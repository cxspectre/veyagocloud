-- =============================================================================
-- 0060 — a thicker invoice, and Mercury and Stripe syncing by themselves.
--
-- Two findings from the 2026-09-14 audit, both finance's own:
--
-- PART 1 — a thicker invoice: a number that is really one, when it last
-- changed, tax, and its lines.
--
-- finance_invoices (0005) held one row per invoice: a client, one amount, one
-- currency, one status. Nothing stopped two invoices sharing a number, nothing
-- recorded when an invoice last changed (a manager reading one could not tell
-- a stale copy from a fresh one), and an invoice was a single line — no way to
-- itemise, and no separate figure for tax or VAT the way a real invoice needs.
--
-- What invoice-pdf.ts actually renders (a single "Professional services" line,
-- the total, no tax breakout) does not change here — this is the ledger's own
-- shape catching up to what a manager needs to see and reason about; the
-- document a client receives is invoice-pdf's to change, not the workspace's.
--
-- ── What changes ────────────────────────────────────────────────────────
--   1. number is unique, case- and space-insensitive: "INV-1042" and
--      "inv-1042 " are the same number, and two invoices cannot share one.
--   2. updated_at, moved by a trigger the way every other workspace table
--      already carries one (0001's touch_updated_at()).
--   3. tax_rate (a percentage, e.g. 8.875) and tax_amount (in the invoice's
--      own currency and cents, like amount) are new and optional. amount
--      keeps meaning exactly what it always has — the total charged — so
--      finance-model.js, which reads it and is not touched here, needs no
--      change; tax is additional detail beside the total, not a rename of it
--      or a recomputation.
--   4. finance_invoice_lines: an invoice can be itemised — a description, a
--      quantity, a unit amount and a line amount — rather than the one
--      description on the invoice row standing in for everything billed.
--      Optional: every invoice on the books today is backfilled with one
--      line reading "Professional services", matching the single line
--      invoice-pdf.ts already prints for all of them (below), so the two
--      never disagree about what an existing invoice bills for.
--
-- Policies mirror 0005 and 0040: managers, with their second factor. 0040
-- only reached the tables that existed when it ran (its own header says so),
-- so the new table carries both layers itself, checked below, or
-- supabase/tests/06-second-factor.sql's generic coverage check would fail
-- the moment this table exists.
--
-- PART 2 (§5, below) — Mercury and Stripe sync themselves once a day, the way
-- mail already syncs itself (0038 §9), and integration_connections (0024,
-- whose own provider check already lists 'mercury' and 'stripe') gets a row
-- for each so a manager can see whether the last one worked, instead of
-- finding out only by pressing Settings' "Sync" button and watching it fail.
-- =============================================================================

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. A number that is really one ───────────────────────────────────────
-- Two invoices of the same number, however typed, are one lost in a search
-- and the other found — whichever a manager was not looking for. Existing
-- duplicates stop this migration rather than being renamed by a guess.

do $$
begin
  if exists (select 1 from public.finance_invoices
             group by upper(btrim(number)) having count(*) > 1) then
    raise exception '0060: two invoices share a number (case- and space-insensitive). Renumber one, then run this again.';
  end if;
end
$$;

create unique index if not exists finance_invoices_number_idx
  on public.finance_invoices (upper(btrim(number)));

comment on index public.finance_invoices_number_idx is
  'One invoice per number, whatever its case or the spaces typed around it (0060).';

-- ── 2. When an invoice last changed ──────────────────────────────────────

alter table public.finance_invoices add column if not exists updated_at timestamptz not null default now();

drop trigger if exists finance_invoices_touch_updated_at on public.finance_invoices;
create trigger finance_invoices_touch_updated_at
  before update on public.finance_invoices
  for each row execute function public.touch_updated_at();

comment on column public.finance_invoices.updated_at is
  'Moved by a trigger on every change (0060), like every other workspace table.';

-- ── 3. Tax and VAT, beside the total ─────────────────────────────────────
-- amount stays the total charged, so every existing reader of it keeps
-- working unchanged. These columns are additional detail: null means what it
-- always has, an invoice with no tax recorded.

alter table public.finance_invoices add column if not exists tax_rate numeric(6,3);
alter table public.finance_invoices add column if not exists tax_amount numeric(12,2);

alter table public.finance_invoices drop constraint if exists finance_invoices_tax_rate_check;
alter table public.finance_invoices add constraint finance_invoices_tax_rate_check
  check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));

alter table public.finance_invoices drop constraint if exists finance_invoices_tax_amount_check;
alter table public.finance_invoices add constraint finance_invoices_tax_amount_check
  check (tax_amount is null or tax_amount >= 0);

comment on column public.finance_invoices.tax_rate is
  'A percentage, e.g. 8.875 for 8.875%. Null: no tax recorded on this invoice (0060).';
comment on column public.finance_invoices.tax_amount is
  'The tax charged, in the invoice''s own currency and cents, like amount. Null: no tax recorded (0060).';

-- ── 4. Invoice lines ──────────────────────────────────────────────────────
-- One row on the invoice (0005) stood in for everything billed. A line is
-- optional: an invoice with none reads exactly as before, its own
-- description and amount the whole of it.

create table if not exists public.finance_invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.finance_invoices(id) on delete cascade,
  description text not null,
  quantity    numeric(12,2) not null default 1,
  unit_amount numeric(12,2) not null,
  amount      numeric(12,2) not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists finance_invoice_lines_invoice_idx
  on public.finance_invoice_lines (invoice_id, sort_order);

drop trigger if exists finance_invoice_lines_touch_updated_at on public.finance_invoice_lines;
create trigger finance_invoice_lines_touch_updated_at
  before update on public.finance_invoice_lines
  for each row execute function public.touch_updated_at();

alter table public.finance_invoice_lines enable row level security;

drop policy if exists "manager all finance invoice lines" on public.finance_invoice_lines;
create policy "manager all finance invoice lines"
  on public.finance_invoice_lines for all
  using (public.is_manager()) with check (public.is_manager());

-- 0040 only reached the tables that existed when it ran; a table added since
-- carries this restrictive policy itself, or the second factor gate has a
-- hole the moment this table exists.
drop policy if exists "second factor required" on public.finance_invoice_lines;
create policy "second factor required" on public.finance_invoice_lines
  as restrictive for all to authenticated
  using ((select public.second_factor_met()))
  with check ((select public.second_factor_met()));

comment on table public.finance_invoice_lines is
  'What an invoice bills, itemised. Optional: an invoice with none is exactly '
  'as finance_invoices.amount and .notes always described it (0060).';

-- Every invoice on the books today gets the one line invoice-pdf.ts already
-- prints for it (the literal text "Professional services", _shared/invoice-
-- pdf.ts's only line item), so an existing invoice's lines never disagree
-- with the document it was actually sent as. A future invoice made with real
-- line items is not touched by this: only invoices with none yet are given
-- this one, and running the migration again adds nothing a second time.
insert into public.finance_invoice_lines (invoice_id, description, quantity, unit_amount, amount, sort_order)
select i.id, 'Professional services', 1, i.amount, i.amount, 0
from public.finance_invoices i
where not exists (select 1 from public.finance_invoice_lines l where l.invoice_id = i.id);

do $$
declare v_backfilled int;
begin
  get diagnostics v_backfilled = row_count;
  raise notice '0060: % existing invoices given a single "Professional services" line, matching invoice-pdf.ts', v_backfilled;
end
$$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
begin
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and tablename = 'finance_invoices'
                   and indexname = 'finance_invoices_number_idx') then
    raise exception '0060: nothing stops two invoices sharing a number';
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'finance_invoices'
                   and column_name = 'updated_at') then
    raise exception '0060: finance_invoices has no updated_at';
  end if;

  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.finance_invoices'::regclass
                   and tgname = 'finance_invoices_touch_updated_at'
                   and not tgisinternal) then
    raise exception '0060: nothing moves finance_invoices.updated_at when it changes';
  end if;

  select string_agg(col, ', ') into v_missing
  from unnest(array['tax_rate', 'tax_amount']) as col
  where not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'finance_invoices'
                       and column_name = col);
  if v_missing is not null then
    raise exception '0060: finance_invoices is missing %', v_missing;
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'finance_invoice_lines') then
    raise exception '0060: finance_invoice_lines was not created';
  end if;

  if not exists (select 1 from pg_class c
                 where c.oid = 'public.finance_invoice_lines'::regclass and c.relrowsecurity) then
    raise exception '0060: finance_invoice_lines has no row-level security';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'finance_invoice_lines'
                   and policyname = 'manager all finance invoice lines' and permissive = 'PERMISSIVE'
                   and qual like '%is_manager()%' and with_check like '%is_manager()%')
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'finance_invoice_lines'
                      and policyname = 'second factor required' and permissive = 'RESTRICTIVE'
                      and cmd = 'ALL' and roles = array['authenticated']::name[]
                      and qual like '%second_factor_met%' and with_check like '%second_factor_met%') then
    raise exception '0060: finance_invoice_lines does not have both the manager and second-factor policies';
  end if;

  if exists (select 1 from public.finance_invoices i
             where not exists (select 1 from public.finance_invoice_lines l where l.invoice_id = i.id)) then
    raise exception '0060: an invoice was left with no line at all';
  end if;
end
$$;

-- ── 5. Mercury and Stripe sync by themselves, once a day ─────────────────
--
-- Both currently need a manager signed in to work at all: they read the
-- caller's own session (is_manager()) rather than the service role, so that
-- a leaked sync secret can trigger a sync but never read a studio's money
-- straight out of the database. That is exactly right, and stays — it is not
-- touched here (supabase/functions/sync-mercury/** and sync-stripe/index.ts
-- are both off limits to this change; sync-stripe is a sibling of the same
-- shape, read for this comment, not edited).
--
-- A schedule has no manager to sign in as, so it signs in as one: a studio-
-- owned account made ONLY for this — an owner or admin with NO second factor
-- ever enrolled. 0040 lets a session through at aal1 while its account has no
-- verified factor ("enter the code if you have one" — the same rule an
-- ordinary sign-in without 2FA already relies on); enrolling a factor on this
-- account later would silently stop every scheduled sync from authenticating
-- at all, with no error a person would see without checking here.
--
-- integration_connections (0024) already lists 'mercury' and 'stripe' among
-- its allowed providers and already carries status / last_synced_at /
-- last_error — built for exactly this, just never given a row for either.
-- One studio-wide row each (employee_id null, like the studio's own mailbox
-- connections) is what supabase/functions/sync-finance-scheduled/index.ts
-- (new, not a migration) writes its result to after each run — the Settings
-- screen that already reads this table for mail and calendar needs no change
-- to show these two as well.
insert into public.integration_connections (provider, account_label, status)
select v.provider, v.account_label, 'disconnected'
from (values ('mercury', 'Mercury (scheduled sync)'), ('stripe', 'Stripe (scheduled sync)')) as v(provider, account_label)
where not exists (
  select 1 from public.integration_connections c
  where c.provider = v.provider and c.employee_id is null
);

comment on column public.integration_connections.status is
  'connected/needs_reauth/disconnected/error. For mercury and stripe (0060), '
  'set by sync-finance-scheduled after each run, exactly as a mailbox''s own '
  'sync sets it — disconnected only ever means "never run yet".';

-- Once a day rather than every five minutes, the way mail is scheduled
-- (0038 §9): bank and card data does not need to be near-real-time, and both
-- providers rate-limit far more readily than Graph does. 14 days back on
-- every run — deliberately more than the gap between runs — so a run that
-- fails outright is still fully covered by the next one, and a transaction
-- either provider amends a few days after it first posts (pending settling
-- to posted, a late fee) is re-read rather than left at its first reading.
-- Four secrets, created once by hand, never committed:
--
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as FINANCE_SYNC_SECRET>', 'finance_sync_secret');
--
-- and, read by the function itself rather than by this schedule
-- (`supabase secrets set`): FINANCE_SYNC_SECRET (checked against the header
-- below, exactly as MAIL_SYNC_SECRET already is), and FINANCE_SYNC_EMAIL /
-- FINANCE_SYNC_PASSWORD, the dedicated account's own sign-in.
--
-- Until all four secrets exist the job runs and its request fails harmlessly
-- (the function itself answers 401 or 500, recorded as an error on both
-- providers' rows above); cron.job_run_details and net._http_response say
-- why, the same as mail's schedule.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sync-finance';
  perform cron.schedule(
    'sync-finance',
    '0 3 * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/sync-finance-scheduled',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'finance_sync_secret')
        ),
        body := jsonb_build_object('days', 14),
        timeout_milliseconds := 120000
      );
    $job$
  );
end $$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare v_missing text;
begin
  select string_agg(v.provider, ', ') into v_missing
  from (values ('mercury'), ('stripe')) as v(provider)
  where not exists (
    select 1 from public.integration_connections c
    where c.provider = v.provider and c.employee_id is null
  );
  if v_missing is not null then
    raise exception '0060: no scheduled-sync connection row for %', v_missing;
  end if;

  if not exists (
    select 1 from cron.job
    where jobname = 'sync-finance' and schedule = '0 3 * * *' and active
      and command like '%sync-finance-scheduled%'
      and command like '%finance_sync_secret%'
  ) then
    raise exception '0060: nothing schedules the finance sync';
  end if;

  -- Exactly one job of this name: unschedule-then-schedule (as above, and as
  -- 0038 does for mail) is what keeps a re-run of this migration from
  -- stacking up a second cron.job row that fires the same request twice a day.
  if (select count(*) from cron.job where jobname = 'sync-finance') <> 1 then
    raise exception '0060: sync-finance is scheduled more than once';
  end if;
end
$$;
