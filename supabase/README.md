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
through Resend and sends the visitor a fixed acknowledgement. The public site
still makes no third-party calls: the only request is to our own function, and
if it fails the page falls back to a pre-filled `mailto:`.

Deploy once, in this order:

```bash
supabase db push                                           # applies 0019_website_enquiries.sql
supabase functions deploy website-enquiry --no-verify-jwt  # visitors have no session
supabase secrets set ENQUIRY_TO=hello@veyago.cloud ENQUIRY_IP_SALT="$(openssl rand -hex 24)"
```

`ENQUIRY_IP_SALT` is mandatory: the function refuses every request until it is
set, because an IP hashed with a salt that lives in this repository would be
a reversible IP. `RESEND_API_KEY`, `EMAIL_FROM` and `SITE_URL` are shared with
the other functions and must already be set. `ENQUIRY_ORIGINS` (comma-separated) overrides
the allowed origins, which default to the production domains plus localhost.
Leads are readable by managers in the dashboard's database view; the attempt
log (`website_enquiry_attempts`) is service-role only and prunes itself.
