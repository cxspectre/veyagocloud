-- 0051_invoice_links.sql — an invoice knows its client's company, and the
-- project it bills.
--
-- An invoice carried only its client's name (0005), so the workspace could
-- match an invoice to a company only by that name, and could not tie one to a
-- project at all. It now has company_id and project_id, both optional:
--
--   * A project brings its company. An invoice filed under a project, with no
--     company named, takes the project's; one naming a company other than its
--     project's is refused.
--   * With no company, the client's name links one: the company whose name is
--     the same but for case and the spaces around it, when exactly one live
--     company has that name, and the invoice's project has no company of its
--     own for the name to contradict. Two of a name, or only a deleted one,
--     link none — a guess would put the money on the wrong client.
--   * An update is held to what it changes: a project filed or a company named
--     beside a project is checked, and the client of an invoice with no company
--     is linked by its new name. It is refused only when the write is what
--     makes an invoice and its project disagree. So an invoice whose project
--     later moves to another company can still be marked paid, and can still
--     be given another company — merge_companies (0053) moves a merged
--     company's invoices so — though not be filed under another company's
--     project; a company taken off an invoice stays off; and a company or
--     project deleted outright leaves its invoices unlinked rather than
--     pointing at a row that is gone.
--
-- The project is a client_projects row. public.projects is the marketing
-- site's research projects (0002), which have no company (see 0021, 0022).
--
-- Stored invoices are linked by their client's name, by the same rule and by
-- nothing else. The backfill writes company_id alone, which no activity trigger
-- watches — 0027 logs an invoice only when an update of its status makes it
-- paid — so the activity feed hears nothing of it.
--
-- Who reads and writes invoices stays as 0005 and 0040 left it: managers, with
-- their second factor. No policy changes; the new columns are the managers'
-- to write like every other.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

-- ── 1. The links ─────────────────────────────────────────────────────────

alter table public.finance_invoices add column if not exists company_id uuid;
alter table public.finance_invoices add column if not exists project_id uuid;

-- Named, and added only when missing, so a second run adds no second key.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.finance_invoices'::regclass
                   and conname = 'finance_invoices_company_id_fkey') then
    alter table public.finance_invoices
      add constraint finance_invoices_company_id_fkey
      foreign key (company_id) references public.crm_companies(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.finance_invoices'::regclass
                   and conname = 'finance_invoices_project_id_fkey') then
    alter table public.finance_invoices
      add constraint finance_invoices_project_id_fkey
      foreign key (project_id) references public.client_projects(id) on delete set null;
  end if;
end
$$;

create index if not exists finance_invoices_company_idx
  on public.finance_invoices (company_id)
  where company_id is not null;

create index if not exists finance_invoices_project_idx
  on public.finance_invoices (project_id)
  where project_id is not null;

comment on column public.finance_invoices.company_id is
  'The client''s company: its project''s, or the one live company named like the client (0051).';
comment on column public.finance_invoices.project_id is
  'The client project the invoice bills — client_projects, not the site''s projects (0051).';

-- ── 2. The company a client's name links ─────────────────────────────────
-- The one live company whose name is the client's but for case and the spaces
-- around it; null when none has it, or more than one. The trigger and the
-- backfill both link through this, so they link by one rule.

create or replace function public.invoice_client_company(p_client text)
returns uuid
language sql
stable
set search_path = public
as $$
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from public.crm_companies c
  where c.deleted_at is null
    and btrim(p_client) <> ''
    and lower(btrim(c.name)) = lower(btrim(p_client));
$$;

comment on function public.invoice_client_company(text) is
  'The one live company named like an invoice''s client, but for case and surrounding spaces; '
  'null for none or several (0051).';

-- ── 3. Linking an invoice as it is written ───────────────────────────────
-- security definer, so the links do not depend on what the writer can read.
-- It reads only for those who may read companies and projects anyway: staff,
-- and the service role and the database itself, which have no auth.uid().
-- Anyone else is refused the write by RLS straight after this trigger, and
-- is told nothing about a project first.

create or replace function public.link_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_changed boolean;
  v_company_changed boolean;
  v_client_changed  boolean;
  v_old_company     uuid;
  v_project_company uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'anon'
     or (auth.uid() is not null and not public.is_staff()) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_project_changed := true;
    v_company_changed := true;
    v_client_changed  := true;
  else
    v_project_changed := new.project_id is distinct from old.project_id;
    v_company_changed := new.company_id is distinct from old.company_id;
    v_client_changed  := new.client is distinct from old.client;
    v_old_company     := old.company_id;
  end if;

  if new.project_id is not null and (v_project_changed or v_company_changed or v_client_changed) then
    select p.company_id into v_project_company
    from public.client_projects p
    where p.id = new.project_id;
  end if;

  -- A project filed with no company brings its own; a company named beside a
  -- project, or a project filed beside a company, must be the project's —
  -- unless the write is not what makes them disagree. An invoice that already
  -- named another company than its project's, because the project moved since,
  -- may change company, as merge_companies (0053) moves a merged company's
  -- invoices; filed under another project, it is checked like any other.
  if new.company_id is null then
    if v_project_changed then
      new.company_id := v_project_company;
    end if;
  elsif (v_project_changed or v_company_changed)
        and v_project_company is not null
        and v_project_company <> new.company_id
        and not (not v_project_changed
                 and v_old_company is not null
                 and v_old_company <> v_project_company) then
    raise exception 'That project belongs to a different company than the invoice';
  end if;

  -- Still no company, and a client that is new: its name links one — unless
  -- the project has a company, which a name must not contradict.
  if new.company_id is null and v_client_changed and v_project_company is null then
    new.company_id := public.invoice_client_company(new.client);
  end if;

  return new;
end;
$$;

drop trigger if exists link_invoice on public.finance_invoices;
create trigger link_invoice
  before insert or update of client, company_id, project_id on public.finance_invoices
  for each row execute function public.link_invoice();

-- ── 4. Invoices stored before now ────────────────────────────────────────
-- Linked by their client's name, by the rule above and nothing else — never
-- from a project, and never an invoice whose project has a company, which a
-- name must not contradict. A function, so supabase/tests/16-invoice-links.sql
-- runs what this migration ran, and the table owner can run it again once the
-- CRM holds companies older invoices name. Run again, it links any invoice
-- that has no company by then, a company taken off by hand included.

create or replace function public.link_invoices_by_client()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_linked integer;
begin
  update public.finance_invoices i
  set company_id = m.company_id
  from (select f.id, public.invoice_client_company(f.client) as company_id
        from public.finance_invoices f
        left join public.client_projects p on p.id = f.project_id
        where f.company_id is null
          and p.company_id is null) m
  where i.id = m.id
    and i.company_id is null
    and m.company_id is not null;
  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

comment on function public.link_invoices_by_client() is
  'Links every invoice with no company, and no project company, to the one live company named '
  'like its client; writes nothing else. Run by 0051; the table owner may run it again (0051).';

-- Only the trigger and the table owner call these.
revoke all on function public.invoice_client_company(text), public.link_invoice(),
  public.link_invoices_by_client()
  from public, anon, authenticated, service_role;

do $$
declare
  v_linked integer;
begin
  v_linked := public.link_invoices_by_client();
  raise notice '0051: % stored invoices linked to the company their client names', v_linked;
end
$$;

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
begin
  if not exists (select 1
                 from pg_constraint k
                 join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                 where k.conrelid = 'public.finance_invoices'::regclass
                   and k.contype = 'f'
                   and a.attname = 'company_id'
                   and k.confrelid = 'public.crm_companies'::regclass
                   and k.confdeltype = 'n') then
    raise exception '0051: finance_invoices.company_id is not a key to crm_companies, cleared when the company is deleted';
  end if;

  if not exists (select 1
                 from pg_constraint k
                 join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                 where k.conrelid = 'public.finance_invoices'::regclass
                   and k.contype = 'f'
                   and a.attname = 'project_id'
                   and k.confrelid = 'public.client_projects'::regclass
                   and k.confdeltype = 'n') then
    raise exception '0051: finance_invoices.project_id is not a key to client_projects, cleared when the project is deleted';
  end if;

  select string_agg(col, ', ') into v_missing
  from unnest(array['company_id', 'project_id']) as col
  where not exists (select 1
                    from pg_index x
                    join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
                    where x.indrelid = 'public.finance_invoices'::regclass
                      and a.attname = col);
  if v_missing is not null then
    raise exception '0051: nothing indexes finance_invoices.%', v_missing;
  end if;

  if not exists (select 1
                 from pg_trigger t
                 where t.tgrelid = 'public.finance_invoices'::regclass
                   and t.tgname = 'link_invoice'
                   and not t.tgisinternal
                   and t.tgenabled = 'O'
                   and pg_get_triggerdef(t.oid) like
                       '% BEFORE INSERT OR UPDATE OF client, company_id, project_id ON public.finance_invoices FOR EACH ROW %link_invoice()') then
    raise exception '0051: nothing links an invoice as it is written';
  end if;

  if pg_get_functiondef('public.link_invoice()'::regprocedure) not like '%v_old_company <> v_project_company%' then
    raise exception '0051: link_invoice() refuses another company for an invoice whose project has already moved to another company';
  end if;

  if has_function_privilege('anon', 'public.invoice_client_company(text)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_client_company(text)', 'execute')
     or has_function_privilege('anon', 'public.link_invoice()', 'execute')
     or has_function_privilege('authenticated', 'public.link_invoice()', 'execute')
     or has_function_privilege('anon', 'public.link_invoices_by_client()', 'execute')
     or has_function_privilege('authenticated', 'public.link_invoices_by_client()', 'execute') then
    raise exception '0051: a signed-in or anonymous caller can call the invoice linking functions';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'finance_invoices'
                   and policyname = 'manager all finance invoices' and permissive = 'PERMISSIVE')
     or not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'finance_invoices'
                      and policyname = 'second factor required' and permissive = 'RESTRICTIVE') then
    raise exception '0051: finance_invoices no longer has the policies 0005 and 0040 gave it';
  end if;

  select string_agg(i.number, ', ' order by i.number) into v_missing
  from public.finance_invoices i
  left join public.client_projects p on p.id = i.project_id
  where i.company_id is null
    and p.company_id is null
    and public.invoice_client_company(i.client) is not null;
  if v_missing is not null then
    raise exception '0051: invoices % are not linked to the company their client names', v_missing;
  end if;
end
$$;
