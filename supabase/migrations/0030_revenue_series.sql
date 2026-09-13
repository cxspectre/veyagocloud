-- =============================================================================
-- 0030 — Monthly revenue, for the Overview chart.
--
-- The chart could be drawn from finance_transactions in the browser, but that
-- means shipping a year of rows to plot twelve numbers — and the browser only
-- holds the window it happened to fetch, so the figures would quietly disagree
-- with the Revenue tile, which sums in the database. One source, one answer.
--
-- Returns a row per month INCLUDING months with no income, because a gap in a
-- line chart is read as missing data rather than as a zero.
--
-- Managers only, like every other finance surface. A non-manager gets no rows
-- rather than an error, so the caller can simply not draw the panel.
-- =============================================================================

create or replace function public.revenue_series(p_months int default 6)
returns table (month date, revenue numeric, expenses numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    select generate_series(
             date_trunc('month', current_date) - ((greatest(least(p_months, 24), 1) - 1) * interval '1 month'),
             date_trunc('month', current_date),
             interval '1 month'
           )::date as month
  )
  select s.month,
         coalesce(sum(t.amount) filter (where t.amount > 0), 0)      as revenue,
         coalesce(abs(sum(t.amount) filter (where t.amount < 0)), 0) as expenses
  from span s
  left join public.finance_transactions t
    on date_trunc('month', t.posted_at)::date = s.month
  where public.is_manager()
  group by s.month
  order by s.month;
$$;

revoke all on function public.revenue_series(int) from public, anon;
grant execute on function public.revenue_series(int) to authenticated;

comment on function public.revenue_series(int) is
  'Monthly income and expenditure for the Overview chart. Empty months are '
  'returned as zero rather than omitted — a gap in a line reads as missing '
  'data. security_invoker + an is_manager() predicate, so a non-manager gets '
  'no rows.';
