-- =============================================================================
-- 0028 — Make the sync keys upsertable.
--
-- 0024 and 0026 gave integration_connections and calendar_events unique
-- indexes built on EXPRESSIONS — lower(account_label) in one, a COALESCE plus
-- a WHERE clause in the other. Both enforce the right rule, and neither can be
-- named in an ON CONFLICT target, so every upsert the sync functions make
-- against them would have failed at runtime with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- 0005 already wrote the rule down, on finance_transactions:
--
--     Plain (non-partial) so PostgREST upserts can target it; NULL
--     external_ids (manual entries) are always distinct, so they never
--     collide.
--
-- This applies it in both places. The uniqueness rules themselves do not
-- change:
--   * account_label is now normalised to lowercase on write, so a plain index
--     on (provider, account_label) is exactly the old lower() index.
--   * calendar_id defaults to '' instead of null, so a plain three-column
--     index says what the COALESCE said. Hand-made events keep a NULL
--     external_id, and NULLs never equal each other, so they still never
--     collide with a synced row — which is what the WHERE clause was for.
--
-- Both tables are empty at the time of writing, so there is nothing to
-- backfill; the statements are written to be correct either way.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. integration_connections: normalise, then index plainly.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.integration_connections_normalise()
returns trigger
language plpgsql
as $$
begin
  -- An address is case-insensitive; storing it lowercased is what lets a plain
  -- unique index do the job the lower() index was doing.
  new.account_label := lower(trim(new.account_label));
  return new;
end;
$$;

drop trigger if exists integration_connections_normalise on public.integration_connections;
create trigger integration_connections_normalise
  before insert or update on public.integration_connections
  for each row execute function public.integration_connections_normalise();

update public.integration_connections
set account_label = lower(trim(account_label))
where account_label <> lower(trim(account_label));

drop index if exists public.integration_connections_account_idx;
create unique index if not exists integration_connections_account_idx
  on public.integration_connections (provider, account_label);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. calendar_events: give calendar_id a default so the key is three plain
--    columns.
-- ─────────────────────────────────────────────────────────────────────────────
update public.calendar_events set calendar_id = '' where calendar_id is null;

alter table public.calendar_events
  alter column calendar_id set default '',
  alter column calendar_id set not null;

drop index if exists public.calendar_events_external_idx;
create unique index if not exists calendar_events_external_idx
  on public.calendar_events (connection_id, calendar_id, external_id);

comment on index public.calendar_events_external_idx is
  'Plain, not partial: PostgREST upserts must be able to name it. Hand-made '
  'events have a NULL external_id and NULLs never collide, so they are still '
  'excluded in practice.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Prove both are usable as ON CONFLICT targets, so this cannot regress
--    unnoticed the way it did between 0024 and here.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  conn uuid;
begin
  insert into public.integration_connections (provider, account_label, status)
  values ('imap', 'Upsert.Probe@Example.com', 'disconnected')
  on conflict (provider, account_label) do update set last_error = null
  returning id into conn;

  -- Same row again: the upsert must update rather than raise, and the label
  -- must have been lowercased on the way in.
  insert into public.integration_connections (provider, account_label, status)
  values ('imap', 'upsert.probe@example.com', 'disconnected')
  on conflict (provider, account_label) do update set last_error = 'probe'
  returning id into conn;

  insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at)
  values (conn, 'primary', 'probe-event', 'Probe', now())
  on conflict (connection_id, calendar_id, external_id) do update set title = 'Probe';

  insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at)
  values (conn, 'primary', 'probe-event', 'Probe again', now())
  on conflict (connection_id, calendar_id, external_id) do update set title = excluded.title;

  if (select count(*) from public.calendar_events where external_id = 'probe-event') <> 1 then
    raise exception '0028: the calendar upsert duplicated instead of updating';
  end if;

  delete from public.calendar_events where connection_id = conn;
  delete from public.integration_connections where id = conn;
end $$;
