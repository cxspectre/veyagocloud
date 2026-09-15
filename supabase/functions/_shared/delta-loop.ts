/* How the scheduled sync walks one folder's Graph delta.
 *
 * Page by page: fetch, store, then save the link to carry on from. A run that
 * dies part-way resumes at the first page it did not store, and a burst of
 * changes bigger than one run is worked through over several.
 *
 * What a failure costs is afterFolderFailure()'s decision:
 *   - a link Graph says has gone (410) is dropped, and the folder starts again
 *     at once — once per run;
 *   - a link Graph refuses outright (400, 404), or one the guard will not
 *     follow, gets three runs before it is dropped, so one bad link cannot
 *     stop a mailbox for good and one bad minute cannot throw a good link away;
 *   - an outage, a rate limit, a lost grant or a database error never costs
 *     the link: the next run tries the same page again.
 * A folder that fails reports it and stops; the caller carries on with the
 * next folder, so a stuck inbox does not stop Sent Items.
 *
 * What a page reports as gone from the folder — deleted, archived or moved in
 * Outlook — is handed to leave() after the page is stored and before its link
 * is saved, so a removal that could not be filed is read again, not skipped.
 * Storing first is right while a moved message gets a new Graph id, as it does
 * without `Prefer: IdType="ImmutableId"`: a removed id never comes back. With
 * immutable ids one page could carry a message's return and its removal under
 * the same id — leave() asks Graph before filing anything (inbox-sweep.ts),
 * which keeps a message that is back where it is.
 *
 * Removals Graph has not answered about yet read the page again next run, and
 * that is not a failure — but only for STILL_ASKING_RUNS runs in a row. After
 * that the folder goes on without them, and says so (unconfirmed): one message
 * Graph keeps not answering about must not stop the folder, and all the mail
 * that arrives after it, for good. The daily inbox comparison asks again.
 *
 * Graph, the database and the cursor are handed in, so this is tested in node
 * as-is (delta-loop.test.js). The type import is erased when it runs there.
 */
import type { FolderCursor } from './mail-store.ts';

export const DEAD_LINK_TRIES = 3;
/* About half an hour on the five-minute schedule. */
export const STILL_ASKING_RUNS = 6;
const GONE = 410;
const REFUSED = [400, 404];

export interface DeltaPage {
  items: unknown[];
  removed: number;
  /* The Graph ids of what left the folder (removedIds). */
  removedIds?: string[];
  /* More in this round: carry on from here. */
  nextLink: string | null;
  /* The round is done: start the next one from here. */
  deltaLink: string | null;
}

export interface Stored {
  threads: number;
  messages: number;
  routedToTickets: number;
}

export interface FolderDeps {
  fetchPage(from: string | null): Promise<DeltaPage>;
  store(items: unknown[]): Promise<Stored>;
  /* Files what left the folder out of it here too; answers how many messages.
     Required: a caller that forgot it would drop every removal without a word. */
  leave(ids: string[]): Promise<number>;
  save(cursor: FolderCursor): Promise<void>;
}

export interface FolderResult extends Stored {
  removed: number;
  /* Messages filed out of the folder because Outlook no longer has them there. */
  left: number;
  pages: number;
  caughtUp: boolean;
  restarted: boolean;
  error: string | null;
  /* Removals the folder went on without after asking for long enough, and why:
     for the mailbox's last_error. Not a failure — the mail itself synced. */
  unconfirmed: string | null;
}

const fresh = (): FolderCursor => ({ link: null, failures: 0 });

/* The ids a delta page marks as gone from its folder. Graph sends those as
   { id, "@removed": { reason } } and nothing more: deleted, or moved to another
   folder, it does not say which. */
export function removedIds(items: unknown[]): string[] {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item !== null && typeof item === 'object' && Boolean((item as Record<string, unknown>)['@removed']))
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

function statusOf(err: unknown): number | null {
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : null;
}

function messageOf(err: unknown): string {
  const message = err && typeof err === 'object' ? (err as { message?: unknown }).message : err;
  return String(message ?? 'The sync failed for an unknown reason');
}

export function afterFolderFailure(cursor: FolderCursor, err: unknown): FolderCursor {
  if (!cursor.link) return fresh();
  const status = statusOf(err);
  if (status === GONE) return fresh();
  const refused = (status !== null && REFUSED.includes(status))
    || /^Graph call not allowed/.test(messageOf(err));
  if (!refused) return cursor;
  const failures = cursor.failures + 1;
  return failures >= DEAD_LINK_TRIES ? fresh() : { ...cursor, failures };
}

/* Work that stopped to carry on next run (StillAsking in mail-sync.ts). */
function retryLater(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { retryLater?: unknown }).retryLater === true);
}

export async function syncFolder(
  start: FolderCursor,
  deps: FolderDeps,
  maxPages: number,
  deadline?: number,
): Promise<FolderResult> {
  let cursor = start;
  let totals = { threads: 0, messages: 0, routedToTickets: 0, removed: 0, left: 0, pages: 0 };
  let restarted = false;
  let unconfirmed: string | null = null;
  const finish = (caughtUp: boolean, error: string | null): FolderResult =>
    ({ ...totals, caughtUp, restarted, error, unconfirmed });

  while (totals.pages < maxPages) {
    /* The run's time is up: stop at the saved link, and carry on next run. A
       run the platform stops mid-page releases nothing and records nothing. */
    if (deadline !== undefined && Date.now() >= deadline) return finish(false, null);
    try {
      const page = await deps.fetchPage(cursor.link);
      totals = { ...totals, pages: totals.pages + 1 };

      const stored = await deps.store(page.items);
      /* Counted as soon as it is stored: a page whose removals then fail to
         file is still stored, and the answer says so. */
      totals = {
        ...totals,
        threads: totals.threads + stored.threads,
        messages: totals.messages + stored.messages,
        routedToTickets: totals.routedToTickets + stored.routedToTickets,
        removed: totals.removed + page.removed,
      };
      const gone = page.removedIds ?? [];
      if (gone.length) {
        try {
          const left = await deps.leave(gone);
          totals = { ...totals, left: totals.left + left };
        } catch (err) {
          if (!retryLater(err)) throw err;
          /* Still to be confirmed with Graph: the page is read again next run,
             and the run is counted. Past the limit — or with no saved link to
             come back to, when a new round would not read this page again —
             the folder goes on without them. */
          const asks = (cursor.asks ?? 0) + 1;
          if (cursor.link && asks < STILL_ASKING_RUNS) {
            /* The page was fetched, so its link works: no failures carry over. */
            await deps.save({ link: cursor.link, failures: 0, asks });
            return finish(false, null);
          }
          unconfirmed = `${messageOf(err)}. The sync went on without them; the daily inbox comparison asks again.`;
        }
      }

      /* Stored, so saved — and only then followed, so the saved place is never
         ahead of what is stored. */
      const next = { link: page.nextLink ?? page.deltaLink, failures: 0 };
      await deps.save(next);
      cursor = next;

      if (!page.nextLink) return finish(true, null);
    } catch (err) {
      const next = afterFolderFailure(cursor, err);
      if (next.link !== cursor.link || next.failures !== cursor.failures) {
        /* Best effort: not managing to record a failure must not hide it. */
        await deps.save(next).catch(() => undefined);
      }
      if (cursor.link && !next.link && !restarted) {
        restarted = true;
        cursor = next;
        continue;
      }
      return finish(false, messageOf(err));
    }
  }
  return finish(false, null);
}
