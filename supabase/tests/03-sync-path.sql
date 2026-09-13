-- 03-sync-path.sql — the write path the Edge Functions take.
--
-- Every ON CONFLICT target here is one a sync function names. A unique index
-- built on an expression or with a WHERE clause cannot be an ON CONFLICT
-- target, and the failure only shows up at runtime, on the first real sync —
-- which is exactly how 0024 and 0026 shipped broken and 0028 fixed them.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);

insert into public.crm_companies (id, name, domain) values
  ('11111111-1111-1111-1111-111111111111','Sync Fixture Co','sync-fixture.invalid');
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
   'Sync Fixture Person','person@sync-fixture.invalid');

-- Mixed case on purpose: google-callback stores whatever Google reports.
insert into public.integration_connections (id, provider, account_label, status)
values ('55555555-5555-5555-5555-555555555555','imap','Sync.Fixture@Example.Invalid','connected');

insert into results(name, expected, actual, pass)
select 'account_label normalised on write', 'sync.fixture@example.invalid', account_label,
       account_label = 'sync.fixture@example.invalid'
from public.integration_connections where id='55555555-5555-5555-5555-555555555555';

insert into public.mail_threads (connection_id, external_id, subject, snippet, folder, is_read)
values ('55555555-5555-5555-5555-555555555555','thr-1','A few thoughts on the homepage',
        'The first concept looks great','inbox',false)
on conflict (connection_id, external_id) do update
  set subject = excluded.subject, snippet = excluded.snippet;

insert into public.mail_threads (connection_id, external_id, subject, snippet, folder, is_read)
values ('55555555-5555-5555-5555-555555555555','thr-1','A few thoughts on the homepage',
        'The first concept looks great','inbox',true)
on conflict (connection_id, external_id) do update
  set subject = excluded.subject, is_read = excluded.is_read;

insert into results(name, expected, actual, pass)
select 'thread upsert is idempotent', '1', count(*)::text, count(*) = 1
from public.mail_threads where external_id = 'thr-1';

insert into public.mail_messages (thread_id, external_id, direction, from_name, from_email,
                                  to_emails, subject, body_text, sent_at)
select id,'msg-1','inbound','Sync Fixture Person','person@sync-fixture.invalid',
       array['sync.fixture@example.invalid'],'A few thoughts on the homepage','Hi Cassian, looks great.',now()
from public.mail_threads where external_id='thr-1'
on conflict (thread_id, external_id) do update set body_text = excluded.body_text;

insert into public.mail_messages (thread_id, external_id, direction, from_name, from_email,
                                  to_emails, subject, body_text, sent_at)
select id,'msg-1','inbound','Sync Fixture Person','person@sync-fixture.invalid',
       array['sync.fixture@example.invalid'],'A few thoughts on the homepage','Hi Cassian, looks great. (edited)',now()
from public.mail_threads where external_id='thr-1'
on conflict (thread_id, external_id) do update set body_text = excluded.body_text;

insert into results(name, expected, actual, pass)
select 'message upsert is idempotent', '1', count(*)::text, count(*) = 1
from public.mail_messages where external_id = 'msg-1';

insert into results(name, expected, actual, pass)
select 'trigger counted the thread', '1', message_count::text, message_count = 1
from public.mail_threads where external_id='thr-1';

insert into results(name, expected, actual, pass)
select 'trigger matched the sender to the CRM', 'Sync Fixture Person',
       coalesce((select full_name from public.crm_contacts c where c.id = t.contact_id),'no match'),
       t.contact_id = '22222222-2222-2222-2222-222222222222'
from public.mail_threads t where t.external_id='thr-1';

insert into results(name, expected, actual, pass)
select 'trigger carried the company across', 'Sync Fixture Co',
       coalesce((select name from public.crm_companies c where c.id = t.company_id),'no match'),
       t.company_id = '11111111-1111-1111-1111-111111111111'
from public.mail_threads t where t.external_id='thr-1';

insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at, kind)
values ('55555555-5555-5555-5555-555555555555','primary','ev-1','Northline design review', now(),'client')
on conflict (connection_id, calendar_id, external_id) do update set title = excluded.title;
insert into public.calendar_events (connection_id, calendar_id, external_id, title, starts_at, kind)
values ('55555555-5555-5555-5555-555555555555','primary','ev-1','Northline design review (moved)', now(),'client')
on conflict (connection_id, calendar_id, external_id) do update set title = excluded.title;

insert into results(name, expected, actual, pass)
select 'calendar upsert updates in place', '1 · moved',
       count(*)::text || ' · ' || case when max(title) like '%moved%' then 'moved' else 'stale' end,
       count(*) = 1 and max(title) like '%moved%'
from public.calendar_events where external_id='ev-1';

-- Hand-made events carry a NULL external_id, and NULLs never collide, so any
-- number of them coexist with synced rows on the same key columns.
insert into public.calendar_events (title, starts_at, kind) values ('Local one', now(),'focus');
insert into public.calendar_events (title, starts_at, kind) values ('Local two', now(),'focus');
-- Scoped to this suite's own rows: hand-made events are ordinary content, so
-- counting every one of them would make this check depend on what is seeded.
insert into results(name, expected, actual, pass)
select 'null external_id rows never collide', '2', count(*)::text, count(*) = 2
from public.calendar_events where external_id is null and title like 'Local %';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
