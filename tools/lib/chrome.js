/* Shared site chrome for the static-export builders (essays + journal + wallpapers).
   One source of truth for the <head> meta, the header/nav/drawer, and the footer,
   so generated pages stay identical to the hand-authored pages. The matching markup
   in the hand-authored index.html pages is kept in sync by hand (see plan section F).

   app.js injects the launch bar, the language picker, and the drawer language list
   at runtime — those are NOT part of this static chrome. */
'use strict';

var { esc, attr } = require('./escape');

var SITE = 'https://www.veyago.cloud';
var DEFAULT_OG_IMAGE = SITE + '/assets/og.png';

/* Privacy-preserving analytics. OFF until ANALYTICS_DOMAIN is set, so nothing
   third-party is ever added to the site without an explicit decision.
   To turn it on: sign up at plausible.io (or a self-hosted instance), then
     ANALYTICS_DOMAIN=veyago.cloud npm run build
   or put ANALYTICS_DOMAIN=veyago.cloud in .env. Plausible is cookieless and
   stores no personal data, so no consent banner is required — which matters
   given how the apps are positioned on privacy. Swap ANALYTICS_SRC for a
   self-hosted script URL if you'd rather not call plausible.io at all. */
function analyticsTag() {
  var domain = process.env.ANALYTICS_DOMAIN;
  if (!domain) return '';
  var src = process.env.ANALYTICS_SRC || 'https://plausible.io/js/script.js';
  return '<script defer data-domain="' + attr(domain) + '" src="' + attr(src) + '"></script>';
}

/* The <head> inner markup. Mirrors the hand-authored pages + tools/build-essays.js. */
function headTags(opts) {
  opts = opts || {};
  var title = opts.title || 'Veyago';
  var description = opts.description || '';
  var canonical = opts.canonical || SITE + '/';
  var ogTitle = opts.ogTitle || title;
  var ogDescription = opts.ogDescription || description;
  var ogImage = opts.ogImage || DEFAULT_OG_IMAGE;
  var ogType = opts.ogType || 'website';
  var robots = opts.robots || 'index,follow';
  var extra = opts.extra || '';
  return [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<title>' + esc(title) + '</title>',
    '<meta name="description" content="' + attr(description) + '" />',
    '<meta name="theme-color" content="#ffffff" />',
    '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />',
    '<link rel="stylesheet" href="/styles.css" />',
    '<meta property="og:title" content="' + attr(ogTitle) + '" />',
    '<meta property="og:description" content="' + attr(ogDescription) + '" />',
    '<meta property="og:image" content="' + attr(ogImage) + '" />',
    '<meta property="og:type" content="' + attr(ogType) + '" />',
    '<link rel="canonical" href="' + attr(canonical) + '" />',
    '<meta name="robots" content="' + attr(robots) + '" />',
    '<meta property="og:url" content="' + attr(canonical) + '" />',
    '<meta property="og:site_name" content="Veyago" />',
    '<meta property="og:locale" content="en_US" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:site" content="@veyago_cloud" />',
    '<meta name="twitter:title" content="' + attr(ogTitle) + '" />',
    '<meta name="twitter:description" content="' + attr(ogDescription) + '" />',
    '<meta name="twitter:image" content="' + attr(ogImage) + '" />',
    analyticsTag(),
    extra
  ].filter(Boolean).join('\n  ');
}

/* The header / nav / mobile drawer. Keep this in lockstep with the hand-authored pages. */
function header() {
  return `<header class="nav" id="site-nav">
    <div class="wrap">
      <a class="brand" href="/"><img src="/assets/veyago-icon.png" alt="" aria-hidden="true" width="22" height="22" /> Veyago</a>
      <nav class="nav-links">
        <a href="/apps/">Apps</a>
        <a href="/projects/">Projects</a>
        <a href="/journal/">Articles</a>
        <a href="/services/">Services</a>
        <a href="/websites/">Websites</a>
        <div class="nav-item" id="company-nav">
          <button class="nav-drop-btn" aria-expanded="false" aria-haspopup="true">Company <svg class="nav-chev" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="nav-dropdown">
            <a href="/company/"><span class="dd-title">About</span><span class="dd-sub">The studio and our story</span></a>
            <a href="/team/"><span class="dd-title">Team</span><span class="dd-sub">The people building it</span></a>
            <a href="/approach/"><span class="dd-title">Approach</span><span class="dd-sub">How we think and build</span></a>
          </div>
        </div>
      </nav>
      <div class="nav-right">
        <a class="nav-cta" href="mailto:hello@veyago.cloud">Contact</a>
        <button class="nav-toggle" id="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="nav-drawer">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
  </header>

  <div class="nav-scrim" id="nav-scrim"></div>
  <aside class="nav-drawer" id="nav-drawer" role="dialog" aria-modal="true" aria-label="Menu" aria-hidden="true">
    <div class="nav-drawer-top">
      <button class="nav-drawer-close" id="nav-drawer-close" aria-label="Close menu">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <nav class="nav-drawer-links" aria-label="Primary">
      <a href="/apps/">Apps</a>
      <a href="/projects/">Projects</a>
      <a href="/journal/">Articles</a>
      <a href="/services/">Services</a>
      <a href="/websites/">Websites</a>
      <p class="nm-label">Company</p>
      <a class="nm-sub" href="/company/">About</a>
      <a class="nm-sub" href="/team/">Team</a>
      <a class="nm-sub" href="/approach/">Approach</a>
      <a class="nav-cta nm-cta" href="mailto:hello@veyago.cloud">Contact</a>
    </nav>
  </aside>`;
}

/* The site footer. Keep in lockstep with the hand-authored pages. */
function footer() {
  return `<footer class="footer">
    <div class="wrap">
      <p class="legal-top">Veyago Inc. is a New York C-Corporation. App Store is a trademark of Apple Inc. Apple Intelligence availability varies by device and region.</p>
      <div class="footer-cols">
        <div><h5>Apps</h5><a href="/veyago/">Veyago travel</a><a href="/kept/">Kept</a></div>
        <div><h5>Company</h5><a href="/company/">About</a><a href="/team/">Team</a><a href="/approach/">Approach</a><a href="/services/">Services</a><a href="/websites/">Websites</a><a href="/projects/">Projects</a><a href="/journal/">Articles</a><a href="/wallpapers/">Wallpapers</a><a href="mailto:hello@veyago.cloud">Contact</a></div>
        <div><h5>Legal</h5><a href="/privacy/">Privacy Policy</a><a href="/kept-privacy/">Kept Privacy</a><a href="/terms/">Terms</a><a href="/legal/">Legal / Imprint</a></div>
        <div><h5>Get in touch</h5><a href="mailto:hello@veyago.cloud">hello@veyago.cloud</a><a href="/support/">Support</a><a href="https://instagram.com/veyago_cloud" target="_blank" rel="noopener">Instagram ↗</a><a href="https://veyago.app" target="_blank" rel="noopener">veyago.app ↗</a></div>
      </div>
      <div class="footer-base">
        <span>&copy; <span id="year">2026</span> Veyago Inc · New York C-Corp</span>
        <span>Incorporated April 2026 · Launching Q3 2026</span>
      </div>
    </div>
  </footer>`;
}

/* Assemble a full document. `scripts` is a list of extra <script src> appended after app.js. */
function page(opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var scripts = (opts.scripts || [])
    .map(function (src) { return '  <script src="' + attr(src) + '" defer></script>'; })
    .join('\n');
  return '<!DOCTYPE html>\n' +
    '<html lang="' + attr(lang) + '">\n' +
    '<head>\n  ' + headTags(opts.head || {}) + '\n</head>\n' +
    '<body>\n  ' + header() + '\n\n' +
    opts.body + '\n\n' +
    '  ' + footer() + '\n' +
    '  <script src="/assets/js/site-config.js"></script>\n' +
    '  <script src="/app.js" defer></script>\n' +
    (scripts ? scripts + '\n' : '') +
    '</body>\n</html>\n';
}

module.exports = { headTags, header, footer, page, SITE, DEFAULT_OG_IMAGE };
