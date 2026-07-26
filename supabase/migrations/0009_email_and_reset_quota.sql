-- =============================================================================
-- Veyago — rate limiting for the public password-reset endpoint.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.
--
-- request-password-reset is the only endpoint in the system that must work
-- WITHOUT a session (someone who forgot their password has none), so it is the
-- one place an outsider can make us send email. Without a limit it is a
-- mail-bomb primitive and a way to burn the Resend quota.
--
-- The table is written only by the service role from inside the Edge Function.
-- RLS is on with NO policies at all, so no browser client can read it — the
-- attempt log would otherwise reveal which addresses have accounts, which is
-- exactly what the endpoint's neutral responses exist to hide.
-- =============================================================================

create table if not exists public.password_reset_attempts (
  id         bigserial primary key,
  email      text not null,
  ip         text not null,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_attempts_email_idx
  on public.password_reset_attempts (email, created_at desc);
create index if not exists password_reset_attempts_ip_idx
  on public.password_reset_attempts (ip, created_at desc);

alter table public.password_reset_attempts enable row level security;
-- Intentionally no policies: service role only (it bypasses RLS).

-- ---------------------------------------------------------------------------
-- Records an attempt and reports whether it is allowed. SECURITY DEFINER so the
-- function can write the log regardless of the caller, and it prunes as it goes
-- so the table cannot grow without bound.
-- ---------------------------------------------------------------------------
create or replace function public.consume_reset_quota(
  p_email          text,
  p_ip             text,
  p_max_email      int default 3,
  p_max_ip         int default 10,
  p_window_minutes int default 15
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff     timestamptz := now() - make_interval(mins => p_window_minutes);
  email_hits int;
  ip_hits    int;
begin
  -- Keep the table small; anything older than a day is useless for limiting.
  delete from public.password_reset_attempts where created_at < now() - interval '1 day';

  select count(*) into email_hits
  from public.password_reset_attempts
  where email = lower(p_email) and created_at >= cutoff;

  select count(*) into ip_hits
  from public.password_reset_attempts
  where ip = p_ip and created_at >= cutoff;

  -- Log every attempt, allowed or not, so hammering cannot reset the window.
  insert into public.password_reset_attempts (email, ip)
  values (lower(p_email), p_ip);

  return email_hits < p_max_email and ip_hits < p_max_ip;
end;
$$;

-- Only the service role should ever call this.
revoke all on function public.consume_reset_quota(text, text, int, int, int) from public, anon, authenticated;
