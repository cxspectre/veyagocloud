-- =============================================================================
-- 0027 — Activity feed, and the overview numbers in one round trip.
--
-- The workspace Overview shows four KPI tiles, today's agenda and a recent
-- activity list. Five separate queries for one screen is five round trips and
-- five chances for the numbers to disagree with each other, so the KPIs come
-- back from a single function.
--
-- VISIBILITY. Activity rows carry their own audience. Finance is manager-only
-- everywhere else in this schema (0005), and an activity feed is exactly the
-- kind of place that quietly undoes that — "Invoice INV-026 marked paid" tells
-- a reader the amount is real, who the client is, and that money moved, none
-- of which a non-manager is otherwise allowed to know. So rows are tagged
-- 'staff' or 'manager' and the read policy honours the tag.
--
-- Idempotent. Adds only.
-- =============================================================================

create table if not exists public.workspace_activity (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.employees(id) on delete set null,
  verb        text not null
                check (verb in ('created','updated','resolved','reopened','paid','commented','synced')),
  entity_type text not null
                check (entity_type in ('ticket','project','contact','company','invoice','task','mail')),
  entity_id   uuid,
  summary     text not null,
  visibility  text not null default 'staff' check (visibility in ('staff','manager')),
  created_at  timestamptz not null default now()
);

create index if not exists workspace_activity_recent_idx
  on public.workspace_activity (created_at desc);
create index if not exists workspace_activity_entity_idx
  on public.workspace_activity (entity_type, entity_id, created_at desc);

alter table public.workspace_activity enable row level security;

drop policy if exists "read activity by audience" on public.workspace_activity;
create policy "read activity by audience"
  on public.workspace_activity for select
  using (
    case visibility
      when 'manager' then public.is_manager()
      else public.is_staff()
    end
  );

-- Written by triggers only (they are SECURITY DEFINER, so they do not need a
-- policy). No INSERT policy on purpose: a feed anyone can write to is a feed
-- nobody can trust.

-- ─────────────────────────────────────────────────────────────────────────────
-- The recorder. One function, called by each table's own small trigger.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.log_activity(
  p_verb        text,
  p_entity_type text,
  p_entity_id   uuid,
  p_summary     text,
  p_visibility  text default 'staff'
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.workspace_activity (actor_id, verb, entity_type, entity_id, summary, visibility)
  values (public.active_employee_id(), p_verb, p_entity_type, p_entity_id, p_summary, p_visibility);
$$;

revoke all on function public.log_activity(text, text, uuid, text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers. Deliberately sparse: a feed that records every keystroke is noise.
-- Creation, and the one state change per entity that a person would mention
-- out loud.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.activity_from_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('created', 'ticket', new.id,
      'Ticket #VYG-' || new.number || ' · ' || new.subject);
  elsif new.status is distinct from old.status
        and new.status in ('resolved','closed') and old.status not in ('resolved','closed') then
    perform public.log_activity('resolved', 'ticket', new.id,
      'Resolved #VYG-' || new.number || ' · ' || new.subject);
  elsif new.status is distinct from old.status
        and old.status in ('resolved','closed') and new.status not in ('resolved','closed') then
    perform public.log_activity('reopened', 'ticket', new.id,
      'Reopened #VYG-' || new.number || ' · ' || new.subject);
  end if;
  return null;                                  -- AFTER trigger: return value ignored
end;
$$;

drop trigger if exists activity_from_ticket on public.support_tickets;
create trigger activity_from_ticket
  after insert or update of status on public.support_tickets
  for each row execute function public.activity_from_ticket();

create or replace function public.activity_from_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('created', 'project', new.id, 'New project · ' || new.name);
  elsif new.status is distinct from old.status then
    perform public.log_activity('updated', 'project', new.id,
      new.name || ' moved to ' || replace(new.status, '_', ' '));
  end if;
  return null;
end;
$$;

drop trigger if exists activity_from_project on public.client_projects;
create trigger activity_from_project
  after insert or update of status on public.client_projects
  for each row execute function public.activity_from_project();

create or replace function public.activity_from_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_activity('created', 'contact', new.id, 'Added ' || new.full_name || ' to the CRM');
  return null;
end;
$$;

drop trigger if exists activity_from_contact on public.crm_contacts;
create trigger activity_from_contact
  after insert on public.crm_contacts
  for each row execute function public.activity_from_contact();

-- Money is manager-only, and so is hearing about it.
create or replace function public.activity_from_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    perform public.log_activity('paid', 'invoice', new.id,
      'Invoice ' || new.number || ' paid · ' || new.client, 'manager');
  end if;
  return null;
end;
$$;

drop trigger if exists activity_from_invoice on public.finance_invoices;
create trigger activity_from_invoice
  after update of status on public.finance_invoices
  for each row execute function public.activity_from_invoice();

-- ─────────────────────────────────────────────────────────────────────────────
-- The overview numbers.
--
-- security INVOKER (the default) so every count below is filtered by the
-- caller's own RLS. The finance figures are additionally gated on is_manager()
-- and come back as null rather than 0 for everyone else: a zero would read as
-- "no revenue this month", which is a worse answer than "not your business".
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.workspace_overview()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_manager  boolean := public.is_manager();
  v_start    date    := date_trunc('month', current_date)::date;
  v_revenue  numeric;
  v_invoices jsonb;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  if v_manager then
    select coalesce(sum(amount), 0) into v_revenue
    from public.finance_transactions
    where amount > 0 and posted_at >= v_start;

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
    'as_of',            now(),
    'revenue_month',    v_revenue,
    'invoices_outstanding', v_invoices,
    'tickets_open',     (select count(*) from public.support_tickets
                          where status in ('open','in_progress','waiting') and deleted_at is null),
    'tickets_high',     (select count(*) from public.support_tickets
                          where status in ('open','in_progress','waiting') and deleted_at is null
                            and priority in ('high','urgent')),
    'projects_active',  (select count(*) from public.client_projects
                          where status in ('discovery','in_progress','in_review') and deleted_at is null),
    'tasks_open',       (select count(*) from public.tasks where status <> 'done'),
    'events_today',     (select count(*) from public.calendar_events
                          where status <> 'cancelled'
                            and starts_at >= date_trunc('day', now())
                            and starts_at <  date_trunc('day', now()) + interval '1 day')
  );
end;
$$;

revoke all on function public.workspace_overview() from public, anon;
grant execute on function public.workspace_overview() to authenticated;

comment on function public.workspace_overview() is
  'One round trip for the Overview tiles. Finance figures are null for '
  'non-managers rather than 0 — a zero would read as a real number.';
comment on table public.workspace_activity is
  'Recent activity. Rows are tagged staff/manager; finance events are '
  'manager-only so the feed cannot undo the finance boundary.';
