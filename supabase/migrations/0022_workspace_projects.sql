-- =============================================================================
-- 0022 — Client projects: the studio's actual client work.
--
-- NOT public.projects. That table is the marketing site's research projects
-- (slug, essay_slug, published) and is rendered into /projects/<slug>/ by
-- tools/build-essays.js. This is the delivery work the workspace board shows:
-- Kept · Autumn release, Northline · Website, and so on.
--
-- Tasks gain a project_id so the board can roll up progress. That is an
-- additive column on a live table (5 rows at time of writing) and every
-- existing row keeps project_id null, which reads as "not filed under a
-- project" — the same thing it meant yesterday.
--
-- CAREFUL — tasks_guard_assignee_columns (0006) works by pinning every column
-- an assignee may NOT change. A new column it does not mention is therefore
-- writable by any assignee by default, so section 3 extends it. Adding a
-- column to public.tasks without touching that function silently widens what
-- a non-manager can do.
--
-- Idempotent. Adds only.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The projects themselves.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.client_projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company_id  uuid references public.crm_companies(id) on delete set null,
  code        text,                                  -- one or two chars for the board tile
  accent      text not null default 'default'
                check (accent in ('default','travel','client')),
  status      text not null default 'discovery'
                check (status in ('discovery','in_progress','in_review','completed','on_hold','cancelled')),
  description text,
  starts_on   date,
  due_on      date,
  completed_at timestamptz,
  budget      numeric(12,2),
  currency    text not null default 'USD',
  owner_id    uuid references public.employees(id) on delete set null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists client_projects_live_idx
  on public.client_projects (status, sort_order, due_on) where deleted_at is null;
create index if not exists client_projects_company_idx
  on public.client_projects (company_id) where deleted_at is null;

drop trigger if exists client_projects_touch_updated_at on public.client_projects;
create trigger client_projects_touch_updated_at
  before update on public.client_projects
  for each row execute function public.touch_updated_at();

drop trigger if exists guard_soft_delete on public.client_projects;
create trigger guard_soft_delete
  before update on public.client_projects
  for each row execute function public.guard_soft_delete();

alter table public.client_projects enable row level security;

drop policy if exists "staff read client_projects" on public.client_projects;
create policy "staff read client_projects"
  on public.client_projects for select using (public.is_staff());

drop policy if exists "staff creates client_projects" on public.client_projects;
create policy "staff creates client_projects"
  on public.client_projects for insert with check (public.is_staff());

drop policy if exists "staff updates client_projects" on public.client_projects;
create policy "staff updates client_projects"
  on public.client_projects for update
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "manager deletes client_projects" on public.client_projects;
create policy "manager deletes client_projects"
  on public.client_projects for delete using (public.is_manager());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. File tasks under a project.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists project_id uuid references public.client_projects(id) on delete set null;

create index if not exists tasks_project_idx on public.tasks (project_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Keep the assignee column guard honest (see the header).
--    Re-filing a task under a different project is a planning decision, not
--    progress, so it belongs with the manager-only columns.
-- ─────────────────────────────────────────────────────────────────────────────
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
  new.project_id  := old.project_id;  -- added 0022
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Progress, computed rather than stored.
--
--    A stored percentage drifts the moment a task changes underneath it. The
--    board reads this view instead. security_invoker so the caller's own RLS
--    on client_projects and tasks still applies — a view is otherwise owned by
--    the definer and would hand out rows the policies refuse.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.client_project_progress
with (security_invoker = true) as
select
  p.id,
  p.name,
  p.company_id,
  c.name                                                     as company_name,
  p.code,
  p.accent,
  p.status,
  p.description,
  p.due_on,
  p.owner_id,
  p.sort_order,
  count(t.id)                                                as task_count,
  count(t.id) filter (where t.status = 'done')               as tasks_done,
  case
    when count(t.id) = 0 then 0
    else round(100.0 * count(t.id) filter (where t.status = 'done') / count(t.id))
  end                                                        as progress
from public.client_projects p
left join public.crm_companies c on c.id = p.company_id and c.deleted_at is null
left join public.tasks t on t.project_id = p.id
where p.deleted_at is null
group by p.id, c.name;

comment on table public.client_projects is
  'The studio''s client delivery work. Distinct from public.projects, which is '
  'the marketing site''s research projects.';
comment on view public.client_project_progress is
  'Board rollup: each live client project with its task counts and a computed '
  'completion percentage. security_invoker, so RLS still applies.';
