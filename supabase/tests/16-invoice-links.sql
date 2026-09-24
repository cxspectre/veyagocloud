-- 16-invoice-links.sql — an invoice knows its client's company and its
-- project (0051).
--
-- An invoice carried only its client's name, so the workspace matched invoices
-- to companies by name and could tie none to a project. A project now brings
-- its company with it, and a project for another company is refused. Without
-- a company, the client's name links the one live company of that name,
-- whatever its case or the spaces around it: never one of two, never a deleted
-- one, and never against the company of the invoice's project. The OWNER, a
-- manager, adds and changes invoices and both links, the way the workspace and
-- invoice-pdf write them; the assistant, woken for this transaction as an
-- employee, still reads and writes no invoice. Someone signed in who is not on
-- the team, and an anonymous caller, are refused by row-level security before
-- they learn whose a project is. When a project moves to another company, its
-- invoices keep theirs, and such an invoice can still be pointed at another
-- company, the way merge_companies (0053) points a merged company's invoices at
-- the one it keeps; an invoice that agrees with its project cannot. The
-- backfill 0051 ran is run again, as the table owner, over invoices stored
-- before their company was added: it links by name and by nothing else,
-- changes nothing else, writes no activity about what it links, and leaves
-- alone an invoice whose project has a company.
--
-- Companies and projects are named "check-db 16 …", so no stored company can
-- match, and a check names a fixture by the last two digits of its id. Each
-- write is its own statement before anything reads what it did. A refusal
-- passes only for the reason it is about (pg_temp.refused, as in 05).
-- Everything is rolled back.
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

-- A query that answers (actual text, pass boolean). An error is a named FAIL,
-- not the end of the suite: without 0051 there are no links to read.
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

-- What an invoice is linked to, as a check says it.
create function pg_temp.links(p_company uuid, p_project uuid)
returns text
language sql
as $$
  select case when p_company is null then 'no company' else 'company ' || right(p_company::text, 2) end
         || ' · '
         || case when p_project is null then 'no project' else 'project ' || right(p_project::text, 2) end;
$$;

grant execute on function pg_temp.refused(text, text, text), pg_temp.affects(text, text, int),
  pg_temp.check(text, text, text), pg_temp.links(uuid, uuid) to authenticated, anon;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- Fixtures, as the table owner. Companies: one of its name (01), two live ones
-- of one name (02, 03), one only deleted (04), a deleted one and a live one of
-- one name (05, 06), the project's (07) and another (08). Projects: 21 is 07's;
-- 22 and 23 have no company.
insert into public.crm_companies (id, name, deleted_at) values
  ('16a00000-0000-4000-a000-000000000001', 'check-db 16 Northline Studio', null),
  ('16a00000-0000-4000-a000-000000000002', 'check-db 16 Twin & Co', null),
  ('16a00000-0000-4000-a000-000000000003', 'check-db 16 Twin & Co', null),
  ('16a00000-0000-4000-a000-000000000004', 'check-db 16 Closed GmbH', now()),
  ('16a00000-0000-4000-a000-000000000005', 'check-db 16 Renamed BV', now()),
  ('16a00000-0000-4000-a000-000000000006', 'check-db 16 Renamed BV', null),
  ('16a00000-0000-4000-a000-000000000007', 'check-db 16 Project Client', null),
  ('16a00000-0000-4000-a000-000000000008', 'check-db 16 Other Client', null);

insert into public.client_projects (id, name, company_id) values
  ('16a00000-0000-4000-a000-000000000021', 'check-db 16 Project', '16a00000-0000-4000-a000-000000000007'),
  ('16a00000-0000-4000-a000-000000000022', 'check-db 16 Project with no company', null),
  ('16a00000-0000-4000-a000-000000000023', 'check-db 16 Another project with no company', null);

-- ── The OWNER, a manager ─────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('NAME: a manager adds six invoices that name only their client', $sql$
  insert into public.finance_invoices (id, number, client, amount) values
    ('16a00000-0000-4000-a000-000000000101', 'CHECK-16-101', 'check-db 16 Northline Studio', 101),
    ('16a00000-0000-4000-a000-000000000102', 'CHECK-16-102', '  CHECK-DB 16 northline STUDIO ', 102),
    ('16a00000-0000-4000-a000-000000000103', 'CHECK-16-103', 'check-db 16 Twin & Co', 103),
    ('16a00000-0000-4000-a000-000000000104', 'CHECK-16-104', 'check-db 16 Closed GmbH', 104),
    ('16a00000-0000-4000-a000-000000000105', 'CHECK-16-105', 'check-db 16 Renamed BV', 105),
    ('16a00000-0000-4000-a000-000000000106', 'CHECK-16-106', 'check-db 16 Nobody', 106)
$sql$, 6);

select pg_temp.check('NAME: a client with one company of its name is linked to it', 'company 01 · no project', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000001' and project_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000101'
$sql$);

select pg_temp.check('CASE AND SPACES: the same name in other case, with spaces around it, still links', 'company 01 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000001'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000102'
$sql$);

select pg_temp.check('TWO OF A NAME: a name two live companies share links neither', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000103'
$sql$);

select pg_temp.check('DELETED: a name only a deleted company has links nothing', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000104'
$sql$);

select pg_temp.check('DELETED: a deleted company does not stand in the way of the live one of its name', 'company 06 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000006'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000105'
$sql$);

select pg_temp.check('NAME: a name no company has links nothing', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000106'
$sql$);

select pg_temp.affects('PROJECT: a manager adds an invoice under a project, naming no company', $sql$
  insert into public.finance_invoices (id, number, client, amount, project_id)
  values ('16a00000-0000-4000-a000-000000000107', 'CHECK-16-107', 'check-db 16 Northline Studio', 107,
          '16a00000-0000-4000-a000-000000000021')
$sql$, 1);

select pg_temp.check('PROJECT: it takes the project''s company, not the one its client''s name would link', 'company 07 · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000007' and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000107'
$sql$);

select pg_temp.affects('PROJECT: a manager adds an invoice naming a project and that project''s company', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id)
  values ('16a00000-0000-4000-a000-000000000108', 'CHECK-16-108', 'check-db 16 Project Client', 108,
          '16a00000-0000-4000-a000-000000000007', '16a00000-0000-4000-a000-000000000021')
$sql$, 1);

select pg_temp.refused('PROJECT: an invoice for one company cannot name another company''s project', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id)
  values ('16a00000-0000-4000-a000-000000000109', 'CHECK-16-109', 'check-db 16 Other Client', 109,
          '16a00000-0000-4000-a000-000000000008', '16a00000-0000-4000-a000-000000000021')
$sql$, 'belongs to a different company');

select pg_temp.affects('PROJECT: a manager adds an invoice under a project that has no company', $sql$
  insert into public.finance_invoices (id, number, client, amount, project_id)
  values ('16a00000-0000-4000-a000-000000000110', 'CHECK-16-110', 'check-db 16 Northline Studio', 110,
          '16a00000-0000-4000-a000-000000000022')
$sql$, 1);

select pg_temp.check('PROJECT: with no company from its project, its client''s name links one', 'company 01 · project 22', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000001' and project_id = '16a00000-0000-4000-a000-000000000022'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000110'
$sql$);

select pg_temp.affects('BY HAND: a manager adds an invoice linked to a company', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id)
  values ('16a00000-0000-4000-a000-000000000111', 'CHECK-16-111', 'check-db 16 Other Client', 111,
          '16a00000-0000-4000-a000-000000000008')
$sql$, 1);

select pg_temp.affects('PROJECT LATER: a manager files the invoice two companies'' name left unlinked under a project', $sql$
  update public.finance_invoices set project_id = '16a00000-0000-4000-a000-000000000021'
  where id = '16a00000-0000-4000-a000-000000000103'
$sql$, 1);

select pg_temp.check('PROJECT LATER: and it takes the project''s company', 'company 07 · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000007' and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000103'
$sql$);

select pg_temp.refused('PROJECT LATER: an invoice linked to one company cannot be filed under another company''s project', $sql$
  update public.finance_invoices set project_id = '16a00000-0000-4000-a000-000000000021'
  where id = '16a00000-0000-4000-a000-000000000101'
$sql$, 'belongs to a different company');

select pg_temp.refused('COMPANY LATER: nor an invoice under a project moved to another company', $sql$
  update public.finance_invoices set company_id = '16a00000-0000-4000-a000-000000000008'
  where id = '16a00000-0000-4000-a000-000000000107'
$sql$, 'belongs to a different company');

select pg_temp.affects('CLIENT LATER: a manager corrects the client of an invoice nothing linked', $sql$
  update public.finance_invoices set client = 'check-db 16 Northline Studio'
  where id = '16a00000-0000-4000-a000-000000000104'
$sql$, 1);

select pg_temp.check('CLIENT LATER: and the company its new name has is linked', 'company 01 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000001'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000104'
$sql$);

select pg_temp.affects('CLIENT LATER: a manager renames the client of a linked invoice', $sql$
  update public.finance_invoices set client = 'check-db 16 Other Client'
  where id = '16a00000-0000-4000-a000-000000000102'
$sql$, 1);

select pg_temp.check('CLIENT LATER: and it keeps its company', 'company 01 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000001'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000102'
$sql$);

select pg_temp.affects('BY HAND: a manager links an invoice to a company and a project', $sql$
  update public.finance_invoices
  set company_id = '16a00000-0000-4000-a000-000000000007', project_id = '16a00000-0000-4000-a000-000000000021'
  where id = '16a00000-0000-4000-a000-000000000106'
$sql$, 1);

select pg_temp.check('BY HAND: both links are written', 'company 07 · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000007' and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000106'
$sql$);

select pg_temp.affects('BY HAND: a manager takes both links off again', $sql$
  update public.finance_invoices set company_id = null, project_id = null
  where id = '16a00000-0000-4000-a000-000000000106'
$sql$, 1);

select pg_temp.check('BY HAND: and both stay off', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null and project_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000106'
$sql$);

select pg_temp.affects('BY HAND: a manager takes the company off an invoice under a project', $sql$
  update public.finance_invoices set company_id = null
  where id = '16a00000-0000-4000-a000-000000000108'
$sql$, 1);

select pg_temp.check('BY HAND: and the company stays off, though the project has one', 'no company · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id is null and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000108'
$sql$);

select pg_temp.affects('CLIENT LATER: a manager renames that invoice''s client to another company''s name', $sql$
  update public.finance_invoices set client = 'check-db 16 Northline Studio'
  where id = '16a00000-0000-4000-a000-000000000108'
$sql$, 1);

select pg_temp.check('CLIENT LATER: and the name links no company against its project''s', 'no company · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id is null and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000108'
$sql$);

select pg_temp.refused('COMPANY LATER: nor can that invoice, with no company but under a project, be given another company', $sql$
  update public.finance_invoices set company_id = '16a00000-0000-4000-a000-000000000008'
  where id = '16a00000-0000-4000-a000-000000000108'
$sql$, 'belongs to a different company');

reset role;

-- ── The assistant, an employee ───────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: still read no invoice', '0 invoices', count(*) || ' invoices', count(*) = 0
from public.finance_invoices where number like 'CHECK-16-%';

select pg_temp.refused('STAFF: cannot add an invoice, not even one a company''s name would link', $sql$
  insert into public.finance_invoices (id, number, client, amount)
  values ('16a00000-0000-4000-a000-000000000120', 'CHECK-16-120', 'check-db 16 Northline Studio', 120)
$sql$, 'row-level security');

select pg_temp.refused('STAFF: nor one under a project and its company', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id)
  values ('16a00000-0000-4000-a000-000000000121', 'CHECK-16-121', 'check-db 16 Project Client', 121,
          '16a00000-0000-4000-a000-000000000007', '16a00000-0000-4000-a000-000000000021')
$sql$, 'row-level security');

select pg_temp.affects('STAFF: cannot link an invoice to a company', $sql$
  update public.finance_invoices set company_id = '16a00000-0000-4000-a000-000000000001'
  where id = '16a00000-0000-4000-a000-000000000103'
$sql$, 0);

select pg_temp.affects('STAFF: nor take an invoice off its project', $sql$
  update public.finance_invoices set project_id = null
  where id = '16a00000-0000-4000-a000-000000000103'
$sql$, 0);

reset role;

select pg_temp.check('STAFF: the invoice they tried is as the manager left it', 'company 07 · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000007' and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000103'
$sql$);

-- ── Someone signed in who is not on the team, and nobody signed in ───────
-- Neither may read projects, so neither is told whose a project is: the write
-- is refused by row-level security, not by what 0051 knows of the project.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"16a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('NOT ON THE TEAM: an invoice under another company''s project is refused by row-level security, saying nothing of the project', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id)
  values ('16a00000-0000-4000-a000-000000000122', 'CHECK-16-122', 'check-db 16 Other Client', 122,
          '16a00000-0000-4000-a000-000000000008', '16a00000-0000-4000-a000-000000000021')
$sql$, 'row-level security');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select pg_temp.refused('ANON: and so is an anonymous caller''s', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id, project_id)
  values ('16a00000-0000-4000-a000-000000000123', 'CHECK-16-123', 'check-db 16 Other Client', 123,
          '16a00000-0000-4000-a000-000000000008', '16a00000-0000-4000-a000-000000000021')
$sql$, 'row-level security');

reset role;

-- ── The OWNER again: projects and companies that change afterwards ───────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('LATER: a manager moves the project to another company', $sql$
  update public.client_projects set company_id = '16a00000-0000-4000-a000-000000000006'
  where id = '16a00000-0000-4000-a000-000000000021'
$sql$, 1);

-- Every field written back as it stands, the way a form that saves them all does.
select pg_temp.affects('LATER: an invoice under that project can still be marked paid', $sql$
  update public.finance_invoices
  set status = 'paid', paid_on = current_date, client = client, company_id = company_id, project_id = project_id
  where id = '16a00000-0000-4000-a000-000000000107'
$sql$, 1);

select pg_temp.check('LATER: and keeps the company it was for', 'paid · company 07 · project 21', $sql$
  select status || ' · ' || pg_temp.links(company_id, project_id),
         status = 'paid' and company_id = '16a00000-0000-4000-a000-000000000007'
         and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000107'
$sql$);

-- merge_companies (0053) points a merged company's invoices at the company it
-- keeps with this statement, whatever project they are under. 103 and 107 are
-- company 07's, under project 21, which has moved to company 06: they already
-- disagreed with their project, so the write does not make them disagree.
select pg_temp.affects('MERGE: the invoices of a company, under a project since moved to another, can be pointed at a third company, as merging companies does', $sql$
  update public.finance_invoices set company_id = '16a00000-0000-4000-a000-000000000001'
  where company_id = '16a00000-0000-4000-a000-000000000007'
$sql$, 2);

select pg_temp.check('MERGE: both now name that company, still under the project that moved',
                     'company 01 · project 21 · company 01 · project 21', $sql$
  select string_agg(pg_temp.links(company_id, project_id), ' · ' order by id),
         count(*) = 2
         and bool_and(company_id = '16a00000-0000-4000-a000-000000000001'
                      and project_id = '16a00000-0000-4000-a000-000000000021')
  from public.finance_invoices
  where id in ('16a00000-0000-4000-a000-000000000103', '16a00000-0000-4000-a000-000000000107')
$sql$);

select pg_temp.affects('MERGE: a manager files a new invoice under the project that moved', $sql$
  insert into public.finance_invoices (id, number, client, amount, project_id)
  values ('16a00000-0000-4000-a000-000000000112', 'CHECK-16-112', 'check-db 16 Renamed BV', 112,
          '16a00000-0000-4000-a000-000000000021')
$sql$, 1);

select pg_temp.refused('MERGE: but an invoice that agrees with its project still cannot be pointed at another company', $sql$
  update public.finance_invoices set company_id = '16a00000-0000-4000-a000-000000000001'
  where id = '16a00000-0000-4000-a000-000000000112'
$sql$, 'belongs to a different company');

select pg_temp.check('MERGE: and it keeps the company of the project it is under', 'company 06 · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000006' and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000112'
$sql$);

select pg_temp.affects('DELETED OUTRIGHT: a manager deletes a company', $sql$
  delete from public.crm_companies where id = '16a00000-0000-4000-a000-000000000008'
$sql$, 1);

select pg_temp.check('DELETED OUTRIGHT: its invoice stays, linked to no company', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null and project_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000111'
$sql$);

select pg_temp.affects('DELETED OUTRIGHT: a manager deletes a project', $sql$
  delete from public.client_projects where id = '16a00000-0000-4000-a000-000000000022'
$sql$, 1);

select pg_temp.check('DELETED OUTRIGHT: its invoice stays, on no project, still linked to its company', 'company 01 · no project', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000001' and project_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000110'
$sql$);

reset role;

-- ── The backfill, run again as the table owner ───────────────────────────
-- Invoices stored as the service role stores them, before their company was in
-- the CRM, so nothing linked them: one naming a company added later (131), the
-- same name in other case and spaces (132), a paid one (136), one under a
-- project with no company (137), one naming two companies added later (133),
-- one naming a company added and deleted (134), and one a manager already
-- linked to another company (135). 108, from above, is under a project that
-- has a company, and names another.
select set_config('request.jwt.claims', '', true);

insert into public.finance_invoices
  (id, number, client, amount, currency, status, issued_on, due_on, paid_on, notes, client_email)
values
  ('16a00000-0000-4000-a000-000000000131', 'CHECK-16-131', 'check-db 16 Late Arrival', 131, 'USD', 'sent',
   current_date - 20, current_date + 10, null, null, null),
  ('16a00000-0000-4000-a000-000000000132', 'CHECK-16-132', ' CHECK-DB 16 late arrival  ', 132, 'USD', 'draft',
   null, null, null, null, null),
  ('16a00000-0000-4000-a000-000000000133', 'CHECK-16-133', 'check-db 16 Late Twins', 133, 'USD', 'sent',
   current_date - 20, current_date + 10, null, null, null),
  ('16a00000-0000-4000-a000-000000000134', 'CHECK-16-134', 'check-db 16 Late Closed', 134, 'USD', 'overdue',
   current_date - 40, current_date - 10, null, null, null),
  ('16a00000-0000-4000-a000-000000000136', 'CHECK-16-136', 'check-db 16 Late Arrival', 136, 'EUR', 'paid',
   current_date - 40, current_date - 10, current_date - 5, 'check-db 16 paid in full', 'ap@check-db-16.invalid');

select pg_temp.affects('BACKFILL: an invoice a manager linked to another company is stored', $sql$
  insert into public.finance_invoices (id, number, client, amount, company_id)
  values ('16a00000-0000-4000-a000-000000000135', 'CHECK-16-135', 'check-db 16 Late Arrival', 135,
          '16a00000-0000-4000-a000-000000000006')
$sql$, 1);

select pg_temp.affects('BACKFILL: and one under a project with no company', $sql$
  insert into public.finance_invoices (id, number, client, amount, project_id)
  values ('16a00000-0000-4000-a000-000000000137', 'CHECK-16-137', 'check-db 16 Late Arrival', 137,
          '16a00000-0000-4000-a000-000000000023')
$sql$, 1);

insert into public.crm_companies (id, name, deleted_at) values
  ('16a00000-0000-4000-a000-000000000009', 'check-db 16 Late Arrival', null),
  ('16a00000-0000-4000-a000-000000000010', 'check-db 16 Late Twins', null),
  ('16a00000-0000-4000-a000-000000000011', 'check-db 16 Late Twins', null),
  ('16a00000-0000-4000-a000-000000000012', 'check-db 16 Late Closed', now());

select pg_temp.check('BACKFILL: nothing linked them when they were stored', '0 of 6 linked', $sql$
  select count(company_id) || ' of ' || count(*) || ' linked', count(*) = 6 and count(company_id) = 0
  from public.finance_invoices
  where id in ('16a00000-0000-4000-a000-000000000131', '16a00000-0000-4000-a000-000000000132',
               '16a00000-0000-4000-a000-000000000133', '16a00000-0000-4000-a000-000000000134',
               '16a00000-0000-4000-a000-000000000136', '16a00000-0000-4000-a000-000000000137')
$sql$);

-- Activity about this suite's own invoices, companies and projects, and no
-- other: the whole feed would also count what other sessions write meanwhile.
select set_config('test.activity_before',
  (select count(*)::text from public.workspace_activity where entity_id::text like '16a00000-%'), true);
select set_config('test.paid_before',
  (select md5((to_jsonb(i) - 'company_id')::text) from public.finance_invoices i
   where i.id = '16a00000-0000-4000-a000-000000000136'), true);

select pg_temp.check('BACKFILL: runs again, as the table owner', 'at least 4 invoices linked', $sql$
  select n || ' invoices linked', n >= 4
  from (select public.link_invoices_by_client() as n) backfill
$sql$);

select pg_temp.check('BACKFILL: an invoice whose client names one live company is linked to it', 'company 09 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000009'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000131'
$sql$);

select pg_temp.check('BACKFILL: so is one naming it in other case, with spaces around it', 'company 09 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000009'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000132'
$sql$);

select pg_temp.check('BACKFILL: and one under a project with no company', 'company 09 · project 23', $sql$
  select pg_temp.links(company_id, project_id),
         company_id = '16a00000-0000-4000-a000-000000000009' and project_id = '16a00000-0000-4000-a000-000000000023'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000137'
$sql$);

select pg_temp.check('BACKFILL: a name two live companies share links neither', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000133'
$sql$);

select pg_temp.check('BACKFILL: a name only a deleted company has links nothing', 'no company · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id is null
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000134'
$sql$);

select pg_temp.check('BACKFILL: an invoice already linked keeps its company', 'company 06 · no project', $sql$
  select pg_temp.links(company_id, project_id), company_id = '16a00000-0000-4000-a000-000000000006'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000135'
$sql$);

select pg_temp.check('BACKFILL: an invoice under a project that has a company is left as a manager left it', 'no company · project 21', $sql$
  select pg_temp.links(company_id, project_id),
         company_id is null and project_id = '16a00000-0000-4000-a000-000000000021'
  from public.finance_invoices where id = '16a00000-0000-4000-a000-000000000108'
$sql$);

select pg_temp.check('BACKFILL: a paid invoice is linked, and nothing else about it changes', 'company 09 · otherwise as it was', $sql$
  select pg_temp.links(company_id, project_id)
           || case when md5((to_jsonb(i) - 'company_id')::text) = current_setting('test.paid_before')
                   then ' · otherwise as it was' else ' · changed' end,
         company_id = '16a00000-0000-4000-a000-000000000009' and project_id is null
         and md5((to_jsonb(i) - 'company_id')::text) = current_setting('test.paid_before')
  from public.finance_invoices i where i.id = '16a00000-0000-4000-a000-000000000136'
$sql$);

insert into results(name, expected, actual, pass)
select 'BACKFILL: writes nothing to the activity feed about what it links', '0 activities', n || ' activities', n = 0
from (select count(*) - current_setting('test.activity_before')::int as n
      from public.workspace_activity
      where entity_id::text like '16a00000-%') written;

-- ── What 0051 leaves in place ────────────────────────────────────────────

select pg_temp.check('SHAPE: each link lets go when its company or project is deleted, and is indexed',
                     'company_id: crm_companies, set null, indexed · project_id: client_projects, set null, indexed', $sql$
  select string_agg(a.attname || ': ' || t.relname || ', '
                      || case k.confdeltype when 'n' then 'set null' else 'on delete ' || k.confdeltype::text end || ', '
                      || case when exists (select 1 from pg_index x
                                           where x.indrelid = k.conrelid and x.indkey[0] = a.attnum)
                              then 'indexed' else 'not indexed' end,
                    ' · ' order by a.attname),
         count(*) = 2
         and bool_and(k.confdeltype = 'n')
         and bool_and(exists (select 1 from pg_index x where x.indrelid = k.conrelid and x.indkey[0] = a.attnum))
         and bool_and((a.attname, t.relname) in (('company_id', 'crm_companies'), ('project_id', 'client_projects')))
  from pg_constraint k
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
  join pg_class t on t.oid = k.confrelid
  where k.conrelid = 'public.finance_invoices'::regclass
    and k.contype = 'f'
    and a.attname in ('company_id', 'project_id')
$sql$);

-- 0005 gave invoices to managers only, and 0040 asked for the second factor.
-- 0051 changes neither: staff read no invoice (above), and nothing else opens one.
insert into results(name, expected, actual, pass)
select 'POLICIES: invoices keep the two policies 0005 and 0040 gave them, and no others',
       'manager all finance invoices · second factor required',
       coalesce(string_agg(policyname, ' · ' order by policyname), 'none'),
       count(*) = 2
       and coalesce(bool_and(case policyname
             when 'manager all finance invoices' then
               permissive = 'PERMISSIVE' and cmd = 'ALL'
               and qual like '%is_manager()%' and with_check like '%is_manager()%'
             when 'second factor required' then
               permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles = array['authenticated']::name[]
               and qual like '%second_factor_met()%' and with_check like '%second_factor_met()%'
             else false end), false)
from pg_policies
where schemaname = 'public' and tablename = 'finance_invoices';

select pg_temp.check('GRANTS: neither a signed-in nor an anonymous caller can call 0051''s functions',
                     'authenticated none · anon none', $sql$
  select 'authenticated ' || case when bool_or(has_function_privilege('authenticated', f, 'execute')) then 'some' else 'none' end
           || ' · anon ' || case when bool_or(has_function_privilege('anon', f, 'execute')) then 'some' else 'none' end,
         not bool_or(has_function_privilege('authenticated', f, 'execute'))
         and not bool_or(has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.invoice_client_company(text)', 'public.link_invoice()',
                    'public.link_invoices_by_client()']) as f
$sql$);

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
