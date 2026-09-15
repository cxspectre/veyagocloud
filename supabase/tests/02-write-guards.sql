begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated;
grant usage, select on sequence results_id_seq to authenticated;

update public.employees set status='active', role='employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.crm_companies (id, name) values ('11111111-1111-1111-1111-111111111111','Test Co');
insert into public.client_projects (id, name) values ('33333333-3333-3333-3333-333333333333','Project A');
insert into public.client_projects (id, name) values ('3a3a3a3a-3333-3333-3333-333333333333','Project B');
insert into public.support_tickets (id, subject) values ('44444444-4444-4444-4444-444444444444','Guard ticket');
insert into public.ticket_messages (id, ticket_id, direction, body)
values ('4a4a4a4a-4444-4444-4444-444444444444','44444444-4444-4444-4444-444444444444','inbound','original text');
insert into public.tasks (id, title, assignee_id, project_id, priority, status)
values ('99999999-9999-9999-9999-999999999999', 'Guard task',
        (select id from public.employees where user_id='21fc20c1-50e8-4764-9a11-71031d2f8f2c'),
        '33333333-3333-3333-3333-333333333333', 'normal', 'todo');
insert into public.integration_connections (id, provider, account_label, status)
values ('55555555-5555-5555-5555-555555555555','microsoft_mail','fixture.inbox@example.invalid','connected');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}',true);

-- 1. An assignee may advance their task…
update public.tasks set status='in_progress' where id='99999999-9999-9999-9999-999999999999';
insert into results(name, expected, actual, pass)
select 'assignee CAN move their task along', 'in_progress', status, status='in_progress'
from public.tasks where id='99999999-9999-9999-9999-999999999999';

-- 2. …but not re-file it under another project (0022 guard).
update public.tasks set project_id='3a3a3a3a-3333-3333-3333-333333333333'
where id='99999999-9999-9999-9999-999999999999';
insert into results(name, expected, actual, pass)
select 'TASK GUARD: assignee cannot re-file the project', 'Project A',
       (select name from public.client_projects where id = t.project_id),
       t.project_id = '33333333-3333-3333-3333-333333333333'
from public.tasks t where t.id='99999999-9999-9999-9999-999999999999';

-- 3. …nor rewrite its title.
update public.tasks set title='hijacked' where id='99999999-9999-9999-9999-999999999999';
insert into results(name, expected, actual, pass)
select 'TASK GUARD: assignee cannot rewrite the title', 'Guard task', title, title='Guard task'
from public.tasks where id='99999999-9999-9999-9999-999999999999';

-- 4. Soft delete is a manager decision (guard_soft_delete).
do $$
begin
  begin
    update public.client_projects set deleted_at = now()
    where id='33333333-3333-3333-3333-333333333333';
    insert into results(name, expected, actual, pass)
    values ('SOFT DELETE: employee blocked', 'refused', 'allowed the delete', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values ('SOFT DELETE: employee blocked', 'refused', 'refused: ' || left(sqlerrm, 42), true);
  end;
end $$;

-- 5. A sent reply cannot be edited later: no UPDATE policy at all.
do $$
declare n int;
begin
  update public.ticket_messages set body='rewritten history'
  where id='4a4a4a4a-4444-4444-4444-444444444444';
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  values ('APPEND-ONLY: ticket reply cannot be edited', '0 rows updated',
          n::text || ' rows updated', n = 0);
exception when others then
  insert into results(name, expected, actual, pass)
  values ('APPEND-ONLY: ticket reply cannot be edited', '0 rows updated',
          'refused: ' || left(sqlerrm, 42), true);
end $$;

-- 6. Staff may not invent events on a synced calendar.
do $$
begin
  begin
    insert into public.calendar_events (connection_id, external_id, title, starts_at)
    values ('55555555-5555-5555-5555-555555555555','fake','Fake sync event', now());
    insert into results(name, expected, actual, pass)
    values ('CALENDAR: no hand-written rows on a synced account', 'refused', 'inserted', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values ('CALENDAR: no hand-written rows on a synced account', 'refused',
            'refused: ' || left(sqlerrm, 42), true);
  end;
end $$;

-- 7. …but a local event is fine.
insert into public.calendar_events (title, starts_at, kind)
values ('Studio check-in', now(), 'team');
insert into results(name, expected, actual, pass)
select 'CALENDAR: local event allowed', '1', count(*)::text, count(*)=1
from public.calendar_events where title='Studio check-in';

-- 8. You cannot post a ticket reply as a colleague.
do $$
declare other uuid;
begin
  select id into other from public.employees
  where user_id='d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';
  begin
    insert into public.ticket_messages (ticket_id, author_employee_id, direction, body)
    values ('44444444-4444-4444-4444-444444444444', other, 'outbound', 'posted as someone else');
    insert into results(name, expected, actual, pass)
    values ('IMPERSONATION: cannot reply as a colleague', 'refused', 'inserted', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values ('IMPERSONATION: cannot reply as a colleague', 'refused',
            'refused: ' || left(sqlerrm, 42), true);
  end;
end $$;

-- 9. Replying stamps the response clock, internal notes do not.
insert into public.ticket_messages (ticket_id, author_employee_id, direction, body)
values ('44444444-4444-4444-4444-444444444444',
        (select id from public.employees where user_id='21fc20c1-50e8-4764-9a11-71031d2f8f2c'),
        'outbound', 'our reply');
-- 0034: writing a reply is not responding to anyone. The clock starts when
-- the reply is DELIVERED, so a ticket with no contact email never claims to
-- have been answered.
insert into results(name, expected, actual, pass)
select 'CLOCK: writing a reply does not start it', 'not started',
       coalesce(first_response_at::text, 'not started'), first_response_at is null
from public.support_tickets where id='44444444-4444-4444-4444-444444444444';

-- 12. Notes: you write as yourself, and you cannot rewrite a colleague's.
do $$
declare other uuid;
begin
  select id into other from public.employees
  where user_id='d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';
  begin
    insert into public.workspace_notes (entity_type, entity_id, author_id, body)
    values ('ticket','44444444-4444-4444-4444-444444444444', other, 'posted as someone else');
    insert into results(name, expected, actual, pass)
    values ('NOTES: cannot write as a colleague', 'refused', 'inserted', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values ('NOTES: cannot write as a colleague', 'refused', 'refused: ' || left(sqlerrm, 42), true);
  end;
end $$;

insert into public.workspace_notes (entity_type, entity_id, author_id, body)
values ('ticket','44444444-4444-4444-4444-444444444444',
        (select id from public.employees where user_id='21fc20c1-50e8-4764-9a11-71031d2f8f2c'),
        'my own note');
insert into results(name, expected, actual, pass)
select 'NOTES: can write as yourself', '1', count(*)::text, count(*) = 1
from public.workspace_notes where body = 'my own note';

-- A note by someone else, planted with the owner's id, must be read-only here.
insert into results(name, expected, actual, pass)
select 'NOTES: blank body is refused', 'refused',
       coalesce((select 'accepted' from public.workspace_notes where body = '   ' limit 1), 'refused'),
       not exists (select 1 from public.workspace_notes where body = '   ');

reset role;

-- Planted as the owner, then checked from the employee's session below.
insert into public.workspace_notes (entity_type, entity_id, author_id, body)
values ('ticket','44444444-4444-4444-4444-444444444444',
        (select id from public.employees where user_id='d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'),
        'the owner wrote this');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}',true);

insert into results(name, expected, actual, pass)
select 'NOTES: staff read everyone''s notes', '2', count(*)::text, count(*) = 2
from public.workspace_notes;

do $$
declare n int;
begin
  update public.workspace_notes set body = 'rewritten' where body = 'the owner wrote this';
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  values ('NOTES: cannot edit a colleague''s note', '0 rows updated',
          n::text || ' rows updated', n = 0);
end $$;

reset role;

-- 10. Resolution timestamps are the database's, not the client's.
update public.support_tickets set status='resolved' where id='44444444-4444-4444-4444-444444444444';
insert into results(name, expected, actual, pass)
select 'resolved_at stamped on resolve', 'set', coalesce(resolved_at::text,'null'), resolved_at is not null
from public.support_tickets where id='44444444-4444-4444-4444-444444444444';

update public.support_tickets set status='open' where id='44444444-4444-4444-4444-444444444444';
insert into results(name, expected, actual, pass)
select 'resolved_at cleared on reopen', 'null', coalesce(resolved_at::text,'null'), resolved_at is null
from public.support_tickets where id='44444444-4444-4444-4444-444444444444';

-- 10b. Delivery starts the clock, and only the first delivery.
update public.ticket_messages set delivered_at = now()
where ticket_id='44444444-4444-4444-4444-444444444444' and direction='outbound';

insert into results(name, expected, actual, pass)
select 'CLOCK: delivery starts it', 'started',
       case when first_response_at is null then 'still null' else 'started' end,
       first_response_at is not null
from public.support_tickets where id='44444444-4444-4444-4444-444444444444';

update public.ticket_messages set delivered_at = now() + interval '1 hour'
where ticket_id='44444444-4444-4444-4444-444444444444' and direction='outbound';

insert into results(name, expected, actual, pass)
select 'CLOCK: a later delivery does not move it', 'unchanged',
       case when first_response_at < now() + interval '30 minutes' then 'unchanged' else 'moved' end,
       first_response_at < now() + interval '30 minutes'
from public.support_tickets where id='44444444-4444-4444-4444-444444444444';

-- The internal note the two checks below act on. Without it they update zero
-- rows and pass vacuously, which is a test that proves nothing.
insert into public.ticket_messages (ticket_id, author_employee_id, direction, body)
values ('44444444-4444-4444-4444-444444444444',
        (select id from public.employees where user_id='21fc20c1-50e8-4764-9a11-71031d2f8f2c'),
        'internal', 'between us');

insert into results(name, expected, actual, pass)
select 'INTERNAL NOTE: the fixture exists', '1', count(*)::text, count(*) = 1
from public.ticket_messages where direction='internal';

-- An internal note can never be marked delivered. Two separate barriers, and
-- they fail differently: under RLS there is simply no UPDATE policy, so the
-- statement is a silent no-op; with the policy out of the way, the CHECK from
-- 0033 raises. The invariant is the same either way — the stamp never lands.
do $$
declare n int;
begin
  update public.ticket_messages set delivered_at = now() where direction='internal';
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  select 'INTERNAL NOTE: stays unstamped under RLS', 'no stamp',
         case when bool_or(delivered_at is not null) then 'stamped' else 'no stamp' end,
         not bool_or(delivered_at is not null)
  from public.ticket_messages where direction='internal';
exception when others then
  insert into results(name, expected, actual, pass)
  values ('INTERNAL NOTE: stays unstamped under RLS', 'no stamp',
          'refused: ' || left(sqlerrm, 34), true);
end $$;

reset role;

-- And the constraint itself, with RLS out of the picture.
do $$
begin
  begin
    update public.ticket_messages set delivered_at = now() where direction='internal';
    insert into results(name, expected, actual, pass)
    values ('INTERNAL NOTE: the CHECK refuses a stamp', 'refused', 'accepted', false);
  exception when check_violation then
    insert into results(name, expected, actual, pass)
    values ('INTERNAL NOTE: the CHECK refuses a stamp', 'refused', 'check_violation', true);
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}',true);

-- 11. Project progress is computed from its tasks.
insert into results(name, expected, actual, pass)
select 'progress computed from tasks', '0 of 1', tasks_done::text || ' of ' || task_count::text,
       task_count = 1 and tasks_done = 0 and progress = 0
from public.client_project_progress where id='33333333-3333-3333-3333-333333333333';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
