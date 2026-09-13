-- =============================================================================
-- 0021 — Workspace CRM: the companies and people behind the work.
--
-- The workspace app (a separate static front end, same anon-key + RLS model as
-- /admin) has a CRM view that until now ran on sample data. This migration
-- gives it a real home, and gives /websites/ enquiries somewhere to graduate to.
--
-- WHY A NEW TABLE RATHER THAN REUSING public.projects OR public.website_enquiries:
--   * public.projects is the MARKETING site's research projects (slug, essay,
--     published) — a different thing that happens to share a word. 0022 adds
--     client_projects for the studio's actual client work.
--   * website_enquiries is an append-only capture log: one row per submission,
--     written by an anon RPC. A lead that becomes a client needs to be edited,
--     re-assigned and kept — that is a different lifecycle, so it gets its own
--     row here and keeps a pointer back to where it came from.
--
-- Permissions: staff read and write, managers delete. Matches the split 0012
-- established for content — the two-person studio both maintain the CRM, but
-- removing a record is a manager decision.
--
-- Idempotent. Adds only; touches no existing row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Companies. The client, prospect or partner. `domain` is what lets inbound
-- mail and enquiries be matched to an existing relationship automatically
-- (0024 uses it), so it is stored lowercased and bare — "northline.example",
-- not "https://www.northline.example/".
-- ---------------------------------------------------------------------------
create table if not exists public.crm_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text,
  kind        text not null default 'prospect'
                check (kind in ('prospect','client','partner','internal')),
  stage       text not null default 'lead'
                check (stage in ('lead','qualified','proposal','client','dormant','lost')),
  value       numeric(12,2),                      -- open or annual value, studio's estimate
  currency    text not null default 'USD',
  owner_id    uuid references public.employees(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- One company per domain, but only among the live rows: a deleted record must
-- not block re-adding the client later.
create unique index if not exists crm_companies_domain_idx
  on public.crm_companies (lower(domain)) where domain is not null and deleted_at is null;
create index if not exists crm_companies_live_idx
  on public.crm_companies (stage, name) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Contacts. A person, optionally at a company. `enquiry_id` keeps the trail
-- back to the /websites/ form submission that introduced them.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.crm_companies(id) on delete set null,
  full_name   text not null,
  email       text,
  phone       text,
  title       text,
  is_primary  boolean not null default false,
  enquiry_id  uuid references public.website_enquiries(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create unique index if not exists crm_contacts_email_idx
  on public.crm_contacts (lower(email)) where email is not null and deleted_at is null;
create index if not exists crm_contacts_company_idx
  on public.crm_contacts (company_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- updated_at + the same soft-delete guard 0012 put on content: only a manager
-- may set or clear deleted_at. Named to sort before the touch trigger, since
-- two BEFORE UPDATE triggers fire in alphabetical order.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['crm_companies','crm_contacts'] loop
    execute format('drop trigger if exists %I_touch_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_touch_updated_at before update on public.%I '
      'for each row execute function public.touch_updated_at()', t, t);

    execute format('drop trigger if exists guard_soft_delete on public.%I', t);
    execute format(
      'create trigger guard_soft_delete before update on public.%I '
      'for each row execute function public.guard_soft_delete()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS. Private tables: no anonymous access at all, like employees and finance.
-- ---------------------------------------------------------------------------
alter table public.crm_companies enable row level security;
alter table public.crm_contacts  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['crm_companies','crm_contacts'] loop
    execute format('drop policy if exists "staff read %s" on public.%I', t, t);
    execute format(
      'create policy "staff read %s" on public.%I for select using (public.is_staff())', t, t);

    execute format('drop policy if exists "staff creates %s" on public.%I', t, t);
    execute format(
      'create policy "staff creates %s" on public.%I for insert with check (public.is_staff())', t, t);

    execute format('drop policy if exists "staff updates %s" on public.%I', t, t);
    execute format(
      'create policy "staff updates %s" on public.%I for update '
      'using (public.is_staff()) with check (public.is_staff())', t, t);

    -- Hard delete stays with managers; everyday removal is deleted_at, which
    -- the guard trigger already restricts to managers.
    execute format('drop policy if exists "manager deletes %s" on public.%I', t, t);
    execute format(
      'create policy "manager deletes %s" on public.%I for delete using (public.is_manager())', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Graduating an enquiry into the CRM.
--
-- Re-runnable by design: called twice on the same enquiry it returns the same
-- contact rather than a duplicate, because a manager clicking twice is a much
-- likelier event than a genuine second person on the same address.
--
-- SECURITY DEFINER so it can read website_enquiries (manager-only) and write
-- the CRM in one step, with an explicit is_staff() gate of its own — a definer
-- function without one is a hole straight through RLS.
-- ---------------------------------------------------------------------------
create or replace function public.promote_enquiry_to_crm(p_enquiry_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e          public.website_enquiries%rowtype;
  v_domain   text;
  v_company  uuid;
  v_contact  uuid;
begin
  if not public.is_staff() then
    raise exception 'Only staff can promote an enquiry';
  end if;

  select * into e from public.website_enquiries where id = p_enquiry_id;
  if not found then
    raise exception 'No enquiry %', p_enquiry_id;
  end if;

  -- Already promoted: hand back the contact we made last time.
  select id into v_contact
  from public.crm_contacts
  where enquiry_id = p_enquiry_id and deleted_at is null
  limit 1;
  if v_contact is not null then
    return v_contact;
  end if;

  -- The email domain identifies the company, unless it is a public mailbox —
  -- matching on gmail.com would merge every unrelated sole trader into one.
  v_domain := lower(nullif(split_part(e.email, '@', 2), ''));
  if v_domain in ('gmail.com','googlemail.com','outlook.com','hotmail.com',
                  'live.com','yahoo.com','icloud.com','me.com','proton.me','protonmail.com') then
    v_domain := null;
  end if;

  if v_domain is not null then
    select id into v_company
    from public.crm_companies
    where lower(domain) = v_domain and deleted_at is null
    limit 1;
  end if;

  if v_company is null then
    insert into public.crm_companies (name, domain, kind, stage, notes)
    values (coalesce(nullif(e.business, ''), nullif(v_domain, ''), e.name),
            v_domain, 'prospect', 'lead',
            nullif(e.message, ''))
    returning id into v_company;
  end if;

  -- An existing contact on that address keeps its row and gains the trail back.
  select id into v_contact
  from public.crm_contacts
  where lower(email) = lower(e.email) and deleted_at is null
  limit 1;

  if v_contact is not null then
    update public.crm_contacts
    set enquiry_id = coalesce(enquiry_id, p_enquiry_id),
        company_id = coalesce(company_id, v_company)
    where id = v_contact;
    return v_contact;
  end if;

  insert into public.crm_contacts (company_id, full_name, email, enquiry_id, notes)
  values (v_company, e.name, e.email, p_enquiry_id, nullif(e.message, ''))
  returning id into v_contact;

  return v_contact;
end;
$$;

revoke all on function public.promote_enquiry_to_crm(uuid) from public, anon;
grant execute on function public.promote_enquiry_to_crm(uuid) to authenticated;

comment on table public.crm_companies is
  'Workspace CRM: the client, prospect or partner. Distinct from public.projects, '
  'which is the marketing site''s research projects.';
comment on table public.crm_contacts is
  'Workspace CRM: a person, optionally at a company. enquiry_id keeps the trail '
  'back to the /websites/ submission that introduced them.';
