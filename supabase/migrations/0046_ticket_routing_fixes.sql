-- 0046_ticket_routing_fixes.sql — a ticket and its mail stay together.
--
-- route_mail_to_ticket() and create_ticket_from_thread() (0035; no migration
-- since has replaced either) followed a conversation's link to its ticket
-- without asking whether that ticket had been deleted. A deleted ticket keeps
-- its row (0023), so the link outlives it: "Create ticket" on the conversation
-- handed back the deleted ticket — which the workspace does not list, so the
-- button seemed to do nothing — and every later reply from the customer was
-- filed on it and reopened it, out of sight. A reply to a ticket waiting on the
-- customer left it waiting, so the queue never showed they had answered
-- (review, 2026-09-14).
--
-- A deleted ticket is now out of the loop, as a removed one would be:
--   - routing follows a conversation's link only to a live ticket; otherwise
--     it reads the reference in the subject, as for a conversation with no
--     link, which already skipped deleted tickets. With nothing live to follow,
--     the reply stays mail: routing still never opens a ticket;
--   - "Create ticket" opens a new ticket for such a conversation, points the
--     conversation at it and carries the conversation so far into it. A reply
--     the deleted ticket held comes too: the new ticket takes over its link to
--     the mail, which is unique, and the deleted ticket keeps its own copy of
--     the words, so a restore brings it back as it was.
--
-- A customer's reply to a ticket waiting on them reopens it, as it already
-- reopened one resolved or closed. Those two are kept: routing opens no
-- follow-up ticket, so a closed ticket left closed would hide the reply. In
-- progress stays in progress — someone is already on it.
--
-- A reference too big to be any ticket's number — a subject quoting
-- "#VYG-99999999999" — made routing fail with "value out of range for type
-- integer". store_mail_batch caught the error, so the reply was stored and
-- never routed. Such a number now names no ticket, and routing goes on as for
-- mail that names none.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. A customer's reply finds its ticket ──────────────────────────────
-- route_mail_to_ticket() as 0035 left it, but for four things:
--   - a message already routed answers with its ticket only while that ticket
--     is live; one filed on a deleted ticket is routed as if it were new;
--   - the conversation's link is followed only to a live ticket;
--   - a ticket waiting on the customer reopens too;
--   - a reference too big to be a ticket's number names no ticket, rather than
--     failing the call.
-- Still SECURITY DEFINER for the sync (store_mail_batch), and still no way to
-- aim it at a ticket of your choosing: it takes a mail message id and nothing
-- else.

create or replace function public.route_mail_to_ticket(p_mail_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m           record;
  v_digits    text;
  v_ticket    uuid;
  v_existing  uuid;
begin
  select mm.id, mm.thread_id, mm.direction, mm.subject, mm.body_text, mm.sent_at,
         mt.ticket_id, mt.contact_id
    into m
  from public.mail_messages mm
  join public.mail_threads mt on mt.id = mm.thread_id
  where mm.id = p_mail_message_id;

  if not found or m.direction <> 'inbound' then
    return null;                       -- our own sent mail is already in the thread
  end if;

  -- Already routed to a live ticket: nothing to do, and say which. A message
  -- filed on a deleted ticket is routed again below.
  select tm.ticket_id into v_existing
  from public.ticket_messages tm
  join public.support_tickets st on st.id = tm.ticket_id
  where tm.mail_message_id = p_mail_message_id and st.deleted_at is null;
  if v_existing is not null then
    return v_existing;
  end if;

  -- The thread's own link wins: once a human has attached a conversation to a
  -- ticket, later replies follow it even if someone edits the subject line —
  -- unless that ticket was deleted, which is no link at all.
  select st.id into v_ticket
  from public.support_tickets st
  where st.id = m.ticket_id and st.deleted_at is null;

  if v_ticket is null then
    -- The reference is read as text, and cast only once it could be a ticket's
    -- number: longer than ten digits, or past the largest integer, it names no
    -- ticket. Cast straight to an integer, it failed the call. Two IFs, so the
    -- cast is never reached for a number too long for it.
    v_digits := ltrim(substring(coalesce(m.subject, '') from '#VYG-([0-9]+)'), '0');
    if length(v_digits) between 1 and 10 then
      if v_digits::bigint <= 2147483647 then
        select id into v_ticket
        from public.support_tickets
        where number = v_digits::int and deleted_at is null;
      end if;
    end if;
  end if;

  if v_ticket is null then
    return null;                       -- nothing live to follow: it stays mail, by design
  end if;

  -- Filed on a deleted ticket before: that ticket keeps its copy of the words,
  -- and this one takes over the link, which is unique.
  update public.ticket_messages set mail_message_id = null
  where mail_message_id = p_mail_message_id;

  insert into public.ticket_messages
    (ticket_id, author_contact_id, direction, body, mail_message_id, created_at)
  values
    (v_ticket, m.contact_id, 'inbound',
     coalesce(nullif(trim(m.body_text), ''), '(no text in this message)'),
     p_mail_message_id, coalesce(m.sent_at, now()));

  -- Keep the thread pointing at the ticket, so the next reply skips the lookup
  -- and the mail view can show the connection.
  update public.mail_threads set ticket_id = v_ticket, updated_at = now()
  where id = m.thread_id and ticket_id is distinct from v_ticket;

  -- A customer who has replied is waiting on us again: a ticket waiting on
  -- them, resolved or closed goes back in the queue. In progress stays so.
  update public.support_tickets
  set status = case when status in ('waiting','resolved','closed') then 'open' else status end,
      updated_at = now()
  where id = v_ticket;

  return v_ticket;
end;
$$;

revoke all on function public.route_mail_to_ticket(uuid) from public, anon, authenticated;

comment on function public.route_mail_to_ticket(uuid) is
  'Appends an inbound email to the live ticket its thread is attached to, or '
  'else to the live ticket named in its subject, and reopens a waiting, resolved '
  'or closed ticket. Returns the ticket id, or NULL when there is nothing live to '
  'follow — unmatched mail deliberately does not open a ticket (0035, 0046).';

-- ── 2. "Create ticket" on a conversation ────────────────────────────────
-- create_ticket_from_thread() as 0035 left it, but a conversation whose ticket
-- was deleted has none, so it gets a new one rather than the deleted one back.

create or replace function public.create_ticket_from_thread(p_thread_id uuid, p_product text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t        record;
  v_ticket uuid;
  msg      record;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  -- The thread's ticket, only while it is live.
  select mt.id, mt.subject, mt.contact_id, mt.company_id, st.id as ticket_id, mt.connection_id
    into t
  from public.mail_threads mt
  left join public.support_tickets st on st.id = mt.ticket_id and st.deleted_at is null
  where mt.id = p_thread_id and public.can_read_connection(mt.connection_id);

  if not found then
    raise exception 'No such conversation, or it is not yours to open';
  end if;

  if t.ticket_id is not null then
    return t.ticket_id;                -- already has one; hand it back
  end if;

  insert into public.support_tickets (subject, contact_id, company_id, product, source, assignee_id)
  values (coalesce(nullif(trim(t.subject), ''), 'Conversation'),
          t.contact_id, t.company_id, p_product, 'email', public.active_employee_id())
  returning id into v_ticket;

  update public.mail_threads set ticket_id = v_ticket, updated_at = now() where id = p_thread_id;

  -- Bring the conversation so far with it: a ticket that starts blank makes
  -- whoever picks it up go back to the inbox to read what happened. What a
  -- deleted ticket held comes too (route_mail_to_ticket, above).
  for msg in
    select id from public.mail_messages
    where thread_id = p_thread_id and direction = 'inbound'
    order by sent_at
  loop
    perform public.route_mail_to_ticket(msg.id);
  end loop;

  return v_ticket;
end;
$$;

revoke all on function public.create_ticket_from_thread(uuid, text) from public, anon;
grant execute on function public.create_ticket_from_thread(uuid, text) to authenticated;

comment on function public.create_ticket_from_thread(uuid, text) is
  'Opens a ticket for a mail thread and carries the conversation so far into it. '
  'Idempotent: a thread that already has a live ticket returns that one; one whose '
  'ticket was deleted gets a new one (0046).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%where st.id = m.ticket_id and st.deleted_at is null%' then
    raise exception '0046: route_mail_to_ticket() still follows a conversation to a deleted ticket';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%status in (''waiting'',''resolved'',''closed'')%' then
    raise exception '0046: a customer''s reply still leaves a waiting ticket waiting';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%length(v_digits) between 1 and 10%' then
    raise exception '0046: a reference too big for a ticket number still fails routing';
  end if;
  if pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure)
       not like '%on st.id = mt.ticket_id and st.deleted_at is null%' then
    raise exception '0046: "Create ticket" still hands back a deleted ticket';
  end if;
  if has_function_privilege('authenticated', 'public.route_mail_to_ticket(uuid)', 'execute')
     or has_function_privilege('anon', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0046: a signed-in person could route mail onto a ticket, or anon open one';
  end if;
  if not has_function_privilege('authenticated', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0046: staff can no longer open a ticket from a conversation';
  end if;
end
$$;
