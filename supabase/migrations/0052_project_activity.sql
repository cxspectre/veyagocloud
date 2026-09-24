-- 0052_project_activity.sql — a project's own history.
--
-- workspace_activity (0027) records a few events across the workspace, but no
-- entry said which project it belonged to, so a project page could not show its
-- own history, and nothing recorded the work on a project: its tasks, its notes,
-- its files.
--
-- Now:
--
--   1. An entry names its project: workspace_activity.project_id, ON DELETE SET
--      NULL rather than cascade. An entry about a ticket or a task is that
--      record's history, and the studio's, as much as the project's; a project
--      deleted outright (rare: projects are archived, and one with files cannot
--      be deleted at all, 0039) should not take them with it. Its entries stay
--      in the feed, on no project.
--   2. An entry written without a project is given the one its record belongs
--      to (set_activity_project): a project is its own, a ticket or a task its
--      project's. So 0027's own entries carry their project without its
--      triggers being rewritten, and entries written before now are filed the
--      same way (backfill_activity_projects). A contact or company can be on
--      many projects and an invoice is on none, and nothing writes mail
--      entries, so those stay on none.
--   3. An index on (project_id, created_at desc), for a project's page.
--   4. New entries, in 0027's style:
--
--        a task on a project   added      created     New task · <title>
--                              done       completed   Completed task · <title>
--                              reopened   reopened    Reopened task · <title>
--                              deleted    deleted     Deleted task · <title>
--        a note on a project   added      created     New note · <project>
--                              deleted    deleted     Deleted note · <project>
--        a project's file      added      created     New file · <file name>
--                              removed    deleted     Removed file · <file name>
--
--      Sparse, as 0027 is. A task moved along without being finished, renamed
--      or re-filed writes nothing, and neither does a task under no project or
--      a note on anything but a project. A note's text is not copied into the
--      feed, where it would outlive the note.
--   5. A file's name is for its project's team (0039), while the feed is for all
--      staff. A file's entries are tagged 'team', and a RESTRICTIVE policy lets
--      only the team read a team entry: the project's members, its owner, and
--      owners and admins, as can_open_project_files() says. Once its project is
--      deleted outright, such an entry is for owners and admins alone.
--
-- 0027 does not guard a write against its entry failing, and neither does this:
-- an exception block per row is a subtransaction per row. Instead nothing here
-- can fail. Every verb, kind and audience is one the table's rules take, every
-- name copied is NOT NULL, and a note's project, which has no foreign key
-- (0032), is looked up rather than trusted: a note on a project that is gone,
-- as cleanup_orphan_notes() removes, writes nothing. The triggers stay cheap:
-- one insert per event, and one lookup by primary key for a note.
-- set_activity_project runs only for an entry about a project, ticket or task
-- written without a project.
--
-- 0041 does nothing with workspace_activity. Checked by
-- supabase/tests/17-project-activity.sql.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- Moving a project along holds the project, then writes its entry
-- (activity_from_project). Taking the locks in that order here means this
-- cannot deadlock with someone doing it.
--
-- The lock is taken inside a DO block. `supabase db push` sends a migration's
-- statements as one batch, with a single Sync and no BEGIN, which Postgres does
-- not count as a transaction block: a bare LOCK TABLE there is refused ("LOCK
-- TABLE can only be used in transaction blocks", 25P01) and the migration
-- stops. Inside the block it is not a top-level statement, and the lock is
-- held all the same, until the migration's transaction ends. The block after
-- it checks that it still is, so run outside one transaction this stops here,
-- before it changes anything, as the bare statement would have.
do $$
begin
  lock table public.client_projects in share row exclusive mode;
end
$$;

do $$
begin
  if not exists (select 1 from pg_locks l
                 where l.locktype = 'relation'
                   and l.relation = 'public.client_projects'::regclass
                   and l.pid = pg_backend_pid()
                   and l.mode = 'ShareRowExclusiveLock'
                   and l.granted) then
    raise exception '0052: run this migration in one transaction, as supabase db push does, so it holds client_projects until it ends'
      using errcode = '25P01';
  end if;
end
$$;

-- ── 1. An entry's project ────────────────────────────────────────────────
-- Each rule is dropped and added again, so a second run leaves it as written.

alter table public.workspace_activity
  add column if not exists project_id uuid references public.client_projects(id) on delete set null;

alter table public.workspace_activity
  drop constraint if exists workspace_activity_verb_check,
  add constraint workspace_activity_verb_check
    check (verb in ('created', 'updated', 'resolved', 'reopened', 'paid', 'commented', 'synced',
                    'completed', 'deleted')),
  drop constraint if exists workspace_activity_entity_type_check,
  add constraint workspace_activity_entity_type_check
    check (entity_type in ('ticket', 'project', 'contact', 'company', 'invoice', 'task', 'mail',
                           'note', 'file')),
  drop constraint if exists workspace_activity_visibility_check,
  add constraint workspace_activity_visibility_check
    check (visibility in ('staff', 'manager', 'team'));

create index if not exists workspace_activity_project_idx
  on public.workspace_activity (project_id, created_at desc);

comment on column public.workspace_activity.project_id is
  'The project the entry belongs to: the project itself, or the project of the ticket, task, '
  'note or file it is about. Set null when the project is deleted outright; the entry stays (0052).';

-- ── 2. The project an entry's record belongs to ──────────────────────────
-- Security invoker: set_activity_project calls it as the table owner, and the
-- backfill runs as the table owner too.

create or replace function public.activity_project_of(p_entity_type text, p_entity_id uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select case p_entity_type
           when 'project' then (select p.id from public.client_projects p where p.id = p_entity_id)
           when 'ticket'  then (select t.project_id from public.support_tickets t where t.id = p_entity_id)
           when 'task'    then (select t.project_id from public.tasks t where t.id = p_entity_id)
         end;
$$;

create or replace function public.set_activity_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.project_id := public.activity_project_of(new.entity_type, new.entity_id);
  return new;
end;
$$;

drop trigger if exists set_activity_project on public.workspace_activity;
create trigger set_activity_project
  before insert on public.workspace_activity
  for each row
  when (new.project_id is null and new.entity_type in ('project', 'ticket', 'task'))
  execute function public.set_activity_project();

-- Entries written before an entry had a project. Safe to run again: it fills
-- only what is still on no project and has a project to go to.
create or replace function public.backfill_activity_projects()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_filed integer;
begin
  update public.workspace_activity a
  set project_id = f.project_id
  from (select x.id, public.activity_project_of(x.entity_type, x.entity_id) as project_id
        from public.workspace_activity x
        where x.project_id is null
          and x.entity_type in ('project', 'ticket', 'task')) f
  where a.id = f.id
    and f.project_id is not null;
  get diagnostics v_filed = row_count;
  return v_filed;
end;
$$;

-- ── 3. What happens on a project ─────────────────────────────────────────
-- log_activity (0027) with the project given. Security invoker: it runs inside
-- the triggers below, which are SECURITY DEFINER, as 0027's are.

create or replace function public.log_project_activity(
  p_project     uuid,
  p_verb        text,
  p_entity_type text,
  p_entity_id   uuid,
  p_summary     text,
  p_visibility  text default 'staff'
)
returns void
language sql
set search_path = public
as $$
  insert into public.workspace_activity (actor_id, verb, entity_type, entity_id, summary, visibility, project_id)
  values (public.active_employee_id(), p_verb, p_entity_type, p_entity_id, p_summary, p_visibility, p_project);
$$;

-- A task on a project: added, done, reopened, deleted. A deleted task names its
-- project itself, since there is no task left to look it up by.
create or replace function public.activity_from_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.project_id is not null then
      perform public.log_project_activity(new.project_id, 'created', 'task', new.id,
        'New task · ' || new.title);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.project_id is not null and new.status is distinct from old.status then
      if new.status = 'done' then
        perform public.log_project_activity(new.project_id, 'completed', 'task', new.id,
          'Completed task · ' || new.title);
      elsif old.status = 'done' then
        perform public.log_project_activity(new.project_id, 'reopened', 'task', new.id,
          'Reopened task · ' || new.title);
      end if;
    end if;
  elsif old.project_id is not null then
    perform public.log_project_activity(old.project_id, 'deleted', 'task', old.id,
      'Deleted task · ' || old.title);
  end if;
  return null;                                  -- AFTER trigger: return value ignored
end;
$$;

drop trigger if exists activity_from_task on public.tasks;
create trigger activity_from_task
  after insert or update of status or delete on public.tasks
  for each row execute function public.activity_from_task();

-- A note on a project: added, deleted.
create or replace function public.activity_from_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    uuid;
  v_project uuid;
  v_name    text;
begin
  if tg_op = 'INSERT' then
    if new.entity_type <> 'project' then
      return null;
    end if;
    v_note := new.id;
    v_project := new.entity_id;
  else
    if old.entity_type <> 'project' then
      return null;
    end if;
    v_note := old.id;
    v_project := old.entity_id;
  end if;

  -- A note has no foreign key to its record (0032), so its project may be gone.
  select p.name into v_name from public.client_projects p where p.id = v_project;
  if not found then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_project_activity(v_project, 'created', 'note', v_note, 'New note · ' || v_name);
  else
    perform public.log_project_activity(v_project, 'deleted', 'note', v_note, 'Deleted note · ' || v_name);
  end if;
  return null;
end;
$$;

drop trigger if exists activity_from_note on public.workspace_notes;
create trigger activity_from_note
  after insert or delete on public.workspace_notes
  for each row execute function public.activity_from_note();

-- A project's file: added, removed. Its name is for the project's team, so the
-- entry is too.
create or replace function public.activity_from_project_file()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_project_activity(new.project_id, 'created', 'file', new.id,
      'New file · ' || new.name, 'team');
  else
    perform public.log_project_activity(old.project_id, 'deleted', 'file', old.id,
      'Removed file · ' || old.name, 'team');
  end if;
  return null;
end;
$$;

drop trigger if exists activity_from_project_file on public.project_files;
create trigger activity_from_project_file
  after insert or delete on public.project_files
  for each row execute function public.activity_from_project_file();

-- Called by the triggers as the table owner; no role needs them.
revoke all on function public.activity_project_of(text, uuid), public.set_activity_project(),
  public.backfill_activity_projects(), public.log_project_activity(uuid, text, text, uuid, text, text),
  public.activity_from_task(), public.activity_from_note(), public.activity_from_project_file()
  from public, anon, authenticated;

-- ── 4. A team entry is for the project's team ────────────────────────────
-- Restrictive, so it holds whatever the permissive policy ("read activity by
-- audience", 0027) or any added later lets staff read.

drop policy if exists "team entries are for the project team" on public.workspace_activity;
create policy "team entries are for the project team"
  on public.workspace_activity as restrictive for select to authenticated
  using (visibility <> 'team' or public.can_open_project_files(project_id));

comment on table public.workspace_activity is
  'Recent activity. Rows are tagged staff/manager/team: finance events are manager-only so '
  'the feed cannot undo the finance boundary, and a project file''s entries are for the '
  'project''s team. project_id files an entry under its project (0052).';

-- ── 5. Entries written before now ────────────────────────────────────────

do $$
declare
  v_filed integer := public.backfill_activity_projects();
begin
  raise notice '0052: % existing activity entries filed under their project', v_filed;
end
$$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
begin
  if not exists (select 1 from pg_constraint c
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                 where c.conrelid = 'public.workspace_activity'::regclass and c.contype = 'f'
                   and a.attname = 'project_id'
                   and c.confrelid = 'public.client_projects'::regclass
                   and c.confdeltype = 'n') then
    raise exception '0052: workspace_activity.project_id does not name a client project, set null when it goes';
  end if;

  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and tablename = 'workspace_activity'
                   and indexdef like '%(project_id, created_at DESC)') then
    raise exception '0052: a project''s history has no index';
  end if;

  -- One rule per column, taking the new values. An older rule under another
  -- name would refuse the new entries, and with them the writes they belong to.
  select string_agg(r.col, ', ') into v_missing
  from (values ('verb', array['completed', 'deleted']),
               ('entity_type', array['note', 'file']),
               ('visibility', array['team'])) as r(col, vals)
  where (select count(*) from pg_constraint c
         where c.conrelid = 'public.workspace_activity'::regclass and c.contype = 'c'
           and pg_get_constraintdef(c.oid) ~ ('\m' || r.col || '\M')) <> 1
     or exists (select 1 from unnest(r.vals) as v(val)
                where not exists (select 1 from pg_constraint c
                                  where c.conrelid = 'public.workspace_activity'::regclass and c.contype = 'c'
                                    and pg_get_constraintdef(c.oid) ~ ('\m' || r.col || '\M')
                                    and pg_get_constraintdef(c.oid) like ('%''' || v.val || '''%')));
  if v_missing is not null then
    raise exception '0052: the rules for % do not take the new entries', v_missing;
  end if;

  select string_agg(t.tbl || '.' || t.trg, ', ') into v_missing
  from (values ('tasks', 'activity_from_task'),
               ('workspace_notes', 'activity_from_note'),
               ('project_files', 'activity_from_project_file'),
               ('workspace_activity', 'set_activity_project')) as t(tbl, trg)
  where not exists (select 1 from pg_trigger g
                    where g.tgrelid = ('public.' || t.tbl)::regclass and g.tgname = t.trg
                      and not g.tgisinternal and g.tgenabled <> 'D');
  if v_missing is not null then
    raise exception '0052: missing triggers: %', v_missing;
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'workspace_activity'
                   and policyname = 'team entries are for the project team'
                   and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
                   and qual like '%can_open_project_files(project_id)%') then
    raise exception '0052: a file''s entries are not kept to its project''s team';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'workspace_activity'
                   and policyname = 'second factor required' and permissive = 'RESTRICTIVE') then
    raise exception '0052: the feed no longer requires the second factor';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'workspace_activity'
               and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) then
    raise exception '0052: a policy lets someone write the feed';
  end if;

  select string_agg(f.fn, ', ') into v_missing
  from unnest(array['public.log_project_activity(uuid, text, text, uuid, text, text)',
                    'public.activity_project_of(text, uuid)',
                    'public.backfill_activity_projects()']) as f(fn)
  where has_function_privilege('anon', f.fn, 'execute')
     or has_function_privilege('authenticated', f.fn, 'execute');
  if v_missing is not null then
    raise exception '0052: signed-in people can call %', v_missing;
  end if;

  if exists (select 1 from public.workspace_activity a
             where a.project_id is null
               and a.entity_type in ('project', 'ticket', 'task')
               and public.activity_project_of(a.entity_type, a.entity_id) is not null) then
    raise exception '0052: entries about a project''s records were left on no project';
  end if;
end
$$;
