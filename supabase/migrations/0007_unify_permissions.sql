-- =============================================================================
-- Veyago — one permission system.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.
--
-- THE PROBLEM THIS FIXES
-- Until now there were two disconnected permission systems:
--   • content    (articles, wallpapers, apps, projects, announcements, storage)
--                gated on public.admins via is_admin()
--   • operations (employees, onboarding, tasks, finance)
--                gated on employees.role via is_manager()
-- and is_manager() was defined as `is_admin() OR role in (owner,admin)`.
--
-- So the ONLY way to let an assistant write an article was to add them to
-- public.admins — which also made is_manager() true and handed them the bank
-- ledger, the invoices, and everyone's roles. There was no expressible middle.
--
-- THE FIX IS SUBTRACTION, NOT A BRIDGE. Adding a third helper (can_publish(),
-- is_content_editor(), …) would leave three systems to reason about. Instead:
-- employees.role becomes the single source of truth, every policy is repointed
-- at it, and public.admins stops granting anything.
--
--   staff   (owner, admin, assistant, employee) → content + company work
--   manager (owner, admin)                      → the above + finance + people
--
-- BREAK-GLASS: public.admins and is_admin() still exist but are referenced by
-- NO policy. If you ever lock yourself out, recover in the SQL editor with:
--   insert into public.employees (user_id, email, full_name, role, status)
--   values ('<your-auth-uid>', '<you@…>', '<Your Name>', 'owner', 'active')
--   on conflict (email) do update set role = 'owner', status = 'active',
--                                     user_id = excluded.user_id;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Backfill: every current allowlist admin becomes an owner employee.
--    Runs BEFORE any policy is repointed, so nobody loses access mid-migration.
-- ---------------------------------------------------------------------------
-- 1a. Link employee rows that match an auth user but never got user_id filled
--     in (invite accepted before the link was recorded). Do this first so the
--     match-by-user_id below sees them.
update public.employees e
set user_id = u.id
from auth.users u
where e.user_id is null and lower(u.email) = lower(e.email);

-- 1b. Promote allowlist admins who ALREADY have an employees row.
--     Matched on user_id or email; both columns are unique, so inserting
--     blindly could trip either constraint.
update public.employees e
set role   = case when e.role in ('owner','admin') then e.role else 'owner' end,
    status = 'active'
from public.admins a
left join auth.users u on u.id = a.user_id
where e.user_id = a.user_id
   or lower(e.email) = lower(coalesce(a.email, u.email, ''));

-- 1c. Insert allowlist admins who have no employees row at all.
insert into public.employees (user_id, email, full_name, role, status)
select a.user_id,
       coalesce(a.email, u.email, a.user_id::text),
       coalesce(u.raw_user_meta_data->>'full_name',
                split_part(coalesce(a.email, u.email, 'Owner'), '@', 1)),
       'owner',
       'active'
from public.admins a
left join auth.users u on u.id = a.user_id
where not exists (
  select 1 from public.employees e
  where e.user_id = a.user_id
     or lower(e.email) = lower(coalesce(a.email, u.email, ''))
);

-- ---------------------------------------------------------------------------
-- 2. Refuse to proceed if that would leave nobody in charge. Without this a
--    bad backfill silently locks every human out of finance and team admin.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from public.employees
  where role in ('owner','admin') and status <> 'inactive' and user_id is not null;

  if n = 0 then
    raise exception
      'Aborting: no active owner/admin with a linked auth user in public.employees. %',
      'Add yourself first (see BREAK-GLASS in this file), then re-run.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Role helpers become purely role-based. is_admin() is deliberately NOT
--    consulted any more — that is the whole point of this migration.
-- ---------------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.employee_role() is not null;
$$;

create or replace function public.is_manager()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.employee_role() in ('owner','admin');
$$;

comment on function public.is_admin() is
  'LEGACY / BREAK-GLASS ONLY. Referenced by no policy since migration 0007. '
  'employees.role is the single source of truth for permissions.';

-- ---------------------------------------------------------------------------
-- 4. Repoint every content policy from is_admin() to is_staff().
--    Anonymous read of published rows is unchanged — the public site depends
--    on it at build time.
-- ---------------------------------------------------------------------------
drop policy if exists "admin writes articles" on public.articles;
create policy "staff writes articles"
  on public.articles for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "admin writes wallpapers" on public.wallpapers;
create policy "staff writes wallpapers"
  on public.wallpapers for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "admin writes announcements" on public.site_announcements;
create policy "staff writes announcements"
  on public.site_announcements for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "admin writes apps" on public.apps;
create policy "staff writes apps"
  on public.apps for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "admin writes projects" on public.projects;
create policy "staff writes projects"
  on public.projects for all
  using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- 5. Storage: same repoint, so an assistant can actually upload the cover
--    image for the article they just wrote.
-- ---------------------------------------------------------------------------
drop policy if exists "admin writes media buckets" on storage.objects;
create policy "staff writes media buckets"
  on storage.objects for insert to authenticated
  with check (bucket_id in ('article-media', 'wallpapers') and public.is_staff());

drop policy if exists "admin updates media buckets" on storage.objects;
create policy "staff updates media buckets"
  on storage.objects for update to authenticated
  using (bucket_id in ('article-media', 'wallpapers') and public.is_staff())
  with check (bucket_id in ('article-media', 'wallpapers') and public.is_staff());

drop policy if exists "admin deletes media buckets" on storage.objects;
create policy "staff deletes media buckets"
  on storage.objects for delete to authenticated
  using (bucket_id in ('article-media', 'wallpapers') and public.is_staff());

-- ---------------------------------------------------------------------------
-- 6. public.admins is now inert. Keep the rows as a record, but only managers
--    may read it and nobody may write it from the browser.
-- ---------------------------------------------------------------------------
drop policy if exists "admin reads admins" on public.admins;
drop policy if exists "admin writes admins" on public.admins;
create policy "manager reads legacy admins"
  on public.admins for select
  using (public.is_manager());

-- ---------------------------------------------------------------------------
-- 7. An invited employee becomes active once they actually sign in and set a
--    password. Nothing flipped this before, so "Invites pending" counted up
--    forever.
--
--    This can't be a plain UPDATE from the browser: the only write policy on
--    employees is manager-only, and an assistant must not be able to edit their
--    own row in general. So it's a narrow SECURITY DEFINER function that can do
--    exactly one thing — flip the caller's own row from invited to active.
--    Called from admin/js/auth.js after the password is saved.
-- ---------------------------------------------------------------------------
create or replace function public.activate_self()
returns void
language sql
security definer
set search_path = public
as $$
  update public.employees
  set status = 'active'
  where user_id = auth.uid() and status = 'invited';
$$;

revoke all on function public.activate_self() from public;
grant execute on function public.activate_self() to authenticated;
