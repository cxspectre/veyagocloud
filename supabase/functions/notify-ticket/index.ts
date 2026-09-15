/* notify-ticket — emails the assignee when a ticket is handed to them.
 *
 * Deploy:  supabase functions deploy notify-ticket
 * Secrets: RESEND_API_KEY, EMAIL_FROM, SITE_URL is not used here — a ticket
 *          is opened in the workspace, not the marketing site's admin, so
 *          the link is built from WORKSPACE_URL instead (default
 *          https://workspace.veyago.cloud, the workspace's own deployment).
 *
 * Events
 * ──────
 *   assigned (the only one so far) → assignee: "New ticket: {subject}"
 *
 * A customer's reply is told to the assignee from the mail sync itself
 * (_shared/mail-sync.ts, via _shared/ticket-notify.ts's notifyRepliedTickets)
 * rather than from here: that happens with no browser session at all, so
 * there is no caller for an Edge Function like this one to check.
 *
 * Why best-effort: the ticket is already assigned by the time this runs, so a
 * mail failure must never look like the assignment failed. Callers do not
 * await this into their success toast — the same rule notify-task follows.
 *
 * Security: the caller sends only { ticket_id, event }. Everything else —
 * subject, recipient, email address — is re-read server-side, so this cannot
 * be used to mail arbitrary text to an arbitrary address.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail, ticketAssignedEmail } from '../_shared/email.ts';
import { notifyRecipient } from '../_shared/ticket-notify.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_EVENTS = new Set(['assigned']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
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

    const { data: isStaff, error: roleErr } = await asCaller.rpc('is_staff');
    if (roleErr || !isStaff) return json({ error: 'Staff only' }, 403);

    const body = await req.json().catch(() => ({}));
    const ticketId = String(body.ticket_id ?? '');
    const event = String(body.event ?? 'assigned');

    if (!UUID_RE.test(ticketId)) return json({ error: 'Invalid ticket id' }, 400);
    if (!VALID_EVENTS.has(event)) return json({ error: 'Invalid event' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* Re-read the ticket server-side — the client supplies only an id. */
    const { data: ticket, error: ticketErr } = await admin
      .from('support_tickets')
      .select('id,number,subject,priority,assignee_id')
      .eq('id', ticketId)
      .maybeSingle();
    if (ticketErr) return json({ error: 'Could not read the ticket: ' + ticketErr.message }, 400);
    if (!ticket) return json({ error: 'No such ticket' }, 404);
    if (!ticket.assignee_id) return json({ ok: true, skipped: 'unassigned' });

    const { data: assignee } = await admin
      .from('employees')
      .select('full_name,email,status,user_id')
      .eq('id', ticket.assignee_id)
      .maybeSingle();

    const decision = notifyRecipient(assignee, userData.user.id);
    if (!decision.notify) return json({ ok: true, skipped: decision.reason });

    const { data: assigner } = await admin
      .from('employees')
      .select('full_name')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    const site = (Deno.env.get('WORKSPACE_URL') ?? 'https://workspace.veyago.cloud').replace(/\/+$/, '');
    const ticketUrl = `${site}/#tickets/${ticket.number}`;

    const tpl = ticketAssignedEmail({
      assigneeName: assignee!.full_name,
      number: ticket.number,
      subject: ticket.subject,
      priority: ticket.priority,
      assignedBy: assigner?.full_name ?? null,
      ticketUrl,
    });

    const sent = await sendEmail({ to: assignee!.email, ...tpl });
    await admin.from('email_log').insert({
      to_email: assignee!.email,
      kind: 'ticket_assigned',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
      reference: ticketId,
    });

    return json({ ok: sent.ok, skipped: sent.skipped ? 'email not configured' : undefined });
  } catch (err) {
    console.error('notify-ticket error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
