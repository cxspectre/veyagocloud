-- 0050_project_task_rules.sql — the team can tick any task on their project.
--
-- Until now a task's status was changed by its assignee ("assignee updates own
-- tasks", 0006) or by an owner or admin ("manager all tasks", 0005). The
-- workspace assigns a new task to whoever adds it, so a teammate who ticked it
-- off on the project page was answered with a raw row-level security error.
--
-- Now a task's status is changed by:
--
--   * an owner or admin, as before;
--   * the task's assignee, as before;
--   * anyone on the team of the project the task is filed under: its members
--     and its owner, the team 0039 opens a project's files to, asked through the
--     same can_open_project_files(). A task under no project has no team.
--
-- Everything else stays:
--
--   * Staff change only a task's status and the time it was done. The column
--     guard (0006, 0022) restores every other column a non-manager sends, and
--     now the task's id as well, which it never kept: with a whole team able to
--     reach the guard, "only the status" has to include the key that comments,
--     notes and activity find a task by.
--   * Owners and admins edit and delete tasks. Nobody else deletes one.
--   * A deactivated employee, or a session that still owes its second factor,
--     has no active_employee_id() and is on no team (0040), and the restrictive
--     "second factor required" policy stays on tasks.
--
-- No trigger stamps completed_at. The workspace (setTaskDone) and the admin send
-- it with the status, and the guard lets a non-manager set it — a member as much
-- as an assignee.
--
-- Checked by supabase/tests/15-project-task-rules.sql.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. Who moves a task along ────────────────────────────────────────────
-- (select …) so the caller's employee id is looked up once per statement. The
-- team is asked per row, and only for a task that is filed under a project.

drop policy if exists "assignee updates own tasks" on public.tasks;

drop policy if exists "assignee or project team updates tasks" on public.tasks;
create policy "assignee or project team updates tasks"
  on public.tasks for update to authenticated
  using (
    assignee_id = (select public.active_employee_id())
    or (project_id is not null and public.can_open_project_files(project_id))
  )
  with check (
    assignee_id = (select public.active_employee_id())
    or (project_id is not null and public.can_open_project_files(project_id))
  );

-- ── 2. What they change: the status, as before, and never the id ─────────
-- The body from 0022, with the id kept. The guard runs before the policy's
-- WITH CHECK, so the assignee and project it is checked against are the task's
-- own.

create or replace function public.tasks_guard_assignee_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_manager() then
    return new;                       -- managers may change anything
  end if;
  -- Everyone else (a task's assignee, and its project's team since 0050) may
  -- only move a task along: status + completed_at.
  new.id          := old.id;          -- added 0050
  new.title       := old.title;
  new.details     := old.details;
  new.assignee_id := old.assignee_id;
  new.priority    := old.priority;
  new.due_date    := old.due_date;
  new.created_by  := old.created_by;
  new.created_at  := old.created_at;
  new.project_id  := old.project_id;  -- added 0022
  return new;
end;
$$;

-- It runs as a trigger; no role needs to call it.
revoke all on function public.tasks_guard_assignee_columns() from public, anon, authenticated;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'tasks'
               and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'ALL')
               and policyname not in ('assignee or project team updates tasks', 'manager all tasks')) then
    raise exception '0050: another policy still decides who changes a task';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'tasks'
                   and policyname = 'assignee or project team updates tasks'
                   and permissive = 'PERMISSIVE' and cmd = 'UPDATE'
                   and roles @> array['authenticated']::name[]
                   and qual like '%active_employee_id()%'
                   and qual like '%can_open_project_files(project_id)%'
                   and with_check like '%active_employee_id()%'
                   and with_check like '%can_open_project_files(project_id)%') then
    raise exception '0050: a task''s project team still cannot move it along';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'tasks'
                   and policyname = 'second factor required' and permissive = 'RESTRICTIVE') then
    raise exception '0050: tasks no longer require the second factor';
  end if;

  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.tasks'::regclass and tgname = 'tasks_guard_assignee_columns'
                   and not tgisinternal and tgenabled <> 'D')
     or pg_get_functiondef('public.tasks_guard_assignee_columns()'::regprocedure) !~ 'new\.id\s*:=\s*old\.id' then
    raise exception '0050: the column guard does not keep a task''s id';
  end if;

  if has_function_privilege('authenticated', 'public.tasks_guard_assignee_columns()', 'execute') then
    raise exception '0050: signed-in people can still call the column guard';
  end if;
end
$$;
