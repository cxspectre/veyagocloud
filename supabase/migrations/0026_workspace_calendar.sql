-- =============================================================================
-- 0026 — Calendar: the agenda, synced or entered by hand.
--
-- connection_id is NULLABLE here, unlike mail. A mail message without a
-- mailbox is meaningless, but an event booked in the workspace before any
-- calendar is connected is perfectly ordinary — so null means "ours, entered
-- here" and a value means "synced from that account". The unique index only
-- covers synced rows, so hand-made events never collide.
--
-- Visibility mirrors 0025: a studio calendar is shared, a personal one is the
-- person's own, and managers get no override. Same reasoning, same helper.
--
-- Idempotent. Adds only.
-- =============================================================================

create table if not exists public.calendar_events (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid references public.integration_connections(id) on delete cascade,
  calendar_id   text,                               -- provider sub-calendar, when there are several
  external_id   text,                               -- provider event id; null for hand-made
  title         text not null,
  detail        text,
  location      text,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  all_day       boolean not null default false,
  kind          text not null default 'internal'
                  check (kind in ('team','client','internal','personal','focus')),
  status        text not null default 'confirmed'
                  check (status in ('confirmed','tentative','cancelled')),
  contact_id    uuid references public.crm_contacts(id) on delete set null,
  company_id    uuid references public.crm_companies(id) on delete set null,
  project_id    uuid references public.client_projects(id) on delete set null,
  attendees     jsonb not null default '[]'::jsonb, -- [{name, email, response}]
  created_by    uuid references public.employees(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint calendar_events_ends_after_starts
    check (ends_at is null or ends_at >= starts_at)
);

-- Synced events are unique per (connection, calendar, event). Hand-made rows
-- have a null external_id and are excluded, so they never collide with a sync.
create unique index if not exists calendar_events_external_idx
  on public.calendar_events (connection_id, coalesce(calendar_id, ''), external_id)
  where external_id is not null;

create index if not exists calendar_events_window_idx
  on public.calendar_events (starts_at) where status <> 'cancelled';
create index if not exists calendar_events_project_idx on public.calendar_events (project_id);

drop trigger if exists calendar_events_touch_updated_at on public.calendar_events;
create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.touch_updated_at();

alter table public.calendar_events enable row level security;

-- A hand-made event (connection_id null) is the studio's and visible to staff;
-- a synced one follows the mailbox rule from 0025.
drop policy if exists "read visible calendar events" on public.calendar_events;
create policy "read visible calendar events"
  on public.calendar_events for select
  using (
    case when connection_id is null
      then public.is_staff()
      else public.can_read_connection(connection_id)
    end
  );

-- Staff book events in the workspace. They may not invent rows against a
-- synced calendar: that is the sync's job, and a row the provider does not
-- know about would vanish on the next pull anyway.
drop policy if exists "staff creates local calendar events" on public.calendar_events;
create policy "staff creates local calendar events"
  on public.calendar_events for insert
  with check (public.is_staff() and connection_id is null and external_id is null);

drop policy if exists "staff updates local calendar events" on public.calendar_events;
create policy "staff updates local calendar events"
  on public.calendar_events for update
  using (public.is_staff() and connection_id is null)
  with check (public.is_staff() and connection_id is null);

drop policy if exists "staff deletes local calendar events" on public.calendar_events;
create policy "staff deletes local calendar events"
  on public.calendar_events for delete
  using (public.is_staff() and connection_id is null);

comment on table public.calendar_events is
  'Agenda. connection_id null = entered in the workspace; set = synced from '
  'that account and owned by the sync.';
