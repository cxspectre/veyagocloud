-- 0054_ticket_merge.sql — two tickets about one problem become one.
--
-- A customer who writes about the same problem twice — a new email rather than
-- a reply, the contact form and then an email — opens two tickets. Until now
-- both stayed in the queue, or one was closed by hand with its half of the
-- conversation stranded on it, and the customer's next reply quoting that
-- ticket's number reopened it (0046).
--
-- merge_tickets(keep, drop), for staff (section 3), makes them one:
--   - the dropped ticket's thread — each message still linked to the mail it
--     came from — its notes, and its conversations, in whichever mailbox, move
--     to the ticket kept;
--   - the ticket kept takes the earlier first response of the two; its status,
--     assignee and everything else stay as they were;
--   - the dropped ticket is closed and points at the one kept (merged_into_id,
--     section 1), and an internal note on each says which was merged into which;
--   - a ticket into itself, a deleted or an already merged ticket on either
--     side, and a loop are refused.
--
-- A merged ticket forwards. A reply quoting its number, or in a conversation
-- still attached to it, lands on the ticket it was merged into — or, merged on,
-- on the ticket its merges lead to, while that one is live (sections 2 and 4) —
-- and "Create ticket" on such a conversation hands that ticket back (section 5).
-- The activity feed says a merged ticket was merged, not resolved (section 6).
--
-- merged_into_id is merge_tickets()'s to write: from the browser a ticket cannot
-- be pointed at another, or a merge undone, by editing the row. The service role
-- and the SQL editor still can.
--
-- Locks go conversations first, then tickets: the order the sync already takes
-- them in, since store_mail_batch() (0045) writes a message's conversation before
-- it files the message on a ticket. A merge holds mail_threads in SHARE ROW
-- EXCLUSIVE mode before it locks both tickets FOR UPDATE (section 3); routing and
-- "Create ticket" hold it in ROW EXCLUSIVE mode before they lock a ticket FOR KEY
-- SHARE (sections 2, 4 and 5). So a merge waits for a sync batch in flight, in
-- any mailbox, and a batch that starts while a merge waits or runs waits in turn:
-- no reply is filed on a ticket while it is merged away, and neither side ever
-- holds what the other is waiting for. Two merges take turns. Reading mail waits
-- for nothing, and an edit of a ticket waits only while a merge of it runs.
--
-- The cost: a merge waits for the batch in flight, and the sync for the merge,
-- which takes milliseconds. A batch that outlasts the API's statement timeout
-- fails the merge, which is simply asked again. A hard delete of a ticket — only
-- a manager's own API call or the SQL editor makes one; the workspace deletes
-- softly — locks the ticket before its foreign key clears its conversations. One
-- that lands in the same milliseconds as a merge of that ticket fails one of the
-- two with a deadlock error, and that one is asked again.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. Where a merged ticket went ────────────────────────────────────────
-- Set null if the ticket kept is ever purged outright, as a conversation's link
-- is (0025): its thread went with it, so there is nothing left to forward to.

alter table public.support_tickets
  add column if not exists merged_into_id uuid references public.support_tickets(id) on delete set null;

-- Dropped and added again, so a second run leaves the rule as written here.
alter table public.support_tickets drop constraint if exists support_tickets_not_merged_into_itself;
alter table public.support_tickets
  add constraint support_tickets_not_merged_into_itself check (merged_into_id <> id);

create index if not exists support_tickets_merged_into_idx
  on public.support_tickets (merged_into_id) where merged_into_id is not null;

comment on column public.support_tickets.merged_into_id is
  'The ticket this one was merged into: its thread, notes and conversations are '
  'there, and mail for this ticket goes there too. Null for a ticket never merged. '
  'Written by merge_tickets() only (0054).';

-- From the browser only merge_tickets() writes it. Pointed at another ticket by
-- hand, a ticket would send the customer's replies there and leave its thread
-- behind. merge_tickets() is SECURITY DEFINER and so runs as its owner, which
-- this lets through, as it does the service role and the SQL editor.
create or replace function public.support_tickets_merge_through_merge_tickets()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.merged_into_id is not null then
      raise exception 'A ticket is merged with merge_tickets(), which moves its thread, notes and conversations too'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.merged_into_id is distinct from old.merged_into_id then
    raise exception 'A ticket is merged with merge_tickets(), which moves its thread, notes and conversations too'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

revoke all on function public.support_tickets_merge_through_merge_tickets() from public, anon, authenticated;

drop trigger if exists support_tickets_merge_through_merge_tickets on public.support_tickets;
create trigger support_tickets_merge_through_merge_tickets
  before insert or update of merged_into_id on public.support_tickets
  for each row execute function public.support_tickets_merge_through_merge_tickets();

-- ── 2. Where mail for a ticket goes ──────────────────────────────────────
-- The ticket itself; once merged, the ticket it was merged into; and so on for
-- as long as merges lead on. Null when the ticket they end at is deleted or
-- gone, or when they go round in a loop, which merge_tickets() refuses but an
-- operator's hand edit could make. Only where the merges end has to be live: a
-- merged ticket deleted afterwards still forwards, since deleting it only tidies
-- the list.
--
-- Each ticket read is locked FOR KEY SHARE until the caller's transaction ends.
-- Ordinary edits do not wait on that lock, but a merge does, so the answer holds
-- while the caller files mail on it. Callers hold mail_threads in ROW EXCLUSIVE
-- mode first (see the header): one that arrives during a merge waits there,
-- before it has locked any ticket, and then reads the tickets as merged.
--
-- Not SECURITY DEFINER: it runs as whoever calls it, and only the owner's
-- functions do — route_mail_to_ticket() and create_ticket_from_thread().

create or replace function public.live_ticket_after_merges(p_ticket uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_ticket  uuid := p_ticket;
  v_next    uuid;
  v_deleted timestamptz;
  v_seen    uuid[] := '{}';
begin
  while v_ticket is not null loop
    select st.merged_into_id, st.deleted_at
      into v_next, v_deleted
    from public.support_tickets st
    where st.id = v_ticket
    for key share;

    if not found then
      return null;                     -- purged: nothing to follow
    end if;

    if v_next is null then
      return case when v_deleted is null then v_ticket end;
    end if;

    if v_next = any(v_seen) or cardinality(v_seen) >= 100 then
      return null;                     -- merges that go round lead nowhere
    end if;

    v_seen := v_seen || v_ticket;
    v_ticket := v_next;
  end loop;

  return null;
end;
$$;

revoke all on function public.live_ticket_after_merges(uuid) from public, anon, authenticated, service_role;

comment on function public.live_ticket_after_merges(uuid) is
  'The live ticket mail for this ticket goes to: itself, or where its merges lead. '
  'Null when that ticket is deleted or gone, or the merges loop. Locks each ticket '
  'FOR KEY SHARE, so a merge in progress is waited for. For route_mail_to_ticket() '
  'and create_ticket_from_thread() only (0054).';

-- ── 3. Merging ───────────────────────────────────────────────────────────
-- SECURITY DEFINER: moving a ticket's conversations writes mail_threads, which
-- nobody signed in may write (0038), and its messages and notes, which RLS keeps
-- to their authors (0023, 0032). The caller must be staff, and a session that
-- still owes its second factor is not (0040).

create or replace function public.merge_tickets(p_keep uuid, p_drop uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep  public.support_tickets%rowtype;
  v_drop  public.support_tickets%rowtype;
  v_hop   uuid;
  v_hops  int := 0;
  v_by    uuid;
  v_what  text;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  if p_keep is null or p_drop is null then
    raise exception 'Choose the ticket to keep and the ticket to merge into it';
  end if;

  if p_keep = p_drop then
    raise exception 'A ticket cannot be merged into itself';
  end if;

  -- Conversations before tickets (see the header). SHARE ROW EXCLUSIVE waits for
  -- every writer of conversations in flight — a sync batch, routing, "Create
  -- ticket" — and holds off new ones, and other merges, until this transaction
  -- ends. Were it taken after the tickets, a batch holding one of the dropped
  -- ticket's conversations, about to file a reply on that ticket, would wait for
  -- this merge while this merge waited for the batch, and one of them would fail.
  lock table public.mail_threads in share row exclusive mode;

  -- Then both tickets, in the same order every time. FOR UPDATE, so nothing can
  -- lock either FOR KEY SHARE — routing (live_ticket_after_merges), a foreign
  -- key's check — to file on it until this merge has closed the one it drops.
  perform 1 from public.support_tickets where id = least(p_keep, p_drop) for update;
  perform 1 from public.support_tickets where id = greatest(p_keep, p_drop) for update;

  select * into v_keep from public.support_tickets where id = p_keep;
  if not found then
    raise exception 'No such ticket';
  end if;

  select * into v_drop from public.support_tickets where id = p_drop;
  if not found then
    raise exception 'No such ticket';
  end if;

  if v_drop.deleted_at is not null then
    raise exception '#VYG-% is deleted: restore it before merging it', v_drop.number;
  end if;

  if v_keep.deleted_at is not null then
    raise exception '#VYG-% is deleted: restore it before merging into it', v_keep.number;
  end if;

  -- Where the ticket kept was merged, if it was: back to the dropped one is a loop.
  v_hop := v_keep.merged_into_id;
  while v_hop is not null and v_hops < 100 loop
    if v_hop = p_drop then
      raise exception 'Merging #VYG-% into #VYG-% would make a loop: #VYG-% was already merged into #VYG-%',
        v_drop.number, v_keep.number, v_keep.number, v_drop.number;
    end if;
    select st.merged_into_id into v_hop from public.support_tickets st where st.id = v_hop;
    v_hops := v_hops + 1;
  end loop;

  if v_keep.merged_into_id is not null then
    raise exception '#VYG-% was already merged into #VYG-%: merge into that one instead',
      v_keep.number, (select st.number from public.support_tickets st where st.id = v_keep.merged_into_id);
  end if;

  if v_drop.merged_into_id is not null then
    raise exception '#VYG-% was already merged into #VYG-%',
      v_drop.number, (select st.number from public.support_tickets st where st.id = v_drop.merged_into_id);
  end if;

  -- The thread. Each message keeps its mail_message_id, so the mail it came
  -- from still leads to it, and the next sync files none of it twice.
  update public.ticket_messages set ticket_id = p_keep where ticket_id = p_drop;

  -- The notes.
  update public.workspace_notes set entity_id = p_keep
  where entity_type = 'ticket' and entity_id = p_drop;

  -- The conversations, in any mailbox: whose mailbox one is in decides who reads
  -- it, not which ticket it belongs to.
  update public.mail_threads set ticket_id = p_keep, updated_at = now() where ticket_id = p_drop;

  -- The ticket kept was first answered when either conversation was. Its status,
  -- assignee and the rest stay as they are; updated_at moves on by itself.
  update public.support_tickets
  set first_response_at = least(v_keep.first_response_at, v_drop.first_response_at,
                                (select min(m.delivered_at) from public.ticket_messages m
                                 where m.ticket_id = p_keep and m.direction = 'outbound'))
  where id = p_keep;

  -- The dropped ticket closes, and points at the one kept. It keeps its own
  -- first response: when its customer first heard back is still true.
  update public.support_tickets
  set status = 'closed', merged_into_id = p_keep
  where id = p_drop;

  -- Written last, so the dropped ticket's note stays on it.
  v_by := public.active_employee_id();
  v_what := format('Merged #VYG-%s into #VYG-%s.', v_drop.number, v_keep.number);

  insert into public.ticket_messages (ticket_id, author_employee_id, direction, body)
  values
    (p_keep, v_by, 'internal',
     v_what || format(' The thread, notes and conversations of #VYG-%s are on this ticket now, '
                      'and replies quoting #VYG-%s come here.', v_drop.number, v_drop.number)),
    (p_drop, v_by, 'internal',
     v_what || format(' Its thread, notes and conversations are on #VYG-%s now, '
                      'and replies quoting #VYG-%s go there.', v_keep.number, v_drop.number));

  return p_keep;
end;
$$;

revoke all on function public.merge_tickets(uuid, uuid) from public, anon, service_role;
grant execute on function public.merge_tickets(uuid, uuid) to authenticated;

comment on function public.merge_tickets(uuid, uuid) is
  'Merges p_drop into p_keep: moves its thread, notes and conversations, gives '
  'p_keep the earlier first response, closes p_drop pointing at p_keep, and notes '
  'the merge on both. Refuses a ticket into itself, deleted or merged tickets and '
  'loops. Staff only. Returns p_keep (0054).';

-- ── 4. A customer's reply finds the ticket kept ──────────────────────────
-- route_mail_to_ticket() as 0046 left it — a reference too big for a ticket's
-- number included — but for merges:
--   - the conversation's link, and the ticket its subject names, are followed
--     through merges to the live ticket they lead to (section 2);
--   - a message already routed answers with its ticket only while that ticket
--     is live and not merged away; one filed on a merged ticket, as only
--     someone's hand edit could leave one, is routed again, as one filed on a
--     deleted ticket is;
--   - it holds mail_threads in ROW EXCLUSIVE mode before it locks any ticket
--     (see the header).
-- Its signature, its answer — the ticket's id, or null — and its grants, the
-- sync's alone, stay as they were.

create or replace function public.route_mail_to_ticket(p_mail_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m           record;
  v_digits    text;
  v_named     uuid;
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

  -- Conversations before tickets (see the header). The sync already holds this,
  -- from writing the message's conversation, and "Create ticket" from its start;
  -- called on its own, routing takes it here, before live_ticket_after_merges()
  -- locks a ticket, so it never holds a ticket a merge is waiting for while it
  -- waits for that merge.
  lock table public.mail_threads in row exclusive mode;

  -- Already routed to a live ticket that was not merged away: nothing to do,
  -- and say which. A message filed on a deleted or merged ticket is routed
  -- again below.
  select tm.ticket_id into v_existing
  from public.ticket_messages tm
  join public.support_tickets st on st.id = tm.ticket_id
  where tm.mail_message_id = p_mail_message_id
    and st.deleted_at is null and st.merged_into_id is null;
  if v_existing is not null then
    return v_existing;
  end if;

  -- The thread's own link wins: once a human has attached a conversation to a
  -- ticket, later replies follow it even if someone edits the subject line —
  -- through any merges, to the live ticket they lead to. A link that leads to a
  -- deleted ticket is no link at all.
  v_ticket := public.live_ticket_after_merges(m.ticket_id);

  if v_ticket is null then
    -- The reference is read as text, and cast only once it could be a ticket's
    -- number: longer than ten digits, or past the largest integer, it names no
    -- ticket (0046). The ticket it names forwards, if it was merged.
    v_digits := ltrim(substring(coalesce(m.subject, '') from '#VYG-([0-9]+)'), '0');
    if length(v_digits) between 1 and 10 then
      if v_digits::bigint <= 2147483647 then
        select st.id into v_named
        from public.support_tickets st
        where st.number = v_digits::int;
        v_ticket := public.live_ticket_after_merges(v_named);
      end if;
    end if;
  end if;

  if v_ticket is null then
    return null;                       -- nothing live to follow: it stays mail, by design
  end if;

  -- Filed on a deleted or merged ticket before: that ticket keeps its copy of
  -- the words, and this one takes over the link, which is unique.
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
  'else to the live ticket named in its subject — following merges to the ticket '
  'kept — and reopens a waiting, resolved or closed ticket. Returns the ticket id, '
  'or NULL when there is nothing live to follow: unmatched mail deliberately does '
  'not open a ticket (0035, 0046, 0054).';

-- ── 5. "Create ticket" on a conversation attached to a merged ticket ─────
-- create_ticket_from_thread() as 0046 left it, but the conversation's ticket is
-- followed through merges: attached to a merged ticket, the conversation gets
-- the live ticket its merges lead to back, and is pointed at it. One whose
-- merges end at a deleted ticket has none, and gets a new ticket, as in 0046.
-- Like routing, it holds mail_threads in ROW EXCLUSIVE mode before it locks any
-- ticket (see the header).

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

  -- Conversations before tickets (see the header): taken before
  -- live_ticket_after_merges() locks the conversation's ticket, so this never
  -- holds a ticket a merge is waiting for while it waits for that merge.
  lock table public.mail_threads in row exclusive mode;

  select mt.id, mt.subject, mt.contact_id, mt.company_id, mt.ticket_id, mt.connection_id
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
  'Idempotent: a thread that already has a live ticket — itself, or the ticket its '
  'merges lead to — returns that one; one whose ticket was deleted gets a new one '
  '(0046, 0054).';

-- ── 6. The feed says a merged ticket was merged ──────────────────────────
-- activity_from_ticket() as 0027 left it, but a ticket closed by a merge is
-- recorded as merged — "Merged #VYG-12 into #VYG-11" — not as resolved.

create or replace function public.activity_from_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity('created', 'ticket', new.id,
      'Ticket #VYG-' || new.number || ' · ' || new.subject);
  elsif new.merged_into_id is not null and old.merged_into_id is null then
    perform public.log_activity('updated', 'ticket', new.id,
      'Merged #VYG-' || new.number || ' into #VYG-'
        || coalesce((select st.number::text from public.support_tickets st where st.id = new.merged_into_id), '?')
        || ' · ' || new.subject);
  elsif new.status is distinct from old.status
        and new.status in ('resolved','closed') and old.status not in ('resolved','closed') then
    perform public.log_activity('resolved', 'ticket', new.id,
      'Resolved #VYG-' || new.number || ' · ' || new.subject);
  elsif new.status is distinct from old.status
        and old.status in ('resolved','closed') and new.status not in ('resolved','closed') then
    perform public.log_activity('reopened', 'ticket', new.id,
      'Reopened #VYG-' || new.number || ' · ' || new.subject);
  end if;
  return null;                                  -- AFTER trigger: return value ignored
end;
$$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.support_tickets'::regclass
                   and contype = 'f'
                   and confrelid = 'public.support_tickets'::regclass
                   and pg_get_constraintdef(oid) like 'FOREIGN KEY (merged_into_id)%') then
    raise exception '0054: support_tickets.merged_into_id is missing, or does not refer to a ticket';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.support_tickets'::regclass
                   and conname = 'support_tickets_not_merged_into_itself' and convalidated) then
    raise exception '0054: a ticket could be merged into itself';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.support_tickets'::regclass
                   and tgname = 'support_tickets_merge_through_merge_tickets' and not tgisinternal) then
    raise exception '0054: merged_into_id can be written from the browser';
  end if;
  if not (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
          from pg_proc p where p.oid = 'public.merge_tickets(uuid, uuid)'::regprocedure) then
    raise exception '0054: merge_tickets() is not SECURITY DEFINER with a fixed search_path';
  end if;
  if pg_get_functiondef('public.merge_tickets(uuid, uuid)'::regprocedure) not like '%if not public.is_staff() then%' then
    raise exception '0054: merge_tickets() does not check that its caller is staff';
  end if;
  if has_function_privilege('anon', 'public.merge_tickets(uuid, uuid)', 'execute')
     or has_function_privilege('service_role', 'public.merge_tickets(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.merge_tickets(uuid, uuid)', 'execute') then
    raise exception '0054: merge_tickets() is not for signed-in staff alone';
  end if;
  if has_function_privilege('authenticated', 'public.live_ticket_after_merges(uuid)', 'execute')
     or has_function_privilege('anon', 'public.live_ticket_after_merges(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.route_mail_to_ticket(uuid)', 'execute')
     or has_function_privilege('anon', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0054: a signed-in person could follow merges or route mail, or anon open a ticket';
  end if;
  if not has_function_privilege('authenticated', 'public.create_ticket_from_thread(uuid, text)', 'execute') then
    raise exception '0054: staff can no longer open a ticket from a conversation';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure) not like '%live_ticket_after_merges(m.ticket_id)%'
     or pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure) not like '%live_ticket_after_merges(v_named)%' then
    raise exception '0054: route_mail_to_ticket() does not follow a merged ticket to the one kept';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure) not like '%length(v_digits) between 1 and 10%' then
    raise exception '0054: route_mail_to_ticket() fails on a reference too big for a ticket number';
  end if;
  if pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure)
       not like '%live_ticket_after_merges(t.ticket_id)%' then
    raise exception '0054: "Create ticket" does not follow a merged ticket to the one kept';
  end if;
  if pg_get_functiondef('public.activity_from_ticket()'::regprocedure) not like '%''Merged #VYG-''%' then
    raise exception '0054: the feed still says a merged ticket was resolved';
  end if;
  -- Conversations before tickets: each function takes its lock on mail_threads,
  -- and takes it before its first lock on a ticket.
  if not (position('lock table public.mail_threads in share row exclusive mode'
                   in pg_get_functiondef('public.merge_tickets(uuid, uuid)'::regprocedure))
          between 1 and position('where id = least(p_keep, p_drop) for update'
                                 in pg_get_functiondef('public.merge_tickets(uuid, uuid)'::regprocedure))) then
    raise exception '0054: merge_tickets() does not lock the conversations before the tickets, so it can deadlock with the mail sync';
  end if;
  if not (position('lock table public.mail_threads in row exclusive mode'
                   in pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure))
          between 1 and position('live_ticket_after_merges(m.ticket_id)'
                                 in pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure))) then
    raise exception '0054: route_mail_to_ticket() can lock a ticket before the conversations, and deadlock with a merge';
  end if;
  if not (position('lock table public.mail_threads in row exclusive mode'
                   in pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure))
          between 1 and position('live_ticket_after_merges(t.ticket_id)'
                                 in pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure))) then
    raise exception '0054: "Create ticket" can lock a ticket before the conversations, and deadlock with a merge';
  end if;
  if public.live_ticket_after_merges(null) is not null then
    raise exception '0054: live_ticket_after_merges() finds a ticket for no ticket';
  end if;
end
$$;
