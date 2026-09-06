# Supabase setup — Veyago Journal + Wallpapers

Supabase is the **content store and authoring backend**. It is the *only* surface that
talks to Supabase: the `/admin` pages (which are `noindex`). The **public website never
calls Supabase** — `tools/build.js` reads published rows with the public anon key and
renders static HTML into the repo, so `veyago.cloud` stays first-party and call-free.

> Security model: `supabase-js` runs in the browser with the public **anon key**. Row Level
> Security (`0001_init.sql`) is the real boundary — anyone may *read published rows*, only the
> single admin (the one row in `public.admins`) may *write*. No service-role key is ever used.

## One-time setup

1. **Create a project** at <https://supabase.com/dashboard>. Then open
   **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcdxyz.supabase.co`)
   - **anon public** key (safe to expose — RLS gates everything)

2. **Run the schema.** Dashboard → **SQL Editor** → New query → paste the contents of
   [`migrations/0001_init.sql`](migrations/0001_init.sql) → **Run**. This creates the
   `admins` / `articles` / `wallpapers` tables, the `is_admin()` helper, all RLS policies,
   and the two public-read / admin-write Storage buckets (`article-media`, `wallpapers`).

3. **Create your admin user.** Dashboard → **Authentication → Users → Add user → Create new
   user**. Use a real email + a strong password. **Do not** build a public signup form — this
   is the only account. Recommended: enable MFA for it later (Authentication → Providers / your
   account).

4. **Bootstrap yourself as admin.** Click your new user to copy its **User UID**, then run in
   the SQL Editor:
   ```sql
   insert into public.admins (user_id, email)
   values ('PASTE-USER-UID-HERE', 'you@example.com');
   ```
   After this, the RLS policies let you write everything; nobody else can.

5. **Wire the credentials.**
   - **Admin (browser):** put the values in [`/admin/supabase-config.js`](../admin/supabase-config.js).
     The anon key is public-safe, but `/admin` is `noindex` and behind login anyway.
   - **Build (local):** create a `.env` in the repo root (git-ignored):
     ```
     SUPABASE_URL=https://abcdxyz.supabase.co
     SUPABASE_ANON_KEY=eyJ...your-anon-key...
     ```

## Publishing flow

1. Log into `/admin`, write an article (or upload a wallpaper) and **Publish** it (sets
   `status='published'`, `published_at=now()`).
2. Locally run the export and review the generated files:
   ```bash
   npm install            # one time — installs build devDependencies
   npm run build          # reads published rows → writes /journal, /wallpapers, /assets/wallpapers
   ```
   (Test the renderer without Supabase using the fixture: `node tools/build.js --fixture data/journal/sample-article.json`.)
3. Commit and push — GitHub Pages redeploys. (Auto-publish via a GitHub Action is a documented
   later option; v1 is a local build + push, matching the existing `node tools/build-essays.js`.)

## Auth notes
- The admin pages check for a Supabase session on load and redirect to the login screen if
  there is none. This is **UX only** — RLS is the actual security, so a session-less visitor
  reaching an admin URL still cannot read drafts or write anything.

## Get-a-quote form (website-enquiry)

The forms on `/websites/` and `/services/` post to the `website-enquiry` Edge
Function, which stores the lead in `public.website_enquiries`, emails us
through Resend and sends the visitor a fixed acknowledgement in their language
(English, Dutch or German, from the page's `lang`). The public site still makes
no third-party calls: the only request is to our own function, and if it fails
the page falls back to a pre-filled `mailto:`.

Deploy once, in this order:

```bash
supabase db push                                           # applies 0019 + 0020
supabase functions deploy website-enquiry --no-verify-jwt  # visitors have no session
supabase secrets set ENQUIRY_TO=hello@veyago.cloud ENQUIRY_IP_SALT="$(openssl rand -hex 24)"
```

Two secrets are mandatory and the function refuses every request (HTTP 500,
page shows the mailto fallback) until both are set:

- `ENQUIRY_IP_SALT` — an IP hashed with a salt that lives in this repository
  would be a reversible IP, which the migration promises we never store.
- `EMAIL_FROM` — shared with the other functions, but here it is required
  rather than defaulted: the acknowledgement lands in a stranger's inbox
  signed as Veyago, so Resend's test sender is never an acceptable fallback.

`RESEND_API_KEY` and `SITE_URL` are shared with the other functions and must
already be set. `ENQUIRY_ORIGINS` (comma-separated) overrides the allowed
origins, which default to the production domains; Vercel preview deployments
(`veyagocloud-*-ieglobal-pe.vercel.app`) and localhost are always allowed.

### What the form sends

Besides the fields 0019 introduced, the `/websites/` form sends `package`:
one of `launch`, `business`, `backoffice` or `unsure`, or empty. Empty and
missing become `NULL`; any other value is a 400 with `field: "package"`. The
`/services/` form does not send it.

### After the insert (0020_enquiry_ops.sql)

Everything after the lead is stored is best-effort — none of it can fail the
request, because the lead exists and the visitor has been promised a reply:

1. **We are emailed** (`ENQUIRY_TO`, reply-to set to the visitor), including the
   package line. Logged in `email_log` as kind `enquiry_notify`.
2. **The visitor is acknowledged** in en/nl/de: what happens next, the
   "New York hours (Mon–Fri, ET)" expectation, the packages/FAQ links (website)
   or the services page (project), and hello@veyago.cloud plus both phone
   numbers. Never echoes anything they typed except a letters-only first name.
   Logged as kind `enquiry_ack`.
3. **A follow-up task** is inserted into `public.tasks` with the service role:
   title `Reply to <name> - <website|project> enquiry`, priority `high`, details
   holding business, website, package, message, the reference id and a deep
   link to `/admin/leads?id=<id>`, due the next New York working day (Fri, Sat
   and Sun all land on Monday). Assigned to the first active owner, else the
   first active admin, else left unassigned. No email goes out for it —
   `notify-task` is only ever invoked from the admin UI, and the owner has just
   received the enquiry itself.

Both `email_log` rows carry the enquiry id in the new `reference` column, so
`/admin/leads` can flag a lead nobody was told about ("not notified", red) or a
visitor who got no confirmation ("no acknowledgement", grey).

### Retention

Enforced inside `submit_website_enquiry()` on every submission — no cron, no
extension, no job that can silently stop:

| What                          | When                  | Why                                 |
| ----------------------------- | --------------------- | ----------------------------------- |
| `ip_hash` cleared             | 30 days after entry   | abuse limiting is long over by then |
| `lost` / `spam` leads deleted | 90 days after entry   | nothing left to follow up           |
| every lead deleted            | 24 months after entry | a quote that old is not a lead      |

The `ip_hash` scrub does not move `updated_at` (the trigger skips updates that
only change `ip_hash`), so "last edited" on a lead stays honest. The attempt
log (`website_enquiry_attempts`) is service-role only and prunes itself daily.

### Working the leads: `/admin/leads`

Managers only (RLS: managers read; the column grant lets `authenticated` update
exactly `status`, `notes` and `next_follow_up_on` — nothing the visitor wrote
can be edited from the browser, and nothing is deleted from it). The screen
lists enquiries newest first, opens each in place with every field, a Reply
`mailto:` carrying the reference in the subject, status chips
(new → replied → quoted → won/lost/spam), notes and a follow-up date. "Open"
is new + replied + quoted; "All" adds the closed ones. Follow-ups due today or
earlier are flagged red and counted in the stat strip.
