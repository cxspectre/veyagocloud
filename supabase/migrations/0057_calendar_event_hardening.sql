-- 0057_calendar_event_hardening.sql — three gaps found in the Agenda audit
-- (2026-09-15): a write rule with a hole, two Graph fields we threw away, and a
-- sync nobody runs but a person.
--
-- 1. COLUMN GUARD. 0048 lets whoever made a hand-made event, or an owner or
--    admin, UPDATE that row — but it does not say which COLUMNS. A member of
--    staff who is neither is still refused by RLS, but the creator of their
--    own event could PATCH project_id, company_id, contact_id, kind, status,
--    all_day or attendees straight through PostgREST — nothing in 0048 stops
--    it, and the workspace's own updateEvent() only look like a boundary; RLS
--    is (see actions.js's own header). A BEFORE UPDATE trigger now holds a
--    non-manager to the same five columns the front end already sends: title,
--    detail, location, starts_at, ends_at. An owner or admin is unrestricted,
--    as 0048 already lets them touch any local event. Written the way 0038's
--    integration_connections_browser_can_only_disconnect() is: current_user
--    checked, not a role helper, so the sync and create-calendar-event — both
--    the service role, which RLS does not apply to either — are untouched.
--
-- 2. GRAPH FIELDS DROPPED. graph-message.ts read an event's organiser and its
--    online-meeting link off Graph and then discarded both: toEventRow() put
--    a literal "Online meeting" string in `detail` and never kept the URL, and
--    nothing recorded who organised a meeting synced in. Two columns for the
--    Graph fields, and one for the zone the organiser booked it in — the
--    first step toward 0026's still-open "time zones" item, without taking on
--    recurring series, reminders or written-back replies today.
--
-- 3. NO SCHEDULE. Mail arrives by itself (0038 §9); a calendar only refreshes
--    when someone opens the Agenda or presses Sync. A cron job now asks
--    sync-calendar-scheduled to refresh every live calendar connection every
--    15 minutes — longer than mail's five, because calendarView re-reads the
--    whole window each time rather than following a delta, so it is heavier
--    per call for the same fresh-enough result. Same shape as 0038 §9: a
--    schedule has no user to sign in as, so the function checks a header
--    against a Vault secret instead of a JWT.
--
-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A non-manager changes an event's title, time, place and details — and
--    nothing else, whatever the request carries.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.calendar_events_creator_can_only_change_details()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and not public.is_manager()
     and (to_jsonb(new) - 'title' - 'detail' - 'location' - 'starts_at' - 'ends_at' - 'updated_at')
       is distinct from
         (to_jsonb(old) - 'title' - 'detail' - 'location' - 'starts_at' - 'ends_at' - 'updated_at')
  then
    raise exception 'You can only change an event''s title, time, place and details. Ask an owner or admin for anything else.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists calendar_events_creator_can_only_change_details on public.calendar_events;
create trigger calendar_events_creator_can_only_change_details
  before update on public.calendar_events
  for each row execute function public.calendar_events_creator_can_only_change_details();

comment on function public.calendar_events_creator_can_only_change_details() is
  'RLS (0048) says WHO changes a local event; this says WHICH COLUMNS a '
  'non-manager may move. The service role (the sync, create-calendar-event, '
  'and this migration''s own scheduled sync) is exempt by current_user, as '
  '0038''s connection guard is.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Who organised a synced meeting, its video-call link, and the zone it was
--    booked in — kept, not thrown away.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.calendar_events add column if not exists organizer_name text;
alter table public.calendar_events add column if not exists organizer_email text;
-- https only (finding: "Video meeting links are thrown away — accept only
-- https links"). A join link is pasted into the page as a plain href; an
-- http:// one is a mixed-content warning at best, and Graph has never sent us
-- anything else in practice — a scheme we do not expect is worth dropping
-- rather than trusting.
alter table public.calendar_events add column if not exists meeting_url text
  constraint calendar_events_meeting_url_https check (meeting_url is null or meeting_url like 'https://%');
-- The organiser's OWN zone when they made it (Graph's originalStartTimeZone) —
-- not what we asked calendarView to convert everything to (UTC, so every
-- event this table stores is comparable). Informational only: nothing here
-- converts a display back into it yet.
alter table public.calendar_events add column if not exists time_zone text;

comment on column public.calendar_events.organizer_name is
  'A synced event''s organiser, as Graph''s organizer.emailAddress.name reads '
  'it. Null for a hand-made event: its creator is created_by.';
comment on column public.calendar_events.organizer_email is
  'A synced event''s organiser address, lower-cased. Null for a hand-made '
  'event, or a synced one Graph did not send an organizer for.';
comment on column public.calendar_events.meeting_url is
  'A video-call join link, https only — Graph''s onlineMeeting.joinUrl, '
  'refused at ingestion (and here) when it is not https:// (0057).';
comment on column public.calendar_events.time_zone is
  'The organiser''s own zone when the event was made (Graph''s '
  'originalStartTimeZone) — not the UTC this table stores every instant in. '
  'Shown for context; nothing computes from it yet (0026''s open item).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A calendar refreshes by itself, the way a mailbox already does (0038 §9).
--
--    Fifteen minutes, not five: calendarView re-reads the whole window every
--    time (sync-outlook-calendar has no delta cursor the way mail does), so a
--    calendar with several connections costs more per run for the same
--    freshness. Same two Vault secrets as mail, created once by hand, never
--    committed:
--
--      select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--      select vault.create_secret('<same value as CALENDAR_SYNC_SECRET>', 'calendar_sync_secret');
--
--    A separate secret from mail's, deliberately: a leaked cron header should
--    not double as a key to the other schedule. Until both secrets exist the
--    job runs and its requests fail harmlessly; cron.job_run_details and
--    net._http_response say why.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sync-workspace-calendar';
  perform cron.schedule(
    'sync-workspace-calendar',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/sync-calendar-scheduled',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_secret')
        ),
        body := jsonb_build_object('connectionId', c.id),
        timeout_milliseconds := 120000
      )
      from public.integration_connections c
      where c.provider = 'microsoft_calendar'
        and c.status in ('connected', 'error');
    $job$
  );
end $$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.calendar_events'::regclass
      and tgname = 'calendar_events_creator_can_only_change_details'
  ) then
    raise exception '0057: the calendar event column guard trigger is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calendar_events'
      and column_name in ('organizer_name', 'organizer_email', 'meeting_url', 'time_zone')
    having count(*) = 4
  ) then
    raise exception '0057: calendar_events is missing an organiser, meeting link or time zone column';
  end if;

  if not exists (select 1 from cron.job where jobname = 'sync-workspace-calendar') then
    raise exception '0057: the scheduled calendar sync job is missing';
  end if;
end
$$;
