-- 26-studio-profile-and-notifications.sql — a studio profile any signed-in
-- member of staff can read, and a table where dismissing a notification
-- sticks (0061).
--
-- The OWNER and the assistant (inactive in real life) are woken for this
-- transaction only, as 08 already does. A fixture member linked to nobody's
-- sign-in stands in for "signed in, not on the team". Everything is rolled
-- back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

-- A statement that must be refused, for the reason given (as in 08).
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

-- A query that answers (actual text, pass boolean); an error is a named FAIL.
create function pg_temp.check(p_name text, p_expected text, p_query text)
returns void
language plpgsql
as $$
declare
  v_actual text;
  v_pass   boolean;
begin
  execute p_query into v_actual, v_pass;
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, coalesce(v_actual, 'null'), coalesce(v_pass, false));
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, 'error: ' || left(sqlerrm, 90), false);
end;
$$;

-- Fixtures, as the table owner. A decoy key stands in for a bank field: it
-- must never come back from studio_profile(), only ever from the table
-- itself, and only to a manager.
insert into public.workspace_settings (key, value) values
  ('studio_name', 'check-26 Studio'),
  ('studio_email', 'hello@check-26.example'),
  ('base_currency', 'eur'),
  ('mercury_account_number', 'check-26-secret-account')
on conflict (key) do update set value = excluded.value;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.employees (id, email, full_name, role, status) values
  ('e2600000-0000-4000-a000-000000000001', 'check-26-a@example.invalid', 'check-26 A', 'employee', 'active'),
  ('e2600000-0000-4000-a000-000000000002', 'check-26-b@example.invalid', 'check-26 B', 'employee', 'active');

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- ── STAFF (the assistant, an employee — not a manager) ───────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.check('STAFF: studio_profile() answers the studio''s name', 'check-26 Studio · true', $sql$
  select value, value = 'check-26 Studio' from public.studio_profile() where key = 'studio_name'
$sql$);

select pg_temp.check('STAFF: studio_profile() answers base_currency, upper-cased or not', 'eur · true', $sql$
  select value, lower(value) = 'eur' from public.studio_profile() where key = 'base_currency'
$sql$);

select pg_temp.check('STAFF: studio_profile() answers only its named allowlist, the decoy key included in what it must refuse', '0 · true', $sql$
  select count(*)::text, count(*) = 0 from public.studio_profile()
  where key not in ('studio_name', 'studio_tagline', 'studio_location', 'studio_email', 'studio_website', 'base_currency')
$sql$);

-- "managers read settings" (0016) filters by row, not by grant: a non-manager
-- reads the table itself and back comes nothing, not an error.
select pg_temp.check('STAFF: reads no row of workspace_settings directly, the profile key included', '0 · true', $sql$
  select count(*)::text, count(*) = 0 from public.workspace_settings where key in ('studio_name', 'mercury_account_number')
$sql$);

-- Own dismissal: goes through, and is the only one they can see even once
-- someone else has one too.
select pg_temp.check('STAFF: dismisses their own notification', '1 row · true', $sql$
  with ins as (
    insert into public.notification_dismissals (employee_id, notif_key)
    values (current_setting('test.assistant_employee')::uuid, 'ticket:check-26-1')
    returning 1
  )
  select count(*) || ' row', count(*) = 1 from ins
$sql$);

select pg_temp.refused('STAFF: cannot dismiss a notification as someone else', $sql$
  insert into public.notification_dismissals (employee_id, notif_key)
  values ('e2600000-0000-4000-a000-000000000001', 'ticket:check-26-2')
$sql$, 'row-level security');

select pg_temp.check('STAFF: reads back only their own dismissal', 'ticket:check-26-1 · true', $sql$
  select coalesce(string_agg(notif_key, ','), 'none'),
         coalesce(string_agg(notif_key, ','), 'none') = 'ticket:check-26-1'
  from public.notification_dismissals
$sql$);

-- ── MANAGER (the OWNER) ───────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.check('MANAGER: workspace_settings itself still holds the decoy key', 'check-26-secret-account · true', $sql$
  select value, value = 'check-26-secret-account' from public.workspace_settings where key = 'mercury_account_number'
$sql$);

select pg_temp.check('MANAGER: studio_profile() answers the same profile fields', 'check-26 Studio · true', $sql$
  select value, value = 'check-26 Studio' from public.studio_profile() where key = 'studio_name'
$sql$);

select pg_temp.check('MANAGER: still cannot read the assistant''s dismissal', 'none · true', $sql$
  select coalesce(string_agg(notif_key, ','), 'none'), count(*) = 0
  from public.notification_dismissals where employee_id = current_setting('test.assistant_employee')::uuid
$sql$);

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"c2600000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.check('NOT ON THE TEAM: studio_profile() answers nothing', 'none · true', $sql$
  select coalesce(string_agg(key, ','), 'none'), count(*) = 0 from public.studio_profile()
$sql$);

select pg_temp.refused('NOT ON THE TEAM: cannot dismiss a notification', $sql$
  insert into public.notification_dismissals (employee_id, notif_key) values
  ('e2600000-0000-4000-a000-000000000002', 'ticket:check-26-3')
$sql$, 'row-level security');

-- ── Anon ───────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select pg_temp.refused('ANON: cannot call studio_profile() at all', $sql$
  select 1 from public.studio_profile()
$sql$, 'permission denied for function studio_profile');

-- The select policy is scoped `to authenticated`: anon has none that applies,
-- which (like any other RLS table here) filters every row rather than erroring.
select pg_temp.check('ANON: reads no row of notification_dismissals', '0 · true', $sql$
  select count(*)::text, count(*) = 0 from public.notification_dismissals
$sql$);

reset role;

-- ── A repeat dismissal is a harmless duplicate, not a second row ─────────
-- pg_temp.check() runs its query as a single SELECT (EXECUTE ... INTO), which
-- cannot itself catch an exception, so this one is a plain DO block instead.
do $$
begin
  begin
    insert into public.notification_dismissals (employee_id, notif_key)
    values ('e2600000-0000-4000-a000-000000000001'::uuid, 'ticket:check-26-dup');
    insert into public.notification_dismissals (employee_id, notif_key)
    values ('e2600000-0000-4000-a000-000000000001'::uuid, 'ticket:check-26-dup');
    insert into results(name, expected, actual, pass)
    values ('DUPLICATE: a second identical dismissal raises unique_violation', '23505', 'no error', false);
  exception when unique_violation then
    insert into results(name, expected, actual, pass)
    values ('DUPLICATE: a second identical dismissal raises unique_violation', '23505', sqlstate, sqlstate = '23505');
  end;
end
$$;

insert into results(name, expected, actual, pass)
select 'POLICIES: notification_dismissals carries only its own select and insert', 'staff dismiss own notifications, staff read own notification_dismissals',
       coalesce(string_agg(policyname, ', ' order by policyname), 'none'),
       count(*) = 2 and bool_and(policyname in ('staff dismiss own notifications', 'staff read own notification_dismissals'))
from pg_policies
where schemaname = 'public' and tablename = 'notification_dismissals';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
