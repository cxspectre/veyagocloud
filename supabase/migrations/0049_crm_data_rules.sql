-- 0049_crm_data_rules.sql — CRM data cannot take the workspace down, and
-- promoting an enquiry neither puts strangers into one company nor leaves
-- behind a company nobody is in.
--
-- Found in review (2026-09-14):
--
--   * crm_companies.currency took any text (0021). The workspace shows each
--     contact's company value in that currency, and a single value in a code
--     it cannot format, like "US$" or "Euro", made loading the contacts fail.
--     A company's currency is now three capital letters, the rule
--     project_budgets.currency has had since 0039.
--   * promote_enquiry_to_crm() files a person under the company their
--     address's domain belongs to, unless the address is a public mailbox. Only
--     ten domains counted as public, so two strangers writing from gmx.de,
--     web.de, aol.com or pm.me were put into one shared company. The list now
--     covers the mailboxes common where the site is read — it is in English,
--     Dutch and German.
--   * It also found or made that company before it looked for a contact
--     already on the address, and that contact kept the company they had. So
--     promoting someone already at a company could leave behind a company
--     nobody is in — at a public mailbox, one more for each further enquiry of
--     theirs, since no domain leads back to the one before. It now looks for
--     the contact first. One who is at a company gains the trail back to the
--     enquiry, if they have none yet, and nothing is made; a company is found
--     or made only for a contact without one, or for someone new. The
--     function is otherwise as 0021 left it.
--
-- A code that is three capital letters but for its case or the spaces around
-- it, like " usd " or "eur", is written as those letters. The only triggers on
-- companies (0021) stamp updated_at and guard deleted_at; none writes to the
-- activity feed or notifies anyone. A company stored under any other code,
-- like "US$", keeps it. The rule is added NOT VALID and validated only when
-- every stored company follows it; otherwise this says how many do not and
-- leaves it NOT VALID. New codes are checked either way, and so is any later
-- change to a company still holding an old code, which must fix the code in
-- the same change. To find those companies, and once they are fixed, to
-- finish the job:
--
--   select id, name, currency from public.crm_companies where currency !~ '^[A-Z]{3}$';
--   alter table public.crm_companies validate constraint crm_companies_currency_check;
--
-- Contacts an earlier promotion already put into a shared company stay there,
-- as does any company an earlier promotion left that nobody is in: which of
-- them belongs where, and what goes, is for a person to decide.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. A currency the workspace can show ─────────────────────────────────
-- Dropped and added again, so a second run leaves the rule as written here.
-- Codes are rewritten once the rule is in place, so none in lower case can be
-- stored in between; a second run finds none left to rewrite.

alter table public.crm_companies drop constraint if exists crm_companies_currency_check;
alter table public.crm_companies
  add constraint crm_companies_currency_check check (currency ~ '^[A-Z]{3}$') not valid;

do $$
declare
  v_written int;
  v_outside int;
begin
  -- " usd " and "eur" mean USD and EUR.
  update public.crm_companies
  set currency = upper(btrim(currency))
  where currency !~ '^[A-Z]{3}$'
    and upper(btrim(currency)) ~ '^[A-Z]{3}$';
  get diagnostics v_written = row_count;

  if v_written > 0 then
    raise notice '0049: % companies had a currency in lower case or with spaces around it, '
                 'now written as three capital letters.', v_written;
  end if;

  select count(*) into v_outside
  from public.crm_companies
  where currency !~ '^[A-Z]{3}$';

  if v_outside = 0 then
    alter table public.crm_companies validate constraint crm_companies_currency_check;
  else
    raise notice '0049: % companies have a currency that is not three capital letters, so '
                 'crm_companies_currency_check stays NOT VALID. New codes are checked, and a change '
                 'to one of these companies must fix its code. Fix them, then validate the constraint.',
                 v_outside;
  end if;
end
$$;

-- ── 2. A public mailbox is nobody's company ──────────────────────────────
-- promote_enquiry_to_crm() as 0021 left it, but for the list of public
-- mailboxes, and for looking for a contact already on the address before any
-- company is found or made. Its grants stay as 0021 set them, restated here.

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

  -- An existing contact on that address keeps its row and gains the trail
  -- back. Looked for before any company is found or made (0049). There is one
  -- live contact per address (crm_contacts_email_idx); should that change, the
  -- earliest is the one.
  select id, company_id into v_contact, v_company
  from public.crm_contacts
  where lower(email) = lower(e.email) and deleted_at is null
  order by created_at, id
  limit 1;

  -- One already at a company stays there, and nothing is made.
  if v_company is not null then
    update public.crm_contacts
    set enquiry_id = coalesce(enquiry_id, p_enquiry_id)
    where id = v_contact;
    return v_contact;
  end if;

  -- The email domain identifies the company, unless it is a public mailbox —
  -- matching on gmail.com would merge every unrelated sole trader into one.
  -- Public: the webmail people use anywhere, and the providers common where
  -- the site is read (0049).
  v_domain := lower(nullif(split_part(e.email, '@', 2), ''));
  if v_domain in (
       -- Webmail, wherever someone writes from
       'gmail.com', 'googlemail.com',
       'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.co.uk', 'hotmail.de', 'hotmail.nl', 'hotmail.be',
       'live.com', 'live.co.uk', 'live.de', 'live.nl', 'live.be', 'live.at', 'msn.com', 'windowslive.com',
       'yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'ymail.com', 'rocketmail.com',
       'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
       'aol.com', 'aol.co.uk', 'aol.de', 'aim.com',
       'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
       'tutanota.com', 'tutanota.de', 'tutamail.com', 'tuta.io', 'tuta.com', 'keemail.me',
       'gmx.com', 'mail.com', 'zohomail.com', 'zohomail.eu', 'yandex.com', 'yandex.ru', 'mail.ru',
       'fastmail.com', 'fastmail.fm', 'hey.com', 'hushmail.com', 'mailfence.com', 'duck.com',
       -- Germany, Austria and Switzerland
       'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'magenta.de', 'freenet.de',
       'arcor.de', 'mail.de', 'online.de', 'posteo.de', 'posteo.net', 'mailbox.org',
       'aon.at', 'chello.at', 'bluewin.ch',
       -- The Netherlands and Belgium
       'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'hetnet.nl', 'xs4all.nl',
       'upcmail.nl', 'chello.nl', 'casema.nl', 'telenet.be', 'skynet.be',
       -- The UK and the US
       'btinternet.com', 'sky.com', 'virginmedia.com', 'ntlworld.com', 'blueyonder.co.uk', 'talktalk.net',
       'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'cox.net', 'charter.net',
       'bellsouth.net', 'earthlink.net'
     ) then
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

  -- The contact without a company is filed under this one.
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

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.crm_companies'::regclass
                   and conname = 'crm_companies_currency_check'
                   and pg_get_constraintdef(oid) like '%^[A-Z]{3}$%') then
    raise exception '0049: a company''s currency can still be any text';
  end if;
  if exists (select 1 from public.crm_companies
             where currency !~ '^[A-Z]{3}$' and upper(btrim(currency)) ~ '^[A-Z]{3}$') then
    raise exception '0049: a company still has its currency in lower case or with spaces around it';
  end if;
  if pg_get_functiondef('public.promote_enquiry_to_crm(uuid)'::regprocedure) not like '%''gmx.de''%' then
    raise exception '0049: promote_enquiry_to_crm() still puts strangers at gmx.de into one company';
  end if;
  if has_function_privilege('anon', 'public.promote_enquiry_to_crm(uuid)', 'execute') then
    raise exception '0049: anon can promote an enquiry';
  end if;
end
$$;
