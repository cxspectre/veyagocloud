-- =============================================================================
-- workspace-demo.sql — sample content for the workspace. NOT applied by any
-- migration, and NOT run by `npm run check:db`.
--
-- The workspace schema (0021-0028) ships empty on purpose: the CRM, the
-- projects and the tickets are business records, and inventing them in a live
-- database makes a mess someone then has to clean up. Run this only if you
-- want something on the screen before the real data arrives.
--
--   Apply:  paste into Dashboard -> SQL Editor -> Run
--           (or psql "$DATABASE_URL" -f supabase/seed/workspace-demo.sql)
--
--   Undo:   every row is tagged "[demo]", so this removes all of it and
--           nothing else:
--
--             begin;
--             delete from public.workspace_activity where summary like '%[demo]%';
--             delete from public.calendar_events   where title   like '[demo]%';
--             delete from public.ticket_messages   where ticket_id in
--               (select id from public.support_tickets where subject like '[demo]%');
--             delete from public.support_tickets   where subject like '[demo]%';
--             delete from public.tasks             where title   like '[demo]%';
--             delete from public.client_projects   where name    like '[demo]%';
--             delete from public.crm_contacts      where full_name like '[demo]%';
--             delete from public.crm_companies     where name    like '[demo]%';
--             commit;
--
-- Idempotent: re-running replaces its own rows rather than adding more.
-- =============================================================================

do $$
declare
  v_owner       uuid;
  v_northline   uuid;
  v_meridian    uuid;
  v_forma       uuid;
  v_olivia      uuid;
  v_james       uuid;
  v_emma        uuid;
  v_kept        uuid;
  v_website     uuid;
  v_travel      uuid;
  v_ticket      uuid;
begin
  -- Start from clean so the seed is repeatable.
  delete from public.workspace_activity where summary like '%[demo]%';
  delete from public.calendar_events   where title like '[demo]%';
  delete from public.ticket_messages   where ticket_id in
    (select id from public.support_tickets where subject like '[demo]%');
  delete from public.support_tickets   where subject like '[demo]%';
  delete from public.tasks             where title like '[demo]%';
  delete from public.client_projects   where name like '[demo]%';
  delete from public.crm_contacts      where full_name like '[demo]%';
  delete from public.crm_companies     where name like '[demo]%';

  select id into v_owner from public.employees
  where role in ('owner','admin') and status = 'active'
  order by case role when 'owner' then 0 else 1 end
  limit 1;

  insert into public.crm_companies (name, domain, kind, stage, value, owner_id, notes) values
    ('[demo] Northline Studio',  'northline.example', 'client',   'client',    4800, v_owner, 'Website redesign. Weekly progress update on Fridays.'),
    ('[demo] Meridian Ventures', 'meridian.example',  'prospect', 'proposal', 12000, v_owner, 'Proposal sent; waiting on their board.'),
    ('[demo] Forma Architecture','forma.example',     'client',   'client',    2600, v_owner, 'Contact form and hosting.');

  select id into v_northline from public.crm_companies where name = '[demo] Northline Studio';
  select id into v_meridian  from public.crm_companies where name = '[demo] Meridian Ventures';
  select id into v_forma     from public.crm_companies where name = '[demo] Forma Architecture';

  insert into public.crm_contacts (company_id, full_name, email, title, is_primary, notes) values
    (v_northline, '[demo] Olivia Chen',  'olivia@northline.example', 'Creative director', true,  'Prefers a weekly summary to a call.'),
    (v_meridian,  '[demo] James Brooks', 'james@meridian.example',   'Partner',           true,  'Asked for a fixed price, not a range.'),
    (v_forma,     '[demo] Emma Laurent', 'emma@forma.example',       'Studio manager',    true,  'Handles invoices.');

  select id into v_olivia from public.crm_contacts where full_name = '[demo] Olivia Chen';
  select id into v_james  from public.crm_contacts where full_name = '[demo] James Brooks';
  select id into v_emma   from public.crm_contacts where full_name = '[demo] Emma Laurent';

  -- ── Projects ──────────────────────────────────────────────────────────────
  insert into public.client_projects (name, company_id, code, accent, status, description, due_on, owner_id, sort_order)
  values
    ('[demo] Kept · Autumn release', null, 'k', 'default', 'in_progress',
     'A thoughtful update to document management, subscriptions, and the details that matter.',
     current_date + 13, v_owner, 10),
    ('[demo] Northline · Website', v_northline, 'N', 'client', 'in_progress',
     'A new digital home for an independent design studio.',
     current_date + 27, v_owner, 20),
    ('[demo] Veyago · Travel app', null, 'V', 'travel', 'in_review',
     'The next chapter of Veyago travel, from discovery to a trip worth taking.',
     current_date + 19, v_owner, 30);

  select id into v_kept    from public.client_projects where name = '[demo] Kept · Autumn release';
  select id into v_website from public.client_projects where name = '[demo] Northline · Website';
  select id into v_travel  from public.client_projects where name = '[demo] Veyago · Travel app';

  -- ── Tasks (these are what the board's progress bars count) ────────────────
  insert into public.tasks (title, project_id, assignee_id, status, priority, due_date) values
    ('[demo] Finalize document export flow',      v_kept,    v_owner, 'in_progress', 'high',   current_date + 3),
    ('[demo] Review subscription restore handling', v_kept,  v_owner, 'todo',        'urgent', current_date + 1),
    ('[demo] Prepare App Store release notes',    v_kept,    v_owner, 'done',        'normal', current_date - 1),
    ('[demo] Second pass on the homepage',        v_website, v_owner, 'in_progress', 'normal', current_date + 5),
    ('[demo] Migrate the old gallery images',     v_website, v_owner, 'todo',        'low',    current_date + 9),
    ('[demo] Trip discovery spike',               v_travel,  v_owner, 'done',        'normal', current_date - 4);

  update public.tasks set completed_at = now() - interval '1 day'
  where title like '[demo]%' and status = 'done';

  -- ── Tickets, with a thread ────────────────────────────────────────────────
  insert into public.support_tickets (subject, contact_id, company_id, product, priority, status, assignee_id, source)
  values ('[demo] Subscription not restoring on new device', v_olivia, v_northline, 'Kept', 'high', 'open', v_owner, 'email')
  returning id into v_ticket;

  insert into public.ticket_messages (ticket_id, author_contact_id, direction, body) values
    (v_ticket, v_olivia, 'inbound',
     'I recently upgraded my iPhone and my Kept Plus subscription is not restoring. I have tried signing out and back in. Could you help me get access again?');
  insert into public.ticket_messages (ticket_id, author_employee_id, direction, body) values
    (v_ticket, v_owner, 'internal',
     'Receipt looks valid in App Store Connect — likely the restore path, not the purchase.');

  insert into public.support_tickets (subject, contact_id, company_id, product, priority, status, assignee_id, source) values
    ('[demo] Feedback on the homepage concept', v_olivia, v_northline, 'Northline Studio', 'normal', 'in_progress', v_owner, 'email'),
    ('[demo] Exporting warranty documents',     v_james,  v_meridian,  'Kept',             'low',    'open',        v_owner, 'form'),
    ('[demo] Contact form confirmation email',   v_emma,  v_forma,     'Forma Architecture','normal','open',        v_owner, 'form');

  -- ── Agenda: entered in the workspace, so connection_id stays null ─────────
  insert into public.calendar_events (title, detail, starts_at, ends_at, kind, company_id, project_id, created_by) values
    ('[demo] Weekly studio check-in', 'Internal · Google Meet',
     date_trunc('day', now()) + interval '9 hours',  date_trunc('day', now()) + interval '9 hours 30 minutes', 'team', null, null, v_owner),
    ('[demo] Northline design review', 'Olivia Chen · Google Meet',
     date_trunc('day', now()) + interval '14 hours', date_trunc('day', now()) + interval '14 hours 45 minutes', 'client', v_northline, v_website, v_owner),
    ('[demo] Kept release planning', 'Cassian, Jamie · Google Meet',
     date_trunc('day', now()) + interval '16 hours', date_trunc('day', now()) + interval '16 hours 30 minutes', 'internal', null, v_kept, v_owner),
    ('[demo] Meridian proposal call', 'James Brooks',
     date_trunc('day', now()) + interval '1 day 11 hours', date_trunc('day', now()) + interval '1 day 11 hours 30 minutes', 'client', v_meridian, null, v_owner);

  raise notice 'workspace demo seeded: 3 companies, 3 contacts, 3 projects, 6 tasks, 4 tickets, 4 events';
end $$;
