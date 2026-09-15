-- 11-ticket-routing.sql — a ticket and its mail stay together (0046).
--
-- A customer's reply puts a ticket waiting on them back in the queue as open,
-- leaves one in progress as it is, and reopens one resolved or closed, as
-- before. A deleted ticket is out of the loop: a reply in a conversation
-- attached to one, or naming one in its subject, is not filed on it and does
-- not reopen it, while a conversation attached to one follows the live ticket
-- its next reply names; routing opens no ticket. "Create ticket" on a
-- conversation whose ticket was deleted opens a new one and carries the whole
-- conversation into it — the deleted ticket keeps its own copy — and the
-- customer's next reply lands there. A reference too big to be any ticket's
-- number names none: the reply stays mail, rather than failing to route. So
-- does "#VYG-0", which is nothing once its zeros are read off, while a number
-- padded with zeros past ten digits still names its ticket.
-- Opening a ticket stays for staff, from a mailbox they can read; routing stays
-- the sync's.
--
-- NOTE ON STRUCTURE, as in 04: route_mail_to_ticket() and
-- create_ticket_from_thread() are always called in their own statement before
-- anything asserts on them. A subquery in the same statement reads the snapshot
-- from before the call and cannot see what it wrote. Mail is stored and routed
-- as the table owner, the way the sync does; the OWNER opens tickets, at aal2.
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

-- A customer's message, stored the way the sync stores one, under its
-- conversation's subject unless it says otherwise.
create function pg_temp.customer_writes(p_id uuid, p_thread uuid, p_body text, p_minutes int, p_subject text default null)
returns void
language sql
as $$
  insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder)
  select p_id, t.id, 'check-11-' || p_id, 'inbound', 'customer@check-11.invalid',
         coalesce(p_subject, t.subject), p_body, now() - make_interval(mins => p_minutes), 'inbox'
  from public.mail_threads t
  where t.id = p_thread;
$$;

-- A ticket's reference, as 0033 writes it into the subject of our replies.
create function pg_temp.ref(p_ticket uuid)
returns text
language sql
as $$
  select '[#VYG-' || number || ']' from public.support_tickets where id = p_ticket;
$$;

-- Where a stored message was filed: on the ticket given, on another, or on
-- none. The ticket is compared as text, so one that was never opened reads as
-- a failed check rather than ending the suite.
create function pg_temp.filed(p_message uuid, p_ticket text)
returns text
language sql
as $$
  select case
    when not exists (select 1 from public.ticket_messages where mail_message_id = p_message) then 'on no ticket'
    when exists (select 1 from public.ticket_messages
                 where mail_message_id = p_message and ticket_id::text = p_ticket) then 'on the ticket'
    else 'on another ticket'
  end;
$$;

grant execute on function pg_temp.refused(text, text, text) to authenticated, anon;
grant execute on function pg_temp.affects(text, text, int) to authenticated, anon;
grant execute on function pg_temp.filed(uuid, text) to authenticated, anon;

-- Fixtures, as the table owner. Tickets: W (…11) waits on the customer; D (…12)
-- is deleted once two conversations have reached it; L (…13) is live.
-- Conversations in the studio's mailbox: with W (…21), with D (…22 and …23), and
-- one that only names D (…24). One more (…25) is in the assistant's own mailbox;
-- in …26 the customer quotes numbers too big to be a ticket's, and in the last
-- (…27) a number of nothing but zeros, and L's padded with zeros.
insert into public.crm_companies (id, name, domain) values
  ('11a00000-0000-4000-a000-000000000001', 'check-11 Co', 'check-11.invalid');
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('11a00000-0000-4000-a000-000000000002', '11a00000-0000-4000-a000-000000000001',
   'check-11 Customer', 'customer@check-11.invalid');
insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('11a00000-0000-4000-a000-000000000003', 'microsoft_mail', 'check-11@example.invalid', null, 'connected'),
  ('11a00000-0000-4000-a000-000000000004', 'microsoft_mail', 'check-11-assistant@example.invalid',
   (select id from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), 'connected');

insert into public.support_tickets (id, subject, contact_id, status) values
  ('11a00000-0000-4000-a000-000000000011', 'check-11 Waiting on the customer',
   '11a00000-0000-4000-a000-000000000002', 'waiting'),
  ('11a00000-0000-4000-a000-000000000012', 'check-11 Deleted later',
   '11a00000-0000-4000-a000-000000000002', 'open'),
  ('11a00000-0000-4000-a000-000000000013', 'check-11 Live',
   '11a00000-0000-4000-a000-000000000002', 'open');

insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('11a00000-0000-4000-a000-000000000021', '11a00000-0000-4000-a000-000000000003', 'check-11-waiting',
   'Re: check-11 Waiting on the customer ' || pg_temp.ref('11a00000-0000-4000-a000-000000000011')),
  ('11a00000-0000-4000-a000-000000000022', '11a00000-0000-4000-a000-000000000003', 'check-11-deleted',
   'Re: check-11 Deleted later ' || pg_temp.ref('11a00000-0000-4000-a000-000000000012')),
  ('11a00000-0000-4000-a000-000000000023', '11a00000-0000-4000-a000-000000000003', 'check-11-moved-on',
   'Re: check-11 Deleted later ' || pg_temp.ref('11a00000-0000-4000-a000-000000000012')),
  ('11a00000-0000-4000-a000-000000000024', '11a00000-0000-4000-a000-000000000003', 'check-11-names-deleted',
   'check-11 About ' || pg_temp.ref('11a00000-0000-4000-a000-000000000012')),
  ('11a00000-0000-4000-a000-000000000025', '11a00000-0000-4000-a000-000000000004', 'check-11-personal',
   'check-11 In the assistant''s own mailbox'),
  ('11a00000-0000-4000-a000-000000000026', '11a00000-0000-4000-a000-000000000003', 'check-11-too-big',
   'check-11 Where is my order?'),
  ('11a00000-0000-4000-a000-000000000027', '11a00000-0000-4000-a000-000000000003', 'check-11-zeros',
   'check-11 About my invoice');

-- Counted by this suite's subjects, not the whole table: the live project has
-- real tickets, and people may open one while this runs.
select set_config('test.tickets_before',
  (select count(*) from public.support_tickets where subject like '%check-11%')::text, true);

-- ── W: the customer writes while we wait on them ─────────────────────────
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000031', '11a00000-0000-4000-a000-000000000021',
  'check-11 Here is what you asked for.', 50);

-- Its own statement. See the note above.
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000031') as routed_to;

insert into results(name, expected, actual, pass)
select 'WAITING: a customer''s reply puts the ticket back in the queue as open', 'on the ticket · open',
       pg_temp.filed('11a00000-0000-4000-a000-000000000031', t.id::text) || ' · ' || t.status,
       pg_temp.filed('11a00000-0000-4000-a000-000000000031', t.id::text) = 'on the ticket' and t.status = 'open'
from public.support_tickets t where t.id = '11a00000-0000-4000-a000-000000000011';

-- Someone picks it up, and the customer writes again.
update public.support_tickets set status = 'in_progress' where id = '11a00000-0000-4000-a000-000000000011';
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000032', '11a00000-0000-4000-a000-000000000021',
  'check-11 One more thing.', 40);
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000032') as routed_to;

insert into results(name, expected, actual, pass)
select 'IN PROGRESS: stays in progress — someone is already on it', 'on the ticket · in_progress',
       pg_temp.filed('11a00000-0000-4000-a000-000000000032', t.id::text) || ' · ' || t.status,
       pg_temp.filed('11a00000-0000-4000-a000-000000000032', t.id::text) = 'on the ticket' and t.status = 'in_progress'
from public.support_tickets t where t.id = '11a00000-0000-4000-a000-000000000011';

-- Resolved, and the customer writes again.
update public.support_tickets set status = 'resolved' where id = '11a00000-0000-4000-a000-000000000011';
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000033', '11a00000-0000-4000-a000-000000000021',
  'check-11 It broke again.', 30);
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000033') as routed_to;

insert into results(name, expected, actual, pass)
select 'RESOLVED: reopened, as before', 'on the ticket · open',
       pg_temp.filed('11a00000-0000-4000-a000-000000000033', t.id::text) || ' · ' || t.status,
       pg_temp.filed('11a00000-0000-4000-a000-000000000033', t.id::text) = 'on the ticket' and t.status = 'open'
from public.support_tickets t where t.id = '11a00000-0000-4000-a000-000000000011';

-- Closed, and the customer writes again.
update public.support_tickets set status = 'closed' where id = '11a00000-0000-4000-a000-000000000011';
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000034', '11a00000-0000-4000-a000-000000000021',
  'check-11 And again.', 20);
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000034') as routed_to;

insert into results(name, expected, actual, pass)
select 'CLOSED: reopened, as before — routing opens no follow-up ticket, so a closed one left closed would hide the reply',
       'on the ticket · open',
       pg_temp.filed('11a00000-0000-4000-a000-000000000034', t.id::text) || ' · ' || t.status,
       pg_temp.filed('11a00000-0000-4000-a000-000000000034', t.id::text) = 'on the ticket' and t.status = 'open'
from public.support_tickets t where t.id = '11a00000-0000-4000-a000-000000000011';

-- ── D: two conversations reach it while it is live; then it is deleted ───
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000041', '11a00000-0000-4000-a000-000000000022',
  'check-11 The first words.', 60);
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000042', '11a00000-0000-4000-a000-000000000023',
  'check-11 Another conversation about it.', 58);
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000041') as routed_to;
select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000042') as routed_to;

insert into results(name, expected, actual, pass)
select 'BEFORE: both conversations reached D while it was live, so nothing below passes by routing nothing',
       'on the ticket · on the ticket',
       pg_temp.filed('11a00000-0000-4000-a000-000000000041', '11a00000-0000-4000-a000-000000000012') || ' · ' ||
         pg_temp.filed('11a00000-0000-4000-a000-000000000042', '11a00000-0000-4000-a000-000000000012'),
       pg_temp.filed('11a00000-0000-4000-a000-000000000041', '11a00000-0000-4000-a000-000000000012') = 'on the ticket'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000042', '11a00000-0000-4000-a000-000000000012') = 'on the ticket';

update public.support_tickets set status = 'resolved', deleted_at = now()
where id = '11a00000-0000-4000-a000-000000000012';

-- The customer replies in D's first conversation, still quoting D; someone
-- writes naming D in a conversation of its own; and D's second conversation
-- carries on about L.
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000043', '11a00000-0000-4000-a000-000000000022',
  'check-11 Still there?', 45);
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000044', '11a00000-0000-4000-a000-000000000024',
  'check-11 Quoting an old reference.', 44);
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000045', '11a00000-0000-4000-a000-000000000023',
  'check-11 About the live one now.', 43,
  'Re: check-11 Live ' || pg_temp.ref('11a00000-0000-4000-a000-000000000013'));

select set_config('test.routed_43', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000043')::text, 'null'), true);
select set_config('test.routed_44', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000044')::text, 'null'), true);
select set_config('test.routed_45', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000045')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'DELETED: a reply in a conversation attached to a deleted ticket is not filed on it', 'null · on no ticket',
       current_setting('test.routed_43') || ' · ' ||
         pg_temp.filed('11a00000-0000-4000-a000-000000000043', '11a00000-0000-4000-a000-000000000012'),
       current_setting('test.routed_43') = 'null'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000043', '11a00000-0000-4000-a000-000000000012') = 'on no ticket';

insert into results(name, expected, actual, pass)
select 'DELETED: nor does it reopen the ticket, which stays resolved and deleted', 'resolved · deleted',
       status || ' · ' || case when deleted_at is null then 'live' else 'deleted' end,
       status = 'resolved' and deleted_at is not null
from public.support_tickets where id = '11a00000-0000-4000-a000-000000000012';

insert into results(name, expected, actual, pass)
select 'DELETED: nor is a reply that names a deleted ticket in its subject', 'null · on no ticket',
       current_setting('test.routed_44') || ' · ' ||
         pg_temp.filed('11a00000-0000-4000-a000-000000000044', '11a00000-0000-4000-a000-000000000012'),
       current_setting('test.routed_44') = 'null'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000044', '11a00000-0000-4000-a000-000000000012') = 'on no ticket';

insert into results(name, expected, actual, pass)
select 'DELETED: a conversation attached to one follows the live ticket its reply names, and moves to it',
       'on the ticket · conversation on it',
       pg_temp.filed('11a00000-0000-4000-a000-000000000045', '11a00000-0000-4000-a000-000000000013') ||
         ' · conversation on ' ||
         case when t.ticket_id = '11a00000-0000-4000-a000-000000000013' then 'it'
              when t.ticket_id = '11a00000-0000-4000-a000-000000000012' then 'the deleted ticket'
              else coalesce(t.ticket_id::text, 'nothing') end,
       current_setting('test.routed_45') = '11a00000-0000-4000-a000-000000000013'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000045', '11a00000-0000-4000-a000-000000000013') = 'on the ticket'
         and t.ticket_id = '11a00000-0000-4000-a000-000000000013'
from public.mail_threads t where t.id = '11a00000-0000-4000-a000-000000000023';

-- ── A number no ticket can have ──────────────────────────────────────────
-- A reference too big to be a ticket's number — past an integer, or past a
-- bigint — is no reference: routing finds no ticket rather than failing, which
-- store_mail_batch would only log, leaving the reply unrouted. Each call goes
-- through pg_temp.affects(), so a failure is a named FAIL, not the end of the
-- suite.
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000047', '11a00000-0000-4000-a000-000000000026',
  'check-11 Where is my order?', 42, 'Re: check-11 Order [#VYG-99999999999]');
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000048', '11a00000-0000-4000-a000-000000000026',
  'check-11 Still waiting.', 41, 'Re: check-11 Order [#VYG-' || repeat('9', 30) || ']');

select set_config('test.routed_47', 'not routed', true);
select pg_temp.affects('TOO BIG: routing a reply that quotes #VYG-99999999999 goes through', $sql$
  select set_config('test.routed_47', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000047')::text, 'null'), true)
$sql$, 1);
select set_config('test.routed_48', 'not routed', true);
select pg_temp.affects('TOO BIG: and one that quotes a number past a bigint', $sql$
  select set_config('test.routed_48', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000048')::text, 'null'), true)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'TOO BIG: neither finds a ticket, and both replies stay mail', 'null · on no ticket · null · on no ticket',
       current_setting('test.routed_47') || ' · ' || pg_temp.filed('11a00000-0000-4000-a000-000000000047', 'none')
         || ' · ' || current_setting('test.routed_48') || ' · ' || pg_temp.filed('11a00000-0000-4000-a000-000000000048', 'none'),
       current_setting('test.routed_47') = 'null' and current_setting('test.routed_48') = 'null'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000047', 'none') = 'on no ticket'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000048', 'none') = 'on no ticket';

-- The two edges of reading the reference as text, in a conversation of their own
-- (…27), so the link routing writes there changes nothing above. "#VYG-0" is
-- nothing once its zeros are read off: no number to cast, so no ticket, and no
-- failure. L's number padded with zeros to twelve digits is still L's number,
-- routed to L as it was before 0046. The zeros go first: once the padded
-- reference has attached the conversation to L, a later reply in it would
-- follow that link.
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000049', '11a00000-0000-4000-a000-000000000027',
  'check-11 Is this about ticket zero?', 39, 'Re: check-11 Invoice [#VYG-0]');
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000050', '11a00000-0000-4000-a000-000000000027',
  'check-11 About the live one, padded.', 38,
  'Re: check-11 Live [#VYG-' || (select lpad(number::text, 12, '0') from public.support_tickets
                                  where id = '11a00000-0000-4000-a000-000000000013') || ']');

select set_config('test.routed_49', 'not routed', true);
select pg_temp.affects('ZEROS: routing a reply that quotes #VYG-0 goes through', $sql$
  select set_config('test.routed_49', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000049')::text, 'null'), true)
$sql$, 1);
select set_config('test.routed_50', 'not routed', true);
select pg_temp.affects('ZEROS: and one that quotes L''s number padded with zeros to twelve digits', $sql$
  select set_config('test.routed_50', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000050')::text, 'null'), true)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'ZEROS: #VYG-0 names no ticket, and the reply stays mail', 'null · on no ticket',
       current_setting('test.routed_49') || ' · ' || pg_temp.filed('11a00000-0000-4000-a000-000000000049', 'none'),
       current_setting('test.routed_49') = 'null'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000049', 'none') = 'on no ticket';

insert into results(name, expected, actual, pass)
select 'ZEROS: a number padded with zeros past ten digits still names its ticket: the reply lands on L',
       'L · on the ticket',
       case when current_setting('test.routed_50') = '11a00000-0000-4000-a000-000000000013' then 'L'
            else current_setting('test.routed_50') end
         || ' · ' || pg_temp.filed('11a00000-0000-4000-a000-000000000050', '11a00000-0000-4000-a000-000000000013'),
       current_setting('test.routed_50') = '11a00000-0000-4000-a000-000000000013'
         and pg_temp.filed('11a00000-0000-4000-a000-000000000050', '11a00000-0000-4000-a000-000000000013') = 'on the ticket';

insert into results(name, expected, actual, pass)
select 'ROUTING: opens no ticket', current_setting('test.tickets_before') || ' tickets',
       count(*) || ' tickets', count(*) = current_setting('test.tickets_before')::int
from public.support_tickets where subject like '%check-11%';

-- ── "Create ticket" on D's first conversation ────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select set_config('test.opened', 'none', true);
select pg_temp.affects('CREATE: "Create ticket" on a conversation whose ticket was deleted goes through', $sql$
  select set_config('test.opened', public.create_ticket_from_thread('11a00000-0000-4000-a000-000000000022')::text, true)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CREATE: it opens a new ticket, live, rather than handing back the deleted one', 'a new live ticket',
       case when current_setting('test.opened') = '11a00000-0000-4000-a000-000000000012' then 'the deleted ticket'
            when t.id is null then 'no ticket'
            when t.deleted_at is not null then 'a deleted ticket'
            else 'a new live ticket' end,
       current_setting('test.opened') <> '11a00000-0000-4000-a000-000000000012'
         and t.id is not null and t.deleted_at is null
from (select 1) one
left join public.support_tickets t on t.id::text = current_setting('test.opened');

insert into results(name, expected, actual, pass)
select 'CREATE: the conversation points at the new ticket', 'the new ticket',
       case when t.ticket_id::text = current_setting('test.opened')
                 and current_setting('test.opened') <> '11a00000-0000-4000-a000-000000000012' then 'the new ticket'
            when t.ticket_id = '11a00000-0000-4000-a000-000000000012' then 'the deleted ticket'
            else coalesce(t.ticket_id::text, 'no ticket') end,
       t.ticket_id::text = current_setting('test.opened')
         and current_setting('test.opened') <> '11a00000-0000-4000-a000-000000000012'
from public.mail_threads t where t.id = '11a00000-0000-4000-a000-000000000022';

insert into results(name, expected, actual, pass)
select 'CREATE: the whole conversation comes along — the reply D held, and the one D was not given',
       'on the ticket · on the ticket',
       case when current_setting('test.opened') = '11a00000-0000-4000-a000-000000000012'
            then 'the deleted ticket was handed back' else a.f || ' · ' || b.f end,
       a.f = 'on the ticket' and b.f = 'on the ticket'
         and current_setting('test.opened') <> '11a00000-0000-4000-a000-000000000012'
from (select pg_temp.filed('11a00000-0000-4000-a000-000000000041', current_setting('test.opened')) as f) a,
     (select pg_temp.filed('11a00000-0000-4000-a000-000000000043', current_setting('test.opened')) as f) b;

insert into results(name, expected, actual, pass)
select 'CREATE: the deleted ticket keeps its own copy of what it held, should it be restored', '1 copy · deleted',
       c.n || ' copy · ' || case when t.deleted_at is null then 'live' else 'deleted' end,
       c.n = 1 and t.deleted_at is not null
from public.support_tickets t,
     (select count(*) as n from public.ticket_messages
      where ticket_id = '11a00000-0000-4000-a000-000000000012' and body = 'check-11 The first words.') c
where t.id = '11a00000-0000-4000-a000-000000000012';

select set_config('test.again', 'none', true);
select pg_temp.affects('CREATE: asking again goes through', $sql$
  select set_config('test.again', public.create_ticket_from_thread('11a00000-0000-4000-a000-000000000022')::text, true)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CREATE: and hands back the same ticket, opening no other', 'the same ticket · 1 new',
       case when current_setting('test.again') = current_setting('test.opened') then 'the same ticket'
            else 'another ticket' end
         || ' · ' || (count(*) - current_setting('test.tickets_before')::int) || ' new',
       current_setting('test.again') = current_setting('test.opened')
         and count(*) = current_setting('test.tickets_before')::int + 1
from public.support_tickets where subject like '%check-11%';

select pg_temp.refused('CREATE: not from a conversation in a colleague''s own mailbox', $sql$
  select public.create_ticket_from_thread('11a00000-0000-4000-a000-000000000025')
$sql$, 'not yours to open');

select pg_temp.refused('GRANTS: a signed-in person cannot route mail onto a ticket', $sql$
  select public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000044')
$sql$, 'permission denied');

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"11a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('CREATE: staff only', $sql$
  select public.create_ticket_from_thread('11a00000-0000-4000-a000-000000000024')
$sql$, 'Staff only');

-- ── Anon ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select pg_temp.refused('GRANTS: anon cannot open a ticket from a conversation', $sql$
  select public.create_ticket_from_thread('11a00000-0000-4000-a000-000000000024')
$sql$, 'permission denied');

reset role;

-- ── The customer writes again in D's first conversation, still quoting D ─
select pg_temp.customer_writes('11a00000-0000-4000-a000-000000000046', '11a00000-0000-4000-a000-000000000022',
  'check-11 Thanks for picking it up.', 5);
select set_config('test.routed_46', coalesce(public.route_mail_to_ticket('11a00000-0000-4000-a000-000000000046')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'AFTER: the customer''s next reply lands on the new ticket, not the deleted one', 'on the new ticket',
       case when current_setting('test.opened') = '11a00000-0000-4000-a000-000000000012' then 'on the deleted ticket'
            when current_setting('test.routed_46') = current_setting('test.opened')
                 and f.f = 'on the ticket' then 'on the new ticket'
            else f.f end,
       current_setting('test.opened') <> '11a00000-0000-4000-a000-000000000012'
         and current_setting('test.routed_46') = current_setting('test.opened')
         and f.f = 'on the ticket'
from (select pg_temp.filed('11a00000-0000-4000-a000-000000000046', current_setting('test.opened')) as f) f;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
