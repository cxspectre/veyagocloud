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

-- 0038: a sent copy carries its Message-ID, Bcc and priority, and priority is
-- only ever what Graph has.
insert into public.mail_messages (thread_id, external_id, direction, from_email, to_emails, bcc_emails,
                                  subject, body_text, sent_at, internet_message_id, importance, has_attachments)
select id, 'msg-sent-1', 'outbound', 'sync.fixture@example.invalid', array['person@sync-fixture.invalid'],
       array['boss@example.invalid'], 'Re: A few thoughts', 'Thanks!', now(), '<sent-1@example.invalid>', 'high', true
from public.mail_threads where external_id = 'thr-1'
on conflict (thread_id, external_id) do update set importance = excluded.importance;

insert into results(name, expected, actual, pass)
select 'a sent copy keeps its Message-ID, priority and Bcc',
       '<sent-1@example.invalid> · high · boss@example.invalid',
       internet_message_id || ' · ' || importance || ' · ' || array_to_string(bcc_emails, ','),
       internet_message_id = '<sent-1@example.invalid>' and importance = 'high'
         and bcc_emails = array['boss@example.invalid']
from public.mail_messages where external_id = 'msg-sent-1';

do $$
begin
  update public.mail_messages set importance = 'urgent' where external_id = 'msg-sent-1';
  insert into results(name, expected, actual, pass)
  values ('priority refuses a value Graph does not have', 'rejected', 'ACCEPTED', false);
exception when check_violation then
  insert into results(name, expected, actual, pass)
  values ('priority refuses a value Graph does not have', 'rejected', 'rejected', true);
end $$;

-- 0038: store_mail_batch — the one way every sync, and send-mail, stores mail.
-- A question arrives in the inbox (unread, flagged), then our reply is found in
-- Sent. The thread's state is derived from every stored message, atomically.
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'inbox', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-in-1', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-in-1@sync-fixture.invalid>',
  'direction', 'inbound', 'from_name', 'Sync Fixture Person', 'from_email', 'person@sync-fixture.invalid',
  'to_emails', jsonb_build_array('sync.fixture@example.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Batch question', 'body_text', 'Is it ready?', 'body_html', '', 'snippet', 'Is it ready?',
  'sent_at', (now() - interval '2 hours')::text, 'is_read', false, 'is_flagged', true,
  'importance', 'normal', 'has_attachments', false)));

select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'sent', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-out-1', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-out-1@sync-fixture.invalid>',
  'direction', 'outbound', 'from_name', 'Sync Fixture', 'from_email', 'sync.fixture@example.invalid',
  'to_emails', jsonb_build_array('person@sync-fixture.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Re: Batch question', 'body_text', 'It is.', 'body_html', '', 'snippet', 'It is.',
  'sent_at', (now() - interval '1 hour')::text, 'is_read', true, 'is_flagged', false,
  'importance', 'high', 'has_attachments', false)));

insert into results(name, expected, actual, pass)
select 'our reply found in Sent keeps the conversation in the inbox', 'inbox', folder, folder = 'inbox'
from public.mail_threads where connection_id = '55555555-5555-5555-5555-555555555555' and external_id = 'conv-b';

insert into results(name, expected, actual, pass)
select 'a conversation stays unread while mail from outside in it is', 'unread',
       case when is_read then 'read' else 'unread' end, not is_read
from public.mail_threads where connection_id = '55555555-5555-5555-5555-555555555555' and external_id = 'conv-b';

insert into results(name, expected, actual, pass)
select 'starred follows any flagged message, not just the newest', 'starred',
       case when is_starred then 'starred' else 'not starred' end, is_starred
from public.mail_threads where connection_id = '55555555-5555-5555-5555-555555555555' and external_id = 'conv-b';

insert into results(name, expected, actual, pass)
select 'the preview follows the newest message', 'It is.', snippet, snippet = 'It is.'
from public.mail_threads where connection_id = '55555555-5555-5555-5555-555555555555' and external_id = 'conv-b';

-- Outlook marks the question read and unflagged; the same batch arrives twice.
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'inbox', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-in-1', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-in-1@sync-fixture.invalid>',
  'direction', 'inbound', 'from_name', 'Sync Fixture Person', 'from_email', 'person@sync-fixture.invalid',
  'to_emails', jsonb_build_array('sync.fixture@example.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Batch question', 'body_text', 'Is it ready?', 'body_html', '', 'snippet', 'Is it ready?',
  'sent_at', (now() - interval '2 hours')::text, 'is_read', true, 'is_flagged', false,
  'importance', 'normal', 'has_attachments', false)))
from generate_series(1, 2);

insert into results(name, expected, actual, pass)
select 'read and unflagged in Outlook reads and unstars here; a repeat adds nothing', 'read · not starred · 2',
       case when t.is_read then 'read' else 'unread' end || ' · '
         || case when t.is_starred then 'starred' else 'not starred' end || ' · '
         || (select count(*) from public.mail_messages m where m.thread_id = t.id)::text,
       t.is_read and not t.is_starred and (select count(*) from public.mail_messages m where m.thread_id = t.id) = 2
from public.mail_threads t
where t.connection_id = '55555555-5555-5555-5555-555555555555' and t.external_id = 'conv-b';

-- The question moves folder in Outlook and comes back with a new Graph id: the
-- same message by its Message-ID, so re-pointed rather than stored twice.
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'inbox', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-in-1-moved', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-in-1@sync-fixture.invalid>',
  'direction', 'inbound', 'from_name', 'Sync Fixture Person', 'from_email', 'person@sync-fixture.invalid',
  'to_emails', jsonb_build_array('sync.fixture@example.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Batch question', 'body_text', 'Is it ready?', 'body_html', '', 'snippet', 'Is it ready?',
  'sent_at', (now() - interval '2 hours')::text, 'is_read', true, 'is_flagged', false,
  'importance', 'normal', 'has_attachments', false)));

insert into results(name, expected, actual, pass)
select 'a message with a new Graph id is re-pointed, not duplicated', '2 · b-in-1-moved',
       count(*)::text || ' · ' || coalesce(max(m.external_id) filter (where m.direction = 'inbound'), 'none'),
       count(*) = 2 and max(m.external_id) filter (where m.direction = 'inbound') = 'b-in-1-moved'
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id = '55555555-5555-5555-5555-555555555555' and t.external_id = 'conv-b';

-- A conversation first seen in Sent is filed as sent; an archive sync does not
-- pull a conversation with mail from outside out of the inbox.
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'sent', jsonb_build_array(jsonb_build_object(
  'external_id', 'c-out-1', 'thread_external_id', 'conv-c', 'internet_message_id', '<c-out-1@sync-fixture.invalid>',
  'direction', 'outbound', 'from_name', 'Sync Fixture', 'from_email', 'sync.fixture@example.invalid',
  'to_emails', jsonb_build_array('person@sync-fixture.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'An introduction', 'body_text', 'Hello.', 'body_html', '', 'snippet', 'Hello.',
  'sent_at', now()::text, 'is_read', true, 'is_flagged', false, 'importance', 'normal', 'has_attachments', false)));
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'archive', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-in-1-moved', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-in-1@sync-fixture.invalid>',
  'direction', 'inbound', 'from_name', 'Sync Fixture Person', 'from_email', 'person@sync-fixture.invalid',
  'to_emails', jsonb_build_array('sync.fixture@example.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Batch question', 'body_text', 'Is it ready?', 'body_html', '', 'snippet', 'Is it ready?',
  'sent_at', (now() - interval '2 hours')::text, 'is_read', true, 'is_flagged', false,
  'importance', 'normal', 'has_attachments', false)));

-- The question is archived in Outlook and comes back from an archive sync under
-- yet another Graph id: the same message by Message-ID, re-pointed — not stored,
-- nor routed to its ticket, a second time.
select public.store_mail_batch('55555555-5555-5555-5555-555555555555', 'archive', jsonb_build_array(jsonb_build_object(
  'external_id', 'b-in-1-archived', 'thread_external_id', 'conv-b', 'internet_message_id', '<b-in-1@sync-fixture.invalid>',
  'direction', 'inbound', 'from_name', 'Sync Fixture Person', 'from_email', 'person@sync-fixture.invalid',
  'to_emails', jsonb_build_array('sync.fixture@example.invalid'), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
  'subject', 'Batch question', 'body_text', 'Is it ready?', 'body_html', '', 'snippet', 'Is it ready?',
  'sent_at', (now() - interval '2 hours')::text, 'is_read', true, 'is_flagged', false,
  'importance', 'normal', 'has_attachments', false)));

insert into results(name, expected, actual, pass)
select 'an archived message is the same message, not a second one', '2 · b-in-1-archived',
       count(*)::text || ' · ' || coalesce(max(m.external_id) filter (where m.direction = 'inbound'), 'none'),
       count(*) = 2 and max(m.external_id) filter (where m.direction = 'inbound') = 'b-in-1-archived'
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id = '55555555-5555-5555-5555-555555555555' and t.external_id = 'conv-b';

insert into results(name, expected, actual, pass)
select 'first seen in Sent is filed as sent; archive does not empty the inbox', 'sent · inbox',
       max(folder) filter (where external_id = 'conv-c') || ' · ' || max(folder) filter (where external_id = 'conv-b'),
       max(folder) filter (where external_id = 'conv-c') = 'sent' and max(folder) filter (where external_id = 'conv-b') = 'inbox'
from public.mail_threads where connection_id = '55555555-5555-5555-5555-555555555555';

-- The ON CONFLICT target compose uses for a signature — including the
-- "every mailbox" row, whose connection_id is null. With a plain unique
-- constraint two nulls never collide and the second write would insert.
insert into public.mail_signatures (employee_id, connection_id, html)
select id, null, '<p>First</p>' from public.employees
where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
on conflict (employee_id, connection_id) do update set html = excluded.html;
insert into public.mail_signatures (employee_id, connection_id, html)
select id, null, '<p>Second</p>' from public.employees
where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'
on conflict (employee_id, connection_id) do update set html = excluded.html;

insert into results(name, expected, actual, pass)
select 'a signature for every mailbox updates in place', '1 · <p>Second</p>',
       count(*)::text || ' · ' || coalesce(max(html), ''), count(*) = 1 and max(html) = '<p>Second</p>'
from public.mail_signatures where html in ('<p>First</p>', '<p>Second</p>');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
