-- 0065_ticket_from_thread_rename_fix.sql — create_ticket_from_thread() was
-- still reading mail_threads.last_from_name/last_from_email, columns 0055
-- renamed to other_party_name/other_party_email earlier in this same batch.
--
-- Both migrations were written in isolated worktrees against the same stale
-- base commit, so 0056 never saw 0055's rename. It only surfaced once this
-- batch actually ran against a real database: opening a ticket from a mail
-- conversation — "Create ticket" on any inbound thread — has been raising
-- "column mt.last_from_name does not exist" since 0056 went live. 0056 itself
-- already applied and is not being edited; this replaces the function it left
-- behind with the corrected one, same as 0054 and 0046 did for earlier
-- mistakes in this same function.
--
-- Nothing else about create_ticket_from_thread() changes: same signature,
-- same locking, same grants.

set lock_timeout = '5s';

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

  -- Conversations before tickets (0054's header): taken before
  -- live_ticket_after_merges() locks the conversation's ticket, so this never
  -- holds a ticket a merge is waiting for while it waits for that merge.
  lock table public.mail_threads in row exclusive mode;

  select mt.id, mt.subject, mt.contact_id, mt.company_id, mt.ticket_id, mt.connection_id,
         mt.other_party_name, mt.other_party_email
    into t
  from public.mail_threads mt
  where mt.id = p_thread_id and public.can_read_connection(mt.connection_id);

  if not found then
    raise exception 'No such conversation, or it is not yours to open';
  end if;

  -- The thread's ticket, or where its merges lead, while that one is live.
  v_ticket := public.live_ticket_after_merges(t.ticket_id);

  if v_ticket is not null then
    if v_ticket is distinct from t.ticket_id then
      update public.mail_threads set ticket_id = v_ticket, updated_at = now() where id = p_thread_id;
    end if;
    return v_ticket;                   -- already has one; hand it back
  end if;

  insert into public.support_tickets (subject, contact_id, company_id, product, source, assignee_id,
                                       requester_name, requester_email)
  values (coalesce(nullif(trim(t.subject), ''), 'Conversation'),
          t.contact_id, t.company_id, p_product, 'email', public.active_employee_id(),
          t.other_party_name, t.other_party_email)
  returning id into v_ticket;

  update public.mail_threads set ticket_id = v_ticket, updated_at = now() where id = p_thread_id;

  -- Bring the conversation so far with it: a ticket that starts blank makes
  -- whoever picks it up go back to the inbox to read what happened. What a
  -- deleted ticket held comes too (route_mail_to_ticket, below).
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
  'Opens a ticket for a mail thread and carries the conversation so far into '
  'it, with the thread''s own sender kept on the ticket (0056; column names '
  'fixed in 0065 after 0055 renamed them out from under it). Idempotent: a '
  'thread that already has a live ticket — itself, or the ticket its merges '
  'lead to — returns that one; one whose ticket was deleted gets a new one '
  '(0046, 0054).';

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it took.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure) like '%last_from%' then
    raise exception '0065: create_ticket_from_thread() still reads the old column names';
  end if;
  if pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure) not like '%other_party_email%' then
    raise exception '0065: create_ticket_from_thread() does not read other_party_email';
  end if;
  if not has_function_privilege('authenticated', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0065: authenticated lost execute on create_ticket_from_thread()';
  end if;
  if has_function_privilege('anon', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0065: anon can call create_ticket_from_thread()';
  end if;
end $$;
