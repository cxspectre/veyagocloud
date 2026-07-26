-- =============================================================================
-- Veyago — build_runs: the audit log for "Publish site".
--
-- Run ONCE in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Safe to re-run.
--
-- Publishing used to be a founder-only command on a laptop: a broken build
-- failed locally and never reached production. Now the dashboard can trigger it
-- (supabase/functions/deploy → GitHub repository_dispatch 'publish-site'), so
-- every attempt needs a durable record — who asked, when, what happened, and
-- which commit the Action pushed.
--
-- One row per attempt. The Edge Function inserts it as 'queued'; the GitHub
-- Action moves it to 'running', then 'success' (with commit_sha) or 'failed'
-- (with error). Nothing about this table decides whether a build is safe — the
-- Action verifies the build before committing. This is the paper trail.
--
-- After running this, deploy the function and set its secrets:
--   supabase functions deploy deploy
--   supabase secrets set GITHUB_TOKEN=... GITHUB_REPO=owner/repo
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Build runs. triggered_by_email is stored alongside the FK on purpose: the FK
-- goes NULL when an auth user is deleted, and an audit row that can no longer
-- say who caused it is not an audit row.
--
-- ("trigger" is a non-reserved keyword in PostgreSQL, so it is legal as a plain
-- column name here and in the check below.)
-- ---------------------------------------------------------------------------
create table if not exists public.build_runs (
  id                 uuid primary key default gen_random_uuid(),
  triggered_by       uuid references auth.users(id) on delete set null,
  triggered_by_email text,                                     -- survives user deletion
  trigger            text not null default 'manual' check (trigger in ('manual','cron','api')),
  status             text not null default 'queued' check (status in ('queued','running','success','failed')),
  commit_sha         text,                                     -- commit the Action pushed, once it lands
  error              text,                                     -- failure reason, shown verbatim in the dashboard
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);

-- The dashboard only ever asks for "the most recent runs".
create index if not exists build_runs_started_idx on public.build_runs (started_at desc);

alter table public.build_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Staff may read the history — the assistant needs to see whether their publish
-- succeeded, and the failure reason when it did not.
--
-- There is deliberately NO insert/update/delete policy on this table. With RLS
-- enabled and no write policy, the anon and authenticated roles (i.e. every
-- browser client, including managers) are denied all writes. Only the service
-- role, which bypasses RLS, can write here: the deploy Edge Function creates the
-- row, and the GitHub Action updates it. That is what makes the log trustworthy
-- — nobody can forge a "success", backdate a run, or erase a failed publish
-- from the dashboard. Do not add a write policy to make an admin screen easier.
-- ---------------------------------------------------------------------------
drop policy if exists "staff read build runs" on public.build_runs;
create policy "staff read build runs"
  on public.build_runs for select
  using (public.is_staff());
