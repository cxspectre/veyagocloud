-- =============================================================================
-- 0055 — Mail backend audit findings: who a conversation is with, linking mail
-- to the CRM by hand, attachments on a received message, searching a whole
-- mailbox, disconnecting your own, and clearing out uploads nobody sent.
--
-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace (0045's own
-- reasoning; this file touches the same two busy tables).
-- =============================================================================
set lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A thread is labelled with the OTHER party, not whoever wrote last.
--
--    0037 kept last_from_name/last_from_email from whichever message arrived
--    most recently, and matched a contact only from an inbound message's
--    From. Both read fine until we answer: our own reply is the newest
--    message, so a thread we replied to showed our own name where a
--    customer's belongs, and a thread we started ourselves — compose, before
--    any reply — never matched a contact at all, however long that address
--    had already been in the CRM.
--
--    other_party_name/other_party_email (renamed from last_from_name/email,
--    where 0037 already ran) hold whoever is NOT us: an inbound message's
--    sender, or — nothing has come back from an outbound one yet — its first
--    recipient that is not one of ours (is_staff_address, 0038). Maintained by
--    refresh_mail_thread_state() now, recomputed from every stored message
--    the same way subject and snippet already are, rather than incrementally
--    by the insert trigger: an outbound message never supplies a NAME for
--    whoever we wrote to (Graph's recipient list is addresses only), so it
--    can only ever fill an address in, never claim to know a name, and it
--    can never overwrite what an inbound reply already established.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name = 'last_from_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name = 'other_party_name'
  ) then
    alter table public.mail_threads rename column last_from_name to other_party_name;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name = 'last_from_email'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name = 'other_party_email'
  ) then
    alter table public.mail_threads rename column last_from_email to other_party_email;
  end if;
end $$;

-- A fresh install, where 0037 never ran under the old names, still ends up
-- with exactly these two columns.
alter table public.mail_threads
  add column if not exists other_party_name  text,
  add column if not exists other_party_email text;

comment on column public.mail_threads.other_party_email is
  'Whoever is on the other side of this conversation — never our own address, '
  'whichever of us wrote most recently. Recomputed by refresh_mail_thread_state() '
  'from every stored message (0055; was last_from_email, named for whoever sent '
  'the newest one, which showed our own address on a thread we answered).';
comment on column public.mail_threads.other_party_name is
  'The other party''s display name, from the newest INBOUND message only — an '
  'outbound one has no name for whoever we wrote to, only an address (0055).';

-- The insert trigger still maintains message_count, last_message_at and the
-- CRM match the moment a message is stored — only the match is broadened, to
-- the same "whichever address is not ours" rule as the other-party columns,
-- so a thread we start ourselves can match a contact immediately rather than
-- waiting for a reply that may never come. Still fills a blank only, never
-- overwrites a link a person made by hand (link_mail_thread, below) or one an
-- earlier message already set.
create or replace function public.mail_messages_maintain_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact uuid;
  v_company uuid;
  v_other   text;
begin
  v_other := case
    when new.direction = 'inbound' then new.from_email
    else (
      select addr.email
      from unnest(coalesce(new.to_emails, '{}') || coalesce(new.cc_emails, '{}')) as addr(email)
      where addr.email is not null and addr.email <> '' and not public.is_staff_address(addr.email)
      limit 1
    )
  end;

  if v_other is not null then
    select id, company_id into v_contact, v_company
    from public.crm_contacts
    where lower(email) = lower(v_other) and deleted_at is null
    limit 1;
  end if;

  update public.mail_threads t
  set message_count   = (select count(*) from public.mail_messages m where m.thread_id = new.thread_id),
      last_message_at = greatest(coalesce(t.last_message_at, new.sent_at), new.sent_at),
      contact_id      = coalesce(t.contact_id, v_contact),
      company_id      = coalesce(t.company_id, v_company),
      updated_at      = now()
  where t.id = new.thread_id;

  return new;
end;
$$;

-- refresh_mail_thread_state() already recomputes is_read, is_starred, subject
-- and snippet from every message a thread holds, in one statement, so two
-- overlapping writers cannot put back each other's stale state (0038). The
-- other party's name and address join that list: the newest INBOUND sender
-- when there is one, else the first external recipient of our own newest
-- outbound message — so a conversation we started shows who we wrote to,
-- never our own name, until they answer.
create or replace function public.refresh_mail_thread_state(p_threads uuid[])
returns setof public.mail_threads
language sql
security definer
set search_path = public
as $$
  update public.mail_threads t set
    is_read = not exists (
      select 1 from public.mail_messages m
      where m.thread_id = t.id and m.direction = 'inbound' and not m.is_read),
    is_starred = exists (
      select 1 from public.mail_messages m
      where m.thread_id = t.id and m.is_flagged),
    subject = coalesce((
      select m.subject from public.mail_messages m
      where m.thread_id = t.id order by m.sent_at desc limit 1), t.subject),
    snippet = coalesce((
      select m.preview from public.mail_messages m
      where m.thread_id = t.id order by m.sent_at desc limit 1), t.snippet),
    other_party_name = coalesce((
      select m.from_name from public.mail_messages m
      where m.thread_id = t.id and m.direction = 'inbound'
      order by m.sent_at desc limit 1), t.other_party_name),
    other_party_email = coalesce(
      (select m.from_email from public.mail_messages m
       where m.thread_id = t.id and m.direction = 'inbound'
       order by m.sent_at desc limit 1),
      (select addr.email
       from public.mail_messages m,
            unnest(coalesce(m.to_emails, '{}') || coalesce(m.cc_emails, '{}')) as addr(email)
       where m.thread_id = t.id and m.direction = 'outbound'
         and addr.email is not null and addr.email <> '' and not public.is_staff_address(addr.email)
       order by m.sent_at desc
       limit 1),
      t.other_party_email)
  where t.id = any(p_threads)
  returning t.*;
$$;

-- Threads already stored, worked out fresh the same way a live sync would.
select public.refresh_mail_thread_state(array(select id from public.mail_threads));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Linking mail to the CRM by hand, and catching up what arrived before a
--    contact existed.
--
--    A contact was matched only at the moment a message was stored, above and
--    in 0037 before it — nothing revisited a thread once its sender was
--    finally added to the CRM, and nobody could correct a wrong match, or add
--    one, by hand. link_mail_thread() is the by-hand half: any member of
--    staff who can already read a conversation may say who it is with, the
--    same permission crm_contacts/crm_companies writes already use (0021) —
--    p_contact null clears it. rematch_mail_threads() is the catching-up
--    half, for whatever is still unmatched, using the other_party_email
--    refresh_mail_thread_state() now keeps on every thread; a manager's call,
--    since — unlike one conversation someone is already looking at — it
--    reaches into every mailbox at once, including ones the caller cannot
--    themselves read.
--
--    A full back-fill (every never-matched thread, re-checked automatically
--    whenever a new contact is added) is a larger job than this migration
--    takes on: rematch_mail_threads() is the tool for it, run by hand, or
--    later wired to a schedule or to contact creation — not done here.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.link_mail_thread(p_thread uuid, p_contact uuid)
returns public.mail_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_row     public.mail_threads;
begin
  if not public.is_staff() then
    raise exception 'Only staff can link mail to the CRM.' using errcode = '42501';
  end if;

  perform 1 from public.mail_threads t
  where t.id = p_thread and public.can_read_connection(t.connection_id);
  if not found then
    raise exception 'No such conversation, or it is not yours to open';
  end if;

  if p_contact is not null then
    select c.company_id into v_company
    from public.crm_contacts c
    where c.id = p_contact and c.deleted_at is null;
    if not found then
      raise exception 'That contact is not in the CRM.'
        using errcode = '23503', detail = json_build_object('contact_id', p_contact)::text;
    end if;
  end if;

  update public.mail_threads
  set contact_id = p_contact, company_id = v_company, updated_at = now()
  where id = p_thread
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.link_mail_thread(uuid, uuid) is
  'Sets — or, p_contact null, clears — a conversation''s CRM contact by hand, '
  'company_id following from it. Requires being able to read the thread; any '
  'member of staff, matching crm_contacts/crm_companies writes (0021, 0055).';

revoke all on function public.link_mail_thread(uuid, uuid) from public, anon;
grant execute on function public.link_mail_thread(uuid, uuid) to authenticated;

create or replace function public.rematch_mail_threads(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matched int;
begin
  if not public.is_manager() then
    raise exception 'Only an owner or admin can rematch mail to the CRM.' using errcode = '42501';
  end if;

  with candidates as (
    select t.id as thread_id, c.id as contact_id, c.company_id
    from public.mail_threads t
    join public.crm_contacts c
      on lower(c.email) = lower(t.other_party_email) and c.deleted_at is null
    where t.contact_id is null
      and t.other_party_email is not null
    limit greatest(coalesce(p_limit, 500), 1)
  )
  update public.mail_threads t
  set contact_id = candidates.contact_id,
      company_id = candidates.company_id,
      updated_at = now()
  from candidates
  where t.id = candidates.thread_id;

  get diagnostics v_matched = row_count;
  return v_matched;
end;
$$;

comment on function public.rematch_mail_threads(int) is
  'Matches whatever mail still has no CRM contact against other_party_email, '
  'up to p_limit rows at a time — the back-fill nothing has ever done for mail '
  'stored before its sender was added to the CRM. Manager only: unlike '
  'link_mail_thread, this reaches into every mailbox at once, including ones '
  'the caller cannot themselves read (0055).';

revoke all on function public.rematch_mail_threads(int) from public, anon;
grant execute on function public.rematch_mail_threads(int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Attachments on a stored message.
--
--    Graph's hasAttachments only ever became mail_messages.has_attachments
--    (0038) — a flag, never the files it flags. Nothing fetched what they
--    were, so a received message with a PDF attached, or an inline logo in
--    its signature, showed neither: has_attachments sat there unused, and an
--    inline <img src="cid:...">  in body_html pointed at nothing the workspace
--    ever had.
--
--    mail_attachments is metadata only — name, kind, size, and, for an inline
--    image, its cid — the same choice 0038 made for outgoing attachments
--    (kept in Storage, not the database, until send-mail actually needs the
--    bytes). Fetching and storing the bytes themselves — enough to make an
--    inline image actually render, or to offer a download — is real work of
--    its own (a Graph call per attachment, and somewhere to serve the result
--    from) and is not done here; mail-sync.ts now fetches the metadata list,
--    and store_mail_batch() files it alongside the message it belongs to.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.mail_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.mail_messages(id) on delete cascade,
  external_id  text not null,                              -- Graph attachment id
  name         text not null default '',
  content_type text not null default 'application/octet-stream',
  size         bigint not null default 0,
  is_inline    boolean not null default false,
  content_id   text,                                        -- cid: reference for an inline image
  created_at   timestamptz not null default now()
);

-- Leads with message_id, so this alone also serves "this message's
-- attachments" — a second, plain (message_id) index would only repeat it.
create unique index if not exists mail_attachments_external_idx
  on public.mail_attachments (message_id, external_id);

alter table public.mail_attachments enable row level security;

drop policy if exists "read attachments of a readable message" on public.mail_attachments;
create policy "read attachments of a readable message"
  on public.mail_attachments for select
  using (exists (
    select 1 from public.mail_messages m
    join public.mail_threads t on t.id = m.thread_id
    where m.id = message_id and public.can_read_connection(t.connection_id)
  ));

-- Written only by store_mail_batch (service role) — a person reads what a
-- mailbox holds and never edits it, the same as mail_messages itself (0025).
revoke insert, update, delete on public.mail_attachments from anon, authenticated;

comment on table public.mail_attachments is
  'Attachment metadata for a stored message. Content stays at Graph until a '
  'download path fetches it on demand — not built yet. Written only by '
  'store_mail_batch() (0055).';

-- store_mail_batch(), as 0045 left it, but for one thing: a row's optional
-- 'attachments' array (mail-sync.ts's AttachmentRow list, one call to Graph
-- per message that says hasAttachments) is stored alongside the message it
-- belongs to. Replaced wholesale on a re-sync of the SAME message, rather
-- than merged — simpler, and Graph attachments do not change once a message
-- exists — but only when the array actually has something in it: a transient
-- failure fetching the list (mail-sync.ts swallows that error and hands back
-- an empty one, so it never fails the mail underneath it) must not wipe a
-- list an earlier, successful sync already stored.
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
    -- same direction, and where it was — the same folder, or, sent at the same
    -- moment, the inbox when it now turns up in archive, spam or trash, or
    -- filed as archive when it is back in the inbox (0045). Re-pointed only when
    -- there is exactly one, so a message we sent to our own mailbox — a Sent
    -- copy and an inbox copy under one Message-ID — never has one copy take the
    -- other's id.
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

    -- Attachment metadata (0055), when the caller supplied a non-empty list.
    if jsonb_typeof(v_row->'attachments') = 'array' and jsonb_array_length(v_row->'attachments') > 0 then
      delete from public.mail_attachments where message_id = v_message;
      insert into public.mail_attachments (message_id, external_id, name, content_type, size, is_inline, content_id)
      select v_message,
             a->>'external_id',
             coalesce(nullif(a->>'name', ''), 'attachment'),
             coalesce(nullif(a->>'content_type', ''), 'application/octet-stream'),
             coalesce((a->>'size')::bigint, 0),
             coalesce((a->>'is_inline')::boolean, false),
             nullif(a->>'content_id', '')
      from jsonb_array_elements(v_row->'attachments') a
      where nullif(a->>'external_id', '') is not null;
    end if;

    -- New mail from outside goes to its ticket — once, and never mail from one
    -- of us (is_staff_address, below). A routing failure must not lose the
    -- batch: the mail is stored, and the worst case is one reply someone files
    -- by hand.
    if v_inserted and v_dir = 'inbound'
       and not public.is_staff_address(v_row->>'from_email')
       and not (v_mid is not null and exists (
         select 1 from public.mail_messages x
         where x.thread_id = v_thread and x.internet_message_id = v_mid
           and x.direction = 'inbound' and x.id <> v_message)) then
      begin
        if public.route_mail_to_ticket(v_message) is not null then
          v_routed := v_routed + 1;
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

  return jsonb_build_object('threads', v_threads, 'messages', v_messages, 'routed', v_routed);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Full-text search across a whole mailbox, not only the folders and pages
--    already loaded on screen (mail-model.js's visibleThreads filters the
--    threads a page already has, by sender, subject and preview — nothing
--    reaches a word buried in a message body, or mail outside the
--    200-per-folder page queries.js loads).
--
--    search_text is trigger-maintained rather than a GENERATED column:
--    Postgres refuses to_tsvector(regconfig, text) there, since it is STABLE
--    rather than IMMUTABLE (the text search configuration itself can change)
--    — a trigger is also the shape every other derived value on this table
--    already takes (mail_messages_maintain_thread, refresh_mail_thread_state).
--    Subject and sender outrank the body (setweight), so a search for
--    someone's name finds who wrote before it finds an incidental mention of
--    them in a message's text.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.mail_messages add column if not exists search_text tsvector;

create or replace function public.mail_messages_set_search_text()
returns trigger
language plpgsql
as $$
begin
  new.search_text :=
    setweight(to_tsvector('english', coalesce(new.subject, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.from_name, '') || ' ' || coalesce(new.from_email, '')), 'B')
    || setweight(to_tsvector('english', left(coalesce(new.body_text, ''), 50000)), 'C');
  return new;
end;
$$;

drop trigger if exists mail_messages_set_search_text on public.mail_messages;
create trigger mail_messages_set_search_text
  before insert or update on public.mail_messages
  for each row execute function public.mail_messages_set_search_text();

create index if not exists mail_messages_search_idx on public.mail_messages using gin (search_text);

-- Messages already stored before this migration.
update public.mail_messages
set search_text =
  setweight(to_tsvector('english', coalesce(subject, '')), 'A')
  || setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || coalesce(from_email, '')), 'B')
  || setweight(to_tsvector('english', left(coalesce(body_text, ''), 50000)), 'C')
where search_text is null;

-- One row per matching conversation (its best-ranked message), best match
-- first, RLS applied by hand (can_read_connection) since the join and the
-- index need this to run as security definer. A blank query, or one that is
-- nothing but punctuation websearch_to_tsquery cannot use, returns no rows
-- rather than falling back to "everything" — a cleared search box is the one
-- time it must not become a full mailbox listing.
create or replace function public.search_mail(p_query text, p_limit int default 30)
returns table (
  thread_id     uuid,
  connection_id uuid,
  subject       text,
  snippet       text,
  sent_at       timestamptz,
  rank          real
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_query tsquery;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;
  if p_query is null or btrim(p_query) = '' then
    return;
  end if;
  v_query := websearch_to_tsquery('english', p_query);
  if numnode(v_query) = 0 then
    return;
  end if;

  return query
    select best.thread_id, best.connection_id, best.subject, best.snippet, best.sent_at, best.rank
    from (
      select distinct on (m.thread_id)
             m.thread_id, t.connection_id, m.subject,
             left(coalesce(m.body_text, ''), 200) as snippet, m.sent_at,
             ts_rank(m.search_text, v_query) as rank
      from public.mail_messages m
      join public.mail_threads t on t.id = m.thread_id
      where m.search_text @@ v_query
        and public.can_read_connection(t.connection_id)
      order by m.thread_id, ts_rank(m.search_text, v_query) desc, m.sent_at desc
    ) best
    order by best.rank desc, best.sent_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

comment on function public.search_mail(text, int) is
  'Full-text search across every message this person could already read '
  '(can_read_connection), one row per matching conversation, best match '
  'first. Subject and sender outrank the body — see the weights in '
  'mail_messages_set_search_text() (0055).';

revoke all on function public.search_mail(text, int) from public, anon;
grant execute on function public.search_mail(text, int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Disconnecting your own personal mailbox needs nobody's permission but
--    yours.
--
--    Reconnecting already works this way — microsoft-connect's own rule is
--    "anyone on staff reconnects their own", a studio connection only needing
--    an owner or admin. But 0038's UPDATE policy required is_manager() for
--    ANY change to ANY connection, including disconnecting a plain member of
--    staff's own personal mailbox: nobody but a manager who happened to have
--    connected a personal mailbox themselves could ever switch one off, so
--    "Reconnect" was the only action that could ever be wired to a button.
--
--    The trigger from 0038 (integration_connections_browser_can_only_disconnect)
--    still says WHAT a browser may change on a row it can reach — this only
--    widens WHOSE row that is, to match what reconnecting already allows.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "manager updates studio or own integration_connections" on public.integration_connections;
create policy "staff updates studio or own integration_connections"
  on public.integration_connections for update
  using (
    (public.is_manager() and employee_id is null)
    or employee_id = public.active_employee_id()
  )
  with check (
    (public.is_manager() and employee_id is null)
    or employee_id = public.active_employee_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Attachments nobody ever sent, cleared by themselves.
--
--    send-mail already removes a message's uploads from the mail-attachments
--    bucket the moment it sends (0038 §5); a draft closed without sending, a
--    page refreshed away mid-compose, leaves its files there for good, since
--    nothing else ever looks at them again — compose keeps no "still open"
--    record anywhere the database can see. Once a day, well after any real
--    compose session could still be open (attachment-cleanup.ts's
--    STALE_AFTER_HOURS), cleanup-mail-attachments removes what age alone
--    marks as abandoned. The same secret as the mail sync (0038 §9): both
--    represent "the cron job", not a person, and are no more sensitive than
--    one another.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'cleanup-mail-attachments';
  perform cron.schedule(
    'cleanup-mail-attachments',
    '15 3 * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/cleanup-mail-attachments',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it took.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name in ('last_from_name', 'last_from_email')
  ) then
    raise exception '0055: mail_threads still has last_from_name/last_from_email';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_threads' and column_name = 'other_party_email'
  ) then
    raise exception '0055: mail_threads.other_party_email is missing';
  end if;
  if pg_get_functiondef('public.mail_messages_maintain_thread()'::regprocedure) like '%last_from%' then
    raise exception '0055: the insert trigger still writes the old column names';
  end if;
  if not exists (select 1 from pg_class where relname = 'mail_attachments' and relnamespace = 'public'::regnamespace) then
    raise exception '0055: mail_attachments is missing';
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'mail_attachments'
  ) then
    raise exception '0055: mail_attachments has no RLS policy';
  end if;
  if has_table_privilege('authenticated', 'public.mail_attachments', 'insert')
     or has_table_privilege('authenticated', 'public.mail_attachments', 'update')
     or has_table_privilege('authenticated', 'public.mail_attachments', 'delete') then
    raise exception '0055: a signed-in person could write mail_attachments directly';
  end if;
  if pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure)
       not like '%mail_attachments%' then
    raise exception '0055: store_mail_batch() does not store attachment metadata';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_mail'
  ) then
    raise exception '0055: search_mail() is missing';
  end if;
  if has_function_privilege('anon', 'public.search_mail(text, int)', 'execute') then
    raise exception '0055: anon can search mail';
  end if;
  if not has_function_privilege('authenticated', 'public.link_mail_thread(uuid, uuid)', 'execute') then
    raise exception '0055: link_mail_thread() is not callable';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'integration_connections' and cmd = 'UPDATE'
      and policyname = 'staff updates studio or own integration_connections'
  ) then
    raise exception '0055: the widened disconnect policy is missing';
  end if;
  if not exists (select 1 from cron.job where jobname = 'cleanup-mail-attachments') then
    raise exception '0055: the attachment cleanup schedule is missing';
  end if;
end
$$;
