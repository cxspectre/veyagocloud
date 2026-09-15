/* inbox-sweep.ts — keeping the workspace inbox to what Outlook's inbox holds.
 *
 * Mail leaves it two ways. The scheduled sync's delta reports a message gone
 * (delta-loop.ts), and once a day the schedule compares the whole inbox with a
 * listing of Outlook's (dailyInboxSweep in mail-sync.ts) — for what the delta
 * never reported: mail filed away before 0045, while a mailbox waited to be
 * reconnected, while a link had gone, or received before a delta round
 * reaches; and removals the delta went on without once it had asked for long
 * enough (STILL_ASKING_RUNS in delta-loop.ts). Either way Graph is asked about
 * each message before it is filed (goneFromInbox): filing one on a wrong
 * answer hides a customer's email while it sits unread in Outlook.
 *
 * Kept free of imports so inbox-sweep.test.js runs it in node.
 */

export const SWEEP_EVERY_HOURS = 24;
/* A comparison Graph asked to pause, or one whose run ran out of time before
   it filed anything, is tried again in an hour rather than a day. */
export const SWEEP_RETRY_HOURS = 1;
/* Messages asked about in one run; the rest wait for the next. */
export const SWEEP_MAX = 150;
/* How many of the messages a comparison finds missing it looks through,
   SWEEP_MAX of them at a time (sweepSlice). */
export const SWEEP_LOOKAHEAD = SWEEP_MAX * 10;
/* Questions at once. Outlook takes four at a time per mailbox, and the sync is
   not the only thing asking. */
export const ASK_AT_ONCE = 3;
/* What Graph answers when it means "not now" rather than "no". */
const NOT_NOW = [401, 408, 429, 500, 502, 503, 504];
/* graph-guard.ts refusing a call it will not make — a "no": it would refuse
   again (afterFolderFailure in delta-loop.ts reads it the same way). */
const GUARD_REFUSAL = /^Graph call not allowed/;

const HOUR = 3600_000;

const timeOf = (at: string | null | undefined): number => Date.parse(String(at ?? ''));
const messageOf = (err: unknown): string =>
  String(err && typeof err === 'object' && 'message' in err ? (err as Error).message : err);

export function sweepDue(nowMs: number, sweptAt: string | null | undefined): boolean {
  const last = timeOf(sweptAt);
  return !Number.isFinite(last) || nowMs - last >= SWEEP_EVERY_HOURS * HOUR;
}

/* How far back a listing of the inbox, newest first, holds everything:
   '-infinity' when it ran out — the whole inbox — or else back to the oldest
   message in it. Nothing listed with more to come holds nothing. */
export function coveredSince(listing: { receivedAt: string[]; complete: boolean }): string | null {
  if (listing.complete) return '-infinity';
  const times = listing.receivedAt.map(timeOf).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/* Whether a failure means "not now": a rate limit, an outage, an expired
   token, or no answer at all. Anything else Graph answers is a "no", and so is
   a call the guard will not make. */
export function isTransient(err: unknown): boolean {
  if (GUARD_REFUSAL.test(messageOf(err))) return false;
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status !== 'number' || NOT_NOW.includes(status);
}

export type FolderLookup = {
  /* The inbox's own Graph id. */
  inboxId(): Promise<string>;
  /* The folder a message is in; null when Graph cannot find it. */
  folderOf(id: string): Promise<string | null>;
};

export type Asked = {
  /* Confirmed no longer in the inbox. */
  gone: string[];
  /* Graph refused to say, and would refuse again: they stay. */
  refused: string[];
  /* Not asked about, or not answered for now: after a "not now", or once the
     time was up. */
  unasked: string[];
  /* The "not now" that stopped the asking; null when nothing did. */
  error: unknown;
  /* The first refusal, to say why messages stayed; null when there was none. */
  refusal: unknown;
};

export type AskOptions = { atOnce?: number; deadline?: number; now?: () => number };

/* Which of these messages Outlook no longer has in its inbox: not found, or in
   another folder. One found in the inbox stays, whatever said otherwise, and
   one found without a folder is kept as no answer. Asked a few at a time.
   A refusal keeps that message and the asking goes on: stopping at it left
   everything after it unasked, run after run. A "not now", or the deadline,
   stops the asking — what was confirmed is kept, and the rest is handed back
   unasked. Nothing is filed on a guess. */
export async function goneFromInbox(ids: string[], graph: FolderLookup, options: AskOptions = {}): Promise<Asked> {
  const unique = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id !== ''))];
  const nothing: Asked = { gone: [], refused: [], unasked: [], error: null, refusal: null };
  if (!unique.length) return nothing;
  let inbox = '';
  try {
    inbox = await graph.inboxId();
  } catch (err) {
    /* Without the inbox's own id nothing can be compared. */
    return isTransient(err)
      ? { ...nothing, unasked: unique, error: err }
      : { ...nothing, refused: unique, refusal: err };
  }
  if (!inbox) return { ...nothing, unasked: unique, error: new Error('Graph did not say which folder is the inbox') };

  const now = options.now ?? Date.now;
  const step = Math.max(1, Math.floor(options.atOnce ?? ASK_AT_ONCE));
  let gone: string[] = [];
  let refused: string[] = [];
  let refusal: unknown = null;
  for (let start = 0; start < unique.length; start += step) {
    if (options.deadline !== undefined && now() >= options.deadline) {
      return { gone, refused, unasked: unique.slice(start), error: null, refusal };
    }
    const batch = unique.slice(start, start + step);
    const answers = await Promise.allSettled(batch.map((id) => graph.folderOf(id)));
    const outcomes = batch.map((id, i) => ({ id, answer: answers[i] }));
    const left = outcomes.filter(({ answer }) =>
      answer.status === 'fulfilled' && (answer.value === null || (answer.value !== '' && answer.value !== inbox)));
    const failed = outcomes.flatMap(({ id, answer }) => (answer.status === 'rejected' ? [{ id, reason: answer.reason }] : []));
    const no = failed.filter(({ reason }) => !isTransient(reason));
    const notNow = failed.filter(({ reason }) => isTransient(reason));
    gone = [...gone, ...left.map(({ id }) => id)];
    refused = [...refused, ...no.map(({ id }) => id)];
    if (refusal === null && no.length) refusal = no[0].reason;
    if (notNow.length) {
      return {
        gone,
        refused,
        refusal,
        unasked: [...notNow.map(({ id }) => id), ...unique.slice(start + step)],
        error: notNow[0].reason ?? new Error('Graph gave no answer'),
      };
    }
  }
  return { gone, refused, unasked: [], error: null, refusal };
}

/* For the delta: what Graph confirms has gone, whether the page has to be read
   again, and how many messages that waits on. "Not now" — a rate limit, an
   outage, the run's time up — keeps what was confirmed and asks for the page
   again next run, for as many runs as delta-loop.ts allows, so a bad minute
   drops no removal. "No" about a message keeps that message and lets the delta
   go on: asked again, Graph would say the same. */
export async function confirmedGone(
  ids: string[],
  graph: FolderLookup,
  options: AskOptions = {},
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<{ gone: string[]; retry: string | null; waiting: number }> {
  const asked = await goneFromInbox(ids, graph, options);
  if (asked.refused.length) {
    warn(`[mail-sync] Graph would not say whether ${asked.refused.length} message(s) left the inbox, so they stay: ${messageOf(asked.refusal)}`);
  }
  if (!asked.unasked.length) return { gone: asked.gone, retry: null, waiting: 0 };
  return {
    gone: asked.gone,
    retry: asked.error ? messageOf(asked.error) : 'the run’s time was up',
    waiting: asked.unasked.length,
  };
}

/* Which of the messages a comparison found missing, newest first, to ask Graph
   about: SWEEP_MAX of them, a different stretch each day. Asking about the
   newest every time left everything past them unasked for good whenever Graph
   kept its answer about those. The stretch stays the same all day, so a run
   that filed some carries on where it was. */
export function sweepSlice(ids: string[], nowMs: number): string[] {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length <= SWEEP_MAX) return list;
  const stretches = Math.ceil(list.length / SWEEP_MAX);
  const day = Math.floor(nowMs / (24 * HOUR));
  const start = (((day % stretches) + stretches) % stretches) * SWEEP_MAX;
  return list.slice(start, start + SWEEP_MAX);
}

export type SweepOutcome = { filed: number; more: boolean; covered?: string | null; retry?: boolean; timeUp?: boolean; unavailable?: boolean };

/* When the daily comparison is due again, in ms from the run that reported
   this — or null to leave it due, so the next run carries on: when 0045's
   functions are not live (no comparison was made, so none is recorded), or
   when there is more to file and some was. In an hour when Graph asked for a
   pause, or the run ran out of time before it filed anything — recording a day
   for that skipped a day, every day, on a mailbox too slow to list in time.
   Otherwise in a day: what Graph kept is not asked about every five minutes. */
export function sweepDueAgainIn(report: SweepOutcome): number | null {
  if (report.unavailable) return null;
  if (report.retry || (report.timeUp && report.filed === 0)) return SWEEP_RETRY_HOURS * HOUR;
  if (report.more && report.filed > 0) return null;
  return SWEEP_EVERY_HOURS * HOUR;
}

/* Whether a comparison did what a note about unconfirmed mail promised
   (UNCONFIRMED_NOTE in mail-sync.ts): it compared the whole inbox — its
   listing ran out ('-infinity') rather than stopping at the newest messages —
   asked about everything it found missing, and is not due again before
   tomorrow. One that never reached the oldest mail, or left the rest for
   another day's stretch (sweepSlice), has not: the mail the note is about may
   be there. */
export function sweepSettlesNote(report: SweepOutcome): boolean {
  return sweepDueAgainIn(report) === SWEEP_EVERY_HOURS * HOUR && !report.more && report.covered === '-infinity';
}
