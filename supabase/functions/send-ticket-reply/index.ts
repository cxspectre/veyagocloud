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
 * The address to send to is the linked contact's, or — a sender the CRM has
 * no contact for (0056: requester_email/requester_name) — the raw address
 * the ticket came in on, so a customer nobody has filed in the CRM yet can
 * still be answered.
 *
 * A reply through a studio mailbox answers the customer's own last message
 * (Graph's createReply) rather than starting a fresh one, so it threads in
 * their client instead of opening a new conversation (0056) — the same
 * reason send-mail's own replies use createDraft rather than one-shot
 * sendMail. A reply with nothing to answer (a ticket opened by hand, with no
 * inbound message on it yet) is sent as a new message instead.
 *
 * Once sent, the ticket_messages row already inserted above is stamped with
 * Graph's own Message-ID for it (internet_message_id) — a plain write, no
 * second call to Graph to confirm anything. Whenever the regular mail sync
 * later stores that same message as mail — there is no telling how soon
 * Sent Items shows it, and it is not this call's job to wait and see —
 * route_mail_to_ticket() (0056) matches it by that Message-ID and links it to
 * this same row, instead of filing the reply a second time.
 *
 * Deploy:  supabase functions deploy send-ticket-reply
 * Secrets: RESEND_API_KEY, EMAIL_FROM  (the fallback; already set)
 * Body:    { "ticketId": "...", "body": "…", "kind": "reply" | "note" }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail } from '../_shared/email.ts';
import { decideSend, notRefusedBy, pickTicketMailbox, replyAddress, ticketReplyEmail, ticketRef } from '../_shared/ticket-reply.ts';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { draftMessagePayload } from '../_shared/graph-write.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import { GRAPH, graphRequest } from '../_shared/mail-sync.ts';
import { connectionCheck } from '../_shared/connection-check.ts';

type MailboxCandidate = { id: string; account_label: string; employee_id: string | null; external_id?: string | null };

/* Replies one person may send in RATE_WINDOW_MINUTES: plenty for a busy
   morning, and a ceiling on what a stolen session can send in the studio's
   name. Counted from the replies stored, which are stored before they are
   sent. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MINUTES = 5;

/* The studio mailboxes a reply may leave from: those that pass the connection
   checks. One that is really someone's own would send the customer's reply
   from that person's mailbox. When they cannot be checked there are none, and
   the reply goes by Resend from the studio address — the better failure — with
   the reason logged. */
// deno-lint-ignore no-explicit-any
async function usableMailboxes<T extends MailboxCandidate>(admin: any, rows: T[]): Promise<{ usable: T[]; unchecked: boolean }> {
  try {
    const problems = await Promise.all(rows.map((row) => connectionCheck(admin, row)));
    return { usable: rows.filter((_, i) => !problems[i]), unchecked: false };
  } catch (err) {
    console.warn('[send-ticket-reply] the studio mailboxes could not be checked, so no reply leaves from them:',
      String((err as Error)?.message ?? err));
    return { usable: [], unchecked: true };
  }
}

/* The customer's own last message on this ticket, if the reply can answer it
   directly (Graph's createReply) rather than starting a fresh conversation —
   only when it arrived through the SAME mailbox this reply is about to leave
   from; a message from another mailbox is not one Graph will let this
   mailbox reply to. Read as the service role: this is about how the reply
   threads, not about what the caller may see. */
async function lastCustomerMessage(
  admin: ReturnType<typeof createClient>,
  ticketId: string,
  mailboxId: string,
): Promise<string | null> {
  const { data: linked } = await admin
    .from('ticket_messages')
    .select('mail_message_id')
    .eq('ticket_id', ticketId)
    .eq('direction', 'inbound')
    .not('mail_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!linked?.mail_message_id) return null;

  const { data: original } = await admin
    .from('mail_messages')
    .select('external_id, thread:mail_threads (connection_id)')
    .eq('id', linked.mail_message_id)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const thread = original && (original as any).thread;
  if (!original?.external_id || thread?.connection_id !== mailboxId) return null;
  return original.external_id;
}

/* Sending from the studio's own mailbox beats sending through Resend for a
 * support reply: it lands in Sent where anyone can see it was answered, and
 * — replying to the customer's own last message, when there is one — threads
 * in their client instead of opening a new conversation (0056). Resend stays
 * as the fallback for a project with no mailbox connected yet — losing a
 * reply is worse than sending it from the wrong place. */
async function sendViaGraph(
  admin: ReturnType<typeof createClient>,
  connection: { id: string; account_label: string; external_id?: string | null },
  to: string,
  subject: string,
  html: string,
  originalExternalId: string | null,
): Promise<{ ok: boolean; error?: string; internetMessageId?: string }> {
  try {
    const token = await accessTokenFor(admin, connection.id);
    const box = `${GRAPH}${mailboxPath(connection)}`;
    const replyTo = Deno.env.get('SUPPORT_REPLY_TO');
    const payload = draftMessagePayload({
      to: [to], subject, html,
      ...(replyTo ? { replyTo: [replyTo] } : {}),
    });

    // deno-lint-ignore no-explicit-any
    let draft: any;
    if (originalExternalId) {
      const created = await graphRequest(
        `${box}/messages/${encodeURIComponent(originalExternalId)}/createReply`, token, { method: 'POST', body: {} });
      draft = await graphRequest(`${box}/messages/${encodeURIComponent(created.id)}`, token, {
        method: 'PATCH', body: payload,
      });
    } else {
      draft = await graphRequest(`${box}/messages`, token, { method: 'POST', body: payload });
    }

    await graphRequest(`${box}/messages/${encodeURIComponent(draft.id)}/send`, token, { method: 'POST', body: {} });
    return { ok: true, internetMessageId: draft.internetMessageId };
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

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: me } = await asCaller.rpc('active_employee_id');

    const tooMany = `More than ${RATE_LIMIT} replies in ${RATE_WINDOW_MINUTES} minutes. Wait a few minutes before sending more.`;

    /* This person's replies stored in the last RATE_WINDOW_MINUTES, or null
       when they cannot be counted — which does not stop the reply: this is a
       ceiling, not a permission. A reply this ceiling refused is not counted,
       or a burst of refused requests would keep it shut for five more minutes. */
    const recentReplies = async (): Promise<number | null> => {
      if (typeof me !== 'string') return null;
      const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
      const { count, error: countErr } = await admin
        .from('ticket_messages')
        .select('id', { count: 'exact', head: true })
        .eq('author_employee_id', me)
        .eq('direction', 'outbound')
        .gte('created_at', since)
        .or(notRefusedBy(tooMany));
      if (countErr) {
        console.warn('[send-ticket-reply] could not count recent replies:', countErr.message);
        return null;
      }
      return count ?? 0;
    };

    /* Checked before anything is saved, so a reply refused here is not stored
       as one that was never sent. */
    if (!internal && ((await recentReplies()) ?? 0) >= RATE_LIMIT) {
      return json({ error: `${tooMany} Nothing was saved.` }, 429);
    }

    /* Read through the caller's own session: a ticket they cannot see is a
       ticket they cannot reply to, and RLS is what decides that. requester_*
       (0056) is the raw address a ticket came in on, for a sender the CRM has
       no contact for. */
    const { data: ticket, error: ticketErr } = await asCaller
      .from('support_tickets')
      .select('id, number, subject, requester_name, requester_email, contact:crm_contacts (full_name, email)')
      .eq('id', ticketId)
      .maybeSingle();
    if (ticketErr) return json({ error: ticketErr.message }, 500);
    if (!ticket) return json({ error: 'No such ticket' }, 404);

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

    /* Counted again now this one is stored: requests sent all at once each see
       the others only once they are stored, so a burst past the limit may be
       refused whole. One refused here stays in the conversation, marked as not
       sent, goes nowhere, and stops counting towards the limit. */
    if (!internal && ((await recentReplies()) ?? 0) > RATE_LIMIT) {
      await admin.from('ticket_messages').update({ delivery_error: tooMany }).eq('id', message.id);
      return json({ ok: false, messageId: message.id, sent: false, error: `${tooMany} This one was saved, not sent.` }, 429);
    }

    const contact = (ticket as { contact?: { full_name?: string; email?: string } }).contact;
    /* The linked contact's address, or the raw one the ticket came in on
       (0056) — a sender the CRM has no contact for yet is still someone to
       answer. */
    const to = replyAddress({ contactEmail: contact?.email, requesterEmail: (ticket as { requester_email?: string }).requester_email });
    const decision = decideSend({
      direction: internal ? 'internal' : 'outbound',
      body,
      toEmail: to,
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
      contactName: contact?.full_name ?? (ticket as { requester_name?: string }).requester_name ?? null,
    });

    /* A studio mailbox or none. Support comes from the address the customer
       wrote to, not from whichever personal inbox happens to be connected. */
    const { data: studioMailboxes } = await admin
      .from('integration_connections')
      .select('id, account_label, employee_id, external_id, status')
      .eq('provider', 'microsoft_mail')
      .is('employee_id', null)
      .eq('status', 'connected');
    const studio = studioMailboxes ?? [];
    const { usable, unchecked } = await usableMailboxes(admin, studio);
    const mailbox = pickTicketMailbox(usable);

    const html = wrap(mail.bodyHtml);
    let sent: { ok: boolean; error?: string; skipped?: boolean; internetMessageId?: string };
    let via: 'outlook' | 'resend';
    let outlookError: string | null = null;

    if (mailbox) {
      via = 'outlook';
      const originalExternalId = await lastCustomerMessage(admin, ticketId, mailbox.id).catch((err) => {
        console.warn('[send-ticket-reply] could not find the customer\'s last message to reply to:', String((err as Error)?.message ?? err));
        return null;
      });
      sent = await sendViaGraph(admin, mailbox, to!, mail.subject, html, originalExternalId);
      if (sent.ok) {
        /* Best-effort: whether or not this finds the Sent copy, the reply is
           already sent and recorded — the regular mail sync stores and
           routes it either way (route_mail_to_ticket, 0056) once it does. */
        if (sent.internetMessageId) {
          const { error: stampErr } = await admin
            .from('ticket_messages')
            .update({ internet_message_id: sent.internetMessageId })
            .eq('id', message.id);
          if (stampErr) {
            console.warn('[send-ticket-reply] the Message-ID was not stamped; the regular sync may file this reply again:', stampErr.message);
          }
        }
      } else {
        /* The mailbox is connected but refused. Fall back rather than drop the
           reply, and keep Graph's reason — a needs_reauth connection is the
           likely cause and it is already flagged by accessTokenFor(). */
        console.warn('[send-ticket-reply] Outlook send failed, falling back:', sent.error);
        outlookError = sent.error ?? 'Outlook refused it';
        via = 'resend';
        sent = await sendEmail({
          to: to!, subject: mail.subject, html, text: mail.text,
          replyTo: Deno.env.get('SUPPORT_REPLY_TO') ?? undefined,
        });
      }
    } else {
      via = 'resend';
      sent = await sendEmail({
        to: to!, subject: mail.subject, html, text: mail.text,
        replyTo: Deno.env.get('SUPPORT_REPLY_TO') ?? undefined,
      });
    }

    /* With email not configured, Resend could not stand in: why no mailbox sent
       it is the reason — "no mailbox is connected" was said when one was. */
    const unsentBecause = outlookError
      ? `Outlook would not send it (${outlookError})`
      : studio.length
        ? (unchecked ? 'The studio mailbox could not be checked just now' : 'The studio mailbox needs reconnecting')
        : 'No mailbox is connected';
    const failure = sent.ok ? null
      : sent.skipped ? `${unsentBecause}, and email is not configured`
      : (sent.error ?? 'Send failed');

    await admin.from('ticket_messages').update(
      sent.ok
        ? { delivered_at: new Date().toISOString(), delivery_error: null }
        : { delivery_error: String(failure).slice(0, 500) },
    ).eq('id', message.id);

    await admin.from('email_log').insert({
      to_email: to!,
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
          ? `${failure}, so the reply was saved but not sent.`
          : `The reply was saved but could not be sent: ${sent.error}`,
      }, 502);
    }

    return json({ ok: true, messageId: message.id, sent: true, via, to, ref: ticketRef({ number: ticket.number as number, subject: '' }) });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
