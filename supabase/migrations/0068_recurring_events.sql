-- =============================================================================
-- 0068 — Recurring series, reminders, honest time zones, and answering an
-- invitation: the largest remaining gap in the Agenda.
--
-- WHAT WAS FOUND. 0057 closed three calendar holes and left three open, in its
-- own words: "without taking on recurring series, reminders or written-back
-- replies today". Each has since become a real complaint rather than a note:
--
--   1. A SERIES SYNCS AS WHATEVER GRAPH HAPPENS TO RETURN. The sync asks
--      calendarView, which EXPANDS a series into its occurrences — deliberate,
--      and explained in _shared/calendar-sync.ts: /events returns the series
--      master, so a weekly stand-up would appear once, on the day it was
--      created. But an expanded occurrence carries no recurrence pattern at
--      all (only the master does), and nothing was stored to say it was one of
--      twelve. So twelve identical stand-ups sat on the agenda looking like
--      twelve unrelated meetings, and moving "the Tuesday one" was
--      indistinguishable from moving a one-off. recurrence_type,
--      series_master_id and recurrence_summary are what a row now carries
--      instead.
--
--   2. REMINDERS WERE NOT STORED. Graph sends isReminderOn and
--      reminderMinutesBeforeStart on every event; toEventRow threw both away.
--      Nothing here fires a notification off them — that is 0061's business,
--      not this migration's — but an event's page can now say "Reminder 15
--      minutes before", which is what someone checking whether they will be
--      nudged actually wants to know.
--
--   3. TIME ZONES WERE HALF DONE. 0057 added `time_zone` and said so plainly:
--      "Shown for context; nothing computes from it yet (0026's open item)."
--      The reason it computes from nothing is that Graph returns a WINDOWS
--      timezone name — "W. Europe Standard Time" — which Intl cannot parse:
--      `new Intl.DateTimeFormat('en', { timeZone: 'W. Europe Standard Time' })`
--      throws a RangeError, so a browser cannot render "10:00 in Amsterdam,
--      09:00 for you" from it. time_zone_iana holds the IANA name alongside,
--      when _shared/calendar-recurrence.ts recognises the Windows one, and
--      NULL when it does not — never a guess. graph-message.ts already refuses
--      to guess a zone for a START time for exactly this reason (an event
--      quietly an hour out is the bug people blame on themselves for weeks);
--      refusing to guess one for a LABEL is the same rule, applied where it is
--      cheaper to be wrong and still not worth it.
--
--   4. NO WAY TO ANSWER AN INVITATION. A meeting request synced in, showed
--      everyone else's replies (0026's attendees jsonb), and offered no way to
--      give one. response_status and is_organizer store the calendar owner's
--      own answer; respond-calendar-event sends it to Outlook.
--
-- WHOSE ANSWER response_status IS. The calendar owner's. Graph's
-- responseStatus on an event is always the answer of the mailbox it was read
-- from, and each connection syncs one mailbox's own view of a meeting (0026),
-- so a row from someone's personal calendar carries their reply and one from
-- the studio calendar carries the studio mailbox's. There is no per-person
-- answer to store because there is no per-person copy of the row.
--
-- THE 0057 COLUMN GUARD, AND WHY NOTHING HERE TOUCHES IT. 0057 §1 holds a
-- non-manager to five columns on an UPDATE — title, detail, location,
-- starts_at, ends_at — by comparing to_jsonb(new) minus those five against
-- to_jsonb(old) minus those five. That is an ALLOWLIST, not a denylist: every
-- column added to this table after it, including all eight added here, is
-- refused to a non-manager automatically, because it stays inside the
-- comparison. So this migration does NOT re-create
-- calendar_events_creator_can_only_change_details() — there is nothing it
-- would need to say — and deliberately does not add response_status to the
-- five, even though answering an invitation is the one thing here a
-- non-manager genuinely should be able to do. They do it through
-- respond-calendar-event, which writes with the service role after Outlook has
-- taken the reply; a browser PATCHing response_status straight through
-- PostgREST would record an answer no organiser was ever told about, which is
-- worse than no answer at all. Suite 31 proves both halves: the guard refuses
-- every new column, and the service role still writes them.
--
-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
-- =============================================================================
set lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A series: which one, which occurrence of it, and what the pattern says.
-- ─────────────────────────────────────────────────────────────────────────────

-- Graph's eventType, verbatim, so a value never has to be translated in either
-- direction. 'singleInstance' is the default because it is what a hand-made
-- event is and what every row already in this table was: no backfill, and no
-- window where a row means nothing.
alter table public.calendar_events
  add column if not exists recurrence_type text not null default 'singleInstance';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_recurrence_type_known'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_recurrence_type_known
      check (recurrence_type in ('singleInstance', 'occurrence', 'exception', 'seriesMaster'));
  end if;
end $$;

-- Graph's seriesMasterId: the id of the master every occurrence of one series
-- shares. Text, not a foreign key to this table's own id, for the same reason
-- external_id is text: it is the PROVIDER's identifier, and the master itself
-- may well be outside the window the sync ever stores.
alter table public.calendar_events add column if not exists series_master_id text;

-- The pattern in words ("Every 2 weeks on Monday and Thursday, until 3
-- December 2026"), not the pattern itself. Written by the sync, which fetches
-- each series master once per run to read it, because an expanded occurrence
-- has no pattern of its own. A sentence rather than a jsonb column because the
-- agenda's week lists would otherwise have to carry and parse one to print
-- four words, and because the sync re-runs every fifteen minutes (0057 §3) —
-- better wording is one deploy away, not a backfill.
alter table public.calendar_events add column if not exists recurrence_summary text;

comment on column public.calendar_events.recurrence_type is
  'Graph''s eventType: singleInstance, occurrence, exception or seriesMaster. '
  '''singleInstance'' for anything entered in the workspace, which never '
  'repeats. What the agenda reads to mark an event as recurring, and what '
  '_shared/calendar-event-guard.ts has refused to let anyone edit or delete '
  'from the workspace since 0057 (0068).';
comment on column public.calendar_events.series_master_id is
  'Graph''s seriesMasterId — the provider id every occurrence of one series '
  'shares. Null for a single meeting. What respond-calendar-event answers for '
  'when a reply is for the whole series rather than one date (0068).';
comment on column public.calendar_events.recurrence_summary is
  'How the series repeats, in words, read off the series master by the sync '
  'because an expanded occurrence carries no pattern of its own. Null for a '
  'single meeting, and for a series whose master could not be read — the row '
  'still says it repeats via recurrence_type (0068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Reminders: whether one is set, and how long before.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.calendar_events add column if not exists reminder_on boolean not null default false;
alter table public.calendar_events add column if not exists reminder_minutes integer;

-- Four weeks, which is Outlook's own ceiling. Zero is a real setting — "at the
-- time of the event" — and is kept as zero rather than folded into "none",
-- the same distinction graph-message.ts already draws for an attachment that
-- is genuinely empty. A reminder that is off carries no minutes at all, so the
-- two columns cannot disagree.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_reminder_minutes_sane'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_reminder_minutes_sane
      check (
        reminder_minutes is null
        or (reminder_on and reminder_minutes between 0 and 40320)
      );
  end if;
end $$;

comment on column public.calendar_events.reminder_on is
  'Graph''s isReminderOn: whether the calendar will nudge its owner before '
  'this event. False for a hand-made event, which nothing here reminds anyone '
  'about. Nothing in this database fires on it — it is what an event''s page '
  'reports, not a schedule (0068).';
comment on column public.calendar_events.reminder_minutes is
  'Graph''s reminderMinutesBeforeStart, 0 to 40320 (four weeks, Outlook''s own '
  'ceiling). Zero means "at the time of the event", which is a setting rather '
  'than an absence. Null whenever reminder_on is false, so the two columns '
  'cannot tell different stories (0068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The time-zone work 0057 left open: a zone a browser can actually compute
--    in, beside the one Graph sent.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.calendar_events add column if not exists time_zone_iana text;

-- An IANA name has no spaces and is a region, optionally Area/Location and
-- optionally one part more (America/Argentina/Buenos_Aires). A Windows name
-- always has spaces — "W. Europe Standard Time" — which is exactly what makes
-- the two tellable apart, and what _shared/calendar-recurrence.ts's IANA_SHAPE
-- tests before it stores one. Checked again here rather than trusted: a column
-- a page feeds straight to Intl.DateTimeFormat, which THROWS on a name it does
-- not know, is worth two layers — the same reason 0057 re-checks meeting_url
-- for https:// in the database as well as at ingestion.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_time_zone_iana_shape'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_time_zone_iana_shape
      check (
        time_zone_iana is null
        or time_zone_iana ~ '^[A-Za-z][A-Za-z0-9+_-]*(/[A-Za-z0-9+._-]+){0,2}$'
      );
  end if;
end $$;

comment on column public.calendar_events.time_zone_iana is
  'The zone in time_zone as an IANA name a browser can pass to Intl — '
  'Europe/Amsterdam for Graph''s "W. Europe Standard Time". Null when '
  '_shared/calendar-recurrence.ts does not recognise the Windows name, so a '
  'page prints time_zone plainly instead of converting through a guess: '
  'graph-message.ts refuses to guess a zone for a START time for the same '
  'reason, and being an hour out is no better on a label (0068).';

-- 0057's own comment on time_zone says "nothing computes from it yet (0026''s
-- open item)". Something does now — through time_zone_iana, and only when that
-- is not null — so the column's own description should stop saying otherwise.
comment on column public.calendar_events.time_zone is
  'The organiser''s own zone when the event was made (Graph''s '
  'originalStartTimeZone), usually a Windows name — not the UTC this table '
  'stores every instant in. Shown as written; anything that COMPUTES in a zone '
  'uses time_zone_iana beside it, which is null unless the name was recognised '
  '(0057, extended by 0068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The calendar owner's own answer to an invitation.
-- ─────────────────────────────────────────────────────────────────────────────

-- Graph's responseStatus.response vocabulary, verbatim — the same six strings
-- _shared/calendar-response.ts names, so nothing translates in either
-- direction and a value cannot arrive spelled two ways. 'none' is the default
-- because it is what an event with nobody invited has, and what every row
-- already in this table was.
alter table public.calendar_events add column if not exists response_status text not null default 'none';
alter table public.calendar_events add column if not exists is_organizer boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_response_status_known'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_response_status_known
      check (response_status in
        ('none', 'organizer', 'tentativelyAccepted', 'accepted', 'declined', 'notResponded'));
  end if;
end $$;

comment on column public.calendar_events.response_status is
  'How the CALENDAR OWNER answered this invitation, in Graph''s own words: '
  'none (nobody was invited), notResponded, accepted, tentativelyAccepted, '
  'declined, or organizer. Whose answer it is follows from whose calendar the '
  'row was synced from (0026) — there is no per-person copy of a row, so there '
  'is no per-person answer. Written by the sync, and by respond-calendar-event '
  'once Outlook has taken a reply; never by a browser, which 0057''s column '
  'guard refuses (0068).';
comment on column public.calendar_events.is_organizer is
  'Whether the calendar owner organised this meeting rather than being invited '
  'to it (Graph''s isOrganizer). What the agenda reads to decide whether to '
  'offer Accept and Decline at all: an organiser has no invitation to answer '
  '(0068).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Finding every occurrence of one series.
--
--    respond-calendar-event writes one answer onto every occurrence of a
--    series this connection has, which is a lookup by (connection, calendar,
--    series) — the same leading columns as calendar_events_external_idx (0028)
--    but keyed on the master rather than the occurrence, so that index cannot
--    serve it. Partial: a single meeting has no master, and most rows are
--    single meetings, so indexing their nulls would be paying for nothing.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists calendar_events_series_idx
  on public.calendar_events (connection_id, calendar_id, series_master_id)
  where series_master_id is not null;

comment on index public.calendar_events_series_idx is
  'Every occurrence of one series in one calendar — what respond-calendar-event '
  'writes a whole-series reply across. Partial: a single meeting has no master '
  'and most rows are single meetings (0068).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  guard_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calendar_events'
      and column_name in ('recurrence_type', 'series_master_id', 'recurrence_summary',
                          'reminder_on', 'reminder_minutes', 'time_zone_iana',
                          'response_status', 'is_organizer')
    having count(*) = 8
  ) then
    raise exception '0068: calendar_events is missing a series, reminder, zone or reply column';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname in ('calendar_events_recurrence_type_known',
                      'calendar_events_reminder_minutes_sane',
                      'calendar_events_time_zone_iana_shape',
                      'calendar_events_response_status_known')
    having count(*) = 4
  ) then
    raise exception '0068: one of the new calendar_events check constraints is missing';
  end if;

  if not exists (
    select 1 from pg_class where relname = 'calendar_events_series_idx'
      and relnamespace = 'public'::regnamespace
  ) then
    raise exception '0068: calendar_events_series_idx is missing';
  end if;

  -- 0057 §1 is an ALLOWLIST of five columns, which is what makes every column
  -- added here refused to a non-manager without a word being written about
  -- them. If some later migration ever widens that list, these columns quietly
  -- become browser-writable — so the shape of the guard is asserted here, at
  -- the migration that depends on it, rather than only in the suite.
  select pg_get_functiondef(p.oid) into guard_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'calendar_events_creator_can_only_change_details';

  if guard_definition is null then
    raise exception '0068: 0057''s calendar event column guard is gone';
  end if;
  if position('''response_status''' in guard_definition) > 0
     or position('''recurrence_type''' in guard_definition) > 0
     or position('''reminder_minutes''' in guard_definition) > 0 then
    raise exception '0068: a column added here is in 0057''s editable-column allowlist; a browser can now write it directly';
  end if;
end
$$;
