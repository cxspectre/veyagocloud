-- =============================================================================
-- 0069 — Moving mail: the workspace may now archive a conversation, mark it as
-- junk, or delete it.
--
-- FOUND: the workspace was read-only about where a message lives. Only Inbox
-- and Sent were ever loaded, _shared/graph-guard.ts refused a Graph move
-- outright, and the only thing that ever took a conversation out of the inbox
-- was somebody doing it in Outlook and the sync noticing (0045). A person
-- reading their mail here had no way to clear anything: every conversation
-- they had dealt with stayed in the list for good.
--
-- WHAT CHANGES, AND WHY THE SHAPE IT HAS:
--
--   Delete means Outlook's Deleted Items and nothing else. The owner's
--   decision (2026-09-21) is "archive, junk and delete, where delete is a move
--   to Deleted Items, never a permanent purge", and nothing here — or in
--   graph-guard.ts, or in _shared/mail-move.ts — may ever hard-delete a
--   message. A conversation moved to trash keeps every one of its rows, in
--   both databases: ours and Microsoft's.
--
--   This reuses 0045 rather than inventing a second way for mail to leave the
--   inbox. 0045 already answers the hard question — when does a CONVERSATION
--   leave, given that only its messages actually move — in
--   file_threads_out_of_inbox(): once nothing of it is left in the inbox, it
--   goes to Sent while it still holds a reply of ours (which the workspace
--   lists), and otherwise where its mail went. mail_moved() below files the
--   messages and then calls that same function, so a conversation archived
--   from this workspace and one archived in Outlook and noticed by the sync
--   end up in exactly the same place by exactly the same rule.
--
--   One rule 0045 did not need, added here. file_threads_out_of_inbox() only
--   ever considers a thread whose folder is 'inbox', because the only mail the
--   sync follows for removals is the inbox's (mail_left_folder's own first
--   line). A person can archive a conversation sitting in SENT, though, and
--   0045 has nothing to say about that: section 2 below files such a thread
--   the same way, once nothing of it is left in either listed folder. That is
--   an addition beside file_threads_out_of_inbox(), deliberately not a change
--   to it — that function is also called by mail_left_folder() and by
--   store_mail_batch() (whose current text is 0066's, after 0056 replaced 0055
--   and silently dropped a block), and widening what it does would change the
--   sync's behaviour as a side effect of a button in Mail.
--
--   Nothing here is callable by a browser. mail_moved() is service-role only,
--   like mail_left_folder(): the Edge Function move-mail-thread checks who is
--   asking, reads the thread AS the caller so RLS decides whether it is theirs
--   to touch, moves the messages in Outlook first, and only then calls this
--   with what Outlook actually took. Outlook is the source of truth for where
--   a message is — filing one here that Graph never moved would simply be
--   undone by the next delta, which would store it back under 'inbox'.
--
--   external_id changes on a move. Graph's POST /messages/{id}/move answers
--   with the message under a NEW id, and mail-attachment-content (0063) and
--   the read/starred writer (update-mail-state) both address a message by the
--   id we stored. So mail_moved() takes the new id alongside our own row id
--   and writes it, rather than leaving a stale id behind for the next person
--   who opens an attachment.
--
-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace (0045's own
-- reasoning; this file touches the same two busy mail tables).
-- =============================================================================
set lock_timeout = '5s';

-- The mail tables in the order store_mail_batch() takes them — conversations,
-- then messages — so this migration and a sync batch already under way cannot
-- deadlock against each other (0045's own reasoning, and its own ordering).
-- Inside a DO block: supabase db push sends a file's statements as one
-- pipeline with no BEGIN, where a bare LOCK TABLE is refused.
do $$
begin
  lock table public.mail_threads in share row exclusive mode;
  lock table public.mail_messages in access exclusive mode;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. What the workspace records once Outlook has taken a move.
--
--    p_moves is one entry per message Graph actually moved:
--      [{"id": "<mail_messages.id>", "external_id": "<the NEW Graph id>"}]
--    Only messages in it are touched. A message the Edge Function ran out of
--    time for, or one Graph answered 404 for (it had already moved), is left
--    exactly as it was — the store and Outlook are never made to disagree by a
--    change that only landed on one side, which is the same rule
--    update-mail-state follows for read and starred.
--
--    Returns the conversation as it now stands, the way link_mail_thread()
--    (0055) returns the thread it changed, so the caller can answer the
--    browser with the row rather than asking for it again.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.mail_moved(p_thread uuid, p_to text, p_moves jsonb)
returns public.mail_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.mail_threads;
begin
  -- The same three the owner named, and the same three graph-guard.ts will
  -- let a Graph call reach. 'inbox' and 'sent' are deliberately absent: mail
  -- comes BACK to the inbox by being synced back (store_mail_batch, 0045
  -- section 4), never by this.
  if p_to is null or p_to not in ('archive', 'spam', 'trash') then
    raise exception 'mail_moved: cannot file a conversation to %', coalesce(p_to, 'nowhere');
  end if;

  if not exists (select 1 from public.mail_threads t where t.id = p_thread) then
    raise exception 'mail_moved: no such conversation';
  end if;

  -- Where each message now is, and under which Graph id. Joined on our own
  -- row id AND the thread, so a caller that passed an id from another
  -- conversation moves nothing rather than filing a stranger's mail.
  with moves as (
    select (entry->>'id')::uuid as id, nullif(entry->>'external_id', '') as external_id
    from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) entry
    where nullif(entry->>'id', '') is not null
  )
  update public.mail_messages m
  set folder = p_to,
      -- The new id, unless another message of this conversation is already
      -- stored under it: a sync of the destination folder that ran between
      -- Graph taking the move and this call would have stored the moved copy
      -- itself, and taking its id here would break (thread_id, external_id)
      -- and lose the whole move to a unique violation. Left alone, the two
      -- copies are settled the way they already are everywhere else — by
      -- store_mail_batch()'s own take-over rule (0045 section 4).
      external_id = case
        when moves.external_id is null then m.external_id
        when exists (select 1 from public.mail_messages x
                     where x.thread_id = p_thread and x.external_id = moves.external_id and x.id <> m.id)
          then m.external_id
        else moves.external_id
      end
  from moves
  where m.id = moves.id and m.thread_id = p_thread;

  -- 0045's rule for a conversation with nothing left in the inbox, unchanged
  -- and uncopied: to Sent while it holds a reply of ours there, else to p_to.
  perform public.file_threads_out_of_inbox(array[p_thread], p_to);

  -- And the same rule for one sitting in Sent, which 0045 never had to
  -- consider (see this file's header). A conversation the person archived
  -- from the Sent folder has nothing of it left in either folder the
  -- workspace lists, so it follows its mail out.
  update public.mail_threads t
  set folder = p_to, updated_at = now()
  where t.id = p_thread
    and t.folder = 'sent'
    and not exists (
      select 1 from public.mail_messages m
      where m.thread_id = t.id and m.folder in ('inbox', 'sent'));

  -- Read and starred worked out again from the messages, exactly as every
  -- sync and update-mail-state already do it (refresh_mail_thread_state,
  -- 0038/0055) — never written from this call. It returns the thread, so
  -- there is nothing further to read.
  select * into v_row from public.refresh_mail_thread_state(array[p_thread]);
  if v_row.id is null then
    select * into v_row from public.mail_threads where id = p_thread;
  end if;

  return v_row;
end;
$$;

comment on function public.mail_moved(uuid, text, jsonb) is
  'Records a move Outlook has already taken: files the named messages as '
  'archive, spam or trash under their new Graph ids, then lets 0045''s own '
  'file_threads_out_of_inbox() decide where the conversation itself goes (and '
  'the same rule again for one sitting in Sent, which 0045 never had to '
  'consider). Deletes nothing, here or in Outlook — trash is Deleted Items. '
  'Service role only: move-mail-thread checks who is asking and reads the '
  'thread as them first (0069).';

revoke all on function public.mail_moved(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.mail_moved(uuid, text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The messages a move would touch, read as the person asking.
--
--    move-mail-thread needs the conversation's messages to know what to send
--    Graph, and it must not see one in a mailbox that is not the caller's to
--    read. It already reads the THREAD as the caller (RLS, can_read_connection
--    — 0025), and mail_messages carries its own policy over the same rule, so
--    a plain select as the caller would do. This exists for the narrower
--    reason that the Edge Function should ask for exactly the four columns
--    _shared/mail-move.ts needs and no message body at all: a conversation
--    holding twenty HTML emails is megabytes of body_html that this operation
--    has no use for whatsoever.
--
--    security INVOKER, deliberately — mail_messages' own policy decides, the
--    same choice 0062 made for mail_unread_counts() and for the same reason:
--    a second copy of the visibility rule is a second thing to drift.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.mail_thread_placement(p_thread uuid)
returns table (id uuid, external_id text, direction text, folder text)
language sql
stable
security invoker
set search_path = public
as $$
  select m.id, m.external_id, m.direction, m.folder
  from public.mail_messages m
  join public.mail_threads t on t.id = m.thread_id
  where m.thread_id = p_thread
  order by m.sent_at desc, m.id;
$$;

comment on function public.mail_thread_placement(uuid) is
  'Where each message of a conversation currently is, and under which Graph '
  'id — the four columns _shared/mail-move.ts needs to work out what a move '
  'touches, without dragging every message body along with them. security '
  'invoker, so mail_messages'' own policy decides what comes back, the same '
  'choice mail_unread_counts() made (0062, 0069).';

revoke all on function public.mail_thread_placement(uuid) from public, anon;
grant execute on function public.mail_thread_placement(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it took.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'mail_moved') then
    raise exception '0069: mail_moved() is missing';
  end if;
  v_def := pg_get_functiondef('public.mail_moved(uuid, text, jsonb)'::regprocedure);
  -- The whole point of this migration is that it reuses 0045 rather than
  -- copying it: a future edit that quietly inlines its own version of the
  -- rule fails here rather than drifting away from the sync in silence.
  if v_def not like '%file_threads_out_of_inbox%' then
    raise exception '0069: mail_moved() no longer reuses 0045''s file_threads_out_of_inbox()';
  end if;
  if v_def ~* 'delete\s+from\s+public\.mail_' then
    raise exception '0069: mail_moved() deletes mail, which nothing in this workspace may do';
  end if;
  if has_function_privilege('anon', 'public.mail_moved(uuid, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.mail_moved(uuid, text, jsonb)', 'execute') then
    raise exception '0069: a browser could file mail directly, without Outlook having taken the move';
  end if;
  if not has_function_privilege('service_role', 'public.mail_moved(uuid, text, jsonb)', 'execute') then
    raise exception '0069: move-mail-thread cannot run mail_moved()';
  end if;
  -- mail_moved() calls file_threads_out_of_inbox(), which 0045 revoked from
  -- every role including service_role: it runs only as its owner. So the two
  -- must share one, or a move would raise the moment it tried.
  if (select p.proowner from pg_proc p where p.oid = 'public.mail_moved(uuid, text, jsonb)'::regprocedure)
     is distinct from
     (select p.proowner from pg_proc p where p.oid = 'public.file_threads_out_of_inbox(uuid[], text)'::regprocedure) then
    raise exception '0069: mail_moved() could not file a conversation: it does not own file_threads_out_of_inbox()';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'mail_thread_placement') then
    raise exception '0069: mail_thread_placement() is missing';
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = 'public.mail_thread_placement(uuid)'::regprocedure) then
    raise exception '0069: mail_thread_placement() must stay security invoker, so mail_messages'' own policy decides';
  end if;
  if has_function_privilege('anon', 'public.mail_thread_placement(uuid)', 'execute') then
    raise exception '0069: anon can read where a conversation''s messages are';
  end if;
end
$$;
