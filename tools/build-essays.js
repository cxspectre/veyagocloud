/* Render research Markdown papers (data/research/<slug>.md) into static essay
   pages at /projects/<slug>/index.html, wrapped in the site chrome.
   Run after adding/editing a paper:  node tools/build-essays.js
   A limited Markdown subset is supported: #/##/### headings, paragraphs,
   **bold**, bare URLs (linkified), --- dividers. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'research');
const OUT = path.join(ROOT, 'projects');

// Per-paper metadata (SEO + cross-link to the related app).
const ESSAYS = {
  'the-unkept-life': {
    description: 'Why personal life admin fails - and the case for a private, on-device system of record. The research behind Kept.',
    related: { label: 'Kept', href: '/kept/' },
  },
  'the-edge-moves-in': {
    description: 'How intelligence is migrating to the device, WWDC 2026 as its consumer inflection point, and what it means for privacy-first software.',
    related: null,
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trail = (m.match(/[.,;]+$/) || [''])[0];
    const url = m.slice(0, m.length - trail.length);
    return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' + trail;
  });
  return s;
}

function parse(md) {
  const lines = md.split('\n');
  let title = '', dek = '', byline = '', seenH2 = false, inRefs = false;
  const body = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    body.push('<p' + (inRefs ? ' class="ref"' : '') + '>' + inline(para.join(' ')) + '</p>');
    para = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (t === '') { flush(); continue; }
    if (t === '---') { flush(); continue; }
    if (!title && t.startsWith('# ')) { title = t.slice(2).trim(); continue; }
    if (t.startsWith('## ')) {
      flush();
      const h = t.slice(3).trim();
      seenH2 = true;
      if (/^references$/i.test(h)) inRefs = true;
      body.push('<h2>' + inline(h) + '</h2>');
      continue;
    }
    if (t.startsWith('### ')) {
      const h = t.slice(4).trim();
      if (!seenH2) { dek = h; continue; }   // top subtitle, before any ##
      flush();
      body.push('<h3>' + inline(h) + '</h3>');
      continue;
    }
    if (!seenH2 && !byline) { byline = t; continue; }   // the byline line under the dek
    para.push(t);
  }
  flush();
  return { title, dek, byline, body: body.join('\n        ') };
}

function page(slug, meta, doc) {
  const url = 'https://www.veyago.cloud/projects/' + slug + '/';
  const related = meta.related
    ? '\n        <p class="paper-related">The product designed in response to this research: <a href="' + meta.related.href + '">' + meta.related.label + ' ›</a></p>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(doc.title)} | Veyago research</title>
  <meta name="description" content="${esc(meta.description)}" />
  <meta name="theme-color" content="#ffffff" />
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
  <link rel="stylesheet" href="/styles.css" />
  <meta property="og:title" content="${esc(doc.title)} | Veyago research" />
  <meta property="og:description" content="${esc(meta.description)}" />
  <meta property="og:image" content="https://www.veyago.cloud/assets/og.png" />
  <meta property="og:type" content="article" />
  <link rel="canonical" href="${url}" />
  <meta name="robots" content="index,follow" />
  <meta property="og:url" content="${url}" />
  <meta property="og:site_name" content="Veyago" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@veyago_cloud" />
  <meta name="twitter:title" content="${esc(doc.title)} | Veyago research" />
  <meta name="twitter:description" content="${esc(meta.description)}" />
  <meta name="twitter:image" content="https://www.veyago.cloud/assets/og.png" />
</head>
<body>
  <header class="nav" id="site-nav">
    <div class="wrap">
      <a class="brand" href="/"><img src="/assets/veyago-icon.png" alt="" aria-hidden="true" width="22" height="22" /> Veyago</a>
      <nav class="nav-links">
        <a href="/apps/">Apps</a>
        <a href="/projects/">Projects</a>
        <a href="/services/">Services</a>
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
      <a href="/services/">Services</a>
      <p class="nm-label">Company</p>
      <a class="nm-sub" href="/company/">About</a>
      <a class="nm-sub" href="/team/">Team</a>
      <a class="nm-sub" href="/approach/">Approach</a>
      <a class="nav-cta nm-cta" href="mailto:hello@veyago.cloud">Contact</a>
    </nav>
  </aside>

  <article class="paper">
    <div class="wrap">
      <p class="paper-kicker"><a href="/projects/">&larr; Projects</a> · Working paper</p>
      <h1 class="paper-title">${esc(doc.title)}</h1>
      <p class="paper-dek">${esc(doc.dek)}</p>
      <p class="paper-meta">${esc(doc.byline)}</p>
      <div class="paper-body">
        ${doc.body}${related}
      </div>
    </div>
  </article>

  <footer class="footer">
    <div class="wrap">
      <p class="legal-top">Veyago Inc. is a New York C-Corporation. App Store is a trademark of Apple Inc. Apple Intelligence availability varies by device and region.</p>
      <div class="footer-cols">
        <div><h5>Apps</h5><a href="/veyago/">Veyago travel</a><a href="/kept/">Kept</a></div>
        <div><h5>Company</h5><a href="/company/">About</a><a href="/team/">Team</a><a href="/approach/">Approach</a><a href="/services/">Services</a><a href="/projects/">Projects</a></div>
        <div><h5>Legal</h5><a href="/privacy/">Privacy Policy</a><a href="/kept-privacy/">Kept Privacy</a><a href="/terms/">Terms</a><a href="/legal/">Legal / Imprint</a></div>
        <div><h5>Get in touch</h5><a href="mailto:hello@veyago.cloud">hello@veyago.cloud</a><a href="/support/">Support</a><a href="https://instagram.com/veyago_cloud" target="_blank" rel="noopener">Instagram ↗</a><a href="https://veyago.app" target="_blank" rel="noopener">veyago.app ↗</a></div>
      </div>
      <div class="footer-base">
        <span>&copy; <span id="year">2026</span> Veyago Inc · New York C-Corp</span>
        <span>Incorporated April 2026 · Launching Q3 2026</span>
      </div>
    </div>
  </footer>
  <script src="/app.js" defer></script>
</body>
</html>
`;
}

let built = 0;
for (const slug of Object.keys(ESSAYS)) {
  const md = fs.readFileSync(path.join(SRC, slug + '.md'), 'utf8');
  const doc = parse(md);
  const dir = path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page(slug, ESSAYS[slug], doc));
  console.log('built /projects/' + slug + '/  (' + doc.title + ')');
  built++;
}
console.log(built + ' essay page(s) generated.');
