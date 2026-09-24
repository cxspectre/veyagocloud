-- 07-overview-figures.sql — the Overview's figures, counted the way they read
-- (0041).
--
-- Money is on fixed dates and checked through overview_window and
-- revenue_by_currency with fixed "todays", so each check means the same on
-- whatever day the suite runs. What only reads the clock — the tiles, the
-- chart and the mix — is checked on days counted from today, so those checks
-- keep their bite as the calendar moves: the studio's currency has money only
-- on such days. What happens only at some hours — UTC's day already the next
-- where the viewer is, and a month's last evening west of UTC — is checked on
-- copies of the mix and the tiles as deployed, with their clock set to those
-- hours; the checks on the real clock that can bite only then say which. It is
-- in XTS and codes beginning XB or XT — ISO 4217's codes for testing and for
-- bond units, and codes next to them that no currency has — so nothing real is
-- in it, and XTS is made the studio's currency for this transaction. The
-- time-zone checks put events on the first and last second of the viewer's
-- day, which is never all of UTC's day. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

-- The mix and the tiles as deployed, with the clock as their first argument —
-- now() in their bodies becomes p_now, and nothing else changes — so what they
-- do on a month's last evening, which the real clock reaches a few hours a
-- month, is asked whenever the suite runs (MONTH END, below).
do $$
declare
  f record;
  v_copy text;
begin
  for f in select * from (values
      ('public.revenue_mix(integer, text, text)', 'public.revenue_mix(', 'pg_temp.revenue_mix_at(p_now timestamptz, '),
      ('public.workspace_overview(text)', 'public.workspace_overview(', 'pg_temp.workspace_overview_at(p_now timestamptz, ')
    ) v(fn, head, copy_head)
  loop
    v_copy := replace(replace(pg_get_functiondef(f.fn::regprocedure),
                              'CREATE OR REPLACE FUNCTION ' || f.head, 'CREATE FUNCTION ' || f.copy_head),
                      'now()', 'p_now');
    if position('CREATE FUNCTION ' || f.copy_head in v_copy) <> 1
       or position('p_now' in substr(v_copy, length('CREATE FUNCTION ' || f.copy_head) + 1)) = 0 then
      raise exception '07: % could not be copied with its clock as an argument', f.fn;
    end if;
    execute v_copy;
  end loop;
end
$$;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- The studio's currency, for this transaction.
insert into public.workspace_settings (key, value) values ('base_currency', 'xts')
on conflict (key) do update set value = excluded.value;

insert into public.finance_accounts (id, name)
values ('c7000000-0000-4000-a000-000000000001', 'check-db 07');

-- The trend's days, in XBJ, for the checks with fixed "todays": never in the
-- studio's currency, so no day counted from today falls among them.
insert into public.finance_transactions (account_id, posted_at, description, amount, currency) values
  ('c7000000-0000-4000-a000-000000000001', '2026-09-14', 'September 14', 1200, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-09-20', 'after the 14th', 50, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-09-10', 'another currency, written lower case', 5, 'xba'),
  ('c7000000-0000-4000-a000-000000000001', '2026-08-14', 'the same day last month', 400, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-08-20', 'later last month', 999, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-02-27', 'February 27', 3, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-02-28', 'February 28, the month''s last day', 70, 'XBJ'),
  ('c7000000-0000-4000-a000-000000000001', '2026-03-31', 'March 31', 30, 'XBJ');

-- The studio's revenue, in XTS, on days counted from today that every month's
-- tiles read — the first of this month and the first of last month — so the
-- tiles compare real figures, 20 this month and 5 last, whenever the suite runs.
insert into public.finance_transactions (account_id, posted_at, description, amount, currency) values
  ('c7000000-0000-4000-a000-000000000001', date_trunc('month', now() at time zone 'UTC')::date, 'the first of this month', 20, 'XTS'),
  ('c7000000-0000-4000-a000-000000000001', (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 'the first of last month', 5, 'XTS');

insert into public.finance_invoices (number, client, amount, currency, status, due_on) values
  ('CHECK-07-1', 'Factor Co', 700, 'XTS', 'sent', (now() at time zone 'UTC')::date + 7),
  ('CHECK-07-2', 'Factor Co', 100, 'XTS', 'overdue', (now() at time zone 'UTC')::date - 1),
  ('CHECK-07-3', 'Factor Co', 30, 'XBA', 'overdue', (now() at time zone 'UTC')::date - 10);

-- What counts (finance_figures): one transaction of each kind, in XBB, today.
-- Stripe's rows are on a Stripe account that is switched off: what they count
-- does not depend on it.
insert into public.finance_accounts (id, name, kind, provider, active)
values ('c7000000-0000-4000-a000-000000000002', 'check-db 07 Stripe', 'stripe', 'stripe', false);

insert into public.finance_transactions (account_id, posted_at, description, counterparty, amount, currency, status, source, kind)
select v.account_id::uuid, (now() at time zone 'UTC')::date,
       v.description, v.counterparty, v.amount, v.currency, v.status, v.source, v.kind
from (values
  ('c7000000-0000-4000-a000-000000000002', 'a card payment, charged through Stripe', null, 100, 'XBB', 'posted', 'stripe', 'income'),
  ('c7000000-0000-4000-a000-000000000002', 'what Stripe kept of it', null, -3, 'XBB', 'posted', 'stripe', 'fee'),
  ('c7000000-0000-4000-a000-000000000002', 'money given back to a client', null, -10, 'XBB', 'posted', 'stripe', 'refund'),
  ('c7000000-0000-4000-a000-000000000002', 'STRIPE PAYOUT', null, -87, 'XBB', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', 'STRIPE TRANSFER, that payout arriving', 'Stripe', 87, 'XBB', 'posted', 'mercury', 'payout'),
  ('c7000000-0000-4000-a000-000000000002', 'STRIPE PAYOUT, to an account the workspace does not see', null, -120, 'XBB', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', 'a wire from a client, for that same amount', 'Factor Co', 120, 'XBB', 'posted', 'mercury', 'income'),
  ('c7000000-0000-4000-a000-000000000002', 'a refund, beside a payout of its amount', null, -75, 'XBB', 'posted', 'stripe', 'refund'),
  ('c7000000-0000-4000-a000-000000000001', 'STRIPE TRANSFER, a payout whose Stripe row is not synced', 'Stripe', 75, 'XBB', 'posted', 'mercury', 'payout'),
  ('c7000000-0000-4000-a000-000000000002', 'STRIPE PAYOUT, into an account whose currency is written in lower case', null, -64, 'XBB', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', 'STRIPE TRANSFER, that payout arriving', 'Stripe', 64, ' xbb ', 'posted', 'mercury', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', 'a wire from a client', 'Factor Co', 500, 'XBB', 'posted', 'mercury', 'income'),
  ('c7000000-0000-4000-a000-000000000001', 'a wire still pending', 'Factor Co', 250, 'XBB', 'pending', 'mercury', 'income'),
  ('c7000000-0000-4000-a000-000000000001', 'to savings', 'Mercury Savings', -200, 'XBB', 'posted', 'mercury', 'transfer'),
  ('c7000000-0000-4000-a000-000000000001', 'from checking', 'Mercury Checking', 200, 'XBB', 'posted', 'mercury', 'transfer'),
  ('c7000000-0000-4000-a000-000000000001', 'to the tax account, whose side is not synced', 'Mercury Tax', -300, 'XBB', 'posted', 'mercury', 'transfer'),
  ('c7000000-0000-4000-a000-000000000001', 'software', 'Figma', -40, 'XBB', 'posted', 'mercury', 'expense'),
  ('c7000000-0000-4000-a000-000000000001', 'a merchant refunding us', 'Figma', 15, 'XBB', 'posted', 'mercury', 'expense'),
  ('c7000000-0000-4000-a000-000000000001', 'money given back to a client, entered by hand', 'Factor Co', -20, 'XBB', 'posted', 'manual', 'refund'),
  ('c7000000-0000-4000-a000-000000000001', 'the bank''s fee for a wire', 'Mercury', -6, 'XBB', 'posted', 'mercury', 'fee'),
  ('c7000000-0000-4000-a000-000000000001', 'bank interest', 'Mercury', 2, 'XBB', 'posted', 'mercury', 'interest'),
  ('c7000000-0000-4000-a000-000000000001', 'a correction', 'Mercury', 50, 'XBB', 'posted', 'mercury', 'adjustment'),
  ('c7000000-0000-4000-a000-000000000001', 'entered by hand', null, 30, 'XBB', 'posted', 'manual', null)
) v(account_id, description, counterparty, amount, currency, status, source, kind);

-- Where a payout counts, in XBC in June 2026: in the bank that received it, or
-- from Stripe's side when no synced account did.
insert into public.finance_transactions (account_id, posted_at, description, counterparty, amount, currency, status, source, kind)
select v.account_id::uuid, v.posted_at::date, v.description, v.counterparty, v.amount, v.currency, v.status, v.source, v.kind
from (values
  -- In the bank two days after Stripe made it: the bank's row counts.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-08', 'STRIPE PAYOUT', null, -300, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-10', 'STRIPE TRANSFER', 'Stripe', 300, 'XBC', 'posted', 'mercury', 'payout'),
  -- Fourteen days on, the longest a payout is given: still that payout.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-05', 'STRIPE PAYOUT', null, -250, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-19', 'STRIPE TRANSFER', 'Stripe', 250, 'XBC', 'posted', 'mercury', 'payout'),
  -- Fifteen days on: another payout, and each counts where it is.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-02', 'STRIPE PAYOUT', null, -260, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-17', 'STRIPE TRANSFER', 'Stripe', 260, 'XBC', 'posted', 'mercury', 'payout'),
  -- In the bank the day before Stripe's date, the days cut in different zones: that payout.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-26', 'STRIPE PAYOUT', null, -60, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-25', 'STRIPE TRANSFER', 'Stripe', 60, 'XBC', 'posted', 'mercury', 'payout'),
  -- Two days before: another.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-27', 'STRIPE PAYOUT', null, -55, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-25', 'STRIPE TRANSFER', 'Stripe', 55, 'XBC', 'posted', 'mercury', 'payout'),
  -- Stripe taking back a balance that went negative: the bank's debit counts, against revenue.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-16', 'STRIPE PAYOUT', null, 45, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-17', 'STRIPE DEBIT', 'Stripe', -45, 'XBC', 'posted', 'mercury', 'payout'),
  -- A bank row of that amount the same way round is not its deposit: Stripe paid 35 out to an
  -- account the workspace does not see, and took 35 back from a synced one. Each counts.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-22', 'STRIPE PAYOUT', null, -35, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-23', 'STRIPE DEBIT', 'Stripe', -35, 'XBC', 'posted', 'mercury', 'payout'),
  -- A payout of that amount into an account in another currency is not this one.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-18', 'STRIPE PAYOUT', null, -70, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', '2026-06-19', 'STRIPE TRANSFER', 'Stripe', 70, 'XBD', 'posted', 'mercury', 'payout'),
  -- Two of Stripe's own rows are never each other's bank payout.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-10', 'STRIPE PAYOUT FAILURE', null, 33, 'XBC', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000002', '2026-06-20', 'STRIPE PAYOUT', null, -33, 'XBC', 'posted', 'stripe', 'payout'),
  -- Stripe's charges are the detail behind its payouts, pending or not.
  ('c7000000-0000-4000-a000-000000000002', '2026-06-12', 'a card payment, not yet available', null, 120, 'XBC', 'pending', 'stripe', 'income')
) v(account_id, posted_at, description, counterparty, amount, currency, status, source, kind);

-- Rows that arrive without a kind: from each sync; one a sync gave a kind and
-- stored again without naming it; one entered by hand; and one whose kind an
-- update took away.
insert into public.finance_transactions (account_id, external_id, posted_at, description, counterparty, amount, currency, source, kind) values
  ('c7000000-0000-4000-a000-000000000001', 'check-07-without-kind', '2026-06-02', 'STRIPE TRANSFER ST-1', 'Stripe', 90, 'XBD', 'mercury', null),
  ('c7000000-0000-4000-a000-000000000001', 'check-07-with-kind', '2026-06-02', 'Transfer from savings', 'Mercury Savings', 90, 'XBD', 'mercury', 'transfer'),
  ('c7000000-0000-4000-a000-000000000001', 'check-07-by-hand', '2026-06-02', 'Lunch', null, -5, 'XBD', 'manual', null),
  ('c7000000-0000-4000-a000-000000000002', 'check-07-stripe-without-kind', '2026-06-02', 'STRIPE PAYOUT', null, -40, 'XBD', 'stripe', null),
  ('c7000000-0000-4000-a000-000000000001', 'check-07-kind-taken-away', '2026-06-02', 'Card payment', 'Figma', -12, 'XBD', 'mercury', 'expense'),
  ('c7000000-0000-4000-a000-000000000001', 'check-07-csv', '2026-06-02', 'STRIPE TRANSFER ST-3, imported from a file', 'Stripe', 90, 'XBD', 'csv', null);
update public.finance_transactions set description = 'Transfer from savings, synced again'
where external_id = 'check-07-with-kind';
update public.finance_transactions set kind = null, description = 'STRIPE TRANSFER ST-2', counterparty = 'Stripe', amount = 12
where external_id = 'check-07-kind-taken-away';

-- A deposit still pending, in XBE in June 2026: until it posts, Stripe's payout
-- counts in its place (the checks ask, post it, and ask again). A Stripe payout
-- that is itself still pending counts as neither.
insert into public.finance_transactions (account_id, external_id, posted_at, description, counterparty, amount, currency, status, source, kind) values
  ('c7000000-0000-4000-a000-000000000002', 'check-07-payout-of-pending-deposit', '2026-06-08', 'STRIPE PAYOUT', null, -400, 'XBE', 'posted', 'stripe', 'payout'),
  ('c7000000-0000-4000-a000-000000000001', 'check-07-deposit-pending', '2026-06-10', 'STRIPE TRANSFER, still pending', 'Stripe', 400, 'XBE', 'pending', 'mercury', 'payout'),
  ('c7000000-0000-4000-a000-000000000002', 'check-07-payout-pending', '2026-06-20', 'STRIPE PAYOUT, still pending', null, -90, 'XBE', 'pending', 'stripe', 'payout');

-- The window at a month's end, in XBF, entered by hand, for a viewer in New
-- York on the evenings of September 14 and September 30, when UTC's day is
-- already the next: asked of revenue_by_currency with those days, and of the
-- mix and the tiles at those hours (MONTH END).
insert into public.finance_transactions (account_id, posted_at, description, amount, currency) values
  ('c7000000-0000-4000-a000-000000000001', '2026-08-15', 'August 15', 100, 'XBF'),
  ('c7000000-0000-4000-a000-000000000001', '2026-08-31', 'August 31, the month''s last day', 1000, 'XBF'),
  ('c7000000-0000-4000-a000-000000000001', '2026-09-15', 'September 15 in UTC, the evening of the 14th in New York', 10, 'XBF'),
  ('c7000000-0000-4000-a000-000000000001', '2026-09-30', 'September 30', 20, 'XBF'),
  ('c7000000-0000-4000-a000-000000000001', '2026-10-01', 'October 1 in UTC, the evening of September 30 in New York', 40, 'XBF');

-- The mix's shares, in XBG today: income filed under a category, and Stripe
-- taking a balance back from the bank, filed under none.
insert into public.finance_categories (id, name)
values ('c7000000-0000-4000-a000-0000000000c1', 'check-db 07 client work');
insert into public.finance_transactions (account_id, posted_at, description, counterparty, amount, currency, category_id, status, source, kind) values
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'UTC')::date, 'a wire from a client', 'Factor Co', 300, 'XBG', 'c7000000-0000-4000-a000-0000000000c1', 'posted', 'mercury', 'income'),
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'UTC')::date, 'STRIPE DEBIT', 'Stripe', -45, 'XBG', null, 'posted', 'mercury', 'payout');

-- The edges of what the tiles, the chart and the mix read, on days counted from
-- today, entered by hand. In XBH: today in UTC, tomorrow, and the last day of
-- last month. In XBI: today in UTC, and today in Kiritimati — a day ahead of
-- UTC's from 10:00 UTC.
insert into public.finance_transactions (account_id, posted_at, description, amount, currency) values
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'UTC')::date, 'today', 1, 'XBH'),
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'UTC')::date + 1, 'tomorrow, which no figure has reached', 10, 'XBH'),
  ('c7000000-0000-4000-a000-000000000001', date_trunc('month', now() at time zone 'UTC')::date - 1, 'the last day of last month', 100, 'XBH'),
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'UTC')::date, 'today in UTC', 1, 'XBI'),
  ('c7000000-0000-4000-a000-000000000001', (now() at time zone 'Pacific/Kiritimati')::date, 'today in Kiritimati', 10, 'XBI');

-- The first and the last second of today, in two zones far from UTC.
insert into public.calendar_events (title, starts_at)
select 'check-db 07, first second of today in ' || z, ((now() at time zone z)::date)::timestamp at time zone z
from (values ('Pacific/Kiritimati'), ('Pacific/Pago_Pago')) v(z)
union all
select 'check-db 07, last second of today in ' || z,
       (((now() at time zone z)::date + 1)::timestamp at time zone z) - interval '1 second'
from (values ('Pacific/Kiritimati'), ('Pacific/Pago_Pago')) v(z);

-- ── As the OWNER (manager) ───────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

-- Which days a trend compares, on the days that catch a wrong month length.
insert into results(name, expected, actual, pass)
select 'WINDOW: ' || c.today || ' is compared with last month up to ' || c.expected,
       c.expected::text, w.prev_through::text, w.prev_through = c.expected
from (values ('2026-01-31'::date, '2025-12-31'::date),
             ('2026-03-31'::date, '2026-02-28'::date),
             ('2028-03-31'::date, '2028-02-29'::date),
             ('2026-05-31'::date, '2026-04-30'::date),
             ('2026-09-01'::date, '2026-08-01'::date),
             ('2026-09-14'::date, '2026-08-14'::date)) c(today, expected)
cross join lateral public.overview_window(c.today) w;

insert into results(name, expected, actual, pass)
select 'TREND: September 1–14 against August 1–14, not all of August', '1200 / 400',
       coalesce(e ->> 'month', 'none') || ' / ' || coalesce(e ->> 'previous', 'none'),
       (e ->> 'month')::numeric = 1200 and (e ->> 'previous')::numeric = 400
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-09-14', '2026-09-14')) e
              where e ->> 'currency' = 'XBJ') as e) x;

insert into results(name, expected, actual, pass)
select 'TREND: March 31 against all of February, which is shorter', '30 / 73',
       coalesce(e ->> 'month', 'none') || ' / ' || coalesce(e ->> 'previous', 'none'),
       (e ->> 'month')::numeric = 30 and (e ->> 'previous')::numeric = 73
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-03-31', '2026-03-31')) e
              where e ->> 'currency' = 'XBJ') as e) x;

insert into results(name, expected, actual, pass)
select 'POSTED IN UTC: income the sync dated tomorrow still counts today', '1250, and 1200 without it',
       coalesce(a.e ->> 'month', 'none') || ', and ' || coalesce(b.e ->> 'month', 'none') || ' without it',
       (a.e ->> 'month')::numeric = 1250 and (b.e ->> 'month')::numeric = 1200
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-09-19', '2026-09-20')) e
              where e ->> 'currency' = 'XBJ') as e) a,
     (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-09-19')) e
              where e ->> 'currency' = 'XBJ') as e) b;

insert into results(name, expected, actual, pass)
select 'WINDOW: on the evening of September 14 in New York, what the syncs dated the 15th in UTC counts today, and last month runs to August 15 too', '10 / 100',
       coalesce(e ->> 'month', 'none') || ' / ' || coalesce(e ->> 'previous', 'none'),
       (e ->> 'month')::numeric = 10 and (e ->> 'previous')::numeric = 100
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-09-14', '2026-09-15')) e
              where e ->> 'currency' = 'XBF') as e) x;

insert into results(name, expected, actual, pass)
select 'WINDOW: on the evening of September 30 in New York, what the syncs dated October 1 is October''s, and last month runs to August 30, not 31', '30 / 100',
       coalesce(e ->> 'month', 'none') || ' / ' || coalesce(e ->> 'previous', 'none'),
       (e ->> 'month')::numeric = 30 and (e ->> 'previous')::numeric = 100
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-09-30', '2026-10-01')) e
              where e ->> 'currency' = 'XBF') as e) x;

insert into results(name, expected, actual, pass)
select 'CURRENCY: each currency on its own, however its code was written', 'XBA 5, never added to XBJ',
       coalesce((select 'XBA ' || (e ->> 'month') from jsonb_array_elements(r) e where e ->> 'currency' = 'XBA'), 'no XBA')
         || ', XBJ ' || coalesce((select e ->> 'month' from jsonb_array_elements(r) e where e ->> 'currency' = 'XBJ'), 'none'),
       exists (select 1 from jsonb_array_elements(r) e where e ->> 'currency' = 'XBA' and (e ->> 'month')::numeric = 5)
         and exists (select 1 from jsonb_array_elements(r) e where e ->> 'currency' = 'XBJ' and (e ->> 'month')::numeric = 1200)
from (select public.revenue_by_currency('2026-09-14', '2026-09-14') as r) x;

-- ── What counts ──────────────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'COUNTS: money that reached the studio — wires, what was entered by hand, and a card payment once, as its payout into the bank or, with no synced account to receive it, from Stripe''s side — less what was given back outside Stripe, never Stripe''s own charges, refunds or fees, a transfer, an adjustment, bank interest or a payment still pending',
       '976', coalesce(e ->> 'month', 'none'), (e ->> 'month')::numeric = 976
from (select (select e from jsonb_array_elements(public.revenue_by_currency((now() at time zone 'UTC')::date)) e
              where e ->> 'currency' = 'XBB') as e) x;

insert into results(name, expected, actual, pass)
select 'PAYOUTS: a payout counts where it arrived — fourteen days on or a day before is that payout, fifteen days on or two days before another, in its own currency, never matched to another of Stripe''s rows or to a bank row of its amount the same way round — and Stripe taking a balance back counts against revenue',
       '1265', coalesce(e ->> 'month', 'none'), (e ->> 'month')::numeric = 1265
from (select (select e from jsonb_array_elements(public.revenue_by_currency('2026-06-30', '2026-06-30')) e
              where e ->> 'currency' = 'XBC') as e) x;

insert into results(name, expected, actual, pass)
select 'COUNTS: expenses are spending less what came back, and a bank''s own fee — not Stripe''s fees, already out of its payouts, nor a transfer', '976 revenue / 31 expenses',
       coalesce(sum(revenue), 0) || ' revenue / ' || coalesce(sum(expenses), 0) || ' expenses',
       coalesce(sum(revenue), 0) = 976 and coalesce(sum(expenses), 0) = 31
from public.revenue_series(1, 'UTC', 'xbb');

insert into results(name, expected, actual, pass)
select 'COUNTS: the revenue mix is the same revenue', '976', coalesce(sum(amount), 0)::text, coalesce(sum(amount), 0) = 976
from public.revenue_mix(1, 'UTC', 'xbb');

insert into results(name, expected, actual, pass)
select 'KIND: what was stored without a kind is read the way its sync meant it — a Stripe description is a payout when it starts with one, not when it mentions one', x.expected, x.v, x.v = x.expected
from (select 'payout payout income refund refund refund fee expense income payout payout payout payout income income expense expense expense' as expected,
             concat_ws(' ',
        public.finance_kind_guess('stripe', -87, 'STRIPE PAYOUT', null),
        public.finance_kind_guess('stripe', 87, 'payout_reversal', null),
        public.finance_kind_guess('stripe', 500, 'Creator payout toolkit, invoice 7', null),
        public.finance_kind_guess('stripe', -10, 'Refund for invoice 1042', null),
        public.finance_kind_guess('stripe', -60, 'dispute', null),
        public.finance_kind_guess('stripe', -25, 'Chargeback 42', null),
        public.finance_kind_guess('stripe', -3, 'Stripe fee', null),
        public.finance_kind_guess('stripe', -4, 'Coffee', null),
        public.finance_kind_guess('stripe', 100, 'Invoice 1042', null),
        public.finance_kind_guess('mercury', 87, 'STRIPE TRANSFER ST-1', 'Stripe'),
        public.finance_kind_guess('mercury', 87, 'ACH CREDIT', 'Stripe Payments Europe, Ltd.'),
        public.finance_kind_guess('mercury', 87, 'Stripe; TRANSFER; Veyago LLC', null),
        public.finance_kind_guess('mercury', -45, 'STRIPE DEBIT', 'Stripe, Inc.'),
        public.finance_kind_guess('mercury', 500, 'PINSTRIPE STUDIO PAYMENT', 'Pinstripe Studio'),
        public.finance_kind_guess('mercury', 500, 'Wire', 'The Stripe Agency'),
        public.finance_kind_guess('mercury', -12, 'STRIPE* FIGMA', 'Figma'),
        public.finance_kind_guess('mercury', -12, 'STRIPE* FIGMA', null),
        public.finance_kind_guess('manual', -5, 'Lunch', null)) as v) x;

insert into results(name, expected, actual, pass)
select 'KIND: a synced row inserted or updated without one — from either sync — is given the guess; the kind a sync wrote is kept; a row entered by hand or imported from a file has none',
       'payout transfer none payout payout none', x.v, x.v = 'payout transfer none payout payout none'
from (select concat_ws(' ',
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-without-kind'),
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-with-kind'),
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-by-hand'),
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-stripe-without-kind'),
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-kind-taken-away'),
        (select coalesce(kind, 'none') from public.finance_transactions where external_id = 'check-07-csv')) as v) x;

-- A deposit the bank still shows as pending, and then the same deposit posted.
insert into results(name, expected, actual, pass)
select 'PAYOUTS: while its deposit is still pending, a Stripe payout counts from Stripe''s side; a Stripe payout that is itself still pending counts as neither',
       '400: stripe 400', x.v, x.v = '400: stripe 400'
from (select coalesce((select e ->> 'month' from jsonb_array_elements(public.revenue_by_currency('2026-06-30', '2026-06-30')) e
                        where e ->> 'currency' = 'XBE'), '0')::numeric::int
             || ': ' || coalesce((select string_agg(case when f.source = 'stripe' then 'stripe' else 'bank' end || ' ' || f.counted::int, ', '
                                                    order by f.source, f.counted)
                                  from public.finance_figures f
                                  where upper(trim(f.currency)) = 'XBE' and f.counts_as = 'revenue'), 'nothing') as v) x;

reset role;
update public.finance_transactions set status = 'posted' where external_id = 'check-07-deposit-pending';
set local role authenticated;

insert into results(name, expected, actual, pass)
select 'PAYOUTS: once that deposit posts, it counts, and Stripe''s payout no longer does',
       '400: bank 400', x.v, x.v = '400: bank 400'
from (select coalesce((select e ->> 'month' from jsonb_array_elements(public.revenue_by_currency('2026-06-30', '2026-06-30')) e
                        where e ->> 'currency' = 'XBE'), '0')::numeric::int
             || ': ' || coalesce((select string_agg(case when f.source = 'stripe' then 'stripe' else 'bank' end || ' ' || f.counted::int, ', '
                                                    order by f.source, f.counted)
                                  from public.finance_figures f
                                  where upper(trim(f.currency)) = 'XBE' and f.counts_as = 'revenue'), 'nothing') as v) x;

insert into results(name, expected, actual, pass)
select 'MIX: each share is of the categories listed, so the shares add up to 100 — a category that gave back more than it took in is not listed, and takes nothing off the total',
       'check-db 07 client work: 300, 100.0%', coalesce(x.v, 'no rows'), coalesce(x.v = 'check-db 07 client work: 300, 100.0%', false)
from (select string_agg(m.category || ': ' || m.amount::int || ', ' || m.share || '%', '; ' order by m.amount desc) as v
      from public.revenue_mix(1, 'UTC', 'xbg') m) x;

insert into results(name, expected, actual, pass)
select 'BOUNDS: nothing dated after today counts in the tile, the chart or the mix, and a mix of one month reads no day of last month',
       'tile 1 / chart 100, 1 / mix 1', x.v, x.v = 'tile 1 / chart 100, 1 / mix 1'
from (select 'tile ' || coalesce((select (e ->> 'month')::numeric::int
                                  from jsonb_array_elements(public.workspace_overview('UTC') -> 'revenue_by_currency') e
                                  where e ->> 'currency' = 'XBH'), 0)
             || ' / chart ' || coalesce((select string_agg(s.revenue::int::text, ', ' order by s.month)
                                         from public.revenue_series(2, 'UTC', 'xbh') s), 'none')
             || ' / mix ' || (select coalesce(sum(m.amount), 0)::int from public.revenue_mix(1, 'UTC', 'xbh') m) as v) x;

select set_config('test.overview', public.workspace_overview('UTC')::text, true);

insert into results(name, expected, actual, pass)
select 'CURRENCY: the studio''s own currency, as declared — not the largest number', 'XTS',
       coalesce(current_setting('test.overview')::jsonb ->> 'revenue_currency', 'null'),
       current_setting('test.overview')::jsonb ->> 'revenue_currency' = 'XTS';

insert into results(name, expected, actual, pass)
select 'TILES: the revenue tile is the studio currency''s figure for today', '20 (revenue_by_currency 20)',
       coalesce(o ->> 'revenue_month', 'null') || ' (revenue_by_currency ' || coalesce(e::text, 'none') || ')',
       coalesce((o ->> 'revenue_month')::numeric = 20 and e = 20, false)
from (select current_setting('test.overview')::jsonb as o) x,
     (select (select (r ->> 'month')::numeric
              from jsonb_array_elements(public.revenue_by_currency((now() at time zone 'UTC')::date)) r
              where r ->> 'currency' = 'XTS') as e) y;

insert into results(name, expected, actual, pass)
select 'TILES: last month is counted to the same day as this month, and the tile names that day, not last month''s last',
       w.prev_through || ', 5 (revenue_by_currency 5)',
       coalesce(o ->> 'revenue_prev_through', 'null') || ', ' || coalesce(o ->> 'revenue_prev_month', 'null')
         || ' (revenue_by_currency ' || coalesce(e::text, 'none') || ')',
       coalesce((o ->> 'revenue_prev_through')::date = w.prev_through and (o ->> 'revenue_prev_month')::numeric = 5 and e = 5, false)
from (select current_setting('test.overview')::jsonb as o) x,
     public.overview_window((now() at time zone 'UTC')::date) w,
     (select (select (r ->> 'previous')::numeric
              from jsonb_array_elements(public.revenue_by_currency((now() at time zone 'UTC')::date)) r
              where r ->> 'currency' = 'XTS') as e) y;

insert into results(name, expected, actual, pass)
select 'INVOICES: count, amount and due date all belong to the currency shown',
       'XTS: 2 invoices, 800, due ' || ((now() at time zone 'UTC')::date - 1) || '; XBA listed',
       coalesce(o ->> 'currency', '?') || ': ' || coalesce(o ->> 'count', '?') || ' invoices, ' ||
       coalesce(o ->> 'amount', '?') || ', due ' || coalesce(o ->> 'due_next', '?') ||
       case when exists (select 1 from jsonb_array_elements(o -> 'by_currency') e where e ->> 'currency' = 'XBA')
            then '; XBA listed' else '; no XBA' end,
       o ->> 'currency' = 'XTS' and (o ->> 'count')::int = 2 and (o ->> 'amount')::numeric = 800
         and (o ->> 'due_next')::date = (now() at time zone 'UTC')::date - 1
         and exists (select 1 from jsonb_array_elements(o -> 'by_currency') e
                     where e ->> 'currency' = 'XBA' and (e ->> 'amount')::numeric = 30)
from (select current_setting('test.overview')::jsonb -> 'invoices_outstanding' as o) x;

insert into results(name, expected, actual, pass)
select 'SERIES: one currency, the studio''s unless asked otherwise, and only that currency''s income',
       '3 rows of XTS; 3 rows of XBA summing to ' || x.expected,
       (select count(*) || ' rows of ' || coalesce(string_agg(distinct currency, ','), 'none') from public.revenue_series(3, 'UTC'))
         || '; ' || (select count(*) || ' rows of ' || coalesce(string_agg(distinct currency, ','), 'none')
                            || ' summing to ' || coalesce(sum(revenue), 0) from public.revenue_series(3, 'UTC', 'xba')),
       (select count(*) = 3 and bool_and(currency = 'XTS') from public.revenue_series(3, 'UTC'))
         and (select count(*) = 3 and bool_and(currency = 'XBA') and sum(revenue) = x.expected
              from public.revenue_series(3, 'UTC', 'xba'))
from (select coalesce(sum(amount), 0) as expected from public.finance_transactions
      where amount > 0 and upper(trim(currency)) = 'XBA'
        and posted_at between (date_trunc('month', now() at time zone 'UTC') - interval '2 months')::date
                          and (now() at time zone 'UTC')::date) x;

insert into results(name, expected, actual, pass)
select 'MIX: the studio''s currency, with no other currency''s income added in', 'XTS rows summing to ' || e.total,
       coalesce(a.currencies, 'no rows') || ' summing to ' || coalesce(a.total, 0),
       coalesce(a.only_studio, true) and coalesce(a.total, 0) = e.total
from (select coalesce(sum(amount), 0) as total from public.finance_transactions
      where amount > 0 and upper(trim(currency)) = 'XTS'
        and posted_at between (date_trunc('month', now() at time zone 'UTC') - interval '23 months')::date
                          and (now() at time zone 'UTC')::date) e,
     (select string_agg(distinct currency, ',') as currencies, sum(amount) as total,
             bool_and(currency = 'XTS') as only_studio
      from public.revenue_mix(24, 'UTC')) a;

-- Today is today where the viewer is: the function's count against a direct one.
insert into results(name, expected, actual, pass)
select 'ZONE: today in ' || z.name, e.expected::text, a.actual::text, e.expected = a.actual
from (values ('Pacific/Kiritimati'), ('Pacific/Pago_Pago'), ('Europe/Amsterdam'), ('UTC')) z(name)
cross join lateral (
  select count(*) as expected from public.calendar_events
  where status <> 'cancelled' and (starts_at at time zone z.name)::date = (now() at time zone z.name)::date
) e
cross join lateral (select (public.workspace_overview(z.name) ->> 'events_today')::bigint as actual) a;

-- Revenue runs to the end of the viewer's today, or of UTC's when that is later
-- (the syncs date income in UTC), but never into the viewer's next month — in
-- the tile, the chart and the mix alike — and the tile names the day last month
-- runs to. In UTC−12 (Etc/GMT+12) this bites from 00:00 to 12:00 UTC, while
-- that zone is still on UTC's yesterday; in Kiritimati (UTC+14), from 10:00 UTC
-- to midnight, while it is already on UTC's tomorrow.
insert into results(name, expected, actual, pass)
select 'ZONE: revenue in ' || z.name || ' runs to the viewer''s today, or UTC''s when later, never into the next month — tile, chart and mix alike, and last month to that day',
       e.total || ' / ' || e.total || ' / ' || e.total || ', last month to ' || e.prev_through,
       a.tile || ' / ' || a.chart || ' / ' || a.mix || ', last month to ' || coalesce(a.prev_through::text, 'null'),
       coalesce(a.tile = e.total and a.chart = e.total and a.mix = e.total and a.prev_through = e.prev_through, false)
from (values ('Etc/GMT+12'), ('Pacific/Kiritimati')) z(name)
cross join lateral (select (now() at time zone z.name)::date as today) v
cross join lateral (select make_date(extract(year from v.today)::int, extract(month from v.today)::int, 1) as month_start) m
cross join lateral (select least(greatest(v.today, (now() at time zone 'UTC')::date),
                                 (m.month_start + interval '1 month')::date - 1) as through) d
cross join lateral (
  select coalesce((select sum(t.amount) from public.finance_transactions t
                   where upper(trim(t.currency)) = 'XBI' and t.posted_at between m.month_start and d.through), 0)::int as total,
         (select w.prev_through from public.overview_window(d.through) w) as prev_through
) e
cross join lateral (
  select coalesce((select (r ->> 'month')::numeric from jsonb_array_elements(ow.o -> 'revenue_by_currency') r
                   where r ->> 'currency' = 'XBI'), 0)::int as tile,
         (ow.o ->> 'revenue_prev_through')::date as prev_through,
         (select coalesce(sum(s.revenue), 0)::int from public.revenue_series(1, z.name, 'xbi') s) as chart,
         (select coalesce(sum(x.amount), 0)::int from public.revenue_mix(1, z.name, 'xbi') x) as mix
  from (select public.workspace_overview(z.name) as o) ow
) a;

-- A month's end, and UTC's day already the next, at the hours they happen and
-- whenever the suite runs: the copies made at the top, asked on the evenings of
-- September 14 and September 30 in New York (the XBF days). What the syncs
-- dated the 15th counts on the 14th, in the mix and the tile, and what they
-- dated October 1 does not count on September 30; the tile names last month to
-- the day it counted to, never past last month's end.
insert into results(name, expected, actual, pass)
select 'MONTH END: on the evening of ' || c.evening || ' in New York, the mix and the tile run to UTC''s day but never into October, and the tile names last month to the day it counted to',
       'mix ' || c.mix || ' / tile ' || c.month || ' / ' || c.previous || ', last month to ' || c.through,
       'mix ' || a.mix || ' / tile ' || coalesce(a.month::text, 'none') || ' / ' || coalesce(a.previous::text, 'none')
         || ', last month to ' || coalesce(a.through::text, 'null'),
       coalesce(a.mix = c.mix and a.month = c.month and a.previous = c.previous and a.through = c.through, false)
from (values ('September 14', '2026-09-15T03:00:00Z'::timestamptz, 10, 10, 100, '2026-08-15'::date),
             ('September 30', '2026-10-01T03:00:00Z'::timestamptz, 30, 30, 100, '2026-08-30'::date))
     c(evening, clock, mix, month, previous, through)
cross join lateral (
  select (select coalesce(sum(m.amount), 0)::int from pg_temp.revenue_mix_at(c.clock, 1, 'America/New_York', 'xbf') m) as mix,
         (select (r ->> 'month')::numeric::int from jsonb_array_elements(ow.o -> 'revenue_by_currency') r
          where r ->> 'currency' = 'XBF') as month,
         (select (r ->> 'previous')::numeric::int from jsonb_array_elements(ow.o -> 'revenue_by_currency') r
          where r ->> 'currency' = 'XBF') as previous,
         (ow.o ->> 'revenue_prev_through')::date as through
  from (select pg_temp.workspace_overview_at(c.clock, 'America/New_York') as o) ow
) a;

insert into results(name, expected, actual, pass)
select 'ZONE: a name that is not an IANA zone is UTC', 'UTC / UTC / UTC',
       concat_ws(' / ', public.workspace_overview('Not/AZone') ->> 'time_zone',
                 public.workspace_overview('EST') ->> 'time_zone',
                 public.workspace_overview('UTC+3') ->> 'time_zone'),
       public.workspace_overview('Not/AZone') ->> 'time_zone' = 'UTC'
         and public.workspace_overview('EST') ->> 'time_zone' = 'UTC'
         and public.workspace_overview('UTC+3') ->> 'time_zone' = 'UTC';

insert into results(name, expected, actual, pass)
select 'CALLERS: the live workspace, which passes nothing, still gets an answer', 'UTC, 6 months',
       (public.workspace_overview() ->> 'time_zone') || ', ' || (select count(*) from public.revenue_series(6)) || ' months',
       public.workspace_overview() ->> 'time_zone' = 'UTC' and (select count(*) from public.revenue_series(6)) = 6;

-- ── As the assistant, a member of staff who is not a manager ─────────────
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: no money at all, in any currency, and no finance table to read',
       'null null null null null / 0 series rows / 0 mix rows / 0 transactions counted / 0 transactions, 0 invoices, 0 accounts, 0 categories',
       concat_ws(' ', jsonb_typeof(o -> 'revenue_month'), jsonb_typeof(o -> 'revenue_currency'),
                 jsonb_typeof(o -> 'revenue_prev_through'), jsonb_typeof(o -> 'revenue_by_currency'),
                 jsonb_typeof(o -> 'invoices_outstanding'))
         || ' / ' || (select count(*) from public.revenue_series(3, 'UTC')) || ' series rows'
         || ' / ' || (select count(*) from public.revenue_mix(24, 'UTC')) || ' mix rows'
         || ' / ' || (select count(*) from public.finance_figures) || ' transactions counted'
         || ' / ' || (select count(*) from public.finance_transactions) || ' transactions, '
         || (select count(*) from public.finance_invoices) || ' invoices, '
         || (select count(*) from public.finance_accounts) || ' accounts, '
         || (select count(*) from public.finance_categories) || ' categories',
       jsonb_typeof(o -> 'revenue_month') = 'null' and jsonb_typeof(o -> 'revenue_currency') = 'null'
         and jsonb_typeof(o -> 'revenue_prev_through') = 'null' and jsonb_typeof(o -> 'revenue_by_currency') = 'null'
         and jsonb_typeof(o -> 'invoices_outstanding') = 'null'
         and (select count(*) from public.revenue_series(3, 'UTC')) = 0
         and (select count(*) from public.revenue_mix(24, 'UTC')) = 0
         and (select count(*) from public.finance_figures) = 0
         and (select count(*) from public.finance_transactions) = 0
         and (select count(*) from public.finance_invoices) = 0
         and (select count(*) from public.finance_accounts) = 0
         and (select count(*) from public.finance_categories) = 0
from (select public.workspace_overview('UTC') as o) x;

reset role;

insert into results(name, expected, actual, pass)
select 'GRANTS: anon can call none of them or read what a transaction counts towards, and nobody writes through it', 'none',
       coalesce(string_agg(g.name, ', '), 'none'), count(*) = 0
from (
  select f as name
  from unnest(array['public.workspace_overview(text)', 'public.revenue_series(integer, text, text)',
                    'public.revenue_mix(integer, text, text)', 'public.studio_currency()',
                    'public.overview_zone(text)', 'public.overview_window(date)',
                    'public.revenue_by_currency(date, date)',
                    'public.finance_kind_guess(text, numeric, text, text)']) f
  where has_function_privilege('anon', f, 'execute')
  union all
  select 'anon reads finance_figures' where has_table_privilege('anon', 'public.finance_figures', 'select')
  union all
  select r || ' can ' || p || ' through finance_figures'
  from unnest(array['authenticated', 'service_role']) r
  cross join unnest(array['insert', 'update', 'delete']) p
  where has_table_privilege(r, 'public.finance_figures', p)
) g;

-- ── The studio's currency when none is declared ──────────────────────────
-- The first active account by name whose currency is a code, and with none of
-- those, USD. The setting is taken away and every other account switched off
-- for this, rolled back with the rest.
delete from public.workspace_settings where key = 'base_currency';
update public.finance_accounts set active = false where active;
insert into public.finance_accounts (id, name, currency, active, created_at) values
  ('c7000000-0000-4000-a000-000000000011', 'check-db 07 1, switched off', 'XTC', false, now() - interval '3 days'),
  ('c7000000-0000-4000-a000-000000000012', 'check-db 07 2, no currency code', 'dollars', true, now() - interval '2 days'),
  ('c7000000-0000-4000-a000-000000000013', 'check-db 07 3, the first by name', ' xta ', true, now() - interval '1 day'),
  ('c7000000-0000-4000-a000-000000000014', 'check-db 07 4, the newest', 'XTB', true, now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);
select set_config('test.currency_by_name', coalesce(public.studio_currency(), 'null'), true);
reset role;
update public.finance_accounts set active = false where active;
set local role authenticated;

insert into results(name, expected, actual, pass)
select 'CURRENCY: with none declared, the first active account''s by name — not the newest, one switched off or one whose currency is no code — and with no account, USD',
       'XTA, then USD', current_setting('test.currency_by_name') || ', then ' || coalesce(public.studio_currency(), 'null'),
       current_setting('test.currency_by_name') = 'XTA' and coalesce(public.studio_currency() = 'USD', false);
reset role;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
