# veyago.cloud

The Veyago studio portfolio — a fast, static site showcasing our apps (Kept and the
Veyago travel app) with the privacy policies.

## Structure

| File | Purpose |
|------|---------|
| `index.html` | Studio home — hero, apps, Kept showcase (screenshots), studio values |
| `kept-privacy/` | **Kept** privacy policy (on-device, no data collection) — use `/kept-privacy/` for Kept's App Store listing |
| `privacy/` | **Veyago Inc.** company / travel-app privacy policy |
| `styles.css` | Shared design system (navy `#09111F` + parchment `#D4C9A8`) |
| `assets/` | App screenshots + favicon |
| `vercel.json` | Hosting config — `cleanUrls: true`, no build step (see **Deploy**) |
| `CNAME` | Legacy GitHub Pages artefact; the live site is served by Vercel |

## Deploy (Vercel)

The live site is served by **Vercel**, not GitHub Pages. `vercel.json` does no build —
`outputDirectory` is the repo root, so the committed HTML/CSS/JS ships verbatim. Pushing the
branch set as Vercel's **Production Branch** (Project → Settings → Git) redeploys; check the
dashboard rather than assuming it is `main`. The apex `veyago.cloud` redirects to
`www.veyago.cloud`, which every canonical tag on the site points at.

### ⚠️ Never add a root `<name>.html` next to a `<name>/` directory

`cleanUrls: true` publishes `services.html` under the extensionless key `services`, which
collides with the `services/` directory — and the exact file match wins, so **both `/services`
and `/services/` would serve `services.html` instead of the real page**. Twelve legacy
redirect stubs did exactly that and put every subpage into an infinite refresh loop.

You do not need redirect stubs for the old flat URLs: `cleanUrls` already issues an
unconditional `308` from `/x.html` to `/x`, query string preserved, whether or not `x.html`
exists.

Note that `tools/serve.py` resolves such a collision the *opposite* way (directory wins), so
this class of bug is invisible on `npm start` — verify URL changes against a real deployment.

## Journal, Wallpapers & Admin (content tooling)

Articles and wallpapers are authored in a private, `noindex` admin (`/admin`, backed by
Supabase) and **exported to static HTML by a local build**, so the public site stays static,
fast, and free of third-party calls. The public pages never talk to Supabase.

- **First-time setup:** follow [`supabase/README.md`](supabase/README.md) — create the Supabase
  project, run `supabase/migrations/0001_init.sql`, create your single admin user, then fill in
  `admin/supabase-config.js` and a local `.env` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
- **Write / manage:** open `/admin`, sign in, write articles in the block editor, upload wallpapers.
- **Publish to the live site:**
  ```bash
  npm install            # one time — build-only devDependencies (never shipped to the browser)
  npm run build          # reads PUBLISHED rows from Supabase → writes /journal, /wallpapers, /assets/*
  npm test               # unit tests for the renderer + sanitiser
  ```
  Then commit + push — Vercel redeploys. Preview the look without Supabase:
  `node tools/build.js --fixture data/journal/sample-article.json` (reset with `…/empty.json`).
- **Research papers** (separate, existing): `npm run build:essays` regenerates `/projects/<slug>/`.
- **Newsletter:** the capture form is first-party and makes **no** network call until a visitor
  subscribes. Wire your provider endpoint in `assets/js/newsletter.js` once you choose Buttondown/Ghost.

## App Store privacy URL

Use **`https://www.veyago.cloud/kept-privacy/`** as Kept's privacy policy URL in App Store
Connect — it accurately reflects Kept's on-device, no-collection model. The older
`/kept-privacy.html` form still resolves (308 → `/kept-privacy`), so a listing that already
points there keeps working.

## ⚠️ Please review before going live

- **Contact email** — everything points to `hello@veyago.app`. Make sure that inbox exists / forwards.
- **`privacy/` data sections** — the travel-app "Information we collect / How we use it"
  sections are written to be accurate for a typical destination-discovery app. Confirm they
  match what the Veyago app actually does (e.g., location, analytics provider) and adjust.
- **Veyago app links** point to `https://veyago.app` — update if that domain differs.
- Screenshots are from the Kept demo build; swap in real App Store captures any time
  (`assets/kept-*.png`).
