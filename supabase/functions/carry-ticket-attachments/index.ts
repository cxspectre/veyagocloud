/* carry-ticket-attachments — brings a customer email's attachments onto the
 * ticket it just became.
 *
 * ticket_attachments (0056) already had everywhere to keep one: message_id
 * points at the ticket_messages row a customer's email became, and
 * uploaded_by is nullable for exactly this case — nobody on staff uploaded
 * it. What was missing was anything that actually walked mail_attachments
 * for that message, fetched each one's bytes from Graph, and put them there.
 *
 * Called from 0063's own trigger the moment route_mail_to_ticket() files an
 * INBOUND ticket_messages row with a mail_message_id — whether that came from
 * the regular five-minute sync or from someone clicking "Create ticket" on an
 * existing conversation (create_ticket_from_thread calls the same function
 * for every inbound message the thread already has). A trigger cannot reach
 * Graph itself, so it hands off to this over pg_net and moves on; this is
 * best-effort and asynchronous — nothing here can hold up filing the message
 * on the ticket, or notifying its assignee, which happen first and do not
 * wait for this to answer.
 *
 * No secret grants this alone read access: it reuses MAIL_SYNC_SECRET, the
 * same header sync-mail-scheduled already checks, rather than asking for a
 * new one to set up for what is, like that one, a service-initiated call with
 * nobody signed in — not the service-role key, so a leaked header can only
 * ever trigger these two things, not read everything.
 *
 * Deploy:  supabase functions deploy carry-ticket-attachments --no-verify-jwt
 * Header:  x-sync-secret: <MAIL_SYNC_SECRET>
 * Body:    { "ticketMessageId": "<ticket_messages.id>" }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { fetchAttachmentContent } from '../_shared/graph-attachment.ts';
import { ticketAttachmentPath } from '../_shared/attachment-storage.ts';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { GraphError } from '../_shared/mail-sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32;
const BUCKET = 'ticket-attachments';

// deno-lint-ignore no-explicit-any
type Admin = any;

interface MailAttachment {
  id: string;
  external_id: string;
  name: string;
  content_type: string;
  size: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/* One attachment: fetch, upload, record. Failures here are logged and
 * skipped, never thrown — the trigger this answers to already treats
 * "nothing carried over" as an acceptable outcome for a routing step that
 * must not lose the message underneath it, and the same reasoning applies
 * one level down: one bad attachment must not cost the others on the same
 * email. */
async function carryOne(
  admin: Admin,
  conn: { id: string; account_label: string; external_id?: string | null },
  token: string,
  graphMessageId: string,
  ticketId: string,
  ticketMessageId: string,
  attachment: MailAttachment,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchAttachmentContent(conn, token, graphMessageId, attachment.external_id);
  } catch (err) {
    console.warn(`[carry-ticket-attachments] could not fetch ${attachment.id}:`,
      err instanceof GraphError ? err.message : String((err as Error)?.message ?? err));
    return false;
  }
  /* ticket_attachments.size_bytes must be > 0 (0056's own check); a message
     Graph reports as having an attachment but hands back zero bytes for is
     not one this can carry over. size_bytes is set from what was actually
     fetched, not the metadata's own size (0055) — the two are not always
     equal, and the bytes on hand are the truth here. */
  if (!bytes.length) {
    console.warn(`[carry-ticket-attachments] ${attachment.id} fetched as 0 bytes; not carried`);
    return false;
  }
  /* ticket_attachments.name has the same 1-255 check the client's own upload
     already meets by construction; a name that arrived from Graph could be
     longer, or (name defaults to 'attachment' in toAttachmentRow, but an
     older row or a future source might not) blank. */
  const name = String(attachment.name || '').trim().slice(0, 255) || 'attachment';

  const path = ticketAttachmentPath(ticketId, attachment.id, name);
  const contentType = attachment.content_type || 'application/octet-stream';
  const stored = await admin.storage.from(BUCKET).upload(path, new Blob([bytes], { type: contentType }), {
    contentType, upsert: true,
  });
  /* upsert:true, unlike the client's own uploadTicketAttachment: a retry of
     this exact attachment (the trigger fired twice, or an earlier run's
     database insert below is what failed) lands on the SAME path
     (ticketAttachmentPath is keyed by the mail attachment's own id), and
     overwriting identical bytes with themselves is harmless — refusing the
     upload would only turn a retry into a permanent gap. */
  if (stored.error) {
    console.warn(`[carry-ticket-attachments] could not store ${attachment.id}:`, stored.error.message);
    return false;
  }

  const inserted = await admin.from('ticket_attachments').insert({
    ticket_id: ticketId, message_id: ticketMessageId, storage_path: path,
    name, size_bytes: bytes.length, content_type: contentType,
    uploaded_by: null, mail_attachment_id: attachment.id,
  });
  if (inserted.error) {
    /* Most likely the unique index on mail_attachment_id: another run already
       recorded this one between the check below and this insert. The object
       just uploaded is left in place — it is the same bytes that row already
       points at — rather than removed out from under it. */
    console.warn(`[carry-ticket-attachments] could not record ${attachment.id}:`, inserted.error.message);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = Deno.env.get('MAIL_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (expected.length < MIN_SECRET_LENGTH || !timingSafeEqual(given, expected)) {
    return json({ error: 'Not allowed' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const ticketMessageId = String(body?.ticketMessageId ?? '');
  if (!UUID.test(ticketMessageId)) return json({ error: 'ticketMessageId is required' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  /* mail_message_id is read off the row itself, never trusted from the
     request body — the trigger that calls this only ever has one to send,
     but there is no reason for this endpoint to take its word over the
     database's own. */
  const { data: tm, error: tmErr } = await admin
    .from('ticket_messages')
    .select('id, ticket_id, direction, mail_message_id')
    .eq('id', ticketMessageId)
    .maybeSingle();
  if (tmErr) return json({ error: tmErr.message }, 500);
  if (!tm || tm.direction !== 'inbound' || !tm.mail_message_id) {
    return json({ ok: true, skipped: 'not an inbound email on a ticket' });
  }

  const { data: attachments, error: attachmentsErr } = await admin
    .from('mail_attachments')
    .select('id, external_id, name, content_type, size')
    .eq('message_id', tm.mail_message_id);
  if (attachmentsErr) return json({ error: attachmentsErr.message }, 500);
  if (!attachments?.length) return json({ ok: true, skipped: 'no attachments' });

  const { data: already, error: alreadyErr } = await admin
    .from('ticket_attachments')
    .select('mail_attachment_id')
    .eq('message_id', ticketMessageId)
    .not('mail_attachment_id', 'is', null);
  if (alreadyErr) return json({ error: alreadyErr.message }, 500);
  const carriedAlready = new Set((already ?? []).map((r: { mail_attachment_id: string }) => r.mail_attachment_id));
  const pending = (attachments as MailAttachment[]).filter((a) => !carriedAlready.has(a.id));
  if (!pending.length) return json({ ok: true, skipped: 'already carried' });

  const { data: mm, error: mmErr } = await admin
    .from('mail_messages')
    .select('id, thread_id, external_id')
    .eq('id', tm.mail_message_id)
    .maybeSingle();
  if (mmErr) return json({ error: mmErr.message }, 500);
  if (!mm) return json({ ok: false, error: 'The mail this ticket message came from is gone' }, 404);

  const { data: thread, error: threadErr } = await admin
    .from('mail_threads')
    .select('connection_id')
    .eq('id', mm.thread_id)
    .maybeSingle();
  if (threadErr) return json({ error: threadErr.message }, 500);
  if (!thread) return json({ ok: false, error: 'The conversation this ticket message came from is gone' }, 404);

  const { data: conn, error: connErr } = await admin
    .from('integration_connections')
    .select('id, account_label, external_id, status')
    .eq('id', thread.connection_id)
    .maybeSingle();
  if (connErr) return json({ error: connErr.message }, 500);
  if (!conn || conn.status === 'disconnected') {
    return json({ ok: true, skipped: 'mailbox disconnected' });
  }

  let token: string;
  try {
    token = await accessTokenFor(admin, conn.id);
  } catch (err) {
    console.warn('[carry-ticket-attachments] could not get a token:', String((err as Error)?.message ?? err));
    return json({ ok: true, skipped: 'could not reach the mailbox' });
  }

  let carried = 0;
  for (const attachment of pending) {
    const ok = await carryOne(admin, conn, token, mm.external_id, tm.ticket_id, ticketMessageId, attachment);
    if (ok) carried += 1;
  }

  return json({ ok: true, carried, failed: pending.length - carried });
});
