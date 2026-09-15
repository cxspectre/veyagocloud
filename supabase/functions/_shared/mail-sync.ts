/* Pulling mail from Graph, and storing it.
 *
 * Shared by the manual sync (sync-outlook-mail), the scheduled one
 * (sync-mail-scheduled), and send-mail, which stores its own sent copy
 * exactly the way the next sync would. send-ticket-reply sends through
 * graphRequest() too but does not store here — it only stamps its own
 * ticket_messages row with Graph's Message-ID, and leaves the actual storing
 * to whichever of these runs next.
 *
 * Storing is one database call per chunk — store_mail_batch() in 0038 — which
 * upserts the messages and derives each conversation's folder, read and
 * starred state from every message it holds, atomically. Since 0056 it also
 * routes an outbound message (a reply sent from Mail or Outlook, or one
 * send-ticket-reply already stamped) and says which tickets a CUSTOMER's
 * reply landed on (repliedTickets) — storeMessages tells their assignees
 * (ticket-notify.ts), best-effort, so this never fails the store itself.
 *
 * Every Graph call goes through graphRequest(), which asks graph-guard.ts
 * first: nothing here can delete, move or copy mail, whatever builds the URL.
 */
import { MESSAGE_SELECT, folderFromWellKnownName, toMailRow } from './graph-message.ts';
import { assertGraphCall } from './graph-guard.ts';
import { markNeedsReauth } from './graph-token.ts';
import { directionFor, failureStatusOf, ownAddresses } from './mail-store.ts';
import { removedIds } from './delta-loop.ts';
import { mailboxPath } from './mailbox.ts';
import { notifyRepliedTickets } from './ticket-notify.ts';
import {
  SWEEP_EVERY_HOURS, SWEEP_LOOKAHEAD, SWEEP_MAX, SWEEP_RETRY_HOURS, confirmedGone, coveredSince, goneFromInbox,
  isTransient, sweepDue, sweepDueAgainIn, sweepSettlesNote, sweepSlice,
} from './inbox-sweep.ts';
import type { FolderLookup } from './inbox-sweep.ts';

/* Where a ticket lives in the workspace, not the marketing site's admin —
 * the same env var notify-ticket/index.ts reads, default
 * https://workspace.veyago.cloud. */
function ticketUrl(number: number): string {
  const site = (Deno.env.get('WORKSPACE_URL') ?? 'https://workspace.veyago.cloud').replace(/\/+$/, '');
  return `${site}/#tickets/${number}`;
}

export const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 50;
const DELTA_PAGE_SIZE = 50;
/* Big bodies make big requests. A batch is cut well before PostgREST would
   refuse it, so one HTML-heavy page cannot fail the whole sync. */
const BATCH_BYTES = 2 * 1024 * 1024;
/* Longer than a scheduled run, shorter than letting a crashed one block the
   mailbox for long. */
export const SYNC_LEASE_SECONDS = 420;
/* The statuses a sync may still write to. A run that finishes after someone
   disconnected the mailbox must not switch it back on. */
const LIVE = ['connected', 'error'];
/* The daily inbox comparison lists ids only, 250 to a page and at most 12
   pages: enough for a working inbox, in a request body the database takes. */
const SWEEP_PAGE_SIZE = 250;
const SWEEP_PAGES = 12;
const HOUR_MS = 3600_000;

// deno-lint-ignore no-explicit-any
type Admin = any;
// deno-lint-ignore no-explicit-any
type GraphItem = any;

export interface MailConnection {
  id: string;
  account_label: string;
  external_id?: string | null;
}

/* A Graph refusal with its status kept. 401/403 is a grant without the scope
 * (a mailbox connected before Mail.ReadWrite); 404 is a message that has moved
 * since the last sync; 410 is a delta link Graph no longer recognises. None of
 * them is Graph being down, and callers say so. */
export class GraphError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`Graph → ${status}: ${detail}`);
    this.status = status;
  }
}

export async function graphRequest(
  href: string,
  token: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<GraphItem> {
  const method = init.method ?? 'GET';
  assertGraphCall(method, href, init.body);
  const res = await fetch(href, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      /* UTC dates (see the header of graph-message.ts) and HTML bodies,
         whatever the mailbox's own preferences are. */
      Prefer: ['outlook.timezone="UTC"', 'outlook.body-content-type="html"', init.prefer]
        .filter(Boolean).join(', '),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new GraphError(res.status, (await res.text()).slice(0, 300));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface FolderPage {
  items: GraphItem[];
  moreAvailable: boolean;
  pages: number;
}

/* One folder by received date, newest first, up to `max` across pages — the
 * manual sync's first import or gap-fill. A page ceiling as well as a message
 * ceiling: a nextLink that kept returning the same page would otherwise run
 * until the function times out. */
export async function fetchFolder(
  conn: MailConnection,
  token: string,
  folder: string,
  window: { since: string; max: number },
): Promise<FolderPage> {
  const query = new URLSearchParams({
    $top: String(Math.min(100, window.max)),
    $orderby: 'receivedDateTime desc',
    $filter: `receivedDateTime ge ${window.since}`,
    $select: MESSAGE_SELECT,
  });
  /* '/me' or '/users/hello@veyago.cloud' — getting this wrong does not error,
     it quietly reads the consenting person's own mail (see mailbox.ts). The
     nextLink is passed on unchanged: it already carries the query and the
     skip token, and rebuilding it is how a sync loops on page one. */
  let next: string | null =
    `${GRAPH}${mailboxPath(conn)}/mailFolders/${encodeURIComponent(folder)}/messages?${query}`;
  let items: GraphItem[] = [];
  let pages = 0;
  while (next && items.length < window.max && pages < MAX_PAGES) {
    pages += 1;
    const batch = await graphRequest(next, token);
    items = [...items, ...(batch?.value ?? [])].slice(0, window.max);
    next = batch?.['@odata.nextLink'] ?? null;
  }
  return { items, moreAvailable: next !== null, pages };
}

export interface DeltaPage {
  items: GraphItem[];
  removed: number;
  /* What left the folder in Outlook, by Graph id: for markLeftFolder(). */
  removedIds: string[];
  /* More in this round: carry on from here. */
  nextLink: string | null;
  /* The round is done: start the next one from here. */
  deltaLink: string | null;
}

/* One page of a folder's changes — new mail, and read or flag changes made in
 * Outlook. `from` is the link to carry on from, or null to start a round from
 * `since` (roundStart in mail-store.ts) rather than from the beginning of the
 * folder. Graph encodes the query into the links it returns, so they are
 * followed as they are. Removals — a message deleted or taken out of the
 * folder — come back as their ids, for markLeftFolder(). */
export async function fetchDeltaPage(
  conn: MailConnection,
  token: string,
  folder: string,
  from: string | null,
  since: string,
): Promise<DeltaPage> {
  const start = new URLSearchParams({
    $select: MESSAGE_SELECT,
    $filter: `receivedDateTime ge ${since}`,
  });
  const href = from
    ?? `${GRAPH}${mailboxPath(conn)}/mailFolders/${encodeURIComponent(folder)}/messages/delta?${start}`;
  const page = await graphRequest(href, token, { prefer: `odata.maxpagesize=${DELTA_PAGE_SIZE}` });
  const value: GraphItem[] = page?.value ?? [];
  const gone = removedIds(value);
  return {
    items: value.filter((item) => !item['@removed']),
    removed: gone.length,
    removedIds: gone,
    nextLink: page?.['@odata.nextLink'] ?? null,
    deltaLink: page?.['@odata.deltaLink'] ?? null,
  };
}

export interface StoreResult {
  threads: number;
  messages: number;
  routedToTickets: number;
  /* Graph conversation id → our thread id. */
  threadIds: Map<string, string>;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// deno-lint-ignore no-explicit-any
function chunks(rows: any[]): any[][] {
  return rows.reduce((all, row) => {
    const size = bytes(row);
    const last = all[all.length - 1];
    if (last && last.bytes + size <= BATCH_BYTES) {
      return [...all.slice(0, -1), { rows: [...last.rows, row], bytes: last.bytes + size }];
    }
    return [...all, { rows: [row], bytes: size }];
  }, []).map((chunk: { rows: unknown[] }) => chunk.rows);
}

export async function storeMessages(
  admin: Admin,
  conn: MailConnection,
  graphFolder: string,
  items: GraphItem[],
): Promise<StoreResult> {
  const own = ownAddresses(conn);
  const rows = items.map((raw) => {
    const row = toMailRow(raw, own);
    return { ...row, direction: directionFor(graphFolder, row.direction) };
  });

  let threadIds = new Map<string, string>();
  let messages = 0;
  let routed = 0;
  const repliedTickets = new Set<string>();
  for (const chunk of chunks(rows)) {
    const { data, error } = await admin.rpc('store_mail_batch', {
      p_connection: conn.id,
      p_folder: folderFromWellKnownName(graphFolder),
      p_rows: chunk,
    });
    if (error) throw new Error(`store_mail_batch: ${error.message}`);
    threadIds = new Map([...threadIds, ...Object.entries(data?.threads ?? {}) as [string, string][]]);
    messages += Number(data?.messages ?? 0);
    routed += Number(data?.routed ?? 0);
    for (const id of (data?.repliedTickets ?? []) as string[]) repliedTickets.add(id);
  }

  /* Awaited, so an Edge Function instance torn down right after answering
   * does not silently drop it (there is no EdgeRuntime.waitUntil() assumed
   * here) — but a failure is caught, never thrown: a mail failure must not
   * look like the sync itself failed, the same rule notify-task/index.ts
   * follows for a task. */
  if (repliedTickets.size) {
    await notifyRepliedTickets(admin, [...repliedTickets], ticketUrl).catch((err) => {
      console.warn('[mail-sync] could not tell an assignee about a customer\'s reply:', String((err as Error)?.message ?? err));
    });
  }

  return { threads: threadIds.size, messages, routedToTickets: routed, threadIds };
}

/* 0045's functions, asked for by name. Until 0045 is live PostgREST does not
 * know them (PGRST202): the sync then files nothing and says so, rather than
 * failing every page that reports a removal — which would stop the inbox
 * syncing at all. Any other refusal is thrown. */
async function inboxRpc(admin: Admin, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await admin.rpc(name, args);
  if (!error) return data;
  if (error.code === 'PGRST202') {
    console.warn(`[mail-sync] ${name}() is not live yet (0045): mail that left the inbox in Outlook stays in it here`);
    return null;
  }
  throw new Error(`${name}: ${error.message}`);
}

/* Where Graph says a message is, for goneFromInbox() in inbox-sweep.ts. */
function folderLookup(conn: MailConnection, token: string): FolderLookup {
  const box = `${GRAPH}${mailboxPath(conn)}`;
  return {
    inboxId: async () => String((await graphRequest(`${box}/mailFolders/inbox?$select=id`, token))?.id ?? ''),
    folderOf: async (id) => {
      try {
        const message = await graphRequest(`${box}/messages/${encodeURIComponent(id)}?$select=id,parentFolderId`, token);
        return String(message?.parentFolderId ?? '');
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

/* Files messages Graph has confirmed are no longer in Outlook's inbox. Nothing
 * is deleted, here or in Outlook. A database failure is thrown, so the page
 * that reported them is read again. */
async function fileGone(admin: Admin, conn: MailConnection, gone: string[]): Promise<number> {
  if (!gone.length) return 0;
  const filed = await inboxRpc(admin, 'mail_left_folder', {
    p_connection: conn.id,
    p_folder: 'inbox',
    p_external_ids: gone,
  });
  return Number(filed ?? 0);
}

/* Mail Outlook no longer has in the inbox — deleted, archived, filed elsewhere —
 * leaves the workspace inbox too: mail_left_folder() in 0045 files those
 * messages as archived, and a conversation with nothing left in the inbox with
 * them — to Sent while it holds a reply of ours. Only the inbox is followed: a
 * message gone from Sent Items changes nothing.
 *
 * Graph is asked first, and only about messages the workspace still shows in
 * the inbox: one it still finds there stays, since a wrong removal would hide
 * an unread customer email. When Graph asks for a pause, or the run's time is
 * up, what was confirmed is filed and the page is read again next run
 * (StillAsking) — for as many runs as delta-loop.ts allows; when Graph refuses
 * to say, the message stays and the delta goes on. */
export async function markLeftFolder(
  admin: Admin,
  conn: MailConnection,
  graphFolder: string,
  ids: string[],
  token: string,
  deadline?: number,
): Promise<number> {
  const folder = folderFromWellKnownName(graphFolder);
  if (folder !== 'inbox' || ids.length === 0) return 0;
  const shown = await inboxRpc(admin, 'inbox_messages_among', { p_connection: conn.id, p_external_ids: ids });
  if (!Array.isArray(shown) || !shown.length) return 0;
  const { gone, retry, waiting } = await confirmedGone(shown.map(String), folderLookup(conn, token), { deadline });
  const filed = await fileGone(admin, conn, gone);
  if (retry) throw new StillAsking(retry, waiting);
  return filed;
}

/* Some of a page's removals are still to be confirmed with Graph. What was
 * confirmed is filed, and the page is read again next run (delta-loop.ts) —
 * not a failure, so the mailbox is not marked for it — until the delta has
 * asked for long enough, and goes on without them. */
export class StillAsking extends Error {
  retryLater = true;
  constructor(reason: string, waiting: number) {
    super(`Graph has not confirmed whether ${waiting} message(s) left the inbox (${reason})`);
    this.name = 'StillAsking';
  }
}

export interface InboxListing {
  ids: string[];
  messageIds: string[];
  receivedAt: string[];
  /* The inbox ran out before the page limit did. */
  complete: boolean;
  /* The run's time ran out while listing. */
  timeUp: boolean;
}

/* Outlook's inbox, newest first, as ids only — what the daily comparison needs,
 * and nothing it does not — as far as SWEEP_PAGES pages reach, and no longer
 * than the run has: a slow listing outlasted the run it was part of. */
export async function listInbox(conn: MailConnection, token: string, deadline?: number): Promise<InboxListing> {
  const query = new URLSearchParams({
    $top: String(SWEEP_PAGE_SIZE),
    $orderby: 'receivedDateTime desc',
    $select: 'id,internetMessageId,receivedDateTime',
  });
  let next: string | null = `${GRAPH}${mailboxPath(conn)}/mailFolders/inbox/messages?${query}`;
  let items: GraphItem[] = [];
  let pages = 0;
  let timeUp = false;
  while (next && pages < SWEEP_PAGES) {
    if (deadline !== undefined && Date.now() >= deadline) {
      timeUp = true;
      break;
    }
    pages += 1;
    const page = await graphRequest(next, token);
    items = [...items, ...(page?.value ?? [])];
    next = page?.['@odata.nextLink'] ?? null;
  }
  const field = (name: string) => items.map((item) => String(item?.[name] ?? '')).filter(Boolean);
  return {
    ids: field('id'),
    messageIds: field('internetMessageId'),
    receivedAt: field('receivedDateTime'),
    complete: next === null,
    timeUp,
  };
}

export interface SweepReport {
  filed: number;
  /* More is left than one run asks Graph about. */
  more: boolean;
  /* How far back the comparison reached: '-infinity' for the whole inbox. */
  covered: string | null;
  error?: string;
  /* Graph asked for a pause: compare again sooner than tomorrow. */
  retry?: boolean;
  /* 0045's functions are not live: nothing was compared. */
  unavailable?: boolean;
  /* The run's time ran out before everything was compared. */
  timeUp?: boolean;
}

const messageOf = (err: unknown) => String((err as Error)?.message ?? err);

/* The workspace inbox against a listing of Outlook's, for what the delta never
 * reported: mail filed away before 0045, while a mailbox waited to be
 * reconnected, while a link had gone, or received before a delta round reaches. */
export async function sweepInbox(
  admin: Admin,
  conn: MailConnection,
  token: string,
  options: { deadline?: number; nowMs?: number } = {},
): Promise<SweepReport> {
  const listing = await listInbox(conn, token, options.deadline);
  if (listing.timeUp) return { filed: 0, more: true, covered: null, timeUp: true };
  const covered = coveredSince(listing);
  /* Nothing listed, with more to come: nothing was compared, so there is more. */
  if (!covered) return { filed: 0, more: true, covered };
  const missing = await inboxRpc(admin, 'inbox_messages_missing', {
    p_connection: conn.id,
    p_since: covered,
    p_present_ids: listing.ids,
    p_present_mids: listing.messageIds,
    p_limit: SWEEP_LOOKAHEAD + 1,
  });
  if (!Array.isArray(missing)) {
    return { filed: 0, more: false, covered, unavailable: true, error: 'inbox_messages_missing() is not live yet (0045)' };
  }
  const found = missing.slice(0, SWEEP_LOOKAHEAD).map(String);
  const asked = await goneFromInbox(sweepSlice(found, options.nowMs ?? Date.now()), folderLookup(conn, token),
    { deadline: options.deadline });
  if (asked.refused.length) {
    console.warn(`[mail-sync] Graph would not say whether ${asked.refused.length} message(s) left the inbox, so they stay: ${messageOf(asked.refusal)}`);
  }
  const filed = await fileGone(admin, conn, asked.gone);
  return {
    filed,
    more: missing.length > SWEEP_MAX || asked.unasked.length > 0,
    covered,
    /* Only a "not now" stops the asking (goneFromInbox), so an error is one to
       come back for sooner; unasked without one is the run's time up. */
    ...(asked.error ? { error: messageOf(asked.error), retry: true } : {}),
    ...(asked.unasked.length && !asked.error ? { timeUp: true } : {}),
  };
}

/* The comparison as the schedule runs it: once a day (inbox-sweep.ts), and not
 * before 0045 has added inbox_swept_at. Due again as sweepDueAgainIn() says: in
 * a day; in an hour when Graph asked for a pause, or the time ran out before
 * anything was filed; next run when there is more to file and some was filed.
 * A failure is reported in the answer — the mail itself synced, so the
 * mailbox is not marked for it — and 0045's functions missing is reported and
 * not recorded, so it is never taken for a comparison made. */
export async function dailyInboxSweep(
  admin: Admin,
  conn: MailConnection,
  token: string,
  options: { deadline?: number; nowMs?: number } = {},
): Promise<SweepReport | null> {
  const nowMs = options.nowMs ?? Date.now();
  const { data, error } = await admin.from('integration_connections')
    .select('inbox_swept_at')
    .eq('id', conn.id)
    .maybeSingle();
  if (error || !data || !sweepDue(nowMs, data.inbox_swept_at)) return null;

  const dueAgainIn = async (ms: number) => {
    const at = new Date(nowMs - SWEEP_EVERY_HOURS * HOUR_MS + ms).toISOString();
    const { error: saveErr } = await admin.from('integration_connections')
      .update({ inbox_swept_at: at })
      .eq('id', conn.id);
    if (saveErr) console.warn('[mail-sync] could not record the inbox comparison:', saveErr.message);
  };

  try {
    const report = await sweepInbox(admin, conn, token, { deadline: options.deadline, nowMs });
    if (report.unavailable) {
      console.warn('[mail-sync] the inbox comparison could not run:', report.error);
      return report;
    }
    const again = sweepDueAgainIn(report);
    if (again !== null) await dueAgainIn(again);
    if (sweepSettlesNote(report)) await clearUnconfirmedNote(admin, conn.id);
    return report;
  } catch (err) {
    const transient = isTransient(err);
    await dueAgainIn((transient ? SWEEP_RETRY_HOURS : SWEEP_EVERY_HOURS) * HOUR_MS);
    const message = messageOf(err);
    console.warn(`[mail-sync] the inbox comparison failed, and runs again ${transient ? 'in an hour' : 'tomorrow'}:`, message);
    return { filed: 0, more: false, covered: null, error: message, ...(transient ? { retry: true } : {}) };
  }
}

/* One sync of a mailbox at a time. The schedule, a manager's manual sync and
 * a run that outlived its five minutes would otherwise overlap. */
export async function claimSync(admin: Admin, connectionId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('claim_mail_sync', {
    p_connection: connectionId, p_seconds: SYNC_LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_mail_sync: ${error.message}`);
  return data === true;
}

export async function releaseSync(admin: Admin, connectionId: string): Promise<void> {
  const { error } = await admin.rpc('release_mail_sync', { p_connection: connectionId });
  if (error) console.warn('[mail-sync] lease not released; it expires by itself:', error.message);
}

/* The scheduled sync's delta links, saved after every page so a run that dies
 * part-way carries on from the last page it stored. */
export async function saveCursor(admin: Admin, connectionId: string, cursor: string): Promise<void> {
  const { error } = await admin.from('integration_connections')
    .update({ sync_cursor: cursor })
    .eq('id', connectionId)
    .in('status', LIVE);
  if (error) throw new Error(`Could not save how far the sync got: ${error.message}`);
}

/* What begins a mailbox's last_error when the sync went on without confirming
   some removals (delta-loop.ts). Written so the mailbox list in Mail can show
   it, and kept through the runs after — which otherwise clear last_error —
   until a daily comparison has asked Graph about that mail again. No % or _,
   so it can be matched with LIKE as it is. */
export const UNCONFIRMED_NOTE = 'Some mail filed away in Outlook may still show in this inbox until the daily check. ';

async function clearUnconfirmedNote(admin: Admin, connectionId: string): Promise<void> {
  const { error } = await admin.from('integration_connections')
    .update({ last_error: null })
    .eq('id', connectionId)
    .like('last_error', `${UNCONFIRMED_NOTE}%`);
  if (error) console.warn('[mail-sync] could not clear the note about unconfirmed mail:', error.message);
}

/* delta: the scheduled sync caught up on every folder. delta_synced_at is how
   far back a round that starts again reaches (roundStart). A manual sync — one
   folder, a capped window — must not move it, or what it did not fill in would
   be skipped; nor may a run that stopped part-way. note: what the run went on
   without, kept as last_error while the mailbox stays connected. A run with no
   note clears last_error, but not an UNCONFIRMED_NOTE: that stays until the
   daily comparison has run. */
export async function markSyncedIfLive(
  admin: Admin,
  connectionId: string,
  options: { delta?: boolean; note?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await admin.from('integration_connections')
    .update({
      status: 'connected',
      last_synced_at: now,
      ...(options.delta ? { delta_synced_at: now } : {}),
      ...(options.note ? { last_error: options.note.slice(0, 500) } : {}),
    })
    .eq('id', connectionId)
    .in('status', LIVE);
  if (options.note) return;
  await admin.from('integration_connections')
    .update({ last_error: null })
    .eq('id', connectionId)
    .in('status', LIVE)
    .not('last_error', 'like', `${UNCONFIRMED_NOTE}%`);
}

/* A failed sync flags its connection, so the workspace can say which mailbox
 * is stuck and why — needs_reauth only for what a reconnect fixes (see
 * failureStatusOf), and never over a mailbox someone has disconnected
 * meanwhile. Reporting the failure must not replace it. */
export async function recordSyncFailure(admin: Admin, connectionId: string, err: unknown): Promise<void> {
  const message = String((err as Error)?.message ?? err ?? 'The sync failed');
  try {
    if (failureStatusOf(err) === 'needs_reauth') {
      await markNeedsReauth(admin, connectionId, message);
    } else {
      await admin.from('integration_connections')
        .update({ status: 'error', last_error: message.slice(0, 500) })
        .eq('id', connectionId)
        .in('status', LIVE);
    }
  } catch { /* the original failure is what the caller reports */ }
}
