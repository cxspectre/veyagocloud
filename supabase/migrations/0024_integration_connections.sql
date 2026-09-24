-- =============================================================================
-- 0024 — Integration connections, and a vault the browser cannot open.
--
-- Mercury and Stripe authenticate with one studio-wide key held in a Supabase
-- secret (see supabase/functions/sync-mercury/index.ts). That works for a
-- single global token. An inbox or a calendar does not fit it: those are
-- per-mailbox OAuth grants that expire, refresh, and have to be revoked one at
-- a time. They need rows.
--
-- THE SPLIT IS THE POINT.
--   integration_connections  metadata — which mailbox, connected or not, last
--                            synced when, which error. Staff read this; the
--                            workspace shows it on a settings screen.
--   integration_secrets      the tokens. RLS is on and there is DELIBERATELY
--                            NOT ONE POLICY, so every anon and authenticated
--                            request is refused by default. Only the service
--                            role — which bypasses RLS and lives exclusively in
--                            Edge Functions — can read or write it. The grants
--                            are revoked as well, so PostgREST will not even
--                            expose the table.
--
-- If you ever find yourself adding a policy to integration_secrets, stop: the
-- workspace runs supabase-js in the BROWSER with the anon key, and any policy
-- that lets a signed-in user select from that table hands them a refresh token.
--
-- Idempotent. Adds only.
-- =============================================================================

create table if not exists public.integration_connections (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null
                  check (provider in ('google_mail','google_calendar','imap','caldav',
                                      'ics','mercury','stripe')),
  employee_id   uuid references public.employees(id) on delete cascade,
  account_label text not null,                     -- 'hello@veyago.cloud', 'Mercury Checking'
  external_id   text,                              -- provider-side account id
  status        text not null default 'disconnected'
                  check (status in ('connected','needs_reauth','disconnected','error')),
  scopes        text[],
  sync_cursor   text,                              -- Gmail historyId, IMAP UID, page token
  last_synced_at timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One connection per mailbox per provider. A studio-wide connection has a null
-- employee_id, which this still keys correctly because account_label carries
-- the identity.
create unique index if not exists integration_connections_account_idx
  on public.integration_connections (provider, lower(account_label));

drop trigger if exists integration_connections_touch_updated_at on public.integration_connections;
create trigger integration_connections_touch_updated_at
  before update on public.integration_connections
  for each row execute function public.touch_updated_at();

alter table public.integration_connections enable row level security;

-- Staff see what is connected. Only managers connect or disconnect anything:
-- wiring the studio inbox to a new grant is not an everyday edit.
drop policy if exists "staff read integration_connections" on public.integration_connections;
create policy "staff read integration_connections"
  on public.integration_connections for select using (public.is_staff());

drop policy if exists "manager writes integration_connections" on public.integration_connections;
create policy "manager writes integration_connections"
  on public.integration_connections for all
  using (public.is_manager()) with check (public.is_manager());

-- ---------------------------------------------------------------------------
-- The vault. No policies, no grants — read the header before changing either.
-- ---------------------------------------------------------------------------
create table if not exists public.integration_secrets (
  connection_id uuid primary key
                  references public.integration_connections(id) on delete cascade,
  access_token  text,
  refresh_token text,
  token_type    text,
  expires_at    timestamptz,
  extra         jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

drop trigger if exists integration_secrets_touch_updated_at on public.integration_secrets;
create trigger integration_secrets_touch_updated_at
  before update on public.integration_secrets
  for each row execute function public.touch_updated_at();

alter table public.integration_secrets enable row level security;
alter table public.integration_secrets force row level security;

revoke all on public.integration_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the settings screen reads: connection health without ever joining to
-- the vault. security_invoker so the caller's own RLS still applies.
-- ---------------------------------------------------------------------------
create or replace view public.integration_status
with (security_invoker = true) as
select
  c.id,
  c.provider,
  c.account_label,
  c.employee_id,
  e.full_name as employee_name,
  c.status,
  c.last_synced_at,
  c.last_error,
  -- Whether a token exists, never what it is. EXISTS against a table the
  -- caller cannot select from is still refused under RLS, so this reports on
  -- the connection's own status column instead.
  (c.status = 'connected') as is_live
from public.integration_connections c
left join public.employees e on e.id = c.employee_id;

comment on table public.integration_secrets is
  'OAuth tokens. RLS on with NO policies and grants revoked: service role only, '
  'i.e. Edge Functions. Never add a policy here — the workspace runs the anon '
  'key in the browser.';
comment on table public.integration_connections is
  'Per-mailbox / per-account integration metadata. Safe for staff to read; the '
  'tokens live in integration_secrets.';
