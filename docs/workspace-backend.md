# Veyago Workspace — backend

The workspace is a second front end onto the **same** Supabase project as
`/admin`, not a second database. Same auth, same `employees.role`, same anon
key in the browser with RLS as the only boundary.

Migrations `0021`–`0038`. `0021`–`0038` are all applied to the live project
and verified there — see [Tests](#tests).

**Update, 2026-09-15:** the workspace kept growing past this document —
migrations through `0054` are deployed live (second factor, employee role and
column guards, calendar/mailbox privacy, mail leaving the inbox, agenda and
task write rules, CRM merges and client numbers, invoice links and project
activity), and the function count below is old. This file was not rewritten
to match; the session memory at
`.claude/projects/-Users-cassiandrefke-Developer-Websites-veyago-workspace/memory/workspace-audit.md`
in the workspace repo has the day-by-day detail. Treat everything below this
note as the state as of `0038` unless it says otherwise.

The front end is a separate repo, [`cxspectre/workspaceveyago`][repo], live at
**<https://workspace.veyago.cloud>**. `veyago.cloud/login/` links straight to
it; `veyago.cloud/workspace/` is a permanent redirect for old links.

[repo]: https://github.com/cxspectre/workspaceveyago

---

## What was added

| Area | Tables | Notes |
|---|---|---|
| CRM | `crm_companies`, `crm_contacts` | `promote_enquiry_to_crm()` graduates a `/websites/` enquiry into both |
| Client work | `client_projects`, `tasks.project_id` | **not** `public.projects`, which is the marketing site's research projects. `completed_at` is stamped by the database (0039) |
| Project team | `project_members` | added and removed by the project's owner or an owner/admin; anyone may leave (0039) |
| A project's client people | `project_contacts` | contacts of the project's own company only, each with a role; a project that changes company drops the old company's people (0039) |
| Project files | `project_files`, Storage bucket `project-files` | private, `<project id>/<upload id>/<name>`; a record's size and type are read from storage, not taken from the browser (0039) |
| Project budget | `project_budgets` | moved off `client_projects`, where every employee could read it (0039) |
| Support | `support_tickets`, `ticket_messages` | numbered from 101, rendered `#VYG-142` |
| Mail | `mail_threads`, `mail_messages` | written by the sync, never by the browser — except a thread's `is_read` / `is_starred`, the only columns a person may change (0038) |
| Signatures | `mail_signatures` | one per person per mailbox, private to its owner (0038) |
| Outgoing attachments | Storage bucket `mail-attachments` | private, one folder per auth id, emptied by `send-mail` after sending (0038) |
| Agenda | `calendar_events` | `connection_id null` = entered here; set = synced |
| Integrations | `integration_connections`, `integration_secrets` | metadata vs. tokens, split hard |
| Feed | `workspace_activity` | maintained by triggers, tagged `staff` / `manager` |
| Notes | `workspace_notes` | polymorphic, attached to any record |
| Delivery | `ticket_messages.delivered_at` | a reply that was written is not a reply that was sent |

Two helpers do the aggregate work so a screen is one round trip:

- `workspace_overview(p_tz)` → the four KPI tiles as one `jsonb`, with days and
  months counted in the viewer's time zone (0041).
- `client_project_progress` → a view: each live project with its task counts
  and a computed completion percentage. Progress is **not stored**; a stored
  percentage drifts the moment a task changes underneath it.
- `revenue_series(p_months, p_tz, p_currency)` → a row per month in one
  currency, **including empty ones**, because a gap in a line chart reads as
  missing data rather than as a zero.
- `revenue_mix(p_months, p_tz, p_currency)` → this month's income by category,
  in one currency. Uncategorised income is labelled rather than dropped, so the
  slices always add up to the total.
- `studio_currency()` → the currency the Overview shows money in: the
  `base_currency` workspace setting, else the first active finance account's
  currency, else USD. `revenue_by_currency(today, last_posted)` and
  `overview_window(today)` are the per-currency sums and the "last month up to
  the same day" window behind the tiles (0041).

## Who can see what

`employee_role()` is the single source of truth (migration 0013).

| | anon | `employee` / `assistant` | `owner` / `admin` |
|---|---|---|---|
| CRM, projects, tickets | – | read + write | read + write, and delete |
| Project files | – | projects they own or are a member of | everything |
| Project budgets | – | – | everything |
| Finance | – | – | everything |
| Activity feed | – | `staff` rows only | all rows |
| A studio mailbox | – | read | read |
| A personal mailbox | – | only their own | **only their own** |
| A mail signature | – | only their own | **only their own** |
| A colleague's phone and notes | – | their own phone number only | everything, through `employee_private()` (0043) |
| Roles and status | – | – | everyone's but their own; only an owner makes or changes an owner (0042) |
| `integration_secrets` | – | – | – |

**Staff means staff who entered their code (0040).** For an account with a
verified second factor, a session that has not entered it (`aal1`) is nobody:
`employee_role()` and `active_employee_id()` answer null, so every role check,
staff RPC and Edge Function says "not staff", and every table in `public` with
RLS — plus `storage.objects` — carries a restrictive policy, "second factor
required", that refuses it outright, including the few policies that never ask
for a role. Accounts without a verified factor are unaffected. A new table needs
that policy too: `06-second-factor.sql` fails until it has it. `is_manager()`
answers false, never null, for a session with no role, so a check written `if
not is_manager() then raise` cannot be passed by one — `cleanup_orphan_notes()`
could be, by any signed-in account without an employee row, until 0040. The SQL
editor, which has no `auth.uid()`, still sweeps notes.

**The Overview's figures count the way they read (0041).** `workspace_overview`,
`revenue_series` and `revenue_mix` take the viewer's time zone (`p_tz`, an IANA
name; anything unrecognised is UTC), so "today" and "this month" are the
viewer's. Last month is compared up to the same day of the month, not to its
end. Money is never added across currencies: the figures are in the studio's
currency (`studio_currency()`), named in the answer, with every currency listed
in `revenue_by_currency` and `invoices_outstanding.by_currency` — and an
invoice tile's count, amount and due date all belong to the one currency it
shows. Every new argument has a default, so a caller that passes none gets UTC
and the studio's currency.

**Revenue is money that reached the studio, counted once (0041).** Each
transaction says what it is — `finance_transactions.kind`, written by the sync
that stored it: income, a refund of income, a fee, other spending, a payout
from Stripe to the bank (or Stripe taking a balance back), a transfer between
the studio's own accounts, an adjustment, or bank interest — and the
`finance_figures` view decides from that, never from the sign alone, what each
transaction counts towards (`counts_as`) and by how much (`counted`). Revenue is
money in from clients less what went back; expenses are spending less what came
back. Transfers, adjustments and interest count as neither, and a payment still
pending counts once it has arrived.

A card payment counts once: when Stripe's payout of it arrives in the bank, net
of Stripe's fees and of the refunds the payout left out. Stripe's own rows —
charges, refunds and fees — are the detail behind that payout, and count as
neither. A payout no synced bank account received counts from Stripe's side:
when no posted payout of that amount, the other way, in that currency, reached
a synced account from the day before it to fourteen days after. A deposit the
bank still shows as pending has not arrived, so until it posts Stripe's payout
counts in its place; a Stripe payout still pending counts as neither. So a
month reads the same however long ago Stripe was last synced; counting Stripe's
charges instead was off by up to a month's card income at the edges of what the
Stripe sync had stored. A card payment shows in the month its deposit posted —
a few days after the charge on Stripe's daily schedule, the next month on a
monthly one — or, while no deposit matches its payout, on the day Stripe paid
it out. Four limits: a payout converted into another currency on its way to the
bank counts in both; two payouts of the same amount within those fifteen days —
one to a synced account, one to an account the workspace does not see — count
as one; while a payout is on its way, a deposit of the same amount from the day
before it onwards stands in for it, so a retainer paid out day after day can
read a day or two's payouts short until they land; and a payout that fails or
is cancelled comes back to Stripe as a payout of its own, which counts against
revenue on the day it comes back while the failed payout counted on the day it
was sent — in two different months when a month ends in between — and if the
same amount is paid out again and reaches the bank within fourteen days, that
deposit stands in for the failed payout too, so revenue reads the amount short.

The figures read only the days they show: this month up to the viewer's today,
or UTC's when the syncs have already dated income a day ahead, but never past
the month's last day — on the evening of September 30 in New York, what the
syncs dated October 1 is October's, in the tile, the chart and the mix alike —
and last month up to that same day, which `revenue_prev_through` names. In the
revenue mix, a category that gave back more than it took in is left out, and
each share is of the categories listed, so the shares add up to 100. The
finance policies ask who is looking once a query rather than once a row.

`sync-stripe` stores each balance transaction in whole units, converted from
its currency's smallest unit, and what Stripe kept of any transaction as a fee
row of its own (`_shared/stripe-kind.ts`); a window holding more than 4,000
transactions is stored only in part, and the sync says so. `sync-mercury` maps
Mercury's transaction kinds (`sync-mercury/kind.ts`). Rows stored before 0041,
and any Stripe or Mercury row inserted or updated without a kind, are given one
by `finance_kind_guess()`. A Stripe row is a payout when its description starts
with one ("STRIPE PAYOUT", `payout_failure`), not when it only mentions one. A
Mercury row is Stripe's when its counterparty is one of Stripe's own names —
never Pinstripe or The Stripe Agency — or when the bank's description starts
with the word, as `sync-mercury` reads it too: so a client whose own name starts
with Stripe, on a wire described "STRIPE STUDIO LLC WIRE", is taken for a
payout. That still counts as revenue, but it can stand in for a Stripe payout of
the same amount, and a payment to that client guessed the same way counts
against revenue rather than as an expense. The guess cannot tell a transfer
between the studio's own accounts from other money, and stays until a sync
writes the real kind, even when an older sync updates the row later without
one — so deploy `sync-stripe` and `sync-mercury`, which both write it, right
after 0041, and sync again over anything stored before. A row entered by hand
or imported from a file without a kind is read by its sign.

**Only an owner makes an owner, and there is always one (0042).** Owners and
admins add and change team members; nobody deletes one through the API. For
anyone signed in, a trigger refuses linking a sign-in to a row (only an
invitation does that), changing their own role or status, changing a member's
id or the address of someone who can sign in, and creating, granting or
changing an owner without being one. The service role never moves a member onto
a different sign-in. For everyone — the service role and the SQL editor
included — a change that would leave no owner who can sign in is refused, and so
is deleting the last owner's auth user: make someone else an owner first. `invite-employee` writes with the service role, so it asks
the same questions itself (`_shared/team-rules.ts`); `activate_self()` still
moves the caller's own row from invited to active.

**A colleague's phone and notes are not in the directory (0043).** Signed-in
people can select every column of `employees` except `phone` and `notes`.
`employee_private(id)` answers the phone number to owners, admins and the person
themself, and the notes to owners and admins. A column added to `employees`
later cannot be read through the API until it is granted.

**A colleague's mailbox connection is theirs (0044).** Everyone — owners and
admins included — reads the studio's connections and their own; a colleague's
personal mailbox, its address and its last error are not theirs to read,
through `integration_connections` or `integration_status`. The Edge Functions
read connections with the service role. The calendar functions read and book
into the calendar a connection names — `/users/{address}` for a shared one,
which needs `Calendars.ReadWrite.Shared` and so a reconnect of any calendar
connected before it — and a booking about client work goes into the studio
calendar rather than the booker's own (`_shared/calendar-choice.ts`).

The functions draw the same line (security review, 2026-09-14;
`_shared/connection-rules.ts`, `_shared/connection-check.ts`). None of them acts
on a colleague's personal connection; reads a studio connection that is a team
member's own address, records no consenter, or was connected before its address
was checked against the directory (its grant lacks `User.ReadBasic.All`); or
reads a shared calendar through a grant without `Calendars.ReadWrite.Shared`.
Each of those is a reconnect, decided from the stored grant. A disconnected
calendar is never switched back on. A calendar that needs reconnecting is never
swapped for another: client work is then saved in the workspace, and a private
event is refused. One whose last sync failed still takes bookings — nothing
syncs a calendar again by itself — and Graph's answer to the booking says
whether it really is broken; client work a studio calendar will not take is
saved in the workspace alone. Sending, read and starred changes and ticket
replies refuse a studio mailbox that fails the same rules, as the syncs refuse
to read it. Anyone reconnects their own mailbox; owners and admins connect new
ones, saying whose, and reconnect the studio's — and to anyone else a
colleague's connection is answered as none at all. An owner or admin can still
tell that a colleague has connected an address, since asking to connect it
answers that it is connected for someone else; what stays hidden from them is
the connection itself — its status, its errors and its mail.

**Going live with the calendar fix**, in this order:

1. Add `Calendars.ReadWrite.Shared` and `User.ReadBasic.All` under API
   permissions in Entra, with admin consent if the tenant requires it. The
   callback looks each connected address up in the directory, so a sign-in name
   the team does not store cannot pass for a studio mailbox, and an alias the
   directory does not list is refused: connect a mailbox by its main address.
   Only a work account in the studio's organisation can look addresses up —
   guest and personal Microsoft accounts can connect their own mailbox, and
   nothing read through someone else's grant.
2. Deploy `microsoft-connect`, `sync-outlook-calendar`, `create-calendar-event`,
   `sync-outlook-mail`, `send-mail`, `update-mail-state` and `send-ticket-reply`
   together — each bundles its own copy of `_shared` — and `microsoft-callback`
   and `sync-mail-scheduled` with `--no-verify-jwt`: Microsoft's redirect and
   the schedule carry no Supabase token, and without the flag both answer 401.
3. Count what a studio calendar synced through someone's consent (the dry run
   prints it), and decide what to remove before the next sync.
4. Reconnect every calendar and mailbox — the callback's checks run again on
   each — then run a manual sync. A studio mailbox or calendar that is not
   reconnected stays off: its grant predates the directory check, and every
   function answers that it needs a reconnect.

**Mail that leaves the inbox in Outlook leaves it here (0045).** The scheduled
sync hands what the inbox's delta reports as removed to `mail_left_folder()` —
after asking Graph whether each message really has gone — which files those
messages as `archive` and moves their conversation out of the inbox once none of
its messages is left there: to Sent while it holds a reply of ours, which the
workspace lists. Once a day the sync also compares the inbox with a listing of
Outlook's, for what the delta never reported — everything filed away before
0045 among it. Nothing is deleted, in the workspace or in Outlook, and a message
moved back into the inbox takes over the copy that was filed away
(`store_mail_batch`). Messages stored before 0038 get a folder, and none is
stored without one from now on. Push 0045 **before** deploying
`sync-mail-scheduled`: until the migration is live the sync leaves removals
alone and says so in its log, rather than failing. Pause the mail schedule
while it is pushed: 0045 checks every stored message as it adds its rule,
holding `mail_messages` for that long, and a sync storing mail meanwhile would
wait on it or time out. Push it when nobody is opening tickets from mail or
removing a mailbox, too: either takes the tables in the other order, and should
they meet, Postgres cancels 0045, which can simply be pushed again.

Since 0039, owning a project is a permission: its owner adds the members who
can open its files. So only an owner/admin, or the project's current owner, can
change `owner_id` (`guard_project_owner`); nobody but the database picks a
project's `id`, which could otherwise be a deleted project's; and a project
that has files is archived rather than deleted outright.

Two of those deserve saying out loud:

**Managers cannot read a colleague's personal mailbox.** `can_read_connection()`
grants a studio mailbox (`employee_id is null`) to all staff and a personal one
to its owner, with no manager override. "Owner" is permission to run the
company, not to read someone's mail, and a studio that sells privacy-first
software should not build the other thing into its own tools. Shared
correspondence belongs in a shared mailbox.

**Nobody reads `integration_secrets`.** RLS is on, there is not one policy, and
the grants to `anon` and `authenticated` are revoked — so PostgREST does not
even expose it and the table answers `permission denied` rather than an empty
list. Only the service role, which exists only inside Edge Functions, can touch
it. If you ever find yourself adding a policy there, stop: the workspace runs
the anon key in a browser, and any policy that lets a signed-in user select
from that table hands them a refresh token.

---

## Connecting the inbox and the calendar

Microsoft 365, via Graph. Everything is in place; it needs an app registration
and two secrets.

**1. Entra ID** (portal.azure.com → Microsoft Entra ID) → **App registrations**
→ New registration.

- Supported account types: *Accounts in this organizational directory only* is
  right if Veyago is on a work tenant; the functions default to the `common`
  authority, which accepts either.
- **Authentication** → Add a platform → **Web** → Redirect URI:

```
https://vtbvhhilucxroqoaohjb.supabase.co/functions/v1/microsoft-callback
```

- **API permissions** → Add → Microsoft Graph → **Delegated**:
  `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `Mail.Read.Shared`,
  `Mail.Send.Shared`, `Mail.ReadWrite.Shared`, `Calendars.ReadWrite`,
  `Calendars.ReadWrite.Shared`, `User.ReadBasic.All`,
  `User.Read`, `offline_access`. Grant admin consent if your tenant requires it.
- **Certificates & secrets** → New client secret. Azure shows the **Value**
  exactly once — that is what you copy, not the Secret ID.

**2. Secrets.** `MICROSOFT_REDIRECT_URI` and `OAUTH_STATE_SECRET` are already
set; these two are yours:

```bash
supabase secrets set \
  MICROSOFT_CLIENT_ID=<application (client) id> \
  MICROSOFT_CLIENT_SECRET=<the secret VALUE>
```

Optionally `MICROSOFT_TENANT=<tenant id>` to lock sign-in to one directory.

**3. Connect a mailbox.** All four functions are deployed already. As a
manager:

```bash
curl -X POST https://vtbvhhilucxroqoaohjb.supabase.co/functions/v1/microsoft-connect \
  -H "Authorization: Bearer $YOUR_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"provider":"microsoft_mail","accountLabel":"hello@veyago.cloud","employeeId":null}'
```

`employeeId: null` means a **studio** mailbox every staff member can read. Pass
an employee id instead to make it personal — and personal means personal, with
no manager override. Open the `consentUrl` it returns, approve, and the
callback stores the grant.

Then run a first import by hand; after that the schedule keeps mail current
(see [Sending mail from the workspace](#sending-mail-from-the-workspace)). The
diary — `microsoft_calendar` + `sync-outlook-calendar` — is not scheduled yet:

```bash
curl -X POST https://vtbvhhilucxroqoaohjb.supabase.co/functions/v1/sync-outlook-mail \
  -H "Authorization: Bearer $YOUR_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"connectionId":"<from step 3>","days":30,"max":200,"folder":"inbox"}'
```

### What is asked for, and why

| Scope | Why |
|---|---|
| `Mail.Read` | read the inbox |
| `Mail.Send` | send from the mailbox, so it lands in Sent and threads properly |
| `Mail.ReadWrite` | drafts (every workspace send is one), attachments of 3 MB and up, and read/starred state that reaches Outlook |
| `Mail.Read.Shared`, `Mail.Send.Shared`, `Mail.ReadWrite.Shared` | the same three on a shared mailbox such as hello@veyago.cloud |
| `Calendars.ReadWrite` | read the diary and put things in it |
| `Calendars.ReadWrite.Shared` | the same for a studio calendar, which is a shared mailbox's diary rather than the consenting person's |
| `User.ReadBasic.All` | look a connected address up in the directory, so a studio connection cannot be someone's own mailbox under a sign-in name the team does not store |
| `User.Read` | which mailbox was actually authorised |
| `offline_access` | without it there is no refresh token at all |

**`Mail.ReadWrite` also permits deleting mail.** Graph has no narrower
delegated scope that allows drafts and read state without it. It was held back
for exactly that reason until 2026-09-13, when it was taken for sending from
the workspace. What the grant cannot limit, the code does, twice: every Graph
call for mail passes `_shared/graph-guard.ts`, an allowlist checked at the call,
and `mail-safety.test.js` reads every Edge Function and migration and fails on
any delete, purge, move or copy of a message — so deleting mail stays a
decision, not an accident. See [Nothing deletes mail](#nothing-deletes-mail).

### Things that will bite otherwise

- **`offline_access` or nothing.** Without it Microsoft returns an access token
  and no refresh token: the connection works beautifully for an hour, then dies
  and cannot revive itself. `buildConsentUrl()` refuses to build a URL without
  it, and there is a test that fails if someone removes the guard.
- **A refresh response may omit `refresh_token`.** `mergeTokens()` merges
  rather than replaces, so refreshing never wipes the one credential that
  cannot be re-obtained without sending you back through consent.
- **Graph dates are a wall clock plus a Windows timezone name.**
  `{ dateTime: "2026-09-11T09:00:00.0000000", timeZone: "W. Europe Standard
  Time" }` — no offset, and a zone `Intl` cannot parse. Passing that to
  `new Date()` reads it as server-local and places the event an hour or two
  out, which people blame on themselves for weeks. Both syncs send
  `Prefer: outlook.timezone="UTC"`, and `toInstant()` **refuses** anything that
  is not UTC rather than guessing: a missing event is easier to notice than a
  wrong one.
- **Writing a date needs the opposite care.** `graphDateTime()` sends
  `{ dateTime, timeZone: 'UTC' }` with **no trailing Z** — Graph 400s if the
  field carries an offset as well as a `timeZone`, and reads a bare wall clock
  in the mailbox's own zone if the `timeZone` is missing.
- **`calendarView`, not `/events`.** The latter returns the series master, so a
  weekly stand-up would appear once, on the day it was created.
- The client secret is the **Value**, not the Secret ID. Azure shows it once.
- `invalid_grant` on a sync (revoked, password changed, conditional access)
  flips the connection to `needs_reauth` with the reason in `last_error`,
  rather than retrying forever.

### Mercury

Already built and unchanged: `sync-mercury` uses one studio-wide
`MERCURY_API_KEY` secret and upserts into `finance_accounts` /
`finance_transactions`. It predates `integration_connections` and does not need
it — one global key has nowhere per-user to live.

---

## The workspace front end

It runs on the database now: a sign-in gate, live data in every view, and the
interactive bits writing back. `veyago-workspace/dist/data/`:

| File | What it does |
|---|---|
| `supabase.js` | vendored supabase-js v2 (no CDN — CSP is `script-src 'self'`) |
| `config.js` | project URL + anon key |
| `session.js` | who is signed in, and their role |
| `gate.js` / `gate.css` | sign-in screen, TOTP step, header session chip |
| `queries.js` | one read function per view |
| `actions.js` | the writes |
| `writes.js` | takes over the app's own handlers so they reach the database |
| `store.js` | loads everything and swaps it into the arrays the views render from |

**Script order is load-bearing.** `index.html` has it right:

```html
<!-- before the app: writes.js must register its capture listeners first -->
<script src="data/supabase.js"></script>
<script src="data/config.js"></script>
<script src="data/session.js"></script>
<script src="data/queries.js"></script>
<script src="data/actions.js"></script>
<script src="data/writes.js"></script>
<script src="app.js"></script>
<script src="workspace.js"></script>
<!-- after the app: store.js reaches its top-level const arrays by name -->
<script src="data/gate.js"></script>
<script src="data/store.js"></script>
```

Two reasons, both found the hard way:

- `store.js` replaces the **contents** of `tickets`, `projects`, `contacts`,
  `mails`, `invoices`, `events` and `team`. They are `const`, but they are
  arrays, and a classic script shares the global lexical scope with the ones
  before it — so it can reach them by name and splice. No view code had to
  change to start showing real rows.
- `writes.js` binds `change` and `submit` in the **capture** phase. So does
  `workspace.js`, and it calls `stopImmediatePropagation()` for exactly these
  targets. Capture listeners on the same node fire in *registration* order, so
  loading `writes.js` afterwards means it never runs — and that failure is
  invisible, because the old in-memory handler still ticks the box and still
  says "Task completed" while nothing reaches the database.

### Three traps worth knowing before touching this

**Never call `sb.auth.getSession()`.** supabase-js serialises auth behind a
lock, and anything that asks for the session while it is held waits forever.
Not an error, not a timeout — a promise that never settles and a screen that
stays where it is. `session.js` only ever takes the session from the auth
event, which hands it over directly; `onAuthStateChange` fires
`INITIAL_SESSION` on startup whether or not anyone is signed in, so nothing is
lost by not asking.

**Query inside `ready()`.** A query fired before the JWT is live runs as
nobody: RLS sees no user and every private row comes back empty, which reads as
"no data" rather than "too early". The employee lookup retries a few times
before concluding someone is not staff, for the same reason.

**Status strings are sentence case.** The views match them exactly — the board
filters on `'In progress'`, and the pill colours are keyed by `'In review'`,
`'High'`, `'Paid'`. `label()` in `queries.js` is sentence case deliberately;
Title Case matched nothing, and the board rendered its columns with no cards in
them.

```js
await workspaceSession.ready();
if (!workspaceSession.isStaff()) return;

const tickets = await workspaceData.tickets();
await workspaceActions.replyToTicket(id, 'On it.', 'reply');
```

Each `workspaceData` function returns objects shaped like the array it
replaced, with the raw row under `.row`.

### What is still sample

**Nothing.** Every view reads the database, and the arrays in `app.js` now
start empty — they used to hold sample rows, which meant a failed load looked
like a working workspace belonging to somebody else. Empty renders an empty
state, which is at least true.

The pieces that were written out by hand and are now derived: the Overview
tiles and revenue chart, the revenue mix, the recent-activity feed, the "up
next" card, the notifications bell, the sidebar badges, the team cards, the
ticket owner picker, and the calendar's week. Global search covers tickets,
projects, contacts, events, invoices and mail, and matches ticket numbers.

Mail stays empty until a mailbox is connected — that view has a real empty
state rather than invented threads.

---

## Tests

```bash
npm run check:db     # checks against the live database, each inside a rollback
npm test             # unit tests, 42 of them the Graph/OAuth/reply parsing
```

`check:db` runs the suites in `supabase/tests/` against the **real project**,
each inside a transaction that rolls back. RLS bugs are configuration bugs: a
suite run against a local re-creation can be green while the database people
actually use is not. It skips (exit 0) without a token, so CI stays green.

What it would have caught, and did: `0024` and `0026` originally built their
unique indexes on expressions (`lower(...)`, `coalesce(...) where ...`). Both
enforce the right rule and neither can be named in an `ON CONFLICT` target, so
every upsert the sync functions make would have failed on the first real sync.
`0028` fixes both and proves it in its own `DO` block.

## Sample data

**There is none.** The demo seed was applied during the build so the views
could be checked against something, and then removed — every workspace table is
empty, and the five tasks, 63 transactions, four articles and one enquiry that
predate this work are untouched.

`supabase/seed/workspace-demo.sql` is still there if you ever want a populated
workspace to look at. Every row it writes is tagged `[demo]`, and the file
carries its own delete block.

## Sending a ticket reply

`send-ticket-reply` posts the message **and** sends it in one call.

It sends from a **connected studio mailbox** when there is one: the reply lands
in Sent where anyone can see the customer was answered, and their client
threads it with the rest of the conversation instead of starting a new one.
Never from a personal mailbox (`pickTicketMailbox()`): the query used to take
any connected mailbox, so with the studio's disconnected a customer could be
answered from someone's private address. With no studio mailbox — or if Graph
refuses — it falls back to Resend, the path invites and invoices already use.
Losing a reply is worse than sending it from the wrong place. The response says
which was used (`via`). When email is not configured either, the reason says
why no mailbox sent it: none is connected, the studio's needs reconnecting or
could not be checked just now, or Outlook refused.

A person can send 20 replies in five minutes. The next is refused with 429
before anything is saved, so what was written stays in the reply box; notes do
not count. Replies are counted as they are stored — before they are sent — and
checked again once the new one is, so replies sent all at once cannot slip past
together; one past the limit stays in the conversation, marked as not sent.

The insert runs as the **caller**, through the anon key with their own JWT, so
RLS still decides whether they may post and whose name goes on it. Only the
delivery stamp is written with the service role; the browser has no UPDATE
policy on `ticket_messages` and should not get one.

```
POST /functions/v1/send-ticket-reply
{ "ticketId": "...", "body": "…", "kind": "reply" | "note" }
→ { ok, messageId, sent, reason?, to? }
```

It answers `sent: false` with a reason rather than failing, when there is
nothing to send to. The workspace shows that reason in the toast instead of
"Reply posted", because a reply that never left while the screen says it did is
the failure this whole path exists to prevent.

**An internal note is never emailed.** Three separate things enforce that: the
`decideSend()` decision (unit-tested from several angles), the function's own
branch, and a CHECK constraint that refuses a delivery stamp on
`direction = 'internal'`. One guard in one Edge Function was not enough of a
barrier for the worst bug this feature could have.

### The response clock changed meaning

`first_response_at` used to be stamped when an outbound message was *inserted*.
That was right when inserting was all a reply could do. Now that replies
actually send, the two came apart: a reply to a ticket with no contact email
still started the clock, and the ticket read as answered when nobody outside
the studio had heard anything.

Since 0034 it starts on **delivery**. The cost is that a reply given by phone
never sets it — which is the honest answer, and the ticket's status is where
that belongs.

Set `SUPPORT_REPLY_TO` if replies should come back to a different address than
`EMAIL_FROM`; the subject carries `[#VYG-142]`, and
`ticketNumberFromSubject()` reads it back out so an inbound reply can be
matched to its ticket once the mail sync runs.

## Deployed

All six Edge Functions below were live as of this document's own last update
(migration `0038`). Seven more have gone out since (`send-mail`, `sync-mercury`,
`sync-stripe`, `sync-mail-scheduled`, `update-mail-state`, `invoice-pdf`,
`invite-employee`) — see the update note at the top of this document for
where the detail lives; this table was not extended to match.

| Function | Auth | Needs |
|---|---|---|
| `send-ticket-reply` | staff | `RESEND_API_KEY`, `EMAIL_FROM` — already set |
| `microsoft-connect` | staff — something new, or the studio's, takes an owner or admin; anyone reconnects their own | the Microsoft secrets |
| `microsoft-callback` | **public** (signed `state`) | the Microsoft secrets |
| `sync-outlook-mail` | manager — the studio's mailboxes and their own | a connected mailbox |
| `sync-outlook-calendar` | staff — the studio's calendars and their own | a connected calendar |
| `create-calendar-event` | staff | a connected calendar (409 `localOnly` → saved in the workspace; 503 → the booker's own calendar needs reconnecting) |

Verified after deploying: every authenticated one answers `401` without a
token, and `microsoft-callback` — which is public by necessity, since Microsoft
redirects a browser to it — refuses an unsigned `state` and reports missing
secrets rather than doing anything.

`send-ticket-reply` was exercised against a real ticket: a reply with no
contact email came back `sent: false` with the right reason, an internal note
was recorded and not sent, an empty body was refused with 400, and an unknown
ticket with 404. The Resend leg itself is the same one six other functions use
in production; it was not fired at a real address.

## Inbound mail → tickets

The other half of the loop. Every reply we send carries `[#VYG-142]` in its
subject; `sync-outlook-mail` hands each inbound message to `route_mail_to_ticket()`,
which finds that ticket, appends the customer's words to the thread as an
inbound message attributed to *them*, links the mail thread to the ticket, and
**reopens it if it was resolved or waiting** — a customer who has replied is
waiting on us again (0046). A deleted ticket takes no replies and is never
reopened.

Idempotent: `ticket_messages.mail_message_id` is unique, so re-running a sync
never doubles a reply. A routing failure is logged and the sync carries on —
the mail is already saved, and the worst case is a reply someone files by hand.

**Unreferenced mail deliberately does not open a ticket.** Every inbound
message becoming one turns the queue into a second inbox, newsletters and all.
The manual half is `create_ticket_from_thread()`, wired to the "Create ticket"
button on a mail thread: it opens the ticket, carries the conversation so far
into it, and returns the existing one if the thread already has it — or opens a
new one when that ticket was deleted (0046).

Merges take the mail tables' locks first where they can. `merge_tickets()`
(0054) takes `mail_threads` in SHARE ROW EXCLUSIVE mode before it locks any
ticket row, the order `store_mail_batch()` takes them in. `merge_companies()`
and `merge_contacts()` (0053) do not yet, so now and then one can deadlock with
a mail sync filing mail for the same people: Postgres stops one of the two, and
running it again succeeds.

## Booking something

`create-calendar-event` creates the event **in Outlook first**, then stores it
already owned by the sync (`connection_id` + `external_id` set). That order
matters: a Graph failure leaves nothing behind, rather than a local row
pretending to be a meeting.

It reads the created event back through the same parser the sync uses, so the
stored row is byte-identical to what the next sync would write — otherwise the
first sync after booking silently "corrects" a row that was already right.

With no calendar connected — or for anything headed to the studio calendar while
it needs reconnecting, can no longer refresh its sign-in, or will not take the
event (Graph 401, 403 or 404) — it answers **409 with `localOnly: true`**, and the
workspace inserts a local event itself through the RLS policy that exists for
exactly that. Any other failure saves nothing. A private event whose own
calendar needs reconnecting, or can no longer refresh its sign-in, is refused
with **503**: saved locally, every member of staff would read it. Client work is an event linked to a project, company or contact, never
one guessed from its kind or the words typed. The toast says which happened,
because an event only the workspace knows about is a different thing from one
that is now on your phone.

## Sending mail from the workspace

Migration `0038` and three functions. Deployed and live since 2026-09-15 (see
the update note at the top of this document) — the checklist that follows
describes how that went out, kept for the record.

### send-mail

New mail, reply, reply-all and forward, from any mailbox the caller can read
(`can_read_connection()`: the studio's, and their own).

```
POST /functions/v1/send-mail
{ "connectionId", "mode": "new" | "reply" | "replyAll" | "forward",
  "messageId"?, "to"?, "cc"?, "bcc"?, "subject"?, "html",
  "importance"?: "low" | "normal" | "high",
  "attachments"?: [{ "path", "name", "size", "contentType" }] }
→ { ok, sent, mailbox, threadId, stored }
```

Every send is a **draft first**: created (for a reply, by Outlook, with the
original quoted and the threading headers set), filled in, given its
attachments, then sent. Graph's one-shot `sendMail` cannot carry an attachment
of 3 MB or more, and a reply made that way loses Outlook's quoting. A failure
after the draft exists leaves it in **Drafts**, where it can be finished in
Outlook, and the response says so.

- The request is checked in full before anything reaches Graph
  (`_shared/mail-send.ts`): addresses de-duplicated across To/Cc/Bcc, at most
  500 recipients, 20 attachments and 25 MB, outgoing HTML stripped of scripts
  and handlers, and a reply whose recipients were all removed refused.
- **Attachments go to Storage first** (`mail-attachments`, private), and
  `send-mail` reads every one of them **as the caller**, before any draft
  exists. A path is exactly `<auth id>/<upload id>/<plain name>`, nothing
  percent-encoded: fetch resolves `%2e%2e` to `..` before a request leaves, so a
  path starting with your own id could otherwise end in someone else's folder.
  The storage policy then says the same thing again. From 3 MB a file goes
  through an upload session. (Why Storage at all: an Edge Function has two
  seconds of CPU, not enough to parse 25 MB of base64 out of a JSON body.)
- Only a mailbox that is `connected`, or retrying after an `error`, sends. A
  reply comes from the mailbox the message arrived in; Graph ids belong to one
  mailbox. A shared mailbox that lets the consenting account read but not
  *Send As* gets told exactly that, not "reconnect".
- After sending, the sent copy is read back from Sent Items **by its
  Message-ID** and stored through the sync's own path, so the conversation
  shows it at once and the next sync finds the row already right.

### Nothing deletes mail

`Mail.ReadWrite` would allow it, so it is refused twice. **At runtime**, every
Graph call for mail goes through `graphRequest()`, which asks
`_shared/graph-guard.ts` first: an allowlist of reads, drafts, attachments,
sends and read/flag changes. A call assembled from variables cannot talk its way
past it, and an attachment upload may only go to the session Graph issued.
**In source**, `mail-safety.test.js` fails on any delete, purge, move or copy in
a function or a migration, and checks the guard is actually wired in.

### update-mail-state

Read and starred now reach Outlook. The change goes to Graph first, then to
the stored messages, then to the thread — as the caller, through a column grant
that allows exactly `is_read` and `is_starred`. (0038 revoked the rest: the 0025
policy let anyone who could read a studio thread move it into their own
mailbox.) Un-starring clears every flag in the conversation, because a thread is
starred while any of its messages is flagged. A mailbox connected before
`Mail.ReadWrite` answers 403; the change still lands here, and the response says
Outlook did not get it.

### Mail syncs itself

Every five minutes `pg_cron` sends **one request per connected mailbox** to
`sync-mail-scheduled`, so a slow mailbox cannot use up the others' time. Each run
follows Graph's **delta** for Inbox and Sent Items: new mail, and read and flag
changes made in Outlook. The link Graph hands back is saved after every stored
page, so a burst of changes bigger than one run — "mark all as read" on a busy
inbox — carries on from exactly where it stopped instead of being re-read from
the top. The loop is `_shared/delta-loop.ts`, tested in node.

`sync_cursor` holds, per folder, the link and how many runs in a row it has
failed, together with the mailbox path the links were made for. Links are only
ever followed for that path, and every reconnect clears them: a connection that
once read `/me` — before it knew who consented — must never keep reading that
person's own inbox into a mailbox all staff can see.

- A folder's first round looks back three days. A round that starts again after
  time away — a mailbox waiting to be reconnected, a link Graph has expired —
  reaches back to just before the schedule last caught up on both folders
  (`delta_synced_at`, which neither a manual sync nor a run that stopped
  part-way moves), at most 14 days; run a manual sync for anything older.
- A link Graph says has gone (410) starts the folder again at once. One it
  refuses outright (400, 404) gets three runs first. An outage, a rate limit or
  a database error never costs the link.
- One folder failing does not stop the other.

A manual sync (`sync-outlook-mail`) never touches the cursor, so it cannot make
the schedule skip anything. A per-mailbox lock (`claim_mail_sync`) keeps the
schedule, a manual sync and a long run from overlapping.

Mail deleted, archived or moved out of the inbox in Outlook leaves the workspace
inbox too (0045). The delta reports it gone, Graph is asked whether it really is
(`_shared/inbox-sweep.ts`), and `mail_left_folder()` files it — nothing is
deleted, here or in Outlook. A conversation leaves the inbox once none of its
messages is left there: for Sent while it holds a reply of ours, otherwise for
the archive, which the workspace does not list — a starred one stays under
Starred. What leaves Sent Items changes nothing. Once a day the schedule also
compares the inbox with a listing of Outlook's, for what the delta never
reported: mail filed away before 0045, while a mailbox waited to be reconnected,
while a link had gone, or received before a delta round reaches. The listing
takes in Outlook's inbox as far back as its newest 3,000 messages, and every
workspace inbox message in that span is compared. Graph is asked about at most
150 a run — a different 150 each day when it found more — and while a run files
something the next one carries on; a message Graph refuses to answer about
stays, and the rest are still asked about. When Graph asks for a pause, or a
run's time runs out before it has filed anything, the comparison tries again in
an hour rather than a day. A run stops starting work after 90 seconds — the
platform stops a request at about 150, and a stopped run releases and records
nothing. A page whose removals are not all confirmed yet is read again next run,
for up to six runs in a row, about half an hour. After that the sync goes on
without them and says so — in its log, and on the mailbox in Mail until the
next daily comparison has asked about that mail again: one message Graph keeps not answering
about must not stop all the mail that arrives after it.

Everything is stored through `store_mail_batch()`, one call per batch, which
upserts the messages and brings each conversation in line with **every** message
it holds, in one statement: the inbox wins (a reply of ours found in Sent never
moves a conversation), unread while anything from outside is unread, starred
while anything is flagged. Decided per batch in the function, those went wrong:
overlapping runs wrote each other's stale state back, and a batch that did not
happen to contain the unread message marked the thread read. Mail found in Sent
is always ours, so a reply sent *as* hello@ from a personal mailbox is never
filed onto a ticket as the customer's words. Nor is mail **from** one of us
routed automatically, whichever mailbox it turns up in (`is_staff_address`: a
member of staff, a connected mailbox, or whoever consented to one) — a colleague
cc'ing hello@ on their reply would otherwise be shown on the ticket as the
customer writing, and reopen it. Opening a ticket from a conversation by hand
still brings that mail along, so a forwarded customer email is not lost.
`update-mail-state` works a thread's read and starred out again from its
messages afterwards (`refresh_mail_thread_state`), the same way the sync does.

The function is deployed `--no-verify-jwt` and checks an `x-sync-secret` header
instead: a schedule has no user to sign in as, and should not be handed the
service-role key. A failure marks a mailbox `needs_reauth` — which takes it off
the schedule — only when a reconnect would fix it: Microsoft refusing the grant
(`invalid_grant`, `interaction_required`) or credentials that are gone. The
refresh says which (`TokenRefreshError.permanent`); the wording of Microsoft's
answer does not decide it. A rate limit, Microsoft being briefly unavailable or
a database hiccup is `error`, which the schedule retries. An old grant failing
while someone reconnects flags nothing, and its refreshed tokens never overwrite
the new grant. A run that finishes after someone disconnected the mailbox leaves
it disconnected.

### A mailbox keeps what it was connected as

Managers may write `integration_connections`, and that used to mean every
column. Point a colleague's personal mailbox at yourself (`employee_id`) and
`can_read_connection()` would hand you their mail — and now their sending. Clear
`external_id` on the shared mailbox and the sync would read the consenting
person's own mail into it, for all staff to see. So in 0038, **from the browser
a connection can only be disconnected**: the browser may update `status` and
`last_error` and nothing else, insert nothing, and a trigger keeps `status` to
`disconnected`. A manager disconnects, as they remove, only the studio's
connections or their own; a colleague's personal mailbox is theirs to switch off. Everything else about a connection is written by
`microsoft-connect`, the callback and the sync, as the service role. The
callback connects nothing when Microsoft does not say which account signed in:
without that, a shared mailbox would be read as the consenting person's own.

`microsoft-connect` refuses a different owner for a mailbox that already has a
row, and two first connections of the same address at once cannot overwrite
each other's owner. It reconnects the studio's mailboxes for an owner or admin,
and anyone's own for them — never a colleague's. Something new takes an owner or
admin, who says whose it is; a studio connection cannot be a team member's own
address, nor a personal one a colleague's, and the callback checks both again
before it stores the grant — and refuses an address the directory does not know
as an account whenever the mailbox is read through someone else's grant, since
an alias could be anyone's mailbox. A row refused before it ever held a grant,
or whose consent was abandoned, holds nothing: an owner or admin starts it again,
with the owner it has or the one they name. A manager deletes the studio's connections or their own,
not a colleague's — the row takes the grant and every stored message with it.
Handing a mailbox to someone else means removing the connection and connecting
it fresh; disconnecting keeps the row, and its owner. The workspace has no way to
remove one yet, so for a colleague's personal mailbox that is the SQL editor.

### Going live

Kept for the record — this already happened. `0038` needed **Postgres 15 or
later** (`unique nulls not distinct`); the live project already met that bar.

Before `db push`, `0038` and the `supabase/tests` suites written with it were
dry-run inside one transaction that ends in `rollback`, then applied for
real. Every migration since has followed the same dry-run-then-push shape.

```bash
supabase db push                                   # 0038
supabase functions deploy send-mail update-mail-state sync-outlook-mail \
  send-ticket-reply microsoft-connect
supabase functions deploy sync-mail-scheduled --no-verify-jwt
supabase secrets set MAIL_SYNC_SECRET=$(openssl rand -hex 32)
```

Then once, in the SQL editor, with the same secret value — never committed:

```sql
select vault.create_secret('https://vtbvhhilucxroqoaohjb.supabase.co', 'project_url');
select vault.create_secret('<MAIL_SYNC_SECRET>', 'mail_sync_secret');
```

**Then reconnect every mailbox** through `microsoft-connect`. A grant carries
only the scopes it was consented with, so `Mail.ReadWrite` arrives with the next
consent; until then `send-mail` answers 409 with `reconnect: true`. Add
`Mail.ReadWrite` and `Mail.ReadWrite.Shared` under **API permissions** in Entra
ID first. A reconnect keeps the mailbox's owner and consenting account, so
`employeeId` no longer has to be repeated for a reconnect — leaving it out used
to turn a personal mailbox into a shared one. Connecting something new still
takes it: `null` for the studio, or the employee it belongs to.

**Only then ship the workspace's read and star change** (veyago-workspace
`dist` v36). It calls `update-mail-state` and deliberately has no fallback to
writing the thread row, so before the function is live those buttons fail with
an error instead of quietly doing half the job.

## What is still not built

- **Compose in the workspace.** `send-mail` and `update-mail-state` exist; the
  Mail view does not call them yet, so compose still sends nothing.
- **Scheduled calendar sync.** Mail syncs itself every five minutes;
  `sync-outlook-calendar` is still called by hand.
- **Attachments on tickets.** Mail can carry them; tickets cannot.
- **Cleaning up unsent uploads.** `send-mail` removes a message's files from
  `mail-attachments` once it is sent. Files uploaded for a message that was
  never sent — the compose window closed, or the send failed — stay until
  someone removes them.
- **Mail stored before 0038** has no Message-ID until a sync sees it again (0045
  gave it a folder). One that moves in Outlook before then is stored a second
  time under its new Graph id rather than recognised as the same message.
- **Invoice creation** from the workspace — Finance reads `finance_invoices`,
  which is still written from `/admin`.
