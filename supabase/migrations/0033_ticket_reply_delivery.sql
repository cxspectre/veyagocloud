-- =============================================================================
-- 0033 — Ticket replies that actually reach the customer.
--
-- ticket_messages recorded what we said; nothing sent it. A support desk whose
-- replies never leave the building is a notepad with extra steps, and worse
-- than a notepad — it looks like the customer was answered.
--
-- Sending goes through Resend, the same path invites, invoices and enquiry
-- acknowledgements already use (supabase/functions/_shared/email.ts). No new
-- provider, no new secret.
--
-- WHAT THIS MIGRATION ADDS is only the record of what happened:
--   delivered_at    when Resend accepted it
--   delivery_error  why it did not go, kept next to the message rather than
--                   only in a log, so the thread itself shows a failed send
--   'ticket_reply'  as an email_log kind
--
-- INTERNAL NOTES ARE NEVER SENT. The send path refuses direction='internal',
-- and this migration adds a CHECK so the database refuses it too: a note to
-- each other that reaches the customer is the single worst bug this feature
-- could have, and one guard in one Edge Function is not enough of a barrier.
-- =============================================================================

alter table public.ticket_messages
  add column if not exists delivered_at   timestamptz,
  add column if not exists delivery_error text;

-- An internal note can never carry a delivery stamp. Belt and braces with the
-- check in the send function: this one cannot be bypassed by a future caller.
alter table public.ticket_messages
  drop constraint if exists ticket_messages_internal_never_sent;
alter table public.ticket_messages
  add constraint ticket_messages_internal_never_sent
  check (direction <> 'internal' or (delivered_at is null and delivery_error is null));

create index if not exists ticket_messages_undelivered_idx
  on public.ticket_messages (ticket_id)
  where direction = 'outbound' and delivered_at is null;

-- The delivery stamp is written by the service role from the send function.
-- No policy change is needed: there is still no UPDATE policy on this table,
-- so nothing in the browser can mark its own message as delivered.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_log'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%ticket_reply%'
  ) then
    alter table public.email_log drop constraint if exists email_log_kind_check;
    alter table public.email_log add constraint email_log_kind_check
      check (kind = any (array[
        'invite','password_reset','task_assigned','task_done','task_blocked',
        'task_updated','task_comment','digest','publish_requested','invoice',
        'enquiry_notify','enquiry_ack','ticket_reply'
      ]));
  end if;
end $$;

comment on column public.ticket_messages.delivered_at is
  'When Resend accepted the reply. NULL on an inbound message, on an internal '
  'note, and on an outbound reply that has not been sent (no contact email).';
comment on column public.ticket_messages.delivery_error is
  'Why a send failed, kept beside the message so the thread shows it.';
