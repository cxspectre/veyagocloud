/* calendar-response.ts — answering an invitation: what a caller may say, what
 * Graph is asked to do about it, and why it sometimes cannot be said at all.
 *
 * Split out of respond-calendar-event/index.ts for the reason every other
 * pure module here is (connection-rules.ts, calendar-choice.ts,
 * calendar-event-guard.ts): the rules are the part worth testing, and the
 * fetch around them is the part that needs a live Microsoft tenant. Kept free
 * of Deno and Supabase — and import-free — so calendar-response.test.js can
 * load it in node from a data: URL.
 *
 * WHY REPLYING IS NOT AN EDIT. _shared/calendar-event-guard.ts's
 * eventChangeRefusal() refuses every occurrence, exception and series master
 * outright, because changing ONE occurrence of a series right means writing an
 * exception back and that is still out of scope. Replying is not that: Graph's
 * accept / tentativelyAccept / decline actions work on an occurrence exactly
 * as they work on a single meeting, and on the series master for the whole
 * series, so this file carries its OWN refusal rule rather than borrowing the
 * edit guard's. Deliberately not merged into eventChangeRefusal: they refuse
 * for genuinely different reasons, and one function answering two questions is
 * how a rule gets widened by accident.
 *
 * WHY A DECLINE IS STILL A WRITE TO OUTLOOK FIRST. Same order as
 * update-calendar-event and delete-calendar-event (0057): the calendar is the
 * record, the row is the copy. A reply stored here alone would look right
 * until the next sync (15 minutes, 0057 §3) quietly put the old answer back.
 */

/* What Graph records as the calendar owner's own answer — its responseStatus.
 * response vocabulary verbatim, which is also the check constraint on
 * calendar_events.response_status (0068). 'none' is an event nobody was
 * invited to; 'notResponded' is an invitation still waiting. */
export const RESPONSE_STATUSES = [
  'none', 'organizer', 'tentativelyAccepted', 'accepted', 'declined', 'notResponded',
] as const;
export type ResponseStatus = typeof RESPONSE_STATUSES[number];

/* The three a person may actually send. 'organizer' and 'notResponded' are
 * states Graph puts you in, not answers you give, and 'none' is the absence of
 * an invitation — none of them is something to POST. */
export const SENDABLE_RESPONSES = ['accepted', 'tentativelyAccepted', 'declined'] as const;
export type SendableResponse = typeof SENDABLE_RESPONSES[number];

/* Graph's own action segment for each answer: POST …/events/{id}/accept. */
const ACTIONS: Record<SendableResponse, string> = {
  accepted: 'accept',
  tentativelyAccepted: 'tentativelyAccept',
  declined: 'decline',
};

/* Whatever Graph sent, as one of the six — anything unrecognised (a value from
 * a future API version, a missing responseStatus on an event Graph never
 * attached one to) reads as 'none', which is what a row with no invitation on
 * it has. */
export function responseStatusOf(value: unknown): ResponseStatus {
  const v = String(value ?? '');
  return (RESPONSE_STATUSES as readonly string[]).includes(v) ? v as ResponseStatus : 'none';
}

/* The Graph action for an answer a caller asked to send, or null when that is
 * not one of the three. Case-sensitive on purpose: 'tentativelyAccepted' is
 * how Graph spells it coming back and how the database stores it, and
 * accepting 'TENTATIVE' here would let two spellings of one answer into rows
 * that a check constraint then has to refuse further down. */
export function responseAction(response: unknown): string | null {
  const v = String(response ?? '');
  return (SENDABLE_RESPONSES as readonly string[]).includes(v) ? ACTIONS[v as SendableResponse] : null;
}

export type RespondableEvent = {
  isCancelled?: boolean;
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  sensitivity?: string;
  /* 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster' */
  type?: string;
};

/* Why this event, as the calendar has it RIGHT NOW, cannot be replied to — or
 * null. Read off a fresh GET rather than our own row, the same discipline
 * update-calendar-event keeps: the copy here can be up to 15 minutes old, and
 * a meeting cancelled in that gap should refuse rather than send a cheerful
 * acceptance to an organiser who already called it off.
 *
 * `studio` is whether the calendar is the shared one (employee_id null) — the
 * same flag eventChangeRefusal() takes, and the same last rule: a meeting its
 * organiser marked private shows as "Private" and nothing else to every
 * member of staff (graph-message.ts), so answering for it here would be
 * replying in the studio's name to something nobody here can read. Someone's
 * own personal calendar is different: it was never hidden from them. */
export function responseRefusal(ev: RespondableEvent, studio = false): string | null {
  if (ev.isCancelled) {
    return 'This meeting was cancelled in the calendar. There is nothing left to reply to.';
  }
  if (ev.isOrganizer === true || responseStatusOf(ev.responseStatus?.response) === 'organizer') {
    return 'You organised this meeting, so there is no invitation to answer.';
  }
  if (responseStatusOf(ev.responseStatus?.response) === 'none') {
    return 'This is not an invitation — nobody was invited to it, so there is nothing to answer.';
  }
  if (studio && ['personal', 'private', 'confidential'].includes(String(ev.sensitivity ?? '').toLowerCase())) {
    return 'This meeting is marked private, so it cannot be answered from the studio calendar.';
  }
  return null;
}

/* Which Graph event id a reply is actually sent to. 'occurrence' answers for
 * this one date; 'series' answers for the whole run, which is the series
 * master's id — the same id every occurrence of it carries as seriesMasterId,
 * which is why the caller never has to know it. A row that is not part of a
 * series has no master to answer for, so 'series' falls back to the event
 * itself rather than refusing: answering the only occurrence there is IS
 * answering the series. */
export function responseTarget(
  scope: unknown,
  row: { external_id: string; series_master_id?: string | null },
): string {
  return String(scope ?? '') === 'series' && row.series_master_id
    ? row.series_master_id
    : row.external_id;
}

/* The body of the accept / tentativelyAccept / decline POST.
 *
 * sendResponse defaults TRUE: an organiser who is never told cannot plan a
 * room, and Outlook's own default is to send. A comment is trimmed and capped
 * — Graph accepts a long one, but this arrives from a browser form and a
 * megabyte of text in a meeting reply helps nobody. An empty comment is left
 * OUT of the body entirely rather than sent as '': Graph renders an empty
 * comment as an empty paragraph in the reply mail. */
export const MAX_COMMENT = 1000;

/* The two columns 0068 added for an invitation, read off one Graph event —
 * the companion to calendar-recurrence.ts's eventExtraFields(), split the
 * same way and for the same reason (graph-message.ts cannot import either).
 *
 * WHOSE answer this is: the calendar OWNER's. Graph's responseStatus on an
 * event is always the answer of the mailbox the event was read from, so a row
 * synced from someone's personal calendar carries their reply, and one from
 * the studio calendar carries the studio mailbox's. There is no per-person
 * answer to store because there is no per-person copy of the row — each
 * connection syncs its own mailbox's view of the meeting (0026).
 *
 * `hidden` nulls both for a private event in the shared studio calendar, the
 * same rule graph-message.ts's privateInStudio() applies to its attendees. */
export function responseFields(
  ev: RespondableEvent,
  options: { hidden?: boolean } = {},
): { response_status: ResponseStatus; is_organizer: boolean } {
  if (options.hidden) return { response_status: 'none', is_organizer: false };
  return {
    response_status: responseStatusOf(ev.responseStatus?.response),
    is_organizer: ev.isOrganizer === true,
  };
}

export function respondPayload(options: { comment?: string | null; sendResponse?: boolean } = {}) {
  const comment = String(options.comment ?? '').trim().slice(0, MAX_COMMENT);
  return {
    ...(comment ? { comment } : {}),
    sendResponse: options.sendResponse !== false,
  };
}
