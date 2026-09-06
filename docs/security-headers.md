# Security headers (`vercel.json`)

`vercel.json` cannot carry comments, so the reasoning behind every header lives
here. Change the two together.

Two header blocks exist because the public site and `/admin` have different
needs. Their `source` patterns are disjoint (`/((?!admin).*)` and `/admin(.*)`),
so no request ever matches both and there is nothing for Vercel to merge.

## Headers on every response

| Header | Value | Why |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Two years, subdomains, eligible for the browser preload list. The site is HTTPS-only on Vercel. |
| `X-Content-Type-Options` | `nosniff` | Stops browsers guessing a type for a mislabelled file. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Full URL stays first-party; other origins only see the origin. |
| `X-Frame-Options` | `DENY` | Legacy twin of `frame-ancestors 'none'` for older browsers. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | None of these APIs are used. File inputs in the admin do not need the camera permission. |

`/admin` additionally sends `X-Robots-Tag: noindex, nofollow` (belt and braces
with `robots.txt` and the per-page meta).

## Content-Security-Policy — public site

Built from a grep of every page and script outside `/admin`:

- **No executable inline scripts.** The only inline `<script>` blocks are
  `type="application/ld+json"`, which the browser never executes, so
  `script-src 'self'` needs no hashes. `app.js` loads `/i18n/<lang>.js` by
  injecting a `<script src>` — same origin, allowed.
- **Inline `style=""` attributes exist** (`404.html`, `projects/`, the two
  essays' `--st` accent variable, `approach/`, `team/`, `support/`, `apps/`),
  so `style-src` keeps `'unsafe-inline'`. Removing those 17 attributes in
  favour of classes would let it drop to `'self'`.
- **No fonts are loaded** (system stack only) — `font-src 'self'` is a no-op
  guard.
- **No `data:` images, no iframes, no plugins.** `img-src 'self'`,
  `frame-src 'none'`, `object-src 'none'`.
- **Forms.** The enquiry forms on `/services/` and `/websites/` carry a no-JS
  fallback `action="mailto:hello@veyago.cloud?…"`, hence
  `form-action 'self' mailto:`.
- **One network call, and only on submit.** `assets/js/enquiry.js` posts the
  enquiry form to the `website-enquiry` Supabase function, so `connect-src`
  allows `https://vtbvhhilucxroqoaohjb.supabase.co` (pinned to the project
  ref, not `*.supabase.co`). `assets/js/newsletter.js` only fetches
  `CONFIG.ENDPOINT`, which is empty (fallback mode). Nothing is requested on
  page load.
- `base-uri 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self'; font-src 'self';
connect-src 'self' https://vtbvhhilucxroqoaohjb.supabase.co;
frame-src 'none'; object-src 'none'; base-uri 'self';
form-action 'self' mailto:; frame-ancestors 'none'; upgrade-insecure-requests
```

### When this has to change

- **Newsletter provider wired up** (`assets/js/newsletter.js` `ENDPOINT`):
  add that origin to `connect-src`.
- **Supabase project ref changes** (`assets/js/enquiry.js`,
  `admin/supabase-config.js`): update the host in both CSPs.
- **Analytics, or any other third-party script**: add the script origin to
  `script-src` and `connect-src`. Until it is there, `npm run check` names every
  page that loads it.
- **An inline `<script>` on a public page**: move it to a file under
  `/assets/js/`, or add its `'sha256-…'` hash (see below).

## Content-Security-Policy — `/admin`

- `script-src 'self'` plus two hashes. `admin/transactions.html` and
  `admin/invoices.html` are redirect stubs whose only content is an inline
  `location.replace(...)`; the hashes cover exactly those bytes (leading
  newline and indentation included). Reformatting either script breaks its
  hash — recompute with
  `python3 -c "import hashlib,base64,sys;print(base64.b64encode(hashlib.sha256(sys.stdin.read().encode()).digest()).decode())"`
  fed the text between the `<script>` tags. The vendored
  `/admin/vendor/supabase.js` is same-origin and uses no `eval`.
- `style-src 'self' 'unsafe-inline'`: the admin pages and scripts set styles
  through `style=""` attributes and `innerHTML`.
- `img-src 'self' data: https://vtbvhhilucxroqoaohjb.supabase.co`: `data:`
  for the MFA QR code (`admin/js/account.js`); the Supabase host for
  Storage public URLs shown as previews (`apps-editor.js`, `article.js`,
  `wallpapers.js`).
- `connect-src 'self' https://vtbvhhilucxroqoaohjb.supabase.co wss://vtbvhhilucxroqoaohjb.supabase.co`:
  REST, Auth, Storage and Functions all live on the project host; `wss:` is
  the Realtime endpoint the vendored client can open. Pinned to the project
  ref rather than `*.supabase.co` so a script running in the admin cannot talk
  to a different project. **If the project ref in
  `admin/supabase-config.js` changes, change it here too.**
- `object-src blob:`: the new-invoice flow (`admin/js/invoice-new.js`) builds
  the PDF preview as a `Blob` and shows it in an `<embed src="blob:…">`;
  `<embed>` is governed by `object-src`, not `frame-src`. Only same-origin
  script can mint a `blob:` URL, so this does not widen the attack surface.
  The "Download a copy" link is a plain anchor with `download`, which CSP
  does not gate.
- `frame-src 'self'`: `admin/member-new.html` previews the invite email in a
  sandboxed `srcdoc` iframe (`about:srcdoc` is not a fetched navigation, so
  `frame-src` is not consulted; `'self'` documents the intent).
- Everything else as on the public site.

## Testing locally

`tools/serve.py` reads `vercel.json` and sends the same headers, so a page that
breaks under the policy breaks on `npm start` too. Open the browser console:
CSP violations are logged as "Refused to …".

## Automated check

`npm run check` (`tools/check.js`, run by `.github/workflows/check.yml` on every
pull request and push to `main`) scans every public page, stylesheet and script
for requests to hosts the public CSP above does not allow: `<script src>`,
`<link>` (stylesheet, icon, preload, preconnect, …), `<img>` and `srcset`,
media, frames, plugins, `<form action>`, `url()` / `@import` in CSS, import
maps, and `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` /
`sendBeacon` / `import()` calls with a literal URL. The allowlist is read from
the public CSP block in `vercel.json`, so adding a third-party host is a
one-place change there and the check follows; wildcards and bare schemes in
the CSP allow nothing, only an exact host does. Plain `<a href>` links and
`rel="canonical"` / `rel="alternate"` are navigations or relationships, not
requests, and are not reported. A URL held in a variable cannot be resolved
statically; the CSP remains the runtime backstop. The scanner itself is
`tools/lib/external-requests.js`.
