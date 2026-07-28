-- 0011 — publish approval.
--
-- An assistant may publish the live site, but only with an admin's approval.
-- functions/deploy already authorises assistants (PUBLISHERS), and the comment
-- there says "letting the assistant publish is the whole point" — but the only
-- publish UI was mounted behind requireManager(), so the one role the function
-- was widened for had no button anywhere. This closes that gap honestly rather
-- than by quietly narrowing PUBLISHERS.
--
-- SHAPE (decided 2026-07-28): approving UNLOCKS, it does not ship. The admin
-- grants; the assistant then publishes when they are ready, so they keep
-- control of timing. Owners and admins are unaffected and still publish
-- directly — there is no self-approval dance for the people who could approve
-- themselves anyway.
--
--   pending ──approve──> approved ──publish──> published
--      │                     │
--      ├──reject──> rejected └──(24h)──> expires, unusable
--      └──cancel──> cancelled
--
-- WHY A NEW TABLE, not a build_runs status: 0008 calls build_runs the record of
-- publish ATTEMPTS and says "nobody can forge a success, backdate a run, or
-- erase a failed publish". A request that was never approved is not an attempt.
-- Putting it there would also mean widening a CHECK constraint that three
-- client-side status maps depend on (publish.js and dashboard.js).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The requests table
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.publish_requests (
  id                 uuid primary key default gen_random_uuid(),

  -- Keyed on auth.users to match build_runs (0008), the table this is joined
  -- against — NOT on employees.id, which is what tasks/onboarding use. The
  -- email is denormalised for the same reason build_runs does it: the row must
  -- still say who asked after the user record is gone.
  requested_by       uuid references auth.users(id) on delete set null default auth.uid(),
  requested_by_email text,

  note               text,                    -- what the assistant is shipping, in their words

  status             text not null default 'pending'
                       check (status in ('pending','approved','rejected','cancelled','published')),

  decided_by         uuid references auth.users(id) on delete set null,
  decided_by_email   text,
  decided_at         timestamptz,
  decision_note      text,                    -- why it was rejected; shown to the requester

  -- Set when the approval is spent. Its presence is what makes an approval
  -- single-use: deploy consumes the row conditionally on this being null.
  build_run_id       uuid references public.build_runs(id) on delete set null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The queue reads "pending, newest first" on every load of the publish screen.
create index if not exists publish_requests_queue_idx
  on public.publish_requests (status, created_at desc);

-- One open request per person at a time. Without this a frustrated assistant
-- clicking twice leaves two pending rows and an admin approving both hands out
-- two grants for one intention.
create unique index if not exists publish_requests_one_open_per_user
  on public.publish_requests (requested_by)
  where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Guard trigger
--    Named to sort BEFORE publish_requests_touch_updated_at: two BEFORE UPDATE
--    triggers fire in alphabetical order, and a guard that runs second would be
--    restoring a column the touch trigger had already set.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.publish_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The deploy Edge Function consumes an approval with the service role, where
  -- there is no auth.uid(). Without this early return the guard below would
  -- block the one caller that legitimately marks a request 'published'.
  if auth.uid() is null then
    return new;
  end if;

  -- Provenance is never editable by anyone, manager or not.
  new.id           := old.id;
  new.requested_by := old.requested_by;
  new.created_at   := old.created_at;

  if public.is_manager() then
    -- A manager decides. Stamp the decision server-side so the client cannot
    -- claim someone else approved it, or backdate when.
    if new.status is distinct from old.status
       and new.status in ('approved','rejected') then
      new.decided_by       := auth.uid();
      new.decided_by_email := (select email from public.employees where user_id = auth.uid());
      new.decided_at       := now();
    end if;
    return new;
  end if;

  -- Not a manager: the only move available is withdrawing your own pending
  -- request. Everything else is restored, so a devtools edit achieves nothing.
  if old.requested_by = auth.uid() and old.status = 'pending' and new.status = 'cancelled' then
    new.note             := old.note;
    new.decided_by       := old.decided_by;
    new.decided_by_email := old.decided_by_email;
    new.decided_at       := old.decided_at;
    new.decision_note    := old.decision_note;
    new.build_run_id     := old.build_run_id;
    return new;
  end if;

  raise exception 'Only a manager can decide a publish request';
end;
$$;

drop trigger if exists publish_requests_guard on public.publish_requests;
create trigger publish_requests_guard
  before update on public.publish_requests
  for each row execute function public.publish_requests_guard();

drop trigger if exists publish_requests_touch_updated_at on public.publish_requests;
create trigger publish_requests_touch_updated_at
  before update on public.publish_requests
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS
--    The "may publish" set is written inline as employee_role() in (...) rather
--    than as a can_publish() helper: 0007 names exactly that helper as the
--    anti-pattern, because a SQL helper implies RLS enforces something that is
--    really enforced in the Edge Function.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.publish_requests enable row level security;

-- Everyone on staff can see the queue. Publishing is a shared, whole-site act;
-- knowing one is pending is not privileged information.
drop policy if exists "staff read publish requests" on public.publish_requests;
create policy "staff read publish requests"
  on public.publish_requests for select
  using (public.is_staff());

-- Only someone who could publish may ask to. Mirrors PUBLISHERS in
-- functions/deploy/index.ts — keep the two in step.
drop policy if exists "publisher creates publish request" on public.publish_requests;
create policy "publisher creates publish request"
  on public.publish_requests for insert
  with check (
    public.employee_role() in ('owner','admin','assistant')
    and (requested_by = auth.uid() or requested_by is null)
    and status = 'pending'
  );

-- Managers decide; the guard trigger above constrains what "decide" can mean.
drop policy if exists "manager decides publish request" on public.publish_requests;
create policy "manager decides publish request"
  on public.publish_requests for update
  using (public.is_manager())
  with check (public.is_manager());

-- A requester may withdraw their own pending request, so a stale one never
-- gets permanently stuck waiting for an admin who is not coming.
drop policy if exists "requester cancels own publish request" on public.publish_requests;
create policy "requester cancels own publish request"
  on public.publish_requests for update
  using (requested_by = auth.uid() and status = 'pending')
  with check (requested_by = auth.uid());

-- Deliberately no DELETE policy. This is an audit trail of who asked to ship
-- the public site and who let them; cancelled and rejected rows are the record.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. email_log accepts the new notification kind
--    Its kind column is CHECK-constrained, and notify-task never inspects the
--    result of its email_log insert — so without this the approval email would
--    send correctly and then vanish from the log with no error anywhere.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.email_log drop constraint if exists email_log_kind_check;
alter table public.email_log add constraint email_log_kind_check
  check (kind in ('invite', 'password_reset', 'task_assigned', 'digest', 'publish_requested'));
