/* send-mail — new mail, replies, reply-all and forwards, from the workspace.
 *
 * Every send is a draft first: created (for a reply, created by Outlook with
 * the original quoted and the threading headers set), filled in, given its
 * attachments, then sent. Graph's one-shot sendMail cannot carry an attachment
 * of 3 MB or more, and a reply made that way loses Outlook's quoting.
 *
 * What a failure leaves behind depends on when it happens, so the order is
 * deliberate. Nothing touches Graph until the request is checked in full and
 * every attachment has been read — as the caller, so the storage policy decides
 * whose files they are. A failure after the draft exists leaves it in the
 * mailbox's Drafts, where it can be finished in Outlook; nothing here deletes
 * anything (graph-guard.ts, mail-safety.test.js).
 *
 * After sending, the sent copy is read back from Sent Items by its Message-ID
 * and stored through the path the sync uses, so the conversation shows the
 * reply at once and the next sync finds a row that is already right.
 *
 * Deploy:  supabase functions deploy send-mail
 * Body:    see parseSendRequest() in _shared/mail-send.ts
 * Caller must be staff and able to read the mailbox (can_read_connection).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { assertUploadCall } from '../_shared/graph-guard.ts';
import { MESSAGE_SELECT } from '../_shared/graph-message.ts';
import { draftMessagePayload, fileAttachmentPayload, uploadRanges, uploadSessionPayload } from '../_shared/graph-write.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import {
  attachmentPlan, ownsAttachment, parseSendRequest, prependToBody, sanitizeOutgoingHtml,
  type AttachmentRef, type SendRequest,
} from '../_shared/mail-send.ts';
import { GRAPH, GraphError, graphRequest, storeMessages, type MailConnection } from '../_shared/mail-sync.ts';
import { bytesToBase64 } from '../_shared/bytes.ts';

const BUCKET = 'mail-attachments';
/* Sent Items is written a moment after send returns. A few short looks; if
   the copy is not there yet, the next scheduled sync stores it instead. */
const SENT_COPY_ATTEMPTS = 4;
const SENT_COPY_WAIT_MS = 1500;
const CREATE_DRAFT = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' } as const;
/* One message whatever went wrong with an attachment: saying "not found" for
   one and "wrong size" for another would tell a caller which files exist. */
const UNREADABLE_ATTACHMENT = 'An attachment could not be read. Remove it and add it again.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* What to tell the person, by what Graph actually said. */
function refusal(err: unknown, fallback: string, mailbox: MailConnection): { status: number; body: Record<string, unknown> } {
  const message = String((err as Error).message || err);
  if (/SendAsDenied/i.test(message)) {
    return {
      status: 403,
      body: {
        error: `${mailbox.account_label} does not let ${mailbox.external_id || 'the connected account'} send as it. `
          + 'In Exchange, give that account Send As on the mailbox.',
      },
    };
  }
  if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
    return {
      status: 409,
      body: { error: 'This mailbox needs reconnecting before it can send from the workspace.', reconnect: true },
    };
  }
  return { status: 502, body: { error: `${fallback}: ${message}` } };
}

// deno-lint-ignore no-explicit-any
type Admin = any;
// deno-lint-ignore no-explicit-any
type Caller = any;
// deno-lint-ignore no-explicit-any
type Draft = any;

interface LoadedFile extends AttachmentRef {
  bytes: Uint8Array;
}

/* Every attachment, read before anything exists in Graph — as the caller, so
   the storage select policy (own folder only) is the last word on whose file
   it is. A missing or changed file would otherwise be found only after the
   draft was made, leaving one more draft behind on every retry. */
async function loadAttachments(asCaller: Caller, files: AttachmentRef[]): Promise<LoadedFile[] | null> {
  const loaded: LoadedFile[] = [];
  for (const file of files) {
    const { data: blob, error } = await asCaller.storage.from(BUCKET).download(file.path);
    if (error || !blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== file.size) return null;
    loaded.push({ ...file, bytes });
  }
  return loaded;
}

async function createDraft(
  box: string, token: string, request: SendRequest, html: string,
  originalExternalId: string | null, given: (field: string) => boolean,
): Promise<Draft> {
  if (request.mode === 'new') {
    return graphRequest(`${box}/messages`, token, {
      method: 'POST',
      body: draftMessagePayload({
        to: request.to, cc: request.cc, bcc: request.bcc,
        subject: request.subject, html, importance: request.importance,
      }),
    });
  }

  const action = CREATE_DRAFT[request.mode];
  const created = await graphRequest(
    `${box}/messages/${encodeURIComponent(originalExternalId!)}/${action}`, token, { method: 'POST', body: {} });
  /* Recipients only when the request carried them: createReplyAll has already
     filled in everyone, and a request that said nothing about Cc must not
     clear it. An explicit empty list does clear it. */
  return graphRequest(`${box}/messages/${encodeURIComponent(created.id)}`, token, {
    method: 'PATCH',
    body: draftMessagePayload({
      html: prependToBody(created?.body?.content ?? '', html),
      importance: request.importance,
      ...(request.subject ? { subject: request.subject } : {}),
      ...(given('to') ? { to: request.to } : {}),
      ...(given('cc') ? { cc: request.cc } : {}),
      ...(given('bcc') ? { bcc: request.bcc } : {}),
    }),
  });
}

async function attachFiles(box: string, token: string, draftId: string, files: LoadedFile[]): Promise<void> {
  const attachments = `${box}/messages/${encodeURIComponent(draftId)}/attachments`;
  for (const file of attachmentPlan(files)) {
    if (file.method === 'inline') {
      await graphRequest(attachments, token, {
        method: 'POST',
        body: fileAttachmentPayload({ name: file.name, contentType: file.contentType, contentBase64: bytesToBase64(file.bytes) }),
      });
      continue;
    }

    /* From 3 MB: an upload session, in ranges. The upload URL is
       pre-authenticated — sending our token to it as well is refused — and it
       must be the Outlook attachment session Graph created, nowhere else. */
    const session = await graphRequest(`${attachments}/createUploadSession`, token, {
      method: 'POST', body: uploadSessionPayload({ name: file.name, size: file.bytes.length }),
    });
    assertUploadCall(session?.uploadUrl);
    for (const range of uploadRanges(file.bytes.length)) {
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${range.start}-${range.end}/${file.bytes.length}`,
        },
        body: file.bytes.subarray(range.start, range.end + 1),
      });
      if (!res.ok) throw new GraphError(res.status, `uploading "${file.name}": ${(await res.text()).slice(0, 200)}`);
    }
  }
}

async function storeSentCopy(admin: Admin, conn: MailConnection, token: string, internetMessageId: string): Promise<string | null> {
  const query = new URLSearchParams({
    $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`,
    $select: MESSAGE_SELECT,
    $top: '1',
  });
  for (let attempt = 0; attempt < SENT_COPY_ATTEMPTS; attempt++) {
    await wait(SENT_COPY_WAIT_MS);
    const page = await graphRequest(
      `${GRAPH}${mailboxPath(conn)}/mailFolders/sentitems/messages?${query}`, token).catch(() => null);
    const item = page?.value?.[0];
    if (item) {
      const stored = await storeMessages(admin, conn, 'sentitems', [item]);
      return stored.threadIds.get(item.conversationId || item.id) ?? null;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);

    const payload = await req.json().catch(() => null);
    const parsed = parseSendRequest(payload);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const request = parsed.value;
    /* A field counts as given when it carries a value. `to: null` is not "send
       to nobody" — parseSendRequest lets Outlook fill To for it, so the draft
       must not be told otherwise. */
    const given = (field: string) =>
      Boolean(payload && typeof payload === 'object'
        && Object.prototype.hasOwnProperty.call(payload, field)
        && payload[field] !== null && payload[field] !== undefined);

    /* The same rule that decides whose mail someone can read decides where
       they can send from: the studio's mailboxes, and their own. */
    const { data: canRead } = await asCaller.rpc('can_read_connection', { p_connection: request.connectionId });
    if (!canRead) return json({ error: 'You cannot send from that mailbox' }, 403);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn } = await admin
      .from('integration_connections')
      .select('id, provider, account_label, external_id, status')
      .eq('id', request.connectionId)
      .maybeSingle();
    if (!conn || conn.provider !== 'microsoft_mail') return json({ error: 'That is not a mailbox' }, 400);
    /* Only a mailbox that is working. A disconnected row can still have a
       stored grant, and sending on it would bypass whoever disconnected it. */
    if (!['connected', 'error'].includes(conn.status)) {
      return json({ error: 'This mailbox needs reconnecting before it can send.', reconnect: true }, 409);
    }

    /* Checked against the caller, never taken from the request — then read
       as the caller, below, so the storage policy agrees or nothing is sent. */
    if (request.attachments.some((a) => !ownsAttachment(a.path, userData.user.id))) {
      return json({ error: UNREADABLE_ATTACHMENT }, 400);
    }
    const files = await loadAttachments(asCaller, request.attachments);
    if (!files) return json({ error: UNREADABLE_ATTACHMENT }, 400);

    /* The message being answered, read as the caller so RLS decides whether
       they may see it. Graph ids belong to one mailbox, so it has to be this
       one — answering a studio thread from a personal mailbox would be a 404
       from Graph, or worse, a reply from the wrong address. */
    let originalExternalId: string | null = null;
    if (request.messageId) {
      const { data: original } = await asCaller
        .from('mail_messages')
        .select('external_id, thread:mail_threads (connection_id)')
        .eq('id', request.messageId)
        .maybeSingle();
      if (!original) return json({ error: 'That message is not one you can answer' }, 404);
      // deno-lint-ignore no-explicit-any
      if ((original as any).thread?.connection_id !== conn.id) {
        return json({ error: 'Answer from the mailbox the message arrived in' }, 400);
      }
      originalExternalId = original.external_id;
    }

    const token = await accessTokenFor(admin, conn.id);
    const box = `${GRAPH}${mailboxPath(conn)}`;
    const html = sanitizeOutgoingHtml(request.html);

    let draft: Draft;
    try {
      draft = await createDraft(box, token, request, html, originalExternalId, given);
    } catch (err) {
      const r = refusal(err, 'The message could not be created', conn);
      return json(r.body, r.status);
    }

    try {
      await attachFiles(box, token, draft.id, files);
      await graphRequest(`${box}/messages/${encodeURIComponent(draft.id)}/send`, token, { method: 'POST', body: {} });
    } catch (err) {
      const r = refusal(err, 'The message was not sent', conn);
      /* Say where it is: in Drafts, finished in Outlook with one click. */
      return json({ ...r.body, error: `${r.body.error} It is saved in Drafts in Outlook.`, draftSaved: true }, r.status);
    }

    /* Sent. Everything below is tidying up, and none of it may turn a sent
       message into an error the person would reasonably retry. */
    const threadId = draft.internetMessageId
      ? await storeSentCopy(admin, conn, token, draft.internetMessageId).catch((err) => {
          console.warn('[send-mail] sent copy not stored yet:', (err as Error).message);
          return null;
        })
      : null;

    if (request.attachments.length) {
      const { error: removeErr } = await asCaller.storage.from(BUCKET).remove(request.attachments.map((a) => a.path));
      if (removeErr) console.warn('[send-mail] uploads not removed:', removeErr.message);
    }

    const { error: logErr } = await admin.from('email_log').insert({
      to_email: [...request.to, ...request.cc].join(', ') || '(reply)',
      kind: 'workspace_mail',
      subject: draft.subject ?? request.subject,
      ok: true,
      error: null,
      requested_by: userData.user.id,
      reference: threadId ?? conn.id,
    });
    if (logErr) console.warn('[send-mail] not logged:', logErr.message);

    return json({ ok: true, sent: true, mailbox: conn.account_label, threadId, stored: Boolean(threadId) });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
