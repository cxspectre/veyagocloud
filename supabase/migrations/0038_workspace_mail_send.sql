-- =============================================================================
-- 0038 — Sending mail from the workspace.
--
-- Until now the only mail that left the workspace was a ticket reply; compose
-- saved nothing, and a mailbox synced only when a manager ran a curl. This
-- adds what sending needs, and what the sync has been missing:
--
--   1. mail_messages learns priority, attachments, Bcc and the RFC 2822
--      Message-ID. The Message-ID is how a sent copy is recognised as the
--      message just sent: a draft's Graph id changes when it is sent, the
--      Message-ID does not.
--   2. A thread's person-editable columns are read and starred, and nothing
--      else. The 0025 policy allowed every column, so anyone who could read a
--      studio thread could move it into their own personal mailbox — out of
--      everyone else's sight — or re-point its ticket.
--   3. mail_signatures: one per person per mailbox, private to its owner.
--   4. mail-attachments: a private bucket. The browser uploads into its own
--      folder, send-mail attaches the file and removes it.
--   5. email_log accepts 'workspace_mail', the kind send-mail logs.
--   6. A schedule: every connected mailbox syncs every five minutes.
--
-- Section 6 reads two Vault secrets this file cannot contain — see its header.
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
  add column if not exists has_attachments     boolean not null default false;

do $$
begin
  alter table public.mail_messages
    add constraint mail_messages_importance_check
    check (importance in ('low', 'normal', 'high'));
exception when duplicate_object then null;
end $$;

-- A lookup, not a conflict target: the same Message-ID legitimately appears
-- in two mailboxes when the studio writes to one of its own.
create index if not exists mail_messages_internet_message_idx
  on public.mail_messages (internet_message_id)
  where internet_message_id is not null;

comment on column public.mail_messages.internet_message_id is
  'RFC 2822 Message-ID. Survives a draft being sent and a move between folders, '
  'which the Graph id does not; send-mail finds its sent copy by it.';
comment on column public.mail_messages.bcc_emails is
  'Only ever filled on our own sent copies: a recipient cannot see Bcc.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. What a person may change on a thread.
--
--    RLS decides WHICH threads; the column grant decides WHICH COLUMNS.
--    Everything else on a thread is written by the sync with the service role
--    and by security-definer functions (create_ticket_from_thread,
--    route_mail_to_ticket), neither of which this touches.
-- ─────────────────────────────────────────────────────────────────────────────
revoke update on public.mail_threads from anon, authenticated;
grant update (is_read, is_starred) on public.mail_threads to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Signatures.
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
-- 4. Attachments on their way out.
--
--    Files go to Storage first and send-mail reads them from there: an Edge
--    Function has two seconds of CPU per request, which is not enough to parse
--    25 MB of base64 out of a JSON body. The first folder of every path is the
--    uploader's auth id, and send-mail checks it against the caller.
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
-- 5. The log accepts what send-mail writes.
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
-- 6. Mail arrives by itself.
--
--    Every five minutes pg_cron asks sync-mail-scheduled to sync every
--    connected mailbox. The function is deployed --no-verify-jwt and checks
--    an x-sync-secret header instead: a cron job has no user to sign in as,
--    and handing it the service-role key would give a schedule the keys to
--    everything. Two Vault secrets, created once by hand, never committed:
--
--      select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--      select vault.create_secret('<same value as MAIL_SYNC_SECRET>', 'mail_sync_secret');
--
--    Until they exist the job runs and fails harmlessly; cron.job_run_details
--    says why.
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
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );
end $$;
