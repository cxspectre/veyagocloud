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
 * Not itself unit-tested: fetching from Graph and writing rows is exactly the
 * part that needs a live Postgres and a live Microsoft tenant, which this
 * project's tests do not stand up (see the header of graph-message.test.js's
 * neighbours). What IS pure — the window, the calendar id, what a failure
 * means — is factored out where it can be: agendaModel-style range math stays
 * inline here since it is a handful of lines with nothing to assert beyond
 * "the number given, clamped"; toEventRow, eventChangeRefusal and
 * failureStatusOf carry their own tests already.
 */

import { accessTokenFor, markNeedsReauth, markNeedsReauthIfUnchanged, storedGrant } from './graph-token.ts';
import { toEventRow, type GraphEvent } from './graph-message.ts';
import { isShared, mailboxPath } from './mailbox.ts';
import { failureStatusOf } from './mail-store.ts';
import { markSyncedIfLive } from './mail-sync.ts';
import { grantCovers } from './connection-rules.ts';
import { connectionCheck } from './connection-check.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHARED_SCOPE = 'Calendars.ReadWrite.Shared';
/* The statuses a sync may still write to: never over a calendar someone
   disconnected, or one waiting to be reconnected. */
const LIVE = ['connected', 'error'];
/* Every named sub-calendar upserts under this label until the sync can
   actually read more than a mailbox's own default one — see the header of
   0057 §"only one calendar per account". */
export const DEFAULT_CALENDAR_ID = 'default';

export type CalendarConnectionRow = {
  id: string;
  account_label: string;
  employee_id: string | null;
  external_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

export type CalendarSyncResult = { ok: true; events: number; skipped: number; windowDays: number; calendarId: string };

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
    const res = await fetch(`${GRAPH}${mailboxPath(conn)}/calendarView?${query}`, {
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
    const page = await res.json();
    const studio = conn.employee_id === null;

    let written = 0, skipped = 0;
    for (const ev of (page.value ?? []) as GraphEvent[]) {
      const row = toEventRow(ev, ownDomain, { hidePrivate: studio });
      /* toEventRow returns null when the start cannot be trusted. A missing
         event is easier to notice than one silently an hour out. */
      if (!row) { skipped++; continue; }

      const { error: upErr } = await admin.from('calendar_events').upsert(
        {
          connection_id: conn.id,
          /* Only ever the mailbox's own default calendar — see DEFAULT_CALENDAR_ID. */
          calendar_id: DEFAULT_CALENDAR_ID,
          external_id: row.external_id,
          title: row.title,
          detail: row.detail,
          location: row.location,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          all_day: row.all_day,
          kind: row.kind,
          status: row.status,
          attendees: row.attendees,
          organizer_name: row.organizer_name,
          organizer_email: row.organizer_email,
          meeting_url: row.meeting_url,
          time_zone: row.time_zone,
        },
        { onConflict: 'connection_id,calendar_id,external_id' },
      );
      if (upErr) throw new Error(`event upsert: ${upErr.message}`);
      written++;
    }

    /* Only a calendar still connected, or in error, is marked synced: a run
       must not switch back on a calendar someone disconnected meanwhile. */
    await markSyncedIfLive(admin, conn.id);
    return { ok: true, events: written, skipped, windowDays: days, calendarId: DEFAULT_CALENDAR_ID };
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
