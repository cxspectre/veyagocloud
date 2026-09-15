-- 0058_project_milestones_and_time.sql — milestones and logged time, the two
-- items left over from the Projects area's "everything a project needs" list
-- that need no front-end wiring yet.
--
-- Two small, independent tables:
--
--   1. project_milestones — a project's own checkpoints (a name and a due
--      date, marked reached or not). No sort_order: the audit's own finding
--      about client_projects (ordered by a sort_order nobody ever set, so a
--      reload could reshuffle the whole list) is the lesson here — a
--      milestone list orders by due date, tie-broken by when it was added,
--      which needs nobody to set anything by hand and can never go stale.
--
--      Read by any staff member, the same openness client_projects' own
--      "staff read client_projects" policy already gives the project itself
--      (0022) — a milestone is part of a project's own shape, not something
--      narrower like its files (0039: team only) or its budget (managers
--      only). Written only by whoever can manage the project
--      (can_manage_project, 0039: owners, admins, or the project's own
--      owner) — the same bar as adding or removing its team or its client's
--      people.
--
--      A column for "which task this milestone is" was asked for too, but
--      not added here: tasks_guard_assignee_columns (0006, extended by
--      0022 and 0050) pins the exact list of columns a non-manager may
--      touch on public.tasks, and a new column on that table is writable by
--      any assignee by default unless that function is also extended — 0006
--      and 0050 are the task guard's own migrations, in another session's
--      hands this round (see docs/README's session split). Left as a
--      follow-up once that trigger can be touched: a nullable
--      tasks.milestone_id referencing project_milestones(id) on delete set
--      null, added to both guards' column lists so a non-manager assignee
--      still cannot re-file a task under a different milestone, the same
--      way they cannot re-file one under a different project today.
--
--   2. time_entries — a day's minutes logged against a project, optionally
--      against one task in it, by one person, billable or not. Read by the
--      person whose time it is, or by whoever manages the project (their own
--      timesheet, or a project's whole logged time) — not staff-wide: this
--      is closer to a project's budget than to its status, and the studio's
--      own decision on budgets (0039: "managers' business, like Finance")
--      is the closest precedent for "who logged how long on what". Written
--      by the person it is about, on a project they can at least open the
--      files of (can_open_project_files, 0039: its team, its owner, or a
--      manager) — logging time against a project you have no other standing
--      on would be a data-entry mistake nothing here can tell from a real
--      one, so it is refused the same way uploading a file to it would be.
--      A manager may also correct anyone's entry on a project they manage.
--
--      Not enforced here, and documented rather than guarded: a task_id
--      belonging to a different project than the entry's own project_id.
--      Catching that needs a trigger cross-checking two tables, which is
--      more machinery than a first cut of time tracking needs; a mismatched
--      pair is a reporting nuisance, not a security question, since the
--      project_id itself still governs who may read or write the row.
--
-- Idempotent. Adds only.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── Milestones ───────────────────────────────────────────────────────────

create table if not exists public.project_milestones (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.client_projects(id) on delete cascade,
  name         text not null check (char_length(trim(name)) between 1 and 200),
  due_on       date,
  completed_at timestamptz,
  created_by   uuid default public.active_employee_id()
                 references public.employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A project's milestones, soonest due first — the list's own order, so no
-- query needs an expensive sort at read time.
create index if not exists project_milestones_project_idx
  on public.project_milestones (project_id, due_on);

drop trigger if exists project_milestones_touch_updated_at on public.project_milestones;
create trigger project_milestones_touch_updated_at
  before update on public.project_milestones
  for each row execute function public.touch_updated_at();

alter table public.project_milestones enable row level security;

drop policy if exists "staff read project milestones" on public.project_milestones;
create policy "staff read project milestones"
  on public.project_milestones for select to authenticated
  using (public.is_staff());

drop policy if exists "project leads add milestones" on public.project_milestones;
create policy "project leads add milestones"
  on public.project_milestones for insert to authenticated
  with check (public.can_manage_project(project_id));

drop policy if exists "project leads change milestones" on public.project_milestones;
create policy "project leads change milestones"
  on public.project_milestones for update to authenticated
  using (public.can_manage_project(project_id))
  with check (public.can_manage_project(project_id));

drop policy if exists "project leads remove milestones" on public.project_milestones;
create policy "project leads remove milestones"
  on public.project_milestones for delete to authenticated
  using (public.can_manage_project(project_id));

-- Column grants: id, created_by, created_at and updated_at are the
-- database's to set, never the caller's — the same shape client_projects'
-- own grants take (0039) for the columns nobody may pick or backdate.
revoke insert, update on public.project_milestones from anon, authenticated;
grant insert (project_id, name, due_on, completed_at) on public.project_milestones to authenticated;
grant update (name, due_on, completed_at) on public.project_milestones to authenticated;

comment on table public.project_milestones is
  'A project''s own checkpoints: a name, a due date, and when it was reached. '
  'Read by any staff member, like the project itself; written by whoever can '
  'manage the project. No sort_order — ordered by due date, tie-broken by id.';

-- ── Time tracking ────────────────────────────────────────────────────────

create table if not exists public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.client_projects(id) on delete cascade,
  task_id     uuid references public.tasks(id) on delete set null,
  -- Nullable, like workspace_notes.author_id (0032) and client_projects.owner_id
  -- (0022): an employee row is deactivated, never hard-deleted, in the way this
  -- app is used, but a time entry should not vanish or block that deactivation
  -- if one ever is.
  employee_id uuid references public.employees(id) on delete set null,
  day         date not null,
  minutes     integer not null check (minutes > 0 and minutes <= 1440),
  billable    boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists time_entries_project_idx on public.time_entries (project_id, day);
create index if not exists time_entries_employee_idx on public.time_entries (employee_id, day);

drop trigger if exists time_entries_touch_updated_at on public.time_entries;
create trigger time_entries_touch_updated_at
  before update on public.time_entries
  for each row execute function public.touch_updated_at();

alter table public.time_entries enable row level security;

-- A person's own logged time, on any project; a project's lead or a manager
-- sees everyone's on that project. Not staff-wide: logged hours are closer
-- to a project's budget than to its status (see this file's header).
drop policy if exists "own or managed time entries read" on public.time_entries;
create policy "own or managed time entries read"
  on public.time_entries for select to authenticated
  using (employee_id = public.active_employee_id() or public.can_manage_project(project_id));

-- Logging time against a project needs some real standing on it — its team,
-- its owner, or a manager (can_open_project_files, the same bar a file
-- upload clears) — and only ever for yourself.
drop policy if exists "team logs their own time" on public.time_entries;
create policy "team logs their own time"
  on public.time_entries for insert to authenticated
  with check (employee_id = public.active_employee_id() and public.can_open_project_files(project_id));

-- Correcting your own mistyped entry, or a manager fixing anyone's.
drop policy if exists "own or managed time entries change" on public.time_entries;
create policy "own or managed time entries change"
  on public.time_entries for update to authenticated
  using (employee_id = public.active_employee_id() or public.can_manage_project(project_id))
  with check (employee_id = public.active_employee_id() or public.can_manage_project(project_id));

drop policy if exists "own or managed time entries remove" on public.time_entries;
create policy "own or managed time entries remove"
  on public.time_entries for delete to authenticated
  using (employee_id = public.active_employee_id() or public.can_manage_project(project_id));

-- id, employee_id's own default (none here — sent explicitly, like
-- project_members.employee_id) aside, created_at and updated_at are the
-- database's; project_id and employee_id are never in the update list, so
-- correcting an entry can change what it says, never whose it is or which
-- project it is on — the same restraint project_contacts' own grants take
-- (0039: update(role) only, never the pair that names the link).
revoke insert, update on public.time_entries from anon, authenticated;
grant insert (project_id, task_id, employee_id, day, minutes, billable) on public.time_entries to authenticated;
grant update (task_id, day, minutes, billable) on public.time_entries to authenticated;

comment on table public.time_entries is
  'Minutes logged against a project, and optionally one task in it, by one '
  'person on one day, billable or not. Read by that person or the project''s '
  'lead; written by that person only, on a project they have real standing on.';
