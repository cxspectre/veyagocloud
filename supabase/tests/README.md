# Database tests

Three SQL suites that run against the **live project** inside a transaction and
`ROLLBACK` at the end. Nothing they insert survives, and they read real policies
rather than a local copy — which is the point: RLS bugs are configuration bugs,
and a local re-creation can be green while production is not.

```bash
npm run check:db
```

The runner needs a Supabase **personal access token**. It reads
`SUPABASE_ACCESS_TOKEN`, and on macOS falls back to the one `supabase login`
already stored in the keychain. With neither it skips rather than fails, so CI
without a token stays green.

| Suite | What it proves |
|---|---|
| `01-roles.sql` | anon sees nothing; an employee sees the CRM but no finance, no money in the activity feed, and only the shared mailbox; `integration_secrets` is unreadable by every role that is not the service role |
| `02-write-guards.sql` | an assignee can move their task along but cannot re-file or rename it; soft delete is manager-only; a sent ticket reply cannot be edited; nobody can post as a colleague; resolution timestamps come from the database |
| `03-sync-path.sql` | every `ON CONFLICT` target the Edge Functions use actually exists, re-running a sync updates instead of duplicating, and the mail triggers maintain counts and match senders to the CRM |

Each suite prints one row per check with `PASS` / `FAIL`. The runner exits
non-zero if any row says FAIL.

## Adding a check

Insert into the `results` temp table — `(name, expected, actual, pass)` — and
keep the suite inside its `begin` / `rollback`. A check that needs a
non-manager runs as the inactive assistant, woken for the length of the
transaction only.
