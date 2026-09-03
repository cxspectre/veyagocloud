/* Render research Markdown papers (data/research/<slug>.md) into static essay
   pages at /projects/<slug>/index.html, wrapped in the site chrome with a
   designed masthead, a sticky table of contents (scroll-spy in app.js), and an
   end-of-paper footer. Run after adding/editing a paper:
     node tools/build-essays.js
   Supported Markdown subset: #/##/### headings, paragraphs, **bold**, bare
   URLs (linkified), --- dividers. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { page: renderPage, SITE, DEFAULT_OG_IMAGE } = require('./lib/chrome');
const { esc } = require('./lib/escape');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'research');
const OUT = path.join(ROOT, 'projects');

// Per-paper metadata: SEO description, accent colour (matches the pipeline stage
// colour on /projects/), the related app (cross-link to the Apps page), and the
// publication date (the day the paper first landed on the site — git 941db4d).
const ESSAYS = {
  'the-unkept-life': {
    description: 'Why personal life admin fails - and the case for a private, on-device system of record. The research behind Kept.',
    accent: '#0071e3',
    related: { label: 'Kept', href: '/apps/#kept' },
    published: '2026-06-12',
  },
  'the-edge-moves-in': {
    description: 'How intelligence is migrating to the device, WWDC 2026 as its consumer inflection point, and what it means for privacy-first software.',
    accent: '#0a8d7c',
    related: null,
    published: '2026-06-12',
  },
};

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
const sectionId = (h) => {
  const m = h.match(/^(\d+)\./);
  if (m) return 'section-' + m[1];
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};
const tocLabel = (h) => h.split(':')[0].trim();
function headingHtml(h) {
  const m = h.match(/^(\d+\.)\s*([\s\S]*)$/);
  if (m) return '<span class="sec-n">' + m[1] + '</span> ' + inline(m[2]);
  return inline(h);
}

function parse(md) {
  const lines = md.split('\n');
  let title = '', dek = '', byline = '', seenH2 = false, inRefs = false;
  const body = [], toc = [];
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
      const id = sectionId(h);
      toc.push({ id, label: tocLabel(h) });
      if (/^references$/i.test(h)) inRefs = true;
      body.push('<h2 id="' + id + '">' + headingHtml(h) + '</h2>');
      continue;
    }
    if (t.startsWith('### ')) {
      const h = t.slice(4).trim();
      if (!seenH2) { dek = h; continue; }
      flush();
      body.push('<h3>' + inline(h) + '</h3>');
      continue;
    }
    if (!seenH2 && !byline) { byline = t; continue; }
    para.push(t);
  }
  flush();
  return { title, dek, byline, body: body.join('\n        '), toc };
}

const ORG_ID = SITE + '/#organization';

// Date of the last commit that touched the paper's source, so dateModified tracks
// real edits. Falls back to the publication date outside a git checkout.
function lastModified(slug, fallback) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', path.join('data', 'research', slug + '.md')], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : fallback;
  } catch (err) {
    return fallback;
  }
}

// Structured data for one paper. `Report` matches what /projects/ already declares
// for these two papers in its CollectionPage, and the Organization @id is the same
// node, so the graphs join up.
function jsonLd(slug, meta, doc, url) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Report',
    '@id': url + '#report',
    headline: doc.title,
    description: meta.description,
    abstract: doc.dek,
    url: url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: DEFAULT_OG_IMAGE,
    inLanguage: 'en',
    isAccessibleForFree: true,
    datePublished: meta.published,
    dateModified: lastModified(slug, meta.published),
    author: { '@type': 'Organization', '@id': ORG_ID, name: 'Veyago Inc.', url: SITE + '/' },
    publisher: { '@id': ORG_ID },
  };
  // "</" can never close the script element early, whatever a title contains.
  return JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');
}

// Extra <head> tags: the JSON-LD block plus the Open Graph article properties
// (og:type is already "article"; these give it a date and a byline).
function headExtra(slug, meta, doc, url) {
  return [
    '<meta name="author" content="Veyago Inc." />',
    '<meta property="article:published_time" content="' + meta.published + '" />',
    '<meta property="article:author" content="Veyago Inc." />',
    '<script type="application/ld+json">\n  ' + jsonLd(slug, meta, doc, url).replace(/\n/g, '\n  ') + '\n  </script>',
  ].join('\n  ');
}

function page(slug, meta, doc, next) {
  const url = SITE + '/projects/' + slug + '/';
  const toc = doc.toc.map((s) => '<li><a href="#' + s.id + '">' + esc(s.label) + '</a></li>').join('\n          ');
  const related = meta.related
    ? '\n        <p class="pf-related">The product designed in response to this research: <a href="' + meta.related.href + '">' + meta.related.label + ' &rsaquo;</a></p>'
    : '';
  const readNext = next
    ? '<a class="pf-next" href="/projects/' + next.slug + '/"><span class="pf-next-k">Read next</span><span class="pf-next-t">' + esc(next.title) + ' &rarr;</span></a>'
    : '';
  const body = `  <main id="main">
  <article class="paper" style="--st:${meta.accent}">
    <div class="paper-shell">
      <nav class="paper-toc" aria-label="Contents">
        <p class="ptoc-label">Contents</p>
        <ol>
          ${toc}
        </ol>
      </nav>
      <div class="paper-main">
        <div class="paper-masthead">
          <p class="paper-kicker"><a href="/projects/">&larr; Projects</a> · Working paper</p>
          <h1 class="paper-title">${esc(doc.title)}</h1>
          <p class="paper-dek">${esc(doc.dek)}</p>
          <p class="paper-meta">${esc(doc.byline)}</p>
        </div>
        <div class="paper-body">
        ${doc.body}
        </div>
        <footer class="paper-foot">${related}
          <div class="pf-nav">
            <a class="pf-back" href="/projects/">&larr; All projects</a>
            ${readNext}
          </div>
        </footer>
      </div>
    </div>
  </article>
  </main>`;
  return renderPage({
    lang: 'en',
    head: {
      title: doc.title + ' | Veyago research',
      description: meta.description,
      canonical: url,
      ogType: 'article',
      extra: headExtra(slug, meta, doc, url)
    },
    body
  });
}

// Parse all first so "Read next" can reference the other papers' titles.
const slugs = Object.keys(ESSAYS);
const docs = {};
for (const slug of slugs) docs[slug] = parse(fs.readFileSync(path.join(SRC, slug + '.md'), 'utf8'));

let built = 0;
for (let i = 0; i < slugs.length; i++) {
  const slug = slugs[i];
  const nextSlug = slugs[(i + 1) % slugs.length];
  const next = nextSlug !== slug ? { slug: nextSlug, title: docs[nextSlug].title } : null;
  const dir = path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page(slug, ESSAYS[slug], docs[slug], next));
  console.log('built /projects/' + slug + '/  (' + docs[slug].title + ', ' + docs[slug].toc.length + ' sections)');
  built++;
}
console.log(built + ' essay page(s) generated.');
