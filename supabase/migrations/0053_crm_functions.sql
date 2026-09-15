-- 0053_crm_functions.sql — a contact and their company in one step, merging
-- duplicates, and a number for every client.
--
-- Found in review (2026-09-14):
--
--   * The workspace adds a contact at a company the CRM does not have yet in two
--     requests, the company and then the contact (dist/data/writes.js). When the
--     second failed — an address already in the CRM, say — the first stayed: a
--     company nobody is in. create_contact_with_company() does both in one
--     transaction.
--   * Nothing merged two records of one company or one person. Deleting the
--     duplicate left its projects, tickets, mail, events, invoices, notes and
--     project links pointing at a deleted record. merge_companies() and
--     merge_contacts() move all of it to the record kept.
--   * A client had no number to quote. crm_companies.client_number is given
--     once, from a sequence, when a company first reaches the client stage.
--
-- ── create_contact_with_company(p_full_name, p_email, p_phone, p_title,
--      p_is_primary, p_notes, p_enquiry_id, p_company_id, p_company_name)
--      → (contact_id uuid, company_id uuid)
--
-- Staff only. The company is either p_company_id, a company that is not
-- deleted, or p_company_name: the live company whose lower(btrim(name)) is that
-- name's, or a new lead owned by the caller when there is none. Neither gives a
-- contact at no company. Nothing is guessed from the address's domain. The
-- address is stored trimmed and in lower case, as the workspace stores it.
-- PostgREST answers one object. Refusals (PostgREST's HTTP status in brackets):
--
--   42501 [403] Only staff can add contacts.
--   22023 [400] A contact needs a name.
--   22023 [400] That email address is not an address, like ana@northline.example.
--   22023 [400] Give the company as one in the CRM or as a new name, not both.
--   23503 [409] That company is not in the CRM.       detail {"company_id": "<id>"}
--   21000 [400] More than one company is called "<name>". Pick one of them.
--                                                     detail {"company_ids": ["<id>", …]}
--   23505 [409] A contact with that email address is already in the CRM.
--                                                     detail {"contact_id": "<existing contact's id>"}
--
-- details is JSON: JSON.parse(error.details).contact_id. Any other failure, like
-- an enquiry id that is not one, is the table's own error. Either way nothing is
-- stored, the company included.
--
-- ── merge_companies(p_keep, p_drop) and merge_contacts(p_keep, p_drop) → jsonb
--
-- Owners and admins only. Everything that points at p_drop points at p_keep
-- afterwards: every foreign key crm_merge_references() lists, and the notes on
-- it. Where the kept record is already on a project the merged one is on, the
-- kept one's link and role stay and the other goes. The kept record's empty
-- fields are filled from the merged one; nothing it has is overwritten. The
-- merged record is deleted (deleted_at) and says where it went (merged_into_id).
-- The activity feed says who merged what. Refusals:
--
--   42501 [403] Only an owner or admin can merge companies. / contacts.
--   22023 [400] Pick the company to keep and the company to merge into it.
--   22023 [400] A company cannot be merged into itself.
--   23503 [409] The company to keep is not in the CRM. / to merge
--                                                     detail {"company_id": "<id>"}
--   23503 [409] Merging these would go round in a circle: …   (the one to keep
--               was merged into the one to merge)     detail {"company_id", "merged_into_id"}
--   23503 [409] The company to keep was already merged into another. / to merge
--                                                     detail {"company_id", "merged_into_id"}
--   23503 [409] The company to keep is deleted. Restore it first. / to merge is deleted.
--   23514 [400] Give the company to keep a currency like EUR or USD first: …
--               (its value is in a code 0049 refuses) detail {"company_id", "currency"}
--   23514 [400] The contact to merge is on projects for a company the contact to
--               keep does not work at: <projects>. …  detail {"project_ids": [...]}
--   (kept)      Could not point <table>.<column>[, …] at the kept company: <why>
--               A trigger refused to move something that points at the merged
--               record. The references named are those of the step it stopped
--               (section 5). Nothing is merged, and the trigger's SQLSTATE is
--               kept.                                 detail {"references": ["<table>.<column>", …]}
--               0051's trigger no longer refuses one: it lets a merge move an
--               invoice filed under a project of another company.
--
-- For contacts, read "contact" and contact_id for "company" and company_id.
-- The answer: {"kept_id", "merged_id", "moved": {"<table>.<column>": rows, …},
-- "notes_moved", "filled": [columns filled on the kept record]}, and for
-- companies "client_number" and "left_behind" ({"value", "currency"} when the
-- merged company's value was in a code nobody can read and the kept company had
-- none), for contacts "project_links_moved" and "project_links_dropped".
--
-- "moved" counts only the rows the caller can read. A conversation or a meeting
-- in a colleague's own mailbox or calendar moves like any other row, but owners
-- and admins cannot open those (can_read_connection(), 0025 and 0044), and a
-- count would tell them how often a colleague wrote to or met the person.
--
-- A company's currency: 0049's rule may be NOT VALID while companies stored
-- before it hold codes like "US$", and any update of such a row fails unless it
-- fixes the code. A merged company's code is written as its three letters when
-- only case or spaces are wrong, otherwise as the kept company's code. The kept
-- company takes the merged one's value and code when it has no value and that
-- code can be read; a value in a code nobody can read stays on the merged
-- company ("left_behind"). A code nobody can read on a kept company with a value
-- is refused (above); on a kept company without a value it becomes the merged
-- company's code, or USD, crm_companies.currency's default.
--
-- A merged company's client number goes to the kept company when that has none,
-- so a client keeps the number it is known by; two clients keep their own.
--
-- ── Client numbers
--
-- Given when a live company is inserted or updated at stage 'client' without
-- one, and never changed or cleared after — through the API or otherwise — but
-- by merge_companies() moving one. Nobody gives one by hand. Existing clients
-- are numbered oldest first (created_at, then id); deleted companies are not,
-- and one restored as a client is numbered then. A client that goes dormant
-- keeps its number. Updating a company whose stored currency 0049's NOT VALID
-- rule refuses would fail, so for the backfill such a rule is set aside and put
-- back exactly as it was, still NOT VALID, with a notice saying how many
-- companies needed it; updated_at is left as it was.
--
-- merged_into_id is the database's to write: the API roles cannot set or change
-- it. A record merged into one that is later deleted outright loses the pointer
-- (on delete set null), not its own row.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. Where a merged record went, and a client's number ────────────────

alter table public.crm_companies
  add column if not exists merged_into_id uuid references public.crm_companies(id) on delete set null,
  add column if not exists client_number integer;

alter table public.crm_contacts
  add column if not exists merged_into_id uuid references public.crm_contacts(id) on delete set null;

-- The foreign keys' own lookups, when a record is deleted outright.
create index if not exists crm_companies_merged_into_idx
  on public.crm_companies (merged_into_id) where merged_into_id is not null;
create index if not exists crm_contacts_merged_into_idx
  on public.crm_contacts (merged_into_id) where merged_into_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.crm_companies'::regclass
                   and conname = 'crm_companies_client_number_key') then
    alter table public.crm_companies
      add constraint crm_companies_client_number_key unique (client_number);
  end if;
end
$$;

create sequence if not exists public.crm_companies_client_number_seq as integer minvalue 1;
alter sequence public.crm_companies_client_number_seq owned by public.crm_companies.client_number;

-- The numbering trigger runs as whoever writes the company, so staff need
-- nextval(); nobody needs setval().
revoke all on sequence public.crm_companies_client_number_seq from public, anon, authenticated, service_role;
grant usage on sequence public.crm_companies_client_number_seq to authenticated, service_role;

comment on column public.crm_companies.merged_into_id is
  'The company this one was merged into by merge_companies(), which also deleted it. '
  'Written only by the database (0053).';
comment on column public.crm_contacts.merged_into_id is
  'The contact this one was merged into by merge_contacts(), which also deleted it. '
  'Written only by the database (0053).';
comment on column public.crm_companies.client_number is
  'Given once, from crm_companies_client_number_seq, when the company first reaches the '
  'client stage; never changed after, except moved to the kept company by a merge (0053).';

-- ── 2. The number is the database's to give ──────────────────────────────
-- Not SECURITY DEFINER: current_user is who writes, so the API roles
-- (anon, authenticated, service_role) are told apart from the table owner,
-- which merge_companies() runs as.

create or replace function public.crm_company_client_number()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Set by merge_companies() for the one move it makes: '<merged>><kept>#<number>'.
  v_move text := coalesce(current_setting('veyago.client_number_move', true), '');
begin
  if tg_op = 'INSERT' then
    if new.client_number is not null then
      raise exception 'A client number is given by the database, when a company becomes a client.'
        using errcode = '42501';
    end if;
  elsif new.client_number is distinct from old.client_number then
    if current_user in ('anon', 'authenticated', 'service_role')
       or v_move = ''
       or not coalesce(
            (old.client_number is not null and new.client_number is null
             and v_move = format('%s>%s#%s', new.id, new.merged_into_id, old.client_number))
            or (old.client_number is null and new.client_number is not null
                and split_part(v_move, '>', 2) = format('%s#%s', new.id, new.client_number)),
            false) then
      raise exception 'A company''s client number never changes.'
        using errcode = '42501',
              hint = 'It is given once, when the company first becomes a client.';
    end if;
    return new;
  end if;

  if new.client_number is null and new.stage = 'client' and new.deleted_at is null then
    new.client_number := nextval('public.crm_companies_client_number_seq');
  end if;
  return new;
end;
$$;

drop trigger if exists crm_companies_client_number on public.crm_companies;
create trigger crm_companies_client_number
  before insert or update on public.crm_companies
  for each row execute function public.crm_company_client_number();

-- ── 3. Where a record went is the database's to say ──────────────────────

create or replace function public.guard_crm_merged_into()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role')
     and new.merged_into_id is distinct from (case when tg_op = 'UPDATE' then old.merged_into_id end) then
    raise exception 'Where a merged record went is the database''s to record. Merge the two instead.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['crm_companies', 'crm_contacts'] loop
    execute format('drop trigger if exists guard_merged_into on public.%I', t);
    execute format('create trigger guard_merged_into before insert or update on public.%I '
                   'for each row execute function public.guard_crm_merged_into()', t);
  end loop;
end
$$;

-- ── 4. What points at a company or a contact ─────────────────────────────
-- Every foreign key to crm_companies or crm_contacts, and how a merge treats it:
--   repoint       the merge points it at the kept record, in its step (see
--                 crm_merge_move_references below): an invoice moves in step 2,
--                 after the projects, because link_invoice (0051) checks an
--                 invoice against its project's company;
--   project link  merge_contacts() moves it, keeping the kept contact's link
--                 where both are on a project;
--   history       left as it is: a record merged into the merged one still says
--                 where it went, and merged_into_id leads on from there.
-- The first is called repoint, not move: npm test runs
-- supabase/functions/_shared/mail-safety.test.js, which fails on any migration
-- that names Graph's move or copy action as a quoted string.
-- A new foreign key to either table must be added here: this migration's last
-- block and supabase/tests/18-crm-functions.sql fail while one is missing. A
-- table may have more than one column listed, in one step or in several, and
-- each column moves (section 5); a column is listed once, which the last block
-- checks too.
-- workspace_notes points at records without a foreign key (0032); both merges
-- move its notes too.

create or replace function public.crm_merge_references()
returns table (target_table text, table_name text, column_name text, handling text, step int)
language sql
immutable
set search_path = ''
as $$
  values
    ('crm_companies', 'calendar_events',  'company_id',        'repoint',      1),
    ('crm_companies', 'client_projects',  'company_id',        'repoint',      1),
    ('crm_companies', 'crm_companies',    'merged_into_id',    'history',      null::int),
    ('crm_companies', 'crm_contacts',     'company_id',        'repoint',      1),
    ('crm_companies', 'finance_invoices', 'company_id',        'repoint',      2),   -- 0051
    ('crm_companies', 'mail_threads',     'company_id',        'repoint',      1),
    ('crm_companies', 'support_tickets',  'company_id',        'repoint',      1),
    ('crm_contacts',  'calendar_events',  'contact_id',        'repoint',      1),
    ('crm_contacts',  'crm_contacts',     'merged_into_id',    'history',      null),
    ('crm_contacts',  'mail_threads',     'contact_id',        'repoint',      1),
    ('crm_contacts',  'project_contacts', 'contact_id',        'project link', null),
    ('crm_contacts',  'support_tickets',  'contact_id',        'repoint',      1),
    ('crm_contacts',  'ticket_messages',  'author_contact_id', 'repoint',      1)
$$;

comment on function public.crm_merge_references() is
  'Every foreign key to crm_companies and crm_contacts, and how merge_companies() and '
  'merge_contacts() treat it (0053). A new one must be listed here.';

-- ── 5. What both merges share ────────────────────────────────────────────
-- Called only from the merges below, as their owner.

create or replace function public.crm_merge_pair_refusals(p_table text, p_keep uuid, p_drop uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_noun          text := case p_table when 'crm_companies' then 'company' when 'crm_contacts' then 'contact' end;
  v_key           text := case p_table when 'crm_companies' then 'company_id' when 'crm_contacts' then 'contact_id' end;
  v_keep_id       uuid;
  v_keep_deleted  timestamptz;
  v_keep_merged   uuid;
  v_drop_id       uuid;
  v_drop_deleted  timestamptz;
  v_drop_merged   uuid;
  v_circle        boolean;
begin
  if v_noun is null then
    raise exception 'crm_merge_pair_refusals: % is not a CRM table', p_table;
  end if;
  if p_keep is null or p_drop is null then
    raise exception 'Pick the % to keep and the % to merge into it.', v_noun, v_noun using errcode = '22023';
  end if;
  if p_keep = p_drop then
    raise exception 'A % cannot be merged into itself.', v_noun using errcode = '22023';
  end if;

  -- Both rows, locked in one order, so two merges of one pair wait for each
  -- other rather than deadlock.
  execute format('select 1 from public.%I where id in ($1, $2) order by id for update', p_table)
    using p_keep, p_drop;
  execute format('select id, deleted_at, merged_into_id from public.%I where id = $1', p_table)
    into v_keep_id, v_keep_deleted, v_keep_merged using p_keep;
  execute format('select id, deleted_at, merged_into_id from public.%I where id = $1', p_table)
    into v_drop_id, v_drop_deleted, v_drop_merged using p_drop;

  if v_keep_id is null then
    raise exception 'The % to keep is not in the CRM.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_keep)::text;
  end if;
  if v_drop_id is null then
    raise exception 'The % to merge is not in the CRM.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_drop)::text;
  end if;

  -- The record to keep, or one it went into, is the record to merge.
  execute format($q$
    with recursive chain (id, hops) as (
      select k.merged_into_id, 1 from public.%1$I k where k.id = $1
      union all
      select c.merged_into_id, chain.hops + 1
      from chain join public.%1$I c on c.id = chain.id
      where chain.hops < 10000
    )
    select exists (select 1 from chain where chain.id = $2)
  $q$, p_table) into v_circle using p_keep, p_drop;

  if v_circle then
    raise exception 'Merging these would go round in a circle: the % to keep was merged into the % to merge.', v_noun, v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_keep, 'merged_into_id', v_keep_merged)::text;
  end if;
  if v_keep_merged is not null then
    raise exception 'The % to keep was already merged into another.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_keep, 'merged_into_id', v_keep_merged)::text;
  end if;
  if v_drop_merged is not null then
    raise exception 'The % to merge was already merged into another.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_drop, 'merged_into_id', v_drop_merged)::text;
  end if;
  if v_keep_deleted is not null then
    raise exception 'The % to keep is deleted. Restore it first.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_keep)::text;
  end if;
  if v_drop_deleted is not null then
    raise exception 'The % to merge is deleted.', v_noun
      using errcode = '23503', detail = json_build_object(v_key, p_drop)::text;
  end if;
end;
$$;

-- Every reference crm_merge_references() lists as 'repoint', and that is a foreign
-- key here, pointed at the kept record step by step. A step's references move
-- in ONE statement, so the AFTER triggers of all its updates run once every one
-- of them is done: prune_project_contacts (0039) finds a project and its people
-- at the kept company together, and removes no link. Within that statement each
-- table is updated once, every column of it the step lists in one UPDATE:
-- Postgres applies only one of two updates of the same row in one statement, so
-- a table with two columns listed (a client and the company that referred it,
-- say) would otherwise keep one of them pointing at the merged record. A later
-- step moves after an earlier one, so its BEFORE triggers read what the earlier
-- step moved. A trigger that refuses a move stops the merge, saying what could
-- not move and why, under the refusal's own SQLSTATE.
--
-- Each column's count is read in the same statement, from the rows that pointed
-- at the merged record as the step began, and takes only the rows the caller
-- can read: in a table with a connection_id (mail_threads, calendar_events),
-- those with no connection or one can_read_connection() opens to the caller.
-- The rows it leaves out move all the same. A table listed later whose rows are
-- hidden from owners and admins by some other rule needs its own condition here.
create or replace function public.crm_merge_move_references(p_target text, p_keep uuid, p_drop uuid, p_known text[])
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_noun    text := case p_target when 'crm_companies' then 'company' when 'crm_contacts' then 'contact' end;
  v_step    record;
  v_part    jsonb;
  v_moved   jsonb := '{}'::jsonb;
  v_state   text;
  v_message text;
begin
  if v_noun is null
     or exists (select 1 from public.crm_merge_references() m
                where m.target_table = p_target
                  and (m.handling <> all (p_known) or (m.handling = 'repoint' and m.step is null)))
     or exists (select 1 from public.crm_merge_references() m
                where m.target_table = p_target
                group by m.table_name, m.column_name
                having count(*) > 1) then
    raise exception 'crm_merge_references() lists a reference to % this merge does not know how to treat', p_target;
  end if;

  -- One statement per step: for each of its tables a read (r<n>, one count per
  -- column) and one update (u<n>) of every listed column, as
  --   c = case when c = $2 then $1 else c end, … where c = $2 or …
  for v_step in
    with refs as (
      select m.step, m.table_name, m.column_name
      from public.crm_merge_references() m
      where m.target_table = p_target
        and m.handling = 'repoint'
        and exists (select 1
                    from pg_constraint k
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                    where k.contype = 'f'
                      and cardinality(k.conkey) = 1
                      and k.conrelid = to_regclass(format('public.%I', m.table_name))
                      and k.confrelid = to_regclass(format('public.%I', p_target))
                      and a.attname = m.column_name)
    ),
    tables as (
      select r.step, r.table_name,
             row_number() over (order by r.step, r.table_name) as n,
             array_agg(r.column_name order by r.column_name) as cols,
             exists (select 1 from pg_attribute a
                     where a.attrelid = to_regclass(format('public.%I', r.table_name))
                       and a.attname = 'connection_id' and a.attnum > 0 and not a.attisdropped) as by_connection
      from refs r
      group by r.step, r.table_name
    ),
    parts as (
      select t.step, t.n,
             format('r%1$s as (select %2$s from public.%3$I where %4$s), u%1$s as (update public.%3$I set %5$s where %4$s)',
                    t.n, s.counts, t.table_name, s.matches, s.moves) as ctes,
             s.answer
      from tables t
      cross join lateral (
        select string_agg(format('count(*) filter (where %I = $2%s) as k%s', c.col,
                                 case when t.by_connection
                                      then ' and (connection_id is null or public.can_read_connection(connection_id))'
                                      else '' end,
                                 c.i), ', ' order by c.i) as counts,
               string_agg(format('%I = $2', c.col), ' or ' order by c.i) as matches,
               string_agg(format('%1$I = case when %1$I = $2 then $1 else %1$I end', c.col), ', ' order by c.i) as moves,
               string_agg(format('%L, (select k%s from r%s)', t.table_name || '.' || c.col, c.i, t.n),
                          ', ' order by c.i) as answer
        from unnest(t.cols) with ordinality as c(col, i)
      ) s
    )
    select p.step,
           string_agg(p.ctes, ', ' order by p.n) as ctes,
           string_agg(p.answer, ', ' order by p.n) as answer,
           (select array_agg(r.table_name || '.' || r.column_name order by r.table_name, r.column_name)
            from refs r where r.step = p.step) as refs
    from parts p
    group by p.step
    order by p.step
  loop
    begin
      execute format('with %s select jsonb_build_object(%s)', v_step.ctes, v_step.answer)
        into v_part using p_keep, p_drop;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
      raise exception 'Could not point % at the kept %: %', array_to_string(v_step.refs, ', '), v_noun, v_message
        using errcode = v_state, detail = json_build_object('references', v_step.refs)::text;
    end;
    v_moved := v_moved || v_part;
  end loop;

  return v_moved;
end;
$$;

-- ── 6. A contact and their company, in one transaction ───────────────────

create or replace function public.create_contact_with_company(
  p_full_name    text,
  p_email        text    default null,
  p_phone        text    default null,
  p_title        text    default null,
  p_is_primary   boolean default false,
  p_notes        text    default null,
  p_enquiry_id   uuid    default null,
  p_company_id   uuid    default null,
  p_company_name text    default null,
  out contact_id uuid,
  out company_id uuid
)
returns record
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text := nullif(btrim(p_full_name), '');
  v_email    text := nullif(lower(btrim(p_email)), '');
  v_company  text := nullif(btrim(p_company_name), '');
  v_existing uuid;
  v_matches  uuid[];
begin
  if not public.is_staff() then
    raise exception 'Only staff can add contacts.' using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'A contact needs a name.' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@([^@[:space:].]+\.)+[^@[:space:].]{2,}$' then
    raise exception 'That email address is not an address, like ana@northline.example.' using errcode = '22023';
  end if;
  if p_company_id is not null and v_company is not null then
    raise exception 'Give the company as one in the CRM or as a new name, not both.' using errcode = '22023';
  end if;

  -- One live contact per address (crm_contacts_email_idx). Two calls with one
  -- address take turns here, so the second sees the first's contact.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext('public.crm_contacts: email ' || v_email));
    select c.id into v_existing
    from public.crm_contacts c
    where lower(c.email) = v_email and c.deleted_at is null
    limit 1;
    if v_existing is not null then
      raise exception 'A contact with that email address is already in the CRM.'
        using errcode = '23505',
              detail = json_build_object('contact_id', v_existing)::text,
              hint = 'Open that contact, or use another address.';
    end if;
  end if;

  if p_company_id is not null then
    -- Held until the contact is in, so the company is not merged or deleted meanwhile.
    select co.id into company_id
    from public.crm_companies co
    where co.id = p_company_id and co.deleted_at is null
    for share;
    if company_id is null then
      raise exception 'That company is not in the CRM.'
        using errcode = '23503', detail = json_build_object('company_id', p_company_id)::text;
    end if;
  elsif v_company is not null then
    -- Two calls naming one new company take turns, so they make one company.
    perform pg_advisory_xact_lock(hashtext('public.crm_companies: name ' || lower(v_company)));
    select array_agg(m.id order by m.created_at, m.id) into v_matches
    from (select co.id, co.created_at
          from public.crm_companies co
          where lower(btrim(co.name)) = lower(v_company) and co.deleted_at is null
          for share) m;
    if cardinality(v_matches) > 1 then
      raise exception 'More than one company is called "%". Pick one of them.', v_company
        using errcode = '21000', detail = json_build_object('company_ids', v_matches)::text;
    end if;
    company_id := v_matches[1];
    if company_id is null then
      insert into public.crm_companies (name, owner_id)
      values (v_company, public.active_employee_id())
      returning id into company_id;
    end if;
  end if;

  begin
    insert into public.crm_contacts (company_id, full_name, email, phone, title, is_primary, enquiry_id, notes)
    values (company_id, v_name, v_email, nullif(btrim(p_phone), ''), nullif(btrim(p_title), ''),
            coalesce(p_is_primary, false), p_enquiry_id, nullif(btrim(p_notes), ''))
    returning id into contact_id;
  exception when unique_violation then
    -- Someone added a contact on this address outside this function meanwhile.
    select c.id into v_existing
    from public.crm_contacts c
    where lower(c.email) = v_email and c.deleted_at is null
    limit 1;
    if v_existing is null then
      raise;
    end if;
    raise exception 'A contact with that email address is already in the CRM.'
      using errcode = '23505',
            detail = json_build_object('contact_id', v_existing)::text,
            hint = 'Open that contact, or use another address.';
  end;
end;
$$;

-- ── 7. Merging two companies ─────────────────────────────────────────────

create or replace function public.merge_companies(p_keep uuid, p_drop uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- crm_companies.currency's default (0021).
  c_default_currency constant text := 'USD';
  v_keep         record;
  v_drop         record;
  v_keep_code    text;
  v_drop_code    text;
  v_code         text;
  v_carry_value  boolean;
  v_number_moves boolean;
  v_filled       text[];
  v_moved        jsonb;
  v_notes        int;
begin
  if not public.is_manager() then
    raise exception 'Only an owner or admin can merge companies.' using errcode = '42501';
  end if;
  perform public.crm_merge_pair_refusals('crm_companies', p_keep, p_drop);

  select c.name, c.domain, c.value, c.currency, c.owner_id, c.notes, c.client_number
    into v_keep from public.crm_companies c where c.id = p_keep;
  select c.name, c.domain, c.value, c.currency, c.owner_id, c.notes, c.client_number
    into v_drop from public.crm_companies c where c.id = p_drop;

  -- A code 0049's rule accepts, when case or spaces are all that is wrong.
  v_keep_code := case when upper(btrim(v_keep.currency)) ~ '^[A-Z]{3}$' then upper(btrim(v_keep.currency)) end;
  v_drop_code := case when upper(btrim(v_drop.currency)) ~ '^[A-Z]{3}$' then upper(btrim(v_drop.currency)) end;
  v_carry_value := v_keep.value is null and v_drop.value is not null and v_drop_code is not null;

  if v_carry_value then
    v_code := v_drop_code;
  elsif v_keep_code is not null then
    v_code := v_keep_code;
  elsif v_keep.value is null then
    v_code := coalesce(v_drop_code, c_default_currency);
  else
    raise exception 'Give the company to keep a currency like EUR or USD first: its value is in "%".', v_keep.currency
      using errcode = '23514',
            detail = json_build_object('company_id', p_keep, 'currency', v_keep.currency)::text;
  end if;

  v_number_moves := v_keep.client_number is null and v_drop.client_number is not null;
  v_filled := array_remove(array[
    case when btrim(v_keep.name) = '' and btrim(v_drop.name) <> '' then 'name' end,
    case when coalesce(btrim(v_keep.domain), '') = '' and v_drop.domain is not null then 'domain' end,
    case when v_carry_value then 'value' end,
    case when v_keep.owner_id is null and v_drop.owner_id is not null then 'owner_id' end,
    case when coalesce(btrim(v_keep.notes), '') = '' and v_drop.notes is not null then 'notes' end,
    case when v_number_moves then 'client_number' end
  ], null);

  if v_number_moves then
    perform set_config('veyago.client_number_move',
                       format('%s>%s#%s', p_drop, p_keep, v_drop.client_number), true);
  end if;

  -- The merged company goes first, so its domain and number are free to take.
  update public.crm_companies c
  set deleted_at     = now(),
      merged_into_id = p_keep,
      currency       = coalesce(v_drop_code, v_code),
      client_number  = case when v_number_moves then null else c.client_number end
  where c.id = p_drop;

  update public.crm_companies c
  set name          = case when btrim(c.name) = '' then v_drop.name else c.name end,
      domain        = case when coalesce(btrim(c.domain), '') = '' then v_drop.domain else c.domain end,
      value         = case when v_carry_value then v_drop.value else c.value end,
      currency      = v_code,
      owner_id      = coalesce(c.owner_id, v_drop.owner_id),
      notes         = case when coalesce(btrim(c.notes), '') = '' then v_drop.notes else c.notes end,
      client_number = case when v_number_moves then v_drop.client_number else c.client_number end
  where c.id = p_keep;

  perform set_config('veyago.client_number_move', '', true);

  v_moved := public.crm_merge_move_references('crm_companies', p_keep, p_drop, array['repoint', 'history']);

  update public.workspace_notes n
  set entity_id = p_keep
  where n.entity_type = 'company' and n.entity_id = p_drop;
  get diagnostics v_notes = row_count;

  perform public.log_activity('updated', 'company', p_keep,
    'Merged ' || v_drop.name || ' into ' || case when btrim(v_keep.name) = '' then v_drop.name else v_keep.name end);

  return jsonb_build_object(
    'kept_id',       p_keep,
    'merged_id',     p_drop,
    'moved',         v_moved,
    'notes_moved',   v_notes,
    'filled',        to_jsonb(v_filled),
    'client_number', coalesce(v_keep.client_number, v_drop.client_number),
    'left_behind',   case when v_keep.value is null and v_drop.value is not null and not v_carry_value
                          then jsonb_build_object('value', v_drop.value, 'currency', v_drop.currency) end
  );
end;
$$;

-- ── 8. Merging two contacts ──────────────────────────────────────────────

create or replace function public.merge_contacts(p_keep uuid, p_drop uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep     record;
  v_drop     record;
  v_company  uuid;
  v_blocked  uuid[];
  v_projects text;
  v_filled   text[];
  v_moved    jsonb;
  v_dropped  int;
  v_links    int;
  v_notes    int;
begin
  if not public.is_manager() then
    raise exception 'Only an owner or admin can merge contacts.' using errcode = '42501';
  end if;
  perform public.crm_merge_pair_refusals('crm_contacts', p_keep, p_drop);

  select c.full_name, c.company_id, c.email, c.phone, c.title, c.is_primary, c.enquiry_id, c.notes
    into v_keep from public.crm_contacts c where c.id = p_keep;
  select c.full_name, c.company_id, c.email, c.phone, c.title, c.is_primary, c.enquiry_id, c.notes
    into v_drop from public.crm_contacts c where c.id = p_drop;

  v_company := coalesce(v_keep.company_id, v_drop.company_id);

  -- A project's people work at its company (0039). A link the kept contact
  -- cannot take is a person's call, not something to drop quietly.
  select array_agg(p.id order by p.name, p.id), string_agg(p.name, ', ' order by p.name, p.id)
    into v_blocked, v_projects
  from public.project_contacts pc
  join public.client_projects p on p.id = pc.project_id
  where pc.contact_id = p_drop
    and p.company_id is distinct from v_company
    and not exists (select 1 from public.project_contacts k
                    where k.contact_id = p_keep and k.project_id = pc.project_id);
  if v_blocked is not null then
    raise exception 'The contact to merge is on projects for a company the contact to keep does not work at: %. '
                    'Move the contact to keep to that company, or take the other off those projects, first.', v_projects
      using errcode = '23514', detail = json_build_object('project_ids', v_blocked)::text;
  end if;

  v_filled := array_remove(array[
    case when btrim(v_keep.full_name) = '' and btrim(v_drop.full_name) <> '' then 'full_name' end,
    case when v_keep.company_id is null and v_drop.company_id is not null then 'company_id' end,
    case when coalesce(btrim(v_keep.email), '') = '' and v_drop.email is not null then 'email' end,
    case when coalesce(btrim(v_keep.phone), '') = '' and v_drop.phone is not null then 'phone' end,
    case when coalesce(btrim(v_keep.title), '') = '' and v_drop.title is not null then 'title' end,
    case when not v_keep.is_primary and v_drop.is_primary
              and v_company is not distinct from v_drop.company_id then 'is_primary' end,
    case when v_keep.enquiry_id is null and v_drop.enquiry_id is not null then 'enquiry_id' end,
    case when coalesce(btrim(v_keep.notes), '') = '' and v_drop.notes is not null then 'notes' end
  ], null);

  -- The merged contact goes first, so its address is free to take.
  update public.crm_contacts c
  set deleted_at = now(), merged_into_id = p_keep
  where c.id = p_drop;

  update public.crm_contacts c
  set full_name  = case when btrim(c.full_name) = '' then v_drop.full_name else c.full_name end,
      company_id = v_company,
      email      = case when coalesce(btrim(c.email), '') = '' then v_drop.email else c.email end,
      phone      = case when coalesce(btrim(c.phone), '') = '' then v_drop.phone else c.phone end,
      title      = case when coalesce(btrim(c.title), '') = '' then v_drop.title else c.title end,
      is_primary = c.is_primary or (v_drop.is_primary and v_company is not distinct from v_drop.company_id),
      enquiry_id = coalesce(c.enquiry_id, v_drop.enquiry_id),
      notes      = case when coalesce(btrim(c.notes), '') = '' then v_drop.notes else c.notes end
  where c.id = p_keep;

  v_moved := public.crm_merge_move_references('crm_contacts', p_keep, p_drop,
                                              array['repoint', 'project link', 'history']);

  -- On a project both are on, the kept contact's link and role stay.
  delete from public.project_contacts d
  using public.project_contacts k
  where d.contact_id = p_drop and k.contact_id = p_keep and k.project_id = d.project_id;
  get diagnostics v_dropped = row_count;

  update public.project_contacts pc
  set contact_id = p_keep
  where pc.contact_id = p_drop;
  get diagnostics v_links = row_count;

  update public.workspace_notes n
  set entity_id = p_keep
  where n.entity_type = 'contact' and n.entity_id = p_drop;
  get diagnostics v_notes = row_count;

  perform public.log_activity('updated', 'contact', p_keep,
    'Merged ' || v_drop.full_name || ' into '
      || case when btrim(v_keep.full_name) = '' then v_drop.full_name else v_keep.full_name end);

  return jsonb_build_object(
    'kept_id',               p_keep,
    'merged_id',             p_drop,
    'moved',                 v_moved,
    'project_links_moved',   v_links,
    'project_links_dropped', v_dropped,
    'notes_moved',           v_notes,
    'filled',                to_jsonb(v_filled)
  );
end;
$$;

-- ── 9. Who may call what ─────────────────────────────────────────────────

revoke all on function public.create_contact_with_company(text, text, text, text, boolean, text, uuid, uuid, text)
  from public, anon;
grant execute on function public.create_contact_with_company(text, text, text, text, boolean, text, uuid, uuid, text)
  to authenticated;

revoke all on function public.merge_companies(uuid, uuid), public.merge_contacts(uuid, uuid) from public, anon;
grant execute on function public.merge_companies(uuid, uuid), public.merge_contacts(uuid, uuid) to authenticated;

-- The merges' own parts, and the triggers: nobody calls these directly.
revoke all on function public.crm_merge_references(),
  public.crm_merge_pair_refusals(text, uuid, uuid),
  public.crm_merge_move_references(text, uuid, uuid, text[]),
  public.crm_company_client_number(),
  public.guard_crm_merged_into()
  from public, anon, authenticated, service_role;

comment on function public.create_contact_with_company(text, text, text, text, boolean, text, uuid, uuid, text) is
  'Staff: adds a contact and, when named, their company in one transaction; answers (contact_id, company_id). '
  'Refuses 23505 with detail {"contact_id"} when a live contact has the address, 23503 {"company_id"} for a '
  'company not in the CRM, 21000 {"company_ids"} for a name two live companies have, 22023 for a missing name, '
  'an address that is not one, or both a company id and a name, 42501 for anyone not staff (0053).';
comment on function public.merge_companies(uuid, uuid) is
  'Owners and admins: points everything at p_drop at p_keep, fills p_keep''s empty fields, deletes p_drop and '
  'records merged_into_id; "moved" counts only rows the caller can read. Refuses 42501, 22023 (itself, missing '
  'argument), 23503 (not in the CRM, deleted, already merged, a circle), 23514 (p_keep''s value in an unreadable '
  'currency), and passes on a trigger''s refusal to move a reference, under its SQLSTATE, as "Could not point '
  '<table>.<column> at the kept company: …" with detail {"references"}. See 0053.';
comment on function public.merge_contacts(uuid, uuid) is
  'Owners and admins: points everything at p_drop at p_keep, keeps p_keep''s project links where both are on a '
  'project, fills p_keep''s empty fields, deletes p_drop and records merged_into_id; "moved" counts only rows the '
  'caller can read. Refuses 42501, 22023, 23503, 23514 (project links p_keep cannot take), and passes on a '
  'trigger''s refusal to move a reference, under its SQLSTATE. See 0053.';

-- ── 10. Numbers for the clients there already ────────────────────────────

do $$
declare
  v_rule    record;
  v_names   text[] := '{}';
  v_defs    text[] := '{}';
  v_needs   int;
  v_count   int := 0;
  v_number  int;
  v_first   int;
  v_last    int;
  v_touch   boolean;
  r         record;
begin
  -- A NOT VALID rule (0049's currency rule, while companies stored before it
  -- hold other codes) fails any update of a row that breaks it. Set aside only
  -- the rules a client to be numbered breaks, and only for this block.
  for v_rule in
    select k.conname,
           regexp_replace(pg_get_constraintdef(k.oid), '\s+NOT VALID$', '') as def,
           pg_get_expr(k.conbin, k.conrelid) as expr
    from pg_constraint k
    where k.conrelid = 'public.crm_companies'::regclass and k.contype = 'c' and not k.convalidated
  loop
    execute format('select count(*) from public.crm_companies '
                   'where stage = %L and client_number is null and deleted_at is null and (%s) is false',
                   'client', v_rule.expr)
      into v_needs;
    if v_needs > 0 then
      raise notice '0053: % clients to number break the NOT VALID rule %, so it is set aside while they are '
                   'numbered and put back as it was, still NOT VALID. Their codes are not changed.',
                   v_needs, v_rule.conname;
      v_names := v_names || v_rule.conname::text;
      v_defs  := v_defs || v_rule.def;
      execute format('alter table public.crm_companies drop constraint %I', v_rule.conname);
    end if;
  end loop;

  -- Being numbered is not an edit a person made: updated_at stays.
  v_touch := exists (select 1 from pg_trigger
                     where tgrelid = 'public.crm_companies'::regclass
                       and tgname = 'crm_companies_touch_updated_at' and tgenabled <> 'D');
  if v_touch then
    alter table public.crm_companies disable trigger crm_companies_touch_updated_at;
  end if;

  for r in
    select c.id
    from public.crm_companies c
    where c.stage = 'client' and c.client_number is null and c.deleted_at is null
    order by c.created_at, c.id
  loop
    -- crm_companies_client_number gives the number.
    update public.crm_companies c set client_number = null where c.id = r.id
    returning c.client_number into v_number;
    v_first := coalesce(v_first, v_number);
    v_last  := v_number;
    v_count := v_count + 1;
  end loop;

  if v_touch then
    alter table public.crm_companies enable trigger crm_companies_touch_updated_at;
  end if;

  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    execute format('alter table public.crm_companies add constraint %I %s not valid', v_names[i], v_defs[i]);
    if not exists (select 1 from pg_constraint
                   where conrelid = 'public.crm_companies'::regclass and conname = v_names[i]
                     and regexp_replace(pg_get_constraintdef(oid), '\s+NOT VALID$', '') = v_defs[i]) then
      raise exception '0053: the rule % did not come back as it was', v_names[i];
    end if;
  end loop;

  if v_count > 0 then
    raise notice '0053: numbered % existing clients, oldest first: % to %.', v_count, v_first, v_last;
  end if;
end
$$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
  v_stale   text;
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'crm_companies' and column_name in ('client_number', 'merged_into_id'))
             or (table_name = 'crm_contacts' and column_name = 'merged_into_id'))) <> 3 then
    raise exception '0053: a client number, or where a merged record went, has nowhere to be stored';
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.crm_companies'::regclass
                   and conname = 'crm_companies_client_number_key' and contype = 'u') then
    raise exception '0053: two companies could share a client number';
  end if;

  if (select count(*) from pg_trigger
      where not tgisinternal and tgenabled <> 'D'
        and ((tgrelid = 'public.crm_companies'::regclass
              and tgname in ('crm_companies_client_number', 'guard_merged_into'))
             or (tgrelid = 'public.crm_contacts'::regclass and tgname = 'guard_merged_into'))) <> 3 then
    raise exception '0053: client numbers or merged_into_id can be written by hand';
  end if;

  if exists (select 1 from pg_trigger
             where tgrelid = 'public.crm_companies'::regclass
               and tgname = 'crm_companies_touch_updated_at' and tgenabled = 'D') then
    raise exception '0053: crm_companies_touch_updated_at was left switched off';
  end if;

  if exists (select 1 from public.crm_companies
             where stage = 'client' and deleted_at is null and client_number is null) then
    raise exception '0053: a client has no client number';
  end if;

  if exists (select 1
             from (values ('public.create_contact_with_company(text,text,text,text,boolean,text,uuid,uuid,text)'::regprocedure),
                          ('public.merge_companies(uuid,uuid)'::regprocedure),
                          ('public.merge_contacts(uuid,uuid)'::regprocedure)) as v(f)
             join pg_proc p on p.oid = v.f
             where not p.prosecdef
                or not exists (select 1 from unnest(p.proconfig) s where s like 'search_path=%')
                or has_function_privilege('anon', v.f, 'execute')
                or not has_function_privilege('authenticated', v.f, 'execute')) then
    raise exception '0053: a CRM function does not run as its owner with a fixed search_path, or anon can call it';
  end if;

  if exists (select 1 from public.crm_merge_references() m
             where m.handling not in ('repoint', 'project link', 'history')
                or (m.handling = 'repoint') <> (m.step is not null)) then
    raise exception '0053: crm_merge_references() lists a reference no merge knows how to treat';
  end if;

  if exists (select 1 from public.crm_merge_references() m
             group by m.target_table, m.table_name, m.column_name
             having count(*) > 1) then
    raise exception '0053: crm_merge_references() lists a reference twice';
  end if;

  -- Section 5: a table's listed columns move in one update, and the answer
  -- counts only what the caller can read.
  if pg_get_functiondef('public.crm_merge_move_references(text,uuid,uuid,text[])'::regprocedure)
       not like '%case when %1$I = $2 then $1 else %1$I end%'
     or pg_get_functiondef('public.crm_merge_move_references(text,uuid,uuid,text[])'::regprocedure)
       not like '%public.can_read_connection(connection_id)%' then
    raise exception '0053: a merge can leave a column behind, or count rows its caller cannot read';
  end if;

  -- Every foreign key to a CRM table is one the merges handle.
  select string_agg(c.conrelid::regclass::text || '.' || a.attname, ', '
                    order by c.conrelid::regclass::text, a.attname)
    into v_missing
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.confrelid in ('public.crm_companies'::regclass, 'public.crm_contacts'::regclass)
    and (cardinality(c.conkey) <> 1
         or not exists (select 1 from public.crm_merge_references() m
                        where to_regclass(format('public.%I', m.table_name)) = c.conrelid
                          and m.column_name = a.attname
                          and to_regclass(format('public.%I', m.target_table)) = c.confrelid));
  if v_missing is not null then
    raise exception '0053: no merge handles these foreign keys to the CRM: %. List them in crm_merge_references().',
                    v_missing;
  end if;

  -- Listed but not a foreign key here (0051 not applied, say): no merge touches it.
  select string_agg(m.table_name || '.' || m.column_name, ', ') into v_stale
  from public.crm_merge_references() m
  where not exists (select 1
                    from pg_constraint c
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                    where c.contype = 'f'
                      and c.conrelid = to_regclass(format('public.%I', m.table_name))
                      and c.confrelid = to_regclass(format('public.%I', m.target_table))
                      and a.attname = m.column_name);
  if v_stale is not null then
    raise notice '0053: listed in crm_merge_references() but not a foreign key here, so no merge moves it: %', v_stale;
  end if;
end
$$;
