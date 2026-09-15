/* update-calendar-event — changes a synced event in Outlook first, then here.
 *
 * A hand-made event (connection_id null) is changed straight through RLS
 * (0048, 0057 §1): whoever booked it, or an owner or admin, PATCHes the row
 * and the database enforces which columns. A SYNCED event (connection_id set)
 * is nobody's to touch that way — 0026 and 0048 both say so — because a row
 * changed here alone would look right until the next sync quietly put it
 * back. This function is the one path there is: change it in Outlook, and
 * only once Graph has taken it, update the local row to match — the same
 * order create-calendar-event books a new one in.
 *
 * Read back before writing, always: the event's CURRENT state in the
 * calendar decides whether this may proceed (cancelled, part of a series, or
 * marked private in a studio calendar all refuse — _shared/calendar-
 * event-guard.ts), and its ETag guards the PATCH itself (If-Match), so a
 * change made in Outlook a moment ago is not silently overwritten.
 *
 * Who may do this: the same rule sync-outlook-calendar already uses
 * (_shared/connection-rules.ts mayActOn) — the studio's calendars are shared,
 * so any member of staff acts on one; a personal calendar is its owner's
 * alone. A calendar waiting to be reconnected, or whose grant does not cover
 * a shared mailbox, refuses rather than guessing (_shared/calendar-sync.ts
 * calendarSyncBlocker, the same check the sync itself runs first).
 *
 * NOT exercised against a live Graph or a live Postgres — see the file
 * header this project already uses for that boundary (graph-message.test.js
 * and its neighbours). What is unit-tested: eventChangeRefusal,
 * eventUpdatePayload and keptDuration, which decide everything this function
 * itself does not just read off the request or the database.
 *
 * Deploy:  supabase functions deploy update-calendar-event
 * Body:    { eventId, changes: { title?, detail?, location?, starts_at?, ends_at? }, since? }
 * Caller must be staff.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, TokenRefreshError } from '../_shared/graph-token.ts';
import { toEventRow, toInstant, type GraphEvent } from '../_shared/graph-message.ts';
import { eventUpdatePayload, keptDuration, type EventChanges } from '../_shared/graph-write.ts';
import { eventChangeRefusal } from '../_shared/calendar-event-guard.ts';
import { calendarSyncBlocker } from '../_shared/calendar-sync.ts';
import { mayActOn } from '../_shared/connection-rules.ts';
import { mailboxPath } from '../_shared/mailbox.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const EDITABLE = ['title', 'detail', 'location', 'starts_at', 'ends_at'];
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
    const raw = (body?.changes && typeof body.changes === 'object') ? body.changes : {};
    const keys = Object.keys(raw);
    if (!keys.length) return json({ error: 'Nothing was changed.' }, 400);
    if (!keys.every((k) => EDITABLE.includes(k))) {
      return json({ error: 'Only an event’s title, times, place and details can be changed here.' }, 400);
    }
    const changes: EventChanges = raw;
    if ('title' in changes && !String(changes.title ?? '').trim()) return json({ error: 'An event needs a title.' }, 400);
    if ('starts_at' in changes && isNaN(Date.parse(String(changes.starts_at)))) {
      return json({ error: 'An event needs a start time.' }, 400);
    }
    if (changes.starts_at && changes.ends_at
        && !(Date.parse(String(changes.ends_at)) > Date.parse(String(changes.starts_at)))) {
      return json({ error: 'An event cannot end before it starts.' }, 400);
    }
    const since = body?.since ? String(body.since) : null;

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: row, error: rowErr } = await admin
      .from('calendar_events')
      .select('id, connection_id, calendar_id, external_id, updated_at')
      .eq('id', eventId)
      .maybeSingle();
    if (rowErr) return json({ error: rowErr.message }, 500);
    if (!row) return json({ error: 'That event is not loaded any more.' }, 404);
    if (!row.connection_id || !row.external_id) {
      return json({ error: 'This event is not from a connected calendar.' }, 400);
    }
    if (since && row.updated_at && since !== row.updated_at) {
      return json({ error: 'This event was changed here since you opened it. Close this and open it again.' }, 409);
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

    /* Read back first: the event as the calendar has it right now, its ETag
       for the PATCH, and enough to decide whether this may proceed at all. */
    const studio = conn.employee_id === null;
    const getRes = await fetch(
      `${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(row.external_id)}` +
        '?$select=id,type,isCancelled,sensitivity,start,end',
      { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } },
    );
    if (getRes.status === 404) {
      /* Gone from the calendar already — removed or moved out of this
         mailbox in Outlook. Nothing here to change; the local row is stale,
         so it is removed too rather than left to confuse the next sync. */
      await admin.from('calendar_events').delete().eq('id', row.id);
      return json({ error: 'This event no longer exists in the calendar. It has been removed here too.' }, 404);
    }
    if (!getRes.ok) {
      return json({ error: `Graph refused to read the event (${getRes.status}): ${(await getRes.text()).slice(0, 200)}` }, 502);
    }
    const etag = getRes.headers.get('etag') ?? '';
    const current = await getRes.json() as GraphEvent & { type?: string; isCancelled?: boolean; sensitivity?: string };

    const refusal = eventChangeRefusal(current, studio);
    if (refusal) return json({ error: refusal }, 409);

    const safeChanges = keptDuration(changes, {
      starts_at: toInstant(current.start) ?? new Date().toISOString(),
      ends_at: toInstant(current.end),
    });
    let payload: ReturnType<typeof eventUpdatePayload>;
    try {
      payload = eventUpdatePayload(safeChanges);
    } catch (err) {
      return json({ error: String((err as Error).message) }, 400);
    }

    const patchRes = await fetch(`${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(row.external_id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'outlook.timezone="UTC"',
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (patchRes.status === 412) {
      return json({ error: 'This event was changed in the calendar just now. Reload and try again.' }, 409);
    }
    if (!patchRes.ok) {
      const detail = (await patchRes.text()).slice(0, 200);
      return json({ error: `Graph refused the change (${patchRes.status}): ${detail}` }, 502);
    }
    const updated = await patchRes.json();

    /* Read back through the same parser the sync uses, so this row is
       identical to what the next sync would write. */
    const parsed = toEventRow(updated, String(conn.account_label).split('@')[1] ?? '', { hidePrivate: studio });
    if (!parsed) return json({ error: 'Graph returned an event we could not read back' }, 502);

    const { error: saveErr } = await admin.from('calendar_events').update({
      title: parsed.title,
      detail: parsed.detail,
      location: parsed.location,
      starts_at: parsed.starts_at,
      ends_at: parsed.ends_at,
      all_day: parsed.all_day,
      status: parsed.status,
      attendees: parsed.attendees,
      organizer_name: parsed.organizer_name,
      organizer_email: parsed.organizer_email,
      meeting_url: parsed.meeting_url,
      time_zone: parsed.time_zone,
    }).eq('id', row.id);
    if (saveErr) return json({ error: saveErr.message }, 500);

    return json({ ok: true, id: row.id, calendar: conn.account_label });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
