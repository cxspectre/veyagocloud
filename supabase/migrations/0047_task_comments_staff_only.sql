-- 0047_task_comments_staff_only.sql — task comments are for staff.
--
-- 0017 meant "all staff can read, any staff member can post", and wrote it as
-- policies for any signed-in account: reading is using (true), and posting and
-- removing ask only who wrote the comment. Anyone signed in who is not on the
-- team — a colleague deactivated while their session still runs, say — could
-- read every internal comment on every task, post more, and remove their own.
--
-- Now:
--
--   1. A RESTRICTIVE policy, "staff only", on every command. It is ANDed with
--      the permissive policies, so it closes all of them to whoever is not
--      staff, and any added later. is_staff() rests on employee_role(), so a
--      session that still owes its second factor is not staff either (0040).
--   2. A comment is read where its task is. The read policy looks the task up
--      as the reader, under whatever rules tasks has: today (0005) every member
--      of staff sees the whole board, and if that ever narrows, comments follow.
--   3. Writing is as it was: you post as yourself and remove what you wrote; an
--      owner or admin removes anything. Nobody edits a comment.
--
-- The write policies keep their author checks and gain no staff check of their
-- own. A new row is checked against the permissive policies first, then the
-- restrictive ones in name order, and the first it fails is the error. So a
-- session that owes its code still hears "second factor required", which sorts
-- before "staff only" (supabase/tests/06-second-factor.sql checks for it), and
-- someone who is not staff hears "staff only". is_staff() in the insert policy
-- would turn both into a refusal that names no policy.
--
-- Read by admin/js/task.js only. Checked by supabase/tests/12-task-comments.sql.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. Staff only ────────────────────────────────────────────────────────
-- (select …) so the check runs once per statement rather than once per row.

drop policy if exists "staff only" on public.task_comments;
create policy "staff only"
  on public.task_comments as restrictive for all to authenticated
  using ((select public.is_staff()))
  with check ((select public.is_staff()));

-- ── 2. Read where the task can be read ───────────────────────────────────

drop policy if exists "staff read task comments" on public.task_comments;

drop policy if exists "staff read comments on tasks they can see" on public.task_comments;
create policy "staff read comments on tasks they can see"
  on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_comments.task_id));

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'task_comments'
                   and policyname = 'staff only' and permissive = 'RESTRICTIVE' and cmd = 'ALL'
                   and qual like '%is_staff%' and with_check like '%is_staff%') then
    raise exception '0047: task_comments is still open to people who are not staff';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'task_comments'
               and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
               and policyname <> 'staff read comments on tasks they can see') then
    raise exception '0047: another policy still lets people read every task comment';
  end if;
end
$$;
