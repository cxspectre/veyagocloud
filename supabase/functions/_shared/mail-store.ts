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

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const GRAPH_PREFIX = 'https://graph.microsoft.com/';

/* How far back a folder's first delta round looks, and how far a round that
   starts again after time away may reach back to cover the gap. */
export const FIRST_SYNC_DAYS = 3;
export const MAX_GAP_DAYS = 14;
const OVERLAP_MINUTES = 10;

type Status = 'needs_reauth' | 'error';

/* Which status a failed sync leaves its connection in. needs_reauth takes a
   mailbox off the schedule until someone reconnects it, so it is kept for
   what a reconnect actually fixes: a grant Microsoft refused, or credentials
   that are gone. A database hiccup, or Microsoft being briefly unavailable,
   is not that. */
export function failureStatus(message: string): Status {
  return /invalid_grant|interaction_required|no credentials|cannot refresh itself|no refresh token/i
    .test(String(message || ''))
    ? 'needs_reauth'
    : 'error';
}

/* The same, for a failure as it was thrown. A token refresh says itself
   whether it needs a person (TokenRefreshError in graph-token.ts) — its
   message carries Microsoft's error code for whoever reads last_error, and a
   503 whose body happens to mention invalid_grant must not take a mailbox off
   the schedule. Anything else is judged by its message. */
export function failureStatusOf(err: unknown): Status {
  const failure = err && typeof err === 'object' ? err as { permanent?: unknown; message?: unknown } : null;
  if (typeof failure?.permanent === 'boolean') return failure.permanent ? 'needs_reauth' : 'error';
  return failureStatus(String((failure ? failure.message : err) ?? ''));
}

/* The address that counts as "us" for a connection: the mailbox itself. Not
   whoever consented to reading it — mail that person sends TO the shared inbox
   is mail from outside it. Replies sent AS the mailbox, which land in a
   personal Sent folder, are caught by directionFor(); mail from any member of
   staff is kept off tickets by route_mail_to_ticket() (0038). */
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

/* Where a delta round starts. Three days back on a first sync. After time
   away — a mailbox waiting to be reconnected, a link Graph has expired — from
   just before the last successful sync, so the gap is stored rather than
   skipped; but never more than fourteen days, past which a manual sync fills
   it in. */
export function roundStart(nowMs: number, lastSyncedAt?: string | null): string {
  const usual = nowMs - FIRST_SYNC_DAYS * DAY;
  const last = Date.parse(String(lastSyncedAt ?? ''));
  const since = Number.isFinite(last) ? Math.min(usual, last - OVERLAP_MINUTES * MINUTE) : usual;
  return new Date(Math.max(since, nowMs - MAX_GAP_DAYS * DAY)).toISOString();
}

/* Where the scheduled sync carries on from: Graph's delta link for each
 * folder, and how many runs in a row following it has failed. Kept together
 * as JSON in integration_connections.sync_cursor, with the mailbox path the
 * links were made for (mailboxPath in mailbox.ts). A link encodes whose mail
 * it reads, so one made for /me must never be followed once the connection
 * reads /users/hello@ instead — that would copy the consenting person's own
 * inbox into a mailbox all staff can read.
 *
 * A link is followed as a URL, so anything that is not a Graph link is dropped
 * here rather than fetched, and a cursor that cannot be read is a fresh start. */
export interface FolderCursor {
  link: string | null;
  failures: number;
}

type StoredCursor = { link?: unknown; failures?: unknown } | null;

const isGraphLink = (link: unknown): boolean => typeof link === 'string' && link.startsWith(GRAPH_PREFIX);
const failureCount = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;

export function readCursors(raw: string | null | undefined, mailbox: string): Record<string, FolderCursor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    return {};
  }
  const saved = parsed && typeof parsed === 'object' ? parsed as { mailbox?: unknown; folders?: unknown } : null;
  if (!saved || saved.mailbox !== mailbox) return {};
  const folders = saved.folders;
  if (!folders || typeof folders !== 'object' || Array.isArray(folders)) return {};
  return Object.fromEntries(
    Object.entries(folders as Record<string, StoredCursor>)
      .filter(([, cursor]) => cursor && isGraphLink(cursor.link))
      .map(([folder, cursor]) => [folder, { link: cursor!.link as string, failures: failureCount(cursor!.failures) }]),
  );
}

/* The cursor with one folder's place set — or cleared, with null or a cursor
   without a link — for this mailbox. Links kept for any other mailbox are
   dropped on the way. */
export function withCursor(
  raw: string | null | undefined,
  mailbox: string,
  folder: string,
  cursor: FolderCursor | null,
): string {
  const { [folder]: _previous, ...others } = readCursors(raw, mailbox);
  const folders = cursor && isGraphLink(cursor.link)
    ? { ...others, [folder]: { link: cursor.link, failures: failureCount(cursor.failures) } }
    : others;
  return JSON.stringify({ mailbox, folders });
}
