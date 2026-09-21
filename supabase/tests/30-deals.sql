-- 30-deals.sql — several deals per client, each with its own stage and value,
-- and a won/lost history (0067).
--
-- One company holds several open deals at once, which is the whole point of
-- the table: the old shape (crm_companies.stage/.value/.currency, 0021) had
-- room for one. A deal is open exactly when it has no outcome; won and lost
-- are the outcome and never a stage, so a deal keeps the stage it stood at
-- when it closed. The shape rules hold — a blank title, an outcome with no
-- date, a date with no outcome, a negative value, a currency that is not
-- three capital letters and a stage the table does not have are each refused.
-- Deals are read and written like every other CRM table (0021's split): staff
-- add and change, only a manager removes, a session that has not entered its
-- code is refused everything, and anon reads none of it. updated_at moves on
-- every change and cannot be forged. The backfill is one-time and not a
-- trigger, so a company added now has no deal until someone adds one. And —
-- the regression 0067 §5 exists for — merging two companies moves the merged
-- one's deals to the company kept, rather than failing outright because
-- crm_merge_references() does not know the table.
--
-- Companies and deals are named "check-db 30 …" so no stored row can collide
-- with a fixture here, and the merge runs on two companies at stage 'lead' so
-- it never touches the project's client number sequence. Everything is rolled
-- back.
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

-- A query that answers (actual text, pass boolean).
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

grant execute on function pg_temp.refused(text, text, text), pg_temp.affects(text, text, int),
  pg_temp.check(text, text, text) to authenticated, anon;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);

-- ── Fixtures, as the table owner ─────────────────────────────────────────
-- Two companies the merge later folds into one, and a third that is added
-- after 0067 ran — so it must have no deal of its own until someone adds one.
-- All at stage 'lead' and in EUR: 'client' would draw a client number from
-- the project's own sequence (0053), and merge_companies refuses a company to
-- keep whose value is in a code 0049's rule does not accept.

insert into public.crm_companies (id, name, stage, currency, value) values
  ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Keep Co', 'lead', 'EUR', 4000),
  ('30a00000-0000-4000-a000-000000000002', 'check-db 30 Drop Co', 'lead', 'EUR', 2000),
  ('30a00000-0000-4000-a000-000000000003', 'check-db 30 Fresh Co', 'lead', 'EUR', null);

-- ── The assistant, a member of staff, with the second factor entered ─────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

-- ── 1. Several open deals on one company ─────────────────────────────────

select pg_temp.affects('SEVERAL: staff put three deals on one company, each at its own stage and its own value', $sql$
  insert into public.crm_deals (id, company_id, title, stage, value, currency, expected_close) values
    ('30a00000-0000-4000-a000-000000000101', '30a00000-0000-4000-a000-000000000001',
     'check-db 30 Retainer renewal', 'proposal', 12000, 'EUR', '2026-11-30'),
    ('30a00000-0000-4000-a000-000000000102', '30a00000-0000-4000-a000-000000000001',
     'check-db 30 New site', 'qualified', 30000, 'EUR', '2027-01-15'),
    ('30a00000-0000-4000-a000-000000000103', '30a00000-0000-4000-a000-000000000001',
     'check-db 30 Brand refresh', 'lead', null, 'EUR', null)
$sql$, 3);

select pg_temp.check('SEVERAL: all three are open on the one company, and none of them is the others'' stage',
  'lead · proposal · qualified', $sql$
  select string_agg(stage, ' · ' order by stage),
         string_agg(stage, ' · ' order by stage) = 'lead · proposal · qualified'
  from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000001' and outcome is null and deleted_at is null
$sql$);

select pg_temp.check('SEVERAL: their values are three separate figures, not one overwritten by the next',
  '42000', $sql$
  select sum(value)::text, sum(value) = 42000 from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000001'
$sql$);

select pg_temp.check('SEVERAL: the company''s own stage and value are untouched — 0067 drops neither',
  'lead · 4000.00', $sql$
  select stage || ' · ' || value, stage = 'lead' and value = 4000
  from public.crm_companies where id = '30a00000-0000-4000-a000-000000000001'
$sql$);

-- ── 2. The shape a deal must have ────────────────────────────────────────

select pg_temp.refused('SHAPE: a deal with a blank title is refused', $sql$
  insert into public.crm_deals (company_id, title)
  values ('30a00000-0000-4000-a000-000000000001', '   ')
$sql$, 'crm_deals_title_check');

select pg_temp.refused('SHAPE: won with no date is refused — a win nobody can put in a quarter', $sql$
  insert into public.crm_deals (company_id, title, outcome)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Undated win', 'won')
$sql$, 'crm_deals_closed_check');

select pg_temp.refused('SHAPE: a close date with no outcome is refused too', $sql$
  insert into public.crm_deals (company_id, title, closed_at)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Dated nothing', now())
$sql$, 'crm_deals_closed_check');

select pg_temp.refused('SHAPE: a negative value is refused — a deal is worth what winning it pays', $sql$
  insert into public.crm_deals (company_id, title, value)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Negative', -1)
$sql$, 'crm_deals_value_check');

select pg_temp.refused('SHAPE: a currency that is not three capital letters is refused (0049''s rule)', $sql$
  insert into public.crm_deals (company_id, title, currency)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Dollars', 'US$')
$sql$, 'crm_deals_currency_check');

select pg_temp.refused('SHAPE: a stage the table does not have is refused', $sql$
  insert into public.crm_deals (company_id, title, stage)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Nowhere', 'negotiating')
$sql$, 'crm_deals_stage_check');

select pg_temp.refused('SHAPE: "won" is an outcome, never a stage, so it is refused as one', $sql$
  insert into public.crm_deals (company_id, title, stage)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Won as a stage', 'won')
$sql$, 'crm_deals_stage_check');

-- ── 3. Moving a deal, and closing it ─────────────────────────────────────

select pg_temp.affects('MOVE: staff move one deal along without touching its siblings', $sql$
  update public.crm_deals set stage = 'proposal'
  where id = '30a00000-0000-4000-a000-000000000102'
$sql$, 1);

select pg_temp.check('MOVE: the deal moved and the other two stayed where they were',
  'lead · proposal · proposal', $sql$
  select string_agg(stage, ' · ' order by stage),
         string_agg(stage, ' · ' order by stage) = 'lead · proposal · proposal'
  from public.crm_deals where company_id = '30a00000-0000-4000-a000-000000000001'
$sql$);

select pg_temp.affects('WON: staff mark the renewal won, with the day it was won', $sql$
  update public.crm_deals set outcome = 'won', closed_at = now()
  where id = '30a00000-0000-4000-a000-000000000101'
$sql$, 1);

select pg_temp.check('WON: it keeps the stage it stood at when it closed — the history the old shape lost',
  'proposal · won', $sql$
  select stage || ' · ' || outcome, stage = 'proposal' and outcome = 'won'
  from public.crm_deals where id = '30a00000-0000-4000-a000-000000000101'
$sql$);

select pg_temp.affects('LOST: staff mark the brand refresh lost, from the stage it never got past', $sql$
  update public.crm_deals set outcome = 'lost', closed_at = now()
  where id = '30a00000-0000-4000-a000-000000000103'
$sql$, 1);

select pg_temp.check('OPEN: one of the three is still open, and it is the one nobody closed',
  'check-db 30 New site', $sql$
  select string_agg(title, ' · ' order by title),
         string_agg(title, ' · ' order by title) = 'check-db 30 New site'
  from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000001' and outcome is null and deleted_at is null
$sql$);

select pg_temp.refused('CLOSED: clearing the date but leaving the outcome is refused', $sql$
  update public.crm_deals set closed_at = null
  where id = '30a00000-0000-4000-a000-000000000101'
$sql$, 'crm_deals_closed_check');

-- Reopening is clearing both together, which the rule allows.
select pg_temp.affects('REOPEN: clearing the outcome and the date together puts a deal back in the pipeline', $sql$
  update public.crm_deals set outcome = null, closed_at = null
  where id = '30a00000-0000-4000-a000-000000000103'
$sql$, 1);

select pg_temp.affects('REOPEN: and it is closed again, so the rest of this suite reads as it was written', $sql$
  update public.crm_deals set outcome = 'lost', closed_at = now()
  where id = '30a00000-0000-4000-a000-000000000103'
$sql$, 1);

-- ── 4. updated_at, and a soft delete only a manager may make ─────────────
-- now() is fixed for the whole transaction, so the wall clock cannot move
-- between the insert and this update within one suite run — but the trigger
-- overwriting a value the caller sent is exactly as much proof that it fired,
-- and needs no clock to move to show it (suite 25's own reasoning).

select pg_temp.affects('UPDATED_AT: staff change a deal, trying to backdate it', $sql$
  update public.crm_deals set notes = 'changed for check-db 30', updated_at = '2000-01-01T00:00:00Z'
  where id = '30a00000-0000-4000-a000-000000000102'
$sql$, 1);

select pg_temp.check('UPDATED_AT: the trigger overwrites whatever the caller sent, with now()', 'true', $sql$
  select (updated_at = now())::text, updated_at = now()
  from public.crm_deals where id = '30a00000-0000-4000-a000-000000000102'
$sql$);

select pg_temp.refused('REMOVE: staff cannot take a deal off the board — guard_soft_delete (0012, wired here by 0067)', $sql$
  update public.crm_deals set deleted_at = now()
  where id = '30a00000-0000-4000-a000-000000000102'
$sql$, 'owner or admin');

-- A DELETE the policy filters out reaches no row rather than raising: RLS
-- narrows what a statement can see, and a statement that sees nothing is not
-- an error. So this is counted, not caught — the same way the aal1 update
-- below is.
select pg_temp.affects('REMOVE: nor can staff delete the row outright — the delete policy is the manager''s', $sql$
  delete from public.crm_deals where id = '30a00000-0000-4000-a000-000000000102'
$sql$, 0);

select pg_temp.check('REMOVE: and the deal is still there afterwards', 'check-db 30 New site', $sql$
  select title, title = 'check-db 30 New site' from public.crm_deals
  where id = '30a00000-0000-4000-a000-000000000102'
$sql$);

-- ── 5. The backfill is one-time, not a trigger ───────────────────────────

select pg_temp.check('BACKFILL: a company added after 0067 ran has no deal until someone adds one', '0', $sql$
  select count(*)::text, count(*) = 0 from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000003'
$sql$);

-- ── 6. A session that has not entered its code ───────────────────────────
--
-- The OWNER, not the assistant, and that is the whole point: second_factor_met()
-- (0040) answers true for an account with no verified factor enrolled, because
-- such an account has no code to owe and nothing to withhold. The assistant has
-- none on this project, so running this block as them proves nothing — the
-- restrictive policy correctly lets them through and the checks read as a hole
-- that is not there. The owner has a verified factor, so aal1 genuinely owes a
-- code, which is what makes these three checks mean something. 25-thicker-
-- invoices.sql's own aal1 block uses the owner for exactly this reason.
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal1"}', true);

insert into results(name, expected, actual, pass)
select 'AAL1: staff read no deal at all before the code is entered', '0', count(*)::text, count(*) = 0
from public.crm_deals where company_id = '30a00000-0000-4000-a000-000000000001';

-- Two policies apply to this insert (the permissive staff one and the
-- restrictive second-factor one), so Postgres's own message names neither —
-- the same generic form every other suite expects on a table with both.
select pg_temp.refused('AAL1: and adds none either', $sql$
  insert into public.crm_deals (company_id, title)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Slipped in at aal1')
$sql$, 'row-level security');

select pg_temp.affects('AAL1: an update reaches no row rather than changing one', $sql$
  update public.crm_deals set stage = 'lead' where id = '30a00000-0000-4000-a000-000000000102'
$sql$, 0);

-- ── 7. Someone signed in who is not on the team, and anon ────────────────

select set_config('request.jwt.claims', '{"sub":"30a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NOT ON THE TEAM: signed in, and reads no deal', '0', count(*)::text, count(*) = 0
from public.crm_deals where company_id = '30a00000-0000-4000-a000-000000000001';

reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);

insert into results(name, expected, actual, pass)
select 'ANON: reads no deal', '0', count(*)::text, count(*) = 0
from public.crm_deals where company_id = '30a00000-0000-4000-a000-000000000001';

select pg_temp.refused('ANON: and adds none', $sql$
  insert into public.crm_deals (company_id, title)
  values ('30a00000-0000-4000-a000-000000000001', 'check-db 30 Anon')
$sql$, 'row-level security');

-- ── 8. The OWNER, a manager ──────────────────────────────────────────────

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('REMOVE: a manager takes a deal off the board', $sql$
  update public.crm_deals set deleted_at = now()
  where id = '30a00000-0000-4000-a000-000000000103'
$sql$, 1);

select pg_temp.check('REMOVE: the removed deal is off the open list, and the closed one is still there', '1', $sql$
  select count(*)::text, count(*) = 1 from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000001'
    and deleted_at is null and outcome is not null
$sql$);

-- ── 9. Merging two companies moves the merged one's deals (0067 §5) ──────
-- The regression this migration's §5 exists to prevent: without
-- crm_deals.company_id in crm_merge_references(), 0053's own guard raises
-- "lists a reference to crm_companies this merge does not know how to treat"
-- and every company merge in the workspace stops dead.

select pg_temp.affects('MERGE: the company about to be merged away has two deals of its own', $sql$
  insert into public.crm_deals (id, company_id, title, stage, value, currency) values
    ('30a00000-0000-4000-a000-000000000201', '30a00000-0000-4000-a000-000000000002',
     'check-db 30 Drop Co support', 'qualified', 5000, 'EUR'),
    ('30a00000-0000-4000-a000-000000000202', '30a00000-0000-4000-a000-000000000002',
     'check-db 30 Drop Co hosting', 'lead', 900, 'EUR')
$sql$, 2);

select pg_temp.check('MERGE: the OWNER merges Drop Co into Keep Co, and the merge answers that it moved two deals',
  'deals 2', $sql$
  select 'deals ' || coalesce(r -> 'moved' ->> 'crm_deals.company_id', '?'),
         coalesce(r -> 'moved' ->> 'crm_deals.company_id' = '2', false)
  from public.merge_companies('30a00000-0000-4000-a000-000000000001',
                              '30a00000-0000-4000-a000-000000000002') as r
$sql$);

select pg_temp.check('MERGE: both of the merged company''s deals now belong to the company kept',
  'check-db 30 Drop Co hosting · check-db 30 Drop Co support', $sql$
  select string_agg(title, ' · ' order by title),
         string_agg(title, ' · ' order by title)
           = 'check-db 30 Drop Co hosting · check-db 30 Drop Co support'
  from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000001' and title like 'check-db 30 Drop Co%'
$sql$);

select pg_temp.check('MERGE: no deal is left pointing at the company that was merged away', '0', $sql$
  select count(*)::text, count(*) = 0 from public.crm_deals
  where company_id = '30a00000-0000-4000-a000-000000000002'
$sql$);

select pg_temp.check('MERGE: a moved deal keeps its own stage and value — the merge repoints it, nothing more',
  'qualified · 5000.00', $sql$
  select stage || ' · ' || value, stage = 'qualified' and value = 5000
  from public.crm_deals where id = '30a00000-0000-4000-a000-000000000201'
$sql$);

-- ── 10. A hard delete takes the deals with it ────────────────────────────

select pg_temp.affects('CASCADE: a manager deletes the fresh company outright', $sql$
  insert into public.crm_deals (id, company_id, title)
  values ('30a00000-0000-4000-a000-000000000301', '30a00000-0000-4000-a000-000000000003',
          'check-db 30 Fresh deal')
$sql$, 1);

select pg_temp.affects('CASCADE: the company goes', $sql$
  delete from public.crm_companies where id = '30a00000-0000-4000-a000-000000000003'
$sql$, 1);

select pg_temp.check('CASCADE: its deal goes with it — a deal is only ever reached through its company', '0', $sql$
  select count(*)::text, count(*) = 0 from public.crm_deals
  where id = '30a00000-0000-4000-a000-000000000301'
$sql$);

reset role;

-- ── 11. The shape of the table's own rules ───────────────────────────────

insert into results(name, expected, actual, pass)
select 'POLICIES: crm_deals carries the four policies every CRM table has, and the restrictive one 0040 could not add, and no others',
       'manager deletes crm_deals · second factor required · staff creates crm_deals · staff read crm_deals · staff updates crm_deals',
       coalesce(string_agg(policyname, ' · ' order by policyname), 'none'),
       count(*) = 5
       and coalesce(bool_and(case policyname
             when 'staff read crm_deals' then
               permissive = 'PERMISSIVE' and cmd = 'SELECT' and qual like '%is_staff()%'
             when 'staff creates crm_deals' then
               permissive = 'PERMISSIVE' and cmd = 'INSERT' and with_check like '%is_staff()%'
             when 'staff updates crm_deals' then
               permissive = 'PERMISSIVE' and cmd = 'UPDATE'
               and qual like '%is_staff()%' and with_check like '%is_staff()%'
             when 'manager deletes crm_deals' then
               permissive = 'PERMISSIVE' and cmd = 'DELETE' and qual like '%is_manager()%'
             when 'second factor required' then
               permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles = array['authenticated']::name[]
               and qual like '%second_factor_met()%' and with_check like '%second_factor_met()%'
             else false end), false)
from pg_policies
where schemaname = 'public' and tablename = 'crm_deals';

insert into results(name, expected, actual, pass)
select 'MERGE LIST: crm_merge_references() repoints crm_deals.company_id in step 1 — and still lists everything 0053 put there',
       'crm_deals repoint 1 · 14 references',
       coalesce((select m.table_name || ' ' || m.handling || ' ' || m.step
                 from public.crm_merge_references() m
                 where m.target_table = 'crm_companies' and m.table_name = 'crm_deals'), 'missing')
         || ' · ' || (select count(*)::text from public.crm_merge_references()) || ' references',
       exists (select 1 from public.crm_merge_references() m
               where m.target_table = 'crm_companies' and m.table_name = 'crm_deals'
                 and m.column_name = 'company_id' and m.handling = 'repoint' and m.step = 1)
       and (select count(*) from public.crm_merge_references()) = 14;

-- Every foreign key to a CRM table is one the merges handle — 0053's own rule,
-- restated here because 0067 rewrote the list it reads.
insert into results(name, expected, actual, pass)
select 'MERGE LIST: no foreign key to the CRM is left for no merge to handle', 'none',
       coalesce(string_agg(c.conrelid::regclass::text || '.' || a.attname, ', '
                           order by c.conrelid::regclass::text, a.attname), 'none'),
       count(*) = 0
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.contype = 'f'
  and c.confrelid in ('public.crm_companies'::regclass, 'public.crm_contacts'::regclass)
  and (cardinality(c.conkey) <> 1
       or not exists (select 1 from public.crm_merge_references() m
                      where to_regclass(format('public.%I', m.table_name)) = c.conrelid
                        and m.column_name = a.attname
                        and to_regclass(format('public.%I', m.target_table)) = c.confrelid));

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
