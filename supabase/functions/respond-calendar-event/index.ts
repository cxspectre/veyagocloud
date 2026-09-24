/* respond-calendar-event — answering an invitation in Outlook first, then
 * here. The third of the calendar write functions, and it works exactly the
 * way the other two do (create-calendar-event, update-calendar-event,
 * delete-calendar-event): the calendar is the record, the row is the copy, so
 * Graph is asked first and only what it took is written down. An answer
 * stored here alone would look right until the scheduled sync (0057 §3, every
 * 15 minutes) quietly put the old one back, and the organiser would never
 * have been told at all.
 *
 * WHY THIS IS NOT PART OF update-calendar-event. That function has refused
 * every occurrence, exception and series master since 0057 (_shared/calendar-
 * event-guard.ts), because editing ONE occurrence of a series means writing
 * an exception back and that is still out of scope. Replying is not editing:
 * Graph's accept / tentativelyAccept / decline work on an occurrence and on a
 * series master alike, so this carries its own rule (_shared/calendar-
 * response.ts responseRefusal) rather than widening a guard that exists to
 * refuse. The Graph call itself is the only new thing here; everything about
 * WHO may act on WHICH calendar is the shared modules the other two already
 * use, unchanged.
 *
 * DECLINING USUALLY REMOVES THE MEETING FROM THE CALENDAR. That is Outlook's
 * own behaviour, not something this function does: the next sync then finds
 * the occurrence gone from calendarView and cancels the local row through
 * vanishedIds (_shared/calendar-sync-helpers.ts), exactly as it would for any
 * meeting removed in Outlook. So the row this writes 'declined' onto may well
 * be cancelled fifteen minutes later, and that is the right outcome — not a
 * bug to chase.
 *
 * NOT exercised against a live Graph or a live Postgres — see update-calendar-
 * event's header for the same boundary. What IS unit-tested, in
 * _shared/calendar-response.test.js: responseAction, responseRefusal,
 * responseTarget and respondPayload, which decide everything below that is
 * not read straight off the request or the database.
 *
 * Deploy:  supabase functions deploy respond-calendar-event
 * Body:    { eventId, response: 'accepted'|'tentativelyAccepted'|'declined',
 *            scope?: 'occurrence'|'series', comment?, sendResponse? }
 * Caller must be staff.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, TokenRefreshError } from '../_shared/graph-token.ts';
import {
  MAX_COMMENT, responseAction, responseRefusal, respondPayload, responseTarget,
} from '../_shared/calendar-response.ts';
import { calendarSyncBlocker, DEFAULT_CALENDAR_ID } from '../_shared/calendar-sync.ts';
import { mayActOn } from '../_shared/connection-rules.ts';
import { mailboxPath } from '../_shared/mailbox.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['occurrence', 'series'];
const OWN_WAITING = 'Your calendar needs reconnecting before a reply can be sent from it.';
const STUDIO_WAITING = 'The studio calendar needs reconnecting before a reply can be sent from it.';

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

    /* The three answers a person may send, spelled as Graph spells them —
       anything else is refused here rather than turned into a guess, since
       the same three words are the check constraint on the column this ends
       up writing (0068 calendar_events_response_status_known). */
    const action = responseAction(body?.response);
    if (!action) {
      return json({ error: 'A reply must be accepted, tentativelyAccepted or declined.' }, 400);
    }
    const scope = body?.scope === undefined ? 'occurrence' : String(body.scope);
    if (!SCOPES.includes(scope)) {
      return json({ error: 'A reply answers either this occurrence or the series.' }, 400);
    }
    const comment = body?.comment == null ? '' : String(body.comment);
    if (comment.length > MAX_COMMENT) {
      return json({ error: `A note with a reply can be at most ${MAX_COMMENT} characters.` }, 400);
    }

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: row, error: rowErr } = await admin
      .from('calendar_events')
      .select('id, connection_id, calendar_id, external_id, series_master_id, recurrence_type')
      .eq('id', eventId)
      .maybeSingle();
    if (rowErr) return json({ error: rowErr.message }, 500);
    if (!row) return json({ error: 'That event is not loaded any more.' }, 404);
    if (!row.connection_id || !row.external_id) {
      /* A hand-made event is not an invitation: nobody was invited through
         Outlook, so there is no organiser waiting to hear back. */
      return json({ error: 'This event was entered in the workspace, so there is no invitation to answer.' }, 400);
    }
    if (scope === 'series' && !row.series_master_id) {
      return json({ error: 'This meeting is not part of a series.' }, 400);
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

    /* Which Graph event the reply actually goes to: this date, or the whole
       run — the series master's id, which every occurrence already carries,
       so the browser never has to know it. */
    const target = responseTarget(scope, row);
    const studio = conn.employee_id === null;

    /* Read it back first, the same order update-calendar-event keeps: the
       calendar's CURRENT state decides whether there is anything to answer,
       not our copy of it, which can be a quarter of an hour old. */
    const getRes = await fetch(
      `${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(target)}` +
        '?$select=id,type,isCancelled,sensitivity,isOrganizer,responseStatus',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (getRes.status === 404) {
      return json({ error: 'This meeting is no longer in the calendar, so there is nothing to answer.' }, 404);
    }
    if (!getRes.ok) {
      return json({ error: `Graph refused to read the meeting (${getRes.status}): ${(await getRes.text()).slice(0, 200)}` }, 502);
    }
    const current = await getRes.json();

    const refusal = responseRefusal(current, studio);
    if (refusal) return json({ error: refusal }, 409);

    const postRes = await fetch(
      `${GRAPH}${mailboxPath(conn)}/events/${encodeURIComponent(target)}/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(respondPayload({ comment, sendResponse: body?.sendResponse !== false })),
      },
    );
    /* Graph answers 202 Accepted with an empty body: the reply is queued for
       the organiser, and the event's own responseStatus follows. Nothing is
       read back from it — a 202 says the answer was taken, and re-reading
       immediately races the very update it would be checking for. */
    if (!postRes.ok) {
      const detail = (await postRes.text()).slice(0, 200);
      return json({ error: `Graph refused the reply (${postRes.status}): ${detail}` }, 502);
    }

    /* Written straight onto the row rather than re-read: the answer just sent
       IS the answer, and the next sync confirms it from Graph within fifteen
       minutes either way. A series answer lands on every occurrence of it
       this connection has — they all changed, and leaving eleven of twelve
       saying "no reply yet" would be worse than a moment's optimism.

       The service role writes this, so neither RLS (0026, 0048) nor 0057's
       column guard applies — which is the whole reason this function exists
       rather than the browser PATCHing response_status itself. 0068
       deliberately did NOT add response_status to that guard's five editable
       columns. */
    const answer = String(body.response);
    let saved = admin.from('calendar_events').update({ response_status: answer }, { count: 'exact' });
    saved = scope === 'series'
      ? saved.eq('connection_id', row.connection_id)
        .eq('calendar_id', row.calendar_id ?? DEFAULT_CALENDAR_ID)
        .eq('series_master_id', row.series_master_id)
      : saved.eq('id', row.id);
    const { error: saveErr, count } = await saved;
    if (saveErr) return json({ error: saveErr.message }, 500);

    return json({ ok: true, id: row.id, response: answer, scope, updated: count ?? 0 });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
