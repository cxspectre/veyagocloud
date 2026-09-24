-- 29-agenda-event-search.sql — search_events (0064) finds a past meeting or a
-- non-project event by a word in its title, detail or location, never a
-- cancelled one, honours p_limit up to a hard cap of 50, and — being
-- security_invoker — reads no further than calendar_events' own RLS (0026)
-- already lets the caller see.
--
-- Fixtures, as the table owner, all carrying "zzcheck29" somewhere so the
-- search only ever matches what this suite made (a live database can hold
-- real events using ordinary words): a past meeting (…11, by its title), one
-- found by its detail (…12) and one by its location (…13), a cancelled one
-- that must never come back (…14), one synced into the studio calendar,
-- which any staff member reads (…15), and one synced into the OWNER's own
-- personal calendar, which only the OWNER reads (…16) — the same "not a
-- colleague's diary" shape suites 09 and 13 already prove for connections and
-- writes, proved here for search. A separate batch of 51 rows, marked
-- "zzq29cap" instead so they cannot be matched by the checks above, proves
-- the hard cap holds even when a caller asks for far more than 50. Everything
-- is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- The studio's calendar, and the OWNER's own personal one.
insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('29a00000-0000-4000-a000-000000000001', 'microsoft_calendar', 'check-29-studio@example.invalid', null, 'connected'),
  ('29a00000-0000-4000-a000-000000000002', 'microsoft_calendar', 'check-29-owner@example.invalid',
   current_setting('test.owner_employee')::uuid, 'connected');

insert into public.calendar_events (id, title, detail, location, starts_at, status, connection_id, calendar_id, external_id) values
  -- A meeting well outside any week the agenda would have loaded, found by its title.
  -- calendar_id is '' (0028's own default for a hand-made event), never null:
  -- the column is not-null, and an explicit null overrides a column default
  -- rather than falling back to it.
  ('29a00000-0000-4000-a000-000000000011', 'check-29 zzcheck29 kickoff', null, null,
   now() - interval '90 days', 'confirmed', null, '', null),
  -- Found by its detail, not its title.
  ('29a00000-0000-4000-a000-000000000012', 'check-29 debrief', 'zzcheck29 project debrief notes', null,
   now() - interval '10 days', 'confirmed', null, '', null),
  -- Found by its location, not its title or detail.
  ('29a00000-0000-4000-a000-000000000013', 'check-29 offsite', null, 'zzcheck29 Lisbon office',
   now() + interval '5 days', 'confirmed', null, '', null),
  -- Cancelled: must never come back, whoever searches.
  ('29a00000-0000-4000-a000-000000000014', 'check-29 zzcheck29 cancelled meeting', null, null,
   now() - interval '5 days', 'cancelled', null, '', null),
  -- Synced into the studio calendar: any staff member reads this.
  ('29a00000-0000-4000-a000-000000000015', 'check-29 zzcheck29 zzcheck29studiosync', null, null,
   now() + interval '1 day', 'confirmed', '29a00000-0000-4000-a000-000000000001', 'default', 'check-29-studio'),
  -- Synced into the OWNER's own personal calendar: only the OWNER reads this.
  ('29a00000-0000-4000-a000-000000000016', 'check-29 zzcheck29 zzcheck29ownerprivate', null, null,
   now() + interval '2 days', 'confirmed', '29a00000-0000-4000-a000-000000000002', 'default', 'check-29-owner');

-- 51 more, marked apart from everything above, so a p_limit far higher than
-- 50 still comes back capped at 50.
insert into public.calendar_events (title, starts_at, status, connection_id, calendar_id, external_id)
select 'check-29 zzq29cap ' || g, now() + (g || ' minutes')::interval, 'confirmed', null, '', null
from generate_series(1, 51) as g;

-- Every matching row, in the order search_events itself returns them — WITH
-- ORDINALITY is what makes that order visible to string_agg, which does not
-- otherwise promise to keep a set-returning function's own row order. A role
-- with no grant on search_events at all (anon) raises insufficient_privilege
-- the moment it is called; caught here the way suite 09's pg_temp.readable
-- and pg_temp.events already catch the same thing.
create function pg_temp.found(p_query text, p_limit int default 20)
returns text
language plpgsql
as $$
declare
  seen text;
begin
  select coalesce(string_agg(replace(x.title, 'check-29 ', ''), ' · ' order by x.ordinality), 'none')
  into seen
  from public.search_events(p_query, p_limit) with ordinality as x;
  return seen;
exception when insufficient_privilege then
  return 'refused';
end;
$$;

grant execute on function pg_temp.found(text, int) to authenticated, anon;

-- ── The assistant, a member of staff ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: finds a meeting by its title, one by its detail, one by its location, and a studio-synced one — never the cancelled one or a colleague''s private one, newest first',
       'offsite · zzcheck29 zzcheck29studiosync · debrief · zzcheck29 kickoff',
       pg_temp.found('zzcheck29'), pg_temp.found('zzcheck29') = 'offsite · zzcheck29 zzcheck29studiosync · debrief · zzcheck29 kickoff';

insert into results(name, expected, actual, pass)
select 'STAFF: reads a studio-synced event, the same as any other staff-visible one',
       'zzcheck29 zzcheck29studiosync', pg_temp.found('zzcheck29studiosync'), pg_temp.found('zzcheck29studiosync') = 'zzcheck29 zzcheck29studiosync';

insert into results(name, expected, actual, pass)
select 'STAFF: cannot find an event synced into the OWNER''s own personal calendar', 'none',
       pg_temp.found('zzcheck29ownerprivate'), pg_temp.found('zzcheck29ownerprivate') = 'none';

insert into results(name, expected, actual, pass)
select 'CANCELLED: never comes back, whatever the query', 'none',
       pg_temp.found('zzcheck29 cancelled'), pg_temp.found('zzcheck29 cancelled') = 'none';

insert into results(name, expected, actual, pass)
select 'p_limit: honoured up to the cap — the two most recent of four matches', 'offsite · zzcheck29 zzcheck29studiosync',
       pg_temp.found('zzcheck29', 2), pg_temp.found('zzcheck29', 2) = 'offsite · zzcheck29 zzcheck29studiosync';

insert into results(name, expected, actual, pass)
select 'p_limit: never more than 50, however high a caller asks for 51 real matches', '50 rows',
       count(*) || ' rows', count(*) = 50
from public.search_events('zzq29cap', 1000);

insert into results(name, expected, actual, pass)
select 'BLANK QUERY: asks for nothing rather than the whole table', '0 rows',
       count(*) || ' rows', count(*) = 0
from public.search_events('   ');

insert into results(name, expected, actual, pass)
select 'NULL QUERY: the same', '0 rows', count(*) || ' rows', count(*) = 0
from public.search_events(null);

insert into results(name, expected, actual, pass)
select 'NO MATCH: a word nothing carries finds nothing', '0 rows', count(*) || ' rows', count(*) = 0
from public.search_events('zzcheck29-nothing-carries-this');

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'OWNER: reads their own personal calendar''s synced event, which the assistant could not', 'zzcheck29 zzcheck29ownerprivate',
       pg_temp.found('zzcheck29ownerprivate'), pg_temp.found('zzcheck29ownerprivate') = 'zzcheck29 zzcheck29ownerprivate';

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"29a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NOT ON THE TEAM: signed in, and finds nothing at all', 'none', pg_temp.found('zzcheck29'), pg_temp.found('zzcheck29') = 'none';

-- ── Anon ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

insert into results(name, expected, actual, pass)
select 'ANON: refused outright — search_events carries no grant for anon', 'refused',
       pg_temp.found('zzcheck29'), pg_temp.found('zzcheck29') = 'refused';

reset role;

-- ── Policy shape ─────────────────────────────────────────────────────────
insert into results(name, expected, actual, pass)
select 'GRANTS: authenticated may execute search_events, anon may not', 'yes · no',
       (case when has_function_privilege('authenticated', 'public.search_events(text, int)', 'execute') then 'yes' else 'no' end)
         || ' · ' ||
       (case when has_function_privilege('anon', 'public.search_events(text, int)', 'execute') then 'yes' else 'no' end),
       has_function_privilege('authenticated', 'public.search_events(text, int)', 'execute')
         and not has_function_privilege('anon', 'public.search_events(text, int)', 'execute');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
