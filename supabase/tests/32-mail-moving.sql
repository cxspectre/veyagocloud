-- 32-mail-moving.sql — archiving, junking and deleting a conversation from the
-- workspace (0069).
--
-- The owner decided on 2026-09-21 that the workspace may move mail to three
-- folders and no others, and that DELETE MEANS DELETED ITEMS — never a purge.
-- This suite proves the database half of that: mail_moved() files the messages
-- an Edge Function says Outlook actually took, lets 0045's own
-- file_threads_out_of_inbox() decide where the conversation goes, files a
-- conversation sitting in SENT by the same rule (which 0045 never had to
-- consider), writes the new Graph ids a move hands back, deletes nothing at
-- all, and is out of reach of anything but the service role.
--
-- The OWNER is the real owner (is_manager() true without any changes here).
-- The ASSISTANT, whatever they are in real life, is woken as a plain,
-- non-manager member of staff for the length of this transaction only — the
-- same technique 08-team-rules.sql and 20-mail-backend-fixes.sql use.
-- Everything is rolled back.
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

-- A message the way _shared/graph-message.ts toMailRow() hands it over.
create function pg_temp.mail(p_id text, p_thread text, p_dir text, p_minutes int)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'external_id', p_id, 'thread_external_id', p_thread,
    'internet_message_id', '<' || p_id || '@check-32.invalid>',
    'direction', p_dir,
    'from_email', case when p_dir = 'inbound' then 'customer@check-32.invalid'
                  else 'check-32@example.invalid' end,
    'from_name', case when p_dir = 'inbound' then 'Check32 Customer' else 'Check32 Studio' end,
    'to_emails', case when p_dir = 'inbound' then '["check-32@example.invalid"]'::jsonb
                 else '["customer@check-32.invalid"]'::jsonb end,
    'cc_emails', '[]'::jsonb, 'bcc_emails', '[]'::jsonb,
    'subject', 'check-32 ' || p_thread, 'body_text', 'Hello', 'body_html', '', 'snippet', 'Hello',
    'sent_at', (now() - make_interval(mins => p_minutes))::text,
    'is_read', true, 'is_flagged', false, 'importance', 'normal', 'has_attachments', false);
$$;

create function pg_temp.thread_id(p_connection uuid, p_thread text)
returns uuid
language sql
as $$
  select id from public.mail_threads where connection_id = p_connection and external_id = p_thread;
$$;

create function pg_temp.thread_folder(p_connection uuid, p_thread text)
returns text
language sql
as $$
  select coalesce((select folder from public.mail_threads
                   where connection_id = p_connection and external_id = p_thread), 'no thread');
$$;

-- Where each of a conversation's messages is, by the Graph id it now carries.
create function pg_temp.placement(p_connection uuid, p_thread text)
returns text
language sql
as $$
  select coalesce(string_agg(m.external_id || '=' || m.folder, ', ' order by m.external_id), 'nothing')
  from public.mail_messages m
  join public.mail_threads t on t.id = m.thread_id
  where t.connection_id = p_connection and t.external_id = p_thread;
$$;

-- Every message and conversation this suite made, for the "nothing was
-- deleted" count at the end.
create function pg_temp.still_there(p_connection uuid)
returns text
language sql
as $$
  select (select count(*) from public.mail_threads where connection_id = p_connection)::text || ' threads, '
         || (select count(*) from public.mail_messages m
             join public.mail_threads t on t.id = m.thread_id
             where t.connection_id = p_connection)::text || ' messages';
$$;

-- ── Fixtures ──────────────────────────────────────────────────────────────
-- One studio mailbox everyone on staff can read, and one personal mailbox
-- belonging to the owner, which a colleague must not be able to reach.
select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

-- Woken as a plain, non-manager member of staff — rolled back with everything
-- else.
update public.employees
set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('32a00000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-32@example.invalid', null, 'connected');
insert into public.integration_connections (id, provider, account_label, employee_id, status)
select '32a00000-0000-4000-a000-000000000002', 'microsoft_mail', 'check-32-owner@example.invalid',
       current_setting('test.owner_employee')::uuid, 'connected';

-- P: two inbound messages in the inbox, nothing of ours.
-- Q: a customer's message in the inbox and our reply in Sent.
-- R: a conversation entirely in Sent — one we started that nobody answered.
-- S: already archived by the sync, so a second archive has nothing to move.
select public.store_mail_batch('32a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('p-1', 'conv-p', 'inbound', 40),
  pg_temp.mail('p-2', 'conv-p', 'inbound', 30),
  pg_temp.mail('q-1', 'conv-q', 'inbound', 50)));
select public.store_mail_batch('32a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('q-2', 'conv-q', 'outbound', 45),
  pg_temp.mail('r-1', 'conv-r', 'outbound', 60)));
select public.store_mail_batch('32a00000-0000-4000-a000-000000000001', 'archive', jsonb_build_array(
  pg_temp.mail('s-1', 'conv-s', 'inbound', 70)));
-- A conversation in the owner's own mailbox, for the reach checks below.
select public.store_mail_batch('32a00000-0000-4000-a000-000000000002', 'inbox', jsonb_build_array(
  pg_temp.mail('w-1', 'conv-w', 'inbound', 25)));

select set_config('test.started', pg_temp.still_there('32a00000-0000-4000-a000-000000000001'), true);
-- The owner's own conversation, remembered WHILE it can still be looked up:
-- a colleague cannot read mail_threads to find its id, so asking for it as
-- them would prove nothing about mail_thread_placement() itself — only that
-- the id came back null.
select set_config('test.private_thread',
  pg_temp.thread_id('32a00000-0000-4000-a000-000000000002', 'conv-w')::text, true);

-- ── 1. Archiving a conversation whose mail is all from outside ─────────────
-- Both messages move, and the conversation follows them out of the inbox —
-- 0045's own rule, reused rather than copied.
select public.mail_moved(
  pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-p'), 'archive',
  jsonb_build_array(
    jsonb_build_object('id', (select m.id from public.mail_messages m where m.external_id = 'p-1'
                              and m.thread_id = pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-p')),
                       'external_id', 'p-1-after-move'),
    jsonb_build_object('id', (select m.id from public.mail_messages m where m.external_id = 'p-2'
                              and m.thread_id = pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-p')),
                       'external_id', 'p-2-after-move')));

insert into results(name, expected, actual, pass)
select 'ARCHIVED: the conversation leaves the inbox with its mail', 'archive',
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-p'),
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-p') = 'archive';

-- Graph answers a move with the message under a NEW id, and
-- mail-attachment-content (0063) fetches by exactly that id: a stale one here
-- means an attachment nobody can open afterwards.
insert into results(name, expected, actual, pass)
select 'NEW GRAPH IDS: the ids a move handed back are what the workspace now holds',
       'p-1-after-move=archive, p-2-after-move=archive',
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-p'),
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-p')
         = 'p-1-after-move=archive, p-2-after-move=archive';

-- ── 2. A conversation still holding a reply of ours ────────────────────────
-- Junk deliberately moves only mail from OUTSIDE (_shared/mail-move.ts:
-- reporting our own reply as junk teaches Outlook our own address sends junk),
-- so our Sent copy stays — and 0045's rule then puts the conversation in Sent,
-- where the workspace lists it, rather than in Junk.
select public.mail_moved(
  pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-q'), 'spam',
  jsonb_build_array(
    jsonb_build_object('id', (select m.id from public.mail_messages m where m.external_id = 'q-1'
                              and m.thread_id = pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-q')),
                       'external_id', 'q-1-after-move')));

insert into results(name, expected, actual, pass)
select 'JUNKED, OUR REPLY KEPT: the customer''s message is junk, ours is still in Sent',
       'q-1-after-move=spam, q-2=sent',
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-q'),
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-q') = 'q-1-after-move=spam, q-2=sent';

insert into results(name, expected, actual, pass)
select 'AND THE CONVERSATION GOES TO SENT, not Junk — 0045''s rule, unchanged', 'sent',
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-q'),
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-q') = 'sent';

-- ── 3. A conversation sitting in Sent ──────────────────────────────────────
-- What 0045 never had to consider: file_threads_out_of_inbox() only ever looks
-- at a thread whose folder is 'inbox', because the sync only follows the
-- inbox's removals. A person can archive one in Sent, and 0069 files it by the
-- same rule.
select public.mail_moved(
  pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-r'), 'trash',
  jsonb_build_array(
    jsonb_build_object('id', (select m.id from public.mail_messages m where m.external_id = 'r-1'
                              and m.thread_id = pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-r')),
                       'external_id', 'r-1-after-move')));

insert into results(name, expected, actual, pass)
select 'DELETED FROM SENT: a conversation with nothing left in a listed folder leaves it too',
       'trash · r-1-after-move=trash',
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-r') || ' · '
         || pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-r'),
       pg_temp.thread_folder('32a00000-0000-4000-a000-000000000001', 'conv-r') = 'trash'
         and pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-r') = 'r-1-after-move=trash';

-- ── 4. Nothing is deleted, here or anywhere ────────────────────────────────
-- Delete means Deleted Items. Every row this suite made is still a row.
insert into results(name, expected, actual, pass)
select 'NOTHING WAS DELETED: every conversation and message is still stored',
       current_setting('test.started'), pg_temp.still_there('32a00000-0000-4000-a000-000000000001'),
       pg_temp.still_there('32a00000-0000-4000-a000-000000000001') = current_setting('test.started');

-- ── 5. What mail_moved() refuses ───────────────────────────────────────────
select pg_temp.refused('NOWHERE: a folder outside the three the owner named', $sql$
  select public.mail_moved(pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-s'), 'inbox', '[]'::jsonb)
$sql$, 'cannot file a conversation to inbox');

select pg_temp.refused('NOWHERE: null is not a destination either', $sql$
  select public.mail_moved(pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-s'), null, '[]'::jsonb)
$sql$, 'cannot file a conversation to nowhere');

select pg_temp.refused('NO SUCH CONVERSATION: a thread id that is not one', $sql$
  select public.mail_moved('32ffffff-0000-4000-a000-0000000000ff', 'archive', '[]'::jsonb)
$sql$, 'no such conversation');

-- A message id from ANOTHER conversation, handed in by a caller that has its
-- threads confused: it must move nothing rather than file a stranger's mail.
select public.mail_moved(
  pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-s'), 'trash',
  jsonb_build_array(jsonb_build_object(
    'id', (select m.id from public.mail_messages m where m.external_id = 'q-2'
           and m.thread_id = pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-q')),
    'external_id', 'q-2-should-not-move')));

insert into results(name, expected, actual, pass)
select 'ANOTHER CONVERSATION''S MESSAGE IS NOT TOUCHED: our Sent reply is still in Sent, under its own id',
       'q-1-after-move=spam, q-2=sent',
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-q'),
       pg_temp.placement('32a00000-0000-4000-a000-000000000001', 'conv-q') = 'q-1-after-move=spam, q-2=sent';

-- ── 6. Reading where a conversation's messages are, under RLS ──────────────
-- mail_thread_placement() is security INVOKER (0069), so mail_messages' own
-- policy decides — a colleague's personal mailbox is out of reach without a
-- second copy of the visibility rule to drift.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'PLACEMENT: staff read where a studio conversation''s messages are', '2',
       count(*)::text, count(*) = 2
from public.mail_thread_placement(pg_temp.thread_id('32a00000-0000-4000-a000-000000000001', 'conv-q'));

insert into results(name, expected, actual, pass)
select 'PLACEMENT: but not a colleague''s personal mailbox, asked for by its own id', '0',
       count(*)::text, count(*) = 0
from public.mail_thread_placement(current_setting('test.private_thread')::uuid);

select pg_temp.refused('NO BROWSER MOVES MAIL: a signed-in person cannot file it themselves', $sql$
  select public.mail_moved(
    (select id from public.mail_threads where connection_id = '32a00000-0000-4000-a000-000000000001'
       and external_id = 'conv-s'), 'trash', '[]'::jsonb)
$sql$, 'permission denied');

reset role;

-- Even the owner, who is a manager: moving mail is the Edge Function's to do
-- once Outlook has taken it, not a manager's to do directly.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('NOR AN OWNER: being a manager is not what stands between mail and Outlook', $sql$
  select public.mail_moved(
    (select id from public.mail_threads where connection_id = '32a00000-0000-4000-a000-000000000001'
       and external_id = 'conv-s'), 'trash', '[]'::jsonb)
$sql$, 'permission denied');

reset role;

-- ── 7. Grants, and the reuse the migration promises ────────────────────────
insert into results(name, expected, actual, pass)
select 'GRANTS: move-mail-thread runs mail_moved(); a browser and anon do not', 'sync yes · others no',
       'sync ' || case when g.sync then 'yes' else 'no' end || ' · others ' || case when g.others then 'yes' else 'no' end,
       g.sync and not g.others
from (select
        has_function_privilege('service_role', 'public.mail_moved(uuid, text, jsonb)', 'execute') as sync,
        (select bool_or(has_function_privilege(r.role_name::name, 'public.mail_moved(uuid, text, jsonb)', 'execute'))
         from unnest(array['authenticated', 'anon']) as r(role_name)) as others) g;

insert into results(name, expected, actual, pass)
select 'REUSE: mail_moved() still files a conversation through 0045''s own function', 'yes',
       case when pg_get_functiondef('public.mail_moved(uuid, text, jsonb)'::regprocedure)
                 like '%file_threads_out_of_inbox%' then 'yes' else 'no' end,
       pg_get_functiondef('public.mail_moved(uuid, text, jsonb)'::regprocedure) like '%file_threads_out_of_inbox%';

insert into results(name, expected, actual, pass)
select 'NO DELETE ANYWHERE IN IT: the function that files mail away cannot remove any', 'yes',
       case when pg_get_functiondef('public.mail_moved(uuid, text, jsonb)'::regprocedure)
                 ~* 'delete\s+from\s+public\.mail_' then 'no' else 'yes' end,
       not (pg_get_functiondef('public.mail_moved(uuid, text, jsonb)'::regprocedure)
            ~* 'delete\s+from\s+public\.mail_');

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
