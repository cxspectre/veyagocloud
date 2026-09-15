-- 12-task-comments.sql — task comments are for staff, not for any signed-in
-- account (0047).
--
-- One task and two comments on it, the OWNER's and the assistant's, met by four
-- people in turn: someone signed in who is not on the team; the assistant,
-- deactivated, with a session that has not run out; the same assistant woken as
-- an employee; and the OWNER, a manager. A refusal passes only for the reason it
-- is about (pg_temp.refused, as in 05). Everything is rolled back.
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

-- The assistant starts out deactivated, and is woken further down.
update public.employees set status = 'inactive', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- Fixtures. All rolled back.
insert into public.tasks (id, title)
values ('c1200000-0000-4000-a000-000000000001', 'check-db 12 task');
insert into public.task_comments (id, task_id, author_id, body) values
  ('c1200000-0000-4000-a000-0000000000c1', 'c1200000-0000-4000-a000-000000000001',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', 'check-db 12, from the OWNER'),
  ('c1200000-0000-4000-a000-0000000000c2', 'c1200000-0000-4000-a000-000000000001',
   '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'check-db 12, from the assistant');

-- ── Someone signed in who is not on the team ─────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1200000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NOT ON THE TEAM: signed in, and reads no comment on any task', '0', count(*)::text, count(*) = 0
from public.task_comments;

select pg_temp.refused('NOT ON THE TEAM: cannot comment, even as themselves', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c1200000-0000-4000-a000-000000000001', 'c1200000-0000-4000-a000-0000000000ff', 'check-db 12, from outside')
$sql$, 'policy "staff only"');

-- ── The assistant, deactivated, whose session has not run out ────────────
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'DEACTIVATED: reads no comment, not even their own', '0', count(*)::text, count(*) = 0
from public.task_comments;

select pg_temp.refused('DEACTIVATED: cannot comment', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c1200000-0000-4000-a000-000000000001', '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'check-db 12, after leaving')
$sql$, 'policy "staff only"');

select pg_temp.affects('DEACTIVATED: cannot remove what they once wrote', $sql$
  delete from public.task_comments where id = 'c1200000-0000-4000-a000-0000000000c2'
$sql$, 0);

reset role;

-- ── The assistant, a member of staff ─────────────────────────────────────
update public.employees set status = 'active'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: reads the comments on the task', '2', count(*)::text, count(*) = 2
from public.task_comments where task_id = 'c1200000-0000-4000-a000-000000000001';

select pg_temp.affects('STAFF: comments', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c1200000-0000-4000-a000-000000000001', '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'check-db 12, from staff')
$sql$, 1);

-- No policy names this refusal: none lets anyone sign as a colleague.
select pg_temp.refused('STAFF: still not as a colleague', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c1200000-0000-4000-a000-000000000001', 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', 'check-db 12, signed as the OWNER')
$sql$, 'row-level security policy for table');

select pg_temp.affects('STAFF: removes their own comment', $sql$
  delete from public.task_comments where id = 'c1200000-0000-4000-a000-0000000000c2'
$sql$, 1);

select pg_temp.affects('STAFF: but not a colleague''s', $sql$
  delete from public.task_comments where id = 'c1200000-0000-4000-a000-0000000000c1'
$sql$, 0);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'MANAGER: reads the comments on the task', '2', count(*)::text, count(*) = 2
from public.task_comments where task_id = 'c1200000-0000-4000-a000-000000000001';

select pg_temp.affects('MANAGER: comments', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c1200000-0000-4000-a000-000000000001', 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', 'check-db 12, from a manager')
$sql$, 1);

select pg_temp.affects('MANAGER: removes a colleague''s comment', $sql$
  delete from public.task_comments
  where task_id = 'c1200000-0000-4000-a000-000000000001'
    and author_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'
$sql$, 1);

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'POLICIES: staff only, whatever the command', 'staff only',
       coalesce(string_agg(policyname, ', '), 'none'), count(*) = 1
from pg_policies
where schemaname = 'public' and tablename = 'task_comments'
  and policyname = 'staff only'
  and permissive = 'RESTRICTIVE' and cmd = 'ALL'
  and roles @> array['authenticated']::name[]
  and qual like '%is_staff()%' and with_check like '%is_staff()%';

insert into results(name, expected, actual, pass)
select 'POLICIES: one rule decides who reads a comment, and it asks the task''s own rules',
       'staff read comments on tasks they can see',
       coalesce(string_agg(policyname, ', '), 'none'),
       count(*) = 1 and bool_and(policyname = 'staff read comments on tasks they can see'
                                 and qual like '%tasks%')
from pg_policies
where schemaname = 'public' and tablename = 'task_comments'
  and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
