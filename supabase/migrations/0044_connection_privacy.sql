-- 0044_connection_privacy.sql — a colleague's mailbox connection is theirs.
--
-- "staff read integration_connections" (0024) lets every member of staff read
-- every connection: a colleague's personal mailbox address, whether it works,
-- and its last error, which can quote what the sync was doing. The workspace
-- filtered those rows out in its own query; the database did not.
--
-- 0038 already limited what owners and admins may change or remove to the
-- studio's connections and their own. Reading now follows the same line, for
-- everyone: the studio's connections, and your own.
--
-- integration_status is security_invoker, so it follows. The Edge Functions read
-- connections with the service role and are unaffected; can_read_connection()
-- is SECURITY DEFINER and answers as before.

-- A migration that cannot get its locks within 5 seconds gives up and rolls
-- back, rather than queue behind — and stall — the live workspace.
set lock_timeout = '5s';

drop policy if exists "staff read integration_connections" on public.integration_connections;

drop policy if exists "staff read studio or own integration_connections" on public.integration_connections;
create policy "staff read studio or own integration_connections"
  on public.integration_connections for select to authenticated
  using (
    (select public.is_staff())
    and (employee_id is null or employee_id = (select public.active_employee_id()))
  );

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'integration_connections'
               and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
               and policyname <> 'staff read studio or own integration_connections') then
    raise exception '0044: another policy still lets people read every connection';
  end if;
end
$$;
