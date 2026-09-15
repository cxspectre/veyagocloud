-- 0056_ticket_workflow.sql — the queue a person actually runs support from.
--
-- Six things the audit found tickets still could not do:
--   1. A sender the CRM has no contact for could not be answered: the reply
--      box had a customer's ticket but no address to send to (send-ticket-
--      reply already existed; it had nowhere to look besides contact_id).
--   2. An answer sent from Mail or Outlook, not through the ticket's own
--      reply box, never reached the ticket: only inbound mail was routed.
--   3. A reply the studio owes a customer had no target and no due-by time —
--      "how long has this been open" was a question for whoever was looking,
--      not something the database could say.
--   4. Nowhere to put a file that came with a question, or one someone on
--      the team wants attached to a ticket by hand.
--   5. Nobody heard when a ticket was handed to them, or when its customer
--      wrote back — the assignee found out by opening the queue.
--
-- What changes:
--   1. support_tickets gains requester_name/requester_email — the sender's
--      raw address, kept alongside contact_id rather than instead of it, so
--      a reply always has somewhere to go even before the CRM has a name for
--      them (section 1). create_ticket_from_thread carries it over from the
--      thread it opens the ticket from (0037's own denormalised sender).
--   2. route_mail_to_ticket() also files an outbound message — one sent from
--      Mail or Outlook rather than through send-ticket-reply — on the ticket
--      its thread is already attached to, reconciling it with the row
--      send-ticket-reply already made instead of doubling it, and
--      store_mail_batch()'s routing gate opens for outbound too (section 2).
--   3. ticket_response_targets (staff read, managers write) holds a target
--      per priority; support_tickets gains first_response_due_at and
--      resolve_due_at, kept up to date by a trigger whenever a ticket is
--      opened or its priority changes (section 3).
--   4. ticket_attachments + a private bucket, on the same shape
--      project_files already uses (section 4).
--   5. email_log gains two kinds — ticket_assigned, ticket_customer_reply —
--      for a new notify-ticket function (workspace-side) and the mail sync
--      (section 5).
--
-- Idempotent. Adds only, and replaces functions already replaced since 0035
-- (0046, 0054) with their own fixes carried forward — nothing here undoes a
-- deleted-ticket or merge-following check those added.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. A sender the CRM does not know ───────────────────────────────────

alter table public.support_tickets
  add column if not exists requester_name  text,
  add column if not exists requester_email text;

comment on column public.support_tickets.requester_email is
  'The address a ticket came from, kept even when contact_id is null — so '
  'send-ticket-reply always has somewhere to send to, and the queue never '
  'shows a sender as "Unknown" just because the CRM has not caught up (0056).';
comment on column public.support_tickets.requester_name is
  'The sender''s name as their email gave it, for the same reason as '
  'requester_email — a display name, not a claim that this is who they are.';

-- create_ticket_from_thread() as 0054 left it (following merges to the live
-- ticket a conversation's own leads to), but the new ticket also carries the
-- thread's own sender (0037: mail_threads.last_from_name/last_from_email) —
-- set whether or not a contact matched, so it survives a contact later being
-- renamed, merged or removed from the CRM. Locking and grants unchanged.

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
         mt.last_from_name, mt.last_from_email
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
          t.last_from_name, t.last_from_email)
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
  'it, with the thread''s own sender kept on the ticket (0056). Idempotent: a '
  'thread that already has a live ticket — itself, or the ticket its merges '
  'lead to — returns that one; one whose ticket was deleted gets a new one '
  '(0046, 0054).';

-- ── 2. An answer from Mail or Outlook reaches the ticket ────────────────
-- ticket_messages gains internet_message_id: Graph's own Message-ID for an
-- outbound reply, stamped by send-ticket-reply the moment it has sent one —
-- a plain UPDATE, no round trip to Graph to confirm anything — so that
-- whenever the regular mail sync later stores that same message (in minutes,
-- or after the next scheduled run — there is no telling how soon Sent Items
-- catches up), it recognises the row already there instead of filing a
-- second copy of the same reply. An earlier design tried polling Sent Items
-- for a few seconds from inside send-ticket-reply itself and linking
-- mail_message_id directly; it missed far more often than not — Graph's own
-- eventual consistency is routinely slower than a few seconds — leaving a
-- guaranteed duplicate once the regular sync did catch up, since nothing
-- would have recognised the reply as already recorded by then. Matching on
-- the Message-ID has no such deadline: it is exact, and it does not matter
-- how long the sync takes to get there. A second, independent design tried
-- matching by the message's exact words instead of an id at all; that does
-- not work either — send-ticket-reply's row holds the bare reply someone
-- typed, while the mail synced back is the whole wrapped email (greeting,
-- sign-off, the "reply to this email" footer), so the words are never equal.

alter table public.ticket_messages
  add column if not exists internet_message_id text;

-- Plain and non-partial, so an upsert could target it if one ever needed to;
-- NULLs (every message with no outbound mail pending yet) stay distinct, the
-- same reasoning as mail_message_id's own index just above (0035) and
-- finance_transactions in 0005.
create unique index if not exists ticket_messages_internet_message_idx
  on public.ticket_messages (internet_message_id);

comment on column public.ticket_messages.internet_message_id is
  'Graph''s Message-ID for an outbound reply, stamped by send-ticket-reply '
  'once it has sent one — before the regular mail sync has stored a matching '
  'mail_messages row to point mail_message_id at. route_mail_to_ticket() '
  'matches on this to recognise that reply once the sync catches up, however '
  'long that takes, rather than filing it a second time (0056).';

-- route_mail_to_ticket() as 0054 left it, but for outbound mail: a reply sent
-- through Mail or Outlook rather than send-ticket-reply's own reply box,
-- found on a conversation already attached to a live ticket. Unlike inbound,
-- a bare subject reference is not enough on its own — a staff reply that
-- happens to mention a ticket number in its subject must not attach itself
-- to a ticket nobody meant to touch; only a thread the ticket already owns
-- does. One already matched by internet_message_id (send-ticket-reply's own,
-- above) is linked rather than filed again; anything else reaching here is
-- filed new, with no author (0023's own "the system wrote it" shape: the
-- studio's shared mailbox sent it, not any one person nameable from the mail
-- alone). Status is left exactly as it was: "reply and set to Waiting" is an
-- explicit choice made from the ticket's own reply box (workspace, not this
-- function), not something a sync should decide by itself.

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
  v_body      text;
  v_matched   uuid;
begin
  select mm.id, mm.thread_id, mm.direction, mm.subject, mm.body_text, mm.sent_at,
         mm.internet_message_id, mt.ticket_id, mt.contact_id
    into m
  from public.mail_messages mm
  join public.mail_threads mt on mt.id = mm.thread_id
  where mm.id = p_mail_message_id;

  if not found or m.direction not in ('inbound', 'outbound') then
    return null;
  end if;

  -- Conversations before tickets (0054's header). The sync already holds
  -- this, from writing the message's conversation, and "Create ticket" from
  -- its start; called on its own, routing takes it here, before
  -- live_ticket_after_merges() locks a ticket, so it never holds a ticket a
  -- merge is waiting for while it waits for that merge.
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

  v_body := coalesce(nullif(trim(m.body_text), ''), '(no text in this message)');

  if m.direction = 'outbound' then
    v_ticket := public.live_ticket_after_merges(m.ticket_id);
    if v_ticket is null then
      return null;                     -- not a ticket's conversation: stays mail
    end if;

    -- send-ticket-reply's own row for this exact reply, stamped with Graph's
    -- Message-ID the moment it was sent (see the header comment above):
    -- link it rather than file a second copy.
    if m.internet_message_id is not null then
      update public.ticket_messages
      set mail_message_id = p_mail_message_id
      where ticket_id = v_ticket and internet_message_id = m.internet_message_id
        and mail_message_id is null
      returning ticket_id into v_matched;
      if v_matched is not null then
        return v_matched;
      end if;
    end if;

    -- No row was expecting this one: a reply sent from Mail or Outlook
    -- itself, with nothing on the ticket yet.
    insert into public.ticket_messages (ticket_id, direction, body, mail_message_id, created_at)
    values (v_ticket, 'outbound', v_body, p_mail_message_id, coalesce(m.sent_at, now()));

    return v_ticket;
  end if;

  -- Inbound, as 0054 left it: the thread's own link wins, through any
  -- merges, to the live ticket they lead to; otherwise the reference in the
  -- subject, cast only once it could be a ticket's number (0046: longer than
  -- ten digits, or past the largest integer, names no ticket).
  v_ticket := public.live_ticket_after_merges(m.ticket_id);

  if v_ticket is null then
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
    (v_ticket, m.contact_id, 'inbound', v_body, p_mail_message_id, coalesce(m.sent_at, now()));

  -- Keep the thread pointing at the ticket, so the next reply skips the
  -- lookup and the mail view can show the connection.
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
  'else to the live ticket named in its subject — following merges to the '
  'ticket kept — and reopens a waiting, resolved or closed ticket; and links '
  'an outbound message (a reply sent from Mail or Outlook) to the same ticket '
  'when its thread is already attached to one, reconciling it with a reply '
  'send-ticket-reply already recorded rather than doubling it. Returns the '
  'ticket id, or NULL when there is nothing live to follow: unmatched mail '
  'deliberately does not open a ticket (0035, 0046, 0054, 0056).';

-- store_mail_batch() as 0045 left it, but the routing gate also opens for a
-- newly-stored outbound message — never for one merely updated on conflict,
-- so re-syncing an unchanged message does not ask again — and is_staff_address
-- stays an inbound-only guard: an outbound message is already "from us" by
-- definition (directionFor in _shared/mail-store.ts already reads Sent Items
-- as outbound whoever the From header names). A routing failure still must
-- not lose the batch. Everything else — folders, thread state, the daily
-- sweep hook — is unchanged from 0045.

create or replace function public.store_mail_batch(p_connection uuid, p_folder text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      jsonb;
  v_thread   uuid;
  v_message  uuid;
  v_inserted boolean;
  v_threads  jsonb := '{}'::jsonb;
  v_ids      uuid[] := '{}';
  v_messages int := 0;
  v_routed   int := 0;
  v_mid      text;
  v_dir      text;
  v_copies   uuid[];
  v_this     uuid;
  v_replied  uuid[] := '{}';
begin
  if p_folder not in ('inbox', 'sent', 'archive', 'spam', 'trash') then
    raise exception 'store_mail_batch: unknown folder %', p_folder;
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_mid := nullif(v_row->>'internet_message_id', '');
    v_dir := coalesce(nullif(v_row->>'direction', ''), 'inbound');

    insert into public.mail_threads (connection_id, external_id, subject, snippet, folder)
    values (p_connection, v_row->>'thread_external_id', v_row->>'subject', v_row->>'snippet', p_folder)
    on conflict (connection_id, external_id) do update
      set folder = case
        -- Anything in the inbox keeps a conversation there; failing that, a
        -- message of ours keeps it in Sent, which the workspace lists.
        when excluded.folder = 'inbox' or mail_threads.folder = 'inbox' then 'inbox'
        when excluded.folder = 'sent' or mail_threads.folder = 'sent' then 'sent'
        else excluded.folder
      end
    returning id into v_thread;

    -- The stored copy this could be, under an older Graph id: same Message-ID,
    -- same direction, and where it was — the same folder, or, sent at the
    -- same moment, the inbox when it now turns up in archive, spam or trash,
    -- or filed as archive when it is back in the inbox (0045). Re-pointed
    -- only when there is exactly one, so a message we sent to our own
    -- mailbox — a Sent copy and an inbox copy under one Message-ID — never
    -- has one copy take the other's id.
    if v_mid is not null and not exists (
      select 1 from public.mail_messages x
      where x.thread_id = v_thread and x.external_id = v_row->>'external_id'
    ) then
      select array_agg(c.id) into v_copies
      from public.mail_messages c
      where c.thread_id = v_thread
        and c.internet_message_id = v_mid
        and c.direction = v_dir
        and (c.folder = p_folder
             or (c.sent_at is not distinct from (v_row->>'sent_at')::timestamptz
                 and ((c.folder = 'inbox' and p_folder in ('archive', 'spam', 'trash'))
                      or (c.folder = 'archive' and p_folder = 'inbox'))));

      if cardinality(v_copies) = 1 then
        update public.mail_messages
        set external_id = v_row->>'external_id'
        where id = v_copies[1];
      end if;
    end if;

    insert into public.mail_messages (
      thread_id, external_id, internet_message_id, folder, direction, from_name, from_email,
      to_emails, cc_emails, bcc_emails, subject, body_text, body_html, preview, sent_at,
      importance, has_attachments, is_read, is_flagged)
    values (
      v_thread, v_row->>'external_id', v_mid, p_folder, v_dir,
      v_row->>'from_name', v_row->>'from_email',
      coalesce(array(select jsonb_array_elements_text(v_row->'to_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(v_row->'cc_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(v_row->'bcc_emails')), '{}'),
      v_row->>'subject', v_row->>'body_text', v_row->>'body_html', left(v_row->>'snippet', 300),
      (v_row->>'sent_at')::timestamptz,
      coalesce(nullif(v_row->>'importance', ''), 'normal'),
      coalesce((v_row->>'has_attachments')::boolean, false),
      coalesce((v_row->>'is_read')::boolean, true),
      coalesce((v_row->>'is_flagged')::boolean, false))
    on conflict (thread_id, external_id) do update set
      internet_message_id = coalesce(excluded.internet_message_id, mail_messages.internet_message_id),
      folder          = excluded.folder,
      direction       = excluded.direction,
      subject         = excluded.subject,
      body_text       = excluded.body_text,
      body_html       = excluded.body_html,
      preview         = excluded.preview,
      bcc_emails      = excluded.bcc_emails,
      importance      = excluded.importance,
      has_attachments = excluded.has_attachments,
      is_read         = excluded.is_read,
      is_flagged      = excluded.is_flagged
    returning id, (xmax = 0) into v_message, v_inserted;

    v_messages := v_messages + 1;

    -- New mail from outside goes to its ticket — once, and never mail from
    -- one of us as the customer's own words (is_staff_address, inbound
    -- only: an outbound message is already ours by definition). A routing
    -- failure must not lose the batch: the mail is stored, and the worst
    -- case is one reply someone files by hand.
    if v_inserted and (
      (v_dir = 'inbound' and not public.is_staff_address(v_row->>'from_email')
       and not (v_mid is not null and exists (
         select 1 from public.mail_messages x
         where x.thread_id = v_thread and x.internet_message_id = v_mid
           and x.direction = 'inbound' and x.id <> v_message)))
      or v_dir = 'outbound'
    ) then
      begin
        v_this := public.route_mail_to_ticket(v_message);
        if v_this is not null then
          v_routed := v_routed + 1;
          -- Which tickets a CUSTOMER's reply just landed on, for the caller
          -- to tell the assignee (_shared/mail-sync.ts, 0056) — inbound
          -- only: a reply of ours reaching its ticket is not news to the
          -- assignee, who just sent it.
          if v_dir = 'inbound' and not (v_this = any(v_replied)) then
            v_replied := v_replied || v_this;
          end if;
        end if;
      exception when others then
        raise warning 'store_mail_batch: routing % failed: %', v_message, sqlerrm;
      end;
    end if;

    v_threads := v_threads || jsonb_build_object(v_row->>'thread_external_id', v_thread);
    if not (v_thread = any(v_ids)) then
      v_ids := v_ids || v_thread;
    end if;
  end loop;

  -- Taken over from the inbox by an archive, junk or deleted-items sync, a
  -- conversation's last inbox message takes the conversation with it.
  if p_folder in ('archive', 'spam', 'trash') then
    perform public.file_threads_out_of_inbox(v_ids, p_folder);
  end if;

  perform public.refresh_mail_thread_state(v_ids);

  return jsonb_build_object('threads', v_threads, 'messages', v_messages, 'routed', v_routed,
                             'repliedTickets', to_jsonb(v_replied));
end;
$$;

comment on function public.store_mail_batch(uuid, text, jsonb) is
  'Stores a page of synced mail, keeps each thread''s folder/state and mail_'
  'messages_maintain_thread''s columns current, and routes new mail to its '
  'ticket both ways: an inbound message as the customer''s words, an outbound '
  'one — a reply sent from Mail or Outlook — filed new since send-ticket-'
  'reply links its own replies itself (0038, 0045, 0056). repliedTickets in '
  'its answer names which tickets a CUSTOMER''s reply landed on, for '
  '_shared/mail-sync.ts to tell the assignee. Service role only.';

-- ── 3. Response targets per priority ────────────────────────────────────
-- A starting point, not a promise made to any customer — a manager can
-- change the minutes for a priority; nobody adds or removes a row, since the
-- four values here are exactly the priorities support_tickets.priority
-- already checks against.

create table if not exists public.ticket_response_targets (
  priority               text primary key
                           check (priority in ('low','normal','high','urgent')),
  first_response_minutes int not null check (first_response_minutes > 0),
  resolution_minutes     int not null check (resolution_minutes > 0),
  updated_at             timestamptz not null default now()
);

insert into public.ticket_response_targets (priority, first_response_minutes, resolution_minutes) values
  ('urgent', 30,   4 * 60),
  ('high',   2 * 60,   8 * 60),
  ('normal', 8 * 60,   3 * 24 * 60),
  ('low',    24 * 60,  7 * 24 * 60)
on conflict (priority) do nothing;

drop trigger if exists ticket_response_targets_touch_updated_at on public.ticket_response_targets;
create trigger ticket_response_targets_touch_updated_at
  before update on public.ticket_response_targets
  for each row execute function public.touch_updated_at();

alter table public.ticket_response_targets enable row level security;

drop policy if exists "staff read ticket_response_targets" on public.ticket_response_targets;
create policy "staff read ticket_response_targets"
  on public.ticket_response_targets for select using (public.is_staff());

drop policy if exists "manager writes ticket_response_targets" on public.ticket_response_targets;
create policy "manager writes ticket_response_targets"
  on public.ticket_response_targets for update
  using (public.is_manager()) with check (public.is_manager());

comment on table public.ticket_response_targets is
  'How long a first reply and a resolution should take, by priority — read by '
  'support_tickets_set_due_by() and shown on a ticket''s page. Exactly one row '
  'per priority; staff read, managers change the minutes (0056).';

-- Due-by times, kept current as a ticket is opened or its priority changes.
-- Always against created_at, never re-based from the moment priority
-- changed: raising a ticket to urgent tightens what it owes from when it
-- came in, which is the point of raising it. A priority the target table has
-- no row for (there should not be one) leaves both null rather than failing
-- the write.

alter table public.support_tickets
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolve_due_at         timestamptz;

comment on column public.support_tickets.first_response_due_at is
  'When a first reply is owed, from ticket_response_targets and created_at — '
  'kept current by support_tickets_set_due_by(). Null for a priority the '
  'target table has no row for.';
comment on column public.support_tickets.resolve_due_at is
  'When resolution is owed, the same way first_response_due_at is (0056).';

create or replace function public.support_tickets_set_due_by()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_target public.ticket_response_targets%rowtype;
begin
  select * into v_target from public.ticket_response_targets where priority = new.priority;
  if not found then
    new.first_response_due_at := null;
    new.resolve_due_at := null;
    return new;
  end if;
  new.first_response_due_at := new.created_at + make_interval(mins => v_target.first_response_minutes);
  new.resolve_due_at := new.created_at + make_interval(mins => v_target.resolution_minutes);
  return new;
end;
$$;

drop trigger if exists support_tickets_set_due_by on public.support_tickets;
create trigger support_tickets_set_due_by
  before insert or update of priority on public.support_tickets
  for each row execute function public.support_tickets_set_due_by();

-- Backfilled once for tickets already open when this ships; a ticket already
-- past its target keeps saying so rather than losing the fact.
update public.support_tickets st
set first_response_due_at = st.created_at + make_interval(mins => t.first_response_minutes),
    resolve_due_at         = st.created_at + make_interval(mins => t.resolution_minutes)
from public.ticket_response_targets t
where t.priority = st.priority
  and st.first_response_due_at is null;

-- ── 4. Attachments ───────────────────────────────────────────────────────
-- Same shape project_files (0039) already uses: a record after its upload,
-- storage paths that start with the ticket's own id, and whoever manages the
-- ticket or uploaded the file can remove it. "Manages" here is simpler than a
-- project's team — support_tickets has none — so it is just is_staff() to
-- read and add, is_manager() or the uploader to remove.

create table if not exists public.ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  -- The message it came with, when it came from an incoming email; null for
  -- one added straight to the ticket, or where 0056 ships before that
  -- carrying-over is built.
  message_id   uuid references public.ticket_messages(id) on delete set null,
  storage_path text not null unique,
  name         text not null check (length(trim(name)) between 1 and 255),
  size_bytes   bigint not null check (size_bytes > 0),
  content_type text not null default 'application/octet-stream',
  uploaded_by  uuid default public.active_employee_id()
                 references public.employees(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint ticket_attachments_in_their_ticket
    check (split_part(storage_path, '/', 1) = ticket_id::text)
);

create index if not exists ticket_attachments_ticket_idx
  on public.ticket_attachments (ticket_id, created_at desc);

comment on table public.ticket_attachments is
  'Files on a ticket: staff-uploaded, or carried over from an incoming email '
  '(message_id). storage_path always starts with the ticket''s own id (0056).';

-- A record is written after its upload, by whoever uploaded it, and
-- describes what was stored rather than what the browser said it stored —
-- the same check_project_file() does for project-files.
create or replace function public.check_ticket_attachment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb;
  v_uploader text;
begin
  select o.metadata, coalesce(o.owner_id, o.owner::text) into v_meta, v_uploader
  from storage.objects o
  where o.bucket_id = 'ticket-attachments' and o.name = new.storage_path;
  if not found then
    raise exception 'That file has not finished uploading';
  end if;
  -- Service role (a sync carrying an attachment over from email) has no
  -- auth.uid(), and uploaded_by is null for that path (0056 does not yet
  -- write it) — nothing to check in that case.
  if auth.uid() is not null and v_uploader is distinct from auth.uid()::text then
    raise exception 'Only whoever uploaded a file can record it';
  end if;
  new.size_bytes   := coalesce((v_meta->>'size')::bigint, new.size_bytes);
  new.content_type := coalesce(nullif(v_meta->>'mimetype', ''), new.content_type);
  return new;
end;
$$;

drop trigger if exists check_ticket_attachment on public.ticket_attachments;
create trigger check_ticket_attachment
  before insert on public.ticket_attachments
  for each row execute function public.check_ticket_attachment();

-- Storage paths start with the ticket's id. Compared as text, so a folder
-- that is not a uuid is simply no ticket rather than a cast error.
create or replace function public.can_open_ticket_attachment_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff()
     and exists (select 1 from public.support_tickets st where st.id::text = split_part(p_path, '/', 1));
$$;

create or replace function public.can_remove_ticket_attachment_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_open_ticket_attachment_path(p_path)
     and (not exists (select 1 from public.ticket_attachments f where f.storage_path = p_path)
          or exists (select 1 from public.ticket_attachments f
                     where f.storage_path = p_path
                       and (public.is_manager() or f.uploaded_by = public.active_employee_id())));
$$;

revoke all on function public.can_open_ticket_attachment_path(text), public.can_remove_ticket_attachment_path(text)
  from public, anon;
grant execute on function public.can_open_ticket_attachment_path(text), public.can_remove_ticket_attachment_path(text)
  to authenticated, service_role;

alter table public.ticket_attachments enable row level security;

drop policy if exists "staff read ticket attachment records" on public.ticket_attachments;
create policy "staff read ticket attachment records"
  on public.ticket_attachments for select to authenticated
  using (public.is_staff());

drop policy if exists "staff records ticket attachment uploads" on public.ticket_attachments;
create policy "staff records ticket attachment uploads"
  on public.ticket_attachments for insert to authenticated
  with check (public.is_staff());

drop policy if exists "manager or uploader removes ticket attachment record" on public.ticket_attachments;
create policy "manager or uploader removes ticket attachment record"
  on public.ticket_attachments for delete to authenticated
  using (public.is_staff() and (public.is_manager() or uploaded_by = public.active_employee_id()));

revoke insert, update on public.ticket_attachments from anon, authenticated;
grant insert (ticket_id, storage_path, name, size_bytes, content_type)
  on public.ticket_attachments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('ticket-attachments', 'ticket-attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "staff upload ticket attachments" on storage.objects;
create policy "staff upload ticket attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and public.is_staff()
    and public.can_open_ticket_attachment_path(name)
  );

drop policy if exists "staff read ticket attachments" on storage.objects;
create policy "staff read ticket attachments"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and public.can_open_ticket_attachment_path(name)
  );

drop policy if exists "manager or uploader remove ticket attachments" on storage.objects;
create policy "manager or uploader remove ticket attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and public.can_remove_ticket_attachment_path(name)
  );

-- ── 5. Telling the assignee ──────────────────────────────────────────────
-- Two new email_log kinds: ticket_assigned (notify-ticket, a new Edge
-- Function the workspace calls after assigning a ticket — the same pattern
-- notify-task already uses for tasks) and ticket_customer_reply (the mail
-- sync itself, once store_mail_batch says which tickets a reply just landed
-- on). Same drop-then-recreate as every earlier addition to this constraint
-- (0014, 0015, 0019, 0020, 0033, 0038): its autogenerated name drifts across
-- Supabase projects, so it is found by what it guards, not by name.

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from   pg_constraint con
    join   pg_class      rel on rel.oid = con.conrelid
    join   pg_namespace  nsp on nsp.oid = rel.relnamespace
    where  con.contype = 'c'
    and    nsp.nspname = 'public'
    and    rel.relname = 'email_log'
    and    con.conname ilike '%kind%'
  loop
    execute format('alter table public.email_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_log add constraint email_log_kind_check
  check (kind = any (array[
    'invite','password_reset','task_assigned','task_done','task_blocked',
    'task_updated','task_comment','digest','publish_requested','invoice',
    'enquiry_notify','enquiry_ack','ticket_reply','workspace_mail',
    'ticket_assigned','ticket_customer_reply'
  ]));

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'support_tickets'
        and column_name in ('requester_name', 'requester_email')) <> 2 then
    raise exception '0056: support_tickets is missing requester_name/requester_email';
  end if;
  if pg_get_functiondef('public.create_ticket_from_thread(uuid, text)'::regprocedure)
       not like '%t.last_from_name, t.last_from_email%' then
    raise exception '0056: create_ticket_from_thread() does not carry the sender over';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%m.direction = ''outbound''%'
     or pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%live_ticket_after_merges(m.ticket_id)%' then
    raise exception '0056: route_mail_to_ticket() does not file an outbound reply, or dropped the merge/deleted-ticket checks';
  end if;
  if not (position('lock table public.mail_threads in row exclusive mode'
                   in pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure))
          between 1 and position('live_ticket_after_merges(m.ticket_id)'
                                 in pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure))) then
    raise exception '0056: route_mail_to_ticket() can lock a ticket before the conversations, and deadlock with a merge';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'ticket_messages'
                   and column_name = 'internet_message_id') then
    raise exception '0056: ticket_messages is missing internet_message_id';
  end if;
  if pg_get_functiondef('public.route_mail_to_ticket(uuid)'::regprocedure)
       not like '%internet_message_id = m.internet_message_id%' then
    raise exception '0056: route_mail_to_ticket() does not match send-ticket-reply''s own reply by its Message-ID';
  end if;
  if pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure)
       not like '%or v_dir = ''outbound''%' then
    raise exception '0056: store_mail_batch() still never routes an outbound message';
  end if;
  if pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure)
       not like '%repliedTickets%' then
    raise exception '0056: store_mail_batch() does not say which tickets a customer''s reply landed on';
  end if;
  if has_function_privilege('authenticated', 'public.route_mail_to_ticket(uuid)', 'execute')
     or has_function_privilege('anon', 'public.route_mail_to_ticket(uuid)', 'execute') then
    raise exception '0056: a signed-in person could route mail onto a ticket';
  end if;
  if not exists (select 1 from public.ticket_response_targets where priority = 'urgent')
     or (select count(*) from public.ticket_response_targets) <> 4 then
    raise exception '0056: ticket_response_targets does not have exactly the four priorities';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'support_tickets'
        and column_name in ('first_response_due_at', 'resolve_due_at')) <> 2 then
    raise exception '0056: support_tickets is missing its due-by columns';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ticket_response_targets'::regclass) then
    raise exception '0056: ticket_response_targets does not have row level security enabled';
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'ticket_response_targets' and cmd = 'r') then
    raise exception '0056: ticket_response_targets has no read policy';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'ticket_attachments') then
    raise exception '0056: ticket_attachments is missing';
  end if;
  if not exists (select 1 from storage.buckets where id = 'ticket-attachments' and public = false) then
    raise exception '0056: the ticket-attachments bucket is missing, or is public';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.email_log'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%ticket_customer_reply%'
                   and pg_get_constraintdef(oid) like '%ticket_assigned%') then
    raise exception '0056: email_log does not accept the new ticket notification kinds';
  end if;
end
$$;
