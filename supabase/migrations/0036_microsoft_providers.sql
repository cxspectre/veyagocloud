-- =============================================================================
-- 0036 — Microsoft, not Google.
--
-- 0024 listed google_mail / google_calendar because the workspace prototype's
-- sample events said "Google Meet". That was placeholder text in a mockup, not
-- a fact about the studio: Veyago runs on Microsoft 365. The Google path is
-- removed rather than left deployed — four unused public endpoints are a
-- maintenance liability, and an integration nobody uses still has to be
-- reasoned about every time someone reads the schema.
--
-- Everything else stands. integration_connections, integration_secrets,
-- mail_threads, mail_messages, calendar_events and route_mail_to_ticket() were
-- never provider-specific; only the endpoints, the scopes and the message
-- shape were, and those live in Edge Functions.
-- =============================================================================

alter table public.integration_connections
  drop constraint if exists integration_connections_provider_check;

alter table public.integration_connections
  add constraint integration_connections_provider_check
  check (provider in ('microsoft_mail','microsoft_calendar','imap','caldav',
                      'ics','mercury','stripe'));

-- Nothing to migrate: no connection was ever made against the Google values.
do $$
declare n int;
begin
  select count(*) into n from public.integration_connections
  where provider like 'google%';
  if n > 0 then
    raise exception 'Refusing to drop the google providers: % connection(s) still use them', n;
  end if;
end $$;

comment on table public.integration_connections is
  'Per-mailbox / per-account integration metadata. Safe for staff to read; the '
  'tokens live in integration_secrets. Microsoft 365 is the studio''s provider.';
