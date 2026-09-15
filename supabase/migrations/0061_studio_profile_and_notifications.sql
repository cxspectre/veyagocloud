-- 0061_studio_profile_and_notifications.sql — a studio profile staff can read,
-- and somewhere to remember a notification was seen.
--
-- Found in the Company/Overview audit (2026-09-14):
--
--   1. workspace.js writes the studio's name, tagline, location and contact
--      straight into the page. The real answer lives in workspace_settings
--      (0016), but "managers read settings" is is_manager() only — the whole
--      table, because it also holds bank remittance details, which is exactly
--      why nobody broadened that policy for a directory fact like the studio's
--      name. A SECURITY DEFINER function, on the employee_private() model,
--      answers a small named allowlist to any signed-in member of staff and
--      nothing else from the table — the row grant on workspace_settings itself
--      is untouched, so bank details stay manager-only. Writing a profile field
--      already works: 0016's "managers insert/update settings" policies do not
--      discriminate by key, so an owner or admin can already save one through
--      the same upsert the workspace uses for any other setting.
--
--   2. The bell (shellModel.attention()) lists what needs someone but has no
--      way to remember that a person has seen one — every open urgent ticket,
--      every outstanding invoice, today's events, are read out again at every
--      visit. A table to hold "this person dismissed this one" is the
--      missing piece; the workspace decides what counts as dismissed (a stable
--      key per attention item, e.g. "ticket:<uuid>") and reads this table
--      to leave a dismissed key out of what it shows.
--
-- Neither table needs sync-path or a new Edge Function: both are read and
-- written straight from the browser, RLS-limited to the caller's own rows —
-- exactly as workspace_notes (0009) and mail_signatures already are.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. A studio profile any signed-in member of staff can read ───────────
-- Keys deliberately named, not "everything that is not a secret": a column
-- added to workspace_settings later (a bank field, a new integration's own
-- config) is manager-only by default, the same way 0043 keeps a column added
-- to employees out of the team directory until it is granted. base_currency is
-- included: Finance already shows it to every role it shows a figure to
-- (0041), so there is nothing to protect by leaving it out here.

create or replace function public.studio_profile()
returns table (key text, value text)
language sql
stable
security definer
set search_path = public
as $$
  select s.key, s.value
  from public.workspace_settings s
  where public.is_staff()
    and s.key in ('studio_name', 'studio_tagline', 'studio_location',
                  'studio_email', 'studio_website', 'base_currency')
$$;

comment on function public.studio_profile() is
  'The studio''s public-facing profile fields from workspace_settings, for any '
  'signed-in member of staff: name, tagline, location, contact address, '
  'website and base currency. Every other key (bank remittance details '
  'included) stays behind "managers read settings" (0016). Writing a field is '
  'unchanged: an owner or admin already saves it through the same table (0061).';

revoke all on function public.studio_profile() from public, anon;
grant execute on function public.studio_profile() to authenticated;

-- ── 2. Notification read state ────────────────────────────────────────────
-- One row per person per attention item they have dismissed. No update: a
-- dismissal is dismissed, and re-dismissing the same key is a harmless repeat
-- insert the workspace treats as already done (23505, unique_violation) rather
-- than an error. No delete either — there is no "un-dismiss" in the workspace
-- yet, and a table with no way to write over another person's row needs no
-- extra policy to get that wrong.

create table if not exists public.notification_dismissals (
  employee_id  uuid not null references public.employees(id) on delete cascade,
  notif_key    text not null check (length(notif_key) between 1 and 200),
  dismissed_at timestamptz not null default now(),
  primary key (employee_id, notif_key)
);

create index if not exists notification_dismissals_employee_idx
  on public.notification_dismissals (employee_id);

alter table public.notification_dismissals enable row level security;

drop policy if exists "staff read own notification_dismissals" on public.notification_dismissals;
create policy "staff read own notification_dismissals"
  on public.notification_dismissals for select to authenticated
  using (employee_id = public.active_employee_id());

drop policy if exists "staff dismiss own notifications" on public.notification_dismissals;
create policy "staff dismiss own notifications"
  on public.notification_dismissals for insert to authenticated
  with check (employee_id = public.active_employee_id());

comment on table public.notification_dismissals is
  'Which attention items (shellModel.attention() keys, e.g. "ticket:<uuid>") a '
  'person has dismissed from the bell. Read and written straight from the '
  'browser: each row is that person''s own, the same shape as workspace_notes '
  '(0009) and mail_signatures (0038) already are (0061).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'studio_profile') then
    raise exception '0061: studio_profile() was not created';
  end if;

  if not exists (select 1 from pg_tables
                 where schemaname = 'public' and tablename = 'notification_dismissals') then
    raise exception '0061: notification_dismissals was not created';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'notification_dismissals') <> 2 then
    raise exception '0061: notification_dismissals should carry exactly its own select and insert policies';
  end if;
end
$$;
