/* calendar-sync.ts — pulling one connected calendar's events into
 * calendar_events, and what a failure leaves behind.
 *
 * The one piece sync-outlook-calendar (a staff member pressing Sync) and
 * sync-calendar-scheduled (0057 §3, pg_cron every 15 minutes) share: read the
 * connection's own shared-grant and directory checks, ask Graph for the
 * window, and upsert what comes back — then record success or failure on the
 * connection the same way either caller runs. Whose connection this is, and
 * whether the caller may act on it, is each caller's own to check first
 * (mayActOn is interactive-only; the schedule already enumerates only live
 * calendar connections, in the cron job's own SQL, and re-checks status here
 * anyway — a race between the enumeration and the request is not impossible).
 *
 * TWO MORE BUGS FIXED HERE (agenda audit, 2026-09-14 — both still open as of
 * the wave-1 agenda review, which flagged the first as "still not fixed"):
 * pagination past Graph's 250-event page and retiring events Outlook no
 * longer has, and no longer clobbering a chosen event `kind` with a fresh
 * guess on every ordinary sync. Both fixes are pure functions in
 * ./calendar-sync-helpers.ts (nextLinkOf, vanishedIds, syncedEventFields) —
 * read that file's own header for the full story; this file just wires them
 * into the actual Graph fetch and Postgres upsert, which is the part that
 * cannot be a pure function.
 *
 * Not itself unit-tested past the pure helpers this imports (calendar-sync.
 * test.js, which tests calendar-sync-helpers.ts directly): fetching from
 * Graph and writing rows is exactly the part that needs a live Postgres and
 * a live Microsoft tenant, which this project's tests do not stand up (see
 * the header of graph-message.test.js's neighbours). toEventRow,
 * eventChangeRefusal and failureStatusOf carry their own tests already.
 */

import { accessTokenFor, markNeedsReauth, markNeedsReauthIfUnchanged, storedGrant } from './graph-token.ts';
import { toEventRow, type GraphEvent } from './graph-message.ts';
import { isShared, mailboxPath } from './mailbox.ts';
import { failureStatusOf } from './mail-store.ts';
import { markSyncedIfLive } from './mail-sync.ts';
import { grantCovers } from './connection-rules.ts';
import { connectionCheck } from './connection-check.ts';
import { nextLinkOf, syncedEventFields, vanishedIds, type GraphPage } from './calendar-sync-helpers.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHARED_SCOPE = 'Calendars.ReadWrite.Shared';
/* The statuses a sync may still write to: never over a calendar someone
   disconnected, or one waiting to be reconnected. */
const LIVE = ['connected', 'error'];
/* Every named sub-calendar upserts under this label until the sync can
   actually read more than a mailbox's own default one — see the header of
   0057 §"only one calendar per account". Never taken from a caller: a body
   accepting its own calendarId used to relabel this same calendar under a
   new key and store every event twice. */
export const DEFAULT_CALENDAR_ID = 'default';
/* calendarView pages at 250 a time; a mailbox with a genuinely enormous
   number of events in the window (thousands) stops here rather than page
   forever on a nextLink that never runs out — 20 pages is 5,000 events,
   already far more than any real calendar in a window this short holds. */
const MAX_PAGES = 20;
/* Paged the same way queries.js's everyRow reads a list from the browser
   (PAGE at a time, stop once a page comes back short): Supabase caps a
   single select at its own max rows and says nothing when it does. */
const EXISTING_PAGE = 1000;

export type CalendarConnectionRow = {
  id: string;
  account_label: string;
  employee_id: string | null;
  external_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

export type CalendarSyncResult = {
  ok: true; events: number; skipped: number; cancelled: number; truncated: boolean; windowDays: number; calendarId: string;
};

/* A connection-level problem that stops the sync before it starts, with the
 * status to answer — a shared-grant or directory problem, both already
 * flagged on the connection by the time this returns. null when clear to
 * proceed. */
export async function calendarSyncBlocker(
  admin: Admin,
  conn: CalendarConnectionRow,
): Promise<{ error: string; status: number } | null> {
  if (!LIVE.includes(String(conn.status))) {
    return { error: 'That calendar is not connected. Reconnect it first.', status: 409 };
  }
  const problem = await connectionCheck(admin, conn);
  if (problem) {
    await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at);
    return { error: problem, status: 409 };
  }
  if (isShared(conn)) {
    const grant = await storedGrant(admin, conn.id);
    if (!grant || !grantCovers(grant.scope, SHARED_SCOPE)) {
      const why = `Reconnect ${conn.account_label}: a shared calendar needs ${SHARED_SCOPE}, which its grant does not include.`;
      if (grant) await markNeedsReauthIfUnchanged(admin, conn.id, why, conn.updated_at);
      return { error: why, status: 409 };
    }
  }
  return null;
}

/* Pulls the window into calendar_events and marks the connection synced.
 * Throws on failure, having already flagged the connection (needs_reauth or
 * error) the same way either caller would — a caller's own catch only needs
 * to turn that into the right HTTP answer. Call calendarSyncBlocker() first;
 * this does not repeat those checks. */
export async function runCalendarSync(admin: Admin, conn: CalendarConnectionRow, days: number): Promise<CalendarSyncResult> {
  try {
    const token = await accessTokenFor(admin, conn.id);
    const ownDomain = String(conn.account_label).split('@')[1] || 'veyago.cloud';

    /* A window either side of today: the agenda shows what is coming, and the
       overview still wants this morning's meetings after they have happened. */
    const timeMin = new Date(Date.now() - 7 * 86400_000).toISOString();
    const timeMax = new Date(Date.now() + days * 86400_000).toISOString();

    /* calendarView, not /events: it expands recurring series into the actual
       occurrences in the window. /events returns the series master, and a
       weekly stand-up would appear once, on the day it was created. */
    const query = new URLSearchParams({
      startDateTime: timeMin,
      endDateTime: timeMax,
      $top: '250',
      $orderby: 'start/dateTime',
      $select: 'id,subject,bodyPreview,start,end,isAllDay,isCancelled,showAs,sensitivity,location,attendees,' +
        'onlineMeeting,organizer,originalStartTimeZone',
    });

    /* Every page Graph has for the window, not only the first: a nextLink
       keeps coming back until Graph is actually done, or MAX_PAGES gives up
       on one that never stops (see the file header). `truncated` says which
       one happened — MAX_PAGES giving up means `events` is only PART of the
       window, and vanishedIds must not run against a partial set. */
    const events: GraphEvent[] = [];
    let next: string | null = `${GRAPH}${mailboxPath(conn)}/calendarView?${query}`;
    let truncated = false;
    for (let pages = 0; next; pages++) {
      if (pages >= MAX_PAGES) { truncated = true; break; }
      const res: Response = await fetch(next, {
        headers: {
          Authorization: `Bearer ${token}`,
          /* Ask for UTC, or every dateTime is a wall clock in a Windows timezone
             name — see the header of _shared/graph-message.ts. */
          Prefer: 'outlook.timezone="UTC"',
        },
      });
      /* Not a reconnect by itself: a 401 can be an expired token or a policy
         challenge, and a 403 has causes a reconnect does not fix. The stored
         grant, above, is what says a reconnect is needed. */
      if (!res.ok) {
        throw new Error(`Graph calendarView → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const page: GraphPage = await res.json();
      events.push(...((page.value ?? []) as GraphEvent[]));
      next = nextLinkOf(page);
    }
    const studio = conn.employee_id === null;

    /* What this connection+calendar already has in the same window just
       asked about — needed twice: to decide whether a row's `kind` may take
       the fresh guess (syncedEventFields), and, after the loop, to find
       whatever none of the pages just read mentioned any more (vanishedIds).
       Scoped to the window, not "everything this connection ever synced": a
       shorter `days` than a previous run asked for must not read events
       merely outside today's request as deleted.

       The window test is the same overlap queries.js's own eventsOverlapping
       uses, not a plain starts_at between timeMin and timeMax: a multi-day
       event that started more than 7 days ago but is still running would
       otherwise fall out of `known`. */
    const known = new Set<string>();
    for (let from = 0; ; from += EXISTING_PAGE) {
      const { data: existingRows, error: existingErr } = await admin
        .from('calendar_events')
        .select('external_id')
        .eq('connection_id', conn.id)
        .eq('calendar_id', DEFAULT_CALENDAR_ID)
        .not('external_id', 'is', null)
        .neq('status', 'cancelled')
        .lt('starts_at', timeMax)
        .or(`ends_at.gt."${timeMin}",and(ends_at.is.null,starts_at.gte."${timeMin}")`)
        .order('external_id')
        .range(from, from + EXISTING_PAGE - 1);
      if (existingErr) throw new Error(`reading synced events: ${existingErr.message}`);
      (existingRows ?? []).forEach((r: { external_id: string }) => known.add(r.external_id));
      if (!existingRows || existingRows.length < EXISTING_PAGE) break;
    }

    let written = 0, skipped = 0;
    const seen = new Set<string>();
    for (const ev of events) {
      const row = toEventRow(ev, ownDomain, { hidePrivate: studio });
      /* toEventRow returns null when the start cannot be trusted. A missing
         event is easier to notice than one silently an hour out. */
      if (!row) { skipped++; continue; }
      seen.add(row.external_id);

      const { error: upErr } = await admin.from('calendar_events').upsert(
        syncedEventFields(row, conn.id, DEFAULT_CALENDAR_ID, known.has(row.external_id)),
        { onConflict: 'connection_id,calendar_id,external_id' },
      );
      if (upErr) throw new Error(`event upsert: ${upErr.message}`);
      written++;
    }

    /* An id this connection+calendar had, in this same window, that no page
       just read mentioned: gone from Outlook, so cancelled here too — never a
       hard delete, the same reasoning as everywhere else a sync retires a
       row. calendar_events already excludes cancelled rows from every list
       (calendar_events_window_idx, agenda-model.js), so nothing downstream
       has to change for this to actually clear the agenda. */
    const gone = vanishedIds(known, seen, truncated);
    let cancelled = 0;
    if (gone.length) {
      const { error: cancelErr, count } = await admin
        .from('calendar_events')
        .update({ status: 'cancelled' }, { count: 'exact' })
        .eq('connection_id', conn.id)
        .eq('calendar_id', DEFAULT_CALENDAR_ID)
        .in('external_id', gone);
      if (cancelErr) throw new Error(`cancelling removed events: ${cancelErr.message}`);
      cancelled = count ?? gone.length;
    }

    /* Only a calendar still connected, or in error, is marked synced: a run
       must not switch back on a calendar someone disconnected meanwhile. */
    await markSyncedIfLive(admin, conn.id);
    return { ok: true, events: written, skipped, cancelled, truncated, windowDays: days, calendarId: DEFAULT_CALENDAR_ID };
  } catch (err) {
    const message = String((err as Error).message || err);
    try {
      /* Decided the way the mail sync decides it: a refresh says itself
         whether it needs a person. Matching "refresh" in the wording took a
         calendar off the schedule for a 503 from the token endpoint. */
      if (failureStatusOf(err) === 'needs_reauth') {
        await markNeedsReauth(admin, conn.id, message);
      } else {
        await admin.from('integration_connections')
          .update({ status: 'error', last_error: message.slice(0, 500) })
          .eq('id', conn.id)
          .in('status', LIVE);
      }
    } catch { /* reporting the failure must not replace it */ }
    throw err;
  }
}
