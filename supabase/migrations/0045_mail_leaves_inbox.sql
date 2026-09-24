-- 0045_mail_leaves_inbox.sql — mail archived or deleted in Outlook leaves the
-- workspace inbox too.
--
-- The scheduled sync follows Graph's delta for Inbox and Sent Items. A message
-- deleted in Outlook, archived, or moved to another folder comes back from the
-- inbox's delta as "@removed", with only its id — and the sync counted those and
-- did nothing else, so a conversation could never leave the workspace inbox
-- (audit, 2026-09-14).
--
-- mail_left_folder() now files such messages out of the inbox, once Graph has
-- confirmed each one is gone (mail-sync.ts). Nothing is deleted, here or in
-- Outlook: a message is kept, filed as 'archive' — where it went is not
-- something the delta says — and its conversation leaves the inbox once none of
-- its messages is left there: for Sent while it holds a reply of ours, which the
-- workspace lists, and otherwise for the archive. An archive, junk or
-- deleted-items sync that takes over an inbox copy follows the same rule
-- (file_threads_out_of_inbox, section 1). A message that comes back into the
-- inbox under a new Graph id takes over the copy filed away rather than being
-- stored a second time (store_mail_batch, section 4).
--
-- What the delta never reported — mail filed away before this, while a mailbox
-- waited to be reconnected, or while a link had gone — is found by comparing
-- the inbox with a listing of Outlook's once a day (section 3).

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- The mail tables first, in the order store_mail_batch() takes them —
-- conversations, then messages. A batch already under way holds the first, so
-- this waits for it before holding anything; one that starts later waits for
-- this. Reading conversations carries on meanwhile; reading messages waits.
-- Inside a DO block: supabase db push sends a file's statements as one
-- pipeline with no BEGIN, where a bare LOCK TABLE is refused ("can only be used
-- in transaction blocks") and the push would stop here, after the migrations
-- before it. Taken in the block, the locks are held until the file's
-- transaction ends, as before.
do $$
begin
  lock table public.mail_threads in share row exclusive mode;
  lock table public.mail_messages in access exclusive mode;
end
$$;

-- When the schedule last compared a mailbox's inbox with Outlook's (section
-- 3). After the mail tables, not before: reading mail checks the mailbox's
-- connection only once it holds the mail tables, so taking the connections
-- first made this and a reader each wait for the other.
alter table public.integration_connections
  add column if not exists inbox_swept_at timestamptz;

-- ── 0. Every message says where it is ──────────────────────────────────
-- Messages stored before 0038 have no folder, so nothing below could file one
-- away — or see that it is still in the inbox. They take their conversation's
-- folder, and ours are in Sent. From here on none is stored without one:
-- store_mail_batch(), the only writer, always sets it.

update public.mail_messages m
set folder = case when m.direction = 'outbound' then 'sent' else coalesce(t.folder, 'inbox') end
from public.mail_threads t
where t.id = m.thread_id
  and m.folder is null;

-- Checked as it is added: splitting NOT VALID from VALIDATE saves nothing
-- inside one transaction, which holds the table's lock to the end either way.
do $$
begin
  alter table public.mail_messages
    add constraint mail_messages_folder_check
    check (folder is not null and folder in ('inbox', 'sent', 'archive', 'spam', 'trash'));
exception when duplicate_object then null;
end $$;

-- Messages are looked up by Graph id within a mailbox below; the only index on
-- it leads with the conversation.
create index if not exists mail_messages_external_id_idx on public.mail_messages (external_id);

-- ── 1. A conversation with nothing left in the inbox leaves it ──────────
-- One rule for everything that takes mail out of the inbox: Outlook no longer
-- having it there (mail_left_folder, section 2), and an archive, junk or
-- deleted-items sync taking over the inbox copy (store_mail_batch, section 4).
-- A conversation still holding a reply of ours goes to Sent, which the
-- workspace lists; any other goes where its mail went.

create or replace function public.file_threads_out_of_inbox(p_threads uuid[], p_to text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filed int;
begin
  if p_to is null or p_to not in ('archive', 'spam', 'trash') then
    raise exception 'file_threads_out_of_inbox: cannot file a conversation to %', coalesce(p_to, 'nowhere');
  end if;

  update public.mail_threads t
  set folder = case
    when exists (select 1 from public.mail_messages m where m.thread_id = t.id and m.folder = 'sent') then 'sent'
    else p_to
  end
  where t.id = any(coalesce(p_threads, '{}'))
    and t.folder = 'inbox'
    and not exists (select 1 from public.mail_messages m where m.thread_id = t.id and m.folder = 'inbox');

  get diagnostics v_filed = row_count;
  return v_filed;
end;
$$;

comment on function public.file_threads_out_of_inbox(uuid[], text) is
  'Takes conversations with no message left in the inbox out of it: to Sent '
  'while one holds a message of ours there, else to p_to. For '
  'mail_left_folder() and store_mail_batch() only (0045).';

revoke all on function public.file_threads_out_of_inbox(uuid[], text) from public, anon, authenticated, service_role;

-- ── 2. What Outlook no longer has in the inbox ──────────────────────────

create or replace function public.mail_left_folder(p_connection uuid, p_folder text, p_external_ids text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threads uuid[];
  v_moved   int;
begin
  -- Only the inbox is followed: a message gone from Sent Items changes nothing.
  if p_folder is distinct from 'inbox' then
    return 0;
  end if;

  with moved as (
    update public.mail_messages m
    set folder = 'archive'
    from public.mail_threads t
    where m.thread_id = t.id
      and t.connection_id = p_connection
      and m.folder = 'inbox'
      and m.external_id = any(coalesce(p_external_ids, '{}'))
    returning m.thread_id
  )
  select coalesce(array_agg(distinct moved.thread_id), '{}'), count(*)
    into v_threads, v_moved
  from moved;

  perform public.file_threads_out_of_inbox(v_threads, 'archive');

  return v_moved;
end;
$$;

comment on function public.mail_left_folder(uuid, text, text[]) is
  'Files messages Outlook no longer has in the inbox — by Graph id, for one '
  'connection — as archived, and their conversation too once nothing of it is '
  'left in the inbox (to Sent while it holds a reply of ours). Deletes nothing. '
  'Service role only (0045).';

revoke all on function public.mail_left_folder(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.mail_left_folder(uuid, text, text[]) to service_role;

-- ── 3. What the sync asks before filing anything ───────────────────────
-- The sync asks Graph about each message before filing it (mail-sync.ts), and
-- only about messages the workspace still shows in the inbox. These say which
-- those are: among the ids a delta reported gone, and — once a day — among
-- everything a complete listing of Outlook's inbox no longer has. Read-only.

create or replace function public.inbox_messages_among(p_connection uuid, p_external_ids text[])
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct m.external_id), '{}')
  from public.mail_messages m
  join public.mail_threads t on t.id = m.thread_id
  where t.connection_id = p_connection
    and m.folder = 'inbox'
    and m.external_id = any(coalesce(p_external_ids, '{}'));
$$;

-- p_since is how far back the listing holds everything — '-infinity' when it
-- holds the whole inbox. Graph lists by
-- receivedDateTime and sent_at is sentDateTime, a little earlier, so an hour's
-- margin keeps out a message received just after p_since. Newest first, at
-- most p_limit.
create or replace function public.inbox_messages_missing(
  p_connection uuid, p_since timestamptz, p_present_ids text[], p_present_mids text[], p_limit int)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(missing.external_id order by missing.sent_at desc), '{}')
  from (
    select m.external_id, m.sent_at
    from public.mail_messages m
    join public.mail_threads t on t.id = m.thread_id
    where t.connection_id = p_connection
      and m.folder = 'inbox'
      and m.sent_at >= p_since + interval '1 hour'
      and not exists (select 1 from unnest(coalesce(p_present_ids, '{}')) as present(id)
                      where present.id = m.external_id)
      and not exists (select 1 from unnest(coalesce(p_present_mids, '{}')) as present(mid)
                      where present.mid = m.internet_message_id)
    order by m.sent_at desc
    limit greatest(coalesce(p_limit, 0), 0)
  ) missing;
$$;

comment on function public.inbox_messages_missing(uuid, timestamptz, text[], text[], int) is
  'Messages the workspace shows in a mailbox''s inbox that a complete listing '
  'of Outlook''s inbox since p_since no longer has, by Graph id or Message-ID. '
  'For the daily comparison in sync-mail-scheduled. Service role only (0045).';

revoke all on function public.inbox_messages_among(uuid, text[]) from public, anon, authenticated;
revoke all on function public.inbox_messages_missing(uuid, timestamptz, text[], text[], int) from public, anon, authenticated;
grant execute on function public.inbox_messages_among(uuid, text[]) to service_role;
grant execute on function public.inbox_messages_missing(uuid, timestamptz, text[], text[], int) to service_role;

-- ── 4. A message back in the inbox takes over the copy filed away ────────
-- store_mail_batch() as 0038 left it, but for three things:
--   - which stored copy a message that comes back under a new Graph id may
--     take over: also one mail_left_folder() filed as 'archive', when the
--     message is back in the inbox. Without that, moving mail back in Outlook
--     would store it twice. A copy in another folder is taken over only when it
--     was sent at the same moment — a move keeps that — so a sender reusing a
--     Message-ID for a different message cannot merge the two;
--   - an archive, junk or deleted-items sync that took over the last inbox copy
--     of a conversation takes the conversation out of the inbox (section 1);
--   - a reply of ours puts a filed conversation in Sent, where the workspace
--     lists it, rather than leaving it in the archive.
-- Its grants stay as 0038 set them: service role only.

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

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'mail_left_folder') then
    raise exception '0045: mail_left_folder() is missing';
  end if;
  if pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure)
       not like '%c.folder = ''archive'' and p_folder = ''inbox''%' then
    raise exception '0045: store_mail_batch() does not take back a message returned to the inbox';
  end if;
  if has_function_privilege('authenticated', 'public.mail_left_folder(uuid, text, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.file_threads_out_of_inbox(uuid[], text)', 'execute')
     or has_function_privilege('authenticated', 'public.inbox_messages_among(uuid, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.inbox_messages_missing(uuid, timestamptz, text[], text[], int)', 'execute') then
    raise exception '0045: a signed-in person could read or file mail in a mailbox''s inbox';
  end if;
  if not (has_function_privilege('service_role', 'public.mail_left_folder(uuid, text, text[])', 'execute')
          and has_function_privilege('service_role', 'public.inbox_messages_among(uuid, text[])', 'execute')
          and has_function_privilege('service_role', 'public.inbox_messages_missing(uuid, timestamptz, text[], text[], int)', 'execute')) then
    raise exception '0045: the sync cannot run what it needs';
  end if;
  if pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure)
       not like '%file_threads_out_of_inbox(v_ids, p_folder)%' then
    raise exception '0045: an archive sync still leaves an empty conversation in the inbox';
  end if;
  if not (select has_function_privilege(p.proowner, 'public.file_threads_out_of_inbox(uuid[], text)', 'execute')
          from pg_proc p
          where p.oid = 'public.store_mail_batch(uuid, text, jsonb)'::regprocedure) then
    raise exception '0045: store_mail_batch() could not file a conversation: its owner cannot run file_threads_out_of_inbox()';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.mail_messages'::regclass
                   and conname = 'mail_messages_folder_check' and convalidated) then
    raise exception '0045: a message can still be stored without a folder';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'integration_connections'
                   and column_name = 'inbox_swept_at') then
    raise exception '0045: integration_connections.inbox_swept_at is missing';
  end if;
end
$$;
