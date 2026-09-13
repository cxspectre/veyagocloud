/* send-mail — new mail, replies, reply-all and forwards, from the workspace.
 *
 * Every send is a draft first: created (for a reply, created by Outlook with
 * the original quoted and the threading headers set), filled in, given its
 * attachments, then sent. Graph's one-shot sendMail cannot carry an attachment
 * of 3 MB or more, and a reply made that way loses Outlook's quoting.
 *
 * What a failure leaves behind depends on when it happens, so the order is
 * deliberate. Nothing touches Graph until the request is checked in full
 * (_shared/mail-send.ts). A failure after the draft exists leaves it in the
 * mailbox's Drafts, where it can be finished in Outlook — this function never
 * deletes anything, which mail-safety.test.js enforces.
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
import { MESSAGE_SELECT } from '../_shared/graph-message.ts';
import { draftMessagePayload, fileAttachmentPayload, uploadRanges, uploadSessionPayload } from '../_shared/graph-write.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import {
  attachmentPlan, ownsAttachment, parseSendRequest, prependToBody, sanitizeOutgoingHtml,
  type SendRequest,
} from '../_shared/mail-send.ts';
import { GRAPH, GraphError, graphRequest, storeMessages, type MailConnection } from '../_shared/mail-sync.ts';
import { bytesToBase64 } from '../_shared/bytes.ts';

const BUCKET = 'mail-attachments';
/* Sent Items is written a moment after send returns. A few short looks; if
   the copy is not there yet, the next scheduled sync stores it instead. */
const SENT_COPY_ATTEMPTS = 4;
const SENT_COPY_WAIT_MS = 1500;
const CREATE_DRAFT = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' } as const;

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

/* 401/403 from Graph on a mailbox connected before Mail.ReadWrite: the grant
   can send, but not create a draft. That is a reconnect, not an outage. */
function refusal(err: unknown, fallback: string): Response {
  if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
    return json({ error: 'This mailbox needs reconnecting before it can send from the workspace.', reconnect: true }, 409);
  }
  return json({ error: `${fallback}: ${String((err as Error).message || err)}` }, 502);
}

// deno-lint-ignore no-explicit-any
type Admin = any;
// deno-lint-ignore no-explicit-any
type Draft = any;

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

async function attachFiles(admin: Admin, box: string, token: string, draftId: string, request: SendRequest): Promise<void> {
  for (const file of attachmentPlan(request.attachments)) {
    const { data: blob, error } = await admin.storage.from(BUCKET).download(file.path);
    if (error || !blob) throw new Error(`Could not read the attachment "${file.name}"`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== file.size) throw new Error(`The attachment "${file.name}" is not the file that was added`);

    const attachments = `${box}/messages/${encodeURIComponent(draftId)}/attachments`;
    if (file.method === 'inline') {
      await graphRequest(attachments, token, {
        method: 'POST',
        body: fileAttachmentPayload({ name: file.name, contentType: file.contentType, contentBase64: bytesToBase64(bytes) }),
      });
      continue;
    }

    /* From 3 MB: an upload session, in ranges. The upload URL is
       pre-authenticated — sending our token to it as well is refused. */
    const session = await graphRequest(`${attachments}/createUploadSession`, token, {
      method: 'POST', body: uploadSessionPayload({ name: file.name, size: bytes.length }),
    });
    for (const range of uploadRanges(bytes.length)) {
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`,
        },
        body: bytes.subarray(range.start, range.end + 1),
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
    const given = (field: string) =>
      Boolean(payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, field));

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
    if (conn.status === 'needs_reauth') {
      return json({ error: 'This mailbox needs reconnecting before it can send.', reconnect: true }, 409);
    }

    /* Checked against the caller, never taken from the request. */
    const foreign = request.attachments.find((a) => !ownsAttachment(a.path, userData.user.id));
    if (foreign) return json({ error: `The attachment "${foreign.name}" is not yours to send` }, 403);

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
      return refusal(err, 'The message could not be created');
    }

    try {
      await attachFiles(admin, box, token, draft.id, request);
      await graphRequest(`${box}/messages/${encodeURIComponent(draft.id)}/send`, token, { method: 'POST', body: {} });
    } catch (err) {
      const response = refusal(err, 'The message was not sent');
      /* Say where it is: in Drafts, finished in Outlook with one click. */
      const body = await response.json();
      return json({ ...body, error: `${body.error} It is saved in Drafts in Outlook.`, draftSaved: true }, response.status);
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
      const { error: removeErr } = await admin.storage.from(BUCKET).remove(request.attachments.map((a) => a.path));
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
