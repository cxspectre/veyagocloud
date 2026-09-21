/* calendar-recurrence.ts — the three things a recurring, reminded, timezoned
 * event needs turning into something a page can print, none of which needs a
 * Graph token, a database or a clock: a repeat pattern in words, a Windows
 * timezone name as an IANA one, and a reminder in minutes.
 *
 * Deliberately import-free, like _shared/calendar-sync-helpers.ts and for the
 * same reason: calendar-recurrence.test.js loads this module from a data: URL,
 * which no relative import can resolve from.
 *
 * WHY A SUMMARY IS STORED RATHER THAN THE PATTERN. calendarView expands a
 * series into its occurrences (see _shared/calendar-sync.ts's own comment on
 * why it is calendarView and not /events), and an OCCURRENCE carries no
 * `recurrence` at all — only the series master does. So the sync fetches each
 * master once per run and writes the words onto every occurrence of it. The
 * row keeps the sentence, not the pattern: the sync re-runs every 15 minutes
 * (0057 §3), so a better sentence is one migration and one sync away, and the
 * agenda's week lists would otherwise have to carry and parse a jsonb column
 * to print four words.
 *
 * WHY WINDOWS ZONES NEED MAPPING AT ALL. graph-message.ts's header explains
 * that Graph's start/end come back as a wall clock plus a Windows timezone
 * name that Intl cannot parse, and that the sync sidesteps it by asking for
 * UTC. `originalStartTimeZone` is the one place that name survives into our
 * rows (0057 stored it as `time_zone`, "shown for context; nothing computes
 * from it yet"). Computing from it is exactly what a browser has to do to say
 * "10:00 in Amsterdam, 09:00 for you" — and `new Intl.DateTimeFormat('en',
 * { timeZone: 'W. Europe Standard Time' })` throws a RangeError. So the sync
 * stores BOTH: the name Graph sent, untouched, and — when this file
 * recognises it — the IANA name that a browser can actually compute in.
 * Unrecognised is null, never a guess: a page that says "booked in W. Europe
 * Standard Time" and stops is honest, one that converts through the wrong
 * zone is an hour out, which is the bug graph-message.ts already refuses to
 * risk for start times.
 */

/* Graph's eventType. Anything else — a value from a future API version, or a
 * hand-made row that never came from Graph at all — reads as a plain single
 * event, which is what a row with no series information is. */
export const RECURRENCE_TYPES = ['singleInstance', 'occurrence', 'exception', 'seriesMaster'] as const;
export type RecurrenceType = typeof RECURRENCE_TYPES[number];

export function recurrenceTypeOf(value: unknown): RecurrenceType {
  const v = String(value ?? '');
  return (RECURRENCE_TYPES as readonly string[]).includes(v) ? v as RecurrenceType : 'singleInstance';
}

/* Whether a row is part of a series at all — an occurrence, an occurrence
 * someone moved (exception), or the master itself. What the agenda marks as
 * "repeats", and what update-calendar-event and delete-calendar-event have
 * refused since 0057 (_shared/calendar-event-guard.ts). */
export function isRecurring(type: unknown): boolean {
  return recurrenceTypeOf(type) !== 'singleInstance';
}

export interface GraphRecurrence {
  pattern?: {
    type?: string;
    interval?: number;
    month?: number;
    dayOfMonth?: number;
    daysOfWeek?: string[];
    index?: string;
  };
  range?: {
    type?: string;
    endDate?: string;
    numberOfOccurrences?: number;
  };
}

const WEEKDAYS: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/* Graph's relativeMonthly/relativeYearly index. 'last' is a real value, not a
 * count, which is why this is a map and not an array lookup. */
const INDEXES: Record<string, string> = {
  first: 'first', second: 'second', third: 'third', fourth: 'fourth', last: 'last',
};

/* "Monday", "Monday and Wednesday", "Monday, Wednesday and Friday" — an Oxford
 * comma would read oddly beside the rest of this workspace's own prose. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function daysOf(pattern: GraphRecurrence['pattern']): string {
  const days = (pattern?.daysOfWeek ?? [])
    .map((d) => WEEKDAYS[String(d ?? '').toLowerCase()])
    .filter(Boolean);
  return listOf(days);
}

/* "Every week" / "Every 3 weeks". An interval Graph did not send, or one that
 * is not a whole number above zero, is every one — the commonest pattern by
 * far, and a saner floor than "every 0 weeks". */
function every(unit: string, interval: unknown): string {
  const n = Number(interval);
  return Number.isInteger(n) && n > 1 ? `Every ${n} ${unit}s` : `Every ${unit}`;
}

/* A day of the month Graph sent, or null: only 1–31 is a day, and a month
 * pattern missing one is better left unsaid than printed as "day 0". */
function dayOfMonth(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

function monthName(value: unknown): string | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? MONTHS[n - 1] : null;
}

/* How long it goes on for, appended to the pattern: nothing at all for a
 * series with no end, which is most of them and which "Every week" already
 * says. An endDate is Graph's plain 'YYYY-MM-DD' — read by its parts rather
 * than through Date, so a machine west of Greenwich does not print the day
 * before (the same trap toInstant() exists for, in the other direction). */
function until(range: GraphRecurrence['range']): string {
  const type = String(range?.type ?? '').toLowerCase();
  if (type === 'numbered') {
    const n = Number(range?.numberOfOccurrences);
    if (Number.isInteger(n) && n > 0) return `, ${n} time${n === 1 ? '' : 's'}`;
    return '';
  }
  if (type !== 'enddate') return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(range?.endDate ?? ''));
  if (!parts) return '';
  const month = monthName(Number(parts[2]));
  if (!month) return '';
  return `, until ${Number(parts[3])} ${month} ${parts[1]}`;
}

/* A patternedRecurrence in one sentence — "Every 2 weeks on Monday and
 * Thursday, until 3 December 2026" — or null when Graph sent no pattern, or
 * one shaped unlike anything documented. Null is what a non-recurring event
 * has, so an unreadable pattern simply does not claim to repeat, rather than
 * printing half a sentence about a rule nobody here understood. */
export function recurrenceSummary(recurrence: GraphRecurrence | null | undefined): string | null {
  const pattern = recurrence?.pattern;
  const type = String(pattern?.type ?? '').toLowerCase();
  const days = daysOf(pattern);
  const day = dayOfMonth(pattern?.dayOfMonth);
  const index = INDEXES[String(pattern?.index ?? '').toLowerCase()];
  const month = monthName(pattern?.month);
  const tail = until(recurrence?.range);

  switch (type) {
    case 'daily':
      return every('day', pattern?.interval) + tail;
    case 'weekly':
      return every('week', pattern?.interval) + (days ? ` on ${days}` : '') + tail;
    case 'absolutemonthly':
      return every('month', pattern?.interval) + (day ? ` on day ${day}` : '') + tail;
    case 'relativemonthly':
      return index && days
        ? every('month', pattern?.interval) + ` on the ${index} ${days}` + tail
        : every('month', pattern?.interval) + tail;
    case 'absoluteyearly':
      return 'Every year' + (day && month ? ` on ${day} ${month}` : '') + tail;
    case 'relativeyearly':
      return index && days && month
        ? `Every year on the ${index} ${days} of ${month}${tail}`
        : 'Every year' + tail;
    default:
      return null;
  }
}

/* Windows timezone names to IANA ones, for the zones a studio working out of
 * the Netherlands and billing in Europe and North America actually meets. NOT
 * the full CLDR windowsZones.xml (over a hundred entries, most of which this
 * workspace will never see): a name missing from here answers null, and a page
 * then prints the Windows name plainly instead of converting through a zone
 * nobody checked. Add a row when a real event turns up carrying one. */
const WINDOWS_ZONES: Record<string, string> = {
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Amsterdam',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'w. central africa standard time': 'Africa/Lagos',
  'e. europe standard time': 'Europe/Chisinau',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kyiv',
  'turkey standard time': 'Europe/Istanbul',
  'russian standard time': 'Europe/Moscow',
  'israel standard time': 'Asia/Jerusalem',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'sa eastern standard time': 'America/Cayenne',
  'e. south america standard time': 'America/Sao_Paulo',
  'south africa standard time': 'Africa/Johannesburg',
  'e. africa standard time': 'Africa/Nairobi',
  'egypt standard time': 'Africa/Cairo',
  'morocco standard time': 'Africa/Casablanca',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'central america standard time': 'America/Guatemala',
  'sa pacific standard time': 'America/Bogota',
};

/* An IANA name has no spaces and is either a plain region ("UTC") or
 * Area/Location, optionally with a third part (America/Argentina/Buenos_Aires).
 * A Windows name always has spaces ("W. Europe Standard Time"), which is what
 * makes the two tellable apart without a lookup — and what
 * calendar_events_time_zone_iana_shape (0068) re-checks in the database. */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+){0,2}$/;

/* The IANA name for whatever Graph sent as a zone, or null when this file does
 * not recognise it. A value that is ALREADY an IANA name passes through: some
 * mailboxes are configured with one, and Graph then returns it verbatim. */
export function ianaZone(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const mapped = WINDOWS_ZONES[raw.toLowerCase()];
  if (mapped) return mapped;
  /* Not in the map and not IANA-shaped: an unknown Windows name, or something
     stranger. Null, so nothing downstream converts through a guess. */
  return IANA_SHAPE.test(raw) && raw.length <= 64 ? raw : null;
}

/* Outlook's own ceiling on a reminder is four weeks before the event; Graph
 * will accept larger numbers on some paths and they are meaningless here. */
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;

/* Graph's reminderMinutesBeforeStart as a whole number of minutes, or null for
 * "not known" — missing, negative, fractional, or past the ceiling. Zero is
 * kept: "at the time of the event" is a real setting someone chose, not an
 * absence, the same distinction graph-message.ts's sizeOf() draws for a
 * genuinely empty attachment.
 *
 * The typeof test is doing real work, not tidying: Number(null) is 0 and
 * Number('') is 0, so a coercing version of this function would turn "Graph
 * sent nothing" into "remind me at the moment it starts" — a row that says
 * something false rather than saying nothing. Graph sends JSON, so a real
 * value is always a number here. */
export function reminderMinutes(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_MINUTES) return null;
  return value;
}

/* The six columns 0068 added for series, reminders and zones, read off one
 * Graph event. Separate from graph-message.ts's toEventRow — which produces
 * every OTHER column of the same row — for one blunt reason: toEventRow is
 * tested by loading graph-message.ts from a data: URL, and a data: URL module
 * cannot resolve a relative import, so graph-message.ts must stay import-free
 * and cannot reach the lookup tables above. Both callers (_shared/calendar-
 * sync.ts's upsert loop and update-calendar-event's read-back) merge the two
 * results, so there is still exactly one place each column is decided.
 *
 * `seriesSummary` is the words for the series this event belongs to, fetched
 * from its master by the caller: an expanded occurrence carries no pattern of
 * its own (see the file header). An event that IS the master reads its own.
 *
 * `hidden` is graph-message.ts's privateInStudio() — a private event in the
 * shared studio calendar keeps its time and nothing else, so it does not say
 * that it repeats weekly, when its owner is reminded, or how they replied. */
export function eventExtraFields(
  ev: {
    type?: string;
    seriesMasterId?: string;
    recurrence?: unknown;
    isReminderOn?: boolean;
    reminderMinutesBeforeStart?: number;
    originalStartTimeZone?: string;
  },
  options: { seriesSummary?: string | null; hidden?: boolean } = {},
): {
  recurrence_type: RecurrenceType;
  series_master_id: string | null;
  recurrence_summary: string | null;
  reminder_on: boolean;
  reminder_minutes: number | null;
  time_zone_iana: string | null;
} {
  if (options.hidden) {
    return {
      recurrence_type: 'singleInstance',
      series_master_id: null,
      recurrence_summary: null,
      reminder_on: false,
      reminder_minutes: null,
      time_zone_iana: null,
    };
  }
  const type = recurrenceTypeOf(ev.type);
  const own = recurrenceSummary(ev.recurrence as GraphRecurrence | null | undefined);
  const summary = own ?? (options.seriesSummary ? String(options.seriesSummary) : null);
  return {
    recurrence_type: type,
    series_master_id: String(ev.seriesMasterId ?? '').trim() || null,
    /* Only ever on something that genuinely repeats: a single meeting that
       somehow arrived with a pattern attached would otherwise print "Every
       week" under a one-off, which is worse than saying nothing. */
    recurrence_summary: type === 'singleInstance' ? null : summary,
    reminder_on: ev.isReminderOn === true,
    /* Kept even when the reminder is off, so switching it back on in Outlook
       does not read as "no reminder" until the next full sync — but a row
       with no reminder set at all has none to keep. */
    reminder_minutes: ev.isReminderOn === true ? reminderMinutes(ev.reminderMinutesBeforeStart) : null,
    time_zone_iana: ianaZone(ev.originalStartTimeZone),
  };
}
