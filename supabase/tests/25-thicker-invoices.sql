-- 25-thicker-invoices.sql — a number that is really one, when an invoice last
-- changed, tax, and its lines (0060).
--
-- A number is unique whatever its case or the spaces typed around it, and a
-- clash is refused rather than silently allowed. updated_at moves when an
-- invoice changes and cannot be forged by the caller — the trigger overwrites
-- whatever value a write sends, which is the only way to prove it fired
-- without the wall clock moving inside one transaction. tax_rate and
-- tax_amount take a sensible range and nothing outside it. finance_invoice_lines
-- is read and written like every other finance table — managers, with their
-- second factor — and a line is gone once its invoice is; staff read and add
-- none, and a session that has not entered its code is refused as it is
-- everywhere else. Invoices and companies are named "check-db 25 …" so no
-- stored row can collide with a fixture here. Everything is rolled back.
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

-- ── The OWNER, a manager, with the second factor entered ────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

-- ── 1. A number that is really one ───────────────────────────────────────

select pg_temp.affects('NUMBER: a manager adds two invoices with different numbers', $sql$
  insert into public.finance_invoices (id, number, client, amount) values
    ('25a00000-0000-4000-a000-000000000101', 'CHECK-25-101', 'check-db 25 Northline Studio', 100),
    ('25a00000-0000-4000-a000-000000000102', 'CHECK-25-102', 'check-db 25 Northline Studio', 200)
$sql$, 2);

select pg_temp.refused('NUMBER: the same number, in another case and with spaces around it, is refused', $sql$
  insert into public.finance_invoices (id, number, client, amount)
  values ('25a00000-0000-4000-a000-000000000103', '  check-25-101 ', 'check-db 25 Northline Studio', 300)
$sql$, 'duplicate key');

select pg_temp.check('NUMBER: the first invoice is unharmed by the refused duplicate', 'CHECK-25-101', $sql$
  select number, number = 'CHECK-25-101' from public.finance_invoices
  where id = '25a00000-0000-4000-a000-000000000101'
$sql$);

select pg_temp.refused('NUMBER: renaming one invoice to another''s number is refused too', $sql$
  update public.finance_invoices set number = 'check-25-102'
  where id = '25a00000-0000-4000-a000-000000000101'
$sql$, 'duplicate key');

-- ── 2. When an invoice last changed ──────────────────────────────────────

select pg_temp.check('UPDATED_AT: a new invoice already has one', 'not null', $sql$
  select case when updated_at is null then 'null' else 'not null' end, updated_at is not null
  from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000101'
$sql$);

-- now() is fixed for the whole transaction, so the wall clock cannot move
-- between the insert and this update within one suite run — but the trigger
-- overwriting a value the caller sent is exactly as much proof that it fired,
-- and needs no clock to move to show it.
select pg_temp.affects('UPDATED_AT: a manager changes the invoice, trying to backdate it', $sql$
  update public.finance_invoices
  set notes = 'changed for check-db 25', updated_at = '2000-01-01T00:00:00Z'
  where id = '25a00000-0000-4000-a000-000000000101'
$sql$, 1);

select pg_temp.check('UPDATED_AT: the trigger overwrites whatever the caller sent, with now()', 'true', $sql$
  select (updated_at = now())::text, updated_at = now()
  from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000101'
$sql$);

-- ── 3. Tax and VAT, beside the total ─────────────────────────────────────

select pg_temp.affects('TAX: a manager records tax on an invoice', $sql$
  update public.finance_invoices set tax_rate = 8.875, tax_amount = 8.88
  where id = '25a00000-0000-4000-a000-000000000102'
$sql$, 1);

select pg_temp.check('TAX: the rate and amount round-trip exactly', '8.875 · 8.88', $sql$
  select tax_rate || ' · ' || tax_amount, tax_rate = 8.875 and tax_amount = 8.88
  from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000102'
$sql$);

select pg_temp.refused('TAX: a negative rate is refused', $sql$
  update public.finance_invoices set tax_rate = -1 where id = '25a00000-0000-4000-a000-000000000102'
$sql$, 'finance_invoices_tax_rate_check');

select pg_temp.refused('TAX: a rate over 100% is refused', $sql$
  update public.finance_invoices set tax_rate = 100.5 where id = '25a00000-0000-4000-a000-000000000102'
$sql$, 'finance_invoices_tax_rate_check');

select pg_temp.refused('TAX: a negative tax amount is refused', $sql$
  update public.finance_invoices set tax_amount = -0.01 where id = '25a00000-0000-4000-a000-000000000102'
$sql$, 'finance_invoices_tax_amount_check');

select pg_temp.check('TAX: still whatever was last accepted, after the refusals above', '8.875 · 8.88', $sql$
  select tax_rate || ' · ' || tax_amount, tax_rate = 8.875 and tax_amount = 8.88
  from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000102'
$sql$);

select pg_temp.check('TAX: no tax recorded is still fine, exactly as before this migration', 'true', $sql$
  select (tax_rate is null and tax_amount is null)::text, tax_rate is null and tax_amount is null
  from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000101'
$sql$);

-- ── 4. Invoice lines ──────────────────────────────────────────────────────

select pg_temp.check('LINES: a fresh invoice has none until one is added — the backfill is one-time, not a trigger', '0', $sql$
  select count(*)::text, count(*) = 0 from public.finance_invoice_lines
  where invoice_id = '25a00000-0000-4000-a000-000000000101'
$sql$);

select pg_temp.affects('LINES: a manager itemises the invoice', $sql$
  insert into public.finance_invoice_lines (id, invoice_id, description, quantity, unit_amount, amount, sort_order) values
    ('25a00000-0000-4000-a000-000000000201', '25a00000-0000-4000-a000-000000000101', 'Design', 10, 15, 150, 0),
    ('25a00000-0000-4000-a000-000000000202', '25a00000-0000-4000-a000-000000000101', 'Development', 20, 15, 300, 1)
$sql$, 2);

select pg_temp.check('LINES: the manager reads them back, in order', 'Design · Development', $sql$
  select string_agg(description, ' · ' order by sort_order),
         string_agg(description, ' · ' order by sort_order) = 'Design · Development'
  from public.finance_invoice_lines where invoice_id = '25a00000-0000-4000-a000-000000000101'
$sql$);

-- ── An employee: reads and writes no line, exactly as for an invoice ─────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: reads no invoice line', '0', count(*)::text, count(*) = 0
from public.finance_invoice_lines where invoice_id = '25a00000-0000-4000-a000-000000000101';

select pg_temp.refused('STAFF: cannot add a line', $sql$
  insert into public.finance_invoice_lines (invoice_id, description, unit_amount, amount)
  values ('25a00000-0000-4000-a000-000000000101', 'Slipped in', 1, 1)
$sql$, 'row-level security');

-- ── The same owner, without the second factor entered ────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal1"}', true);

insert into results(name, expected, actual, pass)
select 'AAL1: even the owner reads no line before the code is entered', '0', count(*)::text, count(*) = 0
from public.finance_invoice_lines where invoice_id = '25a00000-0000-4000-a000-000000000101';

select pg_temp.refused('AAL1: and cannot add one either', $sql$
  insert into public.finance_invoice_lines (invoice_id, description, unit_amount, amount)
  values ('25a00000-0000-4000-a000-000000000101', 'Slipped in at aal1', 1, 1)
$sql$, 'second factor required');

-- ── An anonymous caller ────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);

insert into results(name, expected, actual, pass)
select 'ANON: reads no invoice line', '0', count(*)::text, count(*) = 0
from public.finance_invoice_lines where invoice_id = '25a00000-0000-4000-a000-000000000101';

-- ── Back to the OWNER, with the code entered ──────────────────────────────
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('CASCADE: removing the invoice removes it', $sql$
  delete from public.finance_invoices where id = '25a00000-0000-4000-a000-000000000101'
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CASCADE: its lines go with it', '0', count(*)::text, count(*) = 0
from public.finance_invoice_lines where invoice_id = '25a00000-0000-4000-a000-000000000101';

-- ── Prove the table carries exactly the two policies every finance table does ──

insert into results(name, expected, actual, pass)
select 'POLICIES: finance_invoice_lines has the two policies every finance table has, and no others',
       'manager all finance invoice lines · second factor required',
       coalesce(string_agg(policyname, ' · ' order by policyname), 'none'),
       count(*) = 2
       and coalesce(bool_and(case policyname
             when 'manager all finance invoice lines' then
               permissive = 'PERMISSIVE' and cmd = 'ALL'
               and qual like '%is_manager()%' and with_check like '%is_manager()%'
             when 'second factor required' then
               permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles = array['authenticated']::name[]
               and qual like '%second_factor_met()%' and with_check like '%second_factor_met()%'
             else false end), false)
from pg_policies
where schemaname = 'public' and tablename = 'finance_invoice_lines';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
