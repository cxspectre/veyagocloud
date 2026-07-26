-- =============================================================================
-- Veyago — RLS hardening for the employee dashboard (follow-up to 0005).
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.
--
-- Fixes three gaps found in review of 0005:
--
--  1. Offboarded staff kept write access. employee_role() correctly excludes
--     status='inactive', but the "assignee updates own tasks" and "employee own
--     onboarding progress" policies bypassed it by looking employees up
--     directly with no status filter. Deactivating someone does not revoke
--     their existing JWT (sessions refresh for hours), so a deactivated
--     employee could still rewrite their tasks and onboarding rows via direct
--     PostgREST calls.
--
--  2. created_by could be forged. "staff creates tasks" only checked
--     is_staff(), never that created_by = auth.uid(). Staff can read
--     employees.user_id, so a PA could create tasks attributed to the owner —
--     created_by is the only authorship record we keep.
--
--  3. An assignee could rewrite ANY column on a task assigned to them
--     (title, created_by, priority…), not just their own progress fields.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Active-employee id for the caller, or NULL. SECURITY DEFINER so policies can
-- resolve it regardless of the caller's own row visibility. This is the
-- status-aware replacement for the raw subselects used in 0005.
-- ---------------------------------------------------------------------------
create or replace function public.active_employee_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.employees
  where user_id = auth.uid() and status <> 'inactive';
$$;

-- ---------------------------------------------------------------------------
-- Tasks: assignees may only advance their OWN work, and only the columns that
-- represent progress. Everything else (title, details, assignee, priority,
-- due date, authorship) stays manager-only.
-- ---------------------------------------------------------------------------
drop policy if exists "assignee updates own tasks" on public.tasks;
create policy "assignee updates own tasks"
  on public.tasks for update
  using (assignee_id = public.active_employee_id())
  with check (assignee_id = public.active_employee_id());

-- Column-level immutability for non-managers. A trigger (not a WITH CHECK with
-- self-subselects, whose visibility semantics mid-statement are subtle) is the
-- deterministic way to do this: it compares NEW against OLD directly and simply
-- restores any field the assignee is not allowed to touch.
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
  -- Assignees may only move a task along: status + completed_at.
  new.title       := old.title;
  new.details     := old.details;
  new.assignee_id := old.assignee_id;
  new.priority    := old.priority;
  new.due_date    := old.due_date;
  new.created_by  := old.created_by;
  new.created_at  := old.created_at;
  return new;
end;
$$;

drop trigger if exists tasks_guard_assignee_columns on public.tasks;
create trigger tasks_guard_assignee_columns
  before update on public.tasks
  for each row execute function public.tasks_guard_assignee_columns();

-- Authorship is the caller's own id, always. NULL stays allowed so a task can
-- be created by a legacy allowlist admin with no employees row.
drop policy if exists "staff creates tasks" on public.tasks;
create policy "staff creates tasks"
  on public.tasks for insert
  with check (
    public.is_staff()
    and (created_by = auth.uid() or created_by is null)
  );

-- Belt and braces: default created_by server-side so the client cannot choose
-- it even if a future policy loosens.
alter table public.tasks
  alter column created_by set default auth.uid();

-- ---------------------------------------------------------------------------
-- Onboarding progress: same status-aware check for the self-service policy.
-- ---------------------------------------------------------------------------
drop policy if exists "employee own onboarding progress" on public.onboarding_progress;
create policy "employee own onboarding progress"
  on public.onboarding_progress for all
  using (employee_id = public.active_employee_id())
  with check (employee_id = public.active_employee_id());
