-- 06-second-factor.sql — a password alone is not a way in (0040).
--
-- The inactive assistant, woken for this transaction only, is checked three
-- ways: with no authenticator, with an unverified one (an abandoned enrolment,
-- which owes nothing), and with a verified one. With a verified factor, a
-- session whose token says aal1 is nobody: no role, no rows, no writes, no
-- staff RPC — and not even through the policies that only ask who someone is (a
-- comment's author, the folder of a person's own mail attachments), which only
-- the restrictive policy can close. The same person at aal2 is staff again.
-- The factor is stored the way Supabase Auth stores one; everything is rolled
-- back.
--
-- The other suites run their sessions at aal2: a member of staff who entered
-- their code, whether or not their account has one.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
-- The service role writes its own check below.
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

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- An authenticator the assistant enrolled for real is set aside for this
-- transaction, so every check starts from "no factor".
update auth.mfa_factors set status = 'unverified'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c' and status = 'verified';

-- Fixtures. All rolled back.
insert into public.crm_companies (id, name)
values ('c6000000-0000-4000-a000-000000000001', 'Factor Co');
insert into public.crm_contacts (id, company_id, full_name)
values ('c6000000-0000-4000-a000-000000000002', 'c6000000-0000-4000-a000-000000000001', 'Factor Person');
insert into public.tasks (id, title)
values ('c6000000-0000-4000-a000-000000000003', 'Factor task');
-- Comments, whose policies ask only who wrote them: one by the OWNER, one by the assistant.
insert into public.task_comments (id, task_id, author_id, body) values
  ('c6000000-0000-4000-a000-0000000000c1', 'c6000000-0000-4000-a000-000000000003',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', 'Factor comment'),
  ('c6000000-0000-4000-a000-0000000000c2', 'c6000000-0000-4000-a000-000000000003',
   '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'My own comment');
-- A mail attachment in the assistant's own folder, stored the way the Storage
-- API stores one: its policies ask only whose folder it is (0038).
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('mail-attachments', '21fc20c1-50e8-4764-9a11-71031d2f8f2c/c6000000-0000-4000-a000-0000000000a1/a.txt',
   '21fc20c1-50e8-4764-9a11-71031d2f8f2c', '{"size": 5, "mimetype": "text/plain"}');

-- ── No authenticator at all ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal1"}', true);

insert into results(name, expected, actual, pass)
select 'NO FACTOR: aal1 is staff', 'true', public.is_staff()::text, public.is_staff();

insert into results(name, expected, actual, pass)
select 'NO FACTOR: aal1 reads the CRM', '1', count(*)::text, count(*) = 1
from public.crm_contacts where id = 'c6000000-0000-4000-a000-000000000002';

insert into results(name, expected, actual, pass)
select 'NO FACTOR: aal1 sees their own mail attachment', '1', count(*)::text, count(*) = 1
from storage.objects where bucket_id = 'mail-attachments' and name like '21fc20c1-50e8-4764-9a11-71031d2f8f2c/%';

reset role;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('c6000000-0000-4000-a000-0000000000f1', '21fc20c1-50e8-4764-9a11-71031d2f8f2c',
        'check-db 06', 'totp', 'unverified', now(), now());

-- ── An abandoned enrolment ───────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal1"}', true);

insert into results(name, expected, actual, pass)
select 'UNVERIFIED FACTOR: aal1 is staff', 'true', public.is_staff()::text, public.is_staff();

insert into results(name, expected, actual, pass)
select 'UNVERIFIED FACTOR: aal1 reads the CRM', '1', count(*)::text, count(*) = 1
from public.crm_contacts where id = 'c6000000-0000-4000-a000-000000000002';

reset role;
update auth.mfa_factors set status = 'verified', updated_at = now()
where id = 'c6000000-0000-4000-a000-0000000000f1';

-- ── A verified factor, and a session that skipped it ─────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal1"}', true);

insert into results(name, expected, actual, pass)
select 'AAL1: second_factor_met() is false', 'false', public.second_factor_met()::text, not public.second_factor_met();

insert into results(name, expected, actual, pass)
select 'AAL1: no role and no employee id', 'null / null',
       coalesce(public.employee_role(), 'null') || ' / ' || coalesce(public.active_employee_id()::text, 'null'),
       public.employee_role() is null and public.active_employee_id() is null;

insert into results(name, expected, actual, pass)
select 'AAL1: not staff, not a manager — what the Edge Functions ask', 'false / false',
       public.is_staff()::text || ' / ' || public.is_manager()::text,
       not public.is_staff() and not public.is_manager();

insert into results(name, expected, actual, pass)
select 'AAL1: reads no contacts', '0', count(*)::text, count(*) = 0
from public.crm_contacts where id = 'c6000000-0000-4000-a000-000000000002';

insert into results(name, expected, actual, pass)
select 'AAL1: reads no colleagues', '0', count(*)::text, count(*) = 0
from public.employees;

select pg_temp.refused('AAL1: cannot add a company', $sql$
  insert into public.crm_companies (name) values ('Refused Co')
$sql$, 'row-level security');

select pg_temp.affects('AAL1: cannot change a contact', $sql$
  update public.crm_contacts set notes = 'changed at aal1'
  where id = 'c6000000-0000-4000-a000-000000000002'
$sql$, 0);

select pg_temp.refused('AAL1: the overview is for staff only', $sql$
  select public.workspace_overview()
$sql$, 'Staff only');

-- is_manager() used to answer null for a session with no role, and
-- "if not is_manager() then raise" does not raise on null.
select pg_temp.refused('AAL1: cannot sweep notes as an owner would', $sql$
  select public.cleanup_orphan_notes()
$sql$, 'Managers only');

-- Only the restrictive policy can refuse what follows: these permissive
-- policies ask who the person is, not whether they entered their code. The
-- refusal must name the policy, so it cannot pass for any other reason.
insert into results(name, expected, actual, pass)
select 'AAL1: reads no task comments, though their policy is using (true)', '0', count(*)::text, count(*) = 0
from public.task_comments where task_id = 'c6000000-0000-4000-a000-000000000003';

select pg_temp.refused('AAL1: cannot comment, though that policy only asks who the author is', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c6000000-0000-4000-a000-000000000003', '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'at aal1')
$sql$, 'second factor required');

select pg_temp.affects('AAL1: cannot delete their own comment', $sql$
  delete from public.task_comments where id = 'c6000000-0000-4000-a000-0000000000c2'
$sql$, 0);

insert into results(name, expected, actual, pass)
select 'AAL1: cannot see their own mail attachment', '0', count(*)::text, count(*) = 0
from storage.objects where bucket_id = 'mail-attachments' and name like '21fc20c1-50e8-4764-9a11-71031d2f8f2c/%';

-- A token with no aal claim at all is treated as aal1.
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated"}', true);

insert into results(name, expected, actual, pass)
select 'NO AAL CLAIM: counts as aal1', 'false', public.is_staff()::text, not public.is_staff();

-- ── The same person, with the code entered ───────────────────────────────
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'AAL2: staff again', 'employee', coalesce(public.employee_role(), 'null'), public.employee_role() = 'employee';

insert into results(name, expected, actual, pass)
select 'AAL2: reads the CRM', '1', count(*)::text, count(*) = 1
from public.crm_contacts where id = 'c6000000-0000-4000-a000-000000000002';

insert into results(name, expected, actual, pass)
select 'AAL2: reads task comments', '2', count(*)::text, count(*) = 2
from public.task_comments where task_id = 'c6000000-0000-4000-a000-000000000003';

insert into results(name, expected, actual, pass)
select 'AAL2: sees their own mail attachment', '1', count(*)::text, count(*) = 1
from storage.objects where bucket_id = 'mail-attachments' and name like '21fc20c1-50e8-4764-9a11-71031d2f8f2c/%';

select pg_temp.affects('AAL2: adds a company', $sql$
  insert into public.crm_companies (name) values ('Allowed Co')
$sql$, 1);

select pg_temp.affects('AAL2: comments', $sql$
  insert into public.task_comments (task_id, author_id, body)
  values ('c6000000-0000-4000-a000-000000000003', '21fc20c1-50e8-4764-9a11-71031d2f8f2c', 'at aal2')
$sql$, 1);

select pg_temp.affects('AAL2: deletes their own comment', $sql$
  delete from public.task_comments where id = 'c6000000-0000-4000-a000-0000000000c2'
$sql$, 1);

-- ── A signed-in account with no employee row at all ──────────────────────
select set_config('request.jwt.claims', '{"sub":"c6000000-0000-4000-a000-00000000dead","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NO EMPLOYEE ROW: not a manager — false, not nothing', 'false',
       coalesce(public.is_manager()::text, 'null'), public.is_manager() is false;

select pg_temp.refused('NO EMPLOYEE ROW: cannot sweep notes as an owner would', $sql$
  select public.cleanup_orphan_notes()
$sql$, 'Managers only');

-- ── The syncs run as the service role, which RLS does not apply to ───────
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into results(name, expected, actual, pass)
select 'SERVICE ROLE: unaffected', '1', count(*)::text, count(*) = 1
from public.crm_contacts where id = 'c6000000-0000-4000-a000-000000000002';

-- ── Every table is covered, including the next one someone adds ──────────
reset role;

insert into results(name, expected, actual, pass)
select 'GRANTS: anon cannot call second_factor_met()', 'false',
       has_function_privilege('anon', 'public.second_factor_met()', 'execute')::text,
       not has_function_privilege('anon', 'public.second_factor_met()', 'execute');

insert into results(name, expected, actual, pass)
select 'COVERAGE: every table in public has RLS on', 'none',
       coalesce(string_agg(c.relname, ', '), 'none'), count(*) = 0
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and not c.relrowsecurity
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

insert into results(name, expected, actual, pass)
select 'COVERAGE: every RLS table in public, and storage.objects, requires the second factor', 'none',
       coalesce(string_agg(n.nspname || '.' || c.relname, ', '), 'none'), count(*) = 0
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and c.relrowsecurity
  and (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = n.nspname
      and p.tablename = c.relname
      and p.policyname = 'second factor required'
      and p.permissive = 'RESTRICTIVE'
      and p.cmd = 'ALL'
      and p.roles @> array['authenticated']::name[]
      and p.qual like '%second_factor_met%'
      and p.with_check like '%second_factor_met%'
  );

-- A view that runs as its owner skips RLS, and with it this policy.
insert into results(name, expected, actual, pass)
select 'COVERAGE: every view in public runs as the person asking', 'none',
       coalesce(string_agg(c.relname, ', '), 'none'), count(*) = 0
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and (c.relkind = 'm'
       or (c.relkind = 'v'
           and not exists (select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) o
                           where o in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1'))))
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
