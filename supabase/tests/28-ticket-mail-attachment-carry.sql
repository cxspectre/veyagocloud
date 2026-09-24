-- 28-ticket-mail-attachment-carry.sql — 0063: a carried-over attachment can
-- be told apart from a staff one and cannot be doubled, and filing a
-- customer's email on a ticket never fails because of it.
--
-- One connection, one thread, one message with two attachments, one ticket.
-- Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);

-- A minimal, real chain: integration_connections → mail_threads →
-- mail_messages → mail_attachments, and support_tickets on its own.
insert into public.integration_connections (id, provider, account_label, status) values
  ('c2800000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-28@example.invalid', 'connected');

insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('c2800000-0000-4000-a000-000000000002', 'c2800000-0000-4000-a000-000000000001', 'check-28-thread', 'Attachments');

insert into public.mail_messages (id, thread_id, external_id, direction, from_email, sent_at, folder) values
  ('c2800000-0000-4000-a000-000000000003', 'c2800000-0000-4000-a000-000000000002', 'check-28-msg',
   'inbound', 'client@check-28.example.invalid', now(), 'inbox');

insert into public.mail_attachments (id, message_id, external_id, name, content_type, size, is_inline) values
  ('c2800000-0000-4000-a000-000000000004', 'c2800000-0000-4000-a000-000000000003', 'check-28-att-1',
   'quote.pdf', 'application/pdf', 1024, false),
  ('c2800000-0000-4000-a000-000000000005', 'c2800000-0000-4000-a000-000000000003', 'check-28-att-2',
   'logo.png', 'image/png', 512, true);

insert into public.support_tickets (id, subject) values
  ('c2800000-0000-4000-a000-000000000006', 'check-28 attachments');

-- ── The trigger never blocks the ticket_messages insert it answers to ──────
--
-- The environment this suite runs in almost certainly has neither vault
-- secret set (project_url, mail_sync_secret) — 0063's own trigger is written
-- to treat that as "not configured yet" and do nothing, not raise. This is
-- the one thing about the trigger a rolled-back SQL transaction CAN prove:
-- pg_net's own delivery is asynchronous and happens after commit, so it is
-- not what this checks.
insert into public.ticket_messages (id, ticket_id, direction, body, mail_message_id) values
  ('c2800000-0000-4000-a000-000000000007', 'c2800000-0000-4000-a000-000000000006', 'inbound',
   'See the attached quote.', 'c2800000-0000-4000-a000-000000000003');

-- Reaching this line at all, with the row actually there, is the real
-- assertion: a trigger that raised would have aborted the INSERT above (no
-- exception handler wraps it, the way one wraps pg_temp.second_carry below)
-- and the whole script would have stopped before a single row went into
-- results.
insert into results(name, expected, actual, pass)
select 'TRIGGER: filing a customer email with attachments waiting does not fail the insert', '1 row', count(*) || ' row', count(*) = 1
from public.ticket_messages where id = 'c2800000-0000-4000-a000-000000000007';

insert into results(name, expected, actual, pass)
select 'TRIGGER: is attached to ticket_messages for INSERT',
       'ticket_messages_carry_attachments', coalesce(tgname, 'missing'), tgname = 'ticket_messages_carry_attachments'
from pg_trigger
where tgrelid = 'public.ticket_messages'::regclass and tgname = 'ticket_messages_carry_attachments' and not tgisinternal;

-- ── Telling a carried-over row apart from a staff upload ───────────────────
--
-- The Storage API's own record for each file below, so check_ticket_attachment()
-- (0056) finds a real upload behind every storage_path this suite inserts —
-- the same requirement suite 17 already satisfies for project-files.
insert into storage.objects (bucket_id, name, metadata) values
  ('ticket-attachments', 'c2800000-0000-4000-a000-000000000006/c2800000-0000-4000-a000-000000000004/quote.pdf',
   '{"size": 1024, "mimetype": "application/pdf"}'),
  ('ticket-attachments', 'c2800000-0000-4000-a000-000000000006/staff-upload/notes.txt',
   '{"size": 20, "mimetype": "text/plain"}'),
  ('ticket-attachments', 'c2800000-0000-4000-a000-000000000006/c2800000-0000-4000-a000-000000000004/again.pdf',
   '{"size": 1024, "mimetype": "application/pdf"}'),
  ('ticket-attachments', 'c2800000-0000-4000-a000-000000000006/c2800000-0000-4000-a000-000000000005/again.pdf',
   '{"size": 1024, "mimetype": "application/pdf"}');

insert into public.ticket_attachments (id, ticket_id, message_id, storage_path, name, size_bytes, content_type, uploaded_by, mail_attachment_id)
values ('c2800000-0000-4000-a000-000000000008', 'c2800000-0000-4000-a000-000000000006',
        'c2800000-0000-4000-a000-000000000007',
        'c2800000-0000-4000-a000-000000000006/c2800000-0000-4000-a000-000000000004/quote.pdf',
        'quote.pdf', 1024, 'application/pdf', null, 'c2800000-0000-4000-a000-000000000004');

insert into results(name, expected, actual, pass)
select 'CARRIED: a carried-over row has no uploader and points at its mail attachment', 'null · set',
       (case when uploaded_by is null then 'null' else 'set' end) || ' · ' ||
       (case when mail_attachment_id is not null then 'set' else 'null' end),
       uploaded_by is null and mail_attachment_id is not null
from public.ticket_attachments where id = 'c2800000-0000-4000-a000-000000000008';

insert into public.ticket_attachments (id, ticket_id, storage_path, name, size_bytes, content_type, uploaded_by)
values ('c2800000-0000-4000-a000-000000000009', 'c2800000-0000-4000-a000-000000000006',
        'c2800000-0000-4000-a000-000000000006/staff-upload/notes.txt',
        'notes.txt', 20, 'text/plain', null);

insert into results(name, expected, actual, pass)
select 'STAFF UPLOAD: unaffected — no message, no mail attachment', 'null · null',
       (case when message_id is null then 'null' else 'set' end) || ' · ' ||
       (case when mail_attachment_id is null then 'null' else 'set' end),
       message_id is null and mail_attachment_id is null
from public.ticket_attachments where id = 'c2800000-0000-4000-a000-000000000009';

-- ── The same mail attachment cannot be carried over twice ──────────────────

create function pg_temp.second_carry(p_mail_attachment uuid)
returns text
language plpgsql
as $$
begin
  insert into public.ticket_attachments (ticket_id, message_id, storage_path, name, size_bytes, content_type, uploaded_by, mail_attachment_id)
  values ('c2800000-0000-4000-a000-000000000006', 'c2800000-0000-4000-a000-000000000007',
          'c2800000-0000-4000-a000-000000000006/' || p_mail_attachment || '/again.pdf',
          'again.pdf', 1024, 'application/pdf', null, p_mail_attachment);
  return 'inserted';
exception when unique_violation then
  return 'refused';
end;
$$;

insert into results(name, expected, actual, pass)
select 'UNIQUE: a second row for the same mail attachment is refused', 'refused', x.seen, x.seen = 'refused'
from (select pg_temp.second_carry('c2800000-0000-4000-a000-000000000004'::uuid) as seen) x;

insert into results(name, expected, actual, pass)
select 'UNIQUE: a DIFFERENT mail attachment on the same ticket is not caught by the same rule', 'inserted', x.seen, x.seen = 'inserted'
from (select pg_temp.second_carry('c2800000-0000-4000-a000-000000000005'::uuid) as seen) x;

insert into results(name, expected, actual, pass)
select 'UNIQUE: exactly one index enforces it, only where the column is set', 'ticket_attachments_mail_attachment_idx',
       coalesce(string_agg(indexname, ', '), 'none'),
       count(*) = 1 and bool_and(indexname = 'ticket_attachments_mail_attachment_idx')
from pg_indexes
where schemaname = 'public' and tablename = 'ticket_attachments' and indexdef like '%mail_attachment_id%' and indexdef like '%UNIQUE%';

-- ── Removing the mail attachment does not take the ticket's copy with it ───
--
-- Deletes the SECOND mail attachment (…005) — the one pg_temp.second_carry
-- just carried over above as "again.pdf" — and checks that row, not the
-- first attachment's, so this cannot pass by coincidence if ON DELETE were
-- wired to CASCADE the wrong column entirely.

delete from public.mail_attachments where id = 'c2800000-0000-4000-a000-000000000005';

insert into results(name, expected, actual, pass)
select 'ON DELETE SET NULL: the ticket keeps its file; only the link back to mail_attachments clears', '1 row · null',
       count(*) || ' row · ' || coalesce(string_agg(coalesce(mail_attachment_id::text, 'null'), ','), 'none'),
       count(*) = 1 and bool_and(mail_attachment_id is null)
from public.ticket_attachments
where ticket_id = 'c2800000-0000-4000-a000-000000000006' and storage_path like '%/again.pdf';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
