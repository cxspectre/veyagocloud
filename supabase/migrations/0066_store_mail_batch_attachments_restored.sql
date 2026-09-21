-- 0066_store_mail_batch_attachments_restored.sql — store_mail_batch() stopped
-- storing attachment metadata the moment 0056 shipped.
--
-- 0055 added the block that writes mail_attachments from the sync's own
-- payload. 0056 then replaced the whole function to route outbound mail as
-- well — written in an isolated worktree off a base that predated 0055, so its
-- copy simply did not contain that block, and `create or replace` dropped it.
-- Same collision as 0065's (create_ticket_from_thread) and the one 0059 hit in
-- mail_messages_maintain_thread; this is the third and, per a sweep of every
-- function these two migrations both define, the last.
--
-- What it broke, quietly and completely: nothing has been written to
-- mail_attachments since 0056 went live, so a customer's screenshot or signed
-- PDF still vanishes — the exact failure 0063 was written to fix. With no rows
-- there, mail-attachment-content has nothing to fetch, and
-- notify_ticket_attachment_carry()'s `if not exists (select 1 from
-- mail_attachments where message_id = ...)` returns early every single time,
-- so carry-ticket-attachments is never even asked to run. has_attachments on
-- the message stayed true throughout, which is why the workspace showed a
-- paperclip on mail whose attachments it could never open.
--
-- This is 0056's function verbatim — outbound routing, repliedTickets and all
-- — with 0055's attachment block restored to the position it held there.
-- Nothing else changes.

set lock_timeout = '5s';

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

    -- Attachment metadata (0055), when the caller supplied a non-empty list.
    -- A re-sync whose own fetch of the list came back empty sends no list at
    -- all rather than an empty one (mail-sync.ts swallows that failure), so
    -- the absent key must leave what is already stored alone.
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
  'messages_maintain_thread''s columns current, stores what came attached to '
  'each message (0055, restored in 0066 after 0056 replaced the function '
  'without it), and routes new mail to its ticket both ways: an inbound '
  'message as the customer''s words, an outbound one — a reply sent from Mail '
  'or Outlook — filed new since send-ticket-reply links its own replies '
  'itself (0038, 0045, 0056). repliedTickets in its answer names which '
  'tickets a CUSTOMER''s reply landed on, for _shared/mail-sync.ts to tell '
  'the assignee. Service role only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it took: the attachment block is back AND 0056's own routing survived.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_def text := pg_get_functiondef('public.store_mail_batch(uuid, text, jsonb)'::regprocedure);
begin
  if v_def not like '%mail_attachments%' then
    raise exception '0066: store_mail_batch() still does not store attachment metadata';
  end if;
  if v_def not like '%repliedTickets%' then
    raise exception '0066: store_mail_batch() lost 0056''s repliedTickets answer';
  end if;
  if v_def not like '%v_dir = ''outbound''%' then
    raise exception '0066: store_mail_batch() lost 0056''s outbound routing';
  end if;
  if has_function_privilege('anon', 'public.store_mail_batch(uuid, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.store_mail_batch(uuid, text, jsonb)', 'execute') then
    raise exception '0066: store_mail_batch() must stay service-role only';
  end if;
end $$;
