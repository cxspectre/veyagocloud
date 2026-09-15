-- 0040_second_factor_required.sql — a password alone is not a way in.
--
-- The admin and the workspace ask for a TOTP code when an account has a
-- verified second factor, but until now only the screens asked. The database
-- treated a session that skipped the code (aal1) exactly like one that entered
-- it (aal2): the workspace opened on a reload without the code, and every table
-- answered. A stolen password was enough.
--
-- The database now refuses such a session itself, twice over:
--
--   1. employee_role() and active_employee_id() answer null for a session that
--      still owes its code. Every workspace policy, every staff check
--      (is_staff(), is_manager(), can_read_connection(), can_manage_project()
--      …) and every Edge Function that asks rpc('is_staff') or
--      rpc('employee_role') is built on those two, so all of them now say
--      "not staff" to it.
--   2. A RESTRICTIVE policy, "second factor required", on every table in public
--      that has RLS, and on storage.objects. A restrictive policy is ANDed with
--      the permissive ones, so it also closes the policies that never ask for a
--      role: task_comments by author, a person's own mail attachments, a
--      publish request's requester.
--
-- An account WITHOUT a verified factor is unaffected at aal1 — the rule is
-- "enter the code if you have one", Supabase's own pattern — and an unverified
-- factor is an abandoned enrolment, not a factor. The service role bypasses RLS
-- and anon is not `authenticated`, so the syncs, the enquiry form and the
-- public site are untouched.
--
-- A table added later is covered by layer 1 through its policies, but layer 2
-- has to be added with it: supabase/tests/06-second-factor.sql fails while any
-- table in public has RLS without this policy, or any view runs as its owner.
--
-- Every CREATE POLICY holds its table's lock until the migration commits, and
-- every staff query reads employees. Push it when nobody is working.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── Has this session entered its second factor, if it has one? ───────────

create or replace function public.second_factor_met()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
           select 1
           from auth.mfa_factors f
           where f.user_id = auth.uid()
             and f.status = 'verified'
         );
$$;

revoke all on function public.second_factor_met() from public, anon;
grant execute on function public.second_factor_met() to authenticated, service_role;

comment on function public.second_factor_met() is
  'True when the session has entered its second factor (aal2), or the account '
  'has no verified factor to enter. SECURITY DEFINER only to read '
  'auth.mfa_factors. Behind every "second factor required" policy (0040); '
  'employee_role() and active_employee_id() apply the same rule inline.';

-- ── 1. No role and no employee id until the code is in ───────────────────
-- The bodies from 0005 and 0006, with the second factor added. The rule is
-- written out rather than calling second_factor_met(): most policies call these
-- two once per row, and a nested SECURITY DEFINER call per row is what costs.
-- An aal2 token answers before the factor lookup is reached.

create or replace function public.employee_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select e.role
  from public.employees e
  where e.user_id = auth.uid()
    and e.status <> 'inactive'
    and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
         or not exists (select 1 from auth.mfa_factors f
                        where f.user_id = e.user_id and f.status = 'verified'));
$$;

create or replace function public.active_employee_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.user_id = auth.uid()
    and e.status <> 'inactive'
    and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
         or not exists (select 1 from auth.mfa_factors f
                        where f.user_id = e.user_id and f.status = 'verified'));
$$;

-- is_manager() as 0013 left it answered null, not false, for a session with no
-- role — no employee row, a deactivated one, and from here one that still owes
-- its code — and "if not is_manager() then raise" does not raise on null.
-- cleanup_orphan_notes() let any such signed-in account through. It says false.
-- The same signature, grants and search_path as 0013.
create or replace function public.is_manager()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(public.employee_role() in ('owner', 'admin'), false);
$$;

-- The sweep after a hard delete (0032), for an owner or admin, and — like the
-- soft-delete and project-owner guards (0012, 0039) — for the SQL editor, which
-- has no auth.uid(). Now that is_manager() says false, the editor would
-- otherwise be refused too.
create or replace function public.cleanup_orphan_notes()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare removed int;
begin
  if auth.uid() is not null and not public.is_manager() then
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

-- ── 2. Every table, whatever its own policies allow ──────────────────────
-- (select …) so the check runs once per statement rather than once per row.
-- storage.objects first, so a busy bucket fails the migration before anything
-- else is held; employees last, because every staff query waits on it.

do $$
declare
  t record;
begin
  for t in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and c.relrowsecurity
      and (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
    order by (n.nspname = 'storage') desc, (c.relname = 'employees'), c.relname
  loop
    execute format('drop policy if exists %I on %I.%I',
                   'second factor required', t.schema_name, t.table_name);
    execute format(
      'create policy %I on %I.%I as restrictive for all to authenticated '
      'using ((select public.second_factor_met())) '
      'with check ((select public.second_factor_met()))',
      'second factor required', t.schema_name, t.table_name);
  end loop;
end
$$;

-- ── Prove it took, so a half-application cannot pass silently ────────────

do $$
declare
  missing text;
begin
  -- Fails the migration, rather than every staff query afterwards, if the
  -- function cannot read auth.mfa_factors here.
  perform public.second_factor_met();

  -- Here there is no session at all: no role, so no manager — false, not null.
  if public.is_manager() is not false then
    raise exception '0040: is_manager() answers % for a session with no role', coalesce(public.is_manager()::text, 'null');
  end if;

  select string_agg(n.nspname || '.' || c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and c.relrowsecurity
    and (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = n.nspname
        and p.tablename = c.relname
        and p.policyname = 'second factor required'
        and p.permissive = 'RESTRICTIVE'
        and p.qual like '%second_factor_met%'
        and p.with_check like '%second_factor_met%'
    );
  if missing is not null then
    raise exception '0040 did not reach: %', missing;
  end if;
end
$$;
