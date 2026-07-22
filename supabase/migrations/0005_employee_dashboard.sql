-- =============================================================================
-- Veyago — Employee dashboard v1: employees + roles, onboarding, tasks, finance.
--
-- Run ONCE in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Idempotent where practical, so re-running is safe.
--
-- Security model (same as 0001): supabase-js runs in the BROWSER with the anon
-- key. RLS is the ONLY boundary. New pattern in this migration: PRIVATE tables
-- (employees, onboarding, tasks, finance) have NO anonymous access at all.
--
-- Roles: 'owner' and 'admin' see everything (incl. finance). 'assistant' and
-- 'employee' see the team directory, their own onboarding, and their tasks.
-- The public.admins allowlist keeps gating site-content writes as before.
--
-- After running this, deploy the Edge Functions in supabase/functions/ and set
-- secrets (see supabase/functions/README section in each function header):
--   supabase functions deploy invite-employee sync-mercury sync-stripe
--   supabase secrets set MERCURY_API_KEY=... STRIPE_SECRET_KEY=...
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Fix: 0001 only created a SELECT policy on public.admins, so the Users page
-- grant/revoke buttons were blocked by RLS. Admins may now manage the list.
-- ---------------------------------------------------------------------------
drop policy if exists "admin writes admins" on public.admins;
create policy "admin writes admins"
  on public.admins for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Employees. One row per team member. user_id links to auth.users once the
-- person accepts their invite (the invite-employee Edge Function fills it in).
-- ---------------------------------------------------------------------------
create table if not exists public.employees (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid unique references auth.users(id) on delete set null,
  email      text unique not null,
  full_name  text not null,
  role       text not null default 'employee' check (role in ('owner','admin','assistant','employee')),
  title      text,                                            -- job title, e.g. Personal Assistant
  status     text not null default 'invited' check (status in ('invited','active','inactive')),
  start_date date,
  phone      text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists employees_touch_updated_at on public.employees;
create trigger employees_touch_updated_at
  before update on public.employees
  for each row execute function public.touch_updated_at();

-- Role helpers. SECURITY DEFINER like is_admin() so policies can consult the
-- employees table regardless of the caller's own row visibility.
create or replace function public.employee_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.employees where user_id = auth.uid() and status <> 'inactive';
$$;

-- Any active team member (owner/admin/assistant/employee) OR a legacy admin.
create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_admin() or public.employee_role() is not null;
$$;

-- Finance + team management: owners/admins only.
create or replace function public.is_manager()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_admin() or public.employee_role() in ('owner','admin');
$$;

alter table public.employees enable row level security;

drop policy if exists "staff read employees" on public.employees;
create policy "staff read employees"                          -- team directory
  on public.employees for select
  using (public.is_staff());

drop policy if exists "manager writes employees" on public.employees;
create policy "manager writes employees"
  on public.employees for all
  using (public.is_manager())
  with check (public.is_manager());

-- ---------------------------------------------------------------------------
-- Onboarding. A single global checklist (onboarding_items) + per-employee
-- progress rows. Managers curate the checklist; new hires tick their own items.
-- ---------------------------------------------------------------------------
create table if not exists public.onboarding_items (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  category    text not null default 'general',                -- e.g. accounts, legal, tools
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.onboarding_progress (
  employee_id uuid not null references public.employees(id) on delete cascade,
  item_id     uuid not null references public.onboarding_items(id) on delete cascade,
  done        boolean not null default false,
  done_at     timestamptz,
  note        text,
  primary key (employee_id, item_id)
);

alter table public.onboarding_items    enable row level security;
alter table public.onboarding_progress enable row level security;

drop policy if exists "staff read onboarding items" on public.onboarding_items;
create policy "staff read onboarding items"
  on public.onboarding_items for select
  using (public.is_staff());

drop policy if exists "manager writes onboarding items" on public.onboarding_items;
create policy "manager writes onboarding items"
  on public.onboarding_items for all
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "manager all onboarding progress" on public.onboarding_progress;
create policy "manager all onboarding progress"
  on public.onboarding_progress for all
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "employee own onboarding progress" on public.onboarding_progress;
create policy "employee own onboarding progress"
  on public.onboarding_progress for all
  using (employee_id = (select id from public.employees where user_id = auth.uid()))
  with check (employee_id = (select id from public.employees where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Tasks. Managers assign; assignees update status. Built for the PA workflow.
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  details      text,
  assignee_id  uuid references public.employees(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  status       text not null default 'todo' check (status in ('todo','in_progress','blocked','done')),
  priority     text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_date     date,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on public.tasks (assignee_id, status);
create index if not exists tasks_due_idx      on public.tasks (status, due_date);

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

alter table public.tasks enable row level security;

drop policy if exists "manager all tasks" on public.tasks;
create policy "manager all tasks"
  on public.tasks for all
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "staff read tasks" on public.tasks;
create policy "staff read tasks"                              -- everyone sees the board
  on public.tasks for select
  using (public.is_staff());

drop policy if exists "assignee updates own tasks" on public.tasks;
create policy "assignee updates own tasks"
  on public.tasks for update
  using (assignee_id = (select id from public.employees where user_id = auth.uid()))
  with check (assignee_id = (select id from public.employees where user_id = auth.uid()));

drop policy if exists "staff creates tasks" on public.tasks;
create policy "staff creates tasks"                           -- PA can log tasks for review
  on public.tasks for insert
  with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- Finance. Managers only — no other role sees any of this. Transactions are
-- signed amounts in the account currency; sync functions upsert on
-- (account_id, external_id) so re-syncing never duplicates rows.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_accounts (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,                               -- e.g. Mercury Checking
  kind           text not null default 'manual' check (kind in ('bank','stripe','paypal','manual')),
  provider       text,                                        -- 'mercury', 'stripe', …
  external_id    text,                                        -- provider-side account id
  currency       text not null default 'USD',
  last_synced_at timestamptz,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
-- Sync functions upsert on external_id (NULLs stay distinct for manual accounts).
create unique index if not exists finance_accounts_external_idx
  on public.finance_accounts (external_id);

create table if not exists public.finance_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  kind       text not null default 'expense' check (kind in ('income','expense')),
  sort_order int not null default 0
);

create table if not exists public.finance_transactions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.finance_accounts(id) on delete cascade,
  external_id text,                                           -- provider transaction id
  posted_at   date not null,
  description text not null,
  counterparty text,
  amount      numeric(12,2) not null,                         -- signed: + income, − expense
  currency    text not null default 'USD',
  category_id uuid references public.finance_categories(id) on delete set null,
  status      text not null default 'posted' check (status in ('pending','posted')),
  source      text not null default 'manual' check (source in ('mercury','stripe','manual','csv')),
  note        text,
  created_at  timestamptz not null default now()
);
-- Plain (non-partial) so PostgREST upserts can target it; NULL external_ids
-- (manual entries) are always distinct, so they never collide.
create unique index if not exists finance_tx_external_idx
  on public.finance_transactions (account_id, external_id);
create index if not exists finance_tx_posted_idx on public.finance_transactions (posted_at desc);

create table if not exists public.finance_invoices (
  id         uuid primary key default gen_random_uuid(),
  number     text not null,
  client     text not null,
  amount     numeric(12,2) not null,
  currency   text not null default 'USD',
  status     text not null default 'draft' check (status in ('draft','sent','paid','overdue')),
  issued_on  date,
  due_on     date,
  paid_on    date,
  notes      text,
  created_at timestamptz not null default now()
);

alter table public.finance_accounts     enable row level security;
alter table public.finance_categories   enable row level security;
alter table public.finance_transactions enable row level security;
alter table public.finance_invoices     enable row level security;

drop policy if exists "manager all finance accounts" on public.finance_accounts;
create policy "manager all finance accounts"
  on public.finance_accounts for all
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager all finance categories" on public.finance_categories;
create policy "manager all finance categories"
  on public.finance_categories for all
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager all finance transactions" on public.finance_transactions;
create policy "manager all finance transactions"
  on public.finance_transactions for all
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager all finance invoices" on public.finance_invoices;
create policy "manager all finance invoices"
  on public.finance_invoices for all
  using (public.is_manager()) with check (public.is_manager());

-- ---------------------------------------------------------------------------
-- Seed: starter onboarding checklist + finance categories. Safe to re-run.
-- ---------------------------------------------------------------------------
insert into public.onboarding_items (title, description, category, sort_order)
select v.title, v.description, v.category, v.sort_order
from (values
  ('Sign employment agreement', 'Contract signed and stored', 'legal',    10),
  ('Set up work email',         'Account created and tested', 'accounts', 20),
  ('Enable two-factor auth',    'TOTP enrolled on all tools', 'accounts', 30),
  ('Dashboard access granted',  'Invited to the Veyago dashboard with the right role', 'accounts', 40),
  ('Intro to tools & workflow', 'Walkthrough of the dashboard, tasks, and processes', 'tools', 50),
  ('First-week check-in',       'Review questions and blockers after week one', 'general', 60)
) as v(title, description, category, sort_order)
where not exists (select 1 from public.onboarding_items);

insert into public.finance_categories (name, kind, sort_order)
select v.name, v.kind, v.sort_order
from (values
  ('Sales',           'income',  10),
  ('Other income',    'income',  20),
  ('Software & tools','expense', 30),
  ('Contractors',     'expense', 40),
  ('Payroll',         'expense', 50),
  ('Marketing',       'expense', 60),
  ('Fees',            'expense', 70),
  ('Other expense',   'expense', 80)
) as v(name, kind, sort_order)
where not exists (select 1 from public.finance_categories);
