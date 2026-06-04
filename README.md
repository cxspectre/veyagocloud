# veyago.cloud

The Veyago studio portfolio — a fast, static site showcasing our apps (Kept and the
Veyago travel app) with the privacy policies.

## Structure

| File | Purpose |
|------|---------|
| `index.html` | Studio home — hero, apps, Kept showcase (screenshots), studio values |
| `kept-privacy.html` | **Kept** privacy policy (on-device, no data collection) — use this URL for Kept's App Store listing |
| `privacy.html` | **Veyago Inc.** company / travel-app privacy policy |
| `styles.css` | Shared design system (navy `#09111F` + parchment `#D4C9A8`) |
| `assets/` | App screenshots + favicon |
| `CNAME` | Custom domain (`veyago.cloud`) for GitHub Pages |

## Deploy (GitHub Pages)

1. Push to `main` (already wired to `github.com/cxspectre/veyagocloud`).
2. In the repo: **Settings → Pages → Source = Deploy from a branch → `main` / root**.
3. Add an **A / CNAME DNS record** for `veyago.cloud` pointing at GitHub Pages
   (`185.199.108.153` … or a `CNAME` to `cxspectre.github.io`). The `CNAME` file is
   already committed.
4. Enable **Enforce HTTPS**.

Works equally on Netlify, Vercel, or Cloudflare Pages — it's plain static files, no build step.

## App Store privacy URL

Use **`https://veyago.cloud/kept-privacy.html`** (or `/kept-privacy`) as Kept's privacy
policy URL in App Store Connect — it accurately reflects Kept's on-device, no-collection model.

## ⚠️ Please review before going live

- **Contact email** — everything points to `hello@veyago.app`. Make sure that inbox exists / forwards.
- **`privacy.html` data sections** — the travel-app "Information we collect / How we use it"
  sections are written to be accurate for a typical destination-discovery app. Confirm they
  match what the Veyago app actually does (e.g., location, analytics provider) and adjust.
- **Veyago app links** point to `https://veyago.app` — update if that domain differs.
- Screenshots are from the Kept demo build; swap in real App Store captures any time
  (`assets/kept-*.png`).
