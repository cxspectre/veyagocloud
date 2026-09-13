/* create-calendar-event — book something, in Outlook and here, in one call.
 *
 * The workspace can already insert a local event through RLS (connection_id
 * null). That is the right behaviour when no calendar is connected, and the
 * wrong one when there is: an event only the workspace knows about is an event
 * you will miss, because your phone shows Outlook.
 *
 * So: create it in Graph first, then store it already owned by the sync
 * (connection_id + external_id set). Doing it in that order means a Graph
 * failure leaves nothing behind rather than a local row pretending to be a
 * meeting. The caller falls back to a local-only insert when this returns 409.
 *
 * Deploy:  supabase functions deploy create-calendar-event
 * Body:    { title, startsAt, endsAt?, detail?, location?, allDay?, attendees?,
 *            projectId?, companyId?, contactId?, kind? }
 * Caller must be staff.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { eventPayload } from '../_shared/graph-write.ts';
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

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);

    const body = await req.json().catch(() => ({}));
    if (!body?.title || !String(body.title).trim()) return json({ error: 'An event needs a title' }, 400);
    if (!body?.startsAt) return json({ error: 'An event needs a start time' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: me } = await asCaller.rpc('active_employee_id');

    /* A personal calendar is the person's own; a studio one is shared. Prefer
       the caller's own, since an event they booked belongs in their diary. */
    const { data: calendars } = await admin
      .from('integration_connections')
      .select('id, account_label, employee_id')
      .eq('provider', 'microsoft_calendar')
      .eq('status', 'connected');

    const calendar = (calendars ?? []).find((c) => c.employee_id === me)
                  ?? (calendars ?? []).find((c) => c.employee_id === null)
                  ?? null;

    /* 409: nothing is connected. The caller inserts a local event itself —
       it has an RLS policy for exactly that, and a round trip through here
       would add nothing. */
    if (!calendar) {
      return json({ error: 'No calendar is connected', localOnly: true }, 409);
    }

    let payload;
    try {
      payload = eventPayload({
        title: String(body.title),
        startsAt: String(body.startsAt),
        endsAt: body.endsAt ? String(body.endsAt) : null,
        detail: body.detail ?? null,
        location: body.location ?? null,
        allDay: body.allDay === true,
        attendees: Array.isArray(body.attendees) ? body.attendees : [],
      });
    } catch (err) {
      return json({ error: String((err as Error).message) }, 400);
    }

    const token = await accessTokenFor(admin, calendar.id);
    const res = await fetch(`${GRAPH}/me/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return json({ error: `Graph refused the event: ${(await res.text()).slice(0, 200)}` }, 502);
    }
    const created = await res.json();

    /* Read it back through the same parser the sync uses, so the stored row is
       identical to what the next sync would write — otherwise the first sync
       after this "corrects" a row that was already right, and the difference
       is invisible until someone diffs it. */
    const row = toEventRow(created, String(calendar.account_label).split('@')[1] ?? '');
    if (!row) return json({ error: 'Graph returned an event we could not read back' }, 502);

    const { data: stored, error: storeErr } = await admin
      .from('calendar_events')
      .upsert({
        connection_id: calendar.id,
        calendar_id: 'default',
        external_id: row.external_id,
        title: row.title,
        detail: row.detail,
        location: row.location,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        all_day: row.all_day,
        /* The caller's intent wins over the guess toEventRow makes from the
           attendee list — they said what this is for. */
        kind: body.kind ?? row.kind,
        status: row.status,
        attendees: row.attendees,
        project_id: body.projectId ?? null,
        company_id: body.companyId ?? null,
        contact_id: body.contactId ?? null,
        created_by: me ?? null,
      }, { onConflict: 'connection_id,calendar_id,external_id' })
      .select('id')
      .single();
    if (storeErr) return json({ error: storeErr.message }, 500);

    return json({ ok: true, id: stored.id, externalId: row.external_id, calendar: calendar.account_label });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
