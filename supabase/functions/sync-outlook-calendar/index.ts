/* sync-outlook-calendar — pulls a connected calendar into calendar_events.
 *
 * Idempotent: upserts on (connection_id, calendar_id, external_id), the plain
 * unique index from 0028. Hand-made workspace events have a null external_id
 * and are excluded, so a sync can never overwrite something a person entered.
 *
 * Deploy:  supabase functions deploy sync-outlook-calendar
 * Body:    { "connectionId": "...", "days": 60 }
 * Caller must be a manager.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauth, markSynced } from '../_shared/graph-token.ts';
import { toEventRow } from '../_shared/graph-message.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';

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
    const { data: isManager } = await asCaller.rpc('is_manager');
    if (!isManager) return json({ error: 'Managers only' }, 403);

    const body = await req.json().catch(() => ({}));
    connectionId = String(body?.connectionId || '');
    if (!connectionId) return json({ error: 'connectionId is required' }, 400);
    const days = Math.min(Math.max(Number(body?.days) || 60, 1), 365);
    const calendarId = String(body?.calendarId || 'default');

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, provider, account_label')
      .eq('id', connectionId)
      .maybeSingle();
    if (connErr || !conn) return json({ error: 'No such connection' }, 404);
    if (conn.provider !== 'microsoft_calendar') {
      return json({ error: 'That connection is not a calendar' }, 400);
    }

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
      $select: 'id,subject,bodyPreview,start,end,isAllDay,isCancelled,showAs,location,attendees,onlineMeeting',
    });
    const res = await fetch(`${GRAPH}/me/calendarView?${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        /* Ask for UTC, or every dateTime is a wall clock in a Windows timezone
           name — see the header of _shared/graph-message.ts. */
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) {
      throw new Error(`Graph calendarView → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const page = await res.json();

    let written = 0, skipped = 0;
    for (const ev of page.value ?? []) {
      const row = toEventRow(ev, ownDomain);
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

    await markSynced(admin, connectionId, page['@odata.deltaLink'] ?? null);
    return json({ ok: true, events: written, skipped, windowDays: days, calendarId });
  } catch (err) {
    const message = String((err as Error).message || err);
    if (connectionId && !/Managers only|Not signed in/.test(message)) {
      try {
        const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        if (/refresh|invalid_grant|credentials/i.test(message)) {
          await markNeedsReauth(admin, connectionId, message);
        } else {
          await admin.from('integration_connections')
            .update({ status: 'error', last_error: message.slice(0, 500) })
            .eq('id', connectionId);
        }
      } catch { /* reporting the failure must not replace it */ }
    }
    return json({ error: message }, 500);
  }
});
