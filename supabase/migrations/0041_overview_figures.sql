-- 0041_overview_figures.sql — the Overview's figures, counted the way they read.
--
-- The audit of the Overview (2026-09-14) found four ways its figures misled:
--
--   * "vs. last month" set this month so far beside the whole of last month, so
--     every month looked like a slump until its last few days.
--   * "Today" and "this month" were UTC days and months. In the evening in New
--     York "today" had already become tomorrow, and the tile disagreed with the
--     agenda next to it.
--   * Revenue and outstanding invoices added every currency together and
--     labelled the sum USD.
--   * Revenue was every positive transaction. A card payment taken through
--     Stripe counted twice — as Stripe's charge, and again when Stripe paid it
--     into the bank — a transfer between the studio's own accounts counted as
--     income on one side and spending on the other, and a payment still pending
--     counted as if it had arrived.
--
-- Now:
--
--   * Last month is counted up to the same day of the month — or its last day,
--     when it is shorter: August 1–14 beside September 1–14 (overview_window).
--   * The functions take the viewer's time zone, p_tz, an IANA name such as
--     'America/New_York'. Anything else is UTC (overview_zone).
--   * Money stays in its own currency. The Overview shows the studio's currency
--     (studio_currency: the 'base_currency' workspace setting, else the first
--     active finance account's currency, which the admin bills in, else USD)
--     and lists every other currency beside it, never added in.
--   * Each transaction says what it is (finance_transactions.kind, as the sync
--     that stored it read it), and finance_figures decides from that — never
--     from the sign alone — whether it counts as revenue, as an expense, or as
--     neither. Revenue is money that reached the studio: a card payment counts
--     once, when Stripe's payout of it arrives in the bank.
--   * The revenue figures read only the days they show, and the finance
--     policies ask who is looking once a query rather than once a row.
--
-- Every new argument has a default, so a caller that passes none — the
-- workspace as it is live today — still gets an answer, in UTC and the studio's
-- currency. The old signatures are dropped first: two functions that both
-- match a call without arguments leave PostgREST unable to choose.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── The finance tables, all at once ──────────────────────────────────────
-- This migration alters the four finance tables, and altering a table locks it
-- against every other query until the migration commits. Waiting in line for
-- such a lock stalls everything that asks for the table meanwhile, and waiting
-- for one while holding another can deadlock, because what uses these tables
-- takes them in different orders: a sync's upsert takes finance_transactions
-- and then, for its foreign keys, finance_accounts and finance_categories; the
-- Overview takes finance_transactions and then finance_invoices before this
-- migration, and finance_accounts first after it. No one order suits them all.
--
-- So the migration never waits in line. It asks for all four at once without
-- waiting — and for finance_figures, which it makes again below, when it is
-- pushed again. If any is in use, it lets go of what it got and tries again 10
-- to 30 ms later, for up to 5 seconds, then gives up with nothing changed. Once
-- it has them it keeps them until it commits, and nothing below waits for a
-- lock the syncs or the Overview could hold, so they wait only while the rest
-- of the migration runs. The lock is taken in a DO block, as in 0045, because
-- supabase db push sends the file as one pipeline without BEGIN, which refuses
-- a bare LOCK TABLE; a try that succeeds leaves its BEGIN … EXCEPTION block,
-- and its locks stay held until the file's transaction ends. So the file runs
-- as one transaction — supabase db push, or psql -1. Under plain psql -f the
-- locks end with this block, and each ALTER below waits in line on its own.
do $$
declare
  v_started constant timestamptz := clock_timestamp();
  v_try int := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table public.finance_transactions, public.finance_accounts,
                 public.finance_categories, public.finance_invoices
        in access exclusive mode nowait;
      if to_regclass('public.finance_figures') is not null then
        lock table public.finance_figures in access exclusive mode nowait;
      end if;
      exit;
    exception when lock_not_available then
      if clock_timestamp() - v_started >= interval '5 seconds' then
        raise exception '0041: the finance tables stayed busy for 5 seconds (% tries) — something was using them: a sync, the Overview, a vacuum or a backup. Nothing was changed, so running the push again is safe.', v_try
          using errcode = 'lock_not_available';
      end if;
    end;
    perform pg_sleep(0.01 + random() * 0.02);
  end loop;
  raise notice '0041: the finance tables were locked on try % after % ms',
    v_try, round(extract(epoch from clock_timestamp() - v_started) * 1000);
end
$$;

-- ── Which time zone, which currency, which days ──────────────────────────

create or replace function public.overview_zone(p_tz text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  -- An IANA name, or UTC. 'EST' is a fixed offset all year and 'UTC+3' is read
  -- POSIX-style as UTC−3: both would be quietly wrong, so they count as unknown.
  if p_tz is null or (p_tz <> 'UTC' and position('/' in p_tz) = 0) then
    return 'UTC';
  end if;
  perform now() at time zone p_tz;
  return p_tz;
exception when others then
  return 'UTC';
end;
$$;

comment on function public.overview_zone(text) is
  'The time zone to count days and months in: p_tz when it is UTC or an IANA '
  'name Postgres recognises, UTC otherwise (0041).';

-- Security invoker: settings and finance accounts are managers' to read, so
-- for anyone else this is simply USD — and they are shown no money anyway.
create or replace function public.studio_currency()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select upper(trim(s.value))
       from public.workspace_settings s
      where s.key = 'base_currency' and trim(coalesce(s.value, '')) ~* '^[a-z]{3}$'),
    (select upper(trim(a.currency))
       from public.finance_accounts a
      where a.active and trim(a.currency) ~* '^[a-z]{3}$'
      order by a.name
      limit 1),
    'USD');
$$;

comment on function public.studio_currency() is
  'The currency the Overview shows money in: the base_currency workspace setting, '
  'else the first active finance account''s currency (what the admin bills in), '
  'else USD (0041).';

-- The month p_today is in, and the stretch of last month it is compared with:
-- up to the same day, or last month's last day when it has fewer.
create or replace function public.overview_window(p_today date)
returns table (month_start date, prev_start date, prev_through date)
language sql
immutable
set search_path = ''
as $$
  select s.month_start,
         p.prev_start,
         least(p.prev_start + (p_today - s.month_start), s.month_start - 1)
  from (select make_date(extract(year from p_today)::int, extract(month from p_today)::int, 1) as month_start) s
  cross join lateral (select (s.month_start - interval '1 month')::date as prev_start) p;
$$;

comment on function public.overview_window(date) is
  'This month so far, and last month up to the same day (or its last day): '
  'what the Overview''s trend compares (0041).';

-- ── Finance policies ask once ────────────────────────────────────────────
-- 0005's "manager all finance …" policies called is_manager() for every row a
-- query read, and every call reads employees: the revenue figures slowed with
-- every transaction ever stored. In a sub-select it is asked once a query —
-- the same answer, since nothing in one query changes who is asking.

alter policy "manager all finance accounts" on public.finance_accounts
  using ((select public.is_manager())) with check ((select public.is_manager()));
alter policy "manager all finance categories" on public.finance_categories
  using ((select public.is_manager())) with check ((select public.is_manager()));
alter policy "manager all finance invoices" on public.finance_invoices
  using ((select public.is_manager())) with check ((select public.is_manager()));
alter policy "manager all finance transactions" on public.finance_transactions
  using ((select public.is_manager())) with check ((select public.is_manager()));

-- ── What a transaction is ────────────────────────────────────────────────
-- As the sync that stored it read it: income, or a refund of income; a fee or
-- other spending; a payout from Stripe to the bank, or Stripe taking a balance
-- back; a transfer between the studio's own accounts; an adjustment; or bank
-- interest. sync-stripe (_shared/stripe-kind.ts) and sync-mercury
-- (sync-mercury/kind.ts) write it. Rows stored before it existed are given one
-- below, and so is a synced row that arrives without one; one entered by hand
-- may have none.

alter table public.finance_transactions
  add column if not exists kind text;

do $$
begin
  alter table public.finance_transactions
    add constraint finance_transactions_kind_check
    check (kind is null or kind in ('income', 'refund', 'fee', 'expense', 'payout', 'transfer', 'adjustment', 'interest'));
exception when duplicate_object then null;
end $$;

-- What a synced transaction without a kind most likely is. Stripe's
-- description falls back to its reporting category, which names a payout, a
-- refund, a dispute or a fee. Money Stripe moved into or out of the bank is a
-- payout either way — when the description starts with it ("STRIPE PAYOUT",
-- "payout_failure"), not when a charge's own description only mentions one
-- ("Creator payout toolkit, invoice 7"). Stripe is known as sync-mercury/kind.ts
-- knows it: by its own names — Stripe, Stripe, Inc., Stripe Payments Europe,
-- Ltd. — never Pinstripe or The Stripe Agency, or by a bank description that
-- starts with the word; so a client whose own name starts with it, on a wire
-- described "STRIPE STUDIO LLC WIRE", is taken for Stripe here as it is by the
-- sync. Only Mercury's own kind, which the sync sees and this does not,
-- tells a card payment apart: here a card descriptor ("STRIPE* FIGMA") is read
-- by its sign, and a card payment to Stripe itself is taken for a payout.
-- Anything else by its sign. A sync run again replaces the guess with what it
-- knows.
create or replace function public.finance_kind_guess(
  p_source text, p_amount numeric, p_description text, p_counterparty text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_source = 'stripe' and coalesce(p_description, '') ~* '^\s*(stripe\s+)?payout' then 'payout'
    when p_source = 'stripe' and p_amount < 0 and coalesce(p_description, '') ~* 'refund|dispute|chargeback' then 'refund'
    when p_source = 'stripe' and p_amount < 0 and coalesce(p_description, '') ~* '(^|[^a-z])fee' then 'fee'
    when p_source = 'mercury' and p_amount <> 0
     and (coalesce(p_counterparty, '') ~* '^\s*stripe(,?\s+(inc|incorporated|llc|ltd|limited|corp|corporation|co|company))?\.?\s*$'
          or coalesce(p_counterparty, '') ~* '^\s*stripe\s+(payments|technology)\M'
          or (coalesce(p_description, '') ~* '^\s*stripe\M' and coalesce(p_description, '') !~* '^\s*stripe\s*\*'))
      then 'payout'
    when p_amount > 0 then 'income'
    else 'expense'
  end;
$$;

-- A synced row that arrives without a kind — inserted or updated by a sync that
-- predates it, until its new version is deployed — is given the guess rather
-- than read by its sign. A row keeps the kind it has when a later update does
-- not name one: a kind a sync wrote, and a guess too, even when what the row
-- says has changed since — a row stored as "Transaction" and updated to
-- "STRIPE TRANSFER" stays what it was guessed to be until a sync writes its
-- kind. An update that takes the kind away is given the guess again, and a row
-- entered by hand or imported from a file keeps none.
create or replace function public.finance_transactions_kind()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is null and new.source in ('stripe', 'mercury') then
    new.kind := public.finance_kind_guess(new.source, new.amount, new.description, new.counterparty);
  end if;
  return new;
end;
$$;

revoke all on function public.finance_transactions_kind() from public, anon;

drop trigger if exists finance_transactions_kind on public.finance_transactions;
create trigger finance_transactions_kind
  before insert or update on public.finance_transactions
  for each row execute function public.finance_transactions_kind();

update public.finance_transactions
set kind = public.finance_kind_guess(source, amount, description, counterparty)
where kind is null
  and source in ('stripe', 'mercury');

-- The payouts that reached a synced bank account, looked up by amount for each
-- of Stripe's own payouts (finance_figures, below).
create index if not exists finance_tx_bank_payouts_idx
  on public.finance_transactions (amount, posted_at)
  where kind = 'payout' and source <> 'stripe';

-- ── What a transaction counts towards ────────────────────────────────────
-- counts_as: 'revenue', 'expense', or nothing (null); counted: the amount as it
-- counts. Revenue is money that reached the studio from its clients, less what
-- went back to them; expenses are what it spent, less what came back — both
-- summed with their signs. Transfers between the studio's own accounts,
-- adjustments and bank interest count as neither, a payment still pending
-- counts once it has arrived, and a transaction entered by hand with no kind is
-- read by its sign.
--
-- A card payment counts once: when Stripe's payout of it arrives in the bank,
-- net of Stripe's fees and of the refunds the payout already left out. Stripe's
-- own rows — its charges, refunds and fees — are the detail behind that payout,
-- and count as neither. The exception is a payout no synced bank account
-- received — one to an account the workspace does not see — which counts from
-- Stripe's side: when no posted payout of that amount, the other way, in that
-- currency, reached a synced account from the day before it to fourteen days
-- after. A deposit the bank still shows as pending has not arrived, so until it
-- posts, Stripe's payout counts in its place; a Stripe payout still pending
-- counts as neither.
--
-- So a month reads the same however long ago Stripe was last synced. Counting
-- Stripe's charges instead needed its rows to cover exactly the charges in each
-- payout, and was off by as much as a month's card income at the edges of what
-- the Stripe sync had stored. A card payment shows in the month its deposit
-- posted — a few days after it was made on Stripe's daily schedule, the month
-- after on a monthly one — or, while no deposit matches its payout, on the day
-- Stripe paid it out. Four limits:
--
--   * a payout converted into another currency on its way to the bank counts
--     in both;
--   * two payouts of the same amount within those fifteen days, one to a
--     synced account and one to an account the workspace does not see, count
--     as one;
--   * while a payout is on its way, a deposit of the same amount from the day
--     before it onwards stands in for it, so a retainer paid out day after day
--     can read a day or two's payouts short until they land;
--   * a payout that fails or is cancelled comes back to Stripe as a payout of
--     its own (payout_failure, payout_cancel), which counts against revenue on
--     the day it comes back, while the failed payout counted on the day it was
--     sent — in two different months when a month ends in between. When the
--     same amount is then paid out again and reaches the bank within fourteen
--     days, that deposit stands in for the failed payout too, and revenue reads
--     the amount short. Nothing pairs a failure with the payout it undoes.
--
-- A view rather than a function: a function with its own search_path is never
-- inlined, and ran once for every transaction summed. Its columns are named,
-- so a column added to finance_transactions later changes nothing here.
drop view if exists public.finance_figures;
create view public.finance_figures
with (security_invoker = true)
as
select t.id, t.account_id, t.external_id, t.posted_at, t.description, t.counterparty, t.amount, t.currency,
       t.category_id, t.status, t.source, t.kind, t.note, t.created_at,
       f.counts_as,
       case when f.counts_as is null then null
            when t.source = 'stripe' then -t.amount
            else t.amount
       end as counted
from public.finance_transactions t
cross join lateral (
  select case
    when t.status is distinct from 'posted' then null
    when t.source = 'stripe' then
      case when t.kind = 'payout'
            and not exists (
                  select 1
                  from public.finance_transactions d
                  where d.kind = 'payout'
                    and d.source <> 'stripe'
                    and d.status = 'posted'
                    and d.amount = -t.amount
                    and d.posted_at between t.posted_at - 1 and t.posted_at + 14
                    and upper(trim(d.currency)) = upper(trim(t.currency)))
           then 'revenue'
      end
    when t.kind is null then case when t.amount > 0 then 'revenue' when t.amount < 0 then 'expense' end
    when t.kind in ('income', 'refund', 'payout') then 'revenue'
    when t.kind in ('expense', 'fee') then 'expense'
  end as counts_as
) f;

comment on view public.finance_figures is
  'Every finance transaction with what the figures count it towards (counts_as: '
  'revenue, expense, or neither) and the amount it counts (counted) — money that '
  'reached the studio, a card payment once as its payout. Security invoker, so '
  'managers only; read-only (0041).';

revoke all on function public.finance_kind_guess(text, numeric, text, text) from public, anon;
grant execute on function public.finance_kind_guess(text, numeric, text, text) to authenticated, service_role;
revoke all on public.finance_figures from public, anon, authenticated, service_role;
grant select on public.finance_figures to authenticated, service_role;

-- Revenue this month and in last month's matching stretch, per currency. The
-- syncs date income in UTC, so a caller in the evening west of Greenwich passes
-- p_last_posted as UTC's today: that income belongs on today's figures, and
-- last month is then counted to that day too, so the two stretches are as long.
-- Never past this month's last day: on the evening of September 30 in New
-- York, what the syncs dated October 1 is October's, as the chart and the mix
-- count it. The window is worked out here, as overview_window() does: that
-- function is never inlined, and joined to the transactions it read every one
-- of them. Each of the window's days is asked for once, so the posted_at index
-- reads only between them and nothing is worked out again for every row read.
create or replace function public.revenue_by_currency(p_today date, p_last_posted date default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with w as (
    select m.month_start,
           p.prev_start,
           least(p.prev_start + (d.posted_to - m.month_start), m.month_start - 1) as prev_through,
           d.posted_to
    from (select make_date(extract(year from p_today)::int, extract(month from p_today)::int, 1) as month_start) m
    cross join lateral (select (m.month_start - interval '1 month')::date as prev_start) p
    cross join lateral (select least(greatest(p_today, coalesce(p_last_posted, p_today)),
                                     (m.month_start + interval '1 month')::date - 1) as posted_to) d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', r.currency, 'month', r.month_total, 'previous', r.previous_total)
         order by r.currency = b.currency desc, r.currency), '[]'::jsonb)
  from (select public.studio_currency() as currency) b
  cross join (
    select upper(trim(t.currency)) as currency,
           coalesce(sum(t.counted) filter (where t.posted_at >= (select month_start from w)), 0) as month_total,
           coalesce(sum(t.counted) filter (where t.posted_at <  (select month_start from w)), 0) as previous_total
    from public.finance_figures t
    where t.counts_as = 'revenue'
      and t.posted_at between (select prev_start from w) and (select posted_to from w)
      and (t.posted_at >= (select month_start from w) or t.posted_at <= (select prev_through from w))
    group by upper(trim(t.currency))
  ) r;
$$;

comment on function public.revenue_by_currency(date, date) is
  'Revenue per currency (finance_figures): this month to p_today, or to p_last_posted '
  'when that is later but still this month, and last month to the same day. '
  'Security invoker, so managers only (0041).';

revoke all on function public.overview_zone(text) from public, anon;
grant execute on function public.overview_zone(text) to authenticated, service_role;
revoke all on function public.studio_currency() from public, anon;
grant execute on function public.studio_currency() to authenticated, service_role;
revoke all on function public.overview_window(date) from public, anon;
grant execute on function public.overview_window(date) to authenticated, service_role;
revoke all on function public.revenue_by_currency(date, date) from public, anon;
grant execute on function public.revenue_by_currency(date, date) to authenticated, service_role;

-- ── The Overview tiles ───────────────────────────────────────────────────

drop function if exists public.workspace_overview();

create or replace function public.workspace_overview(p_tz text default 'UTC')
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_tz        text        := public.overview_zone(p_tz);
  v_today     date        := (now() at time zone v_tz)::date;
  v_posted_to date        := greatest(v_today, (now() at time zone 'UTC')::date);
  v_day_from  timestamptz := v_today::timestamp at time zone v_tz;
  v_day_to    timestamptz := (v_today + 1)::timestamp at time zone v_tz;
  v_manager   boolean     := public.is_manager();
  v_me        uuid        := public.active_employee_id();
  v_currency  text;
  v_through   date;
  v_revenue   jsonb;
  v_main      jsonb;
  v_owed      jsonb;
  v_invoices  jsonb;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  if v_manager then
    v_currency := public.studio_currency();
    -- Last month runs to the day this month's revenue runs to — UTC's today
    -- when that is later, but never past this month — as revenue_by_currency
    -- counts it, so the day the tile names is the day it counted to.
    select w.prev_through into v_through
    from public.overview_window(v_today) m
    cross join lateral public.overview_window(least(v_posted_to, (m.month_start + interval '1 month')::date - 1)) w;
    v_revenue := public.revenue_by_currency(v_today, v_posted_to);

    select e into v_main
    from jsonb_array_elements(v_revenue) e
    where e ->> 'currency' = v_currency;

    select coalesce(jsonb_agg(jsonb_build_object(
             'currency', i.currency, 'count', i.n, 'amount', i.total, 'due_next', i.due_next)
           order by i.currency = v_currency desc, i.n desc, i.currency), '[]'::jsonb)
      into v_invoices
    from (
      select upper(trim(currency)) as currency, count(*) as n, sum(amount) as total, min(due_on) as due_next
      from public.finance_invoices
      where status in ('sent', 'overdue')
      group by upper(trim(currency))
    ) i;

    -- One currency's invoices, every figure its own: the studio's currency when
    -- anything is owed in it, otherwise the currency with the most invoices.
    v_owed := v_invoices -> 0;
    v_invoices := jsonb_build_object(
      'count',       coalesce((v_owed ->> 'count')::int, 0),
      'currency',    coalesce(v_owed ->> 'currency', v_currency),
      'amount',      coalesce((v_owed ->> 'amount')::numeric, 0),
      'due_next',    (v_owed ->> 'due_next')::date,
      'by_currency', v_invoices
    );
  end if;

  return jsonb_build_object(
    'as_of',                now(),
    'time_zone',            v_tz,
    'today',                v_today,
    'revenue_currency',     v_currency,
    'revenue_month',        case when v_manager then coalesce((v_main ->> 'month')::numeric, 0) end,
    'revenue_prev_month',   case when v_manager then coalesce((v_main ->> 'previous')::numeric, 0) end,
    'revenue_prev_through', v_through,
    'revenue_by_currency',  v_revenue,
    'invoices_outstanding', v_invoices,
    'tickets_open',     (select count(*) from public.support_tickets
                          where status in ('open', 'in_progress', 'waiting') and deleted_at is null),
    'tickets_high',     (select count(*) from public.support_tickets
                          where status in ('open', 'in_progress', 'waiting') and deleted_at is null
                            and priority in ('high', 'urgent')),
    'projects_active',  (select count(*) from public.client_projects
                          where status in ('discovery', 'in_progress', 'in_review') and deleted_at is null),
    'tasks_open',       (select count(*) from public.tasks where status <> 'done'),
    'tasks_mine',       (select count(*) from public.tasks
                          where status <> 'done' and assignee_id = v_me),
    'events_today',     (select count(*) from public.calendar_events
                          where status <> 'cancelled'
                            and starts_at >= v_day_from
                            and starts_at <  v_day_to)
  );
end;
$$;

revoke all on function public.workspace_overview(text) from public, anon;
grant execute on function public.workspace_overview(text) to authenticated;

comment on function public.workspace_overview(text) is
  'One round trip for the Overview tiles, with days and months counted in p_tz. '
  'Money is null for non-managers, and otherwise in revenue_currency (the '
  'studio''s), with every currency in revenue_by_currency and '
  'invoices_outstanding.by_currency. revenue_prev_month runs to '
  'revenue_prev_through: last month up to the day this month''s revenue runs to (0041).';

-- ── The revenue chart ────────────────────────────────────────────────────

drop function if exists public.revenue_series(int);

create or replace function public.revenue_series(p_months int default 6, p_tz text default 'UTC', p_currency text default null)
returns table (month date, revenue numeric, expenses numeric, currency text)
language sql
stable
security invoker
set search_path = public
as $$
  with here as (
    select l.today,
           m.month_start,
           least(greatest(l.today, (now() at time zone 'UTC')::date),
                 (m.month_start + interval '1 month')::date - 1) as posted_to
    from (select (now() at time zone public.overview_zone(p_tz))::date as today) l
    cross join lateral (select make_date(extract(year from l.today)::int, extract(month from l.today)::int, 1) as month_start) m
  ),
  main as (
    select case when upper(trim(coalesce(p_currency, ''))) ~ '^[A-Z]{3}$'
                then upper(trim(p_currency))
                else public.studio_currency()
           end as currency
  ),
  span as (
    select generate_series(
             (select month_start from here) - ((greatest(least(p_months, 24), 1) - 1) * interval '1 month'),
             (select month_start from here),
             interval '1 month'
           )::date as month
  ),
  -- Every month's transactions in one range the posted_at index can use. The
  -- current month runs to UTC's today when that is later, like the tile, for
  -- income the syncs dated in UTC — but not into next month.
  counted as (
    select date_trunc('month', t.posted_at)::date as month, t.counted, t.counts_as
    from public.finance_figures t
    where t.counts_as is not null
      and t.posted_at >= (select min(month) from span)
      and t.posted_at <= (select posted_to from here)
      and upper(trim(t.currency)) = (select currency from main)
  )
  select s.month,
         coalesce(sum(c.counted) filter (where c.counts_as = 'revenue'), 0) as revenue,
         coalesce(-(sum(c.counted) filter (where c.counts_as = 'expense')), 0) as expenses,
         (select currency from main) as currency
  from span s
  left join counted c on c.month = s.month
  where public.is_manager()
  group by s.month
  order by s.month;
$$;

revoke all on function public.revenue_series(int, text, text) from public, anon;
grant execute on function public.revenue_series(int, text, text) to authenticated;

comment on function public.revenue_series(int, text, text) is
  'Monthly income and expenditure in one currency — p_currency, or the studio''s — '
  'with months counted in p_tz. Empty months are zero rather than missing; a '
  'non-manager gets no rows (0041).';

-- ── The revenue mix ──────────────────────────────────────────────────────

drop function if exists public.revenue_mix(int);

create or replace function public.revenue_mix(p_months int default 1, p_tz text default 'UTC', p_currency text default null)
returns table (category text, amount numeric, share numeric, currency text)
language sql
stable
security invoker
set search_path = public
as $$
  with here as (
    select m.month_start,
           least(greatest(l.today, (now() at time zone 'UTC')::date),
                 (m.month_start + interval '1 month')::date - 1) as posted_to
    from (select (now() at time zone public.overview_zone(p_tz))::date as today) l
    cross join lateral (select make_date(extract(year from l.today)::int, extract(month from l.today)::int, 1) as month_start) m
  ),
  main as (
    select case when upper(trim(coalesce(p_currency, ''))) ~ '^[A-Z]{3}$'
                then upper(trim(p_currency))
                else public.studio_currency()
           end as currency
  ),
  window_tx as (
    select t.counted as amount, coalesce(c.name, 'Uncategorised') as category
    from public.finance_figures t
    left join public.finance_categories c on c.id = t.category_id
    where public.is_manager()
      and t.counts_as = 'revenue'
      and upper(trim(t.currency)) = (select currency from main)
      and t.posted_at <= (select posted_to from here)
      and t.posted_at >= ((select month_start from here)
                          - ((greatest(least(p_months, 24), 1) - 1) * interval '1 month'))::date
  ),
  -- A share is of the categories listed, so the shares add up to 100: a
  -- category that gave back more than it took in — Stripe taking a balance
  -- back, filed under none — is not listed, and takes nothing off the total.
  totals as (
    select coalesce(sum(k.amount), 0) as total
    from (select sum(amount) as amount from window_tx group by category having sum(amount) > 0) k
  )
  select w.category,
         sum(w.amount) as amount,
         case when (select total from totals) > 0
              then round(100 * sum(w.amount) / (select total from totals), 1)
              else 0
         end as share,
         (select currency from main) as currency
  from window_tx w
  group by w.category
  having sum(w.amount) > 0
  order by sum(w.amount) desc;
$$;

revoke all on function public.revenue_mix(int, text, text) from public, anon;
grant execute on function public.revenue_mix(int, text, text) to authenticated;

comment on function public.revenue_mix(int, text, text) is
  'This month''s income in one currency — p_currency, or the studio''s — grouped '
  'by finance category, with the month counted in p_tz. Uncategorised income is '
  'labelled rather than dropped; a category that gave back more than it took in '
  'is left out, and each share is of the categories listed (0041).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  missing text;
begin
  select string_agg(f.fn, ', ') into missing
  from unnest(array['overview_zone', 'studio_currency', 'overview_window', 'revenue_by_currency',
                    'workspace_overview', 'revenue_series', 'revenue_mix',
                    'finance_kind_guess', 'finance_transactions_kind']) as f(fn)
  where (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = f.fn) <> 1;
  if missing is not null then
    raise exception '0041: expected exactly one of each, not so for: %', missing;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.finance_transactions'::regclass
                   and conname = 'finance_transactions_kind_check' and convalidated) then
    raise exception '0041: finance_transactions.kind has no rule';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.finance_transactions'::regclass
                   and tgname = 'finance_transactions_kind' and not tgisinternal) then
    raise exception '0041: nothing gives a synced transaction without a kind its guess';
  end if;
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and tablename = 'finance_transactions'
                   and indexname = 'finance_tx_bank_payouts_idx') then
    raise exception '0041: the index finance_figures looks bank payouts up by is missing';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                 where ns.nspname = 'public' and c.relname = 'finance_figures' and c.relkind = 'v'
                   and 'security_invoker=true' = any (coalesce(c.reloptions, '{}'::text[]))) then
    raise exception '0041: finance_figures is missing, or runs as its owner';
  end if;
  if has_table_privilege('anon', 'public.finance_figures', 'select')
     or not has_table_privilege('authenticated', 'public.finance_figures', 'select')
     or has_table_privilege('authenticated', 'public.finance_figures', 'insert, update, delete')
     or has_table_privilege('service_role', 'public.finance_figures', 'insert, update, delete') then
    raise exception '0041: finance_figures is not read-only for staff and the service role, or anon can read it';
  end if;
  select string_agg(p.tablename::text, ', ') into missing
  from pg_policies p
  where p.schemaname = 'public'
    and p.policyname in ('manager all finance accounts', 'manager all finance categories',
                         'manager all finance transactions', 'manager all finance invoices')
    and not (p.qual ilike '%select%is_manager()%' and p.with_check ilike '%select%is_manager()%');
  if missing is not null then
    raise exception '0041: these finance policies still ask once a row: %', missing;
  end if;
  if exists (select 1 from public.finance_transactions where kind is null and source in ('stripe', 'mercury')) then
    raise exception '0041: synced transactions were left without a kind';
  end if;
end
$$;
