-- =============================================================================
-- 0067 — several deals per client, each with its own stage and value, and a
--        won/lost history the old shape could not hold at all.
--
-- crm_companies (0021) carries ONE stage, ONE value and ONE currency directly
-- on the company row. That is a relationship's state, not a deal's, and it
-- cost the studio three things:
--
--   1. A client with two pieces of work in flight — a retainer being renewed
--      and a new site being quoted — had one stage between them. Moving the
--      card to Proposal for the second said the first was a proposal too.
--   2. There was nowhere to put a second value. The studio's answer was to
--      overwrite the first, so the pipeline figure on the CRM's own stat strip
--      (crm-ui.js's stats()) has only ever counted one deal per client.
--   3. Nothing recorded WHEN a deal was won or lost, or that it ever existed.
--      A company moved from 'proposal' to 'client' lost the proposal: the
--      stage column held the present and nothing else, so "how much did we win
--      last quarter" could not be asked of this database at all.
--
-- ── What changes ────────────────────────────────────────────────────────
--   crm_deals: one row per deal, several per company. Its own title, stage,
--   value, currency, owner and expected close date, and — new, and the reason
--   this table exists rather than a second value column on the company —
--   `outcome` ('won' or 'lost') with `closed_at`, both null while the deal is
--   open. A deal is open exactly when it has no outcome, which is the one rule
--   every read here turns on.
--
--   `stage` is where an OPEN deal stands: lead, qualified, proposal, or
--   dormant — gone quiet, neither won nor lost. Won and Lost are NOT stages:
--   they are the outcome, so a deal keeps the stage it stood at when it
--   closed and the board can draw "won out of proposal" rather than losing
--   that the moment it is won. This is why the four stages here are not the
--   six on crm_companies: 'client' and 'lost' there are outcomes wearing a
--   stage's clothes, which is exactly what stopped the old shape recording a
--   history.
--
-- ── WHAT IS NOT DONE HERE, ON PURPOSE ──────────────────────────────────
-- crm_companies.stage, .value and .currency are NOT dropped and NOT touched.
-- They are still read by: queries.js's companies() and contacts() (the
-- contacts list embeds its company's stage, value and currency), 0053's
-- client-number trigger, which gives a company its client_number the first
-- time it reaches stage 'client', and promote_enquiry_to_crm() (0049), which
-- inserts a company at stage 'lead'. Dropping them is a separate migration,
-- after every one of those readers has moved to crm_deals; doing it here
-- would break the CRM's contacts list and the client numbering in the same
-- push. Nothing in this migration writes back to those columns either: a deal
-- won does not move its company to 'client', because that would hand a client
-- number out on a trigger the studio has not asked to fire.
--
-- ── crm_merge_references() IS REPLACED HERE ─────────────────────────────
-- crm_deals.company_id is a foreign key to crm_companies, and 0053 refuses a
-- merge outright — 'crm_merge_references() lists a reference to % this merge
-- does not know how to treat' — for any foreign key to a CRM table that its
-- list does not name. Without the row added in §6 below, merging two
-- companies would stop dead from the moment this table exists. The body in §6
-- is 0053's own VALUES list, read from 0053 (the only migration that defines
-- this function) and reproduced entire, with ONE row added; nothing already
-- in it is changed or dropped.
--
-- Policies mirror 0021's, which is the house pattern for a CRM table: staff
-- read, add and change; only a manager removes. 0040 only reached the tables
-- that existed when it ran (its own header says so), so a table added since
-- carries the restrictive "second factor required" policy itself — the same
-- reasoning 0060 wrote down for finance_invoice_lines, and the same policy
-- text — or supabase/tests/06-second-factor.sql's generic coverage check
-- fails the moment this table exists.
--
-- Idempotent. Adds only; changes no existing row.
-- =============================================================================

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. The table ─────────────────────────────────────────────────────────
-- on delete cascade, not set null: a deal with no company is a row nothing
-- can ever open again — every list of deals in the workspace is reached
-- through a company. A company is removed from the CRM with deleted_at
-- (guard_soft_delete, below), never with DELETE, so this cascade only fires
-- on the hard delete a manager makes deliberately in SQL.

create table if not exists public.crm_deals (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.crm_companies(id) on delete cascade,
  title          text not null,
  -- Where an OPEN deal stands. 'dormant' is open and gone quiet: not won, not
  -- lost, and not counted as live pipeline by the board that draws it.
  stage          text not null default 'lead'
                   check (stage in ('lead', 'qualified', 'proposal', 'dormant')),
  value          numeric(12,2),
  currency       text not null default 'USD',
  owner_id       uuid references public.employees(id) on delete set null,
  expected_close date,
  -- The history the old shape could not hold. Null while the deal is open.
  outcome        text check (outcome in ('won', 'lost')),
  closed_at      timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- A deal with a blank title is one nothing in a list can name. btrim, not
-- <> '', so a title of spaces is refused too.
alter table public.crm_deals drop constraint if exists crm_deals_title_check;
alter table public.crm_deals add constraint crm_deals_title_check
  check (btrim(title) <> '');

-- Closed exactly when it has a date: an outcome with no date is a won deal
-- that cannot be put in a quarter, and a date with no outcome is a closed
-- deal nobody can say the result of. One rule, both directions.
alter table public.crm_deals drop constraint if exists crm_deals_closed_check;
alter table public.crm_deals add constraint crm_deals_closed_check
  check ((outcome is null) = (closed_at is null));

-- A deal's value is what winning it is worth, so it is never negative.
-- crm_companies.value has no such rule (0021) and rows there may hold one
-- either way; this is a new table with nothing to grandfather in, so it is
-- checked from the start rather than added NOT VALID as 0049 had to.
alter table public.crm_deals drop constraint if exists crm_deals_value_check;
alter table public.crm_deals add constraint crm_deals_value_check
  check (value is null or value >= 0);

-- The currency rule is NOT added here. It goes on in §5, after the backfill,
-- and the reason is the whole of why 0049 had to do the same on
-- crm_companies: NOT VALID skips the rows already stored, but every row
-- INSERTED afterwards is checked, and the backfill copies each company's own
-- currency — including the "US$" 0049 could not rewrite. Added first, the
-- rule would refuse the backfill of exactly the companies it exists to get
-- eventually right.

-- Every deal a company has, which is how each one is read: from its company.
create index if not exists crm_deals_company_idx
  on public.crm_deals (company_id) where deleted_at is null;
-- The board's own read: the open deals, by the column they sit in, soonest
-- expected close first. Partial on `outcome is null` because the board asks
-- for open deals and nothing else, and on a studio's books the closed ones
-- are the part that only grows.
create index if not exists crm_deals_open_idx
  on public.crm_deals (stage, expected_close) where deleted_at is null and outcome is null;
-- The won/lost history, newest first: "what did we close last quarter".
create index if not exists crm_deals_closed_idx
  on public.crm_deals (closed_at desc) where deleted_at is null and outcome is not null;

comment on table public.crm_deals is
  'One row per deal, several per company (0067). A deal is open exactly when '
  'outcome is null; `stage` is where an open deal stands, and a closed deal '
  'keeps the stage it stood at when it closed. crm_companies.stage/.value/'
  '.currency are still read by other code and are NOT replaced by this table '
  'yet — 0067''s header lists the readers that have to move first.';

comment on column public.crm_deals.stage is
  'Where an OPEN deal stands. Won and lost are outcomes, not stages (0067), '
  'so that a deal keeps the stage it was at when it closed.';
comment on column public.crm_deals.outcome is
  'Null while the deal is open; ''won'' or ''lost'' once it closed, always '
  'together with closed_at (crm_deals_closed_check, 0067).';
comment on column public.crm_deals.closed_at is
  'When the deal was won or lost. Null while it is open (0067).';
comment on column public.crm_deals.currency is
  'Three capital letters, as crm_companies.currency since 0049. Its rule is '
  'added after the backfill and stays NOT VALID while a backfilled row still '
  'carries a code a company held from before that rule; see 0067 §5.';

-- ── 2. updated_at, and a soft delete only a manager may make ─────────────
-- Both triggers as 0021 wired them to crm_companies and crm_contacts. Named
-- so guard_soft_delete sorts before the touch trigger: two BEFORE UPDATE
-- triggers fire in alphabetical order, and the guard must have its say first.

drop trigger if exists guard_soft_delete on public.crm_deals;
create trigger guard_soft_delete
  before update on public.crm_deals
  for each row execute function public.guard_soft_delete();

drop trigger if exists crm_deals_touch_updated_at on public.crm_deals;
create trigger crm_deals_touch_updated_at
  before update on public.crm_deals
  for each row execute function public.touch_updated_at();

-- ── 3. RLS ───────────────────────────────────────────────────────────────
-- The split 0021 established for the CRM, and 0012 for content before it: the
-- two-person studio both keep the pipeline, and removing a record is a manager
-- decision. Written out rather than looped as 0021 did, because this is one
-- table and a loop over one table reads as a loop that is waiting for a second.

alter table public.crm_deals enable row level security;

drop policy if exists "staff read crm_deals" on public.crm_deals;
create policy "staff read crm_deals" on public.crm_deals
  for select using (public.is_staff());

drop policy if exists "staff creates crm_deals" on public.crm_deals;
create policy "staff creates crm_deals" on public.crm_deals
  for insert with check (public.is_staff());

drop policy if exists "staff updates crm_deals" on public.crm_deals;
create policy "staff updates crm_deals" on public.crm_deals
  for update using (public.is_staff()) with check (public.is_staff());

-- Hard delete stays with managers; everyday removal is deleted_at, which
-- guard_soft_delete already restricts to managers.
drop policy if exists "manager deletes crm_deals" on public.crm_deals;
create policy "manager deletes crm_deals" on public.crm_deals
  for delete using (public.is_manager());

-- 0040 only reached the tables that existed when it ran; a table added since
-- carries this restrictive policy itself, or the second factor gate has a hole
-- the moment this table exists. The same text 0060 gave finance_invoice_lines.
drop policy if exists "second factor required" on public.crm_deals;
create policy "second factor required" on public.crm_deals
  as restrictive for all to authenticated
  using ((select public.second_factor_met()))
  with check ((select public.second_factor_met()));

-- ── 4. One deal per company, from what the company already says ──────────
--
-- First, the one thing the backfill cannot carry across. crm_companies.value
-- has never been checked for sign (0021), and crm_deals_value_check above
-- refuses a negative one — a deal is worth what winning it pays, which is not
-- a negative number. A company holding one stops this migration rather than
-- having it silently zeroed or flipped, the way 0060 stopped on two invoices
-- sharing a number: which of those a studio meant is a person's call, not a
-- guess this migration is entitled to make.

do $$
declare v_negative int;
begin
  select count(*) into v_negative
  from public.crm_companies where deleted_at is null and value < 0;
  if v_negative > 0 then
    raise exception '0067: % live companies have a negative value, which a deal cannot hold. '
                    'Find them with: select id, name, value from public.crm_companies '
                    'where deleted_at is null and value < 0; fix or clear each, then run this again.', v_negative;
  end if;
end
$$;

-- Nothing is lost: every live company's stage, value and currency become its
-- first deal. Only companies with no deal yet are given one, so running this
-- again adds nothing a second time, and a deal added by hand after the first
-- run does not make the company eligible again.
--
-- Soft-deleted companies are skipped. A company off every list has no deal
-- anybody can reach (a deal is read through its company), and giving one to a
-- row a manager already removed would put its value back into a total the
-- moment anyone counted deals without repeating the company's own deleted_at
-- check.
--
-- The stage mapping, and where it is a judgement rather than a copy:
--   lead / qualified / proposal / dormant  → the same stage, still open.
--   client → won, at stage 'proposal': a company that became a client got
--            through the whole pipeline, so proposal is the furthest open
--            stage it can be asserted to have reached.
--   lost   → lost, at stage 'lead': the old shape recorded that a company was
--            lost and never where it stood when that happened, so 'lead' is
--            the only stage every deal is known to have reached. A closed
--            deal is drawn in the Won or Lost column by its outcome, not by
--            its stage, so this affects a history line and nothing that is
--            counted.
--
-- closed_at for those two is the company's own updated_at — the only evidence
-- this database holds of when that relationship last changed. It is evidence,
-- not a record of the day the deal closed, and a studio correcting one is
-- editing a date, not inventing one it never had.
--
-- The title is the company's name: the old shape had no title to carry, and a
-- deal has to be nameable in a list. Renaming it is an ordinary edit. A
-- company whose own name is blank — crm_companies.name is not-null but has
-- never been checked for that (0021) — would fail crm_deals_title_check, so
-- its deal reads "Untitled company" rather than stopping the migration over a
-- record that is already unreadable everywhere else in the workspace.
--
-- created_at is the company's, not now(): a backfilled deal is as old as the
-- relationship it stands for, and a history ordered by created_at would
-- otherwise say every deal the studio has ever had began on the day of this
-- push.
--
-- The currency is written as three capital letters where the company's only
-- differed by case or the spaces around it (" usd " is USD), exactly as 0049
-- rewrote them on crm_companies. A company still holding a code outside that
-- rule — "US$" — hands it to its deal unchanged rather than losing it, and §5
-- below then leaves crm_deals_currency_check NOT VALID and says how many.

insert into public.crm_deals (company_id, title, stage, value, currency, owner_id,
                              outcome, closed_at, created_at)
select c.id,
       coalesce(nullif(btrim(c.name), ''), 'Untitled company'),
       case c.stage
         when 'client' then 'proposal'
         when 'lost'   then 'lead'
         else c.stage
       end,
       c.value,
       case when upper(btrim(c.currency)) ~ '^[A-Z]{3}$' then upper(btrim(c.currency)) else c.currency end,
       c.owner_id,
       case c.stage when 'client' then 'won' when 'lost' then 'lost' else null end,
       case when c.stage in ('client', 'lost') then c.updated_at else null end,
       c.created_at
from public.crm_companies c
where c.deleted_at is null
  and not exists (select 1 from public.crm_deals d where d.company_id = c.id);

do $$
declare v_backfilled int;
begin
  select count(*) into v_backfilled from public.crm_deals;
  raise notice '0067: % deals on the books, one per live company unless the studio has added more', v_backfilled;
end
$$;

-- ── 5. A currency the workspace can show ─────────────────────────────────
-- Added now rather than with the rest of the table's rules, because NOT VALID
-- exempts only the rows already stored: had this been in place a moment ago,
-- it would have refused the backfill of every company whose code 0049 could
-- not rewrite either, and taken the whole migration down with it.
--
-- Dropped and added again so a second run leaves the rule exactly as written
-- here, and validated only when every deal passes — 0049's own shape, and its
-- own reason: a code like "US$" is a person's to fix, not this migration's to
-- guess at. Either way a code written from here on is checked, and so is any
-- later change to a deal still holding an old one, which must fix it in the
-- same change.

alter table public.crm_deals drop constraint if exists crm_deals_currency_check;
alter table public.crm_deals add constraint crm_deals_currency_check
  check (currency ~ '^[A-Z]{3}$') not valid;

do $$
declare v_outside int;
begin
  select count(*) into v_outside from public.crm_deals where currency !~ '^[A-Z]{3}$';
  if v_outside = 0 then
    alter table public.crm_deals validate constraint crm_deals_currency_check;
  else
    raise notice '0067: % deals carry a currency that is not three capital letters, inherited from a '
                 'company 0049 could not rewrite either, so crm_deals_currency_check stays NOT VALID. '
                 'New codes are checked, and a change to one of these deals must fix its code. Fix the '
                 'companies (0049''s header says how) and their deals, then: '
                 'alter table public.crm_deals validate constraint crm_deals_currency_check;', v_outside;
  end if;
end
$$;

-- ── 6. Merging two companies knows about deals ───────────────────────────
-- 0053's own VALUES list, entire, with ONE row added: crm_deals.company_id,
-- repointed in step 1 with every other plain reference to a company. 0053 is
-- the only migration that defines this function; this body was read from it
-- rather than written again from memory, because a create-or-replace built
-- from an older copy silently drops whatever the newer one added.
--
-- Step 1, not 2: step 2 exists for finance_invoices, whose BEFORE trigger
-- (0051) has to read a contact already moved by step 1. crm_deals has no
-- trigger that reads another table, so it moves with the rest.
--
-- 'repoint' and not 'history': a deal belongs to the company that has the
-- work, so merging Northline GmbH into Northline moves its deals across
-- whole. There is no unique index on (company_id, title), so two companies
-- each holding a deal of the same name merge into one company holding both,
-- rather than the merge failing on a collision.

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
    ('crm_companies', 'crm_deals',        'company_id',        'repoint',      1),   -- 0067
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
  'merge_contacts() treat it (0053; crm_deals.company_id added by 0067). A new one must '
  'be listed here.';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
  v_count   int;
begin
  if to_regclass('public.crm_deals') is null then
    raise exception '0067: public.crm_deals is missing';
  end if;

  select string_agg(col, ', ') into v_missing
  from unnest(array['id', 'company_id', 'title', 'stage', 'value', 'currency', 'owner_id',
                    'expected_close', 'outcome', 'closed_at', 'notes',
                    'created_at', 'updated_at', 'deleted_at']) as col
  where not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'crm_deals'
                      and column_name = col);
  if v_missing is not null then
    raise exception '0067: crm_deals is missing %', v_missing;
  end if;

  -- The four rules the table promises about a deal's shape.
  select count(*) into v_count
  from pg_constraint
  where conrelid = 'public.crm_deals'::regclass
    and conname in ('crm_deals_title_check', 'crm_deals_closed_check',
                    'crm_deals_value_check', 'crm_deals_currency_check');
  if v_count <> 4 then
    raise exception '0067: crm_deals carries % of its 4 checks', v_count;
  end if;

  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.crm_deals'::regclass
                   and tgname = 'crm_deals_touch_updated_at' and not tgisinternal) then
    raise exception '0067: nothing moves crm_deals.updated_at when a deal changes';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.crm_deals'::regclass
                   and tgname = 'guard_soft_delete' and not tgisinternal) then
    raise exception '0067: anyone can remove a deal, not only a manager';
  end if;

  -- RLS, and the restrictive policy 0040 cannot add to a table it never saw.
  if not exists (select 1 from pg_class where oid = 'public.crm_deals'::regclass and relrowsecurity) then
    raise exception '0067: crm_deals has no row level security';
  end if;
  select string_agg(want, ', ') into v_missing
  from unnest(array['staff read crm_deals', 'staff creates crm_deals', 'staff updates crm_deals',
                    'manager deletes crm_deals', 'second factor required']) as want
  where not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'crm_deals' and policyname = want);
  if v_missing is not null then
    raise exception '0067: crm_deals is missing the policies: %', v_missing;
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'crm_deals'
                   and policyname = 'second factor required'
                   and permissive = 'RESTRICTIVE' and cmd = 'ALL'
                   and qual like '%second_factor_met()%' and with_check like '%second_factor_met()%') then
    raise exception '0067: crm_deals'' second factor policy is not restrictive on both sides';
  end if;

  -- The backfill: every live company has a deal, and no company has two from
  -- it. A studio that has since added a second deal by hand is fine — this
  -- asks that none is MISSING, not that none was added.
  if exists (select 1 from public.crm_companies c
             where c.deleted_at is null
               and not exists (select 1 from public.crm_deals d where d.company_id = c.id)) then
    raise exception '0067: a live company has no deal — the backfill did not reach it';
  end if;
  if exists (select 1 from public.crm_deals
             where (outcome is null) <> (closed_at is null)) then
    raise exception '0067: a deal is closed without a date, or dated without an outcome';
  end if;

  -- §6: the merge knows about deals, and 0053's own rule — every foreign key
  -- to a CRM table is one the merges handle — still holds with this one added.
  if not exists (select 1 from public.crm_merge_references() m
                 where m.target_table = 'crm_companies' and m.table_name = 'crm_deals'
                   and m.column_name = 'company_id' and m.handling = 'repoint' and m.step = 1) then
    raise exception '0067: crm_merge_references() does not repoint crm_deals.company_id, so every company merge now fails';
  end if;
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
    raise exception '0067: no merge handles these foreign keys to the CRM: %. List them in crm_merge_references().',
      v_missing;
  end if;

  -- 0053's other two rules about that list, restated because this migration
  -- rewrote it: nothing is listed twice, and every entry is one a merge knows.
  if exists (select 1 from public.crm_merge_references() m
             where m.handling not in ('repoint', 'project link', 'history')
                or (m.handling = 'repoint') <> (m.step is not null)) then
    raise exception '0067: crm_merge_references() lists a reference no merge knows how to treat';
  end if;
  if exists (select 1 from public.crm_merge_references() m
             group by m.target_table, m.table_name, m.column_name
             having count(*) > 1) then
    raise exception '0067: crm_merge_references() lists a reference twice';
  end if;

  -- The old columns are still here: other code reads them, and this migration
  -- promised in its header not to drop them.
  select string_agg(col, ', ') into v_missing
  from unnest(array['stage', 'value', 'currency']) as col
  where not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'crm_companies'
                      and column_name = col);
  if v_missing is not null then
    raise exception '0067: crm_companies lost %, which other code still reads — 0067 must not drop them', v_missing;
  end if;
end
$$;
