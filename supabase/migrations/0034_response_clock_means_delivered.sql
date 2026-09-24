-- =============================================================================
-- 0034 — first_response_at should mean the customer heard back.
--
-- 0023 stamped it when an outbound message was INSERTED. That was right when
-- inserting a message was the only thing a reply could be. Now that 0033 sends
-- them, the two have come apart: a reply to a ticket with no contact email, or
-- one Resend refused, still started the clock. The ticket then reads as
-- answered when nobody outside the studio has heard anything — which is the
-- one direction a support metric must never be wrong in.
--
-- New definition: the clock starts when an outbound message is DELIVERED.
--
-- The cost is that a reply given by phone or in person never sets it. That is
-- the honest answer — the database has no evidence of it — and the ticket's
-- own status is where that gets recorded.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Inserting a message still bumps the ticket. It no longer claims a
--    response was made.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ticket_messages_touch_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_tickets
  set updated_at = now()
  where id = new.ticket_id;
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Delivery is what starts the clock — and only the first one.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ticket_messages_stamp_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'outbound'
     and new.delivered_at is not null
     and old.delivered_at is null then
    update public.support_tickets
    set first_response_at = coalesce(first_response_at, new.delivered_at),
        updated_at = now()
    where id = new.ticket_id;
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_messages_stamp_response on public.ticket_messages;
create trigger ticket_messages_stamp_response
  after update of delivered_at on public.ticket_messages
  for each row execute function public.ticket_messages_stamp_response();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Repair the rows the old rule already stamped.
--    A ticket keeps its clock only if one of its outbound messages actually
--    went out; otherwise it goes back to null, because it was never true.
-- ─────────────────────────────────────────────────────────────────────────────
update public.support_tickets t
set first_response_at = (
      select min(m.delivered_at) from public.ticket_messages m
      where m.ticket_id = t.id and m.direction = 'outbound' and m.delivered_at is not null
    )
where t.first_response_at is not null;

comment on column public.support_tickets.first_response_at is
  'When the first outbound reply was DELIVERED — not when it was written. A '
  'reply that could not be sent does not start the clock (0034).';
