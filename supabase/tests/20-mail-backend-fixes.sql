-- 20-mail-backend-fixes.sql — the other party a thread is labelled with,
-- linking and rematching mail to the CRM by hand, attachment metadata,
-- full-text search, and disconnecting your own mailbox (0055).
--
-- The OWNER is the real owner (is_manager() true without any changes here).
-- The ASSISTANT, whatever they are in real life, is woken as a plain,
-- non-manager member of staff for the length of this transaction only — the
-- same technique 08-team-rules.sql uses. Search bodies use a made-up word
-- found nowhere else, so a real message elsewhere in the mailbox cannot make
-- a count come out wrong. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon, service_role;
grant usage, select on sequence results_id_seq to authenticated, anon, service_role;

-- A statement that must be refused, for the reason given (08-team-rules.sql's
-- own helper).
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

-- A message the way _shared/graph-message.ts toMailRow() hands it over, with
-- an optional attachment list (mail-sync.ts's AttachmentRow shape).
-- p_has_attachments defaults to "whatever p_attachments implies" but can be
-- forced true with no list, for the one case that matters on its own: Graph
-- still says the message has attachments while mail-sync.ts's own fetch of
-- the list came back empty (a transient failure it swallows rather than
-- failing the mail underneath it).
create function pg_temp.mail(
  p_id text, p_thread text, p_dir text, p_from_email text, p_from_name text,
  p_to text[], p_body text, p_minutes int, p_attachments jsonb default null,
  p_has_attachments boolean default null
) returns jsonb
language sql
as $$
  select jsonb_build_object(
    'external_id', p_id, 'thread_external_id', p_thread,
    'internet_message_id', '<' || p_id || '@check-20.invalid>',
    'direction', p_dir, 'from_name', p_from_name, 'from_email', p_from_email,
    'to_emails', to_jsonb(p_to), 'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
    'subject', 'check-20 ' || p_thread, 'body_text', p_body, 'body_html', '', 'snippet', p_body,
    'sent_at', (now() - make_interval(mins => p_minutes))::text,
    'is_read', true, 'is_flagged', false, 'importance', 'normal',
    'has_attachments', coalesce(p_has_attachments, p_attachments is not null)
  ) || case when p_attachments is not null
       then jsonb_build_object('attachments', p_attachments) else '{}'::jsonb end;
$$;

-- A thread's other-party columns and CRM link, by connection and Graph id.
create function pg_temp.thread(p_connection uuid, p_external_id text,
                                out other_name text, out other_email text,
                                out contact_id uuid, out company_id uuid)
returns record
language sql
as $$
  select other_party_name, other_party_email, mail_threads.contact_id, mail_threads.company_id
  from public.mail_threads
  where connection_id = p_connection and external_id = p_external_id;
$$;

-- ── Fixtures ──────────────────────────────────────────────────────────────
insert into public.crm_companies (id, name, domain) values
  ('20c00000-0000-4000-a000-000000000001', 'Check20 Co', 'check-20.invalid');
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('20c00000-0000-4000-a000-000000000002', '20c00000-0000-4000-a000-000000000001',
   'Check20 Person', 'prospect@check-20.invalid'),
  ('20c00000-0000-4000-a000-000000000003', null, 'Another Check20 Contact', 'another@check-20.invalid');

insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('20a00000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-20-studio@example.invalid', null, 'connected');

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- Woken as a plain, non-manager member of staff — rolled back with everything
-- else.
update public.employees
set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.integration_connections (id, provider, account_label, employee_id, status)
select '20a00000-0000-4000-a000-000000000002', 'microsoft_mail', 'check-20-assistant@example.invalid',
       current_setting('test.assistant_employee')::uuid, 'connected';
insert into public.integration_connections (id, provider, account_label, employee_id, status)
select '20a00000-0000-4000-a000-000000000003', 'microsoft_mail', 'check-20-owner@example.invalid',
       current_setting('test.owner_employee')::uuid, 'connected';

-- A conversation in the owner's personal mailbox, made early so later
-- sections can both search it and try (and fail) to reach it as someone
-- else's colleague.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000003', 'inbox', jsonb_build_array(
  pg_temp.mail('e-in-1', 'conv-e', 'inbound', 'someone@check-20.invalid', 'Someone Else',
               array['check-20-owner@example.invalid'], 'A zzqxcheckmarker walked into the office.', 1)));

-- ── 1. The OTHER party, not whoever wrote most recently ────────────────────
-- A question arrives; we answer it. The customer, not our own reply, decides
-- who the thread is labelled with.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('a-in-1', 'conv-a', 'inbound', 'prospect@check-20.invalid', 'Check20 Person',
               array['check-20-studio@example.invalid'], 'Any update?', 30)));
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('a-out-1', 'conv-a', 'outbound', 'check-20-studio@example.invalid', 'Check20 Studio',
               array['prospect@check-20.invalid'], 'Yes, tomorrow.', 5)));

insert into results(name, expected, actual, pass)
select 'ANSWERED: the other party stays the customer, not our own reply', 'Check20 Person · prospect@check-20.invalid',
       coalesce(t.other_name, 'null') || ' · ' || coalesce(t.other_email, 'null'),
       t.other_name = 'Check20 Person' and t.other_email = 'prospect@check-20.invalid'
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-a') t;

-- A thread we start ourselves: nobody has answered yet.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('b-out-1', 'conv-b', 'outbound', 'check-20-studio@example.invalid', 'Check20 Studio',
               array['prospect@check-20.invalid'], 'Following up on our call.', 10)));

insert into results(name, expected, actual, pass)
select 'WE WROTE FIRST: shows who we wrote to, never our own name, and matches the CRM straight away',
       'null · prospect@check-20.invalid · Check20 Person',
       coalesce(t.other_name, 'null') || ' · ' || coalesce(t.other_email, 'null') || ' · '
         || coalesce((select full_name from public.crm_contacts c where c.id = t.contact_id), 'no match'),
       t.other_name is null and t.other_email = 'prospect@check-20.invalid'
         and t.contact_id = '20c00000-0000-4000-a000-000000000002'
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-b') t;

insert into results(name, expected, actual, pass)
select 'AND THE COMPANY CAME WITH IT', 'Check20 Co',
       coalesce((select name from public.crm_companies co where co.id = t.company_id), 'no match'),
       t.company_id = '20c00000-0000-4000-a000-000000000001'
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-b') t;

-- Nobody outside is on it at all: nothing to show, and nothing matched.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('c-out-1', 'conv-c', 'outbound', 'check-20-studio@example.invalid', 'Check20 Studio',
               array['check-20-assistant@example.invalid'], 'Note to self.', 1)));

insert into results(name, expected, actual, pass)
select 'ALL OF US: an internal-only message names no other party, and matches no contact', 'null · null · null',
       coalesce(t.other_name, 'null') || ' · ' || coalesce(t.other_email, 'null') || ' · '
         || coalesce(t.contact_id::text, 'null'),
       t.other_name is null and t.other_email is null and t.contact_id is null
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-c') t;

-- ── 2. Linking and rematching by hand ───────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('LINK: staff link a conversation they can read to a contact', $sql$
  select public.link_mail_thread(
    (select id from public.mail_threads where connection_id = '20a00000-0000-4000-a000-000000000001'
       and external_id = 'conv-c'),
    '20c00000-0000-4000-a000-000000000003')
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'LINKED: the company followed — none, since this contact has none', 'Another Check20 Contact · none',
       coalesce((select full_name from public.crm_contacts c where c.id = t.contact_id), 'no match') || ' · '
         || coalesce(t.company_id::text, 'none'),
       t.contact_id = '20c00000-0000-4000-a000-000000000003' and t.company_id is null
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-c') t;

select pg_temp.affects('LINK: null clears it', $sql$
  select public.link_mail_thread(
    (select id from public.mail_threads where connection_id = '20a00000-0000-4000-a000-000000000001'
       and external_id = 'conv-c'), null)
$sql$, 1);

insert into results(name, expected, actual, pass)
select 'CLEARED: no contact left on it', 'null', coalesce(t.contact_id::text, 'null'), t.contact_id is null
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-c') t;

select pg_temp.refused('LINK: a conversation in a colleague''s personal mailbox is not theirs to open', $sql$
  select public.link_mail_thread(
    (select id from public.mail_threads where connection_id = '20a00000-0000-4000-a000-000000000003'
       and external_id = 'conv-e'), null)
$sql$, 'no such conversation');

select pg_temp.refused('LINK: a contact that does not exist', $sql$
  select public.link_mail_thread(
    (select id from public.mail_threads where connection_id = '20a00000-0000-4000-a000-000000000001'
       and external_id = 'conv-c'), gen_random_uuid())
$sql$, 'not in the crm');

select pg_temp.refused('REMATCH: a plain member of staff is not a manager', 'select public.rematch_mail_threads()',
  'owner or admin');

reset role;

-- A message from an address with no matching contact yet — the back-fill's
-- reason to exist: the address only becomes a contact afterwards.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('f-in-1', 'conv-f', 'inbound', 'latecontact@check-20.invalid', 'Late Contact',
               array['check-20-studio@example.invalid'], 'Hello.', 20)));

insert into results(name, expected, actual, pass)
select 'BEFORE THE CONTACT EXISTS: nothing to match yet', 'null', coalesce(t.contact_id::text, 'null'),
       t.contact_id is null
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-f') t;

insert into public.crm_contacts (id, company_id, full_name, email) values
  ('20c00000-0000-4000-a000-000000000004', null, 'Late Contact', 'latecontact@check-20.invalid');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

-- Run for real (rolled back with everything else): whatever else it touches
-- in the live mailbox, this fixture's own thread is the one being proved.
select public.rematch_mail_threads(500);

reset role;

insert into results(name, expected, actual, pass)
select 'REMATCHED: the contact added after the mail arrived is caught up by hand', 'Late Contact',
       coalesce((select full_name from public.crm_contacts c where c.id = t.contact_id), 'no match'),
       t.contact_id = '20c00000-0000-4000-a000-000000000004'
from pg_temp.thread('20a00000-0000-4000-a000-000000000001', 'conv-f') t;

-- ── 3. Attachment metadata ───────────────────────────────────────────────
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('d-in-1', 'conv-d', 'inbound', 'prospect@check-20.invalid', 'Check20 Person',
               array['check-20-studio@example.invalid'], 'See zzqxattachmarker for details.', 2,
               jsonb_build_array(
                 jsonb_build_object('external_id', 'att-1', 'name', 'brief.pdf', 'content_type', 'application/pdf',
                                     'size', 4096, 'is_inline', false, 'content_id', null),
                 jsonb_build_object('external_id', 'att-2', 'name', 'logo.png', 'content_type', 'image/png',
                                     'size', 512, 'is_inline', true, 'content_id', 'logo1')))));

insert into results(name, expected, actual, pass)
select 'ATTACHMENTS STORED: name, kind, size, and an inline one keeps its cid', '2 · brief.pdf,logo.png · logo1',
       count(*)::text || ' · ' || string_agg(a.name, ',' order by a.external_id) || ' · '
         || max(a.content_id) filter (where a.is_inline),
       count(*) = 2 and string_agg(a.name, ',' order by a.external_id) = 'brief.pdf,logo.png'
         and max(a.content_id) filter (where a.is_inline) = 'logo1'
from public.mail_attachments a
join public.mail_messages m on m.id = a.message_id
where m.external_id = 'd-in-1';

-- A re-sync of the same message: Graph still says it has attachments, but
-- this round's fetch of the list came back empty (mail-sync.ts swallows that
-- failure rather than losing the message over it) — the list already stored
-- must not be wiped by it.
select public.store_mail_batch('20a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('d-in-1', 'conv-d', 'inbound', 'prospect@check-20.invalid', 'Check20 Person',
               array['check-20-studio@example.invalid'], 'See zzqxattachmarker for details.', 2,
               null, true)));

insert into results(name, expected, actual, pass)
select 'A RESYNC WITH NO ATTACHMENT LIST KEEPS WHAT WAS ALREADY STORED', '2',
       count(*)::text, count(*) = 2
from public.mail_attachments a join public.mail_messages m on m.id = a.message_id where m.external_id = 'd-in-1';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF READ: attachments of a message in a mailbox they can read (the studio''s)', '2',
       count(*)::text, count(*) = 2
from public.mail_attachments a join public.mail_messages m on m.id = a.message_id where m.external_id = 'd-in-1';

select pg_temp.refused('STAFF WRITE: cannot insert an attachment directly', $sql$
  insert into public.mail_attachments (message_id, external_id, name)
  values ((select id from public.mail_messages where external_id = 'd-in-1'), 'sneaky', 'x')
$sql$, 'permission denied');

reset role;

-- ── 4. Search reaches a whole mailbox, respecting RLS ───────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'SEARCH FINDS A BODY WORD in a mailbox staff can read', '1', count(*)::text, count(*) = 1
from public.search_mail('zzqxattachmarker');

insert into results(name, expected, actual, pass)
select 'SEARCH DOES NOT REACH a colleague''s personal mailbox', '0', count(*)::text, count(*) = 0
from public.search_mail('zzqxcheckmarker');

insert into results(name, expected, actual, pass)
select 'A BLANK QUERY finds nothing, not everything', '0', count(*)::text, count(*) = 0
from public.search_mail('   ');

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'SEARCH FINDS IT in the owner''s own mailbox', '1', count(*)::text, count(*) = 1
from public.search_mail('zzqxcheckmarker');

reset role;

-- ── 5. Disconnecting your own mailbox needs nobody's permission but yours ──
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('DISCONNECT: a plain member of staff disconnects their OWN personal mailbox',
  $sql$update public.integration_connections set status = 'disconnected'
       where id = '20a00000-0000-4000-a000-000000000002'$sql$, 1);

select pg_temp.affects('DISCONNECT: but not the studio''s',
  $sql$update public.integration_connections set status = 'disconnected'
       where id = '20a00000-0000-4000-a000-000000000001'$sql$, 0);

select pg_temp.affects('DISCONNECT: nor a colleague''s personal mailbox',
  $sql$update public.integration_connections set status = 'disconnected'
       where id = '20a00000-0000-4000-a000-000000000003'$sql$, 0);

reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('DISCONNECT: an owner or admin still disconnects the studio''s (unaffected by the widened rule)',
  $sql$update public.integration_connections set status = 'disconnected'
       where id = '20a00000-0000-4000-a000-000000000001'$sql$, 1);

reset role;

-- ── 6. Attachments nobody sent, cleared by themselves ───────────────────────
insert into results(name, expected, actual, pass)
select 'CLEANUP SCHEDULED: once a day, calling cleanup-mail-attachments', '1 · 15 3 * * *',
       count(*)::text || ' · ' || max(schedule),
       count(*) = 1 and max(schedule) = '15 3 * * *'
from cron.job where jobname = 'cleanup-mail-attachments';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
