/* calendar-event-guard.ts — whether a synced event may be changed or removed
 * from the workspace, once update-calendar-event and delete-calendar-event
 * have read it back from Graph.
 *
 * RLS already keeps a synced row (connection_id set) out of reach from the
 * browser (0026, 0048): these two functions are the only path to change or
 * remove one, and they write with the service role, so nothing in the
 * database stops them. What stops them is here — checked against what Graph
 * says the event is NOW, not our stale copy, since a sync a moment ago could
 * already be out of date:
 *
 *   - cancelled: nothing left to change.
 *   - part of a series (occurrence, exception or the series master itself):
 *     changing one occurrence right would need reading the whole series and
 *     writing back an exception, which is out of scope today. Refused rather
 *     than silently rewriting every occurrence, or only this one in a way
 *     Outlook shows differently on every device.
 *   - marked personal, private or confidential in a STUDIO calendar: the
 *     workspace already shows it to every member of staff as "Private" with
 *     nothing else (graph-message.ts toEventRow); changing what nobody here
 *     can see is not this function's to do. A personal calendar's own private
 *     event is still that person's to change — read as /me, it was never
 *     hidden from them.
 *
 * Kept free of Deno and Supabase so calendar-event-guard.test.js runs it in
 * node, the way connection-rules.ts and calendar-choice.ts do.
 */

export type GraphEventGuardInput = {
  type?: string;               // 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
  isCancelled?: boolean;
  sensitivity?: string;
};

/* Why an event fetched from Graph may not be changed or removed here, or
 * null. `studio` is whether the calendar it lives in is the shared one
 * (connection.employee_id === null) — the same flag toEventRow's hidePrivate
 * uses. */
export function eventChangeRefusal(ev: GraphEventGuardInput, studio: boolean): string | null {
  if (ev.isCancelled) {
    return 'This event was already cancelled in the calendar. There is nothing here to change.';
  }
  if (ev.type && ev.type !== 'singleInstance') {
    return 'This is part of a recurring series, which cannot be changed from the workspace yet. Change it in the calendar it came from.';
  }
  if (studio && ['personal', 'private', 'confidential'].includes(String(ev.sensitivity ?? '').toLowerCase())) {
    return 'This event is marked private, so it cannot be changed from the studio calendar.';
  }
  return null;
}
