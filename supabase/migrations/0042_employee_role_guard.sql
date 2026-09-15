-- 0042_employee_role_guard.sql — who may change whose role.
--
-- The one write rule on employees, "manager writes employees" (0005), is FOR ALL
-- with nothing about roles in it. The audit (2026-09-14) found that any owner or
-- admin could, straight through the API:
--
--   * make themselves owner, or demote or deactivate the owner;
--   * delete the owner's row;
--   * point a row's user_id at their own sign-in, and so take over its role.
--
-- The admin's member page prevented some of this, in the browser only. The
-- database now prevents all of it:
--
--   1. Owners and admins may add and change employees; nobody deletes one
--      through the API. People are deactivated, and their history is kept.
--   2. A guard on every insert and update made as a signed-in person:
--        - nobody sets or changes user_id — an invitation links a sign-in;
--        - nobody changes their own role or status;
--        - only an owner creates an owner, makes someone one, or changes one.
--   3. For everyone, operators included: no change may leave the studio without
--      an owner who can sign in.
--   4. One row per address, whatever its case.
--
-- The service role (invite-employee), the table owner (migrations, the SQL
-- editor, the break-glass in 0007) and SECURITY DEFINER functions
-- (activate_self) write as other roles, so the guard in 2 lets them through.
-- invite-employee asks the same questions itself (_shared/team-rules.ts), and
-- activate_self only ever moves the caller's own row from invited to active.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. Add and change, never delete ─────────────────────────────────────

drop policy if exists "manager writes employees" on public.employees;

drop policy if exists "managers add employees" on public.employees;
create policy "managers add employees"
  on public.employees for insert to authenticated
  with check (public.is_manager());

drop policy if exists "managers change employees" on public.employees;
create policy "managers change employees"
  on public.employees for update to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- ── 2. What a signed-in person may change ───────────────────────────────

create or replace function public.employees_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- current_user is the role running the statement: authenticated or anon for
  -- the API, service_role for an Edge Function's admin client, the function's
  -- owner inside a SECURITY DEFINER function. Both of the API's roles are
  -- guarded: anon has no write policy here, and would be refused if it had.
  -- The service role writes for invite-employee. It may link a sign-in to a
  -- member who has none, never move a member onto a different one: that would
  -- hand their role, and their personal mailbox, to whoever holds the new
  -- sign-in (database review, 2026-09-14).
  if tg_op = 'UPDATE' and current_user = 'service_role'
     and old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'This team member already has a sign-in. Deactivate them and invite the new address.'
      using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.user_id is not null then
      raise exception 'Only an invitation links a sign-in to a team member.'
        using errcode = '42501';
    end if;
    if new.role = 'owner' and public.employee_role() is distinct from 'owner' then
      raise exception 'Only an owner can make someone an owner.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'Only an invitation links a sign-in to a team member.'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id then
    raise exception 'A team member''s id cannot change.' using errcode = '42501';
  end if;

  -- An invitation finds a member by their address. Changed on someone who can
  -- sign in, a re-invite to the new address would land on their row.
  if old.user_id is not null and new.email is distinct from old.email then
    raise exception 'The address of a team member who can sign in belongs to their sign-in.'
      using errcode = '42501';
  end if;

  if old.user_id = auth.uid()
     and (new.role is distinct from old.role or new.status is distinct from old.status) then
    raise exception 'Nobody can change their own role or status. Ask another owner or admin.'
      using errcode = '42501';
  end if;

  if (old.role = 'owner' or new.role = 'owner') and public.employee_role() is distinct from 'owner' then
    raise exception 'Only an owner can change an owner, or make someone one.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.employees_guard() is
  'Before insert or update on employees, for writes made as a signed-in person: '
  'nobody links a sign-in, nobody changes their own role or status, and only an '
  'owner creates, makes or changes an owner (0042).';

revoke all on function public.employees_guard() from public, anon, authenticated;

drop trigger if exists employees_guard on public.employees;
create trigger employees_guard
  before insert or update on public.employees
  for each row execute function public.employees_guard();

-- ── 3. Always an owner who can sign in ──────────────────────────────────
-- An owner who can sign in is what employee_role() calls an owner: a linked
-- sign-in, and a status that is not inactive. Like employee_role(), it does not
-- look into auth.users, so a banned account still counts; and deleting the last
-- owner's auth user fails ("Database error deleting user"), because unlinking
-- their row would leave no owner. Make someone else an owner first.
-- SECURITY DEFINER so the count
-- sees every row, whatever the caller may read. An AFTER trigger sees the whole
-- statement's changes, so demoting two owners at once is caught as well.

create or replace function public.employees_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'owner' and old.status <> 'inactive' and old.user_id is not null
     and (tg_op = 'DELETE'
          or not (new.role = 'owner' and new.status <> 'inactive' and new.user_id is not null)) then
    -- Two owners standing each other down at the same moment would each still
    -- see the other. One at a time: the second waits here for the first to
    -- commit, and the count below — a fresh snapshot in a volatile function —
    -- then sees what the first did.
    perform pg_advisory_xact_lock(hashtext('public.employees: an owner who can sign in'));
    -- A transaction at REPEATABLE READ or SERIALIZABLE would not see that
    -- commit. Locking the owners' rows makes it fail to serialise instead.
    -- (At READ COMMITTED — PostgREST, the SQL editor — the lock above is enough,
    -- and locking rows as well could deadlock two demotions.)
    if current_setting('transaction_isolation') <> 'read committed' then
      perform 1 from public.employees e
      where e.role = 'owner' and e.status <> 'inactive' and e.user_id is not null
      for update;
    end if;
    if not exists (select 1 from public.employees e
                   where e.role = 'owner' and e.status <> 'inactive' and e.user_id is not null) then
      raise exception 'The studio needs an owner who can sign in. Make someone else an owner first.'
        using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$;

comment on function public.employees_keep_an_owner() is
  'After update or delete on employees, for every role: refuses the change that '
  'would leave no owner who can sign in (0042).';

revoke all on function public.employees_keep_an_owner() from public, anon, authenticated;

drop trigger if exists employees_keep_an_owner on public.employees;
create trigger employees_keep_an_owner
  after update or delete on public.employees
  for each row execute function public.employees_keep_an_owner();

-- ── 4. One row per address, whatever its case ───────────────────────────
-- GoTrue treats addresses without case, but employees.email was unique byte
-- for byte: Ana@studio.com and ana@studio.com could be two rows, and a check
-- that looked the address up exactly could miss the first (security review,
-- 2026-09-14). Existing rows are not rewritten: two that clash stop this
-- migration, to be merged by a person.

do $$
begin
  if exists (select 1 from public.employees group by lower(email) having count(*) > 1) then
    raise exception '0042: two team members have the same address in different case. Merge them, then run this again.';
  end if;
end
$$;

create unique index if not exists employees_email_lower_idx on public.employees (lower(email));

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'employees'
               and permissive = 'PERMISSIVE' and cmd in ('ALL', 'DELETE')) then
    raise exception '0042: a permissive policy still lets someone delete employees';
  end if;

  if (select count(*) from pg_trigger
      where tgrelid = 'public.employees'::regclass and not tgisinternal
        and tgname in ('employees_guard', 'employees_keep_an_owner')) <> 2 then
    raise exception '0042: the employees triggers are missing';
  end if;

  if to_regclass('public.employees_email_lower_idx') is null then
    raise exception '0042: the index that keeps one row per address is missing';
  end if;

  if not exists (select 1 from public.employees
                 where role = 'owner' and status <> 'inactive' and user_id is not null) then
    raise exception '0042: the studio has no owner who can sign in. Add one first (the break-glass in 0007), then run this again.';
  end if;
end
$$;
