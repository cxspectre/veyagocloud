-- 0043_employee_private_details.sql — a colleague's phone and notes are not
-- everyone's.
--
-- "staff read employees" (0005) lets every member of staff read every column of
-- every employee, phone and notes included, and the admin's member page says so
-- under the notes: "Everyone on the team can read these". A team directory needs
-- names, roles and titles — not how to reach someone at home.
--
-- Signed-in people now read every column of employees except phone and notes.
-- employee_private(id) answers for those two: the phone number to owners, admins
-- and the person themself, the notes to owners and admins only.
--
-- Only the admin's member page reads either, and it asks employee_private() from
-- now on. Every other query names its columns — the workspace, the admin and the
-- Edge Functions — so none of them changes. A column added to employees later
-- cannot be read through the API until it is added to the grant below.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

revoke select on public.employees from anon, authenticated;
grant select (id, user_id, email, full_name, role, title, status, start_date, created_at, updated_at)
  on public.employees to authenticated;

create or replace function public.employee_private(p_employee_id uuid)
returns table (phone text, notes text)
language sql
stable
security definer
set search_path = public
as $$
  select e.phone,
         case when public.is_manager() then e.notes end
  from public.employees e
  where e.id = p_employee_id
    and (public.is_manager() or e.id = public.active_employee_id());
$$;

revoke all on function public.employee_private(uuid) from public, anon;
grant execute on function public.employee_private(uuid) to authenticated;

comment on function public.employee_private(uuid) is
  'A team member''s phone and notes, which signed-in people cannot select from '
  'employees: the phone to owners, admins and the person themself, the notes to '
  'owners and admins only. No row for anyone else (0043).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if has_column_privilege('authenticated', 'public.employees', 'phone', 'select')
     or has_column_privilege('authenticated', 'public.employees', 'notes', 'select') then
    raise exception '0043: signed-in people can still read phone or notes';
  end if;
  if not has_column_privilege('authenticated', 'public.employees', 'full_name', 'select') then
    raise exception '0043: signed-in people can no longer read the team directory';
  end if;
end
$$;
