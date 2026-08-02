-- =============================================================================
-- Task comments: a threaded discussion on each task so decisions and context
-- stay attached to the work rather than living in Slack threads nobody finds.
--
-- RLS: all staff can read, any staff member can post, authors and managers
-- can delete (no editing — keeps the audit trail honest).
--
-- The email_log CHECK constraint is also extended here to include the new
-- task_comment kind, using the same drop-and-recreate pattern as 0015.
-- =============================================================================

create table if not exists public.task_comments (
  id         uuid        primary key default gen_random_uuid(),
  task_id    uuid        not null references public.tasks(id) on delete cascade,
  author_id  uuid        not null references auth.users(id),
  body       text        not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists task_comments_task_idx on public.task_comments(task_id, created_at);

alter table public.task_comments enable row level security;

create policy "staff read task comments"
  on public.task_comments for select
  to authenticated
  using (true);

create policy "staff create task comments"
  on public.task_comments for insert
  to authenticated
  with check (author_id = auth.uid());

create policy "authors or managers delete task comments"
  on public.task_comments for delete
  to authenticated
  using (author_id = auth.uid() or is_manager());

-- ── email_log kind extension ────────────────────────────────────────────────

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from   pg_constraint con
    join   pg_class      rel on rel.oid = con.conrelid
    join   pg_namespace  nsp on nsp.oid = rel.relnamespace
    where  con.contype = 'c'
    and    nsp.nspname = 'public'
    and    rel.relname = 'email_log'
    and    con.conname ilike '%kind%'
  loop
    execute format('alter table public.email_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_log add constraint email_log_kind_check
  check (kind in (
    'invite',
    'password_reset',
    'task_assigned',
    'task_done',
    'task_blocked',
    'task_updated',
    'task_comment',
    'digest',
    'publish_requested',
    'invoice'
  ));
