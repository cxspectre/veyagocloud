-- 15-project-task-rules.sql — the team can tick any task on their project (0050).
--
-- A task's status is changed by an owner or admin, by the task's assignee, or by
-- anyone on the team of the project it is filed under: the project's members and
-- its owner, the team 0039 opens a project's files to. Nothing else about tasks
-- changes: staff still change only a task's status and completion time (the
-- column guard, which now keeps a task's id as well), only owners and admins
-- edit and delete tasks, and a deactivated member or a session that skipped its
-- second factor changes nothing.
--
-- The non-manager is the inactive assistant, woken for this transaction only:
-- first staff on no project's team, then a member of one project and the owner
-- of another; then the same member at aal1, with a verified factor, and
-- deactivated. The OWNER is the manager. A refused update touches no row, so
-- each is followed by a look at the task as the table owner: a check cannot pass
-- because the task was never there. A refusal that raises passes only for the
-- reason it is about (pg_temp.refused, as in 05). Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

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

grant execute on function pg_temp.refused(text, text, text) to authenticated, anon;
grant execute on function pg_temp.affects(text, text, int) to authenticated, anon;
grant execute on function pg_temp.check(text, text, text) to authenticated, anon;

-- ── Fixtures, as the table owner ─────────────────────────────────────────

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- P1 (…21) is the OWNER's, and the assistant joins its team below. P2 (…22) has
-- no owner, and the assistant is never on it. P3 (…23) is the assistant's own.
insert into public.client_projects (id, name, owner_id) values
  ('c1500000-0000-4000-a000-000000000021', 'check-db 15 Team project',
   current_setting('test.owner_employee')::uuid),
  ('c1500000-0000-4000-a000-000000000022', 'check-db 15 Another project', null),
  ('c1500000-0000-4000-a000-000000000023', 'check-db 15 The assistant''s project',
   current_setting('test.assistant_employee')::uuid);

-- T1 (…31) is the assistant's, on P2. T2 (…32) is the OWNER's, on P1. T3 (…33)
-- is the OWNER's, on P2. T4 (…34) is the OWNER's, on P3. T5 (…35) is the
-- OWNER's, under no project.
insert into public.tasks (id, title, project_id, assignee_id, priority, status) values
  ('c1500000-0000-4000-a000-000000000031', 'check-db 15 the assistant''s own task',
   'c1500000-0000-4000-a000-000000000022', current_setting('test.assistant_employee')::uuid, 'normal', 'todo'),
  ('c1500000-0000-4000-a000-000000000032', 'check-db 15 a task on the team''s project',
   'c1500000-0000-4000-a000-000000000021', current_setting('test.owner_employee')::uuid, 'normal', 'todo'),
  ('c1500000-0000-4000-a000-000000000033', 'check-db 15 a task on another project',
   'c1500000-0000-4000-a000-000000000022', current_setting('test.owner_employee')::uuid, 'normal', 'todo'),
  ('c1500000-0000-4000-a000-000000000034', 'check-db 15 a task on the assistant''s project',
   'c1500000-0000-4000-a000-000000000023', current_setting('test.owner_employee')::uuid, 'normal', 'todo'),
  ('c1500000-0000-4000-a000-000000000035', 'check-db 15 a task under no project',
   null, current_setting('test.owner_employee')::uuid, 'normal', 'todo');

-- ── The assistant, on no project's team ──────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ASSIGNEE: moves their own task along, on a project whose team they are not on', $sql$
  update public.tasks set status = 'in_progress'
  where id = 'c1500000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('NOT ON THE TEAM: cannot tick a colleague''s task on a project they are not on', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 0);

select pg_temp.affects('NOT ON THE TEAM: nor a colleague''s task under no project', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000035'
$sql$, 0);

-- The rule is only as narrow as the team: nobody puts themselves on one.
select pg_temp.refused('NOT ON THE TEAM: nobody joins a team to tick its tasks', $sql$
  insert into public.project_members (project_id, employee_id)
  values ('c1500000-0000-4000-a000-000000000021', public.active_employee_id())
$sql$, 'row-level security');

reset role;

select pg_temp.check('ASSIGNEE: their task moved', 'in_progress', $sql$
  select status, status = 'in_progress'
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000031'
$sql$);

select pg_temp.check('NOT ON THE TEAM: the colleague''s tasks are as they were', 'todo · todo', $sql$
  select a.status || ' · ' || b.status, a.status = 'todo' and b.status = 'todo'
  from public.tasks a, public.tasks b
  where a.id = 'c1500000-0000-4000-a000-000000000032'
    and b.id = 'c1500000-0000-4000-a000-000000000035'
$sql$);

-- ── The assistant, a member of P1 and the owner of P3 ────────────────────
insert into public.project_members (project_id, employee_id)
values ('c1500000-0000-4000-a000-000000000021', current_setting('test.assistant_employee')::uuid);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

-- As the workspace's setTaskDone sends it: the status and the time it was done.
select pg_temp.affects('MEMBER: ticks a colleague''s task on their project, the way the workspace does', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 1);

select pg_temp.affects('MEMBER OF ANOTHER PROJECT: cannot tick a task on a project whose team they are not on', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000033'
$sql$, 0);

select pg_temp.affects('PROJECT OWNER: ticks a task on the project they own, without being its member', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000034'
$sql$, 1);

-- A member's update is let through to the column guard, like a tick; the guard
-- keeps everything but the status and completion time.
select pg_temp.affects('MEMBER: a rename reaches the column guard, as a tick does', $sql$
  update public.tasks set title = 'check-db 15 renamed by a member'
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 1);

select pg_temp.affects('MEMBER: so does re-assigning, re-filing or re-planning it', $sql$
  update public.tasks
  set assignee_id = public.active_employee_id(),
      project_id  = 'c1500000-0000-4000-a000-000000000022',
      priority    = 'urgent',
      due_date    = current_date + 1,
      details     = 'check-db 15 rewritten by a member'
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 1);

select pg_temp.affects('MEMBER: and giving it another id', $sql$
  update public.tasks set id = 'c1500000-0000-4000-a000-000000000099'
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 1);

select pg_temp.affects('MEMBER: cannot delete a task — owners and admins do', $sql$
  delete from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 0);

reset role;

select pg_temp.check('MEMBER: the tick lands, with the time it was done', 'done · with its time', $sql$
  select status || ' · ' || case when completed_at is null then 'without a time' else 'with its time' end,
         status = 'done' and completed_at is not null
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'
$sql$);

select pg_temp.check('MEMBER OF ANOTHER PROJECT: that task is as it was', 'todo · without a time', $sql$
  select status || ' · ' || case when completed_at is null then 'without a time' else 'with its time' end,
         status = 'todo' and completed_at is null
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000033'
$sql$);

select pg_temp.check('PROJECT OWNER: the tick lands, with the time it was done', 'done · with its time', $sql$
  select status || ' · ' || case when completed_at is null then 'without a time' else 'with its time' end,
         status = 'done' and completed_at is not null
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000034'
$sql$);

select pg_temp.check('MEMBER: cannot rename a task — the title stays', 'check-db 15 a task on the team''s project', $sql$
  select title, title = 'check-db 15 a task on the team''s project'
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'
$sql$);

select pg_temp.check('MEMBER: nor re-assign, re-file or re-plan it', 'the OWNER · Team project · normal · no due date · no details', format($sql$
  select case when t.assignee_id::text = %L then 'the OWNER' else coalesce(t.assignee_id::text, 'nobody') end
         || ' · ' || coalesce(replace(p.name, 'check-db 15 ', ''), 'no project')
         || ' · ' || t.priority
         || ' · ' || coalesce(t.due_date::text, 'no due date')
         || ' · ' || coalesce(t.details, 'no details'),
         t.assignee_id::text = %L
           and t.project_id = 'c1500000-0000-4000-a000-000000000021'
           and t.priority = 'normal' and t.due_date is null and t.details is null
  from public.tasks t
  left join public.client_projects p on p.id = t.project_id
  where t.id = 'c1500000-0000-4000-a000-000000000032'
$sql$, current_setting('test.owner_employee'), current_setting('test.owner_employee')));

select pg_temp.check('MEMBER: nor give it another id', 'its own id', $sql$
  select case when exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000099') then 'another id'
              when exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000032') then 'its own id'
              else 'gone' end,
         exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000032')
           and not exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000099')
$sql$);

-- ── The same member, at aal1 with a verified factor ──────────────────────
-- Stored the way Supabase Auth stores one, as in 06. Each refusal from here on
-- tries a status the task does not have, and is compared with the task as it
-- was just before, so it cannot pass by leaving alone what was already so.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('c1500000-0000-4000-a000-0000000000f1', '21fc20c1-50e8-4764-9a11-71031d2f8f2c',
        'check-db 15', 'totp', 'verified', now(), now());

select set_config('test.before',
  (select status from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal1"}', true);

select pg_temp.affects('AAL1: a member whose session skipped the code cannot change a task on their project', $sql$
  update public.tasks set status = 'in_progress', completed_at = null
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 0);

reset role;

select pg_temp.check('AAL1: the task is as it was', current_setting('test.before'), $sql$
  select status, status = current_setting('test.before') and status <> 'in_progress'
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'
$sql$);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('AAL2: the same member, with the code entered, can', $sql$
  update public.tasks set status = 'blocked', completed_at = null
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 1);

reset role;

select pg_temp.check('AAL2: the change lands', 'blocked', $sql$
  select status, status = 'blocked'
  from public.tasks where id = 'c1500000-0000-4000-a000-000000000032'
$sql$);

-- ── The same member, deactivated, whose session has not run out ─────────
update public.employees set status = 'inactive'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.before',
  (select a.status || ' · ' || b.status
   from public.tasks a, public.tasks b
   where a.id = 'c1500000-0000-4000-a000-000000000032'
     and b.id = 'c1500000-0000-4000-a000-000000000031'), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('DEACTIVATED: a member cannot change a task on their project', $sql$
  update public.tasks set status = 'in_progress', completed_at = null
  where id = 'c1500000-0000-4000-a000-000000000032'
$sql$, 0);

select pg_temp.affects('DEACTIVATED: nor move their own task along', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000031'
$sql$, 0);

reset role;

select pg_temp.check('DEACTIVATED: both tasks are as they were', current_setting('test.before'), $sql$
  select a.status || ' · ' || b.status,
         a.status || ' · ' || b.status = current_setting('test.before')
           and a.status <> 'in_progress' and b.status <> 'done'
  from public.tasks a, public.tasks b
  where a.id = 'c1500000-0000-4000-a000-000000000032'
    and b.id = 'c1500000-0000-4000-a000-000000000031'
$sql$);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('MANAGER: changes the status of a task not theirs, on a project with no owner', $sql$
  update public.tasks set status = 'done', completed_at = now()
  where id = 'c1500000-0000-4000-a000-000000000031'
$sql$, 1);

select pg_temp.affects('MANAGER: still edits a task', $sql$
  update public.tasks set title = 'check-db 15 renamed by a manager'
  where id = 'c1500000-0000-4000-a000-000000000033'
$sql$, 1);

select pg_temp.affects('MANAGER: still deletes a task', $sql$
  delete from public.tasks where id = 'c1500000-0000-4000-a000-000000000035'
$sql$, 1);

reset role;

select pg_temp.check('MANAGER: the status, the title and the deletion all land', 'done · check-db 15 renamed by a manager · deleted', $sql$
  select coalesce((select status from public.tasks where id = 'c1500000-0000-4000-a000-000000000031'), 'gone')
         || ' · ' || coalesce((select title from public.tasks where id = 'c1500000-0000-4000-a000-000000000033'), 'gone')
         || ' · ' || case when exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000035')
                          then 'still there' else 'deleted' end,
         (select status from public.tasks where id = 'c1500000-0000-4000-a000-000000000031') = 'done'
           and (select title from public.tasks where id = 'c1500000-0000-4000-a000-000000000033') = 'check-db 15 renamed by a manager'
           and not exists (select 1 from public.tasks where id = 'c1500000-0000-4000-a000-000000000035')
$sql$);

-- ── Policies ─────────────────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'POLICIES: a task is moved along by its assignee or its project''s team, and otherwise changed by owners and admins',
       'assignee or project team updates tasks, manager all tasks',
       coalesce(string_agg(policyname, ', ' order by policyname), 'none'),
       count(*) = 2
         and bool_or(policyname = 'manager all tasks')
         and bool_or(policyname = 'assignee or project team updates tasks'
                     and cmd = 'UPDATE'
                     and qual like '%active_employee_id()%' and qual like '%can_open_project_files(project_id)%'
                     and with_check like '%active_employee_id()%' and with_check like '%can_open_project_files(project_id)%')
from pg_policies
where schemaname = 'public' and tablename = 'tasks'
  and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'ALL');

insert into results(name, expected, actual, pass)
select 'POLICIES: tasks still require the second factor', 'second factor required',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 1
from pg_policies
where schemaname = 'public' and tablename = 'tasks'
  and policyname = 'second factor required' and permissive = 'RESTRICTIVE' and cmd = 'ALL'
  and qual like '%second_factor_met%' and with_check like '%second_factor_met%';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
