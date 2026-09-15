-- 10-mail-leaves-inbox.sql — mail archived or deleted in Outlook leaves the
-- workspace inbox (0045).
--
-- A mailbox with conversations stored the way the sync stores them: X has two
-- messages in the inbox; Y has one in the inbox and our reply in Sent; W, Z and
-- S follow further down. A second mailbox holds a message under the same Graph
-- id as one of X's, so a removal is shown to stay inside its own mailbox.
-- Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

insert into public.integration_connections (id, provider, account_label, status) values
  ('10a00000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-10@example.invalid', 'connected'),
  ('10a00000-0000-4000-a000-000000000002', 'microsoft_mail', 'check-10-other@example.invalid', 'connected');

-- A message the way _shared/graph-message.ts toMailRow() hands it over.
create function pg_temp.mail(p_id text, p_thread text, p_mid text, p_dir text, p_minutes int)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'external_id', p_id, 'thread_external_id', p_thread, 'internet_message_id', p_mid,
    'direction', p_dir,
    'from_email', case when p_dir = 'inbound' then 'customer@check-10.invalid' else 'check-10@example.invalid' end,
    'subject', 'check-10 ' || p_thread, 'body_text', 'Hello', 'body_html', '', 'snippet', 'Hello',
    'sent_at', (now() - make_interval(mins => p_minutes))::text);
$$;

create function pg_temp.thread_folder(p_connection uuid, p_thread text)
returns text
language sql
as $$
  select coalesce((select folder from public.mail_threads
                   where connection_id = p_connection and external_id = p_thread), 'no thread');
$$;

create function pg_temp.message_folder(p_connection uuid, p_message text)
returns text
language sql
as $$
  select coalesce((select m.folder from public.mail_messages m
                   join public.mail_threads t on t.id = m.thread_id
                   where t.connection_id = p_connection and m.external_id = p_message), 'no message');
$$;

select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('x-1', 'conv-x', '<x-1@check-10.invalid>', 'inbound', 30),
  pg_temp.mail('x-2', 'conv-x', '<x-2@check-10.invalid>', 'inbound', 20),
  pg_temp.mail('y-1', 'conv-y', '<y-1@check-10.invalid>', 'inbound', 40)));
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('y-2', 'conv-y', '<y-2@check-10.invalid>', 'outbound', 35)));
select public.store_mail_batch('10a00000-0000-4000-a000-000000000002', 'inbox', jsonb_build_array(
  pg_temp.mail('x-1', 'conv-x', '<other-x-1@check-10.invalid>', 'inbound', 30)));

-- One of X's two messages is archived in Outlook.
select set_config('test.moved', public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['x-1'])::text, true);

insert into results(name, expected, actual, pass)
select 'ONE OF TWO: the message leaves the inbox; the conversation, with mail still there, stays',
       '1 · archive · inbox',
       current_setting('test.moved') || ' · ' || m.f || ' · ' || t.f,
       current_setting('test.moved') = '1' and m.f = 'archive' and t.f = 'inbox'
from (select pg_temp.message_folder('10a00000-0000-4000-a000-000000000001', 'x-1') as f) m,
     (select pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-x') as f) t;

insert into results(name, expected, actual, pass)
select 'OTHER MAILBOX: a message under the same Graph id elsewhere stays where it is', 'inbox · inbox',
       m.f || ' · ' || t.f, m.f = 'inbox' and t.f = 'inbox'
from (select pg_temp.message_folder('10a00000-0000-4000-a000-000000000002', 'x-1') as f) m,
     (select pg_temp.thread_folder('10a00000-0000-4000-a000-000000000002', 'conv-x') as f) t;

-- The other is deleted in Outlook: nothing of X is left in the inbox.
select set_config('test.moved', public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['x-2'])::text, true);

insert into results(name, expected, actual, pass)
select 'THE LAST ONE: the conversation leaves the inbox with it', '1 · archive',
       current_setting('test.moved') || ' · ' || t.f, current_setting('test.moved') = '1' and t.f = 'archive'
from (select pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-x') as f) t;

-- Y: the customer's message is archived; our reply stays in Sent.
select set_config('test.moved', public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['y-1'])::text, true);

insert into results(name, expected, actual, pass)
select 'WITH A REPLY IN SENT: the conversation leaves the inbox for Sent, where the reply stays', '1 · sent · sent',
       current_setting('test.moved') || ' · ' || t.f || ' · ' || m.f,
       current_setting('test.moved') = '1' and t.f = 'sent' and m.f = 'sent'
from (select pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-y') as f) t,
     (select pg_temp.message_folder('10a00000-0000-4000-a000-000000000001', 'y-2') as f) m;

-- The folder leg names a message that really is in an inbox, so it is the
-- folder that is refused.
insert into results(name, expected, actual, pass)
select 'NOTHING MORE: the same ids again, an id not stored, no ids, or a folder other than the inbox',
       '0 · 0 · 0 · 0 · inbox',
       concat_ws(' · ',
         public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['x-1', 'x-2']),
         public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['never-stored']),
         public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', null),
         public.mail_left_folder('10a00000-0000-4000-a000-000000000002', 'sent', array['x-1']),
         pg_temp.message_folder('10a00000-0000-4000-a000-000000000002', 'x-1')),
       public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['x-1', 'x-2']) = 0
         and public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', array['never-stored']) = 0
         and public.mail_left_folder('10a00000-0000-4000-a000-000000000001', 'inbox', null) = 0
         and public.mail_left_folder('10a00000-0000-4000-a000-000000000002', 'sent', array['x-1']) = 0
         and pg_temp.message_folder('10a00000-0000-4000-a000-000000000002', 'x-1') = 'inbox';

insert into results(name, expected, actual, pass)
select 'NOTHING DELETED: every message is still stored', '4 · 1',
       count(*) filter (where t.connection_id = '10a00000-0000-4000-a000-000000000001') || ' · ' ||
       count(*) filter (where t.connection_id = '10a00000-0000-4000-a000-000000000002'),
       count(*) filter (where t.connection_id = '10a00000-0000-4000-a000-000000000001') = 4
         and count(*) filter (where t.connection_id = '10a00000-0000-4000-a000-000000000002') = 1
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id in ('10a00000-0000-4000-a000-000000000001', '10a00000-0000-4000-a000-000000000002');

-- x-1 is moved back into the inbox in Outlook, and comes back under a new id.
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('x-1-back', 'conv-x', '<x-1@check-10.invalid>', 'inbound', 30)));

insert into results(name, expected, actual, pass)
select 'BACK IN THE INBOX: it takes over the copy filed away, and the conversation is back',
       '2 messages · x-1-back in inbox · conversation in inbox',
       count(*) || ' messages · ' ||
       coalesce(max(m.external_id) filter (where m.internet_message_id = '<x-1@check-10.invalid>'), 'none') || ' in ' ||
       coalesce(max(m.folder) filter (where m.internet_message_id = '<x-1@check-10.invalid>'), 'none') ||
       ' · conversation in ' || pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-x'),
       count(*) = 2
         and max(m.external_id) filter (where m.internet_message_id = '<x-1@check-10.invalid>') = 'x-1-back'
         and max(m.folder) filter (where m.internet_message_id = '<x-1@check-10.invalid>') = 'inbox'
         and pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-x') = 'inbox'
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id = '10a00000-0000-4000-a000-000000000001' and t.external_id = 'conv-x';

-- W is archived in Outlook, and a sync of the archive gets there before the
-- inbox's delta says so: it takes over the inbox copy, under the new id.
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('w-1', 'conv-w', '<w-1@check-10.invalid>', 'inbound', 60)));
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'archive', jsonb_build_array(
  pg_temp.mail('w-1-archived', 'conv-w', '<w-1@check-10.invalid>', 'inbound', 60)));

insert into results(name, expected, actual, pass)
select 'AN ARCHIVE SYNC: taking over the last inbox copy takes the conversation out of the inbox',
       '1 · w-1-archived in archive · archive',
       count(*) || ' · ' || coalesce(max(m.external_id), 'none') || ' in ' || coalesce(max(m.folder), 'none')
         || ' · ' || pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-w'),
       count(*) = 1 and max(m.external_id) = 'w-1-archived' and max(m.folder) = 'archive'
         and pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-w') = 'archive'
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id = '10a00000-0000-4000-a000-000000000001' and t.external_id = 'conv-w';

-- We answer W from Outlook.
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'sent', jsonb_build_array(
  pg_temp.mail('w-2', 'conv-w', '<w-2@check-10.invalid>', 'outbound', 5)));

insert into results(name, expected, actual, pass)
select 'OUR REPLY TO A FILED CONVERSATION: it is back under Sent, where the workspace lists it', 'sent', t.f, t.f = 'sent'
from (select pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-w') as f) t;

-- Z: a sender reuses a Message-ID for a different message, which turns up in
-- the archive while the first is still in the inbox.
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('z-1', 'conv-z', '<z@check-10.invalid>', 'inbound', 50)));
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'archive', jsonb_build_array(
  pg_temp.mail('z-2', 'conv-z', '<z@check-10.invalid>', 'inbound', 10)));

insert into results(name, expected, actual, pass)
select 'A REUSED MESSAGE-ID: a different message is stored beside the first, which stays in the inbox',
       '2 · z-1 in inbox · inbox',
       count(*) || ' · z-1 in ' || coalesce(max(m.folder) filter (where m.external_id = 'z-1'), 'none')
         || ' · ' || pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-z'),
       count(*) = 2 and max(m.folder) filter (where m.external_id = 'z-1') = 'inbox'
         and pg_temp.thread_folder('10a00000-0000-4000-a000-000000000001', 'conv-z') = 'inbox'
from public.mail_messages m
join public.mail_threads t on t.id = m.thread_id
where t.connection_id = '10a00000-0000-4000-a000-000000000001' and t.external_id = 'conv-z';

-- S, for the daily comparison: s-1 still in Outlook's listing, s-2 gone from
-- it, s-3 back under a new id (listed by its Message-ID), s-edge sent inside
-- the hour after the listing starts, s-old long before.
select public.store_mail_batch('10a00000-0000-4000-a000-000000000001', 'inbox', jsonb_build_array(
  pg_temp.mail('s-1', 'conv-s', '<s-1@check-10.invalid>', 'inbound', 120),
  pg_temp.mail('s-2', 'conv-s', '<s-2@check-10.invalid>', 'inbound', 100),
  pg_temp.mail('s-3', 'conv-s', '<s-3@check-10.invalid>', 'inbound', 90),
  pg_temp.mail('s-edge', 'conv-s', '<s-edge@check-10.invalid>', 'inbound', 1410),
  pg_temp.mail('s-old', 'conv-s', '<s-old@check-10.invalid>', 'inbound', 3000)));

insert into results(name, expected, actual, pass)
select 'COMPARED WITH OUTLOOK: what a listing no longer has — by id or Message-ID, inside its reach, this mailbox only, newest first, at most so many',
       's-2 · x-1-back z-1 · x-1',
       a.v || ' · ' || b.v || ' · ' || c.v,
       a.v = 's-2' and b.v = 'x-1-back z-1' and c.v = 'x-1'
from (select array_to_string(public.inbox_messages_missing('10a00000-0000-4000-a000-000000000001',
        now() - interval '1 day', array['s-1', 'x-1-back', 'z-1'], array['<s-3@check-10.invalid>'], 10), ' ') as v) a,
     (select array_to_string(public.inbox_messages_missing('10a00000-0000-4000-a000-000000000001',
        now() - interval '1 day', array[]::text[], array[]::text[], 2), ' ') as v) b,
     (select array_to_string(public.inbox_messages_missing('10a00000-0000-4000-a000-000000000002',
        now() - interval '1 day', array[]::text[], array[]::text[], 10), ' ') as v) c;

-- A listing that ran out holds the whole inbox, and says so with '-infinity'
-- (coveredSince in inbox-sweep.ts): an hour on from that is still everything.
insert into results(name, expected, actual, pass)
select 'THE WHOLE INBOX: a listing that ran out reaches back past any day', 's-2 s-edge s-old', a.v,
       a.v = 's-2 s-edge s-old'
from (select array_to_string(public.inbox_messages_missing('10a00000-0000-4000-a000-000000000001',
        '-infinity', array['s-1', 'x-1-back', 'z-1'], array['<s-3@check-10.invalid>'], 10), ' ') as v) a;

insert into results(name, expected, actual, pass)
select 'AMONG WHAT WAS REPORTED GONE: only what this mailbox still shows in its inbox', 's-1 s-2 · x-1',
       a.v || ' · ' || b.v, a.v = 's-1 s-2' and b.v = 'x-1'
from (select array_to_string(array(select unnest(public.inbox_messages_among('10a00000-0000-4000-a000-000000000001',
        array['s-2', 's-1', 'x-1', 'w-1-archived', 'never-stored'])) order by 1), ' ') as v) a,
     (select array_to_string(public.inbox_messages_among('10a00000-0000-4000-a000-000000000002',
        array['x-1']), ' ') as v) b;

-- A message with no folder could never be filed, nor seen to be in the inbox.
do $$
begin
  insert into public.mail_messages (thread_id, external_id, sent_at, folder)
  select id, 'check-10-no-folder', now(), null
  from public.mail_threads
  where connection_id = '10a00000-0000-4000-a000-000000000001' and external_id = 'conv-x';
  perform set_config('test.no_folder', 'stored', true);
exception
  when check_violation then perform set_config('test.no_folder', 'refused', true);
  when others then perform set_config('test.no_folder', 'failed another way: ' || sqlerrm, true);
end
$$;

insert into results(name, expected, actual, pass)
select 'NO FOLDER: a message that says nowhere is refused', 'refused',
       current_setting('test.no_folder'), current_setting('test.no_folder') = 'refused';

do $$
begin
  perform public.file_threads_out_of_inbox(array[]::uuid[], 'sent');
  perform set_config('test.file_to', 'filed', true);
exception when others then
  -- Only the helper's own refusal counts: a permission error, or any other
  -- failure, is said as what it was.
  perform set_config('test.file_to',
    case when sqlerrm like '%cannot file a conversation to sent%' then 'refused' else sqlerrm end, true);
end
$$;

insert into results(name, expected, actual, pass)
select 'SENT IS EARNED: a conversation goes to Sent for a reply of ours in it, never on request', 'refused',
       current_setting('test.file_to'), current_setting('test.file_to') = 'refused';

insert into results(name, expected, actual, pass)
select 'GRANTS: the sync runs what it needs; a signed-in person and anon run none of it', 'sync yes · others no',
       'sync ' || case when g.sync then 'yes' else 'no' end || ' · others ' || case when g.others then 'yes' else 'no' end,
       g.sync and not g.others
from (select
        has_function_privilege('service_role', 'public.mail_left_folder(uuid, text, text[])', 'execute')
          and has_function_privilege('service_role', 'public.inbox_messages_among(uuid, text[])', 'execute')
          and has_function_privilege('service_role', 'public.inbox_messages_missing(uuid, timestamptz, text[], text[], int)', 'execute')
          and has_function_privilege('service_role', 'public.store_mail_batch(uuid, text, jsonb)', 'execute') as sync,
        (select bool_or(has_function_privilege(r.role_name::name, f.sig, 'execute'))
         from unnest(array['authenticated', 'anon']) as r(role_name),
              unnest(array['public.mail_left_folder(uuid, text, text[])',
                           'public.inbox_messages_among(uuid, text[])',
                           'public.inbox_messages_missing(uuid, timestamptz, text[], text[], int)',
                           'public.file_threads_out_of_inbox(uuid[], text)',
                           'public.store_mail_batch(uuid, text, jsonb)']) as f(sig)) as others) g;

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
