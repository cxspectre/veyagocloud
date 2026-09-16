/* mail-attachment-content — an attachment's bytes, fetched from Graph when a
 * person actually asks for one.
 *
 * mail_attachments (0055) only ever stored the metadata: name, kind, size,
 * and, for an inline image, its cid. The bytes stay at Graph — fetching every
 * one on every sync would turn a handful of PDFs into megabytes moved around
 * for no reader — so this is what a download link or an inline image, once
 * mail.js and mail-html.js draw them, actually calls.
 *
 * The RESPONSE'S OWN Content-Type is always application/octet-stream, never
 * the attachment's real one: this project's bundled supabase-js only treats
 * a Function response as a Blob for that type (or application/pdf) — anything
 * else falls through to .text(), which corrupts binary. The attachment's real
 * type rides on X-Attachment-Content-Type instead; dist/mail.js already has
 * it from the same attachment list it drew a download button from, and
 * re-types the blob with it (blob.slice(0, size, type)) before showing or
 * offering it — dist/data/actions.js's mailAttachmentContent() hands the
 * blob back untouched.
 *
 * Whose attachment this is to read is decided by mail_attachments' own RLS
 * (can_read_connection + second_factor_met, 0055): read as the caller, so an
 * id belonging to a conversation someone cannot see answers 404 exactly as
 * "no such row" would, never a permission error naming what exists.
 *
 * Deploy:  supabase functions deploy mail-attachment-content
 * Body:    { "attachmentId": "<mail_attachments.id>" }
 * Caller must be staff, past the second-factor gate, and able to read the
 * conversation the attachment arrived on.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged } from '../_shared/graph-token.ts';
import { fetchAttachmentContent } from '../_shared/graph-attachment.ts';
import { GraphError } from '../_shared/mail-sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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

    const body = await req.json().catch(() => ({}));
    const attachmentId = String(body?.attachmentId ?? '');
    if (!UUID.test(attachmentId)) return json({ error: 'attachmentId is required' }, 400);

    /* Read as the caller: an attachment on a conversation they cannot see is
       an attachment they cannot read, exactly as mail_attachments' own RLS
       already decides — nothing here repeats that rule, only follows it. */
    const { data: attachment, error: attachmentErr } = await asCaller
      .from('mail_attachments')
      .select('id, message_id, name, content_type, external_id')
      .eq('id', attachmentId)
      .maybeSingle();
    if (attachmentErr) return json({ error: attachmentErr.message }, 500);
    if (!attachment) return json({ error: 'No such attachment, or it is not yours to read' }, 404);

    const { data: message, error: messageErr } = await asCaller
      .from('mail_messages')
      .select('id, thread_id, external_id')
      .eq('id', attachment.message_id)
      .maybeSingle();
    if (messageErr) return json({ error: messageErr.message }, 500);
    if (!message) return json({ error: 'No such attachment, or it is not yours to read' }, 404);

    const { data: thread, error: threadErr } = await asCaller
      .from('mail_threads')
      .select('connection_id')
      .eq('id', message.thread_id)
      .maybeSingle();
    if (threadErr) return json({ error: threadErr.message }, 500);
    if (!thread) return json({ error: 'No such attachment, or it is not yours to read' }, 404);

    /* Only from here does anything need the service role: integration_secrets
       refuses every other role by design (graph-token.ts's own header). */
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, account_label, external_id, status, updated_at')
      .eq('id', thread.connection_id)
      .maybeSingle();
    if (connErr) return json({ error: connErr.message }, 500);
    if (!conn || conn.status === 'disconnected') {
      return json({ error: 'This mailbox is disconnected, so its attachments cannot be opened right now.' }, 409);
    }

    let token: string;
    try {
      token = await accessTokenFor(admin, conn.id);
    } catch (err) {
      return json({ error: `Could not reach this mailbox: ${String((err as Error)?.message ?? err)}` }, 502);
    }

    let bytes: Uint8Array;
    try {
      bytes = await fetchAttachmentContent(conn, token, message.external_id, attachment.external_id);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        return json({ error: 'This attachment is no longer on the mail server it came from.' }, 404);
      }
      if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
        await markNeedsReauthIfUnchanged(admin, conn.id, `${err.status}: ${err.message}`, conn.updated_at).catch(() => false);
        return json({ error: 'Reconnect this mailbox to open its attachments.' }, 409);
      }
      return json({ error: `Could not fetch the attachment: ${String((err as Error)?.message ?? err)}` }, 502);
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'X-Attachment-Content-Type': attachment.content_type || 'application/octet-stream',
        'X-Attachment-Name': encodeURIComponent(attachment.name || 'attachment'),
        /* Private: this is one person's read of one message's attachment,
           never something a shared cache should hand to somebody else. */
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
