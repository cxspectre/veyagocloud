-- =============================================================================
-- 0035 — A customer's reply lands back on its ticket.
--
-- 0033 puts [#VYG-142] in the subject of every reply we send. This is the
-- other half: when that message comes back, the mail sync hands it to
-- route_mail_to_ticket(), which finds the ticket and appends the customer's
-- words to the thread. Without it the reply sits in the inbox and the ticket
-- looks unanswered — the support loop has a gap exactly where it matters.
--
-- WHAT IT DELIBERATELY DOES NOT DO: create a ticket for unmatched mail. Every
-- inbound message becoming a ticket turns the queue into a second inbox,
-- newsletters and all. Automatic when there is a reference to follow; manual
-- otherwise — the workspace already has a "Create ticket" button on a mail
-- thread for that.
--
-- Idempotency: ticket_messages gains mail_message_id, unique. Re-running a
-- sync over the same message updates the mail row and adds no second copy to
-- the ticket.
-- =============================================================================

alter table public.ticket_messages
  add column if not exists mail_message_id uuid references public.mail_messages(id) on delete set null;

-- Plain and non-partial so an upsert could target it; NULLs (every message
-- written by a person) stay distinct, so they never collide. Same reasoning as
-- finance_transactions in 0005 and the sync keys in 0028.
create unique index if not exists ticket_messages_mail_idx
  on public.ticket_messages (mail_message_id);

comment on column public.ticket_messages.mail_message_id is
  'The synced email this thread entry came from, when it came from one. Unique, '
  'so re-running a sync never doubles a customer''s reply.';

-- ---------------------------------------------------------------------------
-- The routing itself.
--
-- SECURITY DEFINER because the caller is the sync running as the service role,
-- and because it has to write a ticket_message — a table with a deliberately
-- narrow INSERT policy that no automated caller satisfies. It takes a mail
-- message id and nothing else, so there is no way to aim it at a ticket of
-- your choosing.
-- ---------------------------------------------------------------------------
create or replace function public.route_mail_to_ticket(p_mail_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m           record;
  v_ref       int;
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

  -- Already routed: nothing to do, and say which ticket it went to.
  select ticket_id into v_existing
  from public.ticket_messages where mail_message_id = p_mail_message_id;
  if v_existing is not null then
    return v_existing;
  end if;

  -- The thread's own link wins: once a human has attached a conversation to a
  -- ticket, later replies follow it even if someone edits the subject line.
  v_ticket := m.ticket_id;

  if v_ticket is null then
    v_ref := nullif(substring(coalesce(m.subject, '') from '#VYG-([0-9]+)'), '')::int;
    if v_ref is not null then
      select id into v_ticket
      from public.support_tickets
      where number = v_ref and deleted_at is null;
    end if;
  end if;

  if v_ticket is null then
    return null;                       -- no reference: it stays mail, by design
  end if;

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

  -- A customer who has replied is waiting on us again. Reopening a resolved
  -- ticket is the whole point of matching the reference in the first place.
  update public.support_tickets
  set status = case when status in ('resolved','closed') then 'open' else status end,
      updated_at = now()
  where id = v_ticket;

  return v_ticket;
end;
$$;

revoke all on function public.route_mail_to_ticket(uuid) from public, anon, authenticated;

comment on function public.route_mail_to_ticket(uuid) is
  'Appends an inbound email to the ticket named in its subject, or to the one '
  'its thread is already attached to. Returns the ticket id, or NULL when there '
  'is no reference to follow — unmatched mail deliberately does not open a ticket.';

-- ---------------------------------------------------------------------------
-- Creating a ticket from a thread, on purpose. This is the manual half, and it
-- is the one a person triggers from the mail view.
-- ---------------------------------------------------------------------------
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

  select mt.id, mt.subject, mt.contact_id, mt.company_id, mt.ticket_id, mt.connection_id
    into t
  from public.mail_threads mt
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
  -- whoever picks it up go back to the inbox to read what happened.
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
  'Idempotent: a thread that already has a ticket returns that one.';
