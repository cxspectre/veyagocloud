-- =============================================================================
-- 0063 — Attachment content: mail and tickets share the same backend gap.
--
-- FOUND: mail_attachments (0055) and ticket_attachments (0056) both only ever
-- stored metadata — name, kind, size. Neither table's own comment hid this:
-- 0055's said "there is nowhere to fetch the bytes from yet"; 0056's schema
-- already had message_id (a ticket_attachments row can point at the
-- ticket_messages row a customer's email became) and uploaded_by nullable
-- "for exactly this case" — ready for a mail attachment to land there, with
-- nothing that ever put one. A customer emailing in a screenshot or a signed
-- PDF had it vanish: never shown in Mail, never carried onto the ticket their
-- email opened.
--
-- WHAT CHANGES:
--   1. ticket_attachments gains mail_attachment_id, so a row this migration's
--      own carry-over creates can be told apart from one staff uploaded by
--      hand, and so running the carry-over twice for the same mail attachment
--      cannot double it (unique partial index).
--   2. A trigger on ticket_messages: the moment route_mail_to_ticket() (0056)
--      files an INBOUND row with a mail_message_id — from the regular sync or
--      from "Create ticket" on an existing conversation, both call it the
--      same way — it asks a new Edge Function, carry-ticket-attachments, to
--      fetch that email's attachments from Graph and store them on the
--      ticket. A trigger cannot reach Graph itself; net.http_post (already
--      used by 0038's cron job) hands off the actual work and does not wait
--      for it, the same reasoning 0038 used for the schedule.
--   3. mail-attachment-content, a second new Edge Function, is what a person
--      opening a received email calls on demand — this migration does not
--      touch it directly, since it only reads what already exists
--      (mail_attachments, mail_messages, mail_threads), but it is why
--      mail_attachments.external_id — stored since 0055, never read by the
--      workspace before now — starts mattering: it is the Graph attachment id
--      both new functions fetch by.
--
-- Both functions reuse _shared/graph-attachment.ts's fetchAttachmentContent()
-- for the actual Graph call, so "how an attachment's bytes are fetched" has
-- exactly one answer in the codebase, not two that could drift apart.
--
-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace (0045's own
-- reasoning; this file touches ticket_messages, which a busy support queue
-- writes to constantly).
-- =============================================================================
set lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Telling a carried-over attachment apart from one staff uploaded, and
--    keeping the carry-over from ever doubling one.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ticket_attachments
  add column if not exists mail_attachment_id uuid references public.mail_attachments(id) on delete set null;

comment on column public.ticket_attachments.mail_attachment_id is
  'Which mail_attachments row this file came from, when carry-ticket-attachments '
  'put it here — null for one uploaded by hand. Set only by that function''s own '
  'service-role insert; a value set any other way is inert, since nothing else '
  'reads this column — it is never shown, only checked before carrying an '
  'attachment over a second time (0063).';

-- One ticket_attachments row per mail attachment, however many times the
-- carry-over runs for it (a retry after a partial failure, or the trigger
-- firing more than once for the same insert, which pg_net does not itself
-- guard against).
create unique index if not exists ticket_attachments_mail_attachment_idx
  on public.ticket_attachments (mail_attachment_id)
  where mail_attachment_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The hand-off: an inbound ticket_messages row with mail behind it asks
--    carry-ticket-attachments to fetch what came with that email.
--
--    Fails open, on purpose, at two levels:
--      - the trigger itself never raises (a missing extension, an unset vault
--        secret, net.http_post refusing a null url) — an email becoming a
--        ticket must not fail, or be delayed, over attachments failing to
--        carry over;
--      - the vault secrets it needs are read defensively, exactly as 0038's
--        own cron job already treats them: until project_url and
--        mail_sync_secret exist, this queues a request that goes nowhere and
--        says so in net._http_response, the same "fails harmlessly" 0038
--        already accepts for its own schedule.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_ticket_attachment_carry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Only ever reads NEW itself, so nothing here can raise: cheap enough to
  -- keep outside the guarded block below without weakening it.
  if new.direction is distinct from 'inbound' or new.mail_message_id is null then
    return new;
  end if;

  -- Everything past here touches the database, vault or the network — all of
  -- it guarded together, so a failure anywhere in it (an absent table, a
  -- missing secret, net.http_post itself refusing) still returns new rather
  -- than raising out of a trigger a mail sync's own INSERT depends on.
  begin
    if not exists (select 1 from public.mail_attachments where message_id = new.mail_message_id) then
      return new;                        -- nothing to carry: the common case, and the cheap check
    end if;

    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'mail_sync_secret';
    if v_url is null or v_secret is null then
      return new;                      -- not configured yet (0038's own README covers doing so)
    end if;

    perform net.http_post(
      url := v_url || '/functions/v1/carry-ticket-attachments',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-secret', v_secret),
      body := jsonb_build_object('ticketMessageId', new.id),
      timeout_milliseconds := 60000
    );
  exception when others then
    raise warning 'notify_ticket_attachment_carry: could not queue the carry-over for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

comment on function public.notify_ticket_attachment_carry() is
  'Fires carry-ticket-attachments (over pg_net, fire-and-forget) the moment an '
  'inbound customer email is filed on a ticket with attachments waiting in '
  'mail_attachments. Never raises: a missing extension, an unset vault secret, '
  'or the HTTP call itself failing must not lose the ticket_messages row it '
  'answers to, or delay the reply reaching the queue (0063).';

drop trigger if exists ticket_messages_carry_attachments on public.ticket_messages;
create trigger ticket_messages_carry_attachments
  after insert on public.ticket_messages
  for each row execute function public.notify_ticket_attachment_carry();

comment on trigger ticket_messages_carry_attachments on public.ticket_messages is
  'Asks carry-ticket-attachments to fetch a customer email''s attachments the '
  'moment route_mail_to_ticket() (0056) files it — from the regular sync or '
  '"Create ticket" alike, since both call that same function (0063).';

-- ─────────────────────────────────────────────────────────────────────────────
-- Self-check: the shape this migration promises is actually there. Mirrors
-- 0055's own closing block.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ticket_attachments' and column_name = 'mail_attachment_id'
  ) then
    raise exception '0063: ticket_attachments.mail_attachment_id is missing';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'ticket_attachments' and indexname = 'ticket_attachments_mail_attachment_idx'
  ) then
    raise exception '0063: the unique index on mail_attachment_id is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'ticket_messages_carry_attachments'
      and tgrelid = 'public.ticket_messages'::regclass and not tgisinternal
  ) then
    raise exception '0063: the ticket_messages carry-over trigger is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'notify_ticket_attachment_carry' and pronamespace = 'public'::regnamespace) then
    raise exception '0063: notify_ticket_attachment_carry() is missing';
  end if;
end $$;
