-- =============================================================================
-- 0025 — Mail: threads and messages, synced from a connected mailbox.
--
-- Storage only. The sync itself is an Edge Function (not in this migration)
-- that reads its grant from integration_secrets (0024) and upserts here on
-- (connection_id, external_id), the same never-duplicate shape sync-mercury
-- already uses for transactions.
--
-- WHO CAN READ WHAT. A studio mailbox (integration_connections.employee_id is
-- null — hello@veyago.cloud) is readable by every staff member. A personal
-- mailbox is readable by the person whose it is, AND BY NOBODY ELSE, managers
-- included. That is deliberate: "owner" is a permission to run the company,
-- not to read a colleague's mail, and a studio that sells privacy-first
-- software should not build the other thing into its own tools. Shared
-- correspondence belongs in a shared mailbox.
--
-- body_html is stored as received. IT IS UNTRUSTED INPUT — anything rendering
-- it must sanitise first (the repo already carries DOMPurify for exactly this,
-- see admin/js). Prefer body_text wherever it will do.
--
-- Idempotent. Adds only.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Who may see a given mailbox.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.can_read_connection(p_connection uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.integration_connections c
    where c.id = p_connection
      and public.is_staff()
      and (c.employee_id is null                       -- studio-wide mailbox
        or c.employee_id = public.active_employee_id())-- or your own
  );
$$;

comment on function public.can_read_connection(uuid) is
  'True for a studio-wide connection (employee_id null) seen by any staff, or a '
  'personal one seen by its owner. Managers get no override — see 0025 header.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Threads.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.mail_threads (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.integration_connections(id) on delete cascade,
  external_id     text not null,                    -- provider thread id
  subject         text,
  snippet         text,                             -- preview line for the list
  contact_id      uuid references public.crm_contacts(id) on delete set null,
  company_id      uuid references public.crm_companies(id) on delete set null,
  ticket_id       uuid references public.support_tickets(id) on delete set null,
  folder          text not null default 'inbox'
                    check (folder in ('inbox','sent','archive','spam','trash')),
  is_read         boolean not null default false,
  is_starred      boolean not null default false,
  message_count   int not null default 0,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists mail_threads_external_idx
  on public.mail_threads (connection_id, external_id);
create index if not exists mail_threads_folder_idx
  on public.mail_threads (connection_id, folder, last_message_at desc);
create index if not exists mail_threads_contact_idx on public.mail_threads (contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Messages.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.mail_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.mail_threads(id) on delete cascade,
  external_id text not null,                        -- provider message id
  direction   text not null default 'inbound' check (direction in ('inbound','outbound')),
  from_name   text,
  from_email  text,
  to_emails   text[] not null default '{}',
  cc_emails   text[] not null default '{}',
  subject     text,
  body_text   text,
  body_html   text,                                 -- UNTRUSTED: sanitise on render
  sent_at     timestamptz not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists mail_messages_external_idx
  on public.mail_messages (thread_id, external_id);
create index if not exists mail_messages_thread_idx
  on public.mail_messages (thread_id, sent_at);

drop trigger if exists mail_threads_touch_updated_at on public.mail_threads;
create trigger mail_threads_touch_updated_at
  before update on public.mail_threads
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A message maintains its thread, and introduces itself to the CRM.
--
--    Counting in a trigger keeps message_count honest no matter which sync
--    wrote the row. The contact match is best-effort and one-way: it fills a
--    blank, never overwrites a link a human made.
-- ─────────────────────────────────────────────────────────────────────────────
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
      updated_at      = now()
  where t.id = new.thread_id;

  return new;
end;
$$;

drop trigger if exists mail_messages_maintain_thread on public.mail_messages;
create trigger mail_messages_maintain_thread
  after insert on public.mail_messages
  for each row execute function public.mail_messages_maintain_thread();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS. Both tables key off can_read_connection().
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.mail_threads  enable row level security;
alter table public.mail_messages enable row level security;

drop policy if exists "read own mailbox threads" on public.mail_threads;
create policy "read own mailbox threads"
  on public.mail_threads for select
  using (public.can_read_connection(connection_id));

-- Reading, starring and filing are the only edits a person makes by hand; the
-- sync writes everything else with the service role.
drop policy if exists "update own mailbox threads" on public.mail_threads;
create policy "update own mailbox threads"
  on public.mail_threads for update
  using (public.can_read_connection(connection_id))
  with check (public.can_read_connection(connection_id));

drop policy if exists "read own mailbox messages" on public.mail_messages;
create policy "read own mailbox messages"
  on public.mail_messages for select
  using (exists (
    select 1 from public.mail_threads t
    where t.id = thread_id and public.can_read_connection(t.connection_id)
  ));

-- No INSERT/UPDATE/DELETE policies on mail_messages: a mailbox is a record of
-- what was actually sent and received. The sync owns it, through the service
-- role. Sending mail is an Edge Function's job, not a table write.

comment on table public.mail_threads is
  'Synced mail threads. Visibility follows can_read_connection(): studio '
  'mailboxes are shared, personal ones are not.';
comment on table public.mail_messages is
  'Synced messages. Append-only from the service role; body_html is untrusted '
  'and must be sanitised on render.';
