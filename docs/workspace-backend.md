# Veyago Workspace — backend

The workspace is a second front end onto the **same** Supabase project as
`/admin`, not a second database. Same auth, same `employees.role`, same anon
key in the browser with RLS as the only boundary.

Migrations `0021`–`0038`. `0021`–`0037` are applied to the live project and
verified there — see [Tests](#tests). `0038` (sending mail) is written and
tested locally but **not applied yet**; see
[Going live](#going-live).

The front end is a separate repo, [`cxspectre/workspaceveyago`][repo], live at
**<https://workspace.veyago.cloud>**. `veyago.cloud/login/` links straight to
it; `veyago.cloud/workspace/` is a permanent redirect for old links.

[repo]: https://github.com/cxspectre/workspaceveyago

---

## What was added

| Area | Tables | Notes |
|---|---|---|
| CRM | `crm_companies`, `crm_contacts` | `promote_enquiry_to_crm()` graduates a `/websites/` enquiry into both |
| Client work | `client_projects`, `tasks.project_id` | **not** `public.projects`, which is the marketing site's research projects |
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

- `workspace_overview()` → the four KPI tiles as one `jsonb`.
- `client_project_progress` → a view: each live project with its task counts
  and a computed completion percentage. Progress is **not stored**; a stored
  percentage drifts the moment a task changes underneath it.
- `revenue_series(months)` → a row per month, **including empty ones**, because
  a gap in a line chart reads as missing data rather than as a zero.
- `revenue_mix(months)` → this month's income by category. Uncategorised income
  is labelled rather than dropped, so the slices always add up to the total.

## Who can see what

`employee_role()` is the single source of truth (migration 0013).

| | anon | `employee` / `assistant` | `owner` / `admin` |
|---|---|---|---|
| CRM, projects, tickets | – | read + write | read + write, and delete |
| Finance | – | – | everything |
| Activity feed | – | `staff` rows only | all rows |
| A studio mailbox | – | read | read |
| A personal mailbox | – | only their own | **only their own** |
| A mail signature | – | only their own | **only their own** |
| `integration_secrets` | – | – | – |

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
which was used (`via`).

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

All six Edge Functions are live on the project:

| Function | Auth | Needs |
|---|---|---|
| `send-ticket-reply` | staff | `RESEND_API_KEY`, `EMAIL_FROM` — already set |
| `microsoft-connect` | manager | the Microsoft secrets |
| `microsoft-callback` | **public** (signed `state`) | the Microsoft secrets |
| `sync-outlook-mail` | manager | a connected mailbox |
| `sync-outlook-calendar` | manager | a connected calendar |
| `create-calendar-event` | staff | a connected calendar (409 → local-only) |

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
**reopens it if it had been resolved** — a customer who has replied is waiting
on us again.

Idempotent: `ticket_messages.mail_message_id` is unique, so re-running a sync
never doubles a reply. A routing failure is logged and the sync carries on —
the mail is already saved, and the worst case is a reply someone files by hand.

**Unreferenced mail deliberately does not open a ticket.** Every inbound
message becoming one turns the queue into a second inbox, newsletters and all.
The manual half is `create_ticket_from_thread()`, wired to the "Create ticket"
button on a mail thread: it opens the ticket, carries the conversation so far
into it, and returns the existing one if the thread already has it.

## Booking something

`create-calendar-event` creates the event **in Outlook first**, then stores it
already owned by the sync (`connection_id` + `external_id` set). That order
matters: a Graph failure leaves nothing behind, rather than a local row
pretending to be a meeting.

It reads the created event back through the same parser the sync uses, so the
stored row is byte-identical to what the next sync would write — otherwise the
first sync after booking silently "corrects" a row that was already right.

With no calendar connected it answers **409 with `localOnly: true`**, and the
workspace inserts a local event itself through the RLS policy that exists for
exactly that. The toast says which happened, because an event only the
workspace knows about is a different thing from one that is now on your phone.

## Sending mail from the workspace

Migration `0038` and three functions. **Written and unit-tested, not deployed
yet** — the checklist is at the end of this section.

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
  reaches back to just before the last successful sync, at most 14 days; run a
  manual sync for anything older.
- A link Graph says has gone (410) starts the folder again at once. One it
  refuses outright (400, 404) gets three runs first. An outage, a rate limit or
  a database error never costs the link.
- One folder failing does not stop the other.

A manual sync (`sync-outlook-mail`) never touches the cursor, so it cannot make
the schedule skip anything. A per-mailbox lock (`claim_mail_sync`) keeps the
schedule, a manual sync and a long run from overlapping. A message deleted or
taken out of a synced folder in Outlook stays in the workspace.

Everything is stored through `store_mail_batch()`, one call per batch, which
upserts the messages and brings each conversation in line with **every** message
it holds, in one statement: the inbox wins (a reply of ours found in Sent never
moves a conversation), unread while anything from outside is unread, starred
while anything is flagged. Decided per batch in the function, those went wrong:
overlapping runs wrote each other's stale state back, and a batch that did not
happen to contain the unread message marked the thread read. Mail found in Sent
is always ours, so a reply sent *as* hello@ from a personal mailbox is never
filed onto a ticket as the customer's words. Nor is mail **from** one of us,
whichever mailbox it turns up in (`is_staff_address`: a member of staff, a
connected mailbox, or whoever consented to one) — a colleague cc'ing hello@ on
their reply would otherwise be shown on the ticket as the customer writing, and
reopen it.

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
`disconnected`. Everything else about a connection is written by
`microsoft-connect`, the callback and the sync, as the service role.

`microsoft-connect` refuses a different owner for a mailbox that already has a
row, and two first connections of the same address at once cannot overwrite
each other's owner. A manager deletes the studio's connections or their own,
not a colleague's — the row takes the grant and every stored message with it.
Handing a mailbox to someone else means removing the connection and connecting
it fresh; disconnecting keeps the row, and its owner. The workspace has no way to
remove one yet, so for a colleague's personal mailbox that is the SQL editor.

### Going live

`0038` needs **Postgres 15 or later** (`unique nulls not distinct`). Check first,
read-only: `show server_version;` in the SQL editor.

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
`employeeId` no longer has to be repeated — leaving it out used to turn a
personal mailbox into a shared one.

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
- **Mail stored before 0038** has no Message-ID or folder until a sync sees it
  again. One that moves in Outlook before then is stored a second time under its
  new Graph id rather than recognised as the same message.
- **Invoice creation** from the workspace — Finance reads `finance_invoices`,
  which is still written from `/admin`.
