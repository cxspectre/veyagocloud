-- 23-project-milestones-and-time.sql — a project's milestones (0058) are read
-- by any staff member and written only by whoever can manage the project; a
-- project's logged time is read by whoever logged it or whoever manages the
-- project, and written only by whoever logged it, for themselves, on a
-- project they have real standing on.
--
-- The non-manager is the inactive assistant, woken for this transaction only:
-- first a stranger to the OWNER's project, then a member of it (but not its
-- owner), then the owner of a project of their own. The OWNER is the manager.
-- A refusal that raises passes only for the reason it is about
-- (pg_temp.refused, as in 05); a write that goes through is checked for how
-- many rows it touched (pg_temp.affects). Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

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

-- Fixtures. All rolled back.
-- P1 (…21) is the OWNER's. P2 (…22) is the assistant's own.
insert into public.client_projects (id, name, owner_id) values
  ('c2300000-0000-4000-a000-000000000021', 'check-db 23 Owner Project', current_setting('test.owner_employee')::uuid),
  ('c2300000-0000-4000-a000-000000000022', 'check-db 23 Assistant Project', current_setting('test.assistant_employee')::uuid);
insert into public.tasks (id, project_id, title, status) values
  ('c2300000-0000-4000-a000-000000000031', 'c2300000-0000-4000-a000-000000000021', 'check-db 23 task', 'todo');
insert into public.project_milestones (id, project_id, name, due_on) values
  ('c2300000-0000-4000-a000-000000000041', 'c2300000-0000-4000-a000-000000000021', 'Kickoff', current_date + 7);
insert into public.time_entries (id, project_id, task_id, employee_id, day, minutes) values
  ('c2300000-0000-4000-a000-000000000051', 'c2300000-0000-4000-a000-000000000021',
   'c2300000-0000-4000-a000-000000000031', current_setting('test.owner_employee')::uuid, current_date, 90);

-- ── The shape of things ──────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'MILESTONES: no sort_order column', '0 columns', count(*) || ' columns', count(*) = 0
from information_schema.columns
where table_schema = 'public' and table_name = 'project_milestones' and column_name = 'sort_order';

insert into results(name, expected, actual, pass)
select 'TIME: billable defaults true when not said', 'true', billable::text, billable = true
from public.time_entries where id = 'c2300000-0000-4000-a000-000000000051';

select pg_temp.refused('MILESTONES: a blank name is refused', $sql$
  insert into public.project_milestones (project_id, name)
  values ('c2300000-0000-4000-a000-000000000021', '   ')
$sql$, 'project_milestones_name_check');

select pg_temp.refused('MILESTONES: a name past 200 characters is refused', $sql$
  insert into public.project_milestones (project_id, name)
  values ('c2300000-0000-4000-a000-000000000021', repeat('x', 201))
$sql$, 'project_milestones_name_check');

select pg_temp.refused('TIME: zero minutes is refused', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', current_setting('test.owner_employee')::uuid, current_date, 0)
$sql$, 'time_entries_minutes_check');

select pg_temp.refused('TIME: negative minutes is refused', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', current_setting('test.owner_employee')::uuid, current_date, -5)
$sql$, 'time_entries_minutes_check');

select pg_temp.refused('TIME: more than a day''s minutes is refused', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', current_setting('test.owner_employee')::uuid, current_date, 1441)
$sql$, 'time_entries_minutes_check');

select pg_temp.affects('TIME: a full day (1440 minutes) is accepted', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', current_setting('test.owner_employee')::uuid, current_date, 1440)
$sql$, 1);
delete from public.time_entries where minutes = 1440;

-- ── The assistant, a stranger to the OWNER's project ─────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'MILESTONES: read by any staff member, stranger included', '1 row', count(*) || ' row', count(*) = 1
from public.project_milestones where project_id = 'c2300000-0000-4000-a000-000000000021';

select pg_temp.refused('MILESTONES: a stranger cannot add one', $sql$
  insert into public.project_milestones (project_id, name)
  values ('c2300000-0000-4000-a000-000000000021', 'Sneaky milestone')
$sql$, 'row-level security');

select pg_temp.affects('MILESTONES: a stranger cannot change one', $sql$
  update public.project_milestones set name = 'Renamed'
  where id = 'c2300000-0000-4000-a000-000000000041'
$sql$, 0);

select pg_temp.affects('MILESTONES: a stranger cannot remove one', $sql$
  delete from public.project_milestones where id = 'c2300000-0000-4000-a000-000000000041'
$sql$, 0);

insert into results(name, expected, actual, pass)
select 'TIME: hidden from a stranger to the project', '0 rows', count(*) || ' rows', count(*) = 0
from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000021';

select pg_temp.refused('TIME: a stranger cannot log time against a project they have no standing on', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', public.active_employee_id(), current_date, 30)
$sql$, 'row-level security');

select pg_temp.refused('TIME: nor log it as someone else, even on their own project', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000022', current_setting('test.owner_employee')::uuid, current_date, 30)
$sql$, 'row-level security');

select pg_temp.affects('TIME: a stranger cannot correct the OWNER''s entry', $sql$
  update public.time_entries set minutes = 999
  where id = 'c2300000-0000-4000-a000-000000000051'
$sql$, 0);

reset role;

-- ── The assistant, a member of the OWNER's project (not its owner) ───────

insert into public.project_members (project_id, employee_id)
values ('c2300000-0000-4000-a000-000000000021', current_setting('test.assistant_employee')::uuid);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('MILESTONES: a member (not the owner) still cannot add one — that needs can_manage_project, not team membership', $sql$
  insert into public.project_milestones (project_id, name)
  values ('c2300000-0000-4000-a000-000000000021', 'Member''s milestone')
$sql$, 'row-level security');

select pg_temp.affects('TIME: a member logs their own time, on a project they have real standing on', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes)
  values ('c2300000-0000-4000-a000-000000000021', public.active_employee_id(), current_date, 45)
$sql$, 1);

-- A member sees their own entry, but not the OWNER's on the same project:
-- read is "your own, or a project you manage" (this file's header) — team
-- membership alone opens a project's files (0039), not its logged time.
insert into results(name, expected, actual, pass)
select 'TIME: a member sees their own entry, not a colleague''s on the same project', '1 row', count(*) || ' row', count(*) = 1
from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000021';

select pg_temp.affects('TIME: a member corrects their own entry', $sql$
  update public.time_entries set minutes = 50
  where project_id = 'c2300000-0000-4000-a000-000000000021' and employee_id = public.active_employee_id()
$sql$, 1);

select pg_temp.affects('TIME: but not the OWNER''s entry on the same project', $sql$
  update public.time_entries set minutes = 1
  where id = 'c2300000-0000-4000-a000-000000000051'
$sql$, 0);

select pg_temp.refused('TIME: an update cannot move an entry to a different project', $sql$
  update public.time_entries set project_id = 'c2300000-0000-4000-a000-000000000022'
  where project_id = 'c2300000-0000-4000-a000-000000000021' and employee_id = public.active_employee_id()
$sql$, 'permission denied');

select pg_temp.refused('TIME: nor hand it to someone else', $sql$
  update public.time_entries set employee_id = current_setting('test.owner_employee')::uuid
  where project_id = 'c2300000-0000-4000-a000-000000000021' and employee_id = public.active_employee_id()
$sql$, 'permission denied');

select pg_temp.affects('TIME: a member removes their own entry', $sql$
  delete from public.time_entries
  where project_id = 'c2300000-0000-4000-a000-000000000021' and employee_id = public.active_employee_id()
$sql$, 1);

delete from public.project_members where project_id = 'c2300000-0000-4000-a000-000000000021';

reset role;

-- ── The assistant, owner of a project of their own ───────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('MILESTONES: a project''s own owner adds one', $sql$
  insert into public.project_milestones (project_id, name, due_on)
  values ('c2300000-0000-4000-a000-000000000022', 'Assistant''s milestone', current_date + 14)
$sql$, 1);

select pg_temp.affects('MILESTONES: and marks it reached', $sql$
  update public.project_milestones set completed_at = now()
  where project_id = 'c2300000-0000-4000-a000-000000000022'
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'MILESTONES: signed by whoever added it', 'the assistant',
       case when created_by = public.active_employee_id() then 'the assistant'
            else coalesce(created_by::text, 'nobody') end,
       created_by = public.active_employee_id()
from public.project_milestones where project_id = 'c2300000-0000-4000-a000-000000000022';

select pg_temp.affects('MILESTONES: and removes it', $sql$
  delete from public.project_milestones where project_id = 'c2300000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.affects('TIME: an owner logs their own time on their own project', $sql$
  insert into public.time_entries (project_id, employee_id, day, minutes, billable)
  values ('c2300000-0000-4000-a000-000000000022', public.active_employee_id(), current_date, 120, false)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'TIME: billable defaults true, and a non-billable entry keeps false', 'false', billable::text, billable = false
from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000022';

reset role;

-- ── The OWNER, a manager ─────────────────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('MILESTONES: a manager adds one to any project, not only their own', $sql$
  insert into public.project_milestones (project_id, name, due_on)
  values ('c2300000-0000-4000-a000-000000000022', 'Manager''s check', current_date + 3)
$sql$, 1);

select pg_temp.affects('MILESTONES: and removes it', $sql$
  delete from public.project_milestones where project_id = 'c2300000-0000-4000-a000-000000000022' and name = 'Manager''s check'
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'TIME: a manager reads the whole project''s logged time, not only their own', '1 row', count(*) || ' row', count(*) = 1
from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000022';

select pg_temp.affects('TIME: a manager corrects an entry that is not theirs, on a project they manage', $sql$
  update public.time_entries set minutes = 60
  where project_id = 'c2300000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.affects('TIME: and removes it', $sql$
  delete from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000022'
$sql$, 1);

reset role;

-- ── A project deleted outright takes its milestones and time with it ─────
-- Unlike project_files (0039: restrict, so a project with files is archived,
-- not deleted), a milestone or a logged hour is not an external resource
-- with its own storage cost to orphan — it means nothing once its project is
-- gone, so cascade is the right shape here, on a throwaway project of its
-- own so this does not disturb P1 or P2 above.
insert into public.client_projects (id, name, owner_id) values
  ('c2300000-0000-4000-a000-000000000029', 'check-db 23 Throwaway', current_setting('test.owner_employee')::uuid);
insert into public.project_milestones (project_id, name) values
  ('c2300000-0000-4000-a000-000000000029', 'Gone with its project');
insert into public.time_entries (project_id, employee_id, day, minutes) values
  ('c2300000-0000-4000-a000-000000000029', current_setting('test.owner_employee')::uuid, current_date, 15);

select pg_temp.affects('CASCADE: deleting a project outright removes it', $sql$
  delete from public.client_projects where id = 'c2300000-0000-4000-a000-000000000029'
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CASCADE: its milestone went with it', '0 rows', count(*) || ' rows', count(*) = 0
from public.project_milestones where project_id = 'c2300000-0000-4000-a000-000000000029';

insert into results(name, expected, actual, pass)
select 'CASCADE: its logged time went with it', '0 rows', count(*) || ' rows', count(*) = 0
from public.time_entries where project_id = 'c2300000-0000-4000-a000-000000000029';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
