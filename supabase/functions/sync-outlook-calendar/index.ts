/* sync-outlook-calendar — pulls a connected calendar into calendar_events.
 *
 * Idempotent: upserts on (connection_id, calendar_id, external_id), the plain
 * unique index from 0028. Hand-made workspace events have a null external_id
 * and are excluded, so a sync can never overwrite something a person entered.
 *
 * It reads the calendar the connection names: /me for a person's own,
 * /users/{address} for a shared one (_shared/mailbox.ts). It used to read /me
 * for every connection, so a studio calendar connected through a person synced
 * that person's own diary — where every member of staff could read it.
 *
 * What it will not do (security review, 2026-09-14): sync a colleague's
 * personal calendar, a disconnected one, or a studio connection that is a team
 * member's own address, does not record who consented, or was never checked
 * against the directory (_shared/connection-check.ts); switch a
 * disconnected calendar back on; or read a shared calendar through a grant
 * without Calendars.ReadWrite.Shared — that is a reconnect, decided from the
 * stored grant rather than from what Graph answers an old token. An event
 * marked private shows as "Private" in a studio calendar.
 *
 * Deploy:  supabase functions deploy sync-outlook-calendar
 * Body:    { "connectionId": "...", "days": 60 }
 * Caller must be staff: anyone syncs the studio's calendars and their own.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauth, markNeedsReauthIfUnchanged, storedGrant } from '../_shared/graph-token.ts';
import { toEventRow } from '../_shared/graph-message.ts';
import { isShared, mailboxPath } from '../_shared/mailbox.ts';
import { failureStatusOf } from '../_shared/mail-store.ts';
import { markSyncedIfLive } from '../_shared/mail-sync.ts';
import { grantCovers, mayActOn } from '../_shared/connection-rules.ts';
import { connectionCheck } from '../_shared/connection-check.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHARED_SCOPE = 'Calendars.ReadWrite.Shared';
/* The statuses a sync may still write to: never over a calendar someone
   disconnected, or one waiting to be reconnected. */
const LIVE = ['connected', 'error'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  let connectionId = '';

  try {
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    /* Staff, then whose calendar it is (mayActOn, below). Managers only, a
       member of staff's own calendar could not be synced by anyone: they failed
       this, and every manager fails mayActOn. */
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);
    const { data: me, error: meErr } = await asCaller.rpc('active_employee_id');
    if (meErr) return json({ error: 'Could not tell who you are: ' + meErr.message }, 500);

    const body = await req.json().catch(() => ({}));
    const requested = String(body?.connectionId || '');
    if (!requested) return json({ error: 'connectionId is required' }, 400);
    const days = Math.min(Math.max(Number(body?.days) || 60, 1), 365);
    const calendarId = String(body?.calendarId || 'default');

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, provider, account_label, external_id, employee_id, status, updated_at')
      .eq('id', requested)
      .maybeSingle();
    /* A colleague's personal calendar is not the caller's to sync: the same
       answer as no calendar at all, with nothing about it. */
    if (connErr || !conn || !mayActOn(conn, typeof me === 'string' ? me : null)) {
      return json({ error: 'No such connection' }, 404);
    }
    if (conn.provider !== 'microsoft_calendar') {
      return json({ error: 'That connection is not a calendar' }, 400);
    }
    if (!LIVE.includes(conn.status)) {
      return json({ error: 'That calendar is not connected. Reconnect it first.' }, 409);
    }
    const problem = await connectionCheck(admin, conn);
    if (problem) {
      await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at);
      return json({ error: problem }, 409);
    }

    if (isShared(conn)) {
      const grant = await storedGrant(admin, conn.id);
      if (!grant || !grantCovers(grant.scope, SHARED_SCOPE)) {
        const why = `Reconnect ${conn.account_label}: a shared calendar needs ${SHARED_SCOPE}, which its grant does not include.`;
        if (grant) await markNeedsReauthIfUnchanged(admin, conn.id, why, conn.updated_at);
        return json({ error: why }, 409);
      }
    }

    /* Only from here is a failure the calendar's to record. A team or a grant
       that could not be read, above, answers 500 and marks nothing: marked
       'error', the calendar would stop taking bookings over a lookup. */
    connectionId = conn.id;

    const token = await accessTokenFor(admin, connectionId);
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
      $select: 'id,subject,bodyPreview,start,end,isAllDay,isCancelled,showAs,sensitivity,location,attendees,onlineMeeting',
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
    for (const ev of page.value ?? []) {
      const row = toEventRow(ev, ownDomain, { hidePrivate: studio });
      /* toEventRow returns null when the start cannot be trusted. A missing
         event is easier to notice than one silently an hour out. */
      if (!row) { skipped++; continue; }

      const { error: upErr } = await admin.from('calendar_events').upsert(
        {
          connection_id: connectionId,
          calendar_id: calendarId,
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
        },
        { onConflict: 'connection_id,calendar_id,external_id' },
      );
      if (upErr) throw new Error(`event upsert: ${upErr.message}`);
      written++;
    }

    /* Only a calendar still connected, or in error, is marked synced: a run
       must not switch back on a calendar someone disconnected meanwhile. */
    await markSyncedIfLive(admin, connectionId);
    return json({ ok: true, events: written, skipped, windowDays: days, calendarId });
  } catch (err) {
    const message = String((err as Error).message || err);
    if (connectionId) {
      try {
        const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        /* Decided the way the mail sync decides it: a refresh says itself
           whether it needs a person. Matching "refresh" in the wording took a
           calendar off the schedule for a 503 from the token endpoint. */
        if (failureStatusOf(err) === 'needs_reauth') {
          await markNeedsReauth(admin, connectionId, message);
        } else {
          await admin.from('integration_connections')
            .update({ status: 'error', last_error: message.slice(0, 500) })
            .eq('id', connectionId)
            .in('status', LIVE);
        }
      } catch { /* reporting the failure must not replace it */ }
    }
    return json({ error: message }, 500);
  }
});
