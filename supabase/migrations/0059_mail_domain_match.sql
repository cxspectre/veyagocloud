-- 0059_mail_domain_match.sql — an inbound message finds its company by
-- domain too, not only by an exact contact address.
--
-- Found in review (2026-09-15):
--
--   * mail_messages_maintain_thread() (0025) files an inbound message's
--     thread under a company only when the sender's own address already
--     belongs to a crm_contacts row. A colleague at a known client who has
--     never written to us before — or a client contact who exists in the
--     CRM but was never filed under their company — left every one of their
--     threads with no company at all, even though crm_companies.domain
--     exists for exactly this (0021's own header: "what lets inbound mail
--     and enquiries be matched to an existing relationship automatically").
--
-- The fix only widens the SAME best-effort, one-way fill 0025 already does:
-- when no contact match names a company, the sender's address's domain is
-- looked up among live companies (lower(domain), the unique index 0021
-- already keeps one live company per domain), and used only to fill a blank
-- thread.company_id — never to write crm_contacts.company_id, and never to
-- overwrite a company a human already put on the thread. That restraint is
-- deliberate: the CRM's own duplicate rules (crm-model.js's companyKey) never
-- pick a company for a person either, only offer one to confirm.
--
-- A company's OWN domain is never a public mailbox (gmail.com and the like):
-- crm-forms.js's readDomain()/isPublicMail() already refuse one at creation
-- or edit, for every path that can give a company a domain, including the
-- one-step create_contact_with_company() (0053), which never sets a company's
-- domain at all. So this does not repeat that list to stay out of the same
-- trap 0021's promote_enquiry_to_crm() and 0049's expanded list guard
-- against — there is nothing here for it to guard against, unless a domain
-- was written some other way than through the workspace. Still only inbound
-- mail is looked at, exactly as before: what we send is not a signal about
-- whose company wrote to us.
--
-- Idempotent: create or replace on the same signature the trigger already
-- points at, so 0025's trigger picks this up without being redefined.

set lock_timeout = '5s';

create or replace function public.mail_messages_maintain_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact uuid;
  v_company uuid;
  v_domain  text;
begin
  if new.direction = 'inbound' and new.from_email is not null then
    select id, company_id into v_contact, v_company
    from public.crm_contacts
    where lower(email) = lower(new.from_email) and deleted_at is null
    limit 1;

    -- No company from the address itself — either nobody in the CRM has it,
    -- or they do but were never filed under a company. Its domain still says
    -- whose company likely wrote in.
    if v_company is null then
      v_domain := lower(nullif(split_part(new.from_email, '@', 2), ''));
      if v_domain is not null then
        select id into v_company
        from public.crm_companies
        where lower(domain) = v_domain and deleted_at is null
        limit 1;
      end if;
    end if;
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

comment on function public.mail_messages_maintain_thread() is
  'Keeps a thread''s counts and its best-effort contact/company links current '
  'on every message inserted. The contact match is by exact address; failing '
  'that, the company match is by the sender''s domain (0059). Both only fill '
  'a blank a human has not already set, and only for inbound mail.';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if pg_get_functiondef('public.mail_messages_maintain_thread()'::regprocedure) not like '%v_domain%' then
    raise exception '0059: mail_messages_maintain_thread() still does not match a company by domain';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.mail_messages'::regclass
      and tgname = 'mail_messages_maintain_thread'
      and tgfoid = 'public.mail_messages_maintain_thread()'::regprocedure
  ) then
    raise exception '0059: the trigger on mail_messages no longer points at this function';
  end if;
end
$$;
