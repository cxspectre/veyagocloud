-- 08-team-rules.sql — who may change whose role, and who reads a colleague's
-- phone and notes (0042, 0043).
--
-- The OWNER is the owner. The assistant, inactive in real life, is woken for
-- this transaction: first as an admin, then as an employee. A fixture member,
-- linked to nobody's sign-in, is the colleague an admin may still manage. A
-- refusal passes only for the reason it is about (pg_temp.refused, as in 05).
-- Everything is rolled back.
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

-- A query that answers (actual text, pass boolean). An error is a named FAIL,
-- not the end of the suite.
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

-- Fixtures, as the table owner.
update public.employees
set status = 'active', role = 'admin', phone = '+00 0800 0808', notes = 'check-db 08 note'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.employees (id, email, full_name, role, status)
values ('e8000000-0000-4000-a000-000000000001', 'check-db-08@example.invalid', 'check-db 08 member', 'employee', 'invited');

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);
-- The OWNER's address in the other case: upper when it is stored lower, lower otherwise.
select set_config('test.owner_email_other_case',
  (select case when email = lower(email) then upper(email) else lower(email) end
   from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);

-- ── The assistant as an ADMIN ────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('ADMIN: cannot make themselves owner', $sql$
  update public.employees set role = 'owner' where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'
$sql$, 'their own role');

select pg_temp.refused('ADMIN: cannot deactivate themselves', $sql$
  update public.employees set status = 'inactive' where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'
$sql$, 'their own role or status');

select pg_temp.refused('ADMIN: cannot demote the owner', format($sql$
  update public.employees set role = 'employee' where id = %L
$sql$, current_setting('test.owner_employee')), 'only an owner');

select pg_temp.refused('ADMIN: cannot deactivate the owner', format($sql$
  update public.employees set status = 'inactive' where id = %L
$sql$, current_setting('test.owner_employee')), 'only an owner');

select pg_temp.refused('ADMIN: cannot change anything of the owner''s, not even the title', format($sql$
  update public.employees set title = 'Former owner' where id = %L
$sql$, current_setting('test.owner_employee')), 'only an owner');

select pg_temp.refused('ADMIN: cannot take over the owner''s row with their own sign-in', format($sql$
  update public.employees set user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c' where id = %L
$sql$, current_setting('test.owner_employee')), 'only an invitation');

select pg_temp.affects('ADMIN: cannot delete the owner', format($sql$
  delete from public.employees where id = %L
$sql$, current_setting('test.owner_employee')), 0);

select pg_temp.affects('ADMIN: cannot delete anyone', $sql$
  delete from public.employees where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 0);

select pg_temp.refused('ADMIN: cannot add an owner', $sql$
  insert into public.employees (email, full_name, role, status)
  values ('check-db-08-owner@example.invalid', 'check-db 08 owner', 'owner', 'invited')
$sql$, 'only an owner');

select pg_temp.refused('ADMIN: cannot make a colleague an owner', $sql$
  update public.employees set role = 'owner' where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 'only an owner');

select pg_temp.refused('ADMIN: cannot link a sign-in to a colleague', $sql$
  update public.employees set user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
  where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 'only an invitation');

select pg_temp.refused('ADMIN: cannot add a member with a sign-in already linked', $sql$
  insert into public.employees (email, full_name, role, status, user_id)
  values ('check-db-08-linked@example.invalid', 'check-db 08 linked', 'employee', 'invited',
          'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093')
$sql$, 'only an invitation');

select pg_temp.refused('ADMIN: cannot add the owner a second time, in another case', format($sql$
  insert into public.employees (email, full_name, role, status)
  values (%L, 'check-db 08 twin', 'employee', 'invited')
$sql$, current_setting('test.owner_email_other_case')), 'employees_email_lower_idx');

select pg_temp.refused('ADMIN: cannot change the address of someone who can sign in, their own included', $sql$
  update public.employees set email = 'check-db-08-moved@example.invalid'
  where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'
$sql$, 'belongs to their sign-in');

select pg_temp.refused('ADMIN: cannot change a team member''s id', $sql$
  update public.employees set id = gen_random_uuid() where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 'id cannot change');

select pg_temp.affects('ADMIN: still gives a colleague a new role and title', $sql$
  update public.employees set role = 'assistant', title = 'check-db 08'
  where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 1);

select pg_temp.affects('ADMIN: still deactivates a colleague', $sql$
  update public.employees set status = 'inactive' where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 1);

select pg_temp.affects('ADMIN: still adds a member', $sql$
  insert into public.employees (email, full_name, role, status)
  values ('check-db-08-new@example.invalid', 'check-db 08 new', 'employee', 'invited')
$sql$, 1);

-- ── The OWNER ────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('OWNER: makes a colleague an owner', $sql$
  update public.employees set role = 'owner' where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 1);

select pg_temp.affects('OWNER: changes an owner back', $sql$
  update public.employees set role = 'employee' where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 1);

select pg_temp.refused('OWNER: cannot deactivate themselves either', $sql$
  update public.employees set status = 'inactive' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
$sql$, 'their own role or status');

select pg_temp.check('OWNER: reads a colleague''s phone and notes', '+00 0800 0808 / check-db 08 note', format($sql$
  select coalesce(max(p.phone), 'null') || ' / ' || coalesce(max(p.notes), 'null'),
         coalesce(max(p.phone) = '+00 0800 0808' and max(p.notes) = 'check-db 08 note', false)
  from public.employee_private(%L::uuid) p
$sql$, current_setting('test.assistant_employee')));

-- ── The assistant as an EMPLOYEE ─────────────────────────────────────────
reset role;
update public.employees set role = 'employee' where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';
select set_config('test.employee_count', (select count(*)::text from public.employees), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('STAFF: cannot read colleagues'' phone numbers', $sql$
  select phone from public.employees
$sql$, 'permission denied for table employees');

select pg_temp.refused('STAFF: cannot read the notes about colleagues', $sql$
  select notes from public.employees
$sql$, 'permission denied for table employees');

select pg_temp.refused('STAFF: not with select * either', $sql$
  select * from public.employees
$sql$, 'permission denied for table employees');

select pg_temp.check('STAFF: still reads the whole team directory', current_setting('test.employee_count') || ' people', format($sql$
  select count(*) || ' people', count(*)::text = %L
  from (select id, user_id, email, full_name, role, title, status, start_date, created_at, updated_at
        from public.employees) directory
$sql$, current_setting('test.employee_count')));

select pg_temp.check('STAFF: their own phone number, but not the notes about them', '+00 0800 0808 / null', format($sql$
  select coalesce(max(p.phone), 'null') || ' / ' || coalesce(max(p.notes), 'null'),
         coalesce(max(p.phone) = '+00 0800 0808', false) and max(p.notes) is null
  from public.employee_private(%L::uuid) p
$sql$, current_setting('test.assistant_employee')));

select pg_temp.check('STAFF: nothing of a colleague''s', '0 rows', format($sql$
  select count(*) || ' rows', count(*) = 0 from public.employee_private(%L::uuid)
$sql$, current_setting('test.owner_employee')));

-- ── Accepting an invitation still works ──────────────────────────────────
reset role;
update public.employees set status = 'invited' where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);
select pg_temp.affects('ACTIVATE: an invited person can still call activate_self()', 'select public.activate_self()', 1);
reset role;

insert into results(name, expected, actual, pass)
select 'ACTIVATE: an invited person still activates their own row', 'active', status, status = 'active'
from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- ── Operators: the service role, the SQL editor ──────────────────────────
-- Every other owner who can sign in stands down, so the OWNER is the last one.
update public.employees set role = 'admin'
where role = 'owner' and status <> 'inactive' and user_id is not null
  and user_id <> 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';

select pg_temp.refused('OPERATORS: nobody demotes the last owner who can sign in', $sql$
  update public.employees set role = 'admin' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
$sql$, 'needs an owner');

select pg_temp.refused('OPERATORS: nor deactivates them', $sql$
  update public.employees set status = 'inactive' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
$sql$, 'needs an owner');

update public.employees set role = 'owner', status = 'active'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select pg_temp.affects('OPERATORS: with another owner who can sign in, the change goes through', $sql$
  update public.employees set role = 'admin' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
$sql$, 1);

-- The service role, as invite-employee writes: never onto a different sign-in.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.refused('SERVICE ROLE: cannot move a member onto a different sign-in', $sql$
  update public.employees set user_id = gen_random_uuid() where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'
$sql$, 'already has a sign-in');
reset role;

-- Two owners who can sign in: the OWNER again, and the fixture member on the
-- assistant's sign-in, with no history for a delete to cascade into.
update public.employees set role = 'owner' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';
update public.employees set role = 'admin', user_id = null where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';
update public.employees set user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c', role = 'owner', status = 'active'
where id = 'e8000000-0000-4000-a000-000000000001';

select pg_temp.refused('OPERATORS: nor stands every owner down in one statement', $sql$
  update public.employees set role = 'admin' where role = 'owner'
$sql$, 'needs an owner');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.refused('SERVICE ROLE: nor does the service role', $sql$
  update public.employees set status = 'inactive' where role = 'owner'
$sql$, 'needs an owner');
reset role;

update public.employees set role = 'admin' where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';
select pg_temp.refused('OPERATORS: nor deletes the last one', $sql$
  delete from public.employees where id = 'e8000000-0000-4000-a000-000000000001'
$sql$, 'needs an owner');

-- ── Grants and policies ──────────────────────────────────────────────────
insert into results(name, expected, actual, pass)
select 'GRANTS: phone and notes cannot be selected, every directory column can, and anon reads nothing',
       'false false 10 false',
       concat_ws(' ', has_column_privilege('authenticated', 'public.employees', 'phone', 'select'),
                      has_column_privilege('authenticated', 'public.employees', 'notes', 'select'),
                      d.readable,
                      has_any_column_privilege('anon', 'public.employees', 'select')),
       not has_column_privilege('authenticated', 'public.employees', 'phone', 'select')
         and not has_column_privilege('authenticated', 'public.employees', 'notes', 'select')
         and d.readable = 10
         and not has_any_column_privilege('anon', 'public.employees', 'select')
from (select count(*) as readable
      from unnest(array['id', 'user_id', 'email', 'full_name', 'role', 'title', 'status',
                        'start_date', 'created_at', 'updated_at']) as c(name)
      where has_column_privilege('authenticated', 'public.employees', c.name, 'select')) d;

insert into results(name, expected, actual, pass)
select 'GRANTS: anon cannot ask employee_private', 'false',
       has_function_privilege('anon', 'public.employee_private(uuid)', 'execute')::text,
       not has_function_privilege('anon', 'public.employee_private(uuid)', 'execute');

insert into results(name, expected, actual, pass)
select 'POLICIES: nothing lets anyone delete employees', 'none',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 0
from pg_policies
where schemaname = 'public' and tablename = 'employees'
  and permissive = 'PERMISSIVE' and cmd in ('ALL', 'DELETE');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
