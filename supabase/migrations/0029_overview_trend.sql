-- =============================================================================
-- 0029 — Give the overview a real trend, and a figure for everyone.
--
-- The Revenue tile shipped with "↗ 18.6% vs. last month" hardcoded beside it.
-- Next to a live number that is worse than no trend at all: it looks computed,
-- so nobody checks it, and it is wrong every month. Either the comparison is
-- real or the tile does not claim one — so the function now returns last
-- month's figure and the view does the subtraction.
--
-- Also adds `tasks_mine`, because the tiles a non-manager sees should be about
-- their own work rather than three counts and a blank where the money was.
--
-- Replaces the function body from 0027; everything it already returned is
-- returned unchanged, so nothing that reads it needs updating first.
-- =============================================================================

create or replace function public.workspace_overview()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_manager   boolean := public.is_manager();
  v_start     date    := date_trunc('month', current_date)::date;
  v_prev      date    := (date_trunc('month', current_date) - interval '1 month')::date;
  v_me        uuid    := public.active_employee_id();
  v_revenue   numeric;
  v_previous  numeric;
  v_invoices  jsonb;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  if v_manager then
    select coalesce(sum(amount), 0) into v_revenue
    from public.finance_transactions
    where amount > 0 and posted_at >= v_start;

    /* The same month a year's worth of rows ago would be a different question.
       This is strictly the calendar month before the current one. */
    select coalesce(sum(amount), 0) into v_previous
    from public.finance_transactions
    where amount > 0 and posted_at >= v_prev and posted_at < v_start;

    select jsonb_build_object(
             'count',  count(*),
             'amount', coalesce(sum(amount), 0),
             'due_next', min(due_on)
           )
      into v_invoices
    from public.finance_invoices
    where status in ('sent','overdue');
  end if;

  return jsonb_build_object(
    'as_of',                now(),
    'revenue_month',        v_revenue,
    'revenue_prev_month',   v_previous,
    'invoices_outstanding', v_invoices,
    'tickets_open',     (select count(*) from public.support_tickets
                          where status in ('open','in_progress','waiting') and deleted_at is null),
    'tickets_high',     (select count(*) from public.support_tickets
                          where status in ('open','in_progress','waiting') and deleted_at is null
                            and priority in ('high','urgent')),
    'projects_active',  (select count(*) from public.client_projects
                          where status in ('discovery','in_progress','in_review') and deleted_at is null),
    'tasks_open',       (select count(*) from public.tasks where status <> 'done'),
    'tasks_mine',       (select count(*) from public.tasks
                          where status <> 'done' and assignee_id = v_me),
    'events_today',     (select count(*) from public.calendar_events
                          where status <> 'cancelled'
                            and starts_at >= date_trunc('day', now())
                            and starts_at <  date_trunc('day', now()) + interval '1 day')
  );
end;
$$;

comment on function public.workspace_overview() is
  'One round trip for the Overview tiles. Finance figures are null for '
  'non-managers rather than 0 — a zero would read as a real number. '
  'revenue_prev_month exists so the trend beside it is computed, not decorative.';
