/* calendar-sync.ts — the parts of pulling one connected calendar's events
 * into calendar_events that need no Graph token, no Postgres connection and
 * no clock to get right, so they can be tested here instead of only reasoned
 * about (calendar-sync.test.js, the way graph-message.ts and
 * connection-rules.ts are tested).
 *
 * Both bugs this exists to fix are things sync-outlook-calendar's own upsert
 * loop was doing without anyone having asked it to (agenda audit, 2026-09-14
 * — "still not fixed" as of the wave-1 agenda review):
 *
 *   1. It read $top=250 and stopped: a calendar with more events than that in
 *      the window silently lost whatever Graph would have sent on a second
 *      page — no error, just an agenda missing whatever came after the 250th.
 *      Graph pages a calendarView response with `@odata.nextLink`; nextLinkOf
 *      is what a caller follows, and vanishedIds is how it then works out
 *      which of the events it already had were not on ANY of those pages —
 *      deleted in Outlook, and so retired here too (the caller marks them
 *      cancelled; calendar_events already excludes cancelled rows from every
 *      list, and its window index already assumes as much). vanishedIds'
 *      `truncated` parameter is the other half of the same fix: a caller
 *      whose OWN page limit (MAX_PAGES) ran out partway through must say so,
 *      or an event merely past that point looks exactly as "vanished" as one
 *      Outlook genuinely deleted.
 *
 *   2. It wrote `kind` on every row, on every run, straight from toEventRow's
 *      attendee-list guess — including a row create-calendar-event had
 *      already written with the CALLER's own choice (`kind ?? row.kind`:
 *      "the caller's intent wins over the guess"). Nothing records that a
 *      `kind` was chosen rather than guessed, so the very next ordinary sync
 *      put the guess back over it. syncedEventFields is the fix: a row this
 *      sync has never stored before gets the fresh guess, because a guess is
 *      all there has ever been for it; a row it already has keeps whatever
 *      `kind` is already there, because that might be a choice this sync has
 *      no way to tell apart from its own past guesses.
 */

/* The shape fetch(...).then(r => r.json()) hands back for one calendarView
 * page. Only the two fields anything here reads. */
export interface GraphPage {
  value?: unknown[];
  '@odata.nextLink'?: unknown;
}

/* The link to the next page, or null once Graph stops sending one — also
 * null for anything that is not a non-empty string, since a page shaped
 * unlike what was asked for is nearer "stop" than "guess a URL". */
export function nextLinkOf(page: GraphPage): string | null {
  const link = page?.['@odata.nextLink'];
  return typeof link === 'string' && link !== '' ? link : null;
}

/* An id this sync already had, for the window it just asked Graph about,
 * that none of the pages it just read mentioned. Order carries no meaning —
 * the caller only wants the set to mark cancelled.
 *
 * `truncated` is the caller saying its own fetch loop gave up on MAX_PAGES
 * with a link still outstanding, rather than Graph genuinely running out of
 * pages: `seen` is then only PART of the window, and an id past wherever the
 * fetch stopped looks exactly like a deleted one to plain set subtraction —
 * known has it, seen does not, for a reason that has nothing to do with
 * Outlook. Nothing vanishes off the back of an incomplete read; a later,
 * uninterrupted run decides instead. */
export function vanishedIds(known: Iterable<string>, seen: ReadonlySet<string>, truncated = false): string[] {
  if (truncated) return [];
  const out: string[] = [];
  for (const id of known) if (!seen.has(id)) out.push(id);
  return out;
}

export interface SyncableEventRow {
  external_id: string;
  title: string;
  detail: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  kind: string;
  status: string;
  attendees: unknown;
}

/* What an ordinary sync run may put in one event's upsert. Every field but
 * `kind` always reflects what Graph just said — Graph is the only place any
 * of them comes from, so there is nothing to protect. `kind` is the one
 * exception: toEventRow's value is a guess, and the one time it is not a
 * guess is create-calendar-event's caller saying what an event is for, which
 * lands in the same column this upsert would otherwise overwrite. So a row
 * already stored keeps whatever `kind` it has — this leaves `kind` out of the
 * object entirely rather than reading it back from the database first, since
 * an upsert's ON CONFLICT DO UPDATE only touches the columns actually given
 * it, the same reason this sync has never had to protect project_id,
 * company_id, contact_id or created_by either. Only a row genuinely new to
 * this sync gets the fresh guess, because a guess is all there has ever been
 * for it. */
export function syncedEventFields(
  row: SyncableEventRow,
  connectionId: string,
  calendarId: string,
  alreadyStored: boolean,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    connection_id: connectionId,
    calendar_id: calendarId,
    external_id: row.external_id,
    title: row.title,
    detail: row.detail,
    location: row.location,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    status: row.status,
    attendees: row.attendees,
  };
  if (!alreadyStored) fields.kind = row.kind;
  return fields;
}
