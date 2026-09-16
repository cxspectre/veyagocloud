/* sync-calendar-scheduled — what pg_cron calls every 15 minutes (0057 §3).
 *
 * One connection per request, the same shape as sync-mail-scheduled (0038
 * §9): the cron job's own SQL sends one request per live calendar connection,
 * so a slow or stuck one cannot use up the time of the others. The actual
 * work is _shared/calendar-sync.ts, the same module sync-outlook-calendar
 * calls when a person presses Sync — this function only supplies what a
 * schedule has that a signed-in caller does not: no user to check mayActOn
 * against (the cron already enumerates only calendar connections, live ones),
 * and a shared secret instead of a JWT.
 *
 * Simpler than mail's scheduled sync: calendarView re-reads its whole window
 * every run rather than following a delta cursor, so there is no saved
 * position to carry between runs and no burst of changes to work through over
 * several. That is also why this runs every 15 minutes rather than mail's
 * five — the same freshness costs more per call this way.
 *
 * A schedule has no user to sign in as, so this is deployed --no-verify-jwt
 * and checks a shared secret instead. It is not handed the service-role key:
 * a leaked cron header should be able to trigger a sync, not read everything.
 * A separate secret from mail's own, deliberately (0057 §3).
 *
 * Deploy:  supabase functions deploy sync-calendar-scheduled --no-verify-jwt
 * Secrets: supabase secrets set CALENDAR_SYNC_SECRET=$(openssl rand -hex 32)
 *          …and the same value in Vault as calendar_sync_secret (see 0057 §3).
 * Header:  x-sync-secret: <CALENDAR_SYNC_SECRET>
 * Body:    { "connectionId": "..." }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { calendarSyncBlocker, runCalendarSync } from '../_shared/calendar-sync.ts';

/* calendarView asks 7 days back and this many ahead — the same window an
   interactive sync defaults to (sync-outlook-calendar's own `days` body
   field), since a schedule has nobody to ask. */
const WINDOW_DAYS = 60;
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* An unset — or guessable — secret must never mean "anyone may call". */
  const expected = Deno.env.get('CALENDAR_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (expected.length < MIN_SECRET_LENGTH || !timingSafeEqual(given, expected)) {
    return json({ error: 'Not allowed' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const connectionId = String(body?.connectionId ?? '');
  if (!UUID.test(connectionId)) return json({ error: 'connectionId is required' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: conn, error } = await admin
    .from('integration_connections')
    .select('id, provider, account_label, external_id, employee_id, status, updated_at')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!conn || conn.provider !== 'microsoft_calendar') return json({ error: 'No such calendar' }, 404);

  const blocked = await calendarSyncBlocker(admin, conn);
  if (blocked) return json({ ok: false, skipped: 'needs_reauth', error: blocked.error }, blocked.status);

  try {
    const result = await runCalendarSync(admin, conn, WINDOW_DAYS);
    return json({ ...result, calendar: conn.account_label });
  } catch (err) {
    return json({ ok: false, calendar: conn.account_label, error: String((err as Error)?.message ?? err) }, 500);
  }
});
