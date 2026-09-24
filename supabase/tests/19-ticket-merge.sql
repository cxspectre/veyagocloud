-- 19-ticket-merge.sql — a duplicate ticket merged into the one kept (0054).
--
-- Merging moves everything the dropped ticket holds onto the ticket kept: its
-- thread, each message still linked to its mail; its notes; and its
-- conversations, in whichever mailbox. The ticket kept takes the earlier first
-- response and keeps its status and assignee; the dropped one is closed and
-- points at it, and each says in an internal note which was merged into which.
-- A reply quoting the dropped ticket's number, in a new conversation or in its
-- old one, lands on the ticket kept — after further merges, on the ticket they
-- lead to, and on none once that one is deleted — and "Create ticket" on a
-- conversation still attached to the dropped ticket hands back the same ticket.
-- A merge locks the conversations before the tickets, in the order the sync
-- takes them, and holds them until its transaction ends.
-- Refused: a ticket into itself, a deleted or an already merged ticket on either
-- side, a loop, anyone who is not staff — the OWNER included, in a session that
-- skipped their second factor — anon, and setting merged_into_id by hand.
--
-- NOTE ON STRUCTURE, as in 04 and 11: merge_tickets(), route_mail_to_ticket()
-- and create_ticket_from_thread() are always called in their own statement
-- before anything asserts on them. Mail is stored and routed as the table owner,
-- the way the sync does; the OWNER merges and opens tickets at aal2, and the
-- assistant, woken as an employee for this transaction, merges once too. Checks
-- that read what 0054 adds go through pg_temp.check(), so a database without it
-- reports each of them as a FAIL rather than stopping at the first. Everything
-- is rolled back.
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

-- A query that answers (actual text, pass boolean). An error is a named FAIL,
-- not the end of the suite.
create function pg_temp.check(p_name text, p_expected text, p_query text)
returns void
language plpgsql
as $$
declare
  v_actual text;
  v_pass   boolean;
begin
  execute p_query into v_actual, v_pass;
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, coalesce(v_actual, 'null'), coalesce(v_pass, false));
exception when others then
  insert into results(name, expected, actual, pass)
  values (p_name, p_expected, 'error: ' || left(sqlerrm, 90), false);
end;
$$;

-- A customer's message, stored the way the sync stores one, under its
-- conversation's subject unless it says otherwise.
create function pg_temp.customer_writes(p_id uuid, p_thread uuid, p_body text, p_minutes int, p_subject text default null)
returns void
language sql
as $$
  insert into public.mail_messages (id, thread_id, external_id, direction, from_email, subject, body_text, sent_at, folder)
  select p_id, t.id, 'check-19-' || p_id, 'inbound', 'customer@check-19.invalid',
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
grant execute on function pg_temp.check(text, text, text) to authenticated, anon;
grant execute on function pg_temp.filed(uuid, text) to authenticated, anon;

-- ── Fixtures, as the table owner ─────────────────────────────────────────
-- The assistant, inactive in real life, is woken as an employee: staff who is
-- not a manager merges too.
update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

select set_config('test.owner_employee',
  (select id::text from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), true);
select set_config('test.assistant_employee',
  (select id::text from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), true);

insert into public.crm_companies (id, name, domain) values
  ('19a00000-0000-4000-a000-000000000001', 'check-19 Co', 'check-19.invalid');
insert into public.crm_contacts (id, company_id, full_name, email) values
  ('19a00000-0000-4000-a000-000000000002', '19a00000-0000-4000-a000-000000000001',
   'check-19 Customer', 'customer@check-19.invalid');
-- The studio's mailbox (…03), and the assistant's own (…04).
insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('19a00000-0000-4000-a000-000000000003', 'microsoft_mail', 'check-19@example.invalid', null, 'connected'),
  ('19a00000-0000-4000-a000-000000000004', 'microsoft_mail', 'check-19-assistant@example.invalid',
   current_setting('test.assistant_employee')::uuid, 'connected');

-- Tickets. K (…11) is kept and D (…12) dropped into it. X (…13) is deleted, L
-- (…14) is live and about something else, and J (…15) is where K ends up. A,
-- B and C (…16-…18) make a chain.
insert into public.support_tickets (id, subject, contact_id, company_id, priority) values
  ('19a00000-0000-4000-a000-000000000011', 'check-19 Kept: the app will not sync',
   '19a00000-0000-4000-a000-000000000002', '19a00000-0000-4000-a000-000000000001', 'high'),
  ('19a00000-0000-4000-a000-000000000012', 'check-19 Dropped: syncing is broken again',
   '19a00000-0000-4000-a000-000000000002', '19a00000-0000-4000-a000-000000000001', 'normal'),
  ('19a00000-0000-4000-a000-000000000014', 'check-19 Live, about something else',
   '19a00000-0000-4000-a000-000000000002', null, 'normal'),
  ('19a00000-0000-4000-a000-000000000015', 'check-19 Where the kept ticket ends up',
   '19a00000-0000-4000-a000-000000000002', null, 'normal'),
  ('19a00000-0000-4000-a000-000000000016', 'check-19 Chain A', null, null, 'normal'),
  ('19a00000-0000-4000-a000-000000000017', 'check-19 Chain B', null, null, 'normal'),
  ('19a00000-0000-4000-a000-000000000018', 'check-19 Chain C', null, null, 'normal');
insert into public.support_tickets (id, subject, contact_id, deleted_at) values
  ('19a00000-0000-4000-a000-000000000013', 'check-19 Deleted', '19a00000-0000-4000-a000-000000000002', now());

-- Conversations in the studio's mailbox, but …23 in the assistant's own: with K
-- (…21), with D (…22, …23), and six more for the replies and "Create ticket"
-- below (…24-…29).
insert into public.mail_threads (id, connection_id, external_id, subject) values
  ('19a00000-0000-4000-a000-000000000021', '19a00000-0000-4000-a000-000000000003', 'check-19-kept',
   'Re: check-19 Kept: the app will not sync ' || pg_temp.ref('19a00000-0000-4000-a000-000000000011')),
  ('19a00000-0000-4000-a000-000000000022', '19a00000-0000-4000-a000-000000000003', 'check-19-dropped',
   'Re: check-19 Dropped: syncing is broken again ' || pg_temp.ref('19a00000-0000-4000-a000-000000000012')),
  ('19a00000-0000-4000-a000-000000000023', '19a00000-0000-4000-a000-000000000004', 'check-19-dropped-personal',
   'Re: check-19 Dropped: syncing is broken again ' || pg_temp.ref('19a00000-0000-4000-a000-000000000012')),
  ('19a00000-0000-4000-a000-000000000024', '19a00000-0000-4000-a000-000000000003', 'check-19-new',
   'check-19 Following up'),
  ('19a00000-0000-4000-a000-000000000025', '19a00000-0000-4000-a000-000000000003', 'check-19-still-attached',
   'check-19 A conversation with no reference'),
  ('19a00000-0000-4000-a000-000000000026', '19a00000-0000-4000-a000-000000000003', 'check-19-create',
   'check-19 Another conversation with no reference'),
  ('19a00000-0000-4000-a000-000000000027', '19a00000-0000-4000-a000-000000000003', 'check-19-chain',
   'check-19 Following up once more'),
  ('19a00000-0000-4000-a000-000000000028', '19a00000-0000-4000-a000-000000000003', 'check-19-chain-create',
   'check-19 A third conversation with no reference'),
  ('19a00000-0000-4000-a000-000000000029', '19a00000-0000-4000-a000-000000000003', 'check-19-deleted-end',
   'check-19 One last time');

-- The customer writes about K once and about D twice, D the second time to the
-- assistant's own address; the sync routes each.
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000031', '19a00000-0000-4000-a000-000000000021',
  'check-19 The app will not sync.', 240);
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000032', '19a00000-0000-4000-a000-000000000022',
  'check-19 Syncing is broken again.', 180);
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000033', '19a00000-0000-4000-a000-000000000023',
  'check-19 Writing to your colleague about it too.', 170);

-- Their own statements. See the note above.
select public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000031') as routed_to;
select public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000032') as routed_to;
select public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000033') as routed_to;

-- Our replies — D's delivered two hours ago, before K's half an hour ago — and
-- an internal note on D.
insert into public.ticket_messages (id, ticket_id, author_employee_id, direction, body) values
  ('19a00000-0000-4000-a000-000000000061', '19a00000-0000-4000-a000-000000000011',
   current_setting('test.owner_employee')::uuid, 'outbound', 'check-19 We are looking into it.'),
  ('19a00000-0000-4000-a000-000000000062', '19a00000-0000-4000-a000-000000000012',
   current_setting('test.owner_employee')::uuid, 'outbound', 'check-19 Could you sign out and in again?'),
  ('19a00000-0000-4000-a000-000000000063', '19a00000-0000-4000-a000-000000000012',
   current_setting('test.owner_employee')::uuid, 'internal', 'check-19 They are on the old plan.');
update public.ticket_messages set delivered_at = now() - interval '30 minutes'
where id = '19a00000-0000-4000-a000-000000000061';
update public.ticket_messages set delivered_at = now() - interval '2 hours'
where id = '19a00000-0000-4000-a000-000000000062';

-- Notes: two on D, one on K, one on L.
insert into public.workspace_notes (id, entity_type, entity_id, author_id, body) values
  ('19a00000-0000-4000-a000-000000000051', 'ticket', '19a00000-0000-4000-a000-000000000012',
   current_setting('test.owner_employee')::uuid, 'check-19 D''s first note'),
  ('19a00000-0000-4000-a000-000000000052', 'ticket', '19a00000-0000-4000-a000-000000000012',
   current_setting('test.owner_employee')::uuid, 'check-19 D''s second note'),
  ('19a00000-0000-4000-a000-000000000053', 'ticket', '19a00000-0000-4000-a000-000000000011',
   current_setting('test.owner_employee')::uuid, 'check-19 K''s note'),
  ('19a00000-0000-4000-a000-000000000054', 'ticket', '19a00000-0000-4000-a000-000000000014',
   current_setting('test.owner_employee')::uuid, 'check-19 A note on another ticket');

-- K is in progress with the assistant; D waits on the customer, with the OWNER.
update public.support_tickets
set status = 'in_progress', assignee_id = current_setting('test.assistant_employee')::uuid
where id = '19a00000-0000-4000-a000-000000000011';
update public.support_tickets
set status = 'waiting', assignee_id = current_setting('test.owner_employee')::uuid
where id = '19a00000-0000-4000-a000-000000000012';

select set_config('test.d_messages',
  (select string_agg(id::text, ',') from public.ticket_messages where ticket_id = '19a00000-0000-4000-a000-000000000012'), true);
select set_config('test.k_messages',
  (select string_agg(id::text, ',') from public.ticket_messages where ticket_id = '19a00000-0000-4000-a000-000000000011'), true);
-- Counted by this suite's subjects, not the whole table: the live project has
-- real tickets, and people may open one while this runs.
select set_config('test.tickets_before',
  (select count(*) from public.support_tickets where subject like '%check-19%')::text, true);

insert into results(name, expected, actual, pass)
select 'BEFORE: D holds four messages and two notes, K two messages, and D was answered first, so nothing below passes by moving nothing',
       '4 · 2 · 2 · D first',
       d.n || ' · ' || dn.n || ' · ' || k.n || ' · ' ||
         case when dt.first_response_at < kt.first_response_at then 'D first' else 'not D first' end,
       d.n = 4 and dn.n = 2 and k.n = 2 and dt.first_response_at < kt.first_response_at
from (select count(*) as n from public.ticket_messages where ticket_id = '19a00000-0000-4000-a000-000000000012') d,
     (select count(*) as n from public.workspace_notes
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000012') dn,
     (select count(*) as n from public.ticket_messages where ticket_id = '19a00000-0000-4000-a000-000000000011') k,
     public.support_tickets dt, public.support_tickets kt
where dt.id = '19a00000-0000-4000-a000-000000000012' and kt.id = '19a00000-0000-4000-a000-000000000011';

-- ── Who may merge ────────────────────────────────────────────────────────
-- A verified second factor for the OWNER: a session that skipped it is not staff
-- (0040).
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('19a00000-0000-4000-a000-0000000000f1', 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093',
        'check-db 19', 'totp', 'verified', now(), now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19a00000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('STAFF ONLY: not someone signed in who is not on the team', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000012')
$sql$, 'Staff only');

select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal1"}', true);

select pg_temp.refused('SECOND FACTOR: not the OWNER, in a session that skipped their code', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000012')
$sql$, 'Staff only');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select pg_temp.refused('GRANTS: not anon', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000012')
$sql$, 'permission denied');

reset role;

-- ── The OWNER: what cannot be merged ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select pg_temp.refused('REFUSED: a ticket into itself', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000011')
$sql$, 'merged into itself');

select pg_temp.refused('REFUSED: without a ticket to keep', $sql$
  select public.merge_tickets(null, '19a00000-0000-4000-a000-000000000012')
$sql$, 'Choose the ticket to keep');

select pg_temp.refused('REFUSED: a ticket that does not exist', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000099')
$sql$, 'No such ticket');

select pg_temp.refused('REFUSED: a deleted ticket, merged into a live one', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000013')
$sql$, 'is deleted');

select pg_temp.refused('REFUSED: a live ticket, merged into a deleted one', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000013', '19a00000-0000-4000-a000-000000000012')
$sql$, 'is deleted');

select pg_temp.refused('BY HAND: staff cannot point a ticket at another by editing it', $sql$
  update public.support_tickets set merged_into_id = '19a00000-0000-4000-a000-000000000011'
  where id = '19a00000-0000-4000-a000-000000000014'
$sql$, 'merge_tickets');

select pg_temp.refused('BY HAND: nor open a ticket already merged', $sql$
  insert into public.support_tickets (subject, merged_into_id)
  values ('check-19 Planted', '19a00000-0000-4000-a000-000000000011')
$sql$, 'merge_tickets');

-- ── The OWNER merges D into K ────────────────────────────────────────────
-- Conversations before tickets, the order the sync takes them in (0045): before
-- it locks either ticket, the merge holds mail_threads in SHARE ROW EXCLUSIVE
-- mode, which shuts out every writer of conversations until its transaction
-- ends. A sync batch in flight is waited for, and none files a reply while the
-- merge runs. The refusals above that got as far as that lock took it inside
-- their own subtransactions, which let it go again.
select pg_temp.check('LOCKS: before the merge, this transaction does not hold the conversations', 'not held', $sql$
  select case when held then 'held' else 'not held' end, not held
  from (select exists (select 1 from pg_locks
                       where locktype = 'relation' and relation = 'public.mail_threads'::regclass
                         and pid = pg_backend_pid() and mode = 'ShareRowExclusiveLock' and granted) as held) l
$sql$);

select set_config('test.merged', 'none', true);
select pg_temp.affects('MERGE: the OWNER merges D into K', $sql$
  select set_config('test.merged',
    public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000012')::text, true)
$sql$, 1);

select pg_temp.check('LOCKS: the merge holds the conversations, as the sync takes them, until its transaction ends', 'held', $sql$
  select case when held then 'held' else 'not held' end, held
  from (select exists (select 1 from pg_locks
                       where locktype = 'relation' and relation = 'public.mail_threads'::regclass
                         and pid = pg_backend_pid() and mode = 'ShareRowExclusiveLock' and granted) as held) l
$sql$);

select pg_temp.refused('REFUSED: D again, now that it is merged', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000011', '19a00000-0000-4000-a000-000000000012')
$sql$, 'already merged');

select pg_temp.refused('REFUSED: another ticket into D, now that it is merged', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000012', '19a00000-0000-4000-a000-000000000014')
$sql$, 'already merged');

select pg_temp.refused('REFUSED: K back into D, a loop', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000012', '19a00000-0000-4000-a000-000000000011')
$sql$, 'would make a loop');

select pg_temp.refused('BY HAND: nor undo a merge by editing the ticket', $sql$
  update public.support_tickets set merged_into_id = null
  where id = '19a00000-0000-4000-a000-000000000012'
$sql$, 'merge_tickets');

-- A into B, then B into C; C into A would close the circle.
select pg_temp.affects('CHAIN: A merged into B goes through', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000017', '19a00000-0000-4000-a000-000000000016')
$sql$, 1);

select pg_temp.affects('CHAIN: and B into C', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000018', '19a00000-0000-4000-a000-000000000017')
$sql$, 1);

select pg_temp.refused('REFUSED: C into A, which already leads to C, a loop', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000016', '19a00000-0000-4000-a000-000000000018')
$sql$, 'would make a loop');

reset role;

-- ── What the merge did ───────────────────────────────────────────────────
insert into results(name, expected, actual, pass)
select 'MERGE: hands back the ticket kept', 'K',
       case when current_setting('test.merged') = '19a00000-0000-4000-a000-000000000011' then 'K'
            else current_setting('test.merged') end,
       current_setting('test.merged') = '19a00000-0000-4000-a000-000000000011';

insert into results(name, expected, actual, pass)
select 'THREAD: all four messages D held are on K now: the customer''s mail, our reply and D''s internal note',
       '4 on K',
       count(*) filter (where ticket_id = '19a00000-0000-4000-a000-000000000011') || ' on K'
         || case when count(*) filter (where ticket_id <> '19a00000-0000-4000-a000-000000000011') > 0
                 then ', ' || count(*) filter (where ticket_id <> '19a00000-0000-4000-a000-000000000011') || ' elsewhere'
                 else '' end,
       count(*) = 4 and count(*) filter (where ticket_id = '19a00000-0000-4000-a000-000000000011') = 4
from public.ticket_messages
where id = any(string_to_array(current_setting('test.d_messages'), ',')::uuid[]);

insert into results(name, expected, actual, pass)
select 'THREAD: each still linked to its mail, from either mailbox', 'on the ticket · on the ticket',
       pg_temp.filed('19a00000-0000-4000-a000-000000000032', '19a00000-0000-4000-a000-000000000011') || ' · ' ||
         pg_temp.filed('19a00000-0000-4000-a000-000000000033', '19a00000-0000-4000-a000-000000000011'),
       pg_temp.filed('19a00000-0000-4000-a000-000000000032', '19a00000-0000-4000-a000-000000000011') = 'on the ticket'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000033', '19a00000-0000-4000-a000-000000000011') = 'on the ticket';

insert into results(name, expected, actual, pass)
select 'THREAD: K keeps its own two, and holds seven in all — its two, D''s four and the note on the merge',
       '2 of its own · 7 in all',
       own.n || ' of its own · ' || total.n || ' in all', own.n = 2 and total.n = 7
from (select count(*) as n from public.ticket_messages
      where ticket_id = '19a00000-0000-4000-a000-000000000011'
        and id = any(string_to_array(current_setting('test.k_messages'), ',')::uuid[])) own,
     (select count(*) as n from public.ticket_messages
      where ticket_id = '19a00000-0000-4000-a000-000000000011') total;

insert into results(name, expected, actual, pass)
select 'NOTES: D''s notes are on K, and a note on another ticket stays where it is',
       '3 on K · 0 on D · 1 on L',
       k.n || ' on K · ' || d.n || ' on D · ' || l.n || ' on L', k.n = 3 and d.n = 0 and l.n = 1
from (select count(*) as n from public.workspace_notes
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000011') k,
     (select count(*) as n from public.workspace_notes
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000012') d,
     (select count(*) as n from public.workspace_notes
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000014') l;

insert into results(name, expected, actual, pass)
select 'CONVERSATIONS: D''s point at K, the one in a colleague''s own mailbox too', 'K · K',
       string_agg(case when ticket_id = '19a00000-0000-4000-a000-000000000011' then 'K'
                       when ticket_id = '19a00000-0000-4000-a000-000000000012' then 'D'
                       else coalesce(ticket_id::text, 'no ticket') end, ' · ' order by id),
       count(*) = 2 and bool_and(ticket_id is not distinct from '19a00000-0000-4000-a000-000000000011'::uuid)
from public.mail_threads
where id in ('19a00000-0000-4000-a000-000000000022', '19a00000-0000-4000-a000-000000000023');

insert into results(name, expected, actual, pass)
select 'FIRST RESPONSE: K takes the earlier of the two, D''s, two hours ago', 'two hours ago',
       case when first_response_at = now() - interval '2 hours' then 'two hours ago'
            when first_response_at = now() - interval '30 minutes' then 'half an hour ago'
            else coalesce(first_response_at::text, 'none') end,
       first_response_at is not distinct from now() - interval '2 hours'
from public.support_tickets where id = '19a00000-0000-4000-a000-000000000011';

insert into results(name, expected, actual, pass)
select 'FIRST RESPONSE: D still says when its customer first heard back', 'two hours ago',
       case when first_response_at = now() - interval '2 hours' then 'two hours ago'
            else coalesce(first_response_at::text, 'none') end,
       first_response_at is not distinct from now() - interval '2 hours'
from public.support_tickets where id = '19a00000-0000-4000-a000-000000000012';

insert into results(name, expected, actual, pass)
select 'KEPT: K''s status, assignee and priority are as they were', 'in_progress · the assistant · high',
       status || ' · ' ||
         case when assignee_id = current_setting('test.assistant_employee')::uuid then 'the assistant'
              else coalesce(assignee_id::text, 'nobody') end || ' · ' || priority,
       status = 'in_progress' and assignee_id is not distinct from current_setting('test.assistant_employee')::uuid
         and priority = 'high'
from public.support_tickets where id = '19a00000-0000-4000-a000-000000000011';

select pg_temp.check('DROPPED: D is closed, and points at K', 'closed · merged into K', $sql$
  select status || ' · ' ||
           case when merged_into_id = '19a00000-0000-4000-a000-000000000011' then 'merged into K'
                else coalesce('merged into ' || merged_into_id::text, 'not merged') end,
         status = 'closed' and merged_into_id is not distinct from '19a00000-0000-4000-a000-000000000011'::uuid
  from public.support_tickets where id = '19a00000-0000-4000-a000-000000000012'
$sql$);

insert into results(name, expected, actual, pass)
select 'NOTE: both tickets say, in an internal note by the OWNER, that D''s number was merged into K''s',
       '1 on K · 1 on D',
       k.n || ' on K · ' || d.n || ' on D', k.n = 1 and d.n = 1
from (select '%#VYG-' || (select number from public.support_tickets where id = '19a00000-0000-4000-a000-000000000012')
             || ' into #VYG-' || (select number from public.support_tickets where id = '19a00000-0000-4000-a000-000000000011')
             || '%' as phrase) p,
     lateral (select count(*) as n from public.ticket_messages
              where ticket_id = '19a00000-0000-4000-a000-000000000011' and direction = 'internal'
                and author_employee_id = current_setting('test.owner_employee')::uuid
                and body like p.phrase) k,
     lateral (select count(*) as n from public.ticket_messages
              where ticket_id = '19a00000-0000-4000-a000-000000000012' and direction = 'internal'
                and author_employee_id = current_setting('test.owner_employee')::uuid
                and body like p.phrase) d;

insert into results(name, expected, actual, pass)
select 'DROPPED: D holds nothing but that note', '1 message', count(*) || ' message', count(*) = 1
from public.ticket_messages where ticket_id = '19a00000-0000-4000-a000-000000000012';

insert into results(name, expected, actual, pass)
select 'ACTIVITY: the feed says D was merged into K, not that it was resolved', 'merged · not resolved',
       case when m.n > 0 then 'merged' else 'not merged' end || ' · ' ||
         case when r.n > 0 then 'resolved' else 'not resolved' end,
       m.n = 1 and r.n = 0
from (select count(*) as n from public.workspace_activity
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000012'
        and summary like 'Merged #VYG-' || (select number from public.support_tickets where id = '19a00000-0000-4000-a000-000000000012')
                         || ' into #VYG-' || (select number from public.support_tickets where id = '19a00000-0000-4000-a000-000000000011')
                         || ' %') m,
     (select count(*) as n from public.workspace_activity
      where entity_type = 'ticket' and entity_id = '19a00000-0000-4000-a000-000000000012'
        and verb = 'resolved') r;

-- ── The customer writes again ────────────────────────────────────────────
-- Quoting D's number in a new conversation (…41), and in D's old one (…42).
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000041', '19a00000-0000-4000-a000-000000000024',
  'check-19 Any news?', 60,
  'Re: check-19 Dropped: syncing is broken again ' || pg_temp.ref('19a00000-0000-4000-a000-000000000012'));
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000042', '19a00000-0000-4000-a000-000000000022',
  'check-19 Still broken here.', 50);

select set_config('test.routed_41', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000041')::text, 'null'), true);
select set_config('test.routed_42', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000042')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'ROUTING: a reply quoting D''s number, in a new conversation, lands on K, and the conversation goes to K',
       'on the ticket · conversation on K',
       pg_temp.filed('19a00000-0000-4000-a000-000000000041', '19a00000-0000-4000-a000-000000000011')
         || ' · conversation on ' ||
         case when t.ticket_id = '19a00000-0000-4000-a000-000000000011' then 'K'
              when t.ticket_id = '19a00000-0000-4000-a000-000000000012' then 'D'
              else coalesce(t.ticket_id::text, 'nothing') end,
       current_setting('test.routed_41') = '19a00000-0000-4000-a000-000000000011'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000041', '19a00000-0000-4000-a000-000000000011') = 'on the ticket'
         and t.ticket_id is not distinct from '19a00000-0000-4000-a000-000000000011'::uuid
from public.mail_threads t where t.id = '19a00000-0000-4000-a000-000000000024';

insert into results(name, expected, actual, pass)
select 'ROUTING: a reply in D''s old conversation lands on K', 'on the ticket',
       pg_temp.filed('19a00000-0000-4000-a000-000000000042', '19a00000-0000-4000-a000-000000000011'),
       current_setting('test.routed_42') = '19a00000-0000-4000-a000-000000000011'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000042', '19a00000-0000-4000-a000-000000000011') = 'on the ticket';

-- A conversation still attached to D, as a link written while the merge ran
-- could leave one, and a reply in it that quotes nothing.
update public.mail_threads set ticket_id = '19a00000-0000-4000-a000-000000000012'
where id = '19a00000-0000-4000-a000-000000000025';
select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000043', '19a00000-0000-4000-a000-000000000025',
  'check-19 No reference in this one.', 40);
select set_config('test.routed_43', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000043')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'ROUTING: a conversation still attached to D follows the merge to K, and moves to K',
       'on the ticket · conversation on K',
       pg_temp.filed('19a00000-0000-4000-a000-000000000043', '19a00000-0000-4000-a000-000000000011')
         || ' · conversation on ' ||
         case when t.ticket_id = '19a00000-0000-4000-a000-000000000011' then 'K'
              when t.ticket_id = '19a00000-0000-4000-a000-000000000012' then 'D'
              else coalesce(t.ticket_id::text, 'nothing') end,
       current_setting('test.routed_43') = '19a00000-0000-4000-a000-000000000011'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000043', '19a00000-0000-4000-a000-000000000011') = 'on the ticket'
         and t.ticket_id is not distinct from '19a00000-0000-4000-a000-000000000011'::uuid
from public.mail_threads t where t.id = '19a00000-0000-4000-a000-000000000025';

insert into results(name, expected, actual, pass)
select 'ROUTING: D stays closed, and K stays in progress with its assignee', 'D closed · K in_progress, the assistant',
       'D ' || d.status || ' · K ' || k.status || ', ' ||
         case when k.assignee_id = current_setting('test.assistant_employee')::uuid then 'the assistant'
              else coalesce(k.assignee_id::text, 'nobody') end,
       d.status = 'closed' and k.status = 'in_progress'
         and k.assignee_id is not distinct from current_setting('test.assistant_employee')::uuid
from public.support_tickets d, public.support_tickets k
where d.id = '19a00000-0000-4000-a000-000000000012' and k.id = '19a00000-0000-4000-a000-000000000011';

-- The sync again, over a message filed on D before the merge and one filed on K
-- after it.
select set_config('test.again_32', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000032')::text, 'null'), true);
select set_config('test.again_41', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000041')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'ROUTING: a message already filed, before the merge or after, is not filed again', 'K · K · 1 copy · 1 copy',
       case when current_setting('test.again_32') = '19a00000-0000-4000-a000-000000000011' then 'K'
            else current_setting('test.again_32') end || ' · ' ||
       case when current_setting('test.again_41') = '19a00000-0000-4000-a000-000000000011' then 'K'
            else current_setting('test.again_41') end || ' · ' ||
       a.n || ' copy · ' || b.n || ' copy',
       current_setting('test.again_32') = '19a00000-0000-4000-a000-000000000011'
         and current_setting('test.again_41') = '19a00000-0000-4000-a000-000000000011'
         and a.n = 1 and b.n = 1
from (select count(*) as n from public.ticket_messages
      where mail_message_id = '19a00000-0000-4000-a000-000000000032') a,
     (select count(*) as n from public.ticket_messages
      where mail_message_id = '19a00000-0000-4000-a000-000000000041') b;

-- ── "Create ticket" ──────────────────────────────────────────────────────
-- On D's old conversation, and on one still attached to D.
update public.mail_threads set ticket_id = '19a00000-0000-4000-a000-000000000012'
where id = '19a00000-0000-4000-a000-000000000026';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select set_config('test.create_22', 'none', true);
select pg_temp.affects('CREATE: "Create ticket" on D''s old conversation goes through', $sql$
  select set_config('test.create_22',
    public.create_ticket_from_thread('19a00000-0000-4000-a000-000000000022')::text, true)
$sql$, 1);

select set_config('test.create_26', 'none', true);
select pg_temp.affects('CREATE: and on a conversation still attached to D', $sql$
  select set_config('test.create_26',
    public.create_ticket_from_thread('19a00000-0000-4000-a000-000000000026')::text, true)
$sql$, 1);

reset role;

insert into results(name, expected, actual, pass)
select 'CREATE: both hand back K, and the conversation attached to D goes to K', 'K · K · conversation on K',
       case when current_setting('test.create_22') = '19a00000-0000-4000-a000-000000000011' then 'K'
            when current_setting('test.create_22') = '19a00000-0000-4000-a000-000000000012' then 'D'
            else current_setting('test.create_22') end || ' · ' ||
       case when current_setting('test.create_26') = '19a00000-0000-4000-a000-000000000011' then 'K'
            when current_setting('test.create_26') = '19a00000-0000-4000-a000-000000000012' then 'D'
            else current_setting('test.create_26') end || ' · conversation on ' ||
       case when t.ticket_id = '19a00000-0000-4000-a000-000000000011' then 'K'
            when t.ticket_id = '19a00000-0000-4000-a000-000000000012' then 'D'
            else coalesce(t.ticket_id::text, 'nothing') end,
       current_setting('test.create_22') = '19a00000-0000-4000-a000-000000000011'
         and current_setting('test.create_26') = '19a00000-0000-4000-a000-000000000011'
         and t.ticket_id is not distinct from '19a00000-0000-4000-a000-000000000011'::uuid
from public.mail_threads t where t.id = '19a00000-0000-4000-a000-000000000026';

-- ── K merged on, into J, by an employee who is not a manager ─────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

select pg_temp.affects('CHAIN: an employee merges K into J', $sql$
  select public.merge_tickets('19a00000-0000-4000-a000-000000000015', '19a00000-0000-4000-a000-000000000011')
$sql$, 1);

reset role;

select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000044', '19a00000-0000-4000-a000-000000000027',
  'check-19 Hello again.', 30,
  'Re: check-19 Dropped: syncing is broken again ' || pg_temp.ref('19a00000-0000-4000-a000-000000000012'));
select set_config('test.routed_44', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000044')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'CHAIN: a reply quoting D''s number, D merged into K and K into J, lands on J', 'on the ticket',
       pg_temp.filed('19a00000-0000-4000-a000-000000000044', '19a00000-0000-4000-a000-000000000015'),
       current_setting('test.routed_44') = '19a00000-0000-4000-a000-000000000015'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000044', '19a00000-0000-4000-a000-000000000015') = 'on the ticket';

update public.mail_threads set ticket_id = '19a00000-0000-4000-a000-000000000012'
where id = '19a00000-0000-4000-a000-000000000028';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select set_config('test.create_28', 'none', true);
select pg_temp.affects('CHAIN: "Create ticket" on a conversation still attached to D goes through', $sql$
  select set_config('test.create_28',
    public.create_ticket_from_thread('19a00000-0000-4000-a000-000000000028')::text, true)
$sql$, 1);

reset role;

insert into results(name, expected, actual, pass)
select 'CHAIN: and hands back J', 'J',
       case when current_setting('test.create_28') = '19a00000-0000-4000-a000-000000000015' then 'J'
            when current_setting('test.create_28') = '19a00000-0000-4000-a000-000000000011' then 'K'
            when current_setting('test.create_28') = '19a00000-0000-4000-a000-000000000012' then 'D'
            else current_setting('test.create_28') end,
       current_setting('test.create_28') = '19a00000-0000-4000-a000-000000000015';

-- ── Where the merges lead is deleted ─────────────────────────────────────
update public.support_tickets set status = 'resolved', deleted_at = now()
where id = '19a00000-0000-4000-a000-000000000015';

select pg_temp.customer_writes('19a00000-0000-4000-a000-000000000045', '19a00000-0000-4000-a000-000000000029',
  'check-19 Is anyone there?', 20,
  'Re: check-19 Dropped: syncing is broken again ' || pg_temp.ref('19a00000-0000-4000-a000-000000000012'));
select set_config('test.routed_45', coalesce(public.route_mail_to_ticket('19a00000-0000-4000-a000-000000000045')::text, 'null'), true);

insert into results(name, expected, actual, pass)
select 'DELETED END: with J deleted, a reply quoting D''s number stays mail and reopens nothing',
       'null · on no ticket · J resolved · K closed · D closed',
       current_setting('test.routed_45') || ' · ' ||
         pg_temp.filed('19a00000-0000-4000-a000-000000000045', 'none') || ' · J ' || j.status ||
         ' · K ' || k.status || ' · D ' || d.status,
       current_setting('test.routed_45') = 'null'
         and pg_temp.filed('19a00000-0000-4000-a000-000000000045', 'none') = 'on no ticket'
         and j.status = 'resolved' and k.status = 'closed' and d.status = 'closed'
from public.support_tickets j, public.support_tickets k, public.support_tickets d
where j.id = '19a00000-0000-4000-a000-000000000015'
  and k.id = '19a00000-0000-4000-a000-000000000011'
  and d.id = '19a00000-0000-4000-a000-000000000012';

insert into results(name, expected, actual, pass)
select 'ROUTING: opens no ticket', current_setting('test.tickets_before') || ' tickets',
       count(*) || ' tickets', count(*) = current_setting('test.tickets_before')::int
from public.support_tickets where subject like '%check-19%';

update public.mail_threads set ticket_id = '19a00000-0000-4000-a000-000000000012'
where id = '19a00000-0000-4000-a000-000000000029';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

select set_config('test.create_29', 'none', true);
select pg_temp.affects('DELETED END: "Create ticket" on a conversation attached to D goes through', $sql$
  select set_config('test.create_29',
    public.create_ticket_from_thread('19a00000-0000-4000-a000-000000000029')::text, true)
$sql$, 1);

reset role;

insert into results(name, expected, actual, pass)
select 'DELETED END: it opens one new ticket, live, carries the reply into it and takes the conversation',
       'a new live ticket · on the ticket · conversation on it · 1 new',
       case when current_setting('test.create_29') in ('19a00000-0000-4000-a000-000000000012',
                                                       '19a00000-0000-4000-a000-000000000011',
                                                       '19a00000-0000-4000-a000-000000000015') then 'a merged or deleted ticket'
            when n.id is null then 'no ticket'
            when n.deleted_at is not null then 'a deleted ticket'
            else 'a new live ticket' end || ' · ' ||
         pg_temp.filed('19a00000-0000-4000-a000-000000000045', current_setting('test.create_29')) || ' · ' ||
         case when t.ticket_id::text = current_setting('test.create_29') then 'conversation on it'
              else 'conversation on ' || coalesce(t.ticket_id::text, 'nothing') end || ' · ' ||
         (c.n - current_setting('test.tickets_before')::int) || ' new',
       current_setting('test.create_29') not in ('19a00000-0000-4000-a000-000000000012',
                                                 '19a00000-0000-4000-a000-000000000011',
                                                 '19a00000-0000-4000-a000-000000000015')
         and n.id is not null and n.deleted_at is null
         and pg_temp.filed('19a00000-0000-4000-a000-000000000045', current_setting('test.create_29')) = 'on the ticket'
         and t.ticket_id::text = current_setting('test.create_29')
         and c.n = current_setting('test.tickets_before')::int + 1
from public.mail_threads t
left join public.support_tickets n on n.id::text = current_setting('test.create_29')
cross join (select count(*) as n from public.support_tickets where subject like '%check-19%') c
where t.id = '19a00000-0000-4000-a000-000000000029';

-- ── Shape and grants ─────────────────────────────────────────────────────
select pg_temp.check('SCHEMA: merged_into_id refers to a ticket, and never to its own', 'foreign key · check', $sql$
  select string_agg(case contype when 'f' then 'foreign key' else 'check' end, ' · ' order by contype desc),
         count(*) filter (where contype = 'f') = 1 and count(*) filter (where contype = 'c') = 1
  from pg_constraint
  where conrelid = 'public.support_tickets'::regclass
    and contype in ('f', 'c')
    and pg_get_constraintdef(oid) like '%merged_into_id%'
$sql$);

select pg_temp.check('GRANTS: merge_tickets runs as its owner with a fixed search_path, for signed-in people only',
  'definer · search_path · signed-in people only', $sql$
  select concat_ws(' · ',
           case when p.prosecdef then 'definer' else 'invoker' end,
           case when exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                then 'search_path' else 'no search_path' end,
           case when has_function_privilege('authenticated', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute')
                     and not has_function_privilege('service_role', p.oid, 'execute')
                then 'signed-in people only' else 'not signed-in people only' end),
         p.prosecdef
           and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
           and has_function_privilege('authenticated', p.oid, 'execute')
           and not has_function_privilege('anon', p.oid, 'execute')
           and not has_function_privilege('service_role', p.oid, 'execute')
  from pg_proc p
  where p.oid = 'public.merge_tickets(uuid, uuid)'::regprocedure
$sql$);

select pg_temp.check('GRANTS: routing mail, and following merges, stay out of reach of anyone signed in', 'false · false', $sql$
  select has_function_privilege('authenticated', 'public.route_mail_to_ticket(uuid)', 'execute') || ' · ' ||
           has_function_privilege('authenticated', 'public.live_ticket_after_merges(uuid)', 'execute'),
         not has_function_privilege('authenticated', 'public.route_mail_to_ticket(uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public.live_ticket_after_merges(uuid)', 'execute')
$sql$);

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
