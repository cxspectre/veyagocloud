-- 0039_workspace_project_team.sql — who works on a project, who at the client
-- it is for, the files that belong to it, and what it may cost.
--
-- Decisions by the studio owner (2026-09-14):
--   * Project files are for the project's team: its members, its owner, and
--     owners/admins. Nobody else on staff can list, open or upload them.
--   * A project is for ONE company and any number of that company's contacts,
--     each with a role on the project.
--   * The budget is managers' business, like Finance. Any employee could read
--     client_projects.budget; it moves to project_budgets, which only owners
--     and admins can read or write.
--
-- Membership now opens files, so owning a project matters: a project's owner
-- runs its team. guard_project_owner stops anyone but a manager or the current
-- owner from changing who that is.
--
-- A stored file lives at <project id>/<upload id>/<file name> in the private
-- project-files bucket, and project_files holds one row per stored file. The
-- browser uploads first and records second; it removes the upload first and
-- the record second (see can_remove_project_file_path).

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── Members ──────────────────────────────────────────────────────────────

create table if not exists public.project_members (
  project_id  uuid not null references public.client_projects(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  added_by    uuid default public.active_employee_id()
                references public.employees(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (project_id, employee_id)
);

create index if not exists project_members_employee_idx
  on public.project_members (employee_id);

-- ── Who may do what on a project ─────────────────────────────────────────
-- security definer, so the policies below can call these without recursing
-- through the RLS of the tables they read.

-- Owners and admins, and the project's own owner.
create or replace function public.can_manage_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_manager()
      or exists (select 1 from public.client_projects p
                 where p.id = p_project
                   and p.owner_id = public.active_employee_id());
$$;

-- The above, and the project's members.
create or replace function public.can_open_project_files(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_manage_project(p_project)
      or exists (select 1 from public.project_members m
                 where m.project_id = p_project
                   and m.employee_id = public.active_employee_id());
$$;

-- Called from the policies of the signed-in role; nobody else needs them.
revoke all on function public.can_manage_project(uuid), public.can_open_project_files(uuid)
  from public, anon;
grant execute on function public.can_manage_project(uuid), public.can_open_project_files(uuid)
  to authenticated, service_role;

alter table public.project_members enable row level security;

drop policy if exists "staff read project members" on public.project_members;
create policy "staff read project members"
  on public.project_members for select to authenticated
  using (public.is_staff());

drop policy if exists "project leads add members" on public.project_members;
create policy "project leads add members"
  on public.project_members for insert to authenticated
  with check (public.can_manage_project(project_id));

drop policy if exists "project leads remove members, members leave" on public.project_members;
create policy "project leads remove members, members leave"
  on public.project_members for delete to authenticated
  using (public.can_manage_project(project_id)
         or employee_id = public.active_employee_id());

-- A membership is never edited, and who added it is the database's to say.
-- With column grants, write with insert and delete: PostgREST's upsert also
-- updates the conflict key, which is not granted, and fails.
revoke insert, update on public.project_members from anon, authenticated;
grant insert (project_id, employee_id) on public.project_members to authenticated;

-- ── Owning a project ─────────────────────────────────────────────────────

create or replace function public.guard_project_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role (jobs, the dashboard) has no auth.uid().
  if auth.uid() is null then
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id
     and not public.is_manager()
     and old.owner_id is distinct from public.active_employee_id() then
    raise exception 'Only an owner or admin, or the project''s owner, can change who owns it';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_project_owner on public.client_projects;
create trigger guard_project_owner
  before update of owner_id on public.client_projects
  for each row execute function public.guard_project_owner();

-- A project's id is the database's to choose. One chosen by a person could be
-- a deleted project's, and with it the owner's say over whatever of that
-- project is left in storage. completed_at is the database's too
-- (stamp_project_completed). The workspace sends none of these.
revoke insert, update on public.client_projects from anon, authenticated;
grant insert (name, company_id, code, accent, status, description, starts_on, due_on, owner_id, sort_order)
  on public.client_projects to authenticated;
grant update (name, company_id, code, accent, status, description, starts_on, due_on, owner_id, sort_order, deleted_at)
  on public.client_projects to authenticated;

-- ── The client's people ──────────────────────────────────────────────────

create table if not exists public.project_contacts (
  project_id uuid not null references public.client_projects(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  role       text not null default 'day_to_day'
               check (role in ('decision_maker','billing','day_to_day','technical','other')),
  added_by   uuid default public.active_employee_id()
               references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, contact_id)
);

create index if not exists project_contacts_contact_idx
  on public.project_contacts (contact_id);

-- A project's contacts work at the project's company.
create or replace function public.check_project_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_contact public.crm_contacts%rowtype;
begin
  select company_id into v_company from public.client_projects where id = new.project_id;
  select * into v_contact from public.crm_contacts where id = new.contact_id;
  if v_company is null then
    raise exception 'Link the project to a company before adding its contacts';
  end if;
  if v_contact.id is null or v_contact.deleted_at is not null then
    raise exception 'That contact is not in the CRM';
  end if;
  if v_contact.company_id is distinct from v_company then
    raise exception 'That contact does not work at the project''s company';
  end if;
  return new;
end;
$$;

drop trigger if exists check_project_contact on public.project_contacts;
create trigger check_project_contact
  before insert or update of project_id, contact_id on public.project_contacts
  for each row execute function public.check_project_contact();

-- A project that changes company, or a contact who moves to another company,
-- keeps only the links that are still true.
create or replace function public.prune_project_contacts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'client_projects' then
    delete from public.project_contacts pc
    using public.crm_contacts c
    where pc.project_id = new.id
      and c.id = pc.contact_id
      and c.company_id is distinct from new.company_id;
  else
    delete from public.project_contacts pc
    using public.client_projects p
    where pc.contact_id = new.id
      and p.id = pc.project_id
      and p.company_id is distinct from new.company_id;
  end if;
  return null;
end;
$$;

drop trigger if exists prune_project_contacts on public.client_projects;
create trigger prune_project_contacts
  after update of company_id on public.client_projects
  for each row when (new.company_id is distinct from old.company_id)
  execute function public.prune_project_contacts();

drop trigger if exists prune_project_contacts on public.crm_contacts;
create trigger prune_project_contacts
  after update of company_id on public.crm_contacts
  for each row when (new.company_id is distinct from old.company_id)
  execute function public.prune_project_contacts();

alter table public.project_contacts enable row level security;

drop policy if exists "staff read project contacts" on public.project_contacts;
create policy "staff read project contacts"
  on public.project_contacts for select to authenticated
  using (public.is_staff());

drop policy if exists "staff add project contacts" on public.project_contacts;
create policy "staff add project contacts"
  on public.project_contacts for insert to authenticated
  with check (public.is_staff());

drop policy if exists "staff change a project contact's role" on public.project_contacts;
create policy "staff change a project contact's role"
  on public.project_contacts for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff remove project contacts" on public.project_contacts;
create policy "staff remove project contacts"
  on public.project_contacts for delete to authenticated
  using (public.is_staff());

-- Only the role changes after the fact. Changing the person is a remove and
-- an add, which goes through check_project_contact again.
revoke insert, update on public.project_contacts from anon, authenticated;
grant insert (project_id, contact_id, role), update (role)
  on public.project_contacts to authenticated;

-- ── Files ────────────────────────────────────────────────────────────────

create table if not exists public.project_files (
  id           uuid primary key default gen_random_uuid(),
  -- A project with files is archived, not deleted: deleted outright, its
  -- uploads would stay in storage with nothing left to say whose they are.
  project_id   uuid not null references public.client_projects(id) on delete restrict,
  storage_path text not null unique,
  name         text not null check (length(trim(name)) between 1 and 255),
  size_bytes   bigint not null check (size_bytes > 0),
  content_type text not null default 'application/octet-stream',
  uploaded_by  uuid default public.active_employee_id()
                 references public.employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint project_files_in_their_project
    check (split_part(storage_path, '/', 1) = project_id::text)
);

create index if not exists project_files_project_idx
  on public.project_files (project_id, created_at desc);

-- A record is written after its upload, by whoever uploaded it, and describes
-- what was stored rather than what the browser said it stored.
create or replace function public.check_project_file()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb;
  v_uploader text;
begin
  select o.metadata, coalesce(o.owner_id, o.owner::text) into v_meta, v_uploader
  from storage.objects o
  where o.bucket_id = 'project-files' and o.name = new.storage_path;
  if not found then
    raise exception 'That file has not finished uploading';
  end if;
  -- Service role (jobs, the dashboard) has no auth.uid().
  if auth.uid() is not null and v_uploader is distinct from auth.uid()::text then
    raise exception 'Only whoever uploaded a file can record it';
  end if;
  new.size_bytes   := coalesce((v_meta->>'size')::bigint, new.size_bytes);
  new.content_type := coalesce(nullif(v_meta->>'mimetype', ''), new.content_type);
  return new;
end;
$$;

drop trigger if exists check_project_file on public.project_files;
create trigger check_project_file
  before insert on public.project_files
  for each row execute function public.check_project_file();

-- Storage paths start with the project's id. Compared as text, so a folder
-- that is not a uuid is simply no project rather than a cast error.
create or replace function public.can_open_project_file_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.client_projects p
                 where p.id::text = split_part(p_path, '/', 1)
                   and public.can_open_project_files(p.id));
$$;

-- Removing a stored file: whoever manages the project, or whoever uploaded it.
-- An upload whose record never saved may be cleared by anyone who could have
-- uploaded it, so a failed upload does not have to wait for a manager.
create or replace function public.can_remove_project_file_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_open_project_file_path(p_path)
     and (not exists (select 1 from public.project_files f where f.storage_path = p_path)
          or exists (select 1 from public.project_files f
                     where f.storage_path = p_path
                       and (public.can_manage_project(f.project_id)
                            or f.uploaded_by = public.active_employee_id())));
$$;

revoke all on function public.can_open_project_file_path(text), public.can_remove_project_file_path(text)
  from public, anon;
grant execute on function public.can_open_project_file_path(text), public.can_remove_project_file_path(text)
  to authenticated, service_role;

alter table public.project_files enable row level security;

drop policy if exists "project team reads file records" on public.project_files;
create policy "project team reads file records"
  on public.project_files for select to authenticated
  using (public.can_open_project_files(project_id));

drop policy if exists "project team records uploads" on public.project_files;
create policy "project team records uploads"
  on public.project_files for insert to authenticated
  with check (public.can_open_project_files(project_id));

drop policy if exists "project leads or uploader remove file records" on public.project_files;
create policy "project leads or uploader remove file records"
  on public.project_files for delete to authenticated
  using (public.can_open_project_files(project_id)
         and (public.can_manage_project(project_id)
              or uploaded_by = public.active_employee_id()));

revoke insert, update on public.project_files from anon, authenticated;
grant insert (project_id, storage_path, name, size_bytes, content_type)
  on public.project_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "project team uploads project files" on storage.objects;
create policy "project team uploads project files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'project-files'
    and public.is_staff()
    and public.can_open_project_file_path(name)
  );

drop policy if exists "project team reads project files" on storage.objects;
create policy "project team reads project files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'project-files'
    and public.can_open_project_file_path(name)
  );

drop policy if exists "project team removes project files" on storage.objects;
create policy "project team removes project files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'project-files'
    and public.can_remove_project_file_path(name)
  );

-- ── Budget: owners and admins only ───────────────────────────────────────

create table if not exists public.project_budgets (
  project_id uuid primary key references public.client_projects(id) on delete cascade,
  amount     numeric(12,2) not null check (amount >= 0),
  currency   text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  updated_by uuid references public.employees(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function public.stamp_project_budget()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := public.active_employee_id();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_project_budget on public.project_budgets;
create trigger stamp_project_budget
  before insert or update on public.project_budgets
  for each row execute function public.stamp_project_budget();

alter table public.project_budgets enable row level security;

drop policy if exists "managers read project budgets" on public.project_budgets;
create policy "managers read project budgets"
  on public.project_budgets for select to authenticated
  using (public.is_manager());

drop policy if exists "managers set project budgets" on public.project_budgets;
create policy "managers set project budgets"
  on public.project_budgets for insert to authenticated
  with check (public.is_manager());

drop policy if exists "managers change project budgets" on public.project_budgets;
create policy "managers change project budgets"
  on public.project_budgets for update to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "managers remove project budgets" on public.project_budgets;
create policy "managers remove project budgets"
  on public.project_budgets for delete to authenticated
  using (public.is_manager());

-- Set with insert, changed with update, cleared with delete: PostgREST's
-- upsert also updates the conflict key, which is not granted, and fails.
revoke insert, update on public.project_budgets from anon, authenticated;
grant insert (project_id, amount, currency), update (amount, currency)
  on public.project_budgets to authenticated;

-- Existing budgets move across before the columns everyone could read go —
-- inside a DO block, so the migration can run again once the column is gone.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'client_projects'
               and column_name = 'budget') then
    insert into public.project_budgets (project_id, amount, currency)
    select id, budget, case when currency ~ '^[A-Z]{3}$' then currency else 'USD' end
    from public.client_projects
    where budget is not null
    on conflict (project_id) do nothing;
  end if;
end $$;

alter table public.client_projects
  drop column if exists budget,
  drop column if exists currency;

-- ── The board's view: when a project starts and when it was finished ─────
-- New columns go last: create or replace view cannot move existing ones.

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
  end                                                        as progress,
  p.starts_on,
  p.completed_at
from public.client_projects p
left join public.crm_companies c on c.id = p.company_id and c.deleted_at is null
left join public.tasks t on t.project_id = p.id
where p.deleted_at is null
group by p.id, c.name;

-- ── When a project was finished ──────────────────────────────────────────

create or replace function public.stamp_project_completed()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'completed' then
    if tg_op = 'INSERT' or old.status is distinct from 'completed' then
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_project_completed on public.client_projects;
create trigger stamp_project_completed
  before insert or update of status, completed_at on public.client_projects
  for each row execute function public.stamp_project_completed();

-- Projects finished before this migration: their last change is the best
-- record there is, so the touch trigger is kept from moving it to today.
alter table public.client_projects disable trigger client_projects_touch_updated_at;
update public.client_projects
set completed_at = updated_at
where status = 'completed' and completed_at is null;
alter table public.client_projects enable trigger client_projects_touch_updated_at;

-- ── A project's tickets ──────────────────────────────────────────────────

create index if not exists support_tickets_project_idx
  on public.support_tickets (project_id)
  where project_id is not null;

-- ── Functions nobody calls directly ──────────────────────────────────────
-- These run as triggers; no role needs to call them.
revoke all on function public.guard_project_owner(), public.check_project_contact(),
  public.prune_project_contacts(), public.check_project_file(),
  public.stamp_project_budget(), public.stamp_project_completed()
  from public, anon, authenticated;
