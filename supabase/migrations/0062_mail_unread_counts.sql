-- =============================================================================
-- 0062 — The true unread count for a person's own mailboxes.
--
-- Found in the workspace audit (2026-09-16, wave 2): the Mail nav badge, the
-- bell's "N unread conversations" and every mailbox's own badge all count
-- mail-model.js's unreadCount() over whatever mailThreads() happened to load
-- — 200 threads per folder, per mailbox (queries.js). A busy inbox with an
-- unread message past that cut shows a badge that is simply wrong, with
-- nothing on screen saying so — mailModel.unreadCountInfo()'s own `atLeast`
-- flag already says "this is a floor, not the true number" for exactly that
-- reason, because there was no way to ask the database for the real one.
--
-- mail_unread_counts() is that way to ask: one row per mailbox, a real
-- count(*) of its unread inbox threads, for every mailbox this session may
-- read. It is `security invoker`, on purpose, rather than `security definer`
-- with its own copy of the visibility rule: mail_threads' own policy ("read
-- own mailbox threads", can_read_connection(), 0025) already limits a plain
-- SELECT to the studio's mailboxes and this person's own, which is exactly
-- what mailThreads() itself is limited to — so this counts under the SAME
-- rule, rather than a second one that could quietly drift out of step with
-- it. A session that still owes its second factor sees nothing:
-- can_read_connection() calls is_staff(), which calls employee_role(), which
-- 0040 makes answer null (read as false by is_staff()'s own coalesce) until
-- the code is in — the same gate mailThreads() is already behind.
--
-- "Unread" here means exactly what the reading pane already means by it:
-- mail_threads.is_read, kept current by refresh_mail_thread_state() (0038) —
-- false while any inbound message in the thread has not been read, true once
-- every one has. Nothing new is computed or guessed at; this only counts a
-- column mailThreads() was already reading one row at a time. A thread
-- starred but filed away in Outlook (0045: folder archive/spam/trash) is not
-- counted, matching mailModel.unreadCount()'s own rule that unread means
-- unread IN THE INBOX — a sent or filed thread is not waiting for anyone.
--
-- Idempotent. Adds only.
-- =============================================================================

create or replace function public.mail_unread_counts()
returns table (connection_id uuid, unread_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  select t.connection_id, count(*)::integer as unread_count
  from public.mail_threads t
  where t.folder = 'inbox' and t.is_read = false
  group by t.connection_id;
$$;

revoke all on function public.mail_unread_counts() from public, anon;
grant execute on function public.mail_unread_counts() to authenticated;

comment on function public.mail_unread_counts() is
  'One row per mailbox: a real count() of its unread inbox threads, for '
  'every mailbox this session may read. security invoker, so mail_threads'' '
  'own RLS (can_read_connection(), 0025) does the filtering — the same rule '
  'mailThreads() itself reads under, never duplicated here, so the two '
  'cannot drift apart. Anon, and a session that still owes its second '
  'factor, get no rows — the same answer reading mail_threads directly '
  'would give them.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it took.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mail_unread_counts'
  ) then
    raise exception '0062: mail_unread_counts() is missing';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mail_unread_counts' and p.prosecdef
  ) then
    raise exception '0062: mail_unread_counts() must stay security invoker — it relies on mail_threads'' own RLS rather than a rule of its own, and security definer would bypass it';
  end if;
  if has_function_privilege('anon', 'public.mail_unread_counts()', 'execute') then
    raise exception '0062: anon can call mail_unread_counts()';
  end if;
  if not has_function_privilege('authenticated', 'public.mail_unread_counts()', 'execute') then
    raise exception '0062: mail_unread_counts() is not callable by a signed-in session';
  end if;
end
$$;
