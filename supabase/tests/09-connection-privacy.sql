-- 09-connection-privacy.sql — a colleague's mailbox and calendar connections,
-- and what they synced, are theirs (0044).
--
-- Six connections, made as the table owner: the studio's mailbox (1) and
-- calendar (2); the OWNER's personal mailbox (3), in an error state so it has
-- something to leak, and personal calendar (5); the assistant's mailbox (4) and
-- calendar (6). One synced event on each calendar. Each check lists what a
-- person can read. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.integration_connections (id, provider, account_label, employee_id, status, last_error) values
  ('c9000000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-09-studio@example.invalid', null, 'connected', null),
  ('c9000000-0000-4000-a000-000000000002', 'microsoft_calendar', 'check-09-studio@example.invalid', null, 'connected', null),
  ('c9000000-0000-4000-a000-000000000003', 'microsoft_mail', 'check-09-owner@example.invalid',
   (select id from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), 'error', 'check-09 private error'),
  ('c9000000-0000-4000-a000-000000000004', 'microsoft_mail', 'check-09-assistant@example.invalid',
   (select id from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), 'connected', null),
  ('c9000000-0000-4000-a000-000000000005', 'microsoft_calendar', 'check-09-owner@example.invalid',
   (select id from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), 'connected', null),
  ('c9000000-0000-4000-a000-000000000006', 'microsoft_calendar', 'check-09-assistant@example.invalid',
   (select id from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), 'connected', null);

-- One synced event on each calendar: the studio's (2), the OWNER's (5), the assistant's (6).
insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at) values
  ('c9000000-0000-4000-a000-000000000002', 'default', 'check-09-studio', 'check-09 studio', now()),
  ('c9000000-0000-4000-a000-000000000005', 'default', 'check-09-owner', 'check-09 owner', now()),
  ('c9000000-0000-4000-a000-000000000006', 'default', 'check-09-assistant', 'check-09 assistant', now());

-- Which of the six a person can read, by the last digit of their ids. A role
-- refused outright reads as 'refused'.
create function pg_temp.readable(p_from text)
returns text
language plpgsql
as $$
declare
  seen text;
begin
  execute format(
    'select coalesce(string_agg(right(id::text, 1), '' '' order by id), ''none'') from %s
     where id in (''c9000000-0000-4000-a000-000000000001'', ''c9000000-0000-4000-a000-000000000002'',
                  ''c9000000-0000-4000-a000-000000000003'', ''c9000000-0000-4000-a000-000000000004'',
                  ''c9000000-0000-4000-a000-000000000005'', ''c9000000-0000-4000-a000-000000000006'')', p_from)
    into seen;
  return seen;
exception when insufficient_privilege then
  return 'refused';
end;
$$;

-- Which of the three synced events a person can read.
create function pg_temp.events()
returns text
language plpgsql
as $$
declare
  seen text;
begin
  select coalesce(string_agg(replace(title, 'check-09 ', ''), ' · ' order by title), 'none') into seen
  from public.calendar_events where external_id like 'check-09-%';
  return seen;
exception when insufficient_privilege then
  return 'refused';
end;
$$;

grant execute on function pg_temp.readable(text) to authenticated, anon;
grant execute on function pg_temp.events() to authenticated, anon;

-- ── The assistant, a member of staff ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: the studio''s connections and their own — not a colleague''s', '1 2 4 6', x.seen, x.seen = '1 2 4 6'
from (select pg_temp.readable('public.integration_connections') as seen) x;

insert into results(name, expected, actual, pass)
select 'STAFF: nor through integration_status, with its address and last error', '1 2 4 6', x.seen, x.seen = '1 2 4 6'
from (select pg_temp.readable('public.integration_status') as seen) x;

insert into results(name, expected, actual, pass)
select 'STAFF: what the studio''s calendar and their own synced — not a colleague''s diary', 'assistant · studio',
       x.seen, x.seen = 'assistant · studio'
from (select pg_temp.events() as seen) x;

insert into results(name, expected, actual, pass)
select 'STAFF: can_read_connection() answers as the policy does, connection by connection', 'agree',
       case when bool_and(public.can_read_connection(c.id) = exists (
              select 1 from public.integration_connections r where r.id = c.id)) then 'agree' else 'disagree' end,
       bool_and(public.can_read_connection(c.id) = exists (
         select 1 from public.integration_connections r where r.id = c.id))
from (values ('c9000000-0000-4000-a000-000000000001'::uuid), ('c9000000-0000-4000-a000-000000000002'::uuid),
             ('c9000000-0000-4000-a000-000000000003'::uuid), ('c9000000-0000-4000-a000-000000000004'::uuid),
             ('c9000000-0000-4000-a000-000000000005'::uuid), ('c9000000-0000-4000-a000-000000000006'::uuid)) as c(id);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'MANAGER: the studio''s and their own, and no colleague''s either', '1 2 3 5', x.seen, x.seen = '1 2 3 5'
from (select pg_temp.readable('public.integration_connections') as seen) x;

insert into results(name, expected, actual, pass)
select 'MANAGER: the same through integration_status', '1 2 3 5', x.seen, x.seen = '1 2 3 5'
from (select pg_temp.readable('public.integration_status') as seen) x;

insert into results(name, expected, actual, pass)
select 'MANAGER: what the studio''s calendar and their own synced — not a colleague''s diary', 'owner · studio',
       x.seen, x.seen = 'owner · studio'
from (select pg_temp.events() as seen) x;

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"c9000000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NOT ON THE TEAM: signed in, and reads no connection and no synced event', 'none · none',
       x.seen || ' · ' || y.seen, x.seen in ('none', 'refused') and y.seen in ('none', 'refused')
from (select pg_temp.readable('public.integration_connections') as seen) x,
     (select pg_temp.events() as seen) y;

-- ── Anon ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

insert into results(name, expected, actual, pass)
select 'ANON: no connection and no synced event', 'none · none',
       x.seen || ' · ' || y.seen, x.seen in ('none', 'refused') and y.seen in ('none', 'refused')
from (select pg_temp.readable('public.integration_connections') as seen) x,
     (select pg_temp.events() as seen) y;

reset role;

insert into results(name, expected, actual, pass)
select 'POLICIES: one rule decides who reads a connection',
       'staff read studio or own integration_connections',
       coalesce(string_agg(policyname, ', '), 'none'),
       count(*) = 1 and bool_and(policyname = 'staff read studio or own integration_connections')
from pg_policies
where schemaname = 'public' and tablename = 'integration_connections'
  and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
