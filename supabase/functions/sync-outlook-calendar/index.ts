/* sync-outlook-calendar — pulls a connected calendar into calendar_events, on
 * demand (a staff member presses Sync). sync-calendar-scheduled runs the same
 * work every 15 minutes (0057 §3); both call _shared/calendar-sync.ts, so
 * a rule that changes here cannot quietly stay different there — including
 * the pagination and deleted-event retirement fixes documented in that
 * file's own header (agenda audit, 2026-09-14).
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
 * Only the mailbox's own DEFAULT calendar: Graph's calendarView never reads a
 * named secondary calendar, whatever `calendarId` a caller sends, so a caller
 * asking for a second one used to relabel the same events under a new key and
 * store every one of them twice. There is no second calendar to read yet, so
 * there is no calendarId to accept (audit finding: "Only one calendar per
 * account").
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
import { mayActOn } from '../_shared/connection-rules.ts';
import { calendarSyncBlocker, runCalendarSync } from '../_shared/calendar-sync.ts';

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

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
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

    const blocked = await calendarSyncBlocker(admin, conn);
    if (blocked) return json({ error: blocked.error }, blocked.status);

    const result = await runCalendarSync(admin, conn, days);
    return json(result);
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
