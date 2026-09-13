-- =============================================================================
-- 0038 — Sending mail from the workspace, and a mailbox that syncs itself.
--
-- Until now the only mail that left the workspace was a ticket reply; compose
-- saved nothing, and a mailbox synced only when a manager ran a curl. This
-- adds what sending needs, and what the sync has been missing:
--
--   1. mail_messages learns priority, attachments, Bcc, the RFC 2822
--      Message-ID, where each copy was found, and its own read and flagged
--      state. A thread's read/starred is derived from those (§6), so it
--      cannot drift from what its messages say.
--   2. A thread's person-editable columns are read and starred, and nothing
--      else. The 0025 policy allowed every column, so anyone who could read a
--      studio thread could move it into their own personal mailbox.
--   3. A connection's identity stays what was consented to: from the browser
--      it can only be disconnected, and a manager deletes only the studio's
--      connections or their own.
--   4. mail_signatures: one per person per mailbox, private to its owner.
--   5. mail-attachments: a private bucket, one folder per auth id.
--   6. store_mail_batch(): the one way the sync and send-mail store mail —
--      one call per batch, the thread's state derived atomically.
--   7. A per-mailbox sync lock, so runs cannot overlap.
--   8. email_log accepts 'workspace_mail'.
--   9. A schedule: one sync request per connected mailbox, every five minutes.
--
-- §9 reads two Vault secrets this file cannot contain — see its header.
--
-- Idempotent. Adds only.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. What a message carries.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.mail_messages
  add column if not exists internet_message_id text,
  add column if not exists bcc_emails          text[] not null default '{}',
  add column if not exists importance          text not null default 'normal',
  add column if not exists has_attachments     boolean not null default false,
  add column if not exists preview             text,
  add column if not exists folder              text;

do $$
begin
  alter table public.mail_messages
    add constraint mail_messages_importance_check
    check (importance in ('low', 'normal', 'high'));
exception when duplicate_object then null;
end $$;

-- Read and flagged lived only on the thread. They move down to the message —
-- once, carrying the state people could see, so the first derived state
-- matches it: an unread thread keeps its messages from outside unread, and a
-- starred thread's newest message from outside holds the flag.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_messages' and column_name = 'is_read'
  ) then
    alter table public.mail_messages
      add column is_read    boolean not null default true,
      add column is_flagged boolean not null default false;

    update public.mail_messages m
    set is_read = t.is_read
    from public.mail_threads t
    where t.id = m.thread_id and m.direction = 'inbound';

    update public.mail_messages m
    set is_flagged = true
    from public.mail_threads t
    where t.id = m.thread_id
      and t.is_starred
      and m.id = (
        select x.id from public.mail_messages x
        where x.thread_id = t.id
        order by (x.direction = 'inbound') desc, x.sent_at desc
        limit 1
      );
  end if;
end $$;

-- A lookup, not a conflict target: the same Message-ID legitimately appears
-- twice when the studio writes to one of its own mailboxes.
create index if not exists mail_messages_internet_message_idx
  on public.mail_messages (thread_id, internet_message_id)
  where internet_message_id is not null;

comment on column public.mail_messages.internet_message_id is
  'RFC 2822 Message-ID. Survives a move between folders and a draft being '
  'sent, which the Graph id does not; send-mail finds its sent copy by it.';
comment on column public.mail_messages.bcc_emails is
  'Only ever filled on our own sent copies: a recipient cannot see Bcc.';
comment on column public.mail_messages.folder is
  'Where this copy was found (inbox, sent, archive, spam, trash). A message '
  'we send to our own mailbox has two copies with one Message-ID.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. What a person may change on a thread.
--
--    RLS decides WHICH threads; the column grant decides WHICH COLUMNS.
--    Everything else is written by the sync and by security-definer functions
--    (store_mail_batch, create_ticket_from_thread, route_mail_to_ticket).
-- ─────────────────────────────────────────────────────────────────────────────
revoke update on public.mail_threads from anon, authenticated;
grant update (is_read, is_starred) on public.mail_threads to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A connection's identity stays what was consented to.
--
--    Managers may write integration_connections (0024). Three columns decide
--    whose mail a connection reads and sends as: employee_id (who may use it),
--    account_label (which mailbox), external_id (who consented — clear it on
--    the shared mailbox and the sync reads the consenting person's own mail
--    into it, for all staff to see). From the browser, the one change left is
--    disconnecting. Everything else is the service role's: microsoft-connect,
--    the callback, and the sync.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.integration_connections_browser_can_only_disconnect()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       (to_jsonb(new) - 'status' - 'last_error' - 'updated_at')
         is distinct from (to_jsonb(old) - 'status' - 'last_error' - 'updated_at')
    or (new.status is distinct from old.status and new.status <> 'disconnected')
  ) then
    raise exception 'From the workspace a connection can only be disconnected. Connect it again to change it.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists integration_connections_browser_can_only_disconnect on public.integration_connections;
create trigger integration_connections_browser_can_only_disconnect
  before update on public.integration_connections
  for each row execute function public.integration_connections_browser_can_only_disconnect();

-- A personal connection's row takes its grant and every stored message with
-- it. A manager removes the studio's connections, or their own — not a
-- colleague's. (0024's single "for all" policy is split to say so.)
drop policy if exists "manager writes integration_connections" on public.integration_connections;

drop policy if exists "manager inserts integration_connections" on public.integration_connections;
create policy "manager inserts integration_connections"
  on public.integration_connections for insert
  with check (public.is_manager());

drop policy if exists "manager updates integration_connections" on public.integration_connections;
create policy "manager updates integration_connections"
  on public.integration_connections for update
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager deletes studio or own integration_connections" on public.integration_connections;
create policy "manager deletes studio or own integration_connections"
  on public.integration_connections for delete
  using (public.is_manager() and (employee_id is null or employee_id = public.active_employee_id()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Signatures.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.mail_signatures (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  -- null: the signature for every mailbox that has none of its own
  connection_id  uuid references public.integration_connections(id) on delete cascade,
  html           text not null default '' check (octet_length(html) <= 100000),
  use_on_new     boolean not null default true,
  use_on_replies boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- A plain column constraint, so it can be an ON CONFLICT target — an
  -- expression index over coalesce(connection_id, …) could not (see 0028).
  -- NULLS NOT DISTINCT needs Postgres 15.
  constraint mail_signatures_one_per_mailbox
    unique nulls not distinct (employee_id, connection_id)
);

drop trigger if exists mail_signatures_touch_updated_at on public.mail_signatures;
create trigger mail_signatures_touch_updated_at
  before update on public.mail_signatures
  for each row execute function public.touch_updated_at();

alter table public.mail_signatures enable row level security;

-- Your own, for a mailbox you can read. Managers get no override: a
-- signature is as personal as the mailbox it signs for.
drop policy if exists "own mail signatures" on public.mail_signatures;
create policy "own mail signatures"
  on public.mail_signatures for all
  using (employee_id = public.active_employee_id())
  with check (
    employee_id = public.active_employee_id()
    and (connection_id is null or public.can_read_connection(connection_id))
  );

comment on table public.mail_signatures is
  'A person''s signature, per mailbox (connection_id) or for all of them (null). '
  'Inserted by compose into the editor, where it can still be changed; the '
  'server never appends one.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Attachments on their way out.
--
--    Files go to Storage first and send-mail reads them from there, as the
--    caller: an Edge Function has two seconds of CPU per request, not enough to
--    parse 25 MB of base64 out of a JSON body. Paths are
--    <auth id>/<upload id>/<plain name>; send-mail checks the shape and the
--    owner, and the select policy below says the same thing again.
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('mail-attachments', 'mail-attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "staff upload own mail attachments" on storage.objects;
create policy "staff upload own mail attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'mail-attachments'
    and public.is_staff()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "staff read own mail attachments" on storage.objects;
create policy "staff read own mail attachments"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'mail-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "staff remove own mail attachments" on storage.objects;
create policy "staff remove own mail attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'mail-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. store_mail_batch — the one way mail is stored.
--
--    p_rows is what _shared/graph-message.ts toMailRow() produces. Messages
--    upsert on (thread_id, external_id). Then each thread touched is brought
--    in line with EVERY message it holds, not with the batch:
--      folder     the inbox wins; a copy found in Sent never moves a thread,
--                 and a thread with mail in the inbox stays there
--      read       unless a message from outside is unread
--      starred    while any message is flagged
--      subject,   from the newest message
--      snippet
--    In one statement per thread, so two overlapping runs cannot write each
--    other's stale state back.
--
--    A message that comes back under a new Graph id — moved within a folder,
--    or out of the inbox into archive, spam or trash — is re-pointed by its
--    Message-ID rather than stored twice. Only a copy going the same way: a
--    message we send to our own mailbox has an inbound and an outbound copy
--    under one Message-ID, and those stay two. New mail from outside is routed
--    to its ticket (0035) — once: not again for a copy of a message already
--    routed.
-- ─────────────────────────────────────────────────────────────────────────────
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
        when excluded.folder = 'inbox' or mail_threads.folder = 'inbox' then 'inbox'
        when excluded.folder = 'sent' then mail_threads.folder
        else excluded.folder
      end
    returning id into v_thread;

    if v_mid is not null then
      update public.mail_messages m
      set external_id = v_row->>'external_id'
      where m.thread_id = v_thread
        and m.internet_message_id = v_mid
        and m.direction = v_dir
        and (m.folder = p_folder or (m.folder = 'inbox' and p_folder in ('archive', 'spam', 'trash')))
        and m.external_id <> v_row->>'external_id'
        and not exists (
          select 1 from public.mail_messages x
          where x.thread_id = v_thread and x.external_id = v_row->>'external_id')
        and (select count(*) from public.mail_messages y
             where y.thread_id = v_thread and y.internet_message_id = v_mid and y.direction = v_dir) = 1;
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

    -- A routing failure must not lose the batch: the mail is stored, and the
    -- worst case is one reply someone files by hand.
    if v_inserted and v_dir = 'inbound'
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
      where m.thread_id = t.id order by m.sent_at desc limit 1), t.snippet)
  where t.id = any(v_ids);

  return jsonb_build_object('threads', v_threads, 'messages', v_messages, 'routed', v_routed);
end;
$$;

comment on function public.store_mail_batch(uuid, text, jsonb) is
  'The one way the sync and send-mail store mail. Service role only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. One sync of a mailbox at a time.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.integration_connections
  add column if not exists sync_started_at timestamptz;

create or replace function public.claim_mail_sync(p_connection uuid, p_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.integration_connections
  set sync_started_at = now()
  where id = p_connection
    and (sync_started_at is null or sync_started_at < now() - make_interval(secs => p_seconds));
  return found;
end;
$$;

create or replace function public.release_mail_sync(p_connection uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.integration_connections set sync_started_at = null where id = p_connection;
$$;

-- The sync's own functions are the service role's alone. Functions are
-- executable by PUBLIC by default, and Supabase grants anon and authenticated
-- on top; all three are taken back.
revoke all on function public.store_mail_batch(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_mail_sync(uuid, int) from public, anon, authenticated;
revoke all on function public.release_mail_sync(uuid) from public, anon, authenticated;
grant execute on function public.store_mail_batch(uuid, text, jsonb) to service_role;
grant execute on function public.claim_mail_sync(uuid, int) to service_role;
grant execute on function public.release_mail_sync(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The log accepts what send-mail writes.
--
--    email_log.kind is a CHECK (0010, redefined since). The full list is
--    restated — dropping the constraint and adding back only the new kind
--    would refuse every other email the studio sends.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_log'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%workspace_mail%'
  ) then
    alter table public.email_log drop constraint if exists email_log_kind_check;
    alter table public.email_log add constraint email_log_kind_check
      check (kind = any (array[
        'invite','password_reset','task_assigned','task_done','task_blocked',
        'task_updated','task_comment','digest','publish_requested','invoice',
        'enquiry_notify','enquiry_ack','ticket_reply','workspace_mail'
      ]));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Mail arrives by itself.
--
--    Every five minutes pg_cron sends one request per connected mailbox to
--    sync-mail-scheduled — one each, so a slow mailbox cannot use up the time
--    of the others. The function is deployed --no-verify-jwt and checks an
--    x-sync-secret header instead: a cron job has no user to sign in as, and
--    handing it the service-role key would give a schedule the keys to
--    everything. Two Vault secrets, created once by hand, never committed:
--
--      select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--      select vault.create_secret('<same value as MAIL_SYNC_SECRET>', 'mail_sync_secret');
--
--    Until they exist the job runs and its requests fail harmlessly;
--    cron.job_run_details and net._http_response say why.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sync-workspace-mail';
  perform cron.schedule(
    'sync-workspace-mail',
    '*/5 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/sync-mail-scheduled',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_secret')
        ),
        body := jsonb_build_object('connectionId', c.id),
        timeout_milliseconds := 120000
      )
      from public.integration_connections c
      where c.provider = 'microsoft_mail'
        and c.status in ('connected', 'error');
    $job$
  );
end $$;
