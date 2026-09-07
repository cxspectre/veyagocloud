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
| `nl/`, `de/` | Generated locale twins of `websites/` — never edit by hand, run `npm run build:locales` |
| `projects/<slug>/` | Generated research papers — edit `data/research/<slug>.md`, run `npm run build:essays` |
| `tools/` | Build scripts and the `npm run check` gate, with their tests (see **Scripts and checks**) |
| `docs/seo-keywords.md` | What the Position Tracking campaign should measure, and which page answers each query |
| `.github/workflows/` | `check.yml` (tests + checks on every PR), `publish.yml` (Supabase → static export), `drift.yml` |

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
  project, apply the migrations in `supabase/migrations/`, create your single admin user, then fill in
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
- **Research papers** (separate, existing): `npm run build:essays` regenerates `/projects/<slug>/`
  from `data/research/<slug>.md`; `npm run check` fails if the committed pages drift from the sources.
- **Newsletter:** the capture form is first-party and makes **no** network call until a visitor
  subscribes. Wire your provider endpoint in `assets/js/newsletter.js` once you choose Buttondown/Ghost.

## Scripts and checks

Node 22 (`.nvmrc`, `engines` in `package.json`). Run `npm ci` once; every dependency is build-time
only and nothing here is shipped to the browser.

| Command | What it does | Run it when |
|---------|--------------|-------------|
| `npm start` | Serves the site at http://localhost:8765 with the same headers as `vercel.json` (`tools/serve.py`) | Previewing locally |
| `npm run build` | Reads published rows from Supabase and rewrites `/journal`, `/wallpapers`, `/apps/<slug>/`, `assets/js/site-config.js` and the generated block of `sitemap.xml` | Publishing content authored in `/admin` (this is what `publish.yml` runs) |
| `npm run build:essays` | Renders `data/research/*.md` into `/projects/<slug>/index.html` | After editing a paper, or the shared chrome in `tools/lib/chrome.js` |
| `npm run build:locales` | Writes the static `/nl/` and `/de/` twins of the pages listed in `tools/build-locales.js` (`PAGES`) from `i18n/<code>.js` | After editing `websites/index.html` or a dictionary; `npm run build:locales -- --check` only reports untranslated strings |
| `npm run sitemap:lastmod` | Refreshes `<lastmod>` on the hand-written `sitemap.xml` entries from git history | Before committing a change to a hand-written page |
| `npm run shots:work` | Retakes the portfolio screenshots on `/websites/` (`tools/capture-work-shots.js`) into `assets/work-*.webp`, driving a local Chromium; needs `cwebp` | When a site in the Recent work grid has been redesigned, or a new one joins it |
| `npm test` | Unit tests (`node --test`) for the builders, sanitiser, verifier, admin and public scripts | Before every commit |
| `npm run check` | The pre-merge gate (`tools/check.js`): no third-party requests on the public site, full locale coverage, generated essays and twins fresh, generated tree sound | Before opening a PR — `check.yml` runs `npm test` and `npm run check` on every PR and push to `main` |

`npm run check` names the file and the command that fixes it (for example
`STALE  nl/websites/index.html — … regenerate with npm run build:locales`). The external-request
scan takes its allowlist from the public Content-Security-Policy in `vercel.json`, so a new
third-party host must be a deliberate change there first — see
[`docs/security-headers.md`](docs/security-headers.md). Plain `<a href>` links are navigations,
not requests, and are never flagged.

## App Store privacy URL

Use **`https://www.veyago.cloud/kept-privacy/`** as Kept's privacy policy URL in App Store
Connect — it accurately reflects Kept's on-device, no-collection model. The older
`/kept-privacy.html` form still resolves (308 → `/kept-privacy`), so a listing that already
points there keeps working.

## ⚠️ Please review before going live

- **Contact email** — everything points to `hello@veyago.cloud`. Make sure that inbox exists / forwards.
- **`privacy/` data sections** — the travel-app "Information we collect / How we use it"
  sections are written to be accurate for a typical destination-discovery app. Confirm they
  match what the Veyago app actually does (e.g., location, analytics provider) and adjust.
- **Veyago app links** point to `https://veyago.app` — update if that domain differs.
- Screenshots are from the Kept demo build; swap in real App Store captures any time
  (`assets/kept-*-{330,660}w.webp`).
