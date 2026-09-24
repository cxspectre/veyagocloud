-- 14-crm-data-rules.sql — a company's currency is a code the workspace can
-- show, people writing from a public mailbox are not put into one shared
-- company, and promoting someone already in the CRM makes no company they do
-- not need (0049).
--
-- The assistant, inactive in real life, is woken for this transaction and
-- works as staff do in the workspace: adding and changing companies, and
-- promoting enquiries. The enquiries are stored as submit_website_enquiry()
-- stores them, the address in lower case: two strangers at gmx.de, one person
-- each at web.de, aol.com and pm.me, two people at a company's own domain, and
-- two people already in the CRM who write again — a repeat enquirer at gmx.de,
-- at a company since their first enquiry made them a contact, and someone at
-- web.de added with no company. A company made in this transaction has
-- created_at now(), the moment it began, so a check counts those before and
-- after a promotion. A refusal passes only for the reason it is about
-- (pg_temp.refused, as in 05). Everything is rolled back.
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

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

-- Fixtures. All rolled back.
insert into public.crm_companies (id, name, currency) values
  ('14a00000-0000-4000-a000-000000000001', 'check-db 14 company', 'EUR'),
  ('14a00000-0000-4000-a000-000000000002', 'check-db 14 repeat enquirer''s company', 'EUR');

insert into public.website_enquiries (id, kind, name, email, business) values
  ('14a00000-0000-4000-a000-000000000011', 'website', 'check-db 14 first stranger', 'check-db-14-first@gmx.de', null),
  ('14a00000-0000-4000-a000-000000000012', 'website', 'check-db 14 second stranger', 'check-db-14-second@gmx.de', null),
  ('14a00000-0000-4000-a000-000000000013', 'website', 'check-db 14 at web.de', 'check-db-14@web.de', null),
  ('14a00000-0000-4000-a000-000000000014', 'website', 'check-db 14 at aol.com', 'check-db-14@aol.com', null),
  ('14a00000-0000-4000-a000-000000000015', 'website', 'check-db 14 at pm.me', 'check-db-14@pm.me', null),
  ('14a00000-0000-4000-a000-000000000016', 'product', 'check-db 14 colleague one',
   'check-db-14-one@check-db-14.invalid', 'check-db 14 Studio'),
  ('14a00000-0000-4000-a000-000000000017', 'product', 'check-db 14 colleague two',
   'check-db-14-two@check-db-14.invalid', null),
  ('14a00000-0000-4000-a000-000000000031', 'website', 'check-db 14 repeat enquirer', 'check-db-14-again@gmx.de', null),
  ('14a00000-0000-4000-a000-000000000032', 'website', 'check-db 14 repeat enquirer', 'check-db-14-again@gmx.de', null),
  ('14a00000-0000-4000-a000-000000000033', 'website', 'check-db 14 repeat enquirer', 'check-db-14-again@gmx.de', null),
  ('14a00000-0000-4000-a000-000000000041', 'website', 'check-db 14 no company yet', 'check-db-14-no-company@web.de', null),
  ('14a00000-0000-4000-a000-000000000042', 'website', 'check-db 14 no company yet', 'check-db-14-no-company@web.de', null);

-- Already in the CRM: the repeat enquirer, whose first enquiry made them a
-- contact at their company, and someone added with no company.
insert into public.crm_contacts (id, company_id, full_name, email, enquiry_id) values
  ('14a00000-0000-4000-a000-000000000021', '14a00000-0000-4000-a000-000000000002',
   'check-db 14 repeat enquirer', 'check-db-14-again@gmx.de', '14a00000-0000-4000-a000-000000000031'),
  ('14a00000-0000-4000-a000-000000000022', null,
   'check-db 14 no company yet', 'check-db-14-no-company@web.de', null);

-- ── The assistant, a member of staff ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('CURRENCY: a company cannot be added in "US$"', $sql$
  insert into public.crm_companies (name, currency) values ('check-db 14 in dollars', 'US$')
$sql$, 'crm_companies_currency_check');

select pg_temp.refused('CURRENCY: nor changed to a code in lower case, as a project budget cannot', $sql$
  update public.crm_companies set currency = 'eur' where id = '14a00000-0000-4000-a000-000000000001'
$sql$, 'crm_companies_currency_check');

select pg_temp.refused('CURRENCY: nor to nothing', $sql$
  update public.crm_companies set currency = '' where id = '14a00000-0000-4000-a000-000000000001'
$sql$, 'crm_companies_currency_check');

select pg_temp.affects('CURRENCY: three capital letters still go through', $sql$
  update public.crm_companies set currency = 'CHF' where id = '14a00000-0000-4000-a000-000000000001'
$sql$, 1);

select pg_temp.affects('CURRENCY: a company added the way the workspace adds one, with no currency, still goes through', $sql$
  insert into public.crm_companies (name, domain, kind, stage, value, notes, owner_id)
  values ('check-db 14 added in the workspace', null, 'prospect', 'lead', 1200, null, public.active_employee_id())
$sql$, 1);

select pg_temp.affects('PROMOTE: staff promote the two enquiries from gmx.de', $sql$
  select public.promote_enquiry_to_crm(e.id)
  from (values ('14a00000-0000-4000-a000-000000000011'::uuid),
               ('14a00000-0000-4000-a000-000000000012'::uuid)) as e(id)
$sql$, 2);

insert into results(name, expected, actual, pass)
select 'FREE MAIL: two strangers at gmx.de are not put into one shared company', 'a company each',
       case when a.company_id is null or b.company_id is null then 'not both filed under a company'
            when a.company_id = b.company_id then 'one shared company'
            else 'a company each' end,
       coalesce(a.company_id <> b.company_id, false)
from (select (select c.company_id from public.crm_contacts c
              where c.enquiry_id = '14a00000-0000-4000-a000-000000000011' and c.deleted_at is null
              limit 1) as company_id) a,
     (select (select c.company_id from public.crm_contacts c
              where c.enquiry_id = '14a00000-0000-4000-a000-000000000012' and c.deleted_at is null
              limit 1) as company_id) b;

select pg_temp.affects('PROMOTE: and one enquiry each from web.de, aol.com and pm.me', $sql$
  select public.promote_enquiry_to_crm(e.id)
  from (values ('14a00000-0000-4000-a000-000000000013'::uuid),
               ('14a00000-0000-4000-a000-000000000014'::uuid),
               ('14a00000-0000-4000-a000-000000000015'::uuid)) as e(id)
$sql$, 3);

-- A company holding a public mailbox's domain would have the next stranger
-- from that mailbox filed under it.
insert into results(name, expected, actual, pass)
select 'FREE MAIL: none of their companies takes gmx.de, web.de, aol.com or pm.me as its domain',
       '5 contacts · no domain',
       count(*) || ' contacts · ' || coalesce(string_agg(distinct co.domain, ', '), 'no domain'),
       count(*) = 5 and count(co.domain) = 0
from public.crm_contacts c
join public.crm_companies co on co.id = c.company_id
where c.enquiry_id in ('14a00000-0000-4000-a000-000000000011', '14a00000-0000-4000-a000-000000000012',
                       '14a00000-0000-4000-a000-000000000013', '14a00000-0000-4000-a000-000000000014',
                       '14a00000-0000-4000-a000-000000000015')
  and c.deleted_at is null;

select pg_temp.affects('PROMOTE: and the two from people at one company''s own domain', $sql$
  select public.promote_enquiry_to_crm(e.id)
  from (values ('14a00000-0000-4000-a000-000000000016'::uuid),
               ('14a00000-0000-4000-a000-000000000017'::uuid)) as e(id)
$sql$, 2);

insert into results(name, expected, actual, pass)
select 'COMPANY MAIL: two people at a company''s own domain still share that company',
       '2 contacts at 1 company · check-db-14.invalid',
       count(*) || ' contacts at ' || count(distinct c.company_id) || ' company · '
         || coalesce(string_agg(distinct co.domain, ', '), 'no domain'),
       coalesce(count(*) = 2 and count(distinct c.company_id) = 1 and min(co.domain) = 'check-db-14.invalid', false)
from public.crm_contacts c
left join public.crm_companies co on co.id = c.company_id
where c.enquiry_id in ('14a00000-0000-4000-a000-000000000016', '14a00000-0000-4000-a000-000000000017')
  and c.deleted_at is null;

select pg_temp.check('AGAIN: an enquiry promoted a second time hands back the contact it made', 'the same contact', $sql$
  select case when made.id is null then 'no contact the first time'
              when again.id = made.id then 'the same contact'
              else 'another contact' end,
         coalesce(again.id = made.id, false)
  from (select public.promote_enquiry_to_crm('14a00000-0000-4000-a000-000000000011') as id) again,
       (select (select c.id from public.crm_contacts c
                where c.enquiry_id = '14a00000-0000-4000-a000-000000000011' and c.deleted_at is null
                limit 1) as id) made
$sql$);

-- ── A repeat enquirer, already a contact at a company ────────────────────
select set_config('test.companies_so_far',
  (select count(*)::text from public.crm_companies where created_at = now()), true);

select pg_temp.check('AGAIN, FROM GMX.DE: a contact at a company, promoted from a second and a third enquiry, is handed back both times',
                     'the contact they are, 2 of 2 times', $sql$
  select 'the contact they are, '
           || count(*) filter (where p.id = '14a00000-0000-4000-a000-000000000021') || ' of ' || count(*) || ' times',
         count(*) = 2 and count(*) filter (where p.id = '14a00000-0000-4000-a000-000000000021') = 2
  from (select public.promote_enquiry_to_crm(e.id) as id
        from (values ('14a00000-0000-4000-a000-000000000032'::uuid),
                     ('14a00000-0000-4000-a000-000000000033'::uuid)) as e(id)) p
$sql$);

select pg_temp.check('AGAIN, FROM GMX.DE: and no company is made for them', 'companies made: 0', $sql$
  select 'companies made: ' || made.n, made.n = 0
  from (select count(*) - current_setting('test.companies_so_far')::int as n
        from public.crm_companies where created_at = now()) made
$sql$);

select pg_temp.check('AGAIN, FROM GMX.DE: they keep their company, and the trail back to their first enquiry',
                     'their company · the first enquiry', $sql$
  select case when c.company_id = '14a00000-0000-4000-a000-000000000002' then 'their company'
              else coalesce(c.company_id::text, 'no company') end
           || ' · '
           || case when c.enquiry_id = '14a00000-0000-4000-a000-000000000031' then 'the first enquiry'
                   else coalesce(c.enquiry_id::text, 'no enquiry') end,
         coalesce(c.company_id = '14a00000-0000-4000-a000-000000000002'
                  and c.enquiry_id = '14a00000-0000-4000-a000-000000000031', false)
  from public.crm_contacts c
  where c.id = '14a00000-0000-4000-a000-000000000021'
$sql$);

-- ── Someone in the CRM with no company yet ───────────────────────────────
select set_config('test.companies_so_far',
  (select count(*)::text from public.crm_companies where created_at = now()), true);

select pg_temp.check('NO COMPANY YET: a contact without one, promoted from an enquiry, is handed back', 'the contact they are', $sql$
  select case when p.id = '14a00000-0000-4000-a000-000000000022' then 'the contact they are'
              else coalesce(p.id::text, 'null') end,
         coalesce(p.id = '14a00000-0000-4000-a000-000000000022', false)
  from (select public.promote_enquiry_to_crm('14a00000-0000-4000-a000-000000000041') as id) p
$sql$);

select pg_temp.check('NO COMPANY YET: and gains exactly one company, made for them', 'companies made: 1 · filed under it', $sql$
  select 'companies made: ' || made.n || ' · '
           || case when c.company_id is null then 'no company'
                   when co.created_at = now() then 'filed under it'
                   else 'filed under a company that was there before' end,
         coalesce(made.n = 1 and co.created_at = now(), false)
  from (select count(*) - current_setting('test.companies_so_far')::int as n
        from public.crm_companies where created_at = now()) made
  left join public.crm_contacts c on c.id = '14a00000-0000-4000-a000-000000000022'
  left join public.crm_companies co on co.id = c.company_id
$sql$);

select set_config('test.companies_so_far',
  (select count(*)::text from public.crm_companies where created_at = now()), true);
select set_config('test.their_company',
  coalesce((select company_id::text from public.crm_contacts
            where id = '14a00000-0000-4000-a000-000000000022'), ''), true);

select pg_temp.check('NO COMPANY YET: promoted from a second enquiry, is handed back again', 'the contact they are', $sql$
  select case when p.id = '14a00000-0000-4000-a000-000000000022' then 'the contact they are'
              else coalesce(p.id::text, 'null') end,
         coalesce(p.id = '14a00000-0000-4000-a000-000000000022', false)
  from (select public.promote_enquiry_to_crm('14a00000-0000-4000-a000-000000000042') as id) p
$sql$);

select pg_temp.check('NO COMPANY YET: and no company is made; they keep theirs, and the trail back to their first enquiry',
                     'companies made: 0 · their company · the first enquiry', $sql$
  select 'companies made: ' || made.n || ' · '
           || case when c.company_id::text = current_setting('test.their_company') then 'their company'
                   else coalesce(c.company_id::text, 'no company') end
           || ' · '
           || case when c.enquiry_id = '14a00000-0000-4000-a000-000000000041' then 'the first enquiry'
                   else coalesce(c.enquiry_id::text, 'no enquiry') end,
         coalesce(made.n = 0
                  and c.company_id::text = current_setting('test.their_company')
                  and c.enquiry_id = '14a00000-0000-4000-a000-000000000041', false)
  from (select count(*) - current_setting('test.companies_so_far')::int as n
        from public.crm_companies where created_at = now()) made
  left join public.crm_contacts c on c.id = '14a00000-0000-4000-a000-000000000022'
$sql$);

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"14a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('NOT ON THE TEAM: signed in, and cannot promote an enquiry', $sql$
  select public.promote_enquiry_to_crm('14a00000-0000-4000-a000-000000000013')
$sql$, 'Only staff can promote an enquiry');

reset role;

-- ── What is stored, and who may promote ──────────────────────────────────

-- 0049 writes a code that is three capital letters but for its case or the
-- spaces around it, like ' usd ' or 'eur', as those letters. Only a company
-- stored before 0049 can hold such a code, so this looks at every company
-- rather than at a fixture of its own: none may be left.
insert into results(name, expected, actual, pass)
select 'CURRENCY: no company is left in a code that is three capital letters but for its case or spaces',
       '0 companies',
       count(*) || ' companies' || coalesce(': ' || string_agg(quote_literal(currency), ', ' order by currency), ''),
       count(*) = 0
from public.crm_companies
where currency !~ '^[A-Z]{3}$' and upper(btrim(currency)) ~ '^[A-Z]{3}$';

-- Any other code stored before 0049, like "US$", keeps the rule NOT VALID
-- until it is fixed and the rule validated (see 0049); this says how many
-- companies are left.
insert into results(name, expected, actual, pass)
select 'CURRENCY: every company stored follows the rule, so it holds for all of them',
       'validated · 0 companies outside it',
       case when k.convalidated then 'validated' when k.conname is null then 'no rule' else 'not valid' end
         || ' · ' || b.n || ' companies outside it',
       coalesce(k.convalidated, false) and b.n = 0
from (select count(*) as n from public.crm_companies where currency !~ '^[A-Z]{3}$') b
left join pg_constraint k
  on k.conrelid = 'public.crm_companies'::regclass and k.conname = 'crm_companies_currency_check';

insert into results(name, expected, actual, pass)
select 'GRANTS: signed-in staff can promote an enquiry, anon cannot', 'authenticated yes · anon no',
       'authenticated ' || case when has_function_privilege('authenticated', 'public.promote_enquiry_to_crm(uuid)', 'execute')
                                then 'yes' else 'no' end
         || ' · anon ' || case when has_function_privilege('anon', 'public.promote_enquiry_to_crm(uuid)', 'execute')
                               then 'yes' else 'no' end,
       has_function_privilege('authenticated', 'public.promote_enquiry_to_crm(uuid)', 'execute')
         and not has_function_privilege('anon', 'public.promote_enquiry_to_crm(uuid)', 'execute');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
