/* The decisions a sync makes around storing mail.
 *
 * Which folder a conversation belongs in, and whether it is read or starred,
 * are decided in the database — store_mail_batch() in 0038 — atomically and
 * from every stored message. Decided here, from one batch, they went wrong in
 * two ways: two runs overlapping wrote each other's stale state back, and a
 * batch that did not happen to contain the unread message marked a thread read.
 *
 * What stays here is what a function decides before and after that call.
 * Kept free of imports so it can be tested in node as-is.
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/* How far an incremental sync looks back. The overlap covers a run that was
   still going when the last one ended; the ceiling stops a mailbox that was
   down for a month from asking Graph for all of it at once. */
export const SYNC_WINDOW = { overlapMinutes: 10, firstRunDays: 3, maxDays: 14 };

/* Which status a failed sync leaves its connection in. needs_reauth takes a
   mailbox off the schedule until someone reconnects it, so it is kept for
   what a reconnect actually fixes: a grant Microsoft refused, or credentials
   that are gone. A database hiccup while reading the token is not that. */
export function failureStatus(message: string): 'needs_reauth' | 'error' {
  return /invalid_grant|interaction_required|no credentials|cannot refresh itself|no refresh token/i
    .test(String(message || ''))
    ? 'needs_reauth'
    : 'error';
}

/* The addresses that count as "us" for a connection: the mailbox itself, and
   whoever consented to reading it — who may be sending as the mailbox. */
export function ownAddresses(conn: { account_label: string; external_id?: string | null }): string[] {
  const addresses = [conn.account_label, conn.external_id]
    .map((a) => String(a ?? '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(addresses)];
}

/* Where an incremental sync starts, as an ISO instant. */
export function syncWindowStart(lastSyncedAt: string | null | undefined, nowMs: number, opts = SYNC_WINDOW): string {
  const last = Date.parse(String(lastSyncedAt ?? ''));
  if (!Number.isFinite(last)) return new Date(nowMs - opts.firstRunDays * DAY).toISOString();
  /* A last-synced time from the future (clock skew) must not skip mail. */
  const start = Math.min(last, nowMs) - opts.overlapMinutes * MINUTE;
  return new Date(Math.max(start, nowMs - opts.maxDays * DAY)).toISOString();
}

/* Mail found in Sent Items is ours, whatever its From says. Comparing From
   with the mailbox's own address alone filed a reply sent AS hello@ — which
   lands in a personal Sent folder — as inbound, and route_mail_to_ticket then
   appended it to the ticket as the customer's words. */
export function directionFor(graphFolder: string, parsed: 'inbound' | 'outbound'): 'inbound' | 'outbound' {
  return String(graphFolder).toLowerCase() === 'sentitems' ? 'outbound' : parsed;
}
