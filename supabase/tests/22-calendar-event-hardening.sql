-- 22-calendar-event-hardening.sql — 0057: a non-manager who may change their
-- own hand-made event (0048) still cannot widen what it means; the organiser,
-- meeting link and time zone columns exist and the link is https only; the
-- scheduled calendar sync is registered.
--
-- Same two people as suite 13: the OWNER is a manager, the assistant is not.
-- A refusal passes only for the reason it is about (pg_temp.refused, as in 05
-- and 13). Everything is rolled back.
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
insert into public.client_projects (id, name) values
  ('22a00000-0000-4000-a000-000000000090', 'check-22 project');

insert into public.calendar_events (id, title, starts_at, kind, status, attendees, created_by) values
  ('22a00000-0000-4000-a000-000000000011', 'check-22 assistant event', now() + interval '1 day',
   'internal', 'confirmed', '[]'::jsonb, current_setting('test.assistant_employee')::uuid),
  ('22a00000-0000-4000-a000-000000000012', 'check-22 OWNER event', now() + interval '1 day',
   'internal', 'confirmed', '[]'::jsonb, current_setting('test.owner_employee')::uuid);

-- ── The assistant, an employee who is not a manager ──────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ASSISTANT: still moves and renames their own event', $sql$
  update public.calendar_events
  set title = 'check-22 assistant event, renamed', detail = 'Moved to the morning',
      location = 'Meeting room 2', starts_at = starts_at + interval '1 hour', ends_at = starts_at + interval '2 hours'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 1);

select pg_temp.refused('ASSISTANT: cannot turn their event into client work', $sql$
  update public.calendar_events set project_id = '22a00000-0000-4000-a000-000000000090'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 'title, time, place and details');

select pg_temp.refused('ASSISTANT: cannot change its kind', $sql$
  update public.calendar_events set kind = 'client'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot cancel it by changing its status', $sql$
  update public.calendar_events set status = 'cancelled'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: cannot invent an attendee on it', $sql$
  update public.calendar_events set attendees = '[{"name":"Nobody invited this","email":"n@x.example","response":null}]'::jsonb
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

select pg_temp.refused('ASSISTANT: a title change bundled with a kind change is refused whole, not applied in part', $sql$
  update public.calendar_events set title = 'check-22 sneaky', kind = 'client'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 'ask an owner or admin');

insert into results(name, expected, actual, pass)
select 'ASSISTANT: the sneaky update above changed nothing at all', 'check-22 assistant event, renamed',
       title, title = 'check-22 assistant event, renamed'
from public.calendar_events where id = '22a00000-0000-4000-a000-000000000011';

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('OWNER: still moves and files an event as client work — the guard is for non-managers', $sql$
  update public.calendar_events
  set kind = 'client', project_id = '22a00000-0000-4000-a000-000000000090', status = 'tentative'
  where id = '22a00000-0000-4000-a000-000000000012'
$sql$, 1);

-- ── The syncs run as the service role, which the guard exempts by design ──
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select pg_temp.affects('SERVICE ROLE: create-calendar-event and the sync still write every column', $sql$
  update public.calendar_events
  set kind = 'client', status = 'confirmed', attendees = '[{"name":"Dana","email":"dana@x.example","response":"accepted"}]'::jsonb,
      organizer_name = 'Dana Reyes', organizer_email = 'dana@x.example', time_zone = 'Europe/Amsterdam',
      meeting_url = 'https://teams.microsoft.com/l/meetup-join/check-22'
  where id = '22a00000-0000-4000-a000-000000000011'
$sql$, 1);

reset role;

-- ── The meeting link column: https only ───────────────────────────────────
select pg_temp.refused('LINK: an http:// meeting link is refused, not silently kept', format($sql$
  insert into public.calendar_events (title, starts_at, meeting_url) values (%L, now(), %L)
$sql$, 'check-22 http link', 'http://not-secure.example/join'), 'calendar_events_meeting_url_https');

select pg_temp.refused('LINK: a link with no scheme at all is refused too', format($sql$
  insert into public.calendar_events (title, starts_at, meeting_url) values (%L, now(), %L)
$sql$, 'check-22 no scheme', 'not-a-url-at-all'), 'calendar_events_meeting_url_https');

select pg_temp.affects('LINK: an https:// link is kept', format($sql$
  insert into public.calendar_events (title, starts_at, meeting_url) values (%L, now(), %L)
$sql$, 'check-22 https link', 'https://teams.microsoft.com/l/meetup-join/ok'), 1);

select pg_temp.affects('LINK: no link at all is still fine', $sql$
  insert into public.calendar_events (title, starts_at) values ('check-22 no link', now())
$sql$, 1);

-- ── Proof ─────────────────────────────────────────────────────────────────
-- Every check here is a bare aggregate (count/max, no group by), which always
-- answers with exactly one row even when nothing matches — a plain `select …
-- where tgname = …` with no match would insert NO row at all, and a trigger
-- someone later drops would go quietly missing from the results instead of
-- failing loudly.
insert into results(name, expected, actual, pass)
select 'TRIGGER: the column guard is installed on calendar_events',
       'calendar_events_creator_can_only_change_details',
       coalesce(max(tgname), 'none'), count(*) = 1
from pg_trigger where tgrelid = 'public.calendar_events'::regclass
  and tgname = 'calendar_events_creator_can_only_change_details';

insert into results(name, expected, actual, pass)
select 'COLUMNS: organiser, meeting link and time zone all exist',
       '4 columns', count(*) || ' columns', count(*) = 4
from information_schema.columns
where table_schema = 'public' and table_name = 'calendar_events'
  and column_name in ('organizer_name', 'organizer_email', 'meeting_url', 'time_zone');

insert into results(name, expected, actual, pass)
select 'CRON: the calendar sync is scheduled every 15 minutes',
       '*/15 * * * *', coalesce(max(schedule), 'not scheduled'),
       count(*) = 1 and max(schedule) = '*/15 * * * *'
from cron.job where jobname = 'sync-workspace-calendar';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
