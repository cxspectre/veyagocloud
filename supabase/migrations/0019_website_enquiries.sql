-- =============================================================================
-- 0019 — website enquiries: the "Get a quote" form on /websites/ and /services/.
--
-- The public site makes no third-party calls, so the form posts to our own
-- Edge Function (website-enquiry), which writes here with the service role and
-- relays the message to us through Resend. This migration gives it:
--
--   • public.website_enquiries          the lead itself, readable by managers
--   • public.website_enquiry_attempts   every submission attempt, for limiting
--   • public.submit_website_enquiry()   the one atomic entry point: count the
--                                       recent attempts, log this one, insert
--                                       the lead only if under quota
--
-- Modelled on consume_reset_quota (0009): the attempt log is separate from the
-- lead table so hammering the endpoint cannot fill the leads list, and every
-- attempt is logged whether it passes or not, so a burst cannot reset its own
-- window. IPs are stored only as a salted hash (the function hashes before it
-- calls in) — enough to limit abuse, not enough to identify anyone later.
-- =============================================================================

create table if not exists public.website_enquiries (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('website', 'product')),
  name          text not null,
  email         text not null,
  business      text,
  website       text,
  message       text,
  locale        text,
  page          text,
  ip_hash       text,
  status        text not null default 'new'
                check (status in ('new', 'replied', 'quoted', 'won', 'lost', 'spam')),
  notified_at   timestamptz,          -- when the notification to us was sent
  ack_sent_at   timestamptz,          -- when the acknowledgement to the sender was sent
  created_at    timestamptz not null default now()
);

create index if not exists website_enquiries_created_idx
  on public.website_enquiries (created_at desc);
create index if not exists website_enquiries_status_idx
  on public.website_enquiries (status, created_at desc);

alter table public.website_enquiries enable row level security;

drop policy if exists "manager reads enquiries" on public.website_enquiries;
create policy "manager reads enquiries"
  on public.website_enquiries for select
  using (public.is_manager());

-- Managers can move a lead through its statuses; nothing else about it changes
-- from the browser. A policy cannot restrict columns, so the column grant does
-- that part: authenticated may update status and only status. Inserts and
-- deletes stay with the service role.
drop policy if exists "manager updates enquiry status" on public.website_enquiries;
create policy "manager updates enquiry status"
  on public.website_enquiries for update
  using (public.is_manager())
  with check (public.is_manager());

revoke update on public.website_enquiries from anon, authenticated;
grant update (status) on public.website_enquiries to authenticated;

comment on table public.website_enquiries is
  'Leads from the public Get-a-quote form. Inserted only by the website-enquiry '
  'Edge Function (service role) via submit_website_enquiry(). Managers read and '
  'update status; nobody deletes from the browser.';

-- ---------------------------------------------------------------------------

create table if not exists public.website_enquiry_attempts (
  id         bigserial primary key,
  email      text not null,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index if not exists website_enquiry_attempts_email_idx
  on public.website_enquiry_attempts (email, created_at desc);
create index if not exists website_enquiry_attempts_ip_idx
  on public.website_enquiry_attempts (ip_hash, created_at desc);

alter table public.website_enquiry_attempts enable row level security;
-- No policies at all: only the service role (which bypasses RLS) touches it.

-- ---------------------------------------------------------------------------

create or replace function public.submit_website_enquiry(
  p_kind           text,
  p_name           text,
  p_email          text,
  p_business       text,
  p_website        text,
  p_message        text,
  p_locale         text,
  p_page           text,
  p_ip_hash        text,
  p_max_email      int default 3,
  p_max_ip         int default 8,
  p_window_minutes int default 60,
  p_max_global     int default 60     -- ceiling across everyone, per window
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff      timestamptz := now() - make_interval(mins => p_window_minutes);
  email_hits  int;
  ip_hits     int;
  global_hits int;
  new_id      uuid;
begin
  -- Serialise concurrent attempts for the same address and the same IP for the
  -- rest of this transaction. Without this, N parallel requests all count zero
  -- and all get through; with it, the second one waits and counts the first.
  perform pg_advisory_xact_lock(hashtext('enquiry:email:' || lower(p_email)));
  perform pg_advisory_xact_lock(hashtext('enquiry:ip:' || coalesce(p_ip_hash, '')));

  -- Keep the attempt log small; anything older than a day is useless for limiting.
  delete from public.website_enquiry_attempts where created_at < now() - interval '1 day';

  select count(*) into email_hits
  from public.website_enquiry_attempts
  where email = lower(p_email) and created_at >= cutoff;

  select count(*) into ip_hits
  from public.website_enquiry_attempts
  where ip_hash = p_ip_hash and created_at >= cutoff;

  -- A proxy pool defeats per-IP limits; a global ceiling bounds the damage a
  -- flood can do to the inbox and the Resend quota, at the cost of real
  -- enquiries pausing for an hour during an attack. That trade is deliberate.
  select count(*) into global_hits
  from public.website_enquiry_attempts
  where created_at >= cutoff;

  -- Log every attempt, allowed or not, so hammering cannot reset the window.
  insert into public.website_enquiry_attempts (email, ip_hash)
  values (lower(p_email), p_ip_hash);

  if email_hits >= p_max_email or ip_hits >= p_max_ip or global_hits >= p_max_global then
    return null;
  end if;

  insert into public.website_enquiries
    (kind, name, email, business, website, message, locale, page, ip_hash)
  values
    (p_kind, p_name, lower(p_email), nullif(p_business, ''), nullif(p_website, ''),
     nullif(p_message, ''), nullif(p_locale, ''), nullif(p_page, ''), p_ip_hash)
  returning id into new_id;

  return new_id;
end;
$$;

-- Only the Edge Function (service role) may call this. Nothing in the browser
-- should be able to insert a lead or probe the quota.
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, int, int, int, int) from public;
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, int, int, int, int) from anon;
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, int, int, int, int) from authenticated;
grant execute on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, int, int, int, int) to service_role;

comment on function public.submit_website_enquiry is
  'Atomic entry point for the Get-a-quote form: logs the attempt, enforces the '
  'per-email, per-IP-hash and global quota under advisory locks, inserts the '
  'lead when allowed. Returns the new id, or NULL when over quota. Service role only.';

-- ---------------------------------------------------------------------------
-- Drift repair. 0017 was applied to production by hand and only partly: its
-- task_comments table exists, but the wider email_log kind constraint at the
-- end of that file never landed, so notify-task's 'task_comment' log rows
-- violate the check. Reassert the constraint here, idempotently, with the full
-- list 0017 intended. Safe to re-run: it drops whatever kind-check exists and
-- recreates it.
do $$
declare c record;
begin
  for c in
    select con.conname
    from   pg_constraint con
    join   pg_class rel on rel.oid = con.conrelid
    join   pg_namespace nsp on nsp.oid = rel.relnamespace
    where  con.contype = 'c'
    and    nsp.nspname = 'public'
    and    rel.relname = 'email_log'
    and    con.conname ilike '%kind%'
  loop
    execute format('alter table public.email_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_log add constraint email_log_kind_check
  check (kind in (
    'invite',
    'password_reset',
    'task_assigned',
    'task_done',
    'task_blocked',
    'task_updated',
    'task_comment',
    'digest',
    'publish_requested',
    'invoice'
  ));
