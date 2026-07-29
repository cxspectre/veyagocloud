-- 0014 — a place to actually send an invoice, and a kind to log it under.
--
-- finance_invoices tracked a client NAME but no address, so the new guided
-- create-flow (client -> preview the PDF -> send it) had nowhere to send to.
-- RLS is already "manager all" on this table (0005), so no policy change is
-- needed here — just the column.

alter table public.finance_invoices add column if not exists client_email text;

-- email_log.kind is a CHECK constraint, not a free text column (0010), and it
-- did not list 'invoice'. Without this the send would succeed and then the log
-- insert would throw 23514 — the email out the door, the record of it refused.
--
-- 0010 declared the check INLINE, so its name was assigned by Postgres rather
-- than written down. `email_log_kind_check` is the conventional result and is
-- almost certainly right, but dropping the wrong name here would be a silent
-- no-op that leaves the OLD constraint in force alongside the new one — both
-- would apply, 'invoice' would still be rejected, and the migration would look
-- like it had worked. So find whatever CHECK actually constrains `kind` and
-- drop that, rather than trusting the convention.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'email_log'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.email_log drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_log add constraint email_log_kind_check
  check (kind in ('invite', 'password_reset', 'task_assigned', 'digest', 'invoice'));
