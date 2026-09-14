/* Pulling mail from Graph, and storing it.
 *
 * Shared by the manual sync (sync-outlook-mail), the scheduled one
 * (sync-mail-scheduled), send-mail — which stores its own sent copy exactly the
 * way the next sync would — and send-ticket-reply, which only sends.
 *
 * Storing is one database call per chunk — store_mail_batch() in 0038 — which
 * upserts the messages and derives each conversation's folder, read and
 * starred state from every message it holds, atomically.
 *
 * Every Graph call goes through graphRequest(), which asks graph-guard.ts
 * first: nothing here can delete, move or copy mail, whatever builds the URL.
 */
import { MESSAGE_SELECT, folderFromWellKnownName, toMailRow } from './graph-message.ts';
import { assertGraphCall } from './graph-guard.ts';
import { markNeedsReauth } from './graph-token.ts';
import { directionFor, failureStatusOf, ownAddresses } from './mail-store.ts';
import { mailboxPath } from './mailbox.ts';

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
 * folder — are counted, not acted on: the workspace keeps what it has. */
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
  return {
    items: value.filter((item) => !item['@removed']),
    removed: value.filter((item) => item['@removed']).length,
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
  }
  return { threads: threadIds.size, messages, routedToTickets: routed, threadIds };
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

export async function markSyncedIfLive(admin: Admin, connectionId: string): Promise<void> {
  await admin.from('integration_connections')
    .update({ status: 'connected', last_error: null, last_synced_at: new Date().toISOString() })
    .eq('id', connectionId)
    .in('status', LIVE);
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
