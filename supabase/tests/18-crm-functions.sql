-- 18-crm-functions.sql — a contact and their company are added in one step,
-- duplicates are merged by owners and admins without losing what points at
-- them, and a client's number is the database's to give (0053).
--
-- The assistant, inactive in real life, is woken for this transaction as staff
-- and adds contacts the way the workspace does; the OWNER merges. A stranger
-- signed in, the service role, anon, the OWNER at aal1 with a verified factor,
-- and finally the assistant as an inactive admin are all refused. A refusal
-- passes only for its SQLSTATE and its reason (pg_temp.refused_as), and what it
-- said in detail is kept for the check after it.
--
-- As in 04 and 11, every call that writes runs in its own statement, and the
-- checks on what it wrote come after: a subquery in the same statement reads
-- the snapshot from before the call.
--
-- A merge's answer counts only what the OWNER can read: the assistant's own
-- mailbox and calendar hold a conversation and a meeting with the records
-- merged, which move all the same.
--
-- The last section changes the currency rule for a moment, to store companies
-- in codes 0049 refuses the way a company stored before 0049 holds them; puts
-- a trigger of its own on invoices, which refuses a merge; lists a table of its
-- own with two foreign keys to crm_companies in one step; and adds a table
-- whose foreign key no merge handles. Each holds a lock until the rollback,
-- which is why they come last. Everything is rolled back but what the client
-- number sequence gave out, which no rollback returns: the suite notes where
-- the sequence stood and hands its numbers back at the end (SEQUENCE).
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon, service_role;
grant usage, select on sequence results_id_seq to authenticated, anon, service_role;

-- A statement that must be refused, for the reason given.
create function pg_temp.refused(p_name text, p_statement text, p_reason text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_statement;
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'went through', false);
  exception when others then
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_reason, 'refused: ' || left(sqlerrm, 90),
            strpos(lower(sqlerrm), lower(p_reason)) > 0);
  end;
end;
$$;

-- A statement that must be refused with this SQLSTATE, for the reason given.
-- The error's detail is kept in test.detail for the checks after it.
create function pg_temp.refused_as(p_name text, p_statement text, p_state text, p_reason text)
returns void
language plpgsql
as $$
declare
  v_state   text;
  v_message text;
  v_detail  text;
begin
  begin
    execute p_statement;
    perform set_config('test.detail', '', true);
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_state || ' · ' || p_reason, 'went through', false);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
    perform set_config('test.detail', coalesce(v_detail, ''), true);
    insert into results(name, expected, actual, pass)
    values (p_name, 'refused: ' || p_state || ' · ' || p_reason,
            'refused: ' || v_state || ' · ' || left(v_message, 110),
            v_state = p_state and strpos(lower(v_message), lower(p_reason)) > 0);
  end;
end;
$$;

-- A statement that must go through and touch exactly this many rows.
create function pg_temp.affects(p_name text, p_statement text, p_rows int)
returns void
language plpgsql
as $$
declare
  n int;
begin
  execute p_statement;
  get diagnostics n = row_count;
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', n || ' rows', n = p_rows);
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_rows || ' rows', 'refused: ' || left(sqlerrm, 90), false);
end;
$$;

-- A query that must go through; the one value it answers is kept in
-- test.<key> for the checks after it.
create function pg_temp.run(p_name text, p_key text, p_query text)
returns void
language plpgsql
as $$
declare
  v_value text;
begin
  execute p_query into v_value;
  perform set_config('test.' || p_key, coalesce(v_value, ''), true);
  insert into results(name, expected, actual, pass)
  values (p_name, 'goes through', 'went through', true);
exception when others then
  perform set_config('test.' || p_key, '', true);
  insert into results(name, expected, actual, pass)
  values (p_name, 'goes through', 'refused: ' || left(sqlerrm, 90), false);
end;
$$;

-- A query that answers (actual text, pass boolean). An error is a named FAIL,
-- not the end of the suite.
create function pg_temp.check(p_name text, p_expected text, p_query text)
returns void
language plpgsql
as $$
declare
  v_actual text;
  v_pass   boolean;
begin
  execute p_query into v_actual, v_pass;
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, coalesce(v_actual, 'null'), coalesce(v_pass, false));
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, 'error: ' || left(sqlerrm, 90), false);
end;
$$;

-- Foreign keys to a CRM table that crm_merge_references() does not list: the
-- ones a merge would leave pointing at the record it deleted.
create function pg_temp.unhandled_crm_references()
returns text
language plpgsql
as $$
begin
  return (
    select coalesce(string_agg(c.conrelid::regclass::text || '.' || a.attname, ', '
                               order by c.conrelid::regclass::text, a.attname), 'none')
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid in ('public.crm_companies'::regclass, 'public.crm_contacts'::regclass)
      and (cardinality(c.conkey) <> 1
           or not exists (select 1 from public.crm_merge_references() m
                          where to_regclass('public.' || quote_ident(m.table_name)) = c.conrelid
                            and m.column_name = a.attname
                            and to_regclass('public.' || quote_ident(m.target_table)) = c.confrelid))
  );
end;
$$;

-- The last client number given out when this run began, as SEQUENCE noted it,
-- and the last one given out now. plpgsql, so that where 0053 is not applied
-- the suite still runs, and fails by name.
create function pg_temp.client_seq_start()
returns bigint
language plpgsql
as $$
begin
  return case when split_part(current_setting('test.client_seq'), ' ', 2)::boolean
              then split_part(current_setting('test.client_seq'), ' ', 1)::bigint
              else split_part(current_setting('test.client_seq'), ' ', 1)::bigint - 1 end;
end;
$$;

create function pg_temp.client_seq_now()
returns bigint
language plpgsql
as $$
begin
  return (select case when is_called then last_value else last_value - 1 end
          from public.crm_companies_client_number_seq);
end;
$$;

-- crm_merge_references() as 0053 lists it, and more: rewritten until the
-- rollback, for a table of the suite's own.
create function pg_temp.list_references_with(p_more text)
returns void
language plpgsql
as $$
declare
  v_listed text;
begin
  select string_agg(format('(%L, %L, %L, %L, %s)', m.target_table, m.table_name, m.column_name, m.handling,
                           coalesce(m.step::text, 'null::int')),
                    ', ' order by m.target_table, m.table_name, m.column_name)
    into v_listed
  from public.crm_merge_references() m;
  execute format('create or replace function public.crm_merge_references() '
                 'returns table (target_table text, table_name text, column_name text, handling text, step int) '
                 'language sql immutable set search_path = '''' as %L',
                 'values ' || v_listed || ', ' || p_more);
end;
$$;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- Where the client number sequence stands before the fixtures draw from it. A
-- rollback does not give back what a sequence gave out; SEQUENCE, at the end,
-- hands this run's numbers back.
select pg_temp.run('SEQUENCE: note where the client number sequence stands', 'client_seq', $sql$
  select last_value || ' ' || is_called from public.crm_companies_client_number_seq
$sql$);

-- ── Fixtures. All rolled back. ───────────────────────────────────────────
-- 01 is kept and 02 merged into it: 02 is a client, so it holds a number, and
-- it has the domain, value, owner and notes 01 lacks. 03 and 07 are deleted.
-- 05 and 06 have one name between them. 08 and 09 are clients, merged later.
insert into public.crm_companies (id, name, stage, currency, domain, value, owner_id, notes, deleted_at) values
  ('18a00000-0000-4000-a000-000000000001', 'check-db 18 Keep Co', 'lead', 'EUR', null, null, null, null, null),
  ('18a00000-0000-4000-a000-000000000002', 'check-db 18 Drop Co', 'client', 'EUR', 'check-db-18-drop.invalid', 5000,
   current_setting('test.owner_employee')::uuid, 'check-db 18 drop notes', null),
  ('18a00000-0000-4000-a000-000000000003', 'check-db 18 Deleted Co', 'lead', 'EUR', null, null, null, null, now()),
  ('18a00000-0000-4000-a000-000000000004', 'check-db 18 Existing Name', 'lead', 'EUR', null, null, null, null, null),
  ('18a00000-0000-4000-a000-000000000005', 'check-db 18 Twice', 'lead', 'EUR', null, null, null, null, null),
  ('18a00000-0000-4000-a000-000000000006', '  CHECK-DB 18 twice ', 'lead', 'EUR', null, null, null, null, null),
  ('18a00000-0000-4000-a000-000000000007', 'check-db 18 Gone Name', 'lead', 'EUR', null, null, null, null, now()),
  ('18a00000-0000-4000-a000-000000000008', 'check-db 18 Numbered Keep', 'client', 'EUR', null, null, null, null, null),
  ('18a00000-0000-4000-a000-000000000009', 'check-db 18 Numbered Drop', 'client', 'EUR', null, null, null, null, null);

-- 23 is kept and 24 merged into it: 24 has the address, phone and notes 23
-- lacks, and is the primary contact. 25 is at 02 and deleted later. 26 works
-- at 04 and 27 at 01, on a project of 01's. 28 is deleted.
insert into public.crm_contacts (id, company_id, full_name, email, phone, title, is_primary, notes) values
  ('18a00000-0000-4000-a000-000000000021', '18a00000-0000-4000-a000-000000000002', 'check-db 18 Drop Person',
   'check-db-18-drop@check-db-18.invalid', null, null, false, null),
  ('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000001', 'check-db 18 Keep Contact',
   null, null, 'Keeper', false, null),
  ('18a00000-0000-4000-a000-000000000024', '18a00000-0000-4000-a000-000000000001', 'check-db 18 Drop Contact',
   'check-db-18-dup@check-db-18.invalid', '+31 6 0000 0018', 'Dropper', true, 'check-db 18 drop contact notes'),
  ('18a00000-0000-4000-a000-000000000025', '18a00000-0000-4000-a000-000000000002', 'check-db 18 Deleted Person',
   null, null, null, false, null),
  ('18a00000-0000-4000-a000-000000000026', '18a00000-0000-4000-a000-000000000004', 'check-db 18 Elsewhere',
   null, null, null, false, null),
  ('18a00000-0000-4000-a000-000000000027', '18a00000-0000-4000-a000-000000000001', 'check-db 18 On A Project',
   null, null, null, false, null),
  ('18a00000-0000-4000-a000-000000000028', null, 'check-db 18 Gone Person',
   'check-db-18-gone@check-db-18.invalid', null, null, false, null);

insert into public.client_projects (id, name, company_id) values
  ('18a00000-0000-4000-a000-000000000041', 'check-db 18 Project One', '18a00000-0000-4000-a000-000000000001'),
  ('18a00000-0000-4000-a000-000000000042', 'check-db 18 Project Two', '18a00000-0000-4000-a000-000000000001'),
  ('18a00000-0000-4000-a000-000000000043', 'check-db 18 Drop Co Project', '18a00000-0000-4000-a000-000000000002');

insert into public.project_contacts (project_id, contact_id, role) values
  ('18a00000-0000-4000-a000-000000000041', '18a00000-0000-4000-a000-000000000023', 'billing'),
  ('18a00000-0000-4000-a000-000000000041', '18a00000-0000-4000-a000-000000000024', 'technical'),
  ('18a00000-0000-4000-a000-000000000041', '18a00000-0000-4000-a000-000000000027', 'other'),
  ('18a00000-0000-4000-a000-000000000042', '18a00000-0000-4000-a000-000000000024', 'decision_maker'),
  ('18a00000-0000-4000-a000-000000000043', '18a00000-0000-4000-a000-000000000021', 'day_to_day'),
  ('18a00000-0000-4000-a000-000000000043', '18a00000-0000-4000-a000-000000000025', 'billing');

-- Deleted after they joined their project, so the link stays.
update public.crm_contacts set deleted_at = now()
where id in ('18a00000-0000-4000-a000-000000000025', '18a00000-0000-4000-a000-000000000028');

insert into public.support_tickets (id, subject, company_id, contact_id) values
  ('18a00000-0000-4000-a000-000000000051', 'check-db 18 Drop Co ticket',
   '18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000021'),
  ('18a00000-0000-4000-a000-000000000052', 'check-db 18 Drop Contact ticket',
   '18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000024');

insert into public.ticket_messages (id, ticket_id, author_contact_id, direction, body) values
  ('18a00000-0000-4000-a000-000000000053', '18a00000-0000-4000-a000-000000000052',
   '18a00000-0000-4000-a000-000000000024', 'inbound', 'check-db 18 written by the contact merged later');

insert into public.integration_connections (id, provider, account_label, status) values
  ('18a00000-0000-4000-a000-00000000005f', 'microsoft_mail', 'check-18@example.invalid', 'connected');

insert into public.mail_threads (id, connection_id, external_id, subject, company_id, contact_id) values
  ('18a00000-0000-4000-a000-000000000054', '18a00000-0000-4000-a000-00000000005f', 'check-18-company',
   'check-db 18 with Drop Co', '18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000021'),
  ('18a00000-0000-4000-a000-000000000055', '18a00000-0000-4000-a000-00000000005f', 'check-18-contact',
   'check-db 18 with Drop Contact', null, '18a00000-0000-4000-a000-000000000024');

insert into public.calendar_events (id, title, starts_at, company_id, contact_id) values
  ('18a00000-0000-4000-a000-000000000056', 'check-db 18 Drop Co meeting', now() + interval '1 day',
   '18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000021'),
  ('18a00000-0000-4000-a000-000000000057', 'check-db 18 Drop Contact call', now() + interval '2 days',
   null, '18a00000-0000-4000-a000-000000000024');

insert into public.workspace_notes (id, entity_type, entity_id, author_id, body) values
  ('18a00000-0000-4000-a000-000000000058', 'company', '18a00000-0000-4000-a000-000000000002',
   current_setting('test.owner_employee')::uuid, 'check-db 18 a note on Drop Co'),
  ('18a00000-0000-4000-a000-000000000059', 'contact', '18a00000-0000-4000-a000-000000000024',
   current_setting('test.owner_employee')::uuid, 'check-db 18 a note on Drop Contact');

-- Invoices name their company and project since 0051: one for Drop Co's
-- project, and one filed under a project of Invoice Drop Co's that later moved
-- to Invoice Third Co, which 0051 lets an invoice keep.
insert into public.crm_companies (id, name) values
  ('18a00000-0000-4000-a000-00000000000c', 'check-db 18 Invoice Keep Co'),
  ('18a00000-0000-4000-a000-00000000000d', 'check-db 18 Invoice Drop Co'),
  ('18a00000-0000-4000-a000-00000000000e', 'check-db 18 Invoice Third Co');
insert into public.client_projects (id, name, company_id) values
  ('18a00000-0000-4000-a000-000000000044', 'check-db 18 Moved Project', '18a00000-0000-4000-a000-00000000000d');

select pg_temp.affects('FIXTURE: invoices name the company and the project they bill', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id) values
    ('18a00000-0000-4000-a000-00000000005a', 'CHECK-18-1', 'check-db 18 Drop Co', 100,
     '18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000043'),
    ('18a00000-0000-4000-a000-00000000005b', 'CHECK-18-2', 'check-db 18 Invoice Drop Co', 200,
     '18a00000-0000-4000-a000-00000000000d', '18a00000-0000-4000-a000-000000000044')
$sql$, 2);

update public.client_projects set company_id = '18a00000-0000-4000-a000-00000000000e'
where id = '18a00000-0000-4000-a000-000000000044';

-- Refused Drop Co's person, project and invoice, for a merge that a trigger of
-- the suite's own refuses at the invoice (REFUSED, in the last section).
insert into public.crm_companies (id, name) values
  ('18a00000-0000-4000-a000-00000000000a', 'check-db 18 Refused Keep Co'),
  ('18a00000-0000-4000-a000-00000000000b', 'check-db 18 Refused Drop Co');
insert into public.crm_contacts (id, company_id, full_name) values
  ('18a00000-0000-4000-a000-000000000029', '18a00000-0000-4000-a000-00000000000b', 'check-db 18 Refused Drop Person');
insert into public.client_projects (id, name, company_id) values
  ('18a00000-0000-4000-a000-000000000045', 'check-db 18 Refused Drop Project', '18a00000-0000-4000-a000-00000000000b');

select pg_temp.affects('FIXTURE: an invoice for Refused Drop Co''s project', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id) values
    ('18a00000-0000-4000-a000-00000000005c', 'CHECK-18-3', 'check-db 18 Refused Drop Co', 300,
     '18a00000-0000-4000-a000-00000000000b', '18a00000-0000-4000-a000-000000000045')
$sql$, 1);

-- The assistant's own mailbox and calendar, which nobody else can open, owners
-- and admins included (0025, 0044): a conversation and a meeting with Drop Co
-- and Drop Contact.
insert into public.integration_connections (id, provider, account_label, status, employee_id) values
  ('18a00000-0000-4000-a000-0000000000c1', 'microsoft_mail', 'check-18-private@example.invalid', 'connected',
   current_setting('test.assistant_employee')::uuid);

insert into public.mail_threads (id, connection_id, external_id, subject, company_id, contact_id) values
  ('18a00000-0000-4000-a000-00000000005d', '18a00000-0000-4000-a000-0000000000c1', 'check-18-private',
   'check-db 18 the assistant''s own conversation', '18a00000-0000-4000-a000-000000000002',
   '18a00000-0000-4000-a000-000000000024');

insert into public.calendar_events (id, title, starts_at, company_id, contact_id, connection_id, external_id) values
  ('18a00000-0000-4000-a000-00000000005e', 'check-db 18 the assistant''s own meeting', now() + interval '3 days',
   '18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000024',
   '18a00000-0000-4000-a000-0000000000c1', 'check-18-private-event');

-- ── The shape of things ──────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'SHAPE: companies have a client number and a record of where a merged one went, contacts the latter',
       'crm_companies.client_number, crm_companies.merged_into_id, crm_contacts.merged_into_id',
       coalesce(string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name), 'none'),
       count(*) = 3
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'crm_companies' and column_name in ('client_number', 'merged_into_id'))
       or (table_name = 'crm_contacts' and column_name = 'merged_into_id'));

insert into results(name, expected, actual, pass)
select 'SHAPE: no two companies share a client number', 'a unique constraint on client_number',
       case when count(*) > 0 then 'a unique constraint on client_number' else 'none' end,
       count(*) > 0
from pg_constraint k
join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
where k.conrelid = 'public.crm_companies'::regclass
  and k.contype = 'u' and cardinality(k.conkey) = 1 and a.attname = 'client_number';

insert into results(name, expected, actual, pass)
select 'DEFINER: the three functions run as their owner, with a fixed search_path',
       '3 functions',
       count(*) || ' functions',
       count(*) = 3
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('create_contact_with_company', 'merge_companies', 'merge_contacts')
  and p.prosecdef
  and exists (select 1 from unnest(p.proconfig) s where s like 'search_path=%');

select pg_temp.check('GRANTS: signed-in people may call the three functions; anon and PUBLIC may not',
                     'authenticated 3 · anon 0 · public 0', $sql$
  select 'authenticated ' || count(*) filter (where has_function_privilege('authenticated', f, 'execute'))
           || ' · anon ' || count(*) filter (where has_function_privilege('anon', f, 'execute'))
           || ' · public ' || count(*) filter (where exists (
                select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = f),
                                                  acldefault('f', (select proowner from pg_proc where oid = f)))) x
                where x.grantee = 0 and x.privilege_type = 'EXECUTE')),
         count(*) filter (where has_function_privilege('authenticated', f, 'execute')) = 3
           and count(*) filter (where has_function_privilege('anon', f, 'execute')) = 0
           and count(*) filter (where exists (
                select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = f),
                                                  acldefault('f', (select proowner from pg_proc where oid = f)))) x
                where x.grantee = 0 and x.privilege_type = 'EXECUTE')) = 0
  from (values ('public.create_contact_with_company(text,text,text,text,boolean,text,uuid,uuid,text)'::regprocedure),
               ('public.merge_companies(uuid,uuid)'::regprocedure),
               ('public.merge_contacts(uuid,uuid)'::regprocedure)) as v(f)
$sql$);

select pg_temp.check('GRANTS: nobody but the database moves the client number sequence on',
                     'authenticated usage only · anon nothing', $sql$
  select 'authenticated '
           || case when has_sequence_privilege('authenticated', 'public.crm_companies_client_number_seq', 'UPDATE')
                   then 'can set it' when has_sequence_privilege('authenticated', 'public.crm_companies_client_number_seq', 'USAGE')
                   then 'usage only' else 'nothing' end
           || ' · anon '
           || case when has_sequence_privilege('anon', 'public.crm_companies_client_number_seq', 'USAGE,UPDATE,SELECT')
                   then 'something' else 'nothing' end,
         not has_sequence_privilege('authenticated', 'public.crm_companies_client_number_seq', 'UPDATE')
           and not has_sequence_privilege('anon', 'public.crm_companies_client_number_seq', 'USAGE,UPDATE,SELECT')
$sql$);

-- ── Every foreign key to a CRM table is one a merge handles ──────────────

select pg_temp.check('COVERAGE: every foreign key to crm_companies or crm_contacts is one the merge functions handle',
                     'none left out', $sql$
  select case when u = 'none' then 'none left out' else 'left out: ' || u end, u = 'none'
  from (select pg_temp.unhandled_crm_references() as u) x
$sql$);

select pg_temp.check('COVERAGE: and each is handled in a way the merge functions know, every repointed reference in a step',
                     'history, project link, repoint · every repoint in step 1 or 2', $sql$
  select coalesce(string_agg(distinct handling, ', ' order by handling), 'nothing listed')
           || ' · ' || case when count(*) filter (where handling = 'repoint' and coalesce(step, 0) not in (1, 2)) = 0
                            then 'every repoint in step 1 or 2' else 'a repoint without a step' end,
         count(*) > 0
           and count(*) filter (where handling not in ('repoint', 'project link', 'history')) = 0
           and count(*) filter (where handling = 'repoint' and coalesce(step, 0) not in (1, 2)) = 0
  from public.crm_merge_references()
$sql$);

-- ── Client numbers, as staff ─────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('NUMBER: staff add a company that is a client already, the way the project form does', $sql$
  insert into public.crm_companies (id, name, kind, stage)
  values ('18a00000-0000-4000-a000-000000000061', 'check-db 18 Client From The Start', 'client', 'client')
$sql$, 1);

select pg_temp.check('NUMBER: it is given a client number', 'a number', $sql$
  select coalesce(client_number::text, 'no number'), client_number is not null
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000061'
$sql$);

select pg_temp.check('NUMBER: a company the table owner stored as a client has one too', 'a number', $sql$
  select coalesce(client_number::text, 'no number'), client_number is not null
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000002'
$sql$);

select pg_temp.affects('NUMBER: staff add a lead', $sql$
  insert into public.crm_companies (id, name) values ('18a00000-0000-4000-a000-000000000062', 'check-db 18 Lead')
$sql$, 1);

select pg_temp.check('NUMBER: a lead has none', 'no number', $sql$
  select coalesce(client_number::text, 'no number'), client_number is null
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000062'
$sql$);

select pg_temp.affects('NUMBER: staff move the lead through the pipeline to client', $sql$
  update public.crm_companies set stage = 'client' where id = '18a00000-0000-4000-a000-000000000062'
$sql$, 1);

select pg_temp.run('NUMBER: read the number it was given', 'lead_number', $sql$
  select client_number::text from public.crm_companies where id = '18a00000-0000-4000-a000-000000000062'
$sql$);

select pg_temp.check('NUMBER: becoming a client gives it the next number', 'a number after the first client''s', $sql$
  select case when l.client_number is null then 'no number'
              when l.client_number > f.client_number then 'a number after the first client''s'
              else 'number ' || l.client_number || ', not after ' || f.client_number end,
         coalesce(l.client_number > f.client_number, false)
  from public.crm_companies l, public.crm_companies f
  where l.id = '18a00000-0000-4000-a000-000000000062' and f.id = '18a00000-0000-4000-a000-000000000061'
$sql$);

select pg_temp.affects('NUMBER: the client goes dormant', $sql$
  update public.crm_companies set stage = 'dormant' where id = '18a00000-0000-4000-a000-000000000062'
$sql$, 1);

select pg_temp.affects('NUMBER: and becomes a client again', $sql$
  update public.crm_companies set stage = 'client' where id = '18a00000-0000-4000-a000-000000000062'
$sql$, 1);

select pg_temp.check('NUMBER: it keeps the number it was given the first time', 'the same number', $sql$
  select case when client_number::text = current_setting('test.lead_number') then 'the same number'
              else coalesce(client_number::text, 'no number') || ', was ' || current_setting('test.lead_number') end,
         client_number::text = current_setting('test.lead_number')
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000062'
$sql$);

select pg_temp.refused_as('NUMBER: staff cannot give a new company a number of their choosing', $sql$
  insert into public.crm_companies (name, stage, client_number) values ('check-db 18 Chosen Number', 'client', 424242)
$sql$, '42501', 'client number');

select pg_temp.refused_as('NUMBER: nor change a client''s number', $sql$
  update public.crm_companies set client_number = client_number + 1000 where id = '18a00000-0000-4000-a000-000000000061'
$sql$, '42501', 'never changes');

select pg_temp.refused_as('NUMBER: nor take it away', $sql$
  update public.crm_companies set client_number = null where id = '18a00000-0000-4000-a000-000000000061'
$sql$, '42501', 'never changes');

select pg_temp.refused_as('NUMBER: nor give a lead one', $sql$
  update public.crm_companies set client_number = 424243 where id = '18a00000-0000-4000-a000-000000000004'
$sql$, '42501', 'never changes');

select pg_temp.affects('NUMBER: an edit that sends the number back unchanged still goes through', $sql$
  update public.crm_companies set client_number = client_number, notes = 'check-db 18 edited'
  where id = '18a00000-0000-4000-a000-000000000061'
$sql$, 1);

select pg_temp.refused_as('MERGED: staff cannot say a company was merged into another', $sql$
  update public.crm_companies set merged_into_id = '18a00000-0000-4000-a000-000000000001'
  where id = '18a00000-0000-4000-a000-000000000004'
$sql$, '42501', 'merge');

select pg_temp.refused_as('MERGED: nor a contact', $sql$
  update public.crm_contacts set merged_into_id = '18a00000-0000-4000-a000-000000000023'
  where id = '18a00000-0000-4000-a000-000000000026'
$sql$, '42501', 'merge');

-- ── Adding a contact and their company, as staff ─────────────────────────

select pg_temp.run('CREATE: staff add a contact at a company that is not in the CRM yet, in one call', 'made_new', $sql$
  select to_jsonb(r)::text
  from public.create_contact_with_company(
         p_full_name => ' check-db 18 New Person ', p_email => ' Check-DB-18-New@check-db-18.invalid ',
         p_phone => '+31 20 000 0018', p_title => 'Buyer', p_company_name => '  check-db 18 Brand New Co ') r
$sql$);

select pg_temp.check('CREATE: both are made, and the contact is at the company', 'contact at check-db 18 Brand New Co', $sql$
  select case when c.id is null then 'no contact'
              when co.id is null then 'no company'
              else 'contact at ' || co.name end,
         coalesce(c.company_id = co.id and co.name = 'check-db 18 Brand New Co', false)
  from (select nullif(current_setting('test.made_new'), '')::jsonb as made) m
  left join public.crm_contacts c on c.id = (m.made ->> 'contact_id')::uuid
  left join public.crm_companies co on co.id = (m.made ->> 'company_id')::uuid
$sql$);

select pg_temp.check('CREATE: stored the way the workspace stores a contact', 'check-db 18 New Person · check-db-18-new@check-db-18.invalid · +31 20 000 0018 · Buyer', $sql$
  select concat_ws(' · ', c.full_name, c.email, c.phone, c.title),
         c.full_name = 'check-db 18 New Person' and c.email = 'check-db-18-new@check-db-18.invalid'
           and c.phone = '+31 20 000 0018' and c.title = 'Buyer'
  from public.crm_contacts c
  where c.id = (nullif(current_setting('test.made_new'), '')::jsonb ->> 'contact_id')::uuid
$sql$);

select pg_temp.check('CREATE: the new company is a lead, owned by whoever added it, as createCompany makes one',
                     'lead · the assistant', $sql$
  select co.stage || ' · ' || case when co.owner_id::text = current_setting('test.assistant_employee') then 'the assistant'
                                   else coalesce(co.owner_id::text, 'nobody') end,
         co.stage = 'lead' and co.owner_id::text = current_setting('test.assistant_employee')
  from public.crm_companies co
  where co.id = (nullif(current_setting('test.made_new'), '')::jsonb ->> 'company_id')::uuid
$sql$);

select pg_temp.run('CREATE: a contact at a company named as one in the CRM is, whatever the case and spaces', 'made_named', $sql$
  select to_jsonb(r)::text
  from public.create_contact_with_company(p_full_name => 'check-db 18 Named Person',
                                          p_company_name => ' CHECK-DB 18 existing NAME') r
$sql$);

select pg_temp.check('CREATE: goes to that company, and makes none', 'check-db 18 Existing Name · 1 company by that name', $sql$
  select coalesce(co.name, 'no company') || ' · ' || n.n || ' company by that name',
         coalesce(co.id = '18a00000-0000-4000-a000-000000000004' and n.n = 1, false)
  from (select nullif(current_setting('test.made_named'), '')::jsonb as made) m
  left join public.crm_companies co on co.id = (m.made ->> 'company_id')::uuid
  cross join (select count(*) as n from public.crm_companies
              where lower(btrim(name)) = 'check-db 18 existing name') n
$sql$);

select pg_temp.run('CREATE: a contact at a name only a deleted company had', 'made_gone', $sql$
  select to_jsonb(r)::text
  from public.create_contact_with_company(p_full_name => 'check-db 18 Returning Person',
                                          p_company_name => 'check-db 18 Gone Name') r
$sql$);

select pg_temp.check('CREATE: gets a new company, not the deleted one', 'a new company', $sql$
  select case when co.id is null then 'no company'
              when co.id = '18a00000-0000-4000-a000-000000000007' then 'the deleted company'
              when co.deleted_at is null then 'a new company'
              else 'another deleted company' end,
         coalesce(co.id <> '18a00000-0000-4000-a000-000000000007' and co.deleted_at is null, false)
  from (select nullif(current_setting('test.made_gone'), '')::jsonb as made) m
  left join public.crm_companies co on co.id = (m.made ->> 'company_id')::uuid
$sql$);

select pg_temp.run('CREATE: a contact at a company picked by its id', 'made_by_id', $sql$
  select to_jsonb(r)::text
  from public.create_contact_with_company(p_full_name => 'check-db 18 Picked Person',
                                          p_company_id => '18a00000-0000-4000-a000-000000000001') r
$sql$);

select pg_temp.check('CREATE: is at that company', 'check-db 18 Keep Co', $sql$
  select coalesce(co.name, 'no company'),
         coalesce(c.company_id = '18a00000-0000-4000-a000-000000000001'
                  and (m.made ->> 'company_id')::uuid = '18a00000-0000-4000-a000-000000000001', false)
  from (select nullif(current_setting('test.made_new'), '') is not null as ok,
               nullif(current_setting('test.made_by_id'), '')::jsonb as made) m
  left join public.crm_contacts c on c.id = (m.made ->> 'contact_id')::uuid
  left join public.crm_companies co on co.id = c.company_id
$sql$);

select pg_temp.run('CREATE: a contact at no company, and at the address of a deleted contact', 'made_alone', $sql$
  select to_jsonb(r)::text
  from public.create_contact_with_company(p_full_name => 'check-db 18 Alone',
                                          p_email => 'check-db-18-gone@check-db-18.invalid') r
$sql$);

select pg_temp.check('CREATE: is at no company', 'no company · a contact', $sql$
  select case when (m.made ->> 'company_id') is null then 'no company' else 'a company' end
           || ' · ' || case when c.id is null then 'no contact' else 'a contact' end,
         coalesce((m.made ->> 'company_id') is null and c.id is not null and c.company_id is null, false)
  from (select nullif(current_setting('test.made_alone'), '')::jsonb as made) m
  left join public.crm_contacts c on c.id = (m.made ->> 'contact_id')::uuid
$sql$);

select pg_temp.refused_as('CREATE: not at a deleted company', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Nowhere',
                                            p_company_id => '18a00000-0000-4000-a000-000000000003')
$sql$, '23503', 'not in the CRM');

select pg_temp.check('CREATE: and the refusal names the company', 'company_id 18a…03', $sql$
  select case when current_setting('test.detail') = '' then 'no detail' else current_setting('test.detail') end,
         coalesce(nullif(current_setting('test.detail'), '')::jsonb ->> 'company_id'
                  = '18a00000-0000-4000-a000-000000000003', false)
$sql$);

select pg_temp.refused_as('CREATE: nor at a company that is not there', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Nowhere',
                                            p_company_id => '18a00000-0000-4000-a000-0000000000ee')
$sql$, '23503', 'not in the CRM');

select pg_temp.refused_as('CREATE: a company by its id or by a new name, not both', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Both',
                                            p_company_id => '18a00000-0000-4000-a000-000000000001',
                                            p_company_name => 'check-db 18 Keep Co')
$sql$, '22023', 'not both');

select pg_temp.refused_as('CREATE: a contact needs a name', $sql$
  select public.create_contact_with_company(p_full_name => '   ', p_company_name => 'check-db 18 Nameless Co')
$sql$, '22023', 'needs a name');

select pg_temp.refused_as('CREATE: and an address that is one', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Bad Address', p_email => 'not an address')
$sql$, '22023', 'not an address');

select pg_temp.refused_as('CREATE: a name two companies have is a question for the person, not a guess', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Ambiguous', p_company_name => 'check-db 18 TWICE')
$sql$, '21000', 'more than one company');

select pg_temp.check('CREATE: and the refusal lists both companies', 'both ids', $sql$
  select case when current_setting('test.detail') = '' then 'no detail' else current_setting('test.detail') end,
         coalesce((nullif(current_setting('test.detail'), '')::jsonb -> 'company_ids')
                  @> '["18a00000-0000-4000-a000-000000000005", "18a00000-0000-4000-a000-000000000006"]'::jsonb, false)
$sql$);

select pg_temp.refused_as('DUPLICATE: a second live contact on an address, whatever its case, is refused', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Again', p_email => ' CHECK-DB-18-DROP@check-db-18.invalid',
                                            p_company_name => 'check-db 18 Spare Co')
$sql$, '23505', 'already in the CRM');

select pg_temp.check('DUPLICATE: the refusal carries the existing contact''s id, as JSON', '{"contact_id": "18a…21"}', $sql$
  select case when current_setting('test.detail') = '' then 'no detail' else current_setting('test.detail') end,
         coalesce(nullif(current_setting('test.detail'), '')::jsonb ->> 'contact_id'
                  = '18a00000-0000-4000-a000-000000000021', false)
$sql$);

insert into results(name, expected, actual, pass)
select 'DUPLICATE: and leaves no company behind', '0 companies', count(*) || ' companies', count(*) = 0
from public.crm_companies where name = 'check-db 18 Spare Co';

select pg_temp.refused_as('ONE STEP: a contact that cannot be saved for any other reason', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Orphan', p_company_name => 'check-db 18 Orphan Co',
                                            p_enquiry_id => '18a00000-0000-4000-a000-0000000000ef')
$sql$, '23503', 'crm_contacts_enquiry_id_fkey');

insert into results(name, expected, actual, pass)
select 'ONE STEP: leaves no company behind either', '0 companies', count(*) || ' companies', count(*) = 0
from public.crm_companies where name = 'check-db 18 Orphan Co';

-- ── Staff do not merge ───────────────────────────────────────────────────

select pg_temp.refused_as('STAFF: an employee cannot merge companies', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000002')
$sql$, '42501', 'owner or admin');

select pg_temp.refused_as('STAFF: nor contacts', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$, '42501', 'owner or admin');

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"18a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused_as('NOT ON THE TEAM: cannot add a contact', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Intruder', p_company_name => 'check-db 18 Intruder Co')
$sql$, '42501', 'only staff');

select pg_temp.refused_as('NOT ON THE TEAM: nor merge', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000002')
$sql$, '42501', 'owner or admin');

reset role;

-- ── The service role and anon ────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select pg_temp.refused_as('SERVICE ROLE: nobody''s staff, so adds no contact', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Job', p_company_name => 'check-db 18 Job Co')
$sql$, '42501', 'only staff');

select pg_temp.refused_as('SERVICE ROLE: merges nothing', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$, '42501', 'owner or admin');

select pg_temp.refused_as('SERVICE ROLE: and gives no client number either', $sql$
  update public.crm_companies set client_number = 424244 where id = '18a00000-0000-4000-a000-000000000004'
$sql$, '42501', 'never changes');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select pg_temp.refused('ANON: cannot call create_contact_with_company', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Anon')
$sql$, 'permission denied');

select pg_temp.refused('ANON: nor merge_companies', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000002')
$sql$, 'permission denied');

select pg_temp.refused('ANON: nor merge_contacts', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$, 'permission denied');

reset role;

-- ── The OWNER, at aal1 with a verified factor ────────────────────────────
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('18a00000-0000-4000-a000-0000000000f1', 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093',
        'check-db 18', 'totp', 'verified', now(), now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal1"}', true);

select pg_temp.refused_as('AAL1: the OWNER, before their code, adds no contact', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Early', p_company_name => 'check-db 18 Early Co')
$sql$, '42501', 'only staff');

select pg_temp.refused_as('AAL1: merges no companies', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000002')
$sql$, '42501', 'owner or admin');

select pg_temp.refused_as('AAL1: and no contacts', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$, '42501', 'owner or admin');

-- ── The OWNER, a manager, at aal2 ────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused_as('NUMBER: nor does an owner change a client''s number by hand', $sql$
  update public.crm_companies set client_number = client_number + 1000 where id = '18a00000-0000-4000-a000-000000000061'
$sql$, '42501', 'never changes');

select pg_temp.refused_as('MERGE: not a company into itself', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000001')
$sql$, '22023', 'into itself');

select pg_temp.refused_as('MERGE: not without both companies', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', null)
$sql$, '22023', 'company to keep and');

select pg_temp.refused_as('MERGE: not a company that is not there', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-0000000000ee')
$sql$, '23503', 'not in the CRM');

select pg_temp.refused_as('MERGE: not into a deleted company', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000003', '18a00000-0000-4000-a000-000000000001')
$sql$, '23503', 'deleted');

select pg_temp.refused_as('MERGE: nor a deleted company into another', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000003')
$sql$, '23503', 'deleted');

select pg_temp.refused_as('MERGE: not a contact into itself', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000023')
$sql$, '22023', 'into itself');

select pg_temp.refused_as('MERGE: nor a deleted contact', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000028')
$sql$, '23503', 'deleted');

select pg_temp.refused_as('MERGE: nor someone on a project of a company the kept contact does not work at', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000026', '18a00000-0000-4000-a000-000000000027')
$sql$, '23514', 'check-db 18 Project One');

select pg_temp.check('MERGE: which leaves both contacts, and the project link, as they were', 'both live · still on the project', $sql$
  select case when count(*) filter (where c.deleted_at is null) = 2 then 'both live' else 'not both live' end
           || ' · ' || case when exists (select 1 from public.project_contacts pc
                                         where pc.project_id = '18a00000-0000-4000-a000-000000000041'
                                           and pc.contact_id = '18a00000-0000-4000-a000-000000000027')
                            then 'still on the project' else 'off the project' end,
         count(*) filter (where c.deleted_at is null) = 2
           and exists (select 1 from public.project_contacts pc
                       where pc.project_id = '18a00000-0000-4000-a000-000000000041'
                         and pc.contact_id = '18a00000-0000-4000-a000-000000000027')
  from public.crm_contacts c
  where c.id in ('18a00000-0000-4000-a000-000000000026', '18a00000-0000-4000-a000-000000000027')
$sql$);

-- ── A company whose invoice another company's project holds ────────────

-- 0051 lets an invoice change company when it already named another company
-- than its project's: this one is Invoice Drop Co's, under a project that has
-- since moved to Invoice Third Co. The merge moves it to Invoice Keep Co, under
-- the same project. (REFUSED, in the last section, is a merge a trigger stops.)
select pg_temp.run('INVOICES: the OWNER merges Invoice Drop Co, whose invoice is under a project since moved to another company', 'merged_invoices', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-00000000000c', '18a00000-0000-4000-a000-00000000000d')::text
$sql$);

select pg_temp.check('INVOICES: Invoice Drop Co is merged, and its invoice names Invoice Keep Co, still under the project that moved',
                     'Invoice Drop Co merged · invoice at check-db 18 Invoice Keep Co · project at check-db 18 Invoice Third Co', $sql$
  select case when d.deleted_at is not null and d.merged_into_id = '18a00000-0000-4000-a000-00000000000c'
              then 'Invoice Drop Co merged' else 'Invoice Drop Co live' end
           || ' · invoice at ' || coalesce(ic.name, 'no company')
           || ' · project at ' || coalesce(pc.name, 'no company'),
         d.deleted_at is not null and d.merged_into_id = '18a00000-0000-4000-a000-00000000000c'
           and i.company_id = '18a00000-0000-4000-a000-00000000000c'
           and i.project_id = '18a00000-0000-4000-a000-000000000044'
           and p.company_id = '18a00000-0000-4000-a000-00000000000e'
  from public.crm_companies d
  join public.finance_invoices i on i.id = '18a00000-0000-4000-a000-00000000005b'
  join public.client_projects p on p.id = '18a00000-0000-4000-a000-000000000044'
  left join public.crm_companies ic on ic.id = i.company_id
  left join public.crm_companies pc on pc.id = p.company_id
  where d.id = '18a00000-0000-4000-a000-00000000000d'
$sql$);

select pg_temp.check('INVOICES: and the merge answers that it moved one invoice', 'invoices 1', $sql$
  select 'invoices ' || coalesce(r -> 'moved' ->> 'finance_invoices.company_id', '?'),
         coalesce(r -> 'moved' ->> 'finance_invoices.company_id' = '1', false)
  from (select nullif(current_setting('test.merged_invoices'), '')::jsonb as r) x
$sql$);

-- ── Merging two companies ────────────────────────────────────────────────

select pg_temp.run('COMPANIES: note Drop Co''s client number before the merge', 'drop_number', $sql$
  select client_number::text from public.crm_companies where id = '18a00000-0000-4000-a000-000000000002'
$sql$);

select pg_temp.run('COMPANIES: the OWNER merges Drop Co into Keep Co', 'merged_companies', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000001', '18a00000-0000-4000-a000-000000000002')::text
$sql$);

select pg_temp.check('COMPANIES: Drop Co is deleted, and records that it went into Keep Co', 'deleted · into Keep Co', $sql$
  select case when deleted_at is null then 'live' else 'deleted' end || ' · '
           || case when merged_into_id = '18a00000-0000-4000-a000-000000000001' then 'into Keep Co'
                   else coalesce(merged_into_id::text, 'nowhere') end,
         deleted_at is not null and merged_into_id = '18a00000-0000-4000-a000-000000000001'
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000002'
$sql$);

select pg_temp.check('COMPANIES: Keep Co keeps its name and stage, and takes the domain, value, owner and notes it lacked',
                     'check-db 18 Keep Co · lead · check-db-18-drop.invalid · 5000.00 EUR · the OWNER · check-db 18 drop notes', $sql$
  select concat_ws(' · ', name, stage, domain, value || ' ' || currency,
                   case when owner_id::text = current_setting('test.owner_employee') then 'the OWNER'
                        else coalesce(owner_id::text, 'no owner') end,
                   notes),
         name = 'check-db 18 Keep Co' and stage = 'lead' and domain = 'check-db-18-drop.invalid'
           and value = 5000 and currency = 'EUR'
           and owner_id::text = current_setting('test.owner_employee') and notes = 'check-db 18 drop notes'
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000001'
$sql$);

select pg_temp.check('COMPANIES: Keep Co, which had no client number, takes Drop Co''s, and Drop Co gives it up',
                     'Keep Co has Drop Co''s number · Drop Co none', $sql$
  select case when k.client_number::text = current_setting('test.drop_number') then 'Keep Co has Drop Co''s number'
              else 'Keep Co has ' || coalesce(k.client_number::text, 'none') end
           || ' · Drop Co ' || coalesce(d.client_number::text, 'none'),
         k.client_number::text = current_setting('test.drop_number') and d.client_number is null
  from public.crm_companies k, public.crm_companies d
  where k.id = '18a00000-0000-4000-a000-000000000001' and d.id = '18a00000-0000-4000-a000-000000000002'
$sql$);

select pg_temp.check('COMPANIES: what pointed at Drop Co points at Keep Co',
                     'projects 1 · tickets 1 · threads 1 · events 1 · contacts 2 · invoices 1 · notes 1', $sql$
  select 'projects ' || (select count(*) from public.client_projects where company_id = k.id and id = '18a00000-0000-4000-a000-000000000043')
           || ' · tickets ' || (select count(*) from public.support_tickets where company_id = k.id and id = '18a00000-0000-4000-a000-000000000051')
           || ' · threads ' || (select count(*) from public.mail_threads where company_id = k.id and id = '18a00000-0000-4000-a000-000000000054')
           || ' · events ' || (select count(*) from public.calendar_events where company_id = k.id and id = '18a00000-0000-4000-a000-000000000056')
           || ' · contacts ' || (select count(*) from public.crm_contacts where company_id = k.id
                                  and id in ('18a00000-0000-4000-a000-000000000021', '18a00000-0000-4000-a000-000000000025'))
           || ' · invoices ' || (select count(*) from public.finance_invoices where company_id = k.id and id = '18a00000-0000-4000-a000-00000000005a')
           || ' · notes ' || (select count(*) from public.workspace_notes where entity_type = 'company' and entity_id = k.id
                               and id = '18a00000-0000-4000-a000-000000000058'),
         (select count(*) from public.client_projects where company_id = k.id and id = '18a00000-0000-4000-a000-000000000043') = 1
           and (select count(*) from public.support_tickets where company_id = k.id and id = '18a00000-0000-4000-a000-000000000051') = 1
           and (select count(*) from public.mail_threads where company_id = k.id and id = '18a00000-0000-4000-a000-000000000054') = 1
           and (select count(*) from public.calendar_events where company_id = k.id and id = '18a00000-0000-4000-a000-000000000056') = 1
           and (select count(*) from public.crm_contacts where company_id = k.id
                 and id in ('18a00000-0000-4000-a000-000000000021', '18a00000-0000-4000-a000-000000000025')) = 2
           and (select count(*) from public.finance_invoices where company_id = k.id and id = '18a00000-0000-4000-a000-00000000005a') = 1
           and (select count(*) from public.workspace_notes where entity_type = 'company' and entity_id = k.id
                 and id = '18a00000-0000-4000-a000-000000000058') = 1
  from (select '18a00000-0000-4000-a000-000000000001'::uuid as id) k
$sql$);

select pg_temp.check('COMPANIES: nothing points at Drop Co any more', 'nothing', $sql$
  select case when n = 0 then 'nothing' else n || ' references' end, n = 0
  from (select (select count(*) from public.client_projects where company_id = d.id)
             + (select count(*) from public.support_tickets where company_id = d.id)
             + (select count(*) from public.mail_threads where company_id = d.id)
             + (select count(*) from public.calendar_events where company_id = d.id)
             + (select count(*) from public.crm_contacts where company_id = d.id)
             + (select count(*) from public.finance_invoices where company_id = d.id)
             + (select count(*) from public.workspace_notes where entity_type = 'company' and entity_id = d.id) as n
        from (select '18a00000-0000-4000-a000-000000000002'::uuid as id) d) x
$sql$);

select pg_temp.check('COMPANIES: Drop Co''s project keeps its people, the deleted one included', '2 links', $sql$
  select count(*) || ' links', count(*) = 2
  from public.project_contacts
  where project_id = '18a00000-0000-4000-a000-000000000043'
    and contact_id in ('18a00000-0000-4000-a000-000000000021', '18a00000-0000-4000-a000-000000000025')
$sql$);

select pg_temp.check('COMPANIES: the merge answers what it moved', 'projects 1 · contacts 2 · domain filled', $sql$
  select 'projects ' || coalesce(r -> 'moved' ->> 'client_projects.company_id', '?')
           || ' · contacts ' || coalesce(r -> 'moved' ->> 'crm_contacts.company_id', '?')
           || ' · ' || case when r -> 'filled' ? 'domain' then 'domain filled' else 'domain not filled' end,
         coalesce((r -> 'moved' ->> 'client_projects.company_id') = '1'
                  and (r -> 'moved' ->> 'crm_contacts.company_id') = '2'
                  and r -> 'filled' ? 'domain', false)
  from (select nullif(current_setting('test.merged_companies'), '')::jsonb as r) x
$sql$);

select pg_temp.check('PRIVATE: the OWNER cannot open the assistant''s own conversation or meeting', 'threads 0 · meetings 0', $sql$
  select 'threads ' || (select count(*) from public.mail_threads where id = '18a00000-0000-4000-a000-00000000005d')
           || ' · meetings ' || (select count(*) from public.calendar_events where id = '18a00000-0000-4000-a000-00000000005e'),
         (select count(*) from public.mail_threads where id = '18a00000-0000-4000-a000-00000000005d') = 0
           and (select count(*) from public.calendar_events where id = '18a00000-0000-4000-a000-00000000005e') = 0
$sql$);

select pg_temp.check('PRIVATE: so the merge counts only the conversation and the meeting with Drop Co that the OWNER can open',
                     'threads 1 · meetings 1', $sql$
  select 'threads ' || coalesce(r -> 'moved' ->> 'mail_threads.company_id', '?')
           || ' · meetings ' || coalesce(r -> 'moved' ->> 'calendar_events.company_id', '?'),
         coalesce(r -> 'moved' ->> 'mail_threads.company_id' = '1'
                  and r -> 'moved' ->> 'calendar_events.company_id' = '1', false)
  from (select nullif(current_setting('test.merged_companies'), '')::jsonb as r) x
$sql$);

select pg_temp.check('COMPANIES: and the feed says who merged what', 'the OWNER · Merged check-db 18 Drop Co into check-db 18 Keep Co', $sql$
  select case when a.actor_id::text = current_setting('test.owner_employee') then 'the OWNER'
              else coalesce(a.actor_id::text, 'nobody') end || ' · ' || a.summary,
         a.actor_id::text = current_setting('test.owner_employee')
           and a.summary = 'Merged check-db 18 Drop Co into check-db 18 Keep Co'
  from public.workspace_activity a
  where a.entity_type = 'company' and a.entity_id = '18a00000-0000-4000-a000-000000000001'
  order by a.created_at desc
  limit 1
$sql$);

select pg_temp.refused_as('COMPANIES: a merged company is not merged again', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000004', '18a00000-0000-4000-a000-000000000002')
$sql$, '23503', 'already merged');

select pg_temp.refused_as('COMPANIES: nor kept', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000004')
$sql$, '23503', 'already merged');

select pg_temp.refused_as('LOOP: merging Keep Co into the company merged into it would go round in a circle', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000002', '18a00000-0000-4000-a000-000000000001')
$sql$, '23503', 'circle');

select pg_temp.run('COMPANIES: the OWNER merges one client into another', 'merged_numbered', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000008', '18a00000-0000-4000-a000-000000000009')::text
$sql$);

select pg_temp.check('NUMBER: two clients merged keep their own numbers', 'two numbers, as they were', $sql$
  select case when k.client_number is not null and d.client_number is not null and k.client_number <> d.client_number
              then 'two numbers, as they were'
              else 'kept ' || coalesce(k.client_number::text, 'none') || ', merged ' || coalesce(d.client_number::text, 'none') end,
         k.client_number is not null and d.client_number is not null and k.client_number <> d.client_number
  from public.crm_companies k, public.crm_companies d
  where k.id = '18a00000-0000-4000-a000-000000000008' and d.id = '18a00000-0000-4000-a000-000000000009'
$sql$);

-- ── Merging two contacts ─────────────────────────────────────────────────

select pg_temp.run('CONTACTS: the OWNER merges Drop Contact into Keep Contact', 'merged_contacts', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')::text
$sql$);

select pg_temp.check('CONTACTS: Drop Contact is deleted, and records that it went into Keep Contact', 'deleted · into Keep Contact', $sql$
  select case when deleted_at is null then 'live' else 'deleted' end || ' · '
           || case when merged_into_id = '18a00000-0000-4000-a000-000000000023' then 'into Keep Contact'
                   else coalesce(merged_into_id::text, 'nowhere') end,
         deleted_at is not null and merged_into_id = '18a00000-0000-4000-a000-000000000023'
  from public.crm_contacts where id = '18a00000-0000-4000-a000-000000000024'
$sql$);

select pg_temp.check('CONTACTS: Keep Contact keeps its name and title, and takes the address, phone, notes and primary flag',
                     'check-db 18 Keep Contact · Keeper · check-db-18-dup@check-db-18.invalid · +31 6 0000 0018 · check-db 18 drop contact notes · primary', $sql$
  select concat_ws(' · ', full_name, title, email, phone, notes, case when is_primary then 'primary' else 'not primary' end),
         full_name = 'check-db 18 Keep Contact' and title = 'Keeper' and email = 'check-db-18-dup@check-db-18.invalid'
           and phone = '+31 6 0000 0018' and notes = 'check-db 18 drop contact notes' and is_primary
  from public.crm_contacts where id = '18a00000-0000-4000-a000-000000000023'
$sql$);

insert into results(name, expected, actual, pass)
select 'UNIQUE: the address is on one live contact, the kept one', '1 contact · Keep Contact',
       count(*) || ' contact · ' || coalesce(string_agg(case when id = '18a00000-0000-4000-a000-000000000023'
                                                             then 'Keep Contact' else id::text end, ', '), 'nobody'),
       count(*) = 1 and bool_and(id = '18a00000-0000-4000-a000-000000000023')
from public.crm_contacts
where lower(email) = 'check-db-18-dup@check-db-18.invalid' and deleted_at is null;

select pg_temp.check('UNIQUE: on a project both were on, the kept contact stays, in its own role', 'Keep Contact as billing, alone', $sql$
  select coalesce(string_agg(case when contact_id = '18a00000-0000-4000-a000-000000000023' then 'Keep Contact'
                                  else 'Drop Contact' end || ' as ' || role, ', '), 'nobody') || ', alone',
         count(*) = 1 and bool_and(contact_id = '18a00000-0000-4000-a000-000000000023' and role = 'billing')
  from public.project_contacts
  where project_id = '18a00000-0000-4000-a000-000000000041'
    and contact_id in ('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$);

select pg_temp.check('CONTACTS: on a project only the merged contact was on, the kept one takes its place and role',
                     'Keep Contact as decision_maker', $sql$
  select coalesce(string_agg(case when contact_id = '18a00000-0000-4000-a000-000000000023' then 'Keep Contact'
                                  else 'Drop Contact' end || ' as ' || role, ', '), 'nobody'),
         count(*) = 1 and bool_and(contact_id = '18a00000-0000-4000-a000-000000000023' and role = 'decision_maker')
  from public.project_contacts
  where project_id = '18a00000-0000-4000-a000-000000000042'
    and contact_id in ('18a00000-0000-4000-a000-000000000023', '18a00000-0000-4000-a000-000000000024')
$sql$);

select pg_temp.check('CONTACTS: what pointed at Drop Contact points at Keep Contact',
                     'tickets 1 · messages 1 · threads 1 · events 1 · notes 1 · left behind 0', $sql$
  select 'tickets ' || (select count(*) from public.support_tickets where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000052')
           || ' · messages ' || (select count(*) from public.ticket_messages where author_contact_id = k.id and id = '18a00000-0000-4000-a000-000000000053')
           || ' · threads ' || (select count(*) from public.mail_threads where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000055')
           || ' · events ' || (select count(*) from public.calendar_events where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000057')
           || ' · notes ' || (select count(*) from public.workspace_notes where entity_type = 'contact' and entity_id = k.id
                               and id = '18a00000-0000-4000-a000-000000000059')
           || ' · left behind ' || ((select count(*) from public.support_tickets where contact_id = d.id)
                                    + (select count(*) from public.ticket_messages where author_contact_id = d.id)
                                    + (select count(*) from public.mail_threads where contact_id = d.id)
                                    + (select count(*) from public.calendar_events where contact_id = d.id)
                                    + (select count(*) from public.project_contacts where contact_id = d.id)
                                    + (select count(*) from public.workspace_notes where entity_type = 'contact' and entity_id = d.id)),
         (select count(*) from public.support_tickets where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000052') = 1
           and (select count(*) from public.ticket_messages where author_contact_id = k.id and id = '18a00000-0000-4000-a000-000000000053') = 1
           and (select count(*) from public.mail_threads where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000055') = 1
           and (select count(*) from public.calendar_events where contact_id = k.id and id = '18a00000-0000-4000-a000-000000000057') = 1
           and (select count(*) from public.workspace_notes where entity_type = 'contact' and entity_id = k.id
                 and id = '18a00000-0000-4000-a000-000000000059') = 1
           and (select count(*) from public.support_tickets where contact_id = d.id)
               + (select count(*) from public.ticket_messages where author_contact_id = d.id)
               + (select count(*) from public.mail_threads where contact_id = d.id)
               + (select count(*) from public.calendar_events where contact_id = d.id)
               + (select count(*) from public.project_contacts where contact_id = d.id)
               + (select count(*) from public.workspace_notes where entity_type = 'contact' and entity_id = d.id) = 0
  from (select '18a00000-0000-4000-a000-000000000023'::uuid as id) k,
       (select '18a00000-0000-4000-a000-000000000024'::uuid as id) d
$sql$);

select pg_temp.check('CONTACTS: the merge answers what it did with the project links', 'moved 1 · dropped 1', $sql$
  select 'moved ' || coalesce(r ->> 'project_links_moved', '?') || ' · dropped ' || coalesce(r ->> 'project_links_dropped', '?'),
         coalesce(r ->> 'project_links_moved' = '1' and r ->> 'project_links_dropped' = '1', false)
  from (select nullif(current_setting('test.merged_contacts'), '')::jsonb as r) x
$sql$);

select pg_temp.check('PRIVATE: and the contact merge counts only the conversation and the meeting with Drop Contact that the OWNER can open',
                     'threads 1 · meetings 1', $sql$
  select 'threads ' || coalesce(r -> 'moved' ->> 'mail_threads.contact_id', '?')
           || ' · meetings ' || coalesce(r -> 'moved' ->> 'calendar_events.contact_id', '?'),
         coalesce(r -> 'moved' ->> 'mail_threads.contact_id' = '1'
                  and r -> 'moved' ->> 'calendar_events.contact_id' = '1', false)
  from (select nullif(current_setting('test.merged_contacts'), '')::jsonb as r) x
$sql$);

select pg_temp.refused_as('CONTACTS: a merged contact is not merged again', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000026', '18a00000-0000-4000-a000-000000000024')
$sql$, '23503', 'already merged');

select pg_temp.refused_as('LOOP: nor is Keep Contact merged into the contact merged into it', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000024', '18a00000-0000-4000-a000-000000000023')
$sql$, '23503', 'circle');

-- A company deleted outright takes nothing with it but the record of what
-- was merged into it: the foreign key clears that, and the guard lets it.
-- Invoice Keep Co holds no client number, so every number this run drew is
-- still held when SEQUENCE counts them.
select pg_temp.affects('HARD DELETE: an owner deletes a company another was merged into, outright', $sql$
  delete from public.crm_companies where id = '18a00000-0000-4000-a000-00000000000c'
$sql$, 1);

select pg_temp.check('HARD DELETE: the merged company no longer says where it went', 'nowhere', $sql$
  select coalesce(merged_into_id::text, 'nowhere'), merged_into_id is null
  from public.crm_companies where id = '18a00000-0000-4000-a000-00000000000d'
$sql$);

reset role;

-- As the table owner, who reads every mailbox.
select pg_temp.check('PRIVATE: the assistant''s own conversation and meeting moved with both merges all the same',
                     'thread at Keep Co, Keep Contact · meeting at Keep Co, Keep Contact', $sql$
  select 'thread at ' || case when t.company_id = k.company then 'Keep Co' else coalesce(t.company_id::text, 'no company') end
           || ', ' || case when t.contact_id = k.contact then 'Keep Contact' else coalesce(t.contact_id::text, 'no contact') end
           || ' · meeting at ' || case when e.company_id = k.company then 'Keep Co' else coalesce(e.company_id::text, 'no company') end
           || ', ' || case when e.contact_id = k.contact then 'Keep Contact' else coalesce(e.contact_id::text, 'no contact') end,
         t.company_id = k.company and t.contact_id = k.contact and e.company_id = k.company and e.contact_id = k.contact
  from public.mail_threads t, public.calendar_events e,
       (select '18a00000-0000-4000-a000-000000000001'::uuid as company,
               '18a00000-0000-4000-a000-000000000023'::uuid as contact) k
  where t.id = '18a00000-0000-4000-a000-00000000005d' and e.id = '18a00000-0000-4000-a000-00000000005e'
$sql$);

-- ── An inactive admin ────────────────────────────────────────────────────
update public.employees set role = 'admin', status = 'inactive'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused_as('INACTIVE: an admin who is inactive adds no contact', $sql$
  select public.create_contact_with_company(p_full_name => 'check-db 18 Former', p_company_name => 'check-db 18 Former Co')
$sql$, '42501', 'only staff');

select pg_temp.refused_as('INACTIVE: and merges nothing', $sql$
  select public.merge_contacts('18a00000-0000-4000-a000-000000000026', '18a00000-0000-4000-a000-000000000027')
$sql$, '42501', 'owner or admin');

reset role;

-- ── Companies stored before 0049, and a foreign key nobody handles ───────
-- Last, for the locks (see the header). The rule is put back as it was, NOT
-- VALID, the way 0049 leaves it while such companies are stored.
set local lock_timeout = '5s';
select set_config('test.currency_rule',
  (select regexp_replace(pg_get_constraintdef(oid), '\s+NOT VALID$', '')
   from pg_constraint
   where conrelid = 'public.crm_companies'::regclass and conname = 'crm_companies_currency_check'), true);

alter table public.crm_companies drop constraint crm_companies_currency_check;

insert into public.crm_companies (id, name, currency, value) values
  ('18a00000-0000-4000-a000-000000000031', 'check-db 18 Legacy Dollars', 'US$', 700),
  ('18a00000-0000-4000-a000-000000000032', 'check-db 18 Legacy Euros', 'Euro', 900),
  ('18a00000-0000-4000-a000-000000000033', 'check-db 18 Clean Francs', 'CHF', null);

do $$
begin
  execute format('alter table public.crm_companies add constraint crm_companies_currency_check %s not valid',
                 current_setting('test.currency_rule'));
end
$$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.run('LEGACY CODE: a company stored in "US$" is merged into one in CHF', 'merged_legacy', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000033', '18a00000-0000-4000-a000-000000000031')::text
$sql$);

select pg_temp.check('LEGACY CODE: it is deleted and merged, and now holds the kept company''s code', 'deleted · merged · CHF', $sql$
  select case when deleted_at is null then 'live' else 'deleted' end
           || ' · ' || case when merged_into_id = '18a00000-0000-4000-a000-000000000033' then 'merged' else 'not merged' end
           || ' · ' || currency,
         deleted_at is not null and merged_into_id = '18a00000-0000-4000-a000-000000000033' and currency = 'CHF'
  from public.crm_companies where id = '18a00000-0000-4000-a000-000000000031'
$sql$);

select pg_temp.check('LEGACY CODE: a value in a code nobody can read is not carried over, and the merge says so',
                     'kept value none · left behind 700 in US$', $sql$
  select 'kept value ' || coalesce(k.value::text, 'none') || ' · left behind '
           || coalesce((r -> 'left_behind' ->> 'value') || ' in ' || (r -> 'left_behind' ->> 'currency'), 'nothing'),
         k.value is null and (r -> 'left_behind' ->> 'currency') = 'US$' and (r -> 'left_behind' ->> 'value')::numeric = 700
  from public.crm_companies k,
       (select nullif(current_setting('test.merged_legacy'), '')::jsonb as r) x
  where k.id = '18a00000-0000-4000-a000-000000000033'
$sql$);

-- Said by merge_companies() itself: the currency rule's own error is 23514 too.
select pg_temp.refused_as('LEGACY CODE: nothing is merged into a company whose value is in a code nobody can read', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000032', '18a00000-0000-4000-a000-000000000033')
$sql$, '23514', 'a currency like EUR or USD first');

select pg_temp.check('LEGACY CODE: and the refusal names the company and its code', '{"company_id": "18a…32", "currency": "Euro"}', $sql$
  select case when current_setting('test.detail') = '' then 'no detail' else current_setting('test.detail') end,
         coalesce(nullif(current_setting('test.detail'), '')::jsonb ->> 'company_id' = '18a00000-0000-4000-a000-000000000032'
                  and nullif(current_setting('test.detail'), '')::jsonb ->> 'currency' = 'Euro', false)
$sql$);

reset role;

insert into results(name, expected, actual, pass)
select 'LEGACY CODE: the merges leave the currency rule as they found it', 'not valid · as before',
       case when k.convalidated then 'validated' else 'not valid' end || ' · '
         || case when regexp_replace(pg_get_constraintdef(k.oid), '\s+NOT VALID$', '') = current_setting('test.currency_rule')
                 then 'as before' else pg_get_constraintdef(k.oid) end,
       not k.convalidated
         and regexp_replace(pg_get_constraintdef(k.oid), '\s+NOT VALID$', '') = current_setting('test.currency_rule')
from pg_constraint k
where k.conrelid = 'public.crm_companies'::regclass and k.conname = 'crm_companies_currency_check';

-- ── A trigger that refuses to move a reference ──────────────────────────
-- 0051 lets a merge move any invoice now (INVOICES), so a trigger of the
-- suite's own refuses one for a moment, as a later rule might: the merge
-- stops, nothing moves, the earlier steps' moves included, and the refusal
-- says what could not move, under the trigger's own SQLSTATE.
create function public.check_db_18_refuse_invoice_move()
returns trigger
language plpgsql
as $$
begin
  raise exception 'check-db 18 refuses to move this invoice' using errcode = 'CD018';
end;
$$;

create trigger check_db_18_refuse_invoice_move
  before update of company_id on public.finance_invoices
  for each row execute function public.check_db_18_refuse_invoice_move();

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused_as('REFUSED: a trigger that will not move an invoice stops the merge, and the refusal says what could not move and why', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-00000000000a', '18a00000-0000-4000-a000-00000000000b')
$sql$, 'CD018', 'Could not point finance_invoices.company_id at the kept company: check-db 18 refuses to move this invoice');

select pg_temp.check('REFUSED: and names the reference, as JSON', '{"references": ["finance_invoices.company_id"]}', $sql$
  select case when current_setting('test.detail') = '' then 'no detail' else current_setting('test.detail') end,
         coalesce(nullif(current_setting('test.detail'), '')::jsonb = '{"references": ["finance_invoices.company_id"]}'::jsonb, false)
$sql$);

select pg_temp.check('REFUSED: and nothing moved, not even what the steps before the invoice had moved',
                     'Refused Drop Co live · its person, project and invoice still at Refused Drop Co', $sql$
  select case when d.deleted_at is null and d.merged_into_id is null then 'Refused Drop Co live' else 'Refused Drop Co merged' end
           || ' · ' || case when c.company_id = d.id and p.company_id = d.id and i.company_id = d.id
                            then 'its person, project and invoice still at Refused Drop Co'
                            else 'person at ' || coalesce(c.company_id::text, 'none')
                                 || ', project at ' || coalesce(p.company_id::text, 'none')
                                 || ', invoice at ' || coalesce(i.company_id::text, 'none') end,
         d.deleted_at is null and d.merged_into_id is null
           and c.company_id = d.id and p.company_id = d.id and i.company_id = d.id
  from public.crm_companies d
  join public.crm_contacts c on c.id = '18a00000-0000-4000-a000-000000000029'
  join public.client_projects p on p.id = '18a00000-0000-4000-a000-000000000045'
  join public.finance_invoices i on i.id = '18a00000-0000-4000-a000-00000000005c'
  where d.id = '18a00000-0000-4000-a000-00000000000b'
$sql$);

reset role;

drop trigger check_db_18_refuse_invoice_move on public.finance_invoices;
drop function public.check_db_18_refuse_invoice_move();

-- ── A table with two foreign keys to one CRM table ──────────────────────
-- A referral names its client and the company that referred it, both listed in
-- step 1, the way 0053 asks a new foreign key to be listed. Postgres applies
-- only one of two updates of a row in one statement, so a merge must move both
-- columns in one. crm_merge_references() is rewritten until the rollback:
-- 0053's list, and the two columns.
create table public.check_db_18_referrals (
  id                  uuid primary key,
  client_company_id   uuid references public.crm_companies(id),
  referrer_company_id uuid references public.crm_companies(id)
);

select pg_temp.affects('TWO COLUMNS: list both of a referral''s columns in one step', $sql$
  select pg_temp.list_references_with($more$
    ('crm_companies', 'check_db_18_referrals', 'client_company_id',   'repoint', 1),
    ('crm_companies', 'check_db_18_referrals', 'referrer_company_id', 'repoint', 1)$more$)
$sql$, 1);

select pg_temp.check('TWO COLUMNS: the coverage check counts both as handled', 'none left out', $sql$
  select case when u = 'none' then 'none left out' else 'left out: ' || u end, u = 'none'
  from (select pg_temp.unhandled_crm_references() as u) x
$sql$);

insert into public.crm_companies (id, name) values
  ('18a00000-0000-4000-a000-000000000014', 'check-db 18 Referral Keep Co'),
  ('18a00000-0000-4000-a000-000000000015', 'check-db 18 Referral Drop Co');

-- 71 names the company to merge in both columns; 72 names it as the referrer
-- of the company kept.
insert into public.check_db_18_referrals (id, client_company_id, referrer_company_id) values
  ('18a00000-0000-4000-a000-000000000071', '18a00000-0000-4000-a000-000000000015', '18a00000-0000-4000-a000-000000000015'),
  ('18a00000-0000-4000-a000-000000000072', '18a00000-0000-4000-a000-000000000014', '18a00000-0000-4000-a000-000000000015');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.run('TWO COLUMNS: the OWNER merges Referral Drop Co into Referral Keep Co', 'merged_referrals', $sql$
  select public.merge_companies('18a00000-0000-4000-a000-000000000014', '18a00000-0000-4000-a000-000000000015')::text
$sql$);

reset role;

select pg_temp.check('TWO COLUMNS: every column that named Referral Drop Co names Referral Keep Co',
                     '71 client Keep, referrer Keep · 72 client Keep, referrer Keep', $sql$
  select string_agg(right(id::text, 2)
                    || ' client ' || case client_company_id when '18a00000-0000-4000-a000-000000000014' then 'Keep'
                                                            when '18a00000-0000-4000-a000-000000000015' then 'Drop'
                                                            else coalesce(client_company_id::text, 'none') end
                    || ', referrer ' || case referrer_company_id when '18a00000-0000-4000-a000-000000000014' then 'Keep'
                                                                when '18a00000-0000-4000-a000-000000000015' then 'Drop'
                                                                else coalesce(referrer_company_id::text, 'none') end,
                    ' · ' order by id),
         count(*) = 2 and bool_and(client_company_id = '18a00000-0000-4000-a000-000000000014'
                                   and referrer_company_id = '18a00000-0000-4000-a000-000000000014')
  from public.check_db_18_referrals
$sql$);

select pg_temp.check('TWO COLUMNS: and the merge answers each column''s own count', 'client 1 · referrer 2', $sql$
  select 'client ' || coalesce(r -> 'moved' ->> 'check_db_18_referrals.client_company_id', '?')
           || ' · referrer ' || coalesce(r -> 'moved' ->> 'check_db_18_referrals.referrer_company_id', '?'),
         coalesce(r -> 'moved' ->> 'check_db_18_referrals.client_company_id' = '1'
                  and r -> 'moved' ->> 'check_db_18_referrals.referrer_company_id' = '2', false)
  from (select nullif(current_setting('test.merged_referrals'), '')::jsonb as r) x
$sql$);

drop table public.check_db_18_referrals;

-- A table of its own for a moment (a temporary table cannot hold a foreign key
-- to a permanent one), dropped straight after the check and rolled back.
create table public.check_db_18_unhandled (id uuid primary key, company_id uuid references public.crm_companies(id));

select pg_temp.check('COVERAGE: the check notices a foreign key to a CRM table that no merge handles',
                     'left out: check_db_18_unhandled.company_id', $sql$
  select case when u = 'none' then 'none left out' else 'left out: ' || u end,
         u ~ 'check_db_18_unhandled\.company_id'
  from (select pg_temp.unhandled_crm_references() as u) x
$sql$);

drop table public.check_db_18_unhandled;

-- ── The client numbers this run drew, handed back ───────────────────────
-- A sequence gives numbers out outside any transaction, so the rollback would
-- keep this run's, and each run would take numbers from the real clients of
-- the project it runs against. setval is outside it too. The sequence goes back
-- to where it stood only when every number given out since is held by this
-- run's companies; when a real client was numbered meanwhile it stays where it
-- is, and this run's numbers are skipped rather than given twice.
select pg_temp.run('SEQUENCE: count the client numbers given out while this ran, and who holds them', 'drawn', $sql$
  select count(*) filter (where c.id::text like '18a00000-0000-4000-a000-%')
         || ' ' || coalesce(max(c.client_number) filter (where c.id::text like '18a00000-0000-4000-a000-%'),
                            pg_temp.client_seq_start())
         || ' ' || count(*) filter (where c.id::text not like '18a00000-0000-4000-a000-%')
  from public.crm_companies c
  where c.client_number > pg_temp.client_seq_start()
$sql$);

select pg_temp.run('SEQUENCE: hand this run''s client numbers back, when nobody else was given one meanwhile', 'handed_back', $sql$
  select case when pg_temp.client_seq_now() - pg_temp.client_seq_start() = split_part(current_setting('test.drawn'), ' ', 1)::bigint
                   and pg_temp.client_seq_now() = split_part(current_setting('test.drawn'), ' ', 2)::bigint
                   and split_part(current_setting('test.drawn'), ' ', 3)::bigint = 0
              then setval('public.crm_companies_client_number_seq',
                          split_part(current_setting('test.client_seq'), ' ', 1)::bigint,
                          split_part(current_setting('test.client_seq'), ' ', 2)::boolean)::text
              else 'left where it is' end
$sql$);

select pg_temp.check('SEQUENCE: this run used up no client number',
                     'handed back, or skipped when a real client was numbered meanwhile', $sql$
  select case when pg_temp.client_seq_now() = pg_temp.client_seq_start() then 'handed back'
              when split_part(current_setting('test.drawn'), ' ', 3)::bigint > 0
                then 'skipped: a real client was numbered while this ran'
              else 'not handed back: ' || (pg_temp.client_seq_now() - pg_temp.client_seq_start()) || ' numbers used' end,
         pg_temp.client_seq_now() = pg_temp.client_seq_start()
           or split_part(current_setting('test.drawn'), ' ', 3)::bigint > 0
$sql$);

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
