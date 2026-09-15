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
 * Which calendar, and where in Graph: _shared/calendar-choice.ts picks the
 * studio calendar for client work and the booker's own for the rest, and the
 * event is written to the calendar the connection names — /users/{address} for
 * a shared one (_shared/mailbox.ts). It used to write to /me for every
 * connection, so an event booked "in the studio calendar" landed in the diary
 * of whoever had connected it.
 *
 * Checked before anything is booked (security review, 2026-09-14): the
 * project, company and contact named exist and the booker can see them, and
 * the kind is one the agenda knows. Client work is what is linked to one of
 * those — never guessed from the kind. A calendar that is not connected, that is
 * a team member's own address in the studio's name, or whose grant lacks
 * Calendars.ReadWrite.Shared for a shared calendar, is never booked into — and
 * never swapped for another: client work is then booked in the workspace alone
 * (409), and a private event is refused (503). So is one whose sign-in can no
 * longer be refreshed. The booker is invited to a studio booking, so it is in
 * their own diary too.
 *
 * Deploy:  supabase functions deploy create-calendar-event
 * Body:    { title, startsAt, endsAt?, detail?, location?, allDay?, attendees?,
 *            projectId?, companyId?, contactId?, kind? }
 * Caller must be staff.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged, storedGrant, TokenRefreshError } from '../_shared/graph-token.ts';
import { eventPayload } from '../_shared/graph-write.ts';
import { toEventRow } from '../_shared/graph-message.ts';
import { calendarFor } from '../_shared/calendar-choice.ts';
import { connectionProblem, grantCovers, grantProblem } from '../_shared/connection-rules.ts';
import { isShared, mailboxPath } from '../_shared/mailbox.ts';
import { teamAddresses } from '../_shared/team-lookup.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHARED_SCOPE = 'Calendars.ReadWrite.Shared';
/* calendar_events.kind (0026). */
const KINDS = ['team', 'client', 'internal', 'personal', 'focus'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* Which record each id names, and how the refusal names it. */
const LINKS: [string, string, string][] = [
  ['projectId', 'client_projects', 'project'],
  ['companyId', 'crm_companies', 'company'],
  ['contactId', 'crm_contacts', 'contact'],
];
const STUDIO_WAITING = 'The studio calendar needs reconnecting, so this is saved in the workspace only.';
const OWN_WAITING = 'Your calendar needs reconnecting before events can be booked into it.';

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

const addressOf = (attendee: unknown): string => String(
  typeof attendee === 'string'
    ? attendee
    : (attendee as { email?: unknown; address?: unknown } | null)?.email
      ?? (attendee as { address?: unknown } | null)?.address
      ?? '',
).trim().toLowerCase();

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
    const kind = body.kind == null || body.kind === '' ? null : String(body.kind);
    if (kind !== null && !KINDS.includes(kind)) return json({ error: `An event's kind is one of ${KINDS.join(', ')}` }, 400);

    /* Each record named must be one the booker can see — read as them, so RLS
       answers — and what is stored is the id checked, not whatever else the
       request carried. An id that is not one used to pick the studio calendar,
       book the event in Outlook, and only then fail to store it. */
    let linked: Record<string, string | null> = { projectId: null, companyId: null, contactId: null };
    for (const [key, table, what] of LINKS) {
      const raw = body[key];
      if (raw == null || raw === '') continue;
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!UUID.test(id)) return json({ error: `That ${what} is not one you can book against.` }, 400);
      const { data: found, error: findErr } = await asCaller.from(table).select('id').eq('id', id).maybeSingle();
      if (findErr || !found) return json({ error: `That ${what} is not one you can book against.` }, 400);
      linked = { ...linked, [key]: id };
    }

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: me, error: meErr } = await asCaller.rpc('active_employee_id');
    if (meErr) return json({ error: 'Could not tell who you are: ' + meErr.message }, 500);

    const { data: rows, error: calErr } = await admin
      .from('integration_connections')
      .select('id, account_label, employee_id, external_id, status, updated_at')
      .eq('provider', 'microsoft_calendar')
      .neq('status', 'disconnected');
    if (calErr) return json({ error: 'Could not read the calendars: ' + calErr.message }, 500);

    /* A calendar that fails the connection rules — or a studio calendar whose
       grant was never checked against the directory — counts as one waiting to
       be reconnected: never booked into, and never swapped for another. */
    const owners = await teamAddresses(admin);
    const calendars = await Promise.all((rows ?? []).map(async (c) => {
      const problem = connectionProblem(c, owners.get(String(c.account_label).trim().toLowerCase()) ?? null)
        ?? (c.employee_id === null ? grantProblem(c, (await storedGrant(admin, c.id))?.scope) : null);
      return problem ? { ...c, status: 'needs_reauth' } : c;
    }));

    /* Client work is what is linked to a client — never a guess from the kind:
       "Zoom meeting" on a private appointment put it in the studio calendar,
       where every member of staff reads it. */
    const clientWork = Boolean(linked.projectId || linked.companyId || linked.contactId);
    const choice = calendarFor(calendars, { employeeId: typeof me === 'string' ? me : null, clientWork });
    if (!choice.calendar) {
      if (choice.reason === 'own-needs-reconnect') return json({ error: OWN_WAITING, reason: choice.reason }, 503);
      /* 409: the caller books it in the workspace alone, where staff see it. */
      return json({
        error: choice.reason === 'studio-needs-reconnect' ? STUDIO_WAITING : 'No calendar is connected',
        localOnly: true,
        reason: choice.reason,
      }, 409);
    }
    const calendar = choice.calendar;

    if (isShared(calendar)) {
      const grant = await storedGrant(admin, calendar.id);
      if (!grant || !grantCovers(grant.scope, SHARED_SCOPE)) {
        if (grant) {
          await markNeedsReauthIfUnchanged(admin, calendar.id,
            `Reconnect to book into the shared calendar: its grant does not include ${SHARED_SCOPE}.`, calendar.updated_at);
        }
        return calendar.employee_id === null
          ? json({ error: STUDIO_WAITING, localOnly: true, reason: 'studio-needs-reconnect' }, 409)
          : json({ error: OWN_WAITING, reason: 'own-needs-reconnect' }, 503);
      }
    }

    /* The booker, invited to a studio booking, so it is in their own diary. */
    const attendees = Array.isArray(body.attendees) ? [...body.attendees] : [];
    const booker = String(userData.user.email ?? '').trim().toLowerCase();
    if (calendar.employee_id === null && booker && !attendees.some((a) => addressOf(a) === booker)) {
      attendees.push(booker);
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
        attendees,
      });
    } catch (err) {
      return json({ error: String((err as Error).message) }, 400);
    }

    let token: string;
    try {
      token = await accessTokenFor(admin, calendar.id);
    } catch (err) {
      /* A sign-in that can no longer be refreshed — the consenting account lost
         access, say — leaves a calendar waiting to be reconnected, as a missing
         grant does above: client work is booked in the workspace alone, and a
         private event is refused. One Microsoft could not refresh just now saves
         nothing; booking again in a moment works. */
      if (err instanceof TokenRefreshError && err.permanent) {
        return calendar.employee_id === null
          ? json({ error: STUDIO_WAITING, localOnly: true, reason: 'studio-needs-reconnect' }, 409)
          : json({ error: OWN_WAITING, reason: 'own-needs-reconnect' }, 503);
      }
      throw err;
    }
    const res = await fetch(`${GRAPH}${mailboxPath(calendar)}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify(payload),
    });
    /* A refusal is said, not turned into a reconnect: the stored grant, above,
       decides that. A studio calendar Graph will not write to — its consenting
       account lost access, say, while the calendar only reads as 'error' — books
       client work in the workspace alone, as one waiting to be reconnected does,
       rather than saving nothing. A private event is still refused. */
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (calendar.employee_id === null && [401, 403, 404].includes(res.status)) {
        return json({
          error: `The studio calendar would not take the event (Graph ${res.status}), so it is saved in the workspace only. It may need reconnecting.`,
          localOnly: true,
          reason: 'studio-needs-reconnect',
        }, 409);
      }
      return json({ error: `Graph refused the event (${res.status}): ${detail}` }, 502);
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
        kind: kind ?? row.kind,
        status: row.status,
        attendees: row.attendees,
        organizer_name: row.organizer_name,
        organizer_email: row.organizer_email,
        meeting_url: row.meeting_url,
        time_zone: row.time_zone,
        project_id: linked.projectId,
        company_id: linked.companyId,
        contact_id: linked.contactId,
        created_by: typeof me === 'string' ? me : null,
      }, { onConflict: 'connection_id,calendar_id,external_id' })
      .select('id')
      .single();
    if (storeErr) return json({ error: storeErr.message }, 500);

    return json({ ok: true, id: stored.id, externalId: row.external_id, calendar: calendar.account_label });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
