/* The reply a customer actually receives, and the rules about who gets one.
 *
 * Kept out of the Edge Function and out of email.ts because the decisions here
 * are the ones worth testing: whether a message may be sent at all, and how a
 * thread gets stitched back together when the customer hits reply.
 */

export interface TicketLike {
  number: number;
  subject: string;
}

export interface SendDecision {
  send: boolean;
  reason?: string;
}

/* A reply goes out only if it is outbound, to a real address, with something
 * in it. An INTERNAL NOTE NEVER GOES OUT — that is the whole reason this
 * returns a decision rather than the caller writing three ifs and forgetting
 * one. The database carries the same rule as a CHECK (migration 0033). */
export function decideSend(opts: {
  direction: string;
  body: string;
  toEmail?: string | null;
}): SendDecision {
  if (opts.direction === 'internal') {
    return { send: false, reason: 'Internal note — kept between us.' };
  }
  if (opts.direction !== 'outbound') {
    return { send: false, reason: `Nothing to send for a ${opts.direction} message.` };
  }
  if (!opts.body || !opts.body.trim()) {
    return { send: false, reason: 'The reply is empty.' };
  }
  const to = String(opts.toEmail || '').trim();
  if (!to) {
    return { send: false, reason: 'This ticket has no contact email, so the reply was saved but not sent.' };
  }
  /* Deliberately loose. Address validation that tries to be clever rejects
     real addresses; the mail provider is the real judge, and a bounce is a
     better failure than a refusal to try. */
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to)) {
    return { send: false, reason: `"${to}" does not look like an email address.` };
  }
  return { send: true };
}

/* #VYG-142 — the number a person reads and quotes back at you. */
export function ticketRef(ticket: TicketLike): string {
  return `#VYG-${ticket.number}`;
}

/* The PostgREST filter for replies the rate limit did not refuse: those with
   no delivery_error, or a different one. The message is quoted, with its own
   quotes and backslashes escaped, so a comma, period or parenthesis in it stays
   part of it. A filter that stopped parsing would lift the limit without a
   word: the count fails open by design. */
export function notRefusedBy(message: string): string {
  const quoted = String(message).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `delivery_error.is.null,delivery_error.neq."${quoted}"`;
}

/* The subject carries the reference so a reply threads back to the right
 * ticket even in a mail client that ignores In-Reply-To — and so that a person
 * forwarding it internally can still tell what it is about. "Re:" is not added
 * twice when the subject already has one. */
export function replySubject(ticket: TicketLike): string {
  const base = String(ticket.subject || '').trim() || 'Your message';
  const withoutRe = base.replace(/^(re:\s*)+/i, '');
  return `Re: ${withoutRe} [${ticketRef(ticket)}]`;
}

/* Pull the reference back out of a subject line on the way in, so an inbound
 * reply lands on the ticket it belongs to rather than opening a new one. */
export function ticketNumberFromSubject(subject: string): number | null {
  const m = String(subject || '').match(/#VYG-(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Paragraphs, not <br> soup: a reply written with blank lines between thoughts
 * should read that way in the customer's client too. */
export function bodyToHtml(body: string): string {
  return String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export interface ReplyEmail { subject: string; bodyHtml: string; text: string }

/* Composed here, wrapped in the shared Veyago shell by the caller — so a
 * support reply looks like every other mail from the studio. */
export function ticketReplyEmail(opts: {
  ticket: TicketLike;
  body: string;
  fromName?: string | null;
  contactName?: string | null;
}): ReplyEmail {
  const greeting = opts.contactName
    ? `Hi ${escapeHtml(String(opts.contactName).split(/\s+/)[0])},`
    : 'Hi,';
  const signoff = opts.fromName ? escapeHtml(opts.fromName) : 'Veyago';

  return {
    subject: replySubject(opts.ticket),
    bodyHtml:
      `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;">${greeting}</p>` +
      bodyToHtml(opts.body) +
      `<p style="margin:22px 0 0;font-size:15px;line-height:1.65;">${signoff}<br>` +
      `<span style="color:#6e6e73;font-size:13px;">Veyago · ${escapeHtml(ticketRef(opts.ticket))}</span></p>` +
      `<p style="margin:18px 0 0;font-size:12px;color:#6e6e73;line-height:1.6;">` +
      `Reply to this email and it lands back on ${escapeHtml(ticketRef(opts.ticket))}.</p>`,
    text:
      `${opts.contactName ? 'Hi ' + String(opts.contactName).split(/\s+/)[0] + ',' : 'Hi,'}\n\n` +
      `${String(opts.body || '').trim()}\n\n` +
      `${opts.fromName || 'Veyago'}\n` +
      `Veyago · ${ticketRef(opts.ticket)}\n\n` +
      `Reply to this email and it lands back on ${ticketRef(opts.ticket)}.`,
  };
}

export interface MailboxRow {
  id: string;
  account_label: string;
  employee_id: string | null;
  status: string;
  external_id?: string | null;
}

/* Which connected mailbox a support reply leaves from: a studio mailbox, or
 * none. It used to be "any connected mailbox, studio first" — so with the
 * studio mailbox disconnected, a customer was answered from whichever personal
 * inbox happened to be connected, under that person's private address and
 * into their own Sent. Resend from the studio address is the better failure.
 * Sorted by address, so two studio mailboxes cannot swap places between calls. */
export function pickTicketMailbox(rows: MailboxRow[] | null | undefined): MailboxRow | null {
  const studio = (rows ?? [])
    .filter((r) => !r.employee_id && r.status === 'connected')
    .sort((a, b) => String(a.account_label).localeCompare(String(b.account_label)));
  return studio[0] ?? null;
}
