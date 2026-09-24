-- =============================================================================
-- 0032 — Notes on a record.
--
-- The workspace shows a notes panel on tickets, projects, contacts and events.
-- It was an in-memory object that emptied on refresh, which is worse than not
-- offering it: someone writes down what a client asked for, reloads, and it is
-- gone.
--
-- ONE TABLE, NOT FOUR. A note is the same thing whatever it is attached to,
-- and a polymorphic (entity_type, entity_id) pair keeps it that way. The cost
-- is no foreign key — Postgres cannot reference four tables from one column —
-- so orphans are possible when a record is hard-deleted. That is the right
-- trade here: everything these notes hang off is SOFT-deleted (deleted_at), so
-- the row stays and the note stays with it. cleanup_orphan_notes() exists for
-- the rare hard delete.
--
-- Notes are visible to all staff. A studio of two does not need per-person
-- notes on a shared client record, and a note nobody else can see is a note
-- that gets written twice.
-- =============================================================================

create table if not exists public.workspace_notes (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('ticket','project','contact','company','event','task')),
  entity_id   uuid not null,
  author_id   uuid references public.employees(id) on delete set null,
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists workspace_notes_entity_idx
  on public.workspace_notes (entity_type, entity_id, created_at desc);

drop trigger if exists workspace_notes_touch_updated_at on public.workspace_notes;
create trigger workspace_notes_touch_updated_at
  before update on public.workspace_notes
  for each row execute function public.touch_updated_at();

alter table public.workspace_notes enable row level security;

drop policy if exists "staff read workspace_notes" on public.workspace_notes;
create policy "staff read workspace_notes"
  on public.workspace_notes for select using (public.is_staff());

-- Authorship is the caller's own employee row, never a colleague's — the same
-- shape as ticket_messages (0023) and task_comments (0017).
drop policy if exists "staff writes workspace_notes" on public.workspace_notes;
create policy "staff writes workspace_notes"
  on public.workspace_notes for insert
  with check (public.is_staff() and author_id = public.active_employee_id());

-- You may edit or remove what you wrote; a manager may remove anything. Nobody
-- edits someone else's note.
drop policy if exists "author edits own workspace_notes" on public.workspace_notes;
create policy "author edits own workspace_notes"
  on public.workspace_notes for update
  using (author_id = public.active_employee_id())
  with check (author_id = public.active_employee_id());

drop policy if exists "author or manager deletes workspace_notes" on public.workspace_notes;
create policy "author or manager deletes workspace_notes"
  on public.workspace_notes for delete
  using (author_id = public.active_employee_id() or public.is_manager());

-- ---------------------------------------------------------------------------
-- The orphan sweep the header mentions. Not scheduled — run it after a hard
-- delete, or never; it is cheap and it is honest about what it removes.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_orphan_notes()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare removed int;
begin
  if not public.is_manager() then
    raise exception 'Managers only';
  end if;
  with gone as (
    delete from public.workspace_notes n
    where (n.entity_type = 'ticket'  and not exists (select 1 from public.support_tickets t where t.id = n.entity_id))
       or (n.entity_type = 'project' and not exists (select 1 from public.client_projects p where p.id = n.entity_id))
       or (n.entity_type = 'contact' and not exists (select 1 from public.crm_contacts c where c.id = n.entity_id))
       or (n.entity_type = 'company' and not exists (select 1 from public.crm_companies c where c.id = n.entity_id))
       or (n.entity_type = 'event'   and not exists (select 1 from public.calendar_events e where e.id = n.entity_id))
       or (n.entity_type = 'task'    and not exists (select 1 from public.tasks t where t.id = n.entity_id))
    returning 1
  )
  select count(*) into removed from gone;
  return removed;
end;
$$;

revoke all on function public.cleanup_orphan_notes() from public, anon;
grant execute on function public.cleanup_orphan_notes() to authenticated;

comment on table public.workspace_notes is
  'Notes attached to any workspace record. Polymorphic (entity_type, entity_id) '
  'with no FK: everything it hangs off is soft-deleted, so the target survives. '
  'cleanup_orphan_notes() sweeps after a hard delete.';
