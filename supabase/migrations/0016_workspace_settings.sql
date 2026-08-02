-- =============================================================================
-- Workspace-wide key/value settings stored in the DB so managers can
-- configure things (like bank remittance details on invoices) through the
-- admin UI instead of needing CLI access to set Supabase secrets.
--
-- Values are plain text — callers are responsible for how they interpret them.
-- Bank routing/account numbers are the primary use-case; they are no more
-- sensitive than the financial data already stored in finance_transactions.
-- =============================================================================

create table if not exists public.workspace_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table public.workspace_settings enable row level security;

-- Managers can read all settings.
create policy "managers read settings"
  on public.workspace_settings for select
  to authenticated
  using (is_manager());

-- Managers can insert new keys.
create policy "managers insert settings"
  on public.workspace_settings for insert
  to authenticated
  with check (is_manager());

-- Managers can update existing keys.
create policy "managers update settings"
  on public.workspace_settings for update
  to authenticated
  using (is_manager())
  with check (is_manager());
