/* calendar-choice.ts — which connected calendar a workspace booking goes into.

   A personal calendar shows its events to its owner alone (0025, 0026). Client
   work — an event linked to a project, a company or a contact, never one that
   only sounds like it — goes into the studio calendar, where the team sees it,
   with the booker invited. Anything else goes into the booker's own calendar, or the
   studio's when they have none. A colleague's personal calendar is never chosen.

   A calendar waiting to be reconnected is not swapped for another one: client
   work is then booked in the workspace alone, where staff see it, and a private
   event is refused rather than landing in the shared calendar (security review,
   2026-09-14). Callers pass every calendar that is not disconnected, with its
   status. Kept free of Deno and Supabase so calendar-choice.test.js can run it. */

export type CalendarConnection = {
  id: string;
  account_label: string;
  employee_id: string | null;
  external_id?: string | null;
  status?: string | null;
  /* When the row last changed, for a needs_reauth flag that must not land on a
     reconnect (markNeedsReauthIfUnchanged). */
  updated_at?: string | null;
};

export type Booking = {
  /* active_employee_id() for the person booking, null when they have none. */
  employeeId: string | null;
  /* The event is client work. */
  clientWork: boolean;
};

export type Reason = 'ok' | 'no-studio' | 'studio-needs-reconnect' | 'own-needs-reconnect' | 'none';

export type Choice = { calendar: CalendarConnection | null; reason: Reason };

const byAddress = (a: CalendarConnection, b: CalendarConnection) =>
  String(a.account_label).localeCompare(String(b.account_label));

/* Connected — or connected with its last sync failed. That is usually Graph
   having a moment, and nothing syncs a calendar again by itself, so counting it
   as broken refused bookings until someone reconnected. Graph's own answer to
   the booking says whether it really is broken (502). */
const live = (c: CalendarConnection) => c.status === 'connected' || c.status === 'error';

export function calendarFor(calendars: CalendarConnection[], booking: Booking): Choice {
  const list = Array.isArray(calendars) ? calendars : [];
  /* By address, so the same booking always lands in the same place. */
  const studios = list.filter((c) => c.employee_id === null).sort(byAddress);
  const owns = booking.employeeId
    ? list.filter((c) => c.employee_id === booking.employeeId).sort(byAddress)
    : [];

  if (booking.clientWork) {
    const studio = studios.find(live);
    if (studio) return { calendar: studio, reason: 'ok' };
    return { calendar: null, reason: studios.length ? 'studio-needs-reconnect' : 'no-studio' };
  }

  const own = owns.find(live);
  if (own) return { calendar: own, reason: 'ok' };
  if (owns.length) return { calendar: null, reason: 'own-needs-reconnect' };

  const studio = studios.find(live);
  if (studio) return { calendar: studio, reason: 'ok' };
  return { calendar: null, reason: studios.length ? 'studio-needs-reconnect' : 'none' };
}
