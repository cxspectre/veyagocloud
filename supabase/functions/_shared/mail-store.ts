/* The decisions a sync makes around storing mail.
 *
 * Which folder a conversation belongs in, and whether it is read or starred,
 * are decided in the database — store_mail_batch() in 0038 — atomically and
 * from every stored message. What stays here is what a function decides before
 * and after that call: whose mail is ours, what a failure means, and where the
 * scheduled sync carries on from.
 *
 * Kept free of imports so it can be tested in node as-is.
 */

const DAY = 24 * 60 * 60 * 1000;
const GRAPH_PREFIX = 'https://graph.microsoft.com/';

/* How far back a folder's first delta round looks. */
export const FIRST_SYNC_DAYS = 3;

/* Which status a failed sync leaves its connection in. needs_reauth takes a
   mailbox off the schedule until someone reconnects it, so it is kept for
   what a reconnect actually fixes: a grant Microsoft refused, or credentials
   that are gone. A database hiccup, or Microsoft being briefly unavailable,
   is not that. */
export function failureStatus(message: string): 'needs_reauth' | 'error' {
  return /invalid_grant|interaction_required|no credentials|cannot refresh itself|no refresh token/i
    .test(String(message || ''))
    ? 'needs_reauth'
    : 'error';
}

/* The address that counts as "us" for a connection: the mailbox itself. Not
   whoever consented to reading it — mail that person sends TO the shared inbox
   is mail from outside it. Replies sent AS the mailbox, which land in a
   personal Sent folder, are caught by directionFor(). */
export function ownAddresses(conn: { account_label: string; external_id?: string | null }): string[] {
  return [String(conn.account_label ?? '').trim().toLowerCase()].filter(Boolean);
}

/* Mail found in Sent Items is ours, whatever its From says. Comparing From
   with the mailbox's own address alone filed a reply sent AS hello@ — which
   lands in a personal Sent folder — as inbound, and route_mail_to_ticket then
   appended it to the ticket as the customer's words. */
export function directionFor(graphFolder: string, parsed: 'inbound' | 'outbound'): 'inbound' | 'outbound' {
  return String(graphFolder).toLowerCase() === 'sentitems' ? 'outbound' : parsed;
}

export function firstSyncSince(nowMs: number): string {
  return new Date(nowMs - FIRST_SYNC_DAYS * DAY).toISOString();
}

/* The scheduled sync's Graph delta links, one per folder, kept together as
   JSON in integration_connections.sync_cursor. A link is followed as a URL, so
   anything that is not a Graph link is dropped here rather than fetched — and
   a cursor that cannot be read is simply a fresh start. */
export function readCursors(raw: string | null | undefined): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([, link]) => typeof link === 'string' && link.startsWith(GRAPH_PREFIX)),
  ) as Record<string, string>;
}

/* The cursor with one folder's link set — or cleared, with null. */
export function withCursor(raw: string | null | undefined, folder: string, link: string | null): string {
  const { [folder]: _previous, ...others } = readCursors(raw);
  return JSON.stringify(link ? { ...others, [folder]: link } : others);
}
