-- 0013 — finish what 0007 started.
--
-- 0007 was applied to this database by hand rather than by `db push`, and only
-- part of it landed. Confirmed against the live database on 2026-07-28:
--
--   pg_get_functiondef('public.is_manager()') like '%is_admin%'   ->  true
--   4 of 4 policies from 0012 present                             ->  ok
--   policy "staff writes media buckets" exists                    ->  ok
--
-- So the policies and storage grants are in place, but the three role helpers
-- were never redefined. 0007's own header claims "public.admins stops granting
-- anything", and it comments is_admin() as "Referenced by no policy since
-- migration 0007". Neither is true yet.
--
-- WHY THIS MATTERS. is_manager() gates finance, the employees table, publish
-- approvals (0011) and `manager deletes <content>` (0012). Anyone still on
-- public.admins therefore holds full manager rights at the DATABASE level,
-- while admin/js/roles.js no longer shows them a manager UI. The server grants
-- more than the client admits, which is the harder direction to notice: nothing
-- looks broken, it just quietly is not enforcing what it says.
--
-- WHY A NEW MIGRATION rather than re-running 0007: the history has been
-- repaired to mark 0007 applied, so it will never run again — and it must not.
-- Re-running it would recreate `staff writes <table> for all using (is_staff())`,
-- which RLS would OR with 0012's split policies, handing DELETE on every
-- article, wallpaper, app and announcement back to every employee. This file
-- takes only the section that is genuinely missing.
--
-- Idempotent: safe to run twice, and a no-op if 0007's section 3 somehow lands
-- by another route first.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Re-run 0007's backfill first.
--    Tightening is_manager() below removes the allowlist fallback, so anyone on
--    public.admins who never became an employee would lose access the moment it
--    takes effect. 0007 ran this, but its partial application means we cannot
--    assume — and all three steps are no-ops when the work is already done.
--    Copied verbatim from 0007 sections 1a-1c so the two cannot drift.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Link employee rows that match an auth user but never got user_id filled in.
update public.employees e
set user_id = u.id
from auth.users u
where e.user_id is null and lower(u.email) = lower(e.email);

-- 1b. Promote allowlist admins who ALREADY have an employees row.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Refuse to proceed if that would leave nobody in charge.
--    Same guard as 0007, for the same reason: a permissions migration that
--    locks every human out is worse than one that fails.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare n int;
begin
  select count(*) into n
  from public.employees
  where role in ('owner','admin') and status <> 'inactive' and user_id is not null;

  if n = 0 then
    raise exception
      'Refusing to finish 0007: no active owner or admin with a linked auth user. '
      'Insert one first — see the BREAK-GLASS block at the top of 0007.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The part that never landed: role helpers become purely role-based.
--    is_admin() is deliberately NOT consulted any more — that is the whole
--    point of 0007. Copied verbatim from its section 3.
-- ─────────────────────────────────────────────────────────────────────────────

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
  'LEGACY / BREAK-GLASS ONLY. Referenced by no policy since migration 0007 '
  '(whose helper redefinitions actually landed in 0013). employees.role is the '
  'single source of truth for permissions.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Prove it took, so a half-application cannot pass silently a second time.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if pg_get_functiondef('public.is_manager()'::regprocedure) like '%is_admin%' then
    raise exception 'is_manager() still consults is_admin() after 0013 — the redefinition did not take.';
  end if;
end $$;
