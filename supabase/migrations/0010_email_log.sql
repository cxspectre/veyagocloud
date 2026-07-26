-- =============================================================================
-- Veyago — transactional email log.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.
--
-- A record of what the system sent and whether it actually arrived, so "she
-- never got the invite" is answerable instead of a shrug.
--
-- Rate limiting lives separately in 0009 (password_reset_attempts +
-- consume_reset_quota), which is atomic and prunes itself. This table is the
-- delivery record only — do not limit from it.
--
-- Written only by Edge Functions holding the service-role key. There is
-- deliberately no insert/update/delete policy, so the browser cannot forge or
-- erase a row even though managers can read them.
-- =============================================================================

create table if not exists public.email_log (
  id         uuid primary key default gen_random_uuid(),
  to_email   text not null,
  kind       text not null check (kind in ('invite', 'password_reset', 'task_assigned', 'digest')),
  subject    text,
  ok         boolean not null default false,
  error      text,
  -- Who asked for it, when we can tell. NULL for unauthenticated resets.
  requested_by uuid references auth.users(id) on delete set null,
  -- Coarse client fingerprint for abuse triage. Not an audit identity.
  request_ip text,
  created_at timestamptz not null default now()
);

create index if not exists email_log_recent_idx
  on public.email_log (to_email, kind, created_at desc);
create index if not exists email_log_ip_idx
  on public.email_log (request_ip, created_at desc);

alter table public.email_log enable row level security;

drop policy if exists "manager reads email log" on public.email_log;
create policy "manager reads email log"
  on public.email_log for select
  using (public.is_manager());

-- No write policy on purpose: the service role bypasses RLS, everyone else is
-- denied. A browser cannot forge a delivery record nor delete one to hide a send.

comment on table public.email_log is
  'Append-only delivery record for transactional email. Service-role writes only. '
  'Rate limiting is separate — see consume_reset_quota in 0009.';
