/* send-ticket-reply — post a reply to a ticket and actually send it.
 *
 * One call rather than two, because the two halves must not drift: a message
 * row that exists while the email never left is a support desk lying to you,
 * and an email sent with no record of it is worse.
 *
 * The INSERT runs as the CALLER, through the anon key with their own JWT, so
 * RLS still decides whether they may post and whose name goes on it. Only the
 * delivery stamp is written with the service role — the browser has no UPDATE
 * policy on ticket_messages and should not get one.
 *
 * Sends from a connected STUDIO mailbox when there is one, so the reply lands
 * in Sent and threads in the customer's client. Falls back to Resend when
 * there is none — never to someone's personal mailbox (pickTicketMailbox).
 *
 * Deploy:  supabase functions deploy send-ticket-reply
 * Secrets: RESEND_API_KEY, EMAIL_FROM  (the fallback; already set)
 * Body:    { "ticketId": "...", "body": "…", "kind": "reply" | "note" }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail } from '../_shared/email.ts';
import { decideSend, pickTicketMailbox, ticketReplyEmail, ticketRef } from '../_shared/ticket-reply.ts';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { sendMailPayload } from '../_shared/graph-write.ts';
import { mailboxPath } from '../_shared/mailbox.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/* Sending from the studio's own mailbox beats sending through Resend for a
 * support reply: it lands in Sent where anyone can see it was answered, and
 * the customer's client threads it with the rest of the conversation instead
 * of starting a new one. Resend stays as the fallback for a project with no
 * mailbox connected yet — losing a reply is worse than sending it from the
 * wrong place. */
async function sendViaGraph(
  admin: ReturnType<typeof createClient>,
  connection: { id: string; account_label: string; external_id?: string | null },
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await accessTokenFor(admin, connection.id);
    const replyTo = Deno.env.get('SUPPORT_REPLY_TO');
    /* Sent through the shared mailbox's own path, so it leaves as
       hello@veyago.cloud rather than as whoever's grant is being used — and
       lands in THAT mailbox's Sent items, where the team can see it. */
    const res = await fetch(`${GRAPH}${mailboxPath(connection)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendMailPayload({
        to: [to], subject, html,
        ...(replyTo ? { replyTo: [replyTo] } : {}),
      })),
    });
    /* Graph answers 202 Accepted with an empty body on success. */
    if (res.status === 202 || res.ok) return { ok: true };
    return { ok: false, error: `Graph sendMail → ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) };
  }
}

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

/* The shared Veyago shell, so a support reply looks like every other mail from
   the studio. email.ts keeps `layout` private, so the templates there each
   call it; this one borrows invoiceEmail's shape by handing sendEmail the HTML
   the module composed. */
function wrap(bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:28px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f;">
<tr><td style="padding:0 0 18px;font-weight:600;font-size:17px;letter-spacing:-0.02em;">Veyago</td></tr>
<tr><td>${bodyHtml}</td></tr>
</table>
</td></tr></table></body></html>`;
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

    const payload = await req.json().catch(() => ({}));
    const ticketId = String(payload?.ticketId || '');
    const body = String(payload?.body || '').trim();
    const internal = payload?.kind === 'note';
    if (!ticketId) return json({ error: 'ticketId is required' }, 400);
    if (!body) return json({ error: 'The reply is empty' }, 400);

    /* Read through the caller's own session: a ticket they cannot see is a
       ticket they cannot reply to, and RLS is what decides that. */
    const { data: ticket, error: ticketErr } = await asCaller
      .from('support_tickets')
      .select('id, number, subject, contact:crm_contacts (full_name, email)')
      .eq('id', ticketId)
      .maybeSingle();
    if (ticketErr) return json({ error: ticketErr.message }, 500);
    if (!ticket) return json({ error: 'No such ticket' }, 404);

    const { data: me } = await asCaller.rpc('active_employee_id');

    const { data: message, error: insertErr } = await asCaller
      .from('ticket_messages')
      .insert({
        ticket_id: ticketId,
        author_employee_id: me ?? null,
        direction: internal ? 'internal' : 'outbound',
        body,
      })
      .select('id')
      .single();
    if (insertErr) return json({ error: insertErr.message }, 403);

    const contact = (ticket as { contact?: { full_name?: string; email?: string } }).contact;
    const decision = decideSend({
      direction: internal ? 'internal' : 'outbound',
      body,
      toEmail: contact?.email,
    });

    /* Saved, not sent — and the caller is told which, rather than being left to
       assume the customer heard from us. */
    if (!decision.send) {
      return json({ ok: true, messageId: message.id, sent: false, reason: decision.reason });
    }

    const { data: author } = await asCaller
      .from('employees').select('full_name').eq('id', me).maybeSingle();

    const mail = ticketReplyEmail({
      ticket: { number: ticket.number as number, subject: ticket.subject as string },
      body,
      fromName: author?.full_name ?? null,
      contactName: contact?.full_name ?? null,
    });

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* A studio mailbox or none. Support comes from the address the customer
       wrote to, not from whichever personal inbox happens to be connected. */
    const { data: studioMailboxes } = await admin
      .from('integration_connections')
      .select('id, account_label, employee_id, external_id, status')
      .eq('provider', 'microsoft_mail')
      .is('employee_id', null)
      .eq('status', 'connected');
    const mailbox = pickTicketMailbox(studioMailboxes);

    const html = wrap(mail.bodyHtml);
    let sent: { ok: boolean; error?: string; skipped?: boolean };
    let via: 'outlook' | 'resend';

    if (mailbox) {
      via = 'outlook';
      sent = await sendViaGraph(admin, mailbox, contact!.email!, mail.subject, html);
      if (!sent.ok) {
        /* The mailbox is connected but refused. Fall back rather than drop the
           reply, and keep Graph's reason — a needs_reauth connection is the
           likely cause and it is already flagged by accessTokenFor(). */
        console.warn('[send-ticket-reply] Outlook send failed, falling back:', sent.error);
        via = 'resend';
        sent = await sendEmail({
          to: contact!.email!, subject: mail.subject, html, text: mail.text,
          replyTo: Deno.env.get('SUPPORT_REPLY_TO') ?? undefined,
        });
      }
    } else {
      via = 'resend';
      sent = await sendEmail({
        to: contact!.email!, subject: mail.subject, html, text: mail.text,
        replyTo: Deno.env.get('SUPPORT_REPLY_TO') ?? undefined,
      });
    }

    await admin.from('ticket_messages').update(
      sent.ok
        ? { delivered_at: new Date().toISOString(), delivery_error: null }
        : { delivery_error: (sent.error ?? 'Send failed').slice(0, 500) },
    ).eq('id', message.id);

    await admin.from('email_log').insert({
      to_email: contact!.email!,
      kind: 'ticket_reply',
      subject: mail.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
      reference: ticketId,
    });

    if (!sent.ok) {
      return json({
        ok: false, messageId: message.id, sent: false,
        error: sent.skipped
          ? 'No mailbox is connected and email is not configured, so the reply was saved but not sent.'
          : `The reply was saved but could not be sent: ${sent.error}`,
      }, 502);
    }

    return json({ ok: true, messageId: message.id, sent: true, via, to: contact!.email, ref: ticketRef({ number: ticket.number as number, subject: '' }) });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
