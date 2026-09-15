-- 24-mail-domain-match.sql — an inbound message finds its company by domain
-- when no contact's own address does (0059).
--
-- Fixtures: two companies, each with its own domain; one contact at a
-- company (Ana, Northline) and one in the CRM with no company yet (Ben, at
-- an address on Harbor's own domain). Threads cover: a stranger at a
-- company's domain (twice, so it is not a fluke); a known contact with no
-- company, found by domain; a known contact who already has one, unchanged;
-- an address that matches neither a contact nor any company's domain; a
-- thread a human already filed under a company, not moved by a stranger's
-- domain; an outbound message, which this never touches; and a message with
-- no from_email at all. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);

insert into public.crm_companies (id, name, domain) values
  ('24a00000-0000-4000-a000-000000000001', 'check-db 24 Northline', 'northline-24.invalid'),
  ('24a00000-0000-4000-a000-000000000002', 'check-db 24 Harbor', 'harbor-24.invalid');

-- Ana is at Northline; Ben is in the CRM but at no company yet, even though
-- his own address is on Harbor's domain.
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('24a00000-0000-4000-a000-000000000011', '24a00000-0000-4000-a000-000000000001',
   'check-db 24 Ana', 'ana-24@northline-24.invalid'),
  ('24a00000-0000-4000-a000-000000000012', null,
   'check-db 24 Ben', 'ben-24@harbor-24.invalid');

insert into public.integration_connections (id, provider, account_label, status) values
  ('24a00000-0000-4000-a000-000000000021', 'imap', 'mail-domain-match-24.fixture@example.invalid', 'connected');

-- T1, T2: strangers at Northline's own domain — nobody in the CRM has
-- either address, so only the domain can say whose company this is.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000101', '24a00000-0000-4000-a000-000000000021', 'thr-24-1', 'check-db 24 new sender one'),
  ('24a00000-0000-4000-a000-000000000102', '24a00000-0000-4000-a000-000000000021', 'thr-24-2', 'check-db 24 new sender two');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000111', '24a00000-0000-4000-a000-000000000101', 'msg-24-1', 'inbound',
   'first-24@northline-24.invalid', 'check-db 24 new sender one', 'Hello.', now(), 'inbox'),
  ('24a00000-0000-4000-a000-000000000112', '24a00000-0000-4000-a000-000000000102', 'msg-24-2', 'inbound',
   'second-24@northline-24.invalid', 'check-db 24 new sender two', 'Hello again.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: a stranger at a company''s own domain files the thread under it', 'check-db 24 Northline',
       coalesce(co.name, 'no company'), co.id = '24a00000-0000-4000-a000-000000000001'
from public.mail_threads t left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000101';

insert into results(name, expected, actual, pass)
select 'DOMAIN: a second, different stranger at the same domain — not a fluke of the first', 'check-db 24 Northline',
       coalesce(co.name, 'no company'), co.id = '24a00000-0000-4000-a000-000000000001'
from public.mail_threads t left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000102';

insert into results(name, expected, actual, pass)
select 'DOMAIN: neither stranger becomes a contact — only the thread''s company is filled', '0 contacts',
       count(*) || ' contacts', count(*) = 0
from public.crm_contacts
where email in ('first-24@northline-24.invalid', 'second-24@northline-24.invalid');

-- T3: Ben, a known contact with no company, found by his own exact address —
-- and his company filled in from that same address's domain.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000103', '24a00000-0000-4000-a000-000000000021', 'thr-24-3', 'check-db 24 Ben writes in');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000113', '24a00000-0000-4000-a000-000000000103', 'msg-24-3', 'inbound',
   'ben-24@harbor-24.invalid', 'check-db 24 Ben writes in', 'Hi.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: a known contact with no company yet is filed under the company his address belongs to',
       'check-db 24 Ben · check-db 24 Harbor',
       coalesce(c.full_name, 'no contact') || ' · ' || coalesce(co.name, 'no company'),
       c.id = '24a00000-0000-4000-a000-000000000012' and co.id = '24a00000-0000-4000-a000-000000000002'
from public.mail_threads t
left join public.crm_contacts c on c.id = t.contact_id
left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000103';

insert into results(name, expected, actual, pass)
select 'DOMAIN: Ben''s own contact row is not changed — only the thread is filled', 'still no company',
       case when company_id is null then 'still no company' else 'given a company' end,
       company_id is null
from public.crm_contacts where id = '24a00000-0000-4000-a000-000000000012';

-- T4: Ana, whose own address already names her company — unchanged from
-- 0025's original behaviour (regression check).
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000104', '24a00000-0000-4000-a000-000000000021', 'thr-24-4', 'check-db 24 Ana writes in');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000114', '24a00000-0000-4000-a000-000000000104', 'msg-24-4', 'inbound',
   'ana-24@northline-24.invalid', 'check-db 24 Ana writes in', 'Hi.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: a contact whose own address already names her company is unaffected',
       'check-db 24 Ana · check-db 24 Northline',
       coalesce(c.full_name, 'no contact') || ' · ' || coalesce(co.name, 'no company'),
       c.id = '24a00000-0000-4000-a000-000000000011' and co.id = '24a00000-0000-4000-a000-000000000001'
from public.mail_threads t
left join public.crm_contacts c on c.id = t.contact_id
left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000104';

-- T5: an address that names neither a contact nor a company's domain.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000105', '24a00000-0000-4000-a000-000000000021', 'thr-24-5', 'check-db 24 nobody');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000115', '24a00000-0000-4000-a000-000000000105', 'msg-24-5', 'inbound',
   'nobody-24@nowhere-24.invalid', 'check-db 24 nobody', 'Hi.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: an address that matches no contact and no company''s domain links neither', 'no contact · no company',
       coalesce(c.full_name, 'no contact') || ' · ' || coalesce(co.name, 'no company'),
       t.contact_id is null and t.company_id is null
from public.mail_threads t
left join public.crm_contacts c on c.id = t.contact_id
left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000105';

-- T6: a thread a human already filed under Harbor — a stranger at
-- Northline's domain writing into it must not move it.
insert into public.mail_threads (id, connection_id, external_id, subject, company_id) values
  ('24a00000-0000-4000-a000-000000000106', '24a00000-0000-4000-a000-000000000021', 'thr-24-6', 'check-db 24 already filed',
   '24a00000-0000-4000-a000-000000000002');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000116', '24a00000-0000-4000-a000-000000000106', 'msg-24-6', 'inbound',
   'third-24@northline-24.invalid', 'check-db 24 already filed', 'Hi.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: a company a human already put on the thread is not moved by a stranger''s domain',
       'check-db 24 Harbor', coalesce(co.name, 'no company'), co.id = '24a00000-0000-4000-a000-000000000002'
from public.mail_threads t left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000106';

-- T7: outbound only — what we send is not a signal about whose company wrote in.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000107', '24a00000-0000-4000-a000-000000000021', 'thr-24-7', 'check-db 24 outbound only');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000117', '24a00000-0000-4000-a000-000000000107', 'msg-24-7', 'outbound',
   'fourth-24@northline-24.invalid', 'check-db 24 outbound only', 'Hi.', now(), 'sent');

insert into results(name, expected, actual, pass)
select 'DOMAIN: an outbound message at a company''s domain does not file the thread under it', 'no company',
       coalesce(co.name, 'no company'), co.id is null
from public.mail_threads t left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000107';

-- T8: no from_email at all — the original guard, unaffected.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('24a00000-0000-4000-a000-000000000108', '24a00000-0000-4000-a000-000000000021', 'thr-24-8', 'check-db 24 no address');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('24a00000-0000-4000-a000-000000000118', '24a00000-0000-4000-a000-000000000108', 'msg-24-8', 'inbound',
   null, 'check-db 24 no address', 'Hi.', now(), 'inbox');

insert into results(name, expected, actual, pass)
select 'DOMAIN: a message with no from_email is not matched, and does not error', 'no company',
       coalesce(co.name, 'no company'), co.id is null
from public.mail_threads t left join public.crm_companies co on co.id = t.company_id
where t.id = '24a00000-0000-4000-a000-000000000108';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
