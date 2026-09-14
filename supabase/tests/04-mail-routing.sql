-- 04-mail-routing.sql — a customer's reply finds its way back to the ticket.
--
-- 0033 puts [#VYG-142] in the subject of everything we send; 0035 reads it
-- back out. These checks cover the loop and, just as importantly, the case it
-- must NOT handle: unreferenced mail deliberately does not open a ticket, or
-- the queue becomes a second inbox.
--
-- NOTE ON STRUCTURE: route_mail_to_ticket() is always called in its own
-- statement before anything asserts on it. A subquery in the same statement
-- reads the snapshot from before the call and cannot see the row it inserted —
-- which looks exactly like a routing failure.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);

insert into public.crm_companies (id, name, domain) values
  ('c0000000-0000-4000-a000-000000000001','Route Co','route.invalid');
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('c0000000-0000-4000-a000-000000000002','c0000000-0000-4000-a000-000000000001',
   'Route Person','p@route.invalid');
insert into public.integration_connections (id, provider, account_label, status) values
  ('c0000000-0000-4000-a000-000000000003','imap','routing.fixture@example.invalid','connected');
insert into public.support_tickets (id, subject, contact_id, status) values
  ('c0000000-0000-4000-a000-000000000004','Subscription not restoring',
   'c0000000-0000-4000-a000-000000000002','resolved');

insert into public.mail_threads (id, connection_id, external_id, subject, contact_id) values
  ('c0000000-0000-4000-a000-000000000005','c0000000-0000-4000-a000-000000000003','thr-r',
   'Re: Subscription not restoring [#VYG-' ||
     (select number from public.support_tickets where id='c0000000-0000-4000-a000-000000000004') || ']',
   'c0000000-0000-4000-a000-000000000002');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at) values
  ('c0000000-0000-4000-a000-000000000006','c0000000-0000-4000-a000-000000000005','msg-r','inbound',
   'p@route.invalid',
   (select subject from public.mail_threads where id='c0000000-0000-4000-a000-000000000005'),
   'Still not working, sorry.', now());

-- Its own statement. See the note above.
select public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000006') as routed_to;

insert into results(name, expected, actual, pass)
select 'reply is appended to the referenced ticket', 'on the ticket',
       case when ticket_id='c0000000-0000-4000-a000-000000000004' then 'on the ticket' else 'elsewhere' end,
       ticket_id='c0000000-0000-4000-a000-000000000004' and direction='inbound'
from public.ticket_messages where mail_message_id='c0000000-0000-4000-a000-000000000006';

insert into results(name, expected, actual, pass)
select 'the customer''s words come with it', 'Still not working, sorry.',
       coalesce(body,'nothing'), body='Still not working, sorry.'
from public.ticket_messages where mail_message_id='c0000000-0000-4000-a000-000000000006';

insert into results(name, expected, actual, pass)
select 'it is attributed to the contact, not to us', 'the contact',
       case when author_contact_id='c0000000-0000-4000-a000-000000000002' then 'the contact'
            else 'wrong author' end,
       author_contact_id='c0000000-0000-4000-a000-000000000002' and author_employee_id is null
from public.ticket_messages where mail_message_id='c0000000-0000-4000-a000-000000000006';

insert into results(name, expected, actual, pass)
select 'a reply reopens a resolved ticket', 'open', status, status='open'
from public.support_tickets where id='c0000000-0000-4000-a000-000000000004';

insert into results(name, expected, actual, pass)
select 'the thread is linked to the ticket', 'linked',
       case when ticket_id='c0000000-0000-4000-a000-000000000004' then 'linked' else 'not linked' end,
       ticket_id='c0000000-0000-4000-a000-000000000004'
from public.mail_threads where id='c0000000-0000-4000-a000-000000000005';

-- A second sync over the same message.
select public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000006') as second_run;

insert into results(name, expected, actual, pass)
select 're-syncing does not double the reply', '1', count(*)::text, count(*)=1
from public.ticket_messages where mail_message_id='c0000000-0000-4000-a000-000000000006';

-- Mail with no reference: stays mail.
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('c0000000-0000-4000-a000-000000000007','c0000000-0000-4000-a000-000000000003','thr-n',
   'Your weekly newsletter');
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at) values
  ('c0000000-0000-4000-a000-000000000008','c0000000-0000-4000-a000-000000000007','msg-n','inbound',
   'news@example.invalid','Your weekly newsletter','Ten things about CSS.', now());

-- Counted against what was there before, not against an empty table: the live
-- project has real tickets, and an unscoped count(*) was only ever right on an
-- empty database.
select set_config('fixture.tickets_before', (select count(*) from public.support_tickets)::text, true);

insert into results(name, expected, actual, pass)
select 'unreferenced mail is not routed', 'null',
       coalesce(public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000008')::text,'null'),
       public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000008') is null;

insert into results(name, expected, actual, pass)
select 'and no ticket was opened for it', '0 new',
       (count(*) - current_setting('fixture.tickets_before')::int)::text || ' new',
       count(*) = current_setting('fixture.tickets_before')::int
from public.support_tickets;

-- Our own outbound mail is already in the thread; routing it back would echo.
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at) values
  ('c0000000-0000-4000-a000-000000000009','c0000000-0000-4000-a000-000000000005','msg-o','outbound',
   'fixture.inbox@example.invalid','Re: Subscription not restoring','We are on it.', now());

insert into results(name, expected, actual, pass)
select 'our own sent mail is not echoed back', 'null',
       coalesce(public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000009')::text,'null'),
       public.route_mail_to_ticket('c0000000-0000-4000-a000-000000000009') is null;

-- create_ticket_from_thread: the manual half.
grant all on results to authenticated;
grant usage, select on sequence results_id_seq to authenticated;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated"}',true);

-- Counted as the person, who sees tickets the way the checks below do.
select set_config('fixture.tickets_before_manual', (select count(*) from public.support_tickets)::text, true);

select public.create_ticket_from_thread('c0000000-0000-4000-a000-000000000007','Kept') as opened;

insert into results(name, expected, actual, pass)
select 'a thread can be turned into a ticket by hand', 'opened',
       case when ticket_id is null then 'still none' else 'opened' end, ticket_id is not null
from public.mail_threads where id='c0000000-0000-4000-a000-000000000007';

insert into results(name, expected, actual, pass)
select 'the conversation so far comes with it', '1', count(*)::text, count(*)=1
from public.ticket_messages where mail_message_id='c0000000-0000-4000-a000-000000000008';

select public.create_ticket_from_thread('c0000000-0000-4000-a000-000000000007') as again;
insert into results(name, expected, actual, pass)
select 'doing it twice does not open a second ticket', '1 new',
       (count(*) - current_setting('fixture.tickets_before_manual')::int)::text || ' new',
       count(*) = current_setting('fixture.tickets_before_manual')::int + 1
from public.support_tickets;

reset role;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
