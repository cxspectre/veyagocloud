/* ticket-notify.ts — deciding who hears about a ticket, and telling them.
 *
 * Two jobs land here because they start from different places, but must agree
 * on the same rule for who gets told: a manager assigning a ticket from the
 * workspace — an authenticated browser call, notify-ticket/index.ts's own
 * "assigned" event — and a customer's reply arriving through the mail sync,
 * where there is no browser session at all. _shared/mail-sync.ts calls
 * notifyRepliedTickets() directly once store_mail_batch() (0056) says which
 * tickets a reply just landed on, the same way notify-task/index.ts decides
 * who hears about a task, kept apart here so both starting points agree.
 */
import { sendEmail, ticketCustomerReplyEmail } from './email.ts';

export interface EmployeeLike {
  full_name?: string | null;
  email?: string | null;
  status?: string | null;
  user_id?: string | null;
}

/* An assignee who can actually be reached, and is not the person who just
 * caused this: telling someone about their own action is noise, not news —
 * the same two checks notify-task/index.ts makes for a task, kept here so a
 * ticket agrees with it rather than drifting into its own rules. */
export function notifyRecipient(
  assignee: EmployeeLike | null | undefined,
  actingUserId?: string | null,
): { notify: boolean; reason?: string } {
  if (!assignee) return { notify: false, reason: 'unassigned' };
  if (!assignee.email) return { notify: false, reason: 'no email on file' };
  if (assignee.status === 'inactive') return { notify: false, reason: 'inactive' };
  if (actingUserId && assignee.user_id && assignee.user_id === actingUserId) return { notify: false, reason: 'self' };
  return { notify: true };
}

// deno-lint-ignore no-explicit-any
type Admin = any;

/* Called once a mail sync has routed one or more customer replies to their
 * tickets (_shared/mail-sync.ts, after store_mail_batch). Best-effort: a mail
 * failure here must never fail the sync that just correctly filed the reply —
 * the caller is expected to catch, not await this into anything that matters. */
export async function notifyRepliedTickets(
  admin: Admin,
  ticketIds: string[],
  ticketUrl: (number: number) => string,
): Promise<void> {
  const ids = [...new Set((ticketIds || []).filter(Boolean))];
  if (!ids.length) return;

  const { data: tickets, error: ticketErr } = await admin
    .from('support_tickets')
    .select('id, number, subject, assignee_id')
    .in('id', ids)
    .not('assignee_id', 'is', null);
  if (ticketErr || !tickets?.length) return;

  const assigneeIds = [...new Set(tickets.map((t: { assignee_id: string }) => t.assignee_id))];
  const { data: assignees } = await admin
    .from('employees')
    .select('id, full_name, email, status, user_id')
    .in('id', assigneeIds);
  // deno-lint-ignore no-explicit-any
  const byId = new Map((assignees ?? []).map((e: any) => [e.id, e]));

  // deno-lint-ignore no-explicit-any
  for (const ticket of tickets as any[]) {
    const assignee = byId.get(ticket.assignee_id);
    const decision = notifyRecipient(assignee);
    if (!decision.notify) continue;

    const tpl = ticketCustomerReplyEmail({
      assigneeName: assignee.full_name ?? null,
      number: ticket.number,
      subject: ticket.subject,
      ticketUrl: ticketUrl(ticket.number),
    });
    const sent = await sendEmail({ to: assignee.email, ...tpl });
    await admin.from('email_log').insert({
      to_email: assignee.email,
      kind: 'ticket_customer_reply',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      reference: ticket.id,
    });
  }
}
