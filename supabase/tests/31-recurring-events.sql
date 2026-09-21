-- 31-recurring-events.sql — 0068: a row can say it is one occurrence of a
-- series, whether a reminder is set and how long before, which zone it was
-- booked in as a name a browser can actually compute in, and how the calendar
-- owner answered the invitation — and NONE of that is a browser's to write.
--
-- The point of this suite. 0068 added eight columns to a table that 0057 §1
-- guards with an ALLOWLIST of five editable ones. An allowlist means a new
-- column is refused to a non-manager for free, without anybody writing a rule
-- about it — which is exactly the kind of protection that is true until it
-- silently is not, the day someone widens the list for an unrelated reason.
-- Every new column is therefore tried here by hand, one at a time, rather than
-- trusted to the shape of a function.
--
-- Same two people as suites 13 and 22: the OWNER is a manager, the assistant
-- is not. A refusal passes only for the reason it is about (pg_temp.refused,
-- as in 05, 13 and 22). Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon, service_role;
grant usage, select on sequence results_id_seq to authenticated, anon, service_role;

create function pg_temp.refused(p_name text, p_statement text, p_reason text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_statement;
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'went through', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'refused: ' || left(sqlerrm, 90),
            strpos(lower(sqlerrm), lower(p_reason)) > 0);
  end;
end;
$$;

create function pg_temp.affects(p_name text, p_statement text, p_rows int)
returns void
language plpgsql
as $$
declare
  n int;
begin
  execute p_statement;
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', n || ' rows', n = p_rows);
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', 'refused: ' || left(sqlerrm, 90), false);
end;
$$;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- Fixtures, as the table owner. All rolled back.
--
-- The studio's calendar, so a synced series has somewhere to have come from.
insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('31a00000-0000-4000-a000-000000000001', 'microsoft_calendar', 'check-31-studio@example.invalid', null, 'connected');

-- A hand-made event of the assistant's — the only kind RLS lets a non-manager
-- UPDATE at all (0048), and so the only kind that ever reaches 0057's column
-- guard from a browser.
insert into public.calendar_events (id, title, starts_at, kind, status, attendees, created_by) values
  ('31a00000-0000-4000-a000-000000000011', 'check-31 assistant event', now() + interval '1 day',
   'internal', 'confirmed', '[]'::jsonb, current_setting('test.assistant_employee')::uuid),
  ('31a00000-0000-4000-a000-000000000012', 'check-31 OWNER event', now() + interval '1 day',
   'internal', 'confirmed', '[]'::jsonb, current_setting('test.owner_employee')::uuid);

-- Three occurrences of one weekly series, synced into the studio calendar, plus
-- one single meeting in the same calendar that must never be caught by a
-- whole-series reply.
insert into public.calendar_events
  (id, title, starts_at, status, connection_id, calendar_id, external_id,
   recurrence_type, series_master_id, recurrence_summary, response_status)
values
  ('31a00000-0000-4000-a000-000000000021', 'check-31 stand-up', now() + interval '1 day', 'confirmed',
   '31a00000-0000-4000-a000-000000000001', 'default', 'check-31-occ-1',
   'occurrence', 'check-31-master', 'Every week on Monday', 'notResponded'),
  ('31a00000-0000-4000-a000-000000000022', 'check-31 stand-up', now() + interval '8 days', 'confirmed',
   '31a00000-0000-4000-a000-000000000001', 'default', 'check-31-occ-2',
   'occurrence', 'check-31-master', 'Every week on Monday', 'notResponded'),
  ('31a00000-0000-4000-a000-000000000023', 'check-31 stand-up', now() + interval '15 days', 'confirmed',
   '31a00000-0000-4000-a000-000000000001', 'default', 'check-31-occ-3',
   'occurrence', 'check-31-master', 'Every week on Monday', 'notResponded'),
  ('31a00000-0000-4000-a000-000000000024', 'check-31 one-off', now() + interval '2 days', 'confirmed',
   '31a00000-0000-4000-a000-000000000001', 'default', 'check-31-single',
   'singleInstance', null, null, 'notResponded');

-- ── The assistant, an employee who is not a manager ──────────────────────
-- 0057's guard is an allowlist of five columns. Everything 0068 added is
-- outside it, so each one below must be refused WITHOUT 0068 having written a
-- single rule about it. That is the property being tested, one column at a
-- time: a suite that only tried one of the eight would still pass the day
-- somebody widened the list for the other seven.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ASSISTANT: still moves and renames their own event, exactly as 0057 left it', $sql$
  update public.calendar_events
  set title = 'check-31 assistant event, renamed', detail = 'Moved to the morning',
      location = 'Meeting room 2', starts_at = starts_at + interval '1 hour', ends_at = starts_at + interval '2 hours'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 1);

select pg_temp.refused('ASSISTANT: cannot answer an invitation by writing response_status straight through PostgREST', $sql$
  update public.calendar_events set response_status = 'accepted'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot promote themselves to the organiser of an event', $sql$
  update public.calendar_events set is_organizer = true
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot declare their event part of a series', $sql$
  update public.calendar_events set recurrence_type = 'occurrence'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot attach their event to somebody else''s series', $sql$
  update public.calendar_events set series_master_id = 'check-31-master'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot invent a repeat pattern in words', $sql$
  update public.calendar_events set recurrence_summary = 'Every week on Monday'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'title, time, place and details');

select pg_temp.refused('ASSISTANT: cannot switch a reminder on', $sql$
  update public.calendar_events set reminder_on = true
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot set how long before a reminder comes', $sql$
  update public.calendar_events set reminder_on = true, reminder_minutes = 15
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot rewrite the zone a browser computes in', $sql$
  update public.calendar_events set time_zone_iana = 'Pacific/Auckland'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: an allowed title change bundled with a reply is refused whole, not applied in part', $sql$
  update public.calendar_events set title = 'check-31 sneaky', response_status = 'accepted'
  where id = '31a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

insert into results(name, expected, actual, pass)
select 'ASSISTANT: the sneaky update above changed neither the title nor the reply',
       'check-31 assistant event, renamed · none',
       title || ' · ' || response_status,
       title = 'check-31 assistant event, renamed' and response_status = 'none'
from public.calendar_events where id = '31a00000-0000-4000-a000-000000000011';

-- RLS does not raise; it simply matches no row. So this is an `affects 0`, not
-- a `refused` — the same distinction suite 13 already draws for a synced event.
select pg_temp.affects('ASSISTANT: still cannot touch a synced occurrence at all — RLS refuses before any column rule does', $sql$
  update public.calendar_events set title = 'check-31 not yours'
  where id = '31a00000-0000-4000-a000-000000000021'
$sql$, 0);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
-- 0057 exempts managers from the column rule deliberately ("An owner or admin
-- is unrestricted, as 0048 already lets them touch any local event"), and 0068
-- does not change that. Worth stating out loud rather than leaving implied:
-- what a manager can reach this way is a HAND-MADE event, which no organiser
-- ever invited anybody to, so a reply written on one is a note to nobody. RLS
-- still refuses every synced row, to managers as to anyone else.
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('OWNER: unrestricted on their own hand-made event, as 0057 intends', $sql$
  update public.calendar_events
  set response_status = 'accepted', reminder_on = true, reminder_minutes = 15,
      recurrence_type = 'occurrence', series_master_id = 'check-31-owner-series'
  where id = '31a00000-0000-4000-a000-000000000012'
$sql$, 1);

select pg_temp.affects('OWNER: a synced occurrence is still nobody''s to change from the browser (0026, 0048)', $sql$
  update public.calendar_events set response_status = 'accepted'
  where id = '31a00000-0000-4000-a000-000000000021'
$sql$, 0);

-- search_events (0064) still describes a whole row now that the table is
-- wider. It is `returns setof public.calendar_events` with a `select *` body,
-- and adding columns under a function shaped like that is exactly the sort of
-- change that works until it does not — so one of the new columns is asked for
-- by name rather than assumed. 0068 deliberately does NOT `create or replace`
-- search_events: re-writing a function another migration owns is how three
-- production bugs got in. This is the check that says that decision held.
-- Asked as the OWNER, signed in, rather than as the table owner, so RLS is
-- genuinely applied the way suite 29 already asks it.
insert into results(name, expected, actual, pass)
select 'SEARCH: search_events still returns a whole row, new columns included',
       '3 occurrences', count(*) || ' · ' || coalesce(max(recurrence_type), 'none'),
       count(*) = 3 and max(recurrence_type) = 'occurrence'
from public.search_events('check-31 stand-up');

-- ── The syncs and respond-calendar-event run as the service role ─────────
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Every column 0068 added, written in one statement the way the sync's own
-- upsert does. Deliberately onto a row in ANOTHER series ('check-31-other'),
-- so the whole-series reply below has something adjacent to leave alone.
select pg_temp.affects('SERVICE ROLE: the sync writes every column 0068 added', $sql$
  update public.calendar_events
  set recurrence_type = 'occurrence', series_master_id = 'check-31-other',
      recurrence_summary = 'Every 2 weeks on Monday and Thursday, until 3 December 2026',
      reminder_on = true, reminder_minutes = 0,
      time_zone = 'W. Europe Standard Time', time_zone_iana = 'Europe/Amsterdam',
      response_status = 'notResponded', is_organizer = false
  where id = '31a00000-0000-4000-a000-000000000024'
$sql$, 1);

-- A whole-series reply, as respond-calendar-event sends one: every occurrence
-- of THIS series in THIS calendar, and nothing else. The row beside them (…24)
-- shares the connection and the calendar and belongs to a different series, so
-- it must not move — scoping by connection alone would take it too.
select pg_temp.affects('SERVICE ROLE: one reply lands on all three occurrences of the series', $sql$
  update public.calendar_events set response_status = 'declined'
  where connection_id = '31a00000-0000-4000-a000-000000000001'
    and calendar_id = 'default'
    and series_master_id = 'check-31-master'
$sql$, 3);

insert into results(name, expected, actual, pass)
select 'SERIES: another series in the same calendar kept its own answer',
       'notResponded', response_status, response_status = 'notResponded'
from public.calendar_events where id = '31a00000-0000-4000-a000-000000000024';

reset role;

-- ── What the columns will and will not hold ──────────────────────────────

select pg_temp.refused('RECURRENCE: a type Graph never sends is refused, not stored', format($sql$
  insert into public.calendar_events (title, starts_at, recurrence_type) values (%L, now(), %L)
$sql$, 'check-31 bad type', 'weekly'), 'calendar_events_recurrence_type_known');

select pg_temp.refused('REPLY: an answer outside Graph''s own six words is refused', format($sql$
  insert into public.calendar_events (title, starts_at, response_status) values (%L, now(), %L)
$sql$, 'check-31 bad reply', 'maybe'), 'calendar_events_response_status_known');

select pg_temp.refused('REMINDER: longer than Outlook''s own four-week ceiling is refused', format($sql$
  insert into public.calendar_events (title, starts_at, reminder_on, reminder_minutes) values (%L, now(), true, %s)
$sql$, 'check-31 far reminder', 40321), 'calendar_events_reminder_minutes_sane');

select pg_temp.refused('REMINDER: minutes with the reminder switched off is refused — the two columns cannot disagree', format($sql$
  insert into public.calendar_events (title, starts_at, reminder_on, reminder_minutes) values (%L, now(), false, %s)
$sql$, 'check-31 contradictory reminder', 15), 'calendar_events_reminder_minutes_sane');

select pg_temp.affects('REMINDER: zero minutes is a real setting — "at the time of the event" — and is kept', format($sql$
  insert into public.calendar_events (title, starts_at, reminder_on, reminder_minutes) values (%L, now(), true, 0)
$sql$, 'check-31 reminder at the time'), 1);

select pg_temp.affects('REMINDER: no reminder at all is still fine', format($sql$
  insert into public.calendar_events (title, starts_at) values (%L, now())
$sql$, 'check-31 no reminder'), 1);

-- The whole point of time_zone_iana: a Windows name is what Graph sends and
-- what Intl.DateTimeFormat THROWS on, so it must never reach the column a page
-- computes in. Spaces are what tell the two apart.
select pg_temp.refused('ZONE: the Windows name Graph sends is refused in the IANA column', format($sql$
  insert into public.calendar_events (title, starts_at, time_zone, time_zone_iana) values (%L, now(), %L, %L)
$sql$, 'check-31 windows zone', 'W. Europe Standard Time', 'W. Europe Standard Time'),
  'calendar_events_time_zone_iana_shape');

select pg_temp.affects('ZONE: the Windows name is kept as written in time_zone, beside the IANA one', format($sql$
  insert into public.calendar_events (title, starts_at, time_zone, time_zone_iana) values (%L, now(), %L, %L)
$sql$, 'check-31 both zones', 'W. Europe Standard Time', 'Europe/Amsterdam'), 1);

select pg_temp.affects('ZONE: a three-part IANA name is a real one and is kept', format($sql$
  insert into public.calendar_events (title, starts_at, time_zone_iana) values (%L, now(), %L)
$sql$, 'check-31 three part zone', 'America/Argentina/Buenos_Aires'), 1);

select pg_temp.affects('ZONE: a bare region (UTC) is a real one too', format($sql$
  insert into public.calendar_events (title, starts_at, time_zone_iana) values (%L, now(), %L)
$sql$, 'check-31 utc zone', 'UTC'), 1);

select pg_temp.affects('ZONE: no IANA name at all — an unrecognised Windows one — is fine, and is what a page prints plainly', format($sql$
  insert into public.calendar_events (title, starts_at, time_zone, time_zone_iana) values (%L, now(), %L, null)
$sql$, 'check-31 unknown zone', 'Some Unmapped Standard Time'), 1);

-- ── Defaults: every row that existed before 0068 still means something ────

select pg_temp.affects('DEFAULTS: an event saved saying nothing about any of this is a single, unanswered, unreminded one', $sql$
  insert into public.calendar_events (id, title, starts_at)
  values ('31a00000-0000-4000-a000-000000000031', 'check-31 plain event', now())
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'DEFAULTS: and reads back as exactly that',
       'singleInstance · none · false',
       recurrence_type || ' · ' || response_status || ' · ' || reminder_on,
       recurrence_type = 'singleInstance' and response_status = 'none' and reminder_on = false
from public.calendar_events where id = '31a00000-0000-4000-a000-000000000031';

-- ── Shape ────────────────────────────────────────────────────────────────
-- Bare aggregates, for the reason suite 22 spells out: a plain `select … where
-- …` with no match inserts NO row, so something later dropped would go quietly
-- missing from the results instead of failing loudly.

insert into results(name, expected, actual, pass)
select 'COLUMNS: series, reminder, zone and reply columns all exist',
       '8 columns', count(*) || ' columns', count(*) = 8
from information_schema.columns
where table_schema = 'public' and table_name = 'calendar_events'
  and column_name in ('recurrence_type', 'series_master_id', 'recurrence_summary',
                      'reminder_on', 'reminder_minutes', 'time_zone_iana',
                      'response_status', 'is_organizer');

insert into results(name, expected, actual, pass)
select 'CONSTRAINTS: all four new checks are installed',
       '4 checks', count(*) || ' checks', count(*) = 4
from pg_constraint
where conrelid = 'public.calendar_events'::regclass
  and conname in ('calendar_events_recurrence_type_known', 'calendar_events_reminder_minutes_sane',
                  'calendar_events_time_zone_iana_shape', 'calendar_events_response_status_known');

insert into results(name, expected, actual, pass)
select 'INDEX: every occurrence of one series can be found without a scan',
       'calendar_events_series_idx', coalesce(max(relname), 'missing'), count(*) = 1
from pg_class where relname = 'calendar_events_series_idx' and relnamespace = 'public'::regnamespace;

-- The load-bearing assertion of this whole suite: 0057's five-column allowlist
-- is still five columns. Every refusal above rests on that and on nothing else.
insert into results(name, expected, actual, pass)
select 'GUARD: 0057''s editable-column allowlist still names only title, detail, location, starts_at, ends_at',
       'five columns, none of them 0068''s',
       case when max(def) is null then 'the guard is gone' else 'still five' end,
       max(def) is not null
         and position('''response_status''' in max(def)) = 0
         and position('''recurrence_type''' in max(def)) = 0
         and position('''reminder_minutes''' in max(def)) = 0
         and position('''time_zone_iana''' in max(def)) = 0
         and position('''series_master_id''' in max(def)) = 0
         and position('''is_organizer''' in max(def)) = 0
from (
  select pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'calendar_events_creator_can_only_change_details'
) g;

insert into results(name, expected, actual, pass)
select 'TRIGGER: 0057''s column guard is still installed on calendar_events',
       'calendar_events_creator_can_only_change_details',
       coalesce(max(tgname), 'none'), count(*) = 1
from pg_trigger where tgrelid = 'public.calendar_events'::regclass
  and tgname = 'calendar_events_creator_can_only_change_details';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
