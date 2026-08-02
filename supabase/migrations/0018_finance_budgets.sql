-- =============================================================================
-- Monthly category budgets: let managers set a spending target per category
-- and see how actual spending tracks against it this month.
--
-- `category` matches finance_transactions.category (free-text). `period` is
-- always 'monthly' for now — the check constraint leaves room to extend.
-- Unique on (category, period) so upsert-on-conflict works cleanly.
-- =============================================================================

create table if not exists public.finance_budgets (
  id         uuid         primary key default gen_random_uuid(),
  category   text         not null,
  amount     numeric(12,2) not null check (amount > 0),
  period     text         not null default 'monthly' check (period in ('monthly')),
  created_at timestamptz  not null default now(),
  updated_at timestamptz  not null default now(),
  unique (category, period)
);

alter table public.finance_budgets enable row level security;

create policy "managers read budgets"
  on public.finance_budgets for select
  to authenticated
  using (is_manager());

create policy "managers insert budgets"
  on public.finance_budgets for insert
  to authenticated
  with check (is_manager());

create policy "managers update budgets"
  on public.finance_budgets for update
  to authenticated
  using (is_manager())
  with check (is_manager());

create policy "managers delete budgets"
  on public.finance_budgets for delete
  to authenticated
  using (is_manager());
