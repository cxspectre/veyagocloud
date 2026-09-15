/* delete-calendar-event — removes a synced event from Outlook first, then
 * here. The write side of update-calendar-event's header comment applies the
 * same way: a synced row (connection_id set) is nobody's to delete straight
 * through RLS (0026, 0048), because a row removed here alone would come back
 * on the next sync. Idempotent: an event already gone from the calendar —
 * removed in Outlook, or by someone else's click a moment ago — still ends
 * with the local row gone and ok: true, rather than a refusal for something
 * that is already true.
 *
 * Same authorisation and connection checks as update-calendar-event: mayActOn
 * (_shared/connection-rules.ts) for whose calendar this is, calendarSyncBlocker
 * (_shared/calendar-sync.ts) for whether it can be written to at all right
 * now, and eventChangeRefusal (_shared/calendar-event-guard.ts) — read off the
 * calendar's current state — for a cancelled, recurring or private event.
 * Recurring is a real, documented gap here too: Graph would in fact delete a
 * single occurrence cleanly, but this refuses every non-singleInstance type
 * for now, the same as an edit, rather than carrying two different rules for
 * one guard function to get exactly right on the first try.
 *
 * NOT exercised against a live Graph or a live Postgres — see
 * update-calendar-event's header for the same boundary.
 *
 * Deploy:  supabase functions deploy delete-calendar-event
 * Body:    { eventId }
 * Caller must be staff.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, TokenRefreshError } from '../_shared/graph-token.ts';
import { eventChangeRefusal } from '../_shared/calendar-event-guard.ts';
import { calendarSyncBlocker } from '../_shared/calendar-sync.ts';
import { mayActOn } from '../_shared/connection-rules.ts';
import { mailboxPath } from '../_shared/mailbox.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const OWN_WAITING = 'Your calendar needs reconnecting before changes can be sent to it.';
const STUDIO_WAITING = 'The studio calendar needs reconnecting before changes can be sent to it.';

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
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);
    const { data: me, error: meErr } = await asCaller.rpc('active_employee_id');
    if (meErr) return json({ error: 'Could not tell who you are: ' + meErr.message }, 500);

    const body = await req.json().catch(() => ({}));
    const eventId = String(body?.eventId || '');
    if (!eventId) return json({ error: 'eventId is required' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: row, error: rowErr } = await admin
      .from('calendar_events')
      .select('id, connection_id, external_id')
      .eq('id', eventId)
      .maybeSingle();
    if (rowErr) return json({ error: rowErr.message }, 500);
    /* Already gone from the workspace: removing nothing is still the outcome
       asked for. */
    if (!row) return json({ ok: true });
    if (!row.connection_id || !row.external_id) {
      return json({ error: 'This event is not from a connected calendar.' }, 400);
    }

    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, account_label, employee_id, external_id, status, updated_at')
      .eq('id', row.connection_id)
      .maybeSingle();
    if (connErr || !conn || !mayActOn(conn, typeof me === 'string' ? me : null)) {
      return json({ error: 'That event is not loaded any more.' }, 404);
    }

    const blocked = await calendarSyncBlocker(admin, conn);
    if (blocked) return json({ error: blocked.error }, blocked.status);

    let token: string;
    try {
      token = await accessTokenFor(admin, conn.id);
    } catch (err) {
      if (err instanceof TokenRefreshError && err.permanent) {
        return json({ error: conn.employee_id === null ? STUDIO_WAITING : OWN_WAITING }, 503);
      }
      throw err;
    }

    const studio = conn.employee_id === null;
    const getRes = await fetch(
      `${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(row.external_id)}` +
        '?$select=id,type,isCancelled,sensitivity',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (getRes.status !== 404) {
      if (!getRes.ok) {
        return json({ error: `Graph refused to read the event (${getRes.status}): ${(await getRes.text()).slice(0, 200)}` }, 502);
      }
      const current = await getRes.json();
      const refusal = eventChangeRefusal(current, studio);
      if (refusal) return json({ error: refusal }, 409);

      const delRes = await fetch(`${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(row.external_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!delRes.ok && delRes.status !== 404) {
        const detail = (await delRes.text()).slice(0, 200);
        return json({ error: `Graph refused to remove the event (${delRes.status}): ${detail}` }, 502);
      }
    }
    /* Removed in the calendar (just now, or already, per the 404 above): the
       local row is removed too, so the agenda agrees with Outlook. */
    const { error: delErr } = await admin.from('calendar_events').delete().eq('id', row.id);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ ok: true });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
