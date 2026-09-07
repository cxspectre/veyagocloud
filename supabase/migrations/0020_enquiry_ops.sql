-- =============================================================================
-- 0020 — enquiry ops: what happens AFTER the Get-a-quote form is submitted.
--
-- 0019 stored the lead and relayed it. This gives the people answering it
-- somewhere to work from, and keeps the table honest over time:
--
--   • website_enquiries gains the package the visitor picked, free-text notes,
--     a follow-up date and updated_at. Managers may edit status, notes and the
--     follow-up date from the browser — still nothing about the lead itself.
--   • email_log learns the two enquiry mails (to us, to the visitor) and gains
--     a `reference` column so a log row can point back at what caused it.
--   • submit_website_enquiry() takes the package and, on every call, applies
--     the retention rule below. Inside the function on purpose: no cron, no
--     extension, no separate job that can silently stop running.
--
-- Retention — the privacy page promises we keep the least we can:
--   ip_hash            cleared after 30 days    (abuse limiting is done by then)
--   lost / spam leads  deleted after 90 days    (nothing left to follow up)
--   every lead         deleted after 24 months  (a quote that old is not a lead)
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- website_enquiries: the three things a manager writes, plus what they picked.
-- ---------------------------------------------------------------------------

alter table public.website_enquiries
  add column if not exists package text
    constraint website_enquiries_package_check
    check (package in ('launch', 'business', 'backoffice', 'unsure')),
  add column if not exists notes text,
  add column if not exists next_follow_up_on date,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.website_enquiries.package is
  'Which /websites/ package the visitor picked: launch, business, backoffice, '
  'or unsure. NULL when the form did not ask (the /services/ form) or they left it.';
comment on column public.website_enquiries.notes is
  'Manager notes — what was said, what to quote. Never shown to the visitor.';
comment on column public.website_enquiries.next_follow_up_on is
  'When to chase this lead next. Surfaced as "follow-ups due" in /admin/leads.';
comment on column public.website_enquiries.updated_at is
  'Last edit to the row (status, notes, follow-up, delivery stamps). The 30-day '
  'ip_hash scrub is housekeeping, not an edit, and does not move it.';

-- The shared touch_updated_at() from 0001, with one exception: an update that
-- only clears ip_hash is the retention scrub, and "updated 2 minutes ago" on a
-- lead nobody has touched in a month would be a lie. Nothing else ever changes
-- ip_hash after insert, so "ip_hash unchanged" is exactly "a real edit".
drop trigger if exists website_enquiries_touch_updated_at on public.website_enquiries;
create trigger website_enquiries_touch_updated_at
  before update on public.website_enquiries
  for each row
  when (new.ip_hash is not distinct from old.ip_hash)
  execute function public.touch_updated_at();

-- Follow-ups are read by date; most rows have none, so the index stays small.
create index if not exists website_enquiries_follow_up_idx
  on public.website_enquiries (next_follow_up_on)
  where next_follow_up_on is not null;

-- Same row policy as 0019, renamed now that it covers more than the status.
-- The column grant below is what actually limits WHICH columns change: a
-- policy cannot, so authenticated gets update on exactly these three.
drop policy if exists "manager updates enquiry status" on public.website_enquiries;
drop policy if exists "manager updates enquiry" on public.website_enquiries;
create policy "manager updates enquiry"
  on public.website_enquiries for update
  using (public.is_manager())
  with check (public.is_manager());

revoke update on public.website_enquiries from anon, authenticated;
grant update (status, notes, next_follow_up_on) on public.website_enquiries to authenticated;

comment on table public.website_enquiries is
  'Leads from the public Get-a-quote form. Inserted only by the website-enquiry '
  'Edge Function (service role) via submit_website_enquiry(), which also applies '
  'the retention rule on every call. Managers read, and update status, notes and '
  'next_follow_up_on from /admin/leads; nobody deletes from the browser.';

-- ---------------------------------------------------------------------------
-- email_log: the two enquiry mails, and a way back to the record they belong to.
-- ---------------------------------------------------------------------------

alter table public.email_log add column if not exists reference text;

comment on column public.email_log.reference is
  'Id of the record that caused the send, when there is one — the enquiry id for '
  'enquiry_notify / enquiry_ack. Free text rather than a foreign key on purpose: '
  'the delivery record must outlive the lead, which retention deletes.';

create index if not exists email_log_reference_idx
  on public.email_log (reference)
  where reference is not null;

-- Same drop-and-recreate pattern as 0014/0015/0017/0019: the constraint's
-- autogenerated name drifts across projects, so find it rather than name it.
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
    'invoice',
    'enquiry_notify',   -- the lead, to us
    'enquiry_ack'       -- the fixed acknowledgement, to the visitor
  ));

-- ---------------------------------------------------------------------------
-- submit_website_enquiry(): now takes the package and applies retention.
--
-- The signature changes (14 arguments), and CREATE OR REPLACE with a new
-- signature would ADD an overload rather than replace the old one — leaving
-- PostgREST unable to choose between two functions that both accept the nine
-- named arguments the Edge Function sends. So the old one is dropped first.
-- ---------------------------------------------------------------------------

drop function if exists public.submit_website_enquiry(
  text, text, text, text, text, text, text, text, text, int, int, int, int);
drop function if exists public.submit_website_enquiry(
  text, text, text, text, text, text, text, text, text, text, int, int, int, int);

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
  p_package        text default null,   -- launch | business | backoffice | unsure
  p_max_email      int default 3,
  p_max_ip         int default 8,
  p_window_minutes int default 60,
  p_max_global     int default 60       -- ceiling across everyone, per window
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
  v_package   text;
begin
  -- Serialise concurrent attempts for the same address and the same IP for the
  -- rest of this transaction. Without this, N parallel requests all count zero
  -- and all get through; with it, the second one waits and counts the first.
  perform pg_advisory_xact_lock(hashtext('enquiry:email:' || lower(p_email)));
  perform pg_advisory_xact_lock(hashtext('enquiry:ip:' || coalesce(p_ip_hash, '')));

  -- Retention, applied on every submission. Piggybacking on the one write path
  -- means it runs exactly as often as the table grows and never needs a
  -- scheduler; the tables are small, so the three statements are cheap.
  update public.website_enquiries
     set ip_hash = null
   where ip_hash is not null
     and created_at < now() - interval '30 days';

  delete from public.website_enquiries
   where status in ('lost', 'spam')
     and created_at < now() - interval '90 days';

  delete from public.website_enquiries
   where created_at < now() - interval '24 months';

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

  -- The Edge Function validates the package before calling; this only makes
  -- sure a lead is never lost over a label the CHECK constraint would refuse.
  v_package := case
    when p_package in ('launch', 'business', 'backoffice', 'unsure') then p_package
    else null
  end;

  insert into public.website_enquiries
    (kind, name, email, business, website, message, locale, page, ip_hash, package)
  values
    (p_kind, p_name, lower(p_email), nullif(p_business, ''), nullif(p_website, ''),
     nullif(p_message, ''), nullif(p_locale, ''), nullif(p_page, ''), p_ip_hash, v_package)
  returning id into new_id;

  return new_id;
end;
$$;

-- Only the Edge Function (service role) may call this. Nothing in the browser
-- should be able to insert a lead or probe the quota.
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, text, int, int, int, int) from public;
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, text, int, int, int, int) from anon;
revoke all on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, text, int, int, int, int) from authenticated;
grant execute on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, text, int, int, int, int) to service_role;

comment on function public.submit_website_enquiry(text, text, text, text, text, text, text, text, text, text, int, int, int, int) is
  'Atomic entry point for the Get-a-quote form: applies retention (ip_hash cleared '
  'after 30 days, lost/spam deleted after 90, everything after 24 months), logs the '
  'attempt, enforces the per-email, per-IP-hash and global quota under advisory '
  'locks, inserts the lead with its package when allowed. Returns the new id, or '
  'NULL when over quota. Service role only.';
