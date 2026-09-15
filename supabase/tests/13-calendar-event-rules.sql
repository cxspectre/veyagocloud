-- 13-calendar-event-rules.sql — an event entered in the workspace is changed
-- and deleted by whoever made it, or by an owner or admin; a synced event by
-- nobody from the browser (0048).
--
-- The OWNER is a manager. The assistant, inactive in real life, is woken for
-- this transaction as an employee. Made as the table owner: hand-made events of
-- the OWNER's (…11) and the assistant's (…12), one nobody is recorded as making
-- (…13), and two synced into the studio calendar, booked by the assistant (…14)
-- and by the OWNER (…15). The assistant also books one the way the workspace
-- does. Each person is first shown to read every event they then write to, so
-- "0 rows" is the write rule refusing, not a row out of sight. A refusal passes
-- only for the reason it is about (pg_temp.refused, as in 05). Everything is
-- rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon, service_role;
grant usage, select on sequence results_id_seq to authenticated, anon, service_role;

-- A statement that must be refused, for the reason given.
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

-- A statement that must go through and touch exactly this many rows.
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
insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('13a00000-0000-4000-a000-000000000001', 'microsoft_calendar', 'check-13-studio@example.invalid', null, 'connected');

insert into public.calendar_events (id, title, starts_at, created_by) values
  ('13a00000-0000-4000-a000-000000000011', 'check-13 OWNER event', now() + interval '1 day',
   current_setting('test.owner_employee')::uuid),
  ('13a00000-0000-4000-a000-000000000012', 'check-13 assistant event', now() + interval '1 day',
   current_setting('test.assistant_employee')::uuid),
  ('13a00000-0000-4000-a000-000000000013', 'check-13 event nobody is recorded as making', now() + interval '1 day',
   null);

-- Stored the way create-calendar-event stores a booking: synced, and signed by the booker.
insert into public.calendar_events (id, connection_id, calendar_id, external_id, title, starts_at, created_by) values
  ('13a00000-0000-4000-a000-000000000014', '13a00000-0000-4000-a000-000000000001', 'default',
   'check-13-booked-by-assistant', 'check-13 synced, booked by the assistant', now() + interval '1 day',
   current_setting('test.assistant_employee')::uuid),
  ('13a00000-0000-4000-a000-000000000015', '13a00000-0000-4000-a000-000000000001', 'default',
   'check-13-booked-by-owner', 'check-13 synced, booked by the OWNER', now() + interval '1 day',
   current_setting('test.owner_employee')::uuid);

-- ── The assistant, an employee ───────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'SEES: the assistant reads every event this suite made', '5 events', count(*) || ' events', count(*) = 5
from public.calendar_events where title like 'check-13 %';

select pg_temp.affects('ASSISTANT: cannot move or rename the OWNER''s event', $sql$
  update public.calendar_events
  set title = 'check-13 moved by the assistant', starts_at = starts_at + interval '1 hour'
  where id = '13a00000-0000-4000-a000-000000000011'
$sql$, 0);

select pg_temp.affects('ASSISTANT: nor delete it', $sql$
  delete from public.calendar_events where id = '13a00000-0000-4000-a000-000000000011'
$sql$, 0);

select pg_temp.affects('ASSISTANT: nor change an event nobody is recorded as making', $sql$
  update public.calendar_events set title = 'check-13 claimed by the assistant'
  where id = '13a00000-0000-4000-a000-000000000013'
$sql$, 0);

select pg_temp.affects('ASSISTANT: nor delete that one', $sql$
  delete from public.calendar_events where id = '13a00000-0000-4000-a000-000000000013'
$sql$, 0);

select pg_temp.affects('ASSISTANT: still books an event the way createEvent does', $sql$
  insert into public.calendar_events (title, detail, location, starts_at, ends_at, all_day, kind,
                                      project_id, company_id, contact_id, created_by)
  values ('check-13 booked here', 'Booked the way createEvent books one', null,
          now() + interval '2 days', now() + interval '2 days 1 hour', false, 'internal',
          null, null, null, public.active_employee_id())
$sql$, 1);

select pg_temp.affects('ASSISTANT: changes their own event', $sql$
  update public.calendar_events
  set title = 'check-13 booked here, moved',
      starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'
  where title = 'check-13 booked here'
$sql$, 1);

select pg_temp.refused('ASSISTANT: cannot hand their event to a colleague', format($sql$
  update public.calendar_events set created_by = %L
  where title = 'check-13 booked here, moved'
$sql$, current_setting('test.owner_employee')), 'row-level security');

select pg_temp.refused('ASSISTANT: cannot put their event on a synced calendar', $sql$
  update public.calendar_events set connection_id = '13a00000-0000-4000-a000-000000000001'
  where title = 'check-13 booked here, moved'
$sql$, 'row-level security');

select pg_temp.affects('SYNCED: the assistant cannot change an event they booked into the studio calendar', $sql$
  update public.calendar_events set title = 'check-13 renamed by the assistant'
  where id = '13a00000-0000-4000-a000-000000000014'
$sql$, 0);

select pg_temp.affects('SYNCED: nor delete it', $sql$
  delete from public.calendar_events where id = '13a00000-0000-4000-a000-000000000014'
$sql$, 0);

select pg_temp.affects('ASSISTANT: deletes their own event', $sql$
  delete from public.calendar_events where title = 'check-13 booked here, moved'
$sql$, 1);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'SEES: the OWNER reads every event this suite made', '5 events', count(*) || ' events', count(*) = 5
from public.calendar_events where title like 'check-13 %';

select pg_temp.affects('OWNER: moves and renames an event the assistant made', $sql$
  update public.calendar_events
  set title = 'check-13 assistant event, moved by the OWNER', starts_at = starts_at + interval '1 hour'
  where id = '13a00000-0000-4000-a000-000000000012'
$sql$, 1);

select pg_temp.affects('OWNER: changes an event nobody is recorded as making', $sql$
  update public.calendar_events set title = 'check-13 event nobody made, renamed by the OWNER'
  where id = '13a00000-0000-4000-a000-000000000013'
$sql$, 1);

select pg_temp.affects('OWNER: deletes an event the assistant made', $sql$
  delete from public.calendar_events where id = '13a00000-0000-4000-a000-000000000012'
$sql$, 1);

select pg_temp.affects('SYNCED: the OWNER cannot change a synced event, not even one they booked', $sql$
  update public.calendar_events set title = 'check-13 renamed by the OWNER'
  where id in ('13a00000-0000-4000-a000-000000000014', '13a00000-0000-4000-a000-000000000015')
$sql$, 0);

select pg_temp.affects('SYNCED: nor delete one', $sql$
  delete from public.calendar_events
  where id in ('13a00000-0000-4000-a000-000000000014', '13a00000-0000-4000-a000-000000000015')
$sql$, 0);

select pg_temp.refused('OWNER: cannot put an event on a synced calendar either', $sql$
  update public.calendar_events set connection_id = '13a00000-0000-4000-a000-000000000001'
  where id = '13a00000-0000-4000-a000-000000000011'
$sql$, 'row-level security');

-- ── The syncs run as the service role, which RLS does not apply to ───────
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select pg_temp.affects('SERVICE ROLE: the sync still rewrites a synced event', $sql$
  insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at)
  values ('13a00000-0000-4000-a000-000000000001', 'default', 'check-13-booked-by-owner',
          'check-13 synced, moved in Outlook', now() + interval '3 days')
  on conflict (connection_id, calendar_id, external_id) do update
    set title = excluded.title, starts_at = excluded.starts_at
$sql$, 1);

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────
insert into results(name, expected, actual, pass)
select 'POLICIES: one rule decides who changes a calendar event, and one who deletes it',
       'creator or manager updates local calendar events, creator or manager deletes local calendar events',
       coalesce(string_agg(policyname, ', ' order by cmd desc), 'none'),
       count(*) = 2
         and count(*) filter (where cmd = 'UPDATE' and policyname = 'creator or manager updates local calendar events') = 1
         and count(*) filter (where cmd = 'DELETE' and policyname = 'creator or manager deletes local calendar events') = 1
from pg_policies
where schemaname = 'public' and tablename = 'calendar_events'
  and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'DELETE', 'ALL');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
