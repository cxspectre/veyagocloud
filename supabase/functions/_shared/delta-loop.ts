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
 * Graph, the database and the cursor are handed in, so this is tested in node
 * as-is (delta-loop.test.js). The type import is erased when it runs there.
 */
import type { FolderCursor } from './mail-store.ts';

export const DEAD_LINK_TRIES = 3;
const GONE = 410;
const REFUSED = [400, 404];

export interface DeltaPage {
  items: unknown[];
  removed: number;
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
  save(cursor: FolderCursor): Promise<void>;
}

export interface FolderResult extends Stored {
  removed: number;
  pages: number;
  caughtUp: boolean;
  restarted: boolean;
  error: string | null;
}

const fresh = (): FolderCursor => ({ link: null, failures: 0 });

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
  return failures >= DEAD_LINK_TRIES ? fresh() : { link: cursor.link, failures };
}

export async function syncFolder(start: FolderCursor, deps: FolderDeps, maxPages: number): Promise<FolderResult> {
  let cursor = start;
  let totals = { threads: 0, messages: 0, routedToTickets: 0, removed: 0, pages: 0 };
  let restarted = false;
  const finish = (caughtUp: boolean, error: string | null): FolderResult =>
    ({ ...totals, caughtUp, restarted, error });

  while (totals.pages < maxPages) {
    try {
      const page = await deps.fetchPage(cursor.link);
      totals = { ...totals, pages: totals.pages + 1 };

      const stored = await deps.store(page.items);
      totals = {
        ...totals,
        threads: totals.threads + stored.threads,
        messages: totals.messages + stored.messages,
        routedToTickets: totals.routedToTickets + stored.routedToTickets,
        removed: totals.removed + page.removed,
      };

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
