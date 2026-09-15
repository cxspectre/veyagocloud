-- 0048_calendar_event_write_rules.sql — an event is changed by whoever made it.
--
-- "staff updates local calendar events" and "staff deletes local calendar
-- events" (0026) let any member of staff change or delete any event entered in
-- the workspace: reschedule a colleague's client meeting, rename it, or remove
-- it, straight through the API (review, 2026-09-14).
--
-- An event entered here is now changed and deleted by the person who made it
-- (created_by), or by an owner or admin. The rest is as 0026 left it:
--
--   * A synced event (connection_id set) is the sync's. Nobody changes or
--     deletes one from the browser, whoever booked it, and no event is put on a
--     synced calendar.
--   * Adding an event is unchanged. createEvent signs a local event with the
--     booker's employee id; one saved without it, or whose maker's row is gone,
--     is for owners and admins to change.
--   * Staff who are not owners or admins cannot hand their event to someone
--     else either: the rule holds for the row as it is and as it is saved.
--
-- The Edge Functions write calendar_events with the service role, which RLS
-- does not apply to, so create-calendar-event and sync-outlook-calendar are
-- unaffected.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

drop policy if exists "staff updates local calendar events" on public.calendar_events;
drop policy if exists "staff deletes local calendar events" on public.calendar_events;

drop policy if exists "creator or manager updates local calendar events" on public.calendar_events;
create policy "creator or manager updates local calendar events"
  on public.calendar_events for update to authenticated
  using (
    connection_id is null
    and (created_by = (select public.active_employee_id()) or (select public.is_manager()))
  )
  with check (
    connection_id is null
    and (created_by = (select public.active_employee_id()) or (select public.is_manager()))
  );

drop policy if exists "creator or manager deletes local calendar events" on public.calendar_events;
create policy "creator or manager deletes local calendar events"
  on public.calendar_events for delete to authenticated
  using (
    connection_id is null
    and (created_by = (select public.active_employee_id()) or (select public.is_manager()))
  );

comment on column public.calendar_events.created_by is
  'Who made the event. For one entered in the workspace, the member of staff '
  'who may change or delete it besides owners and admins (0048).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'calendar_events'
               and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'DELETE', 'ALL')
               and policyname not in ('creator or manager updates local calendar events',
                                      'creator or manager deletes local calendar events')) then
    raise exception '0048: another policy still lets staff change or delete any calendar event';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'calendar_events'
        and permissive = 'PERMISSIVE'
        and policyname in ('creator or manager updates local calendar events',
                           'creator or manager deletes local calendar events')) <> 2 then
    raise exception '0048: the calendar event write rules are missing';
  end if;
end
$$;
