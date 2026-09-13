-- =============================================================================
-- 0037 — A mail list should show who wrote, not what about.
--
-- mail_threads carried subject and snippet but no sender, because the sender
-- lives on mail_messages. The thread list therefore fell back to the subject
-- where a name belongs, and with an empty CRM that is every row: a list of
-- subjects under a column headed by a person's initials.
--
-- Storing it on the thread rather than joining to "the newest message" keeps
-- the list query a single table read — the join is a correlated subquery per
-- row, which is exactly the shape that is fine at three threads and miserable
-- at three thousand.
-- =============================================================================

alter table public.mail_threads
  add column if not exists last_from_name  text,
  add column if not exists last_from_email text;

comment on column public.mail_threads.last_from_email is
  'Who sent the most recent message in this thread. Denormalised from '
  'mail_messages so the list is one table read; maintained by the trigger below.';

-- ---------------------------------------------------------------------------
-- The trigger already maintained message_count, last_message_at and the CRM
-- match. It gains the sender — and only when the new message is genuinely the
-- latest, so re-syncing an older message cannot rewrite the list with a stale
-- name.
-- ---------------------------------------------------------------------------
create or replace function public.mail_messages_maintain_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact uuid;
  v_company uuid;
begin
  if new.direction = 'inbound' and new.from_email is not null then
    select id, company_id into v_contact, v_company
    from public.crm_contacts
    where lower(email) = lower(new.from_email) and deleted_at is null
    limit 1;
  end if;

  update public.mail_threads t
  set message_count   = (select count(*) from public.mail_messages m where m.thread_id = new.thread_id),
      last_message_at = greatest(coalesce(t.last_message_at, new.sent_at), new.sent_at),
      contact_id      = coalesce(t.contact_id, v_contact),
      company_id      = coalesce(t.company_id, v_company),
      /* Only if this really is the newest. A backfill that walks old messages
         would otherwise leave the list showing whoever wrote first. */
      last_from_name  = case when t.last_message_at is null or new.sent_at >= t.last_message_at
                             then new.from_name else t.last_from_name end,
      last_from_email = case when t.last_message_at is null or new.sent_at >= t.last_message_at
                             then new.from_email else t.last_from_email end,
      updated_at      = now()
  where t.id = new.thread_id;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill the threads already synced, from their newest message.
-- ---------------------------------------------------------------------------
update public.mail_threads t
set last_from_name  = m.from_name,
    last_from_email = m.from_email
from (
  select distinct on (thread_id) thread_id, from_name, from_email
  from public.mail_messages
  order by thread_id, sent_at desc
) m
where m.thread_id = t.id
  and (t.last_from_email is distinct from m.from_email
    or t.last_from_name  is distinct from m.from_name);
