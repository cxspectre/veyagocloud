begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

-- A real non-manager to test with: an inactive assistant, woken up inside this
-- transaction only. No new auth user, nothing left behind after the rollback.
update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- Fixtures the tests read. All rolled back.
insert into public.crm_companies (id, name, domain)
values ('11111111-1111-1111-1111-111111111111', 'Test Co', 'test.example');
insert into public.crm_contacts (id, company_id, full_name, email)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Test Person', 'p@test.example');
insert into public.client_projects (id, name, company_id)
values ('33333333-3333-3333-3333-333333333333', 'Test Project', '11111111-1111-1111-1111-111111111111');
insert into public.support_tickets (id, subject, company_id)
values ('44444444-4444-4444-4444-444444444444', 'Test ticket', '11111111-1111-1111-1111-111111111111');
insert into public.workspace_activity (verb, entity_type, summary, visibility)
values ('paid', 'invoice', 'MONEY MOVED', 'manager'),
       ('created', 'ticket', 'ORDINARY EVENT', 'staff');

-- A studio mailbox and a personal one belonging to the OWNER.
insert into public.integration_connections (id, provider, account_label, employee_id, status)
values ('55555555-5555-5555-5555-555555555555', 'microsoft_mail', 'fixture.inbox@example.invalid', null, 'connected'),
       ('66666666-6666-6666-6666-666666666666', 'microsoft_mail', 'fixture.private@example.invalid',
        (select id from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), 'connected');
insert into public.integration_secrets (connection_id, access_token, refresh_token)
values ('55555555-5555-5555-5555-555555555555', 'ACCESS-TOKEN-SHOULD-NEVER-LEAK', 'REFRESH-SHOULD-NEVER-LEAK');
insert into public.mail_threads (id, connection_id, external_id, subject)
values ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 't1', 'Shared thread'),
       ('88888888-8888-8888-8888-888888888888', '66666666-6666-6666-6666-666666666666', 't2', 'Private thread');
-- The OWNER's signature, which nobody else may read (0038).
insert into public.mail_signatures (employee_id, connection_id, html)
select id, null, '<p>OWNER SIGNATURE</p>' from public.employees
where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
on conflict (employee_id, connection_id) do update set html = excluded.html;

-- ── as the OWNER (manager) ──────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated"}', true);

insert into results(name, expected, actual, pass)
select 'manager: is_manager()', 'true', public.is_manager()::text, public.is_manager() = true;

-- Scoped, for the same reason as the privacy checks below: an unscoped count
-- was only ever right on an empty database.
insert into results(name, expected, actual, pass)
select 'manager: reads own + studio mail threads', '2',
       count(*)::text, count(*) = 2
from public.mail_threads
where id in ('77777777-7777-7777-7777-777777777777',
             '88888888-8888-8888-8888-888888888888');

insert into results(name, expected, actual, pass)
select 'manager: sees manager-tagged activity', 'true',
       (count(*) > 0)::text, count(*) > 0
from public.workspace_activity where summary = 'MONEY MOVED';

do $$
declare n int;
begin
  begin
    select count(*) into n from public.integration_secrets;
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: manager cannot read tokens', 'denied or 0 rows', n::text || ' rows readable', n = 0);
  exception when insufficient_privilege then
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: manager cannot read tokens', 'denied or 0 rows', 'permission denied', true);
  end;
end $$;

insert into results(name, expected, actual, pass)
select 'manager: overview revenue is a number', 'true',
       (public.workspace_overview() -> 'revenue_month' <> 'null'::jsonb)::text,
       public.workspace_overview() -> 'revenue_month' <> 'null'::jsonb;

reset role;

-- ── as an ordinary EMPLOYEE (staff, not manager) ────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated"}', true);

insert into results(name, expected, actual, pass)
select 'employee: is_staff() yes, is_manager() no', 'true/false',
       public.is_staff()::text || '/' || public.is_manager()::text,
       public.is_staff() and not public.is_manager();

insert into results(name, expected, actual, pass)
select 'employee: reads the CRM', 'true', (count(*) > 0)::text, count(*) > 0
from public.crm_companies;

insert into results(name, expected, actual, pass)
select 'FINANCE LEAK: employee cannot see money activity', '0',
       count(*)::text, count(*) = 0
from public.workspace_activity where summary = 'MONEY MOVED';

insert into results(name, expected, actual, pass)
select 'employee: does see ordinary activity', '1',
       count(*)::text, count(*) = 1
from public.workspace_activity where summary = 'ORDINARY EVENT';

-- Scoped to this suite's own two threads. Counting every visible thread was
-- only correct while the database was empty; with a real mailbox connected it
-- fails for a reason that has nothing to do with the rule being tested.
insert into results(name, expected, actual, pass)
select 'MAIL PRIVACY: employee sees the studio thread', 'visible',
       case when count(*) = 1 then 'visible' else 'missing' end, count(*) = 1
from public.mail_threads where id = '77777777-7777-7777-7777-777777777777';

insert into results(name, expected, actual, pass)
select 'MAIL PRIVACY: and not a colleague''s personal one', 'hidden',
       case when count(*) = 0 then 'hidden' else 'VISIBLE' end, count(*) = 0
from public.mail_threads where id = '88888888-8888-8888-8888-888888888888';

-- 0038: a signature is its owner's alone.
insert into results(name, expected, actual, pass)
select 'SIGNATURE PRIVACY: employee cannot read the owner''s signature', 'hidden',
       case when count(*) = 0 then 'hidden' else 'VISIBLE' end, count(*) = 0
from public.mail_signatures where html = '<p>OWNER SIGNATURE</p>';

do $$
begin
  insert into public.mail_signatures (employee_id, connection_id, html)
  values (public.active_employee_id(), '55555555-5555-5555-5555-555555555555', '<p>Mine</p>');
  insert into results(name, expected, actual, pass)
  values ('employee: keeps a signature for the studio mailbox', 'saved', 'saved', true);
exception when others then
  insert into results(name, expected, actual, pass)
  values ('employee: keeps a signature for the studio mailbox', 'saved', sqlerrm, false);
end $$;

do $$
begin
  insert into public.mail_signatures (employee_id, connection_id, html)
  values (public.active_employee_id(), '66666666-6666-6666-6666-666666666666', '<p>Not my mailbox</p>');
  insert into results(name, expected, actual, pass)
  values ('SIGNATURE: not for a mailbox the employee cannot read', 'refused', 'SAVED', false);
exception when insufficient_privilege then
  insert into results(name, expected, actual, pass)
  values ('SIGNATURE: not for a mailbox the employee cannot read', 'refused', 'refused', true);
end $$;

do $$
begin
  insert into public.mail_signatures (employee_id, connection_id, html)
  select id, '55555555-5555-5555-5555-555555555555', '<p>Forged</p>'
  from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093';
  insert into results(name, expected, actual, pass)
  values ('SIGNATURE: nobody writes a colleague''s', 'refused', 'SAVED', false);
exception when insufficient_privilege then
  insert into results(name, expected, actual, pass)
  values ('SIGNATURE: nobody writes a colleague''s', 'refused', 'refused', true);
end $$;

-- 0038: a person marks read and stars; nothing else on a thread is theirs.
do $$
begin
  update public.mail_threads set subject = 'rewritten'
  where id = '77777777-7777-7777-7777-777777777777';
  insert into results(name, expected, actual, pass)
  values ('THREAD COLUMNS: employee cannot rewrite a subject', 'denied', 'ALLOWED', false);
exception when insufficient_privilege then
  insert into results(name, expected, actual, pass)
  values ('THREAD COLUMNS: employee cannot rewrite a subject', 'denied', 'denied', true);
end $$;

do $$
begin
  update public.mail_threads set connection_id = '66666666-6666-6666-6666-666666666666'
  where id = '77777777-7777-7777-7777-777777777777';
  insert into results(name, expected, actual, pass)
  values ('THREAD COLUMNS: nor move a studio thread into a personal mailbox', 'denied', 'ALLOWED', false);
exception when insufficient_privilege then
  insert into results(name, expected, actual, pass)
  values ('THREAD COLUMNS: nor move a studio thread into a personal mailbox', 'denied', 'denied', true);
end $$;

with changed as (
  update public.mail_threads set is_read = true, is_starred = true
  where id = '77777777-7777-7777-7777-777777777777'
  returning 1
)
insert into results(name, expected, actual, pass)
select 'employee: marks a studio thread read and starred', '1', count(*)::text, count(*) = 1
from changed;

do $$
declare n int;
begin
  begin
    select count(*) into n from public.integration_secrets;
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: employee cannot read tokens', 'denied or 0 rows', n::text || ' rows readable', n = 0);
  exception when insufficient_privilege then
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: employee cannot read tokens', 'denied or 0 rows', 'permission denied', true);
  end;
end $$;

insert into results(name, expected, actual, pass)
select 'employee: finance tables stay invisible', '0',
       count(*)::text, count(*) = 0 from public.finance_transactions;

insert into results(name, expected, actual, pass)
select 'employee: overview revenue is null', 'null',
       (public.workspace_overview() -> 'revenue_month')::text,
       public.workspace_overview() -> 'revenue_month' = 'null'::jsonb;

reset role;

-- ── as ANON (the key that ships in the browser before sign-in) ──────────────
set local role anon;
select set_config('request.jwt.claims', '', true);

insert into results(name, expected, actual, pass)
select 'anon: CRM invisible', '0', count(*)::text, count(*) = 0 from public.crm_companies;
insert into results(name, expected, actual, pass)
select 'anon: tickets invisible', '0', count(*)::text, count(*) = 0 from public.support_tickets;
insert into results(name, expected, actual, pass)
select 'anon: projects invisible', '0', count(*)::text, count(*) = 0 from public.client_projects;
insert into results(name, expected, actual, pass)
select 'anon: mail invisible', '0', count(*)::text, count(*) = 0 from public.mail_threads;
insert into results(name, expected, actual, pass)
select 'anon: activity invisible', '0', count(*)::text, count(*) = 0 from public.workspace_activity;
do $$
declare n int;
begin
  begin
    select count(*) into n from public.integration_secrets;
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: anon cannot read tokens', 'denied or 0 rows', n::text || ' rows readable', n = 0);
  exception when insufficient_privilege then
    insert into results(name, expected, actual, pass)
    values ('SEALED VAULT: anon cannot read tokens', 'denied or 0 rows', 'permission denied', true);
  end;
end $$;

reset role;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
