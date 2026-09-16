-- 21-ticket-workflow.sql — the queue a person actually runs support from (0056).
--
-- Five things this checks:
--   1. Opening a ticket from a conversation carries the sender's raw address
--      over even when the CRM has no contact for them.
--   2. A reply sent from Mail or Outlook — not through send-ticket-reply's
--      reply box — is filed on the ticket its conversation is already
--      attached to; one send-ticket-reply already recorded is not duplicated
--      when the sync later sees it (matched on mail_message_id, already
--      linked); a thread with no live ticket to attach to stays mail.
--   3. Response targets: exactly the four priorities, staff read them and a
--      manager alone changes the minutes; a new ticket's first-response and
--      resolve due-by times come from its priority, and moving it to another
--      priority moves them.
--   4. Attachments: staff record one after it is actually uploaded; the
--      uploader or a manager removes it, nobody else; anon reaches none of it.
--   5. email_log accepts the two new kinds this ships (ticket_assigned,
--      ticket_customer_reply).
--
-- NOTE ON STRUCTURE, as in 04, 11 and 19: route_mail_to_ticket() and
-- create_ticket_from_thread() are always called in their own statement before
-- anything asserts on them, so a check reads a settled row rather than a
-- snapshot from before the call. Mail is stored and routed as the table
-- owner, the way the sync does. Everything is rolled back.
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

grant execute on function pg_temp.refused(text, text, text) to authenticated, anon;
grant execute on function pg_temp.affects(text, text, int) to authenticated, anon;

-- ── Fixtures, as the table owner ─────────────────────────────────────────
-- The assistant, inactive in real life, is woken as an employee: staff who is
-- not a manager reads targets and removes their own attachment, but changes
-- neither a target nor someone else's attachment.
update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);
-- What the Storage API turns on for its own deletes (05's own note).
select set_config('storage.allow_delete_query', 'true', true);

insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('21a00000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-21@example.invalid', null, 'connected');

-- A conversation from a sender the CRM has never seen.
insert into public.mail_threads (id, connection_id, external_id, subject, other_party_name, other_party_email) values
  ('21a00000-0000-4000-a000-000000000002', '21a00000-0000-4000-a000-000000000001', 'check-21-new',
   'check-21 A question about billing', 'Check Twentyone Guest', 'guest@check-21.invalid');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

-- Its own statement. See the note above.
select set_config('test.opened',
  public.create_ticket_from_thread('21a00000-0000-4000-a000-000000000002', null)::text, true);

reset role;

insert into results(name, expected, actual, pass)
select 'REQUESTER: a sender the CRM does not know is still kept on the ticket it opens',
       'Check Twentyone Guest · guest@check-21.invalid',
       coalesce(requester_name, '?') || ' · ' || coalesce(requester_email, '?'),
       requester_name = 'Check Twentyone Guest' and requester_email = 'guest@check-21.invalid'
from public.support_tickets where id = current_setting('test.opened')::uuid;

-- ── Response targets ─────────────────────────────────────────────────────

insert into results(name, expected, actual, pass)
select 'TARGETS: exactly the four priorities support_tickets.priority checks against',
       '4', count(*)::text, count(*) = 4
from public.ticket_response_targets
where priority in ('low','normal','high','urgent');

-- A ticket opened above (default priority normal) already has its due-by
-- times, from the target row for 'normal'.
insert into results(name, expected, actual, pass)
select 'DUE BY: a new ticket''s first-response and resolve due-by come from its priority',
       'true · true',
       (first_response_due_at = created_at + make_interval(mins => t.first_response_minutes))::text || ' · ' ||
         (resolve_due_at = created_at + make_interval(mins => t.resolution_minutes))::text,
       first_response_due_at = created_at + make_interval(mins => t.first_response_minutes)
         and resolve_due_at = created_at + make_interval(mins => t.resolution_minutes)
from public.support_tickets st
join public.ticket_response_targets t on t.priority = st.priority
where st.id = current_setting('test.opened')::uuid;

select set_config('test.due_before_urgent',
  (select first_response_due_at::text from public.support_tickets where id = current_setting('test.opened')::uuid), true);

update public.support_tickets set priority = 'urgent' where id = current_setting('test.opened')::uuid;

insert into results(name, expected, actual, pass)
select 'DUE BY: raising the priority both recomputes the due-by from the new target and tightens it, against the same created_at',
       'recomputed · tighter',
       (case when first_response_due_at = created_at + make_interval(mins => t.first_response_minutes)
             then 'recomputed' else 'stale' end)
         || ' · ' || (case when first_response_due_at < current_setting('test.due_before_urgent')::timestamptz
                            then 'tighter' else 'not tighter' end),
       first_response_due_at = created_at + make_interval(mins => t.first_response_minutes)
         and first_response_due_at < current_setting('test.due_before_urgent')::timestamptz
from public.support_tickets st
join public.ticket_response_targets t on t.priority = st.priority
where st.id = current_setting('test.opened')::uuid;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('TARGETS: staff who is not a manager cannot change a target', $sql$
  update public.ticket_response_targets set first_response_minutes = 1 where priority = 'low'
$sql$, 0);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

insert into results(name, expected, actual, pass)
select 'TARGETS: anon reads none of it', '0', count(*)::text, count(*) = 0
from public.ticket_response_targets;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('TARGETS: a manager changes the minutes', $sql$
  update public.ticket_response_targets set first_response_minutes = 15 where priority = 'urgent'
$sql$, 1);

reset role;
update public.ticket_response_targets set first_response_minutes = 30 where priority = 'urgent';

-- ── An answer from Mail or Outlook reaches the ticket ────────────────────

insert into public.support_tickets (id, subject, priority) values
  ('21a00000-0000-4000-a000-000000000011', 'check-21 Attached to a live ticket', 'normal'),
  ('21a00000-0000-4000-a000-000000000012', 'check-21 Not yet attached to anything', 'normal');
insert into public.mail_threads (id, connection_id, external_id, subject, ticket_id) values
  ('21a00000-0000-4000-a000-000000000013', '21a00000-0000-4000-a000-000000000001', 'check-21-attached',
   'Re: check-21 Attached to a live ticket', '21a00000-0000-4000-a000-000000000011'),
  ('21a00000-0000-4000-a000-000000000014', '21a00000-0000-4000-a000-000000000001', 'check-21-unattached',
   'check-21 A conversation with no ticket', null);
insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder) values
  ('21a00000-0000-4000-a000-000000000015', '21a00000-0000-4000-a000-000000000013', 'check-21-reply-1', 'outbound',
   'check-21@example.invalid', 'Re: check-21 Attached to a live ticket', 'check-21 Sent from Outlook, not the ticket box.',
   now(), 'sent'),
  ('21a00000-0000-4000-a000-000000000016', '21a00000-0000-4000-a000-000000000014', 'check-21-reply-2', 'outbound',
   'check-21@example.invalid', 'check-21 A conversation with no ticket', 'check-21 Nothing to attach this to.',
   now(), 'sent');

-- Their own statements. See the note above.
select public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000015') as routed_to;
select public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000016') as routed_to;

insert into results(name, expected, actual, pass)
select 'OUTBOUND: a reply sent from Mail or Outlook is filed on the ticket its conversation is attached to',
       'on the ticket, outbound, no author',
       case when not exists (select 1 from public.ticket_messages where mail_message_id = '21a00000-0000-4000-a000-000000000015')
              then 'nowhere'
            else (select ticket_id::text || ' · ' || direction || ' · ' || coalesce(author_employee_id::text, 'none')
                  from public.ticket_messages where mail_message_id = '21a00000-0000-4000-a000-000000000015') end,
       exists (select 1 from public.ticket_messages
               where mail_message_id = '21a00000-0000-4000-a000-000000000015'
                 and ticket_id = '21a00000-0000-4000-a000-000000000011'
                 and direction = 'outbound' and author_employee_id is null);

insert into results(name, expected, actual, pass)
select 'OUTBOUND: a conversation with no live ticket stays mail, exactly as an inbound one would',
       'null', coalesce(public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000016')::text, 'null'),
       public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000016') is null;

insert into results(name, expected, actual, pass)
select 'OUTBOUND: nothing at all was filed for the unattached conversation',
       '0', count(*)::text, count(*) = 0
from public.ticket_messages where mail_message_id = '21a00000-0000-4000-a000-000000000016';

insert into results(name, expected, actual, pass)
select 'OUTBOUND: asking again for the same reply does not double it',
       '1', count(*)::text, count(*) = 1
from public.ticket_messages where mail_message_id = '21a00000-0000-4000-a000-000000000015';

select public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000015') as second_run;

insert into results(name, expected, actual, pass)
select 'OUTBOUND: still one row after asking again',
       '1', count(*)::text, count(*) = 1
from public.ticket_messages where mail_message_id = '21a00000-0000-4000-a000-000000000015';

-- send-ticket-reply's own row: stamped with Graph's Message-ID the moment it
-- sent (this session's other change), before the sync has anything to point
-- mail_message_id at yet. When the sync later stores that same message —
-- however long that takes — route_mail_to_ticket() must link this row, not
-- file a second one.
insert into public.ticket_messages (id, ticket_id, author_employee_id, direction, body, internet_message_id) values
  ('21a00000-0000-4000-a000-000000000019', '21a00000-0000-4000-a000-000000000011',
   current_setting('test.owner_employee')::uuid, 'outbound', 'check-21 Sent through the ticket box.',
   '<check-21-c@sent.invalid>');

insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder, internet_message_id) values
  ('21a00000-0000-4000-a000-000000000018', '21a00000-0000-4000-a000-000000000013', 'check-21-reply-3', 'outbound',
   'check-21@example.invalid', 'Re: check-21 Attached to a live ticket', 'check-21 Sent through the ticket box.',
   now(), 'sent', '<check-21-c@sent.invalid>');

select public.route_mail_to_ticket('21a00000-0000-4000-a000-000000000018') as third_run;

insert into results(name, expected, actual, pass)
select 'OUTBOUND: a reply send-ticket-reply already stamped is linked by its Message-ID, not filed again, once the sync sees it',
       '1 row, its own author kept, linked',
       count(*)::text || ' row' || (case when count(*) = 1 then '' else 's' end)
         || (case when count(*) = 1 and min(author_employee_id::text) = current_setting('test.owner_employee')
                  then ', its own author kept' else ', author changed or row missing' end)
         || (case when bool_and(mail_message_id = '21a00000-0000-4000-a000-000000000018') then ', linked' else ', not linked' end),
       count(*) = 1 and min(author_employee_id::text) = current_setting('test.owner_employee')
         and bool_and(mail_message_id = '21a00000-0000-4000-a000-000000000018')
from public.ticket_messages where internet_message_id = '<check-21-c@sent.invalid>';

-- ── Attachments ───────────────────────────────────────────────────────────

-- Uploaded by the OWNER, recorded the way the Storage API records an upload
-- (05's own note).
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('ticket-attachments', '21a00000-0000-4000-a000-000000000011/u1/screenshot.png',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 2048, "mimetype": "image/png"}'),
  ('ticket-attachments', '21a00000-0000-4000-a000-000000000012/u2/elsewhere.png',
   'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093', '{"size": 64, "mimetype": "image/png"}');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ATTACHMENTS: staff records an attachment after it is actually uploaded', $sql$
  insert into public.ticket_attachments (ticket_id, storage_path, name, size_bytes, content_type)
  values ('21a00000-0000-4000-a000-000000000011',
          '21a00000-0000-4000-a000-000000000011/u1/screenshot.png', 'screenshot.png', 1, 'text/plain')
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'ATTACHMENTS: the size and type recorded are what storage actually has, not what the browser claimed',
       '2048 · image/png', size_bytes || ' · ' || content_type, size_bytes = 2048 and content_type = 'image/png'
from public.ticket_attachments where storage_path = '21a00000-0000-4000-a000-000000000011/u1/screenshot.png';

select pg_temp.refused('ATTACHMENTS: an upload that has not finished cannot be recorded', $sql$
  insert into public.ticket_attachments (ticket_id, storage_path, name, size_bytes, content_type)
  values ('21a00000-0000-4000-a000-000000000012', '21a00000-0000-4000-a000-000000000012/never/uploaded.png',
          'uploaded.png', 1, 'text/plain')
$sql$, 'has not finished uploading');

-- Table owner, no JWT: the lingering claims from the block above must be
-- cleared too, or check_ticket_attachment() (0056) checks this insert's
-- auth.uid() against storage.objects' owner_id as if a session were still
-- live (17's own convention for the same reason).
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.ticket_attachments (id, ticket_id, storage_path, name, size_bytes, content_type, uploaded_by) values
  ('21a00000-0000-4000-a000-000000000021', '21a00000-0000-4000-a000-000000000012',
   '21a00000-0000-4000-a000-000000000012/u2/elsewhere.png', 'elsewhere.png', 64, 'image/png',
   current_setting('test.assistant_employee')::uuid);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ATTACHMENTS: staff who did not upload a file, and is not a manager, cannot remove it', $sql$
  delete from public.ticket_attachments where storage_path = '21a00000-0000-4000-a000-000000000011/u1/screenshot.png'
$sql$, 0);

reset role;

insert into results(name, expected, actual, pass)
select 'ATTACHMENTS: it is still there', '1', count(*)::text, count(*) = 1
from public.ticket_attachments where storage_path = '21a00000-0000-4000-a000-000000000011/u1/screenshot.png';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ATTACHMENTS: whoever uploaded a file removes their own', $sql$
  delete from public.ticket_attachments where id = '21a00000-0000-4000-a000-000000000021'
$sql$, 1);

reset role;
select set_config('request.jwt.claims', '', true);
insert into public.ticket_attachments (id, ticket_id, storage_path, name, size_bytes, content_type, uploaded_by) values
  ('21a00000-0000-4000-a000-000000000022', '21a00000-0000-4000-a000-000000000012',
   '21a00000-0000-4000-a000-000000000012/u2/elsewhere.png', 'elsewhere.png', 64, 'image/png',
   current_setting('test.assistant_employee')::uuid);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('ATTACHMENTS: a manager removes anyone''s', $sql$
  delete from public.ticket_attachments where id = '21a00000-0000-4000-a000-000000000022'
$sql$, 1);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

insert into results(name, expected, actual, pass)
select 'ATTACHMENTS: anon reads none of it', '0', count(*)::text, count(*) = 0
from public.ticket_attachments;

select pg_temp.refused('ATTACHMENTS: anon cannot upload to the bucket', $sql$
  insert into storage.objects (bucket_id, name, owner_id) values
    ('ticket-attachments', '21a00000-0000-4000-a000-000000000011/anon/x.png', null)
$sql$, 'row-level security');

reset role;

-- ── Telling the assignee ──────────────────────────────────────────────────
-- What notify-ticket and the mail sync write to; proving the constraint
-- accepts both new kinds is enough here — sending the mail itself is
-- Resend's job, outside this database.

select pg_temp.affects('EMAIL LOG: ticket_assigned is an accepted kind', $sql$
  insert into public.email_log (to_email, kind, subject, ok) values ('check-21@example.invalid', 'ticket_assigned', 'x', true)
$sql$, 1);

select pg_temp.affects('EMAIL LOG: ticket_customer_reply is an accepted kind', $sql$
  insert into public.email_log (to_email, kind, subject, ok) values ('check-21@example.invalid', 'ticket_customer_reply', 'x', true)
$sql$, 1);

select pg_temp.refused('EMAIL LOG: an unknown kind is still refused', $sql$
  insert into public.email_log (to_email, kind, subject, ok) values ('check-21@example.invalid', 'ticket_teleported', 'x', true)
$sql$, 'violates check constraint');

-- ── Results ───────────────────────────────────────────────────────────────

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
