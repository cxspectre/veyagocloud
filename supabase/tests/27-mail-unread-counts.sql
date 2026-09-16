-- 27-mail-unread-counts.sql — the true unread count per mailbox
-- (mail_unread_counts(), 0062), not only what a 200-per-folder load could see.
--
-- Three connections, made as the table owner: the studio's mailbox (1), the
-- OWNER's personal one (2), the assistant's personal one (3) — the same shape
-- 09-connection-privacy.sql already uses, so a mailbox visible there is
-- visible to the count here too, and one hidden there counts nothing here
-- either. Six threads across them, read and unread, every folder, prove the
-- count answers only what mail_threads.is_read already means (0038's
-- refresh_mail_thread_state(), which mailThreads() itself reads) — not a rule
-- reinvented for this function. Everything is rolled back.
begin;

create temp table results(id serial, name text, expected text, actual text, pass boolean);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

update public.employees set status = 'active', role = 'employee'
where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c';

insert into public.integration_connections (id, provider, account_label, employee_id, status) values
  ('c2700000-0000-4000-a000-000000000001', 'microsoft_mail', 'check-27-studio@example.invalid', null, 'connected'),
  ('c2700000-0000-4000-a000-000000000002', 'microsoft_mail', 'check-27-owner@example.invalid',
   (select id from public.employees where user_id = 'd7d1bedb-fd7d-48b0-aa82-4fcae1cfb093'), 'connected'),
  ('c2700000-0000-4000-a000-000000000003', 'microsoft_mail', 'check-27-assistant@example.invalid',
   (select id from public.employees where user_id = '21fc20c1-50e8-4764-9a11-71031d2f8f2c'), 'connected');

-- The studio (1): one unread inbox thread, one already read, and one unread
-- but in Sent — unread there is not waiting for anyone, and does not count.
insert into public.mail_threads (connection_id, external_id, folder, is_read) values
  ('c2700000-0000-4000-a000-000000000001', 'check-27-s1', 'inbox', false),
  ('c2700000-0000-4000-a000-000000000001', 'check-27-s2', 'inbox', true),
  ('c2700000-0000-4000-a000-000000000001', 'check-27-s3', 'sent', false);
-- The OWNER's own (2): two unread inbox threads.
insert into public.mail_threads (connection_id, external_id, folder, is_read) values
  ('c2700000-0000-4000-a000-000000000002', 'check-27-o1', 'inbox', false),
  ('c2700000-0000-4000-a000-000000000002', 'check-27-o2', 'inbox', false);
-- The assistant's own (3): one unread inbox thread, and one unread but
-- starred and filed away (0045) — Starred reaches past inbox/sent for the
-- reading pane, but this function counts the inbox alone, so it does not.
insert into public.mail_threads (connection_id, external_id, folder, is_read, is_starred) values
  ('c2700000-0000-4000-a000-000000000003', 'check-27-a1', 'inbox', false, false),
  ('c2700000-0000-4000-a000-000000000003', 'check-27-a2', 'archive', false, true);

-- What this session's own call to mail_unread_counts() answers, narrowed to
-- this suite's own fixtures (account_label) so a live database's real
-- mailboxes never change the expected string.
create function pg_temp.counts()
returns text
language plpgsql
as $$
declare
  seen text;
begin
  select coalesce(string_agg(c.account_label || ':' || u.unread_count, ', ' order by c.account_label), 'none')
  into seen
  from public.mail_unread_counts() u
  join public.integration_connections c on c.id = u.connection_id
  where c.account_label like 'check-27-%';
  return seen;
exception when insufficient_privilege then
  return 'refused';
end;
$$;

grant execute on function pg_temp.counts() to authenticated, anon;

-- ── The assistant, a member of staff ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"21fc20c1-50e8-4764-9a11-71031d2f8f2c","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'STAFF: the studio''s unread and their own — not the owner''s personal mailbox',
       'check-27-assistant@example.invalid:1, check-27-studio@example.invalid:1', x.seen,
       x.seen = 'check-27-assistant@example.invalid:1, check-27-studio@example.invalid:1'
from (select pg_temp.counts() as seen) x;

-- ── The OWNER, a manager ─────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d7d1bedb-fd7d-48b0-aa82-4fcae1cfb093","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'MANAGER: the studio''s unread and their own — not the assistant''s personal mailbox',
       'check-27-owner@example.invalid:2, check-27-studio@example.invalid:1', x.seen,
       x.seen = 'check-27-owner@example.invalid:2, check-27-studio@example.invalid:1'
from (select pg_temp.counts() as seen) x;

-- ── Someone signed in who is not on the team ─────────────────────────────
select set_config('request.jwt.claims', '{"sub":"c2700000-0000-4000-a000-0000000000ff","role":"authenticated","aal":"aal2"}', true);

insert into results(name, expected, actual, pass)
select 'NOT ON THE TEAM: counts nothing — RLS on mail_threads leaves no row to group', 'none',
       x.seen, x.seen in ('none', 'refused')
from (select pg_temp.counts() as seen) x;

-- ── Anon ─────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

insert into results(name, expected, actual, pass)
select 'ANON: refused outright — execute was never granted', 'refused', x.seen, x.seen = 'refused'
from (select pg_temp.counts() as seen) x;

reset role;

insert into results(name, expected, actual, pass)
select 'SECURITY: invoker, not definer — it must rely on mail_threads'' own RLS, never a copy of it',
       'invoker', case when p.prosecdef then 'definer' else 'invoker' end, not p.prosecdef
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'mail_unread_counts';

select name, expected, actual, case when pass then 'PASS' else 'FAIL' end as result
from results order by id;

rollback;
