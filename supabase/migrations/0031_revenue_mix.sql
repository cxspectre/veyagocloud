-- =============================================================================
-- 0031 — Where this month's income came from.
--
-- The Finance screen's "Revenue mix" panel was three hardcoded slices —
-- Client services 70%, Kept 21%, Other 9% — sitting beside a chart that is
-- now real. A fabricated breakdown next to a real total is the same mistake
-- 0029 fixed on the trend: it looks computed, so nobody checks it.
--
-- Groups positive transactions by finance_categories. Anything uncategorised
-- is returned under its own label rather than dropped, because a mix whose
-- slices do not add up to the total is worse than an honest "Uncategorised".
--
-- Managers only, like every finance surface.
-- =============================================================================

create or replace function public.revenue_mix(p_months int default 1)
returns table (category text, amount numeric, share numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with window_tx as (
    select t.amount, coalesce(c.name, 'Uncategorised') as category
    from public.finance_transactions t
    left join public.finance_categories c on c.id = t.category_id
    where public.is_manager()
      and t.amount > 0
      and t.posted_at >= (date_trunc('month', current_date)
                          - ((greatest(least(p_months, 24), 1) - 1) * interval '1 month'))::date
  ),
  totals as (select coalesce(sum(amount), 0) as total from window_tx)
  select w.category,
         sum(w.amount) as amount,
         case when (select total from totals) > 0
              then round(100 * sum(w.amount) / (select total from totals), 1)
              else 0
         end as share
  from window_tx w
  group by w.category
  having sum(w.amount) > 0
  order by sum(w.amount) desc;
$$;

revoke all on function public.revenue_mix(int) from public, anon;
grant execute on function public.revenue_mix(int) to authenticated;

comment on function public.revenue_mix(int) is
  'This month''s income grouped by finance category. Uncategorised income is '
  'labelled rather than dropped, so the slices always add up to the total.';
