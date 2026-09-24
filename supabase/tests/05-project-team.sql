-- 05-project-team.sql — a project's team, its client people, its files and its
-- budget (0039).
--
-- The non-manager is the inactive assistant, woken for this transaction only:
-- first a stranger to the OWNER's project, then a member of it, then the owner
-- of a project of their own. Uploads go into storage.objects the way the
-- Storage API puts them there, owner_id included. Storage refuses direct
-- deletes unless storage.allow_delete_query is on, which the Storage API turns
-- on for its own deletes; this suite turns it on too, so a removal meets the
-- real delete policy.
--
-- A refusal passes only for the reason it is about: pg_temp.refused() looks for
-- that reason in the error, so a check cannot pass because something else broke.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

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

-- The OWNER's employee id, read here as the table owner: what a non-manager may
-- read of employees is not what these checks are about.
select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
-- What the Storage API turns on for its own deletes.
select set_config('storage.allow_delete_query', 'true', true);

-- Fixtures. All rolled back.
insert into public.crm_companies (id, name) values
  ('c5000000-0000-4000-a000-000000000001', 'Team Co'),
  ('c5000000-0000-4000-a000-000000000002', 'Other Co');
insert into public.crm_contacts (id, company_id, full_name) values
  ('c5000000-0000-4000-a000-000000000011', 'c5000000-0000-4000-a000-000000000001', 'Team Person'),
  ('c5000000-0000-4000-a000-000000000012', 'c5000000-0000-4000-a000-000000000002', 'Other Person');
-- P1 (…21) is the OWNER's. P2 (…22) is the assistant's own.
insert into public.client_projects (id, name, company_id, owner_id) values
  ('c5000000-0000-4000-a000-000000000021', 'Team Project', 'c5000000-0000-4000-a000-000000000001',
   current_setting('test.owner_employee')::uuid),
  ('c5000000-0000-4000-a000-000000000022', 'Assistant Project', 'c5000000-0000-4000-a000-000000000001',
   (select id from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'));
insert into public.project_budgets (project_id, amount, currency) values
  ('c5000000-0000-4000-a000-000000000021', 25000, 'EUR');
-- Uploaded by the OWNER, recorded the way the Storage API records an upload.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('project-files', 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 2048, "mimetype": "application/pdf"}'),
  ('project-files', 'c5000000-0000-4000-a000-000000000022/u2/elsewhere.pdf',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 64, "mimetype": "application/pdf"}');
-- The browser claims 1 byte of text; storage says otherwise.
insert into public.project_files (project_id, storage_path, name, size_bytes, content_type, uploaded_by) values
  ('c5000000-0000-4000-a000-000000000021', 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf',
   'brief.pdf', 1, 'text/plain', current_setting('test.owner_employee')::uuid);

-- ── The shape of things ──────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'BUDGET: no longer on client_projects', '0 columns', count(*) || ' columns', count(*) = 0
from information_schema.columns
where table_schema = 'public' and table_name = 'client_projects'
  and column_name in ('budget', 'currency');

insert into results(name, expected, actual, pass)
select 'VIEW: the board reads starts_on and completed_at', '2 columns', count(*) || ' columns', count(*) = 2
from information_schema.columns
where table_schema = 'public' and table_name = 'client_project_progress'
  and column_name in ('starts_on', 'completed_at');

insert into results(name, expected, actual, pass)
select 'FILE RECORD: size and type are what storage holds', '2048 application/pdf',
       size_bytes || ' ' || content_type, size_bytes = 2048 and content_type = 'application/pdf'
from public.project_files
where storage_path = 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf';

select pg_temp.refused('FILE RECORD: needs its upload', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes)
  values ('c5000000-0000-4000-a000-000000000021',
          'c5000000-0000-4000-a000-000000000021/u9/ghost.pdf', 'ghost.pdf', 10)
$sql$, 'has not finished uploading');

select pg_temp.refused('FILE RECORD: stays in its own project''s folder', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes)
  values ('c5000000-0000-4000-a000-000000000021',
          'c5000000-0000-4000-a000-000000000022/u2/elsewhere.pdf', 'elsewhere.pdf', 64)
$sql$, 'project_files_in_their_project');

select pg_temp.refused('PROJECT: one with files is archived, not deleted outright', $sql$
  delete from public.client_projects where id = 'c5000000-0000-4000-a000-000000000021'
$sql$, 'violates foreign key constraint');

update public.client_projects set status = 'completed' where id = 'c5000000-0000-4000-a000-000000000022';
insert into results(name, expected, actual, pass)
select 'COMPLETED: stamped when a project is finished', 'set',
       case when completed_at is null then 'empty' else 'set' end, completed_at is not null
from public.client_projects where id = 'c5000000-0000-4000-a000-000000000022';

update public.client_projects set status = 'in_progress' where id = 'c5000000-0000-4000-a000-000000000022';
insert into results(name, expected, actual, pass)
select 'COMPLETED: cleared when it is reopened', 'empty',
       case when completed_at is null then 'empty' else 'set' end, completed_at is null
from public.client_projects where id = 'c5000000-0000-4000-a000-000000000022';

insert into public.project_contacts (project_id, contact_id, role)
values ('c5000000-0000-4000-a000-000000000021', 'c5000000-0000-4000-a000-000000000011', 'billing');
update public.client_projects set company_id = 'c5000000-0000-4000-a000-000000000002'
where id = 'c5000000-0000-4000-a000-000000000021';
insert into results(name, expected, actual, pass)
select 'CONTACTS: a new company drops the old company''s people', '0 links', count(*) || ' links', count(*) = 0
from public.project_contacts where project_id = 'c5000000-0000-4000-a000-000000000021';
update public.client_projects set company_id = 'c5000000-0000-4000-a000-000000000001'
where id = 'c5000000-0000-4000-a000-000000000021';

-- ── The assistant, a stranger to the OWNER's project ─────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'FILES: records hidden from a non-member', '0 records', count(*) || ' records', count(*) = 0
from public.project_files where project_id = 'c5000000-0000-4000-a000-000000000021';

insert into results(name, expected, actual, pass)
select 'FILES: uploads hidden from a non-member', '0 objects', count(*) || ' objects', count(*) = 0
from storage.objects
where bucket_id = 'project-files' and name like 'c5000000-0000-4000-a000-000000000021/%';

select pg_temp.refused('FILES: a non-member cannot upload', $sql$
  insert into storage.objects (bucket_id, name, owner_id)
  values ('project-files', 'c5000000-0000-4000-a000-000000000021/u3/sneaky.pdf', auth.uid()::text)
$sql$, 'row-level security');

select pg_temp.affects('FILES: a non-member cannot remove an upload', $sql$
  delete from storage.objects
  where bucket_id = 'project-files' and name = 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf'
$sql$, 0);

select pg_temp.refused('MEMBERS: nobody adds themselves', $sql$
  insert into public.project_members (project_id, employee_id)
  values ('c5000000-0000-4000-a000-000000000021', public.active_employee_id())
$sql$, 'row-level security');

select pg_temp.refused('OWNER: an employee cannot take someone''s project', $sql$
  update public.client_projects set owner_id = public.active_employee_id()
  where id = 'c5000000-0000-4000-a000-000000000021'
$sql$, 'can change who owns it');

select pg_temp.refused('PROJECT IDS: an employee cannot choose a project''s id', $sql$
  insert into public.client_projects (id, name)
  values ('c5000000-0000-4000-a000-000000000099', 'A reused id')
$sql$, 'permission denied');

select pg_temp.refused('PROJECT IDS: nor change one', $sql$
  update public.client_projects set id = 'c5000000-0000-4000-a000-000000000099'
  where id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 'permission denied');

select pg_temp.affects('PROJECT: an employee still creates one the way the workspace does', $sql$
  insert into public.client_projects (name, company_id, code, accent, status, description, due_on, owner_id)
  values ('A fresh project', 'c5000000-0000-4000-a000-000000000001', 'F', 'client', 'discovery',
          'Made the way createProject makes one', current_date + 30, public.active_employee_id())
$sql$, 1);

select pg_temp.affects('PROJECT: an employee still moves a project along', $sql$
  update public.client_projects set status = 'in_review'
  where id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'BUDGET: hidden from an employee', '0 rows', count(*) || ' rows', count(*) = 0
from public.project_budgets;

select pg_temp.refused('BUDGET: an employee cannot set one, even on their own project', $sql$
  insert into public.project_budgets (project_id, amount)
  values ('c5000000-0000-4000-a000-000000000022', 10)
$sql$, 'row-level security');

select pg_temp.affects('CONTACTS: an employee adds the company''s contact', $sql$
  insert into public.project_contacts (project_id, contact_id, role)
  values ('c5000000-0000-4000-a000-000000000021', 'c5000000-0000-4000-a000-000000000011', 'decision_maker')
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CONTACTS: signed by whoever added them', 'the assistant',
       case when added_by = public.active_employee_id() then 'the assistant'
            else coalesce(added_by::text, 'nobody') end,
       added_by = public.active_employee_id()
from public.project_contacts
where project_id = 'c5000000-0000-4000-a000-000000000021'
  and contact_id = 'c5000000-0000-4000-a000-000000000011';

select pg_temp.refused('CONTACTS: not someone from another company', $sql$
  insert into public.project_contacts (project_id, contact_id, role)
  values ('c5000000-0000-4000-a000-000000000021', 'c5000000-0000-4000-a000-000000000012', 'billing')
$sql$, 'does not work at the project''s company');

select pg_temp.affects('CONTACTS: an employee changes a role', $sql$
  update public.project_contacts set role = 'billing'
  where project_id = 'c5000000-0000-4000-a000-000000000021'
    and contact_id = 'c5000000-0000-4000-a000-000000000011'
$sql$, 1);

select pg_temp.refused('CONTACTS: who added a contact cannot be rewritten', $sql$
  update public.project_contacts set added_by = null
  where project_id = 'c5000000-0000-4000-a000-000000000021'
$sql$, 'permission denied');

reset role;

-- ── The assistant, a member of the OWNER's project ───────────────────────

insert into public.project_members (project_id, employee_id)
select 'c5000000-0000-4000-a000-000000000021', id
from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';
-- The OWNER's upload whose record never saved.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('project-files', 'c5000000-0000-4000-a000-000000000021/u5/draft.pdf',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 512, "mimetype": "application/pdf"}');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'FILES: a member sees the records', '1 record', count(*) || ' record', count(*) = 1
from public.project_files where project_id = 'c5000000-0000-4000-a000-000000000021';

insert into results(name, expected, actual, pass)
select 'FILES: a member sees the uploads', '2 objects', count(*) || ' objects', count(*) = 2
from storage.objects
where bucket_id = 'project-files' and name like 'c5000000-0000-4000-a000-000000000021/%';

select pg_temp.affects('FILES: a member uploads a file', $sql$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('project-files', 'c5000000-0000-4000-a000-000000000021/u4/notes.txt', auth.uid()::text,
          '{"size": 5, "mimetype": "text/plain"}')
$sql$, 1);

select pg_temp.affects('FILES: and records it', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes, content_type)
  values ('c5000000-0000-4000-a000-000000000021',
          'c5000000-0000-4000-a000-000000000021/u4/notes.txt', 'notes.txt', 5, 'text/plain')
$sql$, 1);

select pg_temp.refused('FILES: a member cannot record a colleague''s upload as theirs', $sql$
  insert into public.project_files (project_id, storage_path, name, size_bytes)
  values ('c5000000-0000-4000-a000-000000000021',
          'c5000000-0000-4000-a000-000000000021/u5/draft.pdf', 'draft.pdf', 512)
$sql$, 'only whoever uploaded a file can record it');

select pg_temp.affects('FILES: a member removes their own upload', $sql$
  delete from storage.objects
  where bucket_id = 'project-files' and name = 'c5000000-0000-4000-a000-000000000021/u4/notes.txt'
$sql$, 1);

select pg_temp.affects('FILES: but not a colleague''s recorded upload', $sql$
  delete from storage.objects
  where bucket_id = 'project-files' and name = 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf'
$sql$, 0);

select pg_temp.affects('FILES: nor a colleague''s record', $sql$
  delete from public.project_files
  where storage_path = 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf'
$sql$, 0);

select pg_temp.affects('FILES: an upload nobody recorded can be cleared by the team', $sql$
  delete from storage.objects
  where bucket_id = 'project-files' and name = 'c5000000-0000-4000-a000-000000000021/u5/draft.pdf'
$sql$, 1);

select pg_temp.affects('MEMBERS: a member can leave', $sql$
  delete from public.project_members
  where project_id = 'c5000000-0000-4000-a000-000000000021'
    and employee_id = public.active_employee_id()
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'MEMBERS: leaving a project closes its files', '0 records', count(*) || ' records', count(*) = 0
from public.project_files where project_id = 'c5000000-0000-4000-a000-000000000021';

-- ── The assistant, owner of a project of their own ───────────────────────

select pg_temp.affects('MEMBERS: a project''s owner adds a colleague', $sql$
  insert into public.project_members (project_id, employee_id)
  values ('c5000000-0000-4000-a000-000000000022', current_setting('test.owner_employee')::uuid)
$sql$, 1);

select pg_temp.affects('OWNER: an owner hands their project over', $sql$
  update public.client_projects set owner_id = current_setting('test.owner_employee')::uuid
  where id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.refused('OWNER: and cannot take it back', $sql$
  update public.client_projects set owner_id = public.active_employee_id()
  where id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 'can change who owns it');

insert into results(name, expected, actual, pass)
select 'OWNER: the project is the OWNER''s now', 'the OWNER',
       case when owner_id = current_setting('test.owner_employee')::uuid then 'the OWNER'
            else coalesce(owner_id::text, 'nobody') end,
       owner_id = current_setting('test.owner_employee')::uuid
from public.client_projects where id = 'c5000000-0000-4000-a000-000000000022';

reset role;

-- ── The OWNER, a manager ─────────────────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'BUDGET: a manager sees it', '1 row', count(*) || ' row', count(*) = 1
from public.project_budgets where project_id = 'c5000000-0000-4000-a000-000000000021';

select pg_temp.affects('BUDGET: a manager sets one', $sql$
  insert into public.project_budgets (project_id, amount, currency)
  values ('c5000000-0000-4000-a000-000000000022', 900, 'EUR')
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'BUDGET: signed by the manager who set it', 'the OWNER',
       case when updated_by = current_setting('test.owner_employee')::uuid then 'the OWNER'
            else coalesce(updated_by::text, 'nobody') end,
       updated_by = current_setting('test.owner_employee')::uuid
from public.project_budgets where project_id = 'c5000000-0000-4000-a000-000000000022';

select pg_temp.affects('BUDGET: a manager changes one', $sql$
  update public.project_budgets set amount = 1200
  where project_id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.affects('BUDGET: a manager removes one', $sql$
  delete from public.project_budgets where project_id = 'c5000000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.affects('FILES: a manager removes anyone''s upload', $sql$
  delete from storage.objects
  where bucket_id = 'project-files' and name = 'c5000000-0000-4000-a000-000000000021/u1/brief.pdf'
$sql$, 1);

reset role;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
