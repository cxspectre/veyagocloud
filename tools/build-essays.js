/* Render research Markdown papers (data/research/<slug>.md) into static essay
   pages at /projects/<slug>/index.html, wrapped in the site chrome with a
   designed masthead, a sticky table of contents (scroll-spy in app.js), and an
   end-of-paper footer. Run after adding/editing a paper:
     node tools/build-essays.js
   Supported Markdown subset: #/##/### headings, paragraphs, **bold**, bare
   URLs (linkified), --- dividers.

   As a module it exports renderEssays(), which builds every page in memory
   without writing; tools/check.js uses that to prove the committed pages match
   the sources. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { page: renderPage, SITE, DEFAULT_OG_IMAGE } = require('./lib/chrome');
const { esc } = require('./lib/escape');
const entity = require('./lib/entity');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'research');
const OUT_DIR = 'projects';

// Per-paper metadata: SEO description, accent colour (matches the pipeline stage
// colour on /projects/), the related app (cross-link to the Apps page), and the
// publication date (the day the paper first landed on the site — git 941db4d).
const ESSAYS = {
  'the-unkept-life': {
    description: 'Why personal life admin fails - and the case for a private, on-device system of record. The research behind Kept.',
    accent: '#0071e3',
    related: { label: 'Kept', href: '/apps/#kept' },
    published: '2026-06-12',
    ogImage: '/assets/og-paper-unkept-life.png',
  },
  'the-edge-moves-in': {
    description: 'How intelligence is migrating to the device, WWDC 2026 as its consumer inflection point, and what it means for privacy-first software.',
    accent: '#0a8d7c',
    related: null,
    published: '2026-06-12',
    ogImage: '/assets/og-paper-edge-moves-in.png',
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
/* A reference reads "Author, title, publication, https://…". Auto-linking the
   naked URL gives crawlers an anchor whose text is the URL itself, which says
   nothing about the target and reads badly. Linking the description that
   precedes it says exactly what is on the other end. Lines without a trailing
   URL (a source cited but not linked) are left as prose. */
function reference(s) {
  const m = s.match(/^([\s\S]+?)[,;]?\s+(https?:\/\/\S+)$/);
  if (!m) return inline(s);
  return '<a href="' + m[2] + '" target="_blank" rel="noopener">' + inline(m[1]) + '</a>';
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

/* "Author, title, publication, https://…" → a CreativeWork node. The URL is
   split off so the citation carries a name and a target rather than one blob. */
function citation(line) {
  const m = line.match(/^([\s\S]+?)[,;]?\s+(https?:\/\/\S+)$/);
  if (!m) return { '@type': 'CreativeWork', name: line };
  return { '@type': 'CreativeWork', name: m[1].trim(), url: m[2] };
}

function parse(md) {
  const lines = md.split('\n');
  let title = '', dek = '', byline = '', seenH2 = false, inRefs = false;
  const body = [], toc = [], references = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ');
    if (inRefs) references.push(citation(text));
    body.push(inRefs
      ? '<p class="ref">' + reference(text) + '</p>'
      : '<p>' + inline(text) + '</p>');
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
  return { title, dek, byline, body: body.join('\n        '), toc, references };
}

const ORG_ID = SITE + '/#organization';

// "2026-06-12" → "12 June 2026", the visible half of a <time datetime> pair.
function longDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// Date of the last commit that touched the paper's source, so dateModified tracks
// real edits. A source with uncommitted edits is dated today — the date the next
// commit will carry — so a page regenerated alongside an edit stays fresh once
// both are committed (tools/check.js compares them). Falls back to the
// publication date outside a git checkout.
function lastModified(slug, fallback) {
  const source = path.join('data', 'research', slug + '.md');
  try {
    if (git(['status', '--porcelain', '--', source])) return new Date().toISOString().slice(0, 10);
    const out = git(['log', '-1', '--format=%cs', '--', source]);
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : fallback;
  } catch (err) {
    return fallback;
  }
}

// Structured data for one paper. `Report` matches what /projects/ already declares
// for these two papers in its CollectionPage, and the Organization @id is the same
// node, so the graphs join up.
function jsonLd(slug, meta, doc, url) {
  const report = {
    '@type': 'Report',
    '@id': url + '#report',
    headline: doc.title,
    description: meta.description,
    abstract: doc.dek,
    url: url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: meta.ogImage ? SITE + meta.ogImage : DEFAULT_OG_IMAGE,
    inLanguage: 'en',
    isAccessibleForFree: true,
    datePublished: meta.published,
    dateModified: lastModified(slug, meta.published),
    author: entity.authorRef(),
    publisher: { '@id': ORG_ID },
    learningResourceType: 'Working paper',
    genre: 'Research report',
    citation: doc.references,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.paper-title', '.paper-dek'] },
  };
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      report,
      entity.founder(),
      entity.breadcrumb([
        { name: 'Home', url: SITE + '/' },
        { name: 'Projects', url: SITE + '/projects/' },
        { name: doc.title },
      ]),
    ],
  };
  // "</" can never close the script element early, whatever a title contains.
  return JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');
}

// Extra <head> tags: the JSON-LD block plus the Open Graph article properties
// (og:type is already "article"; these give it a date and a byline).
function headExtra(slug, meta, doc, url) {
  return [
    '<meta name="author" content="Cassian Drefke" />',
    '<meta property="article:published_time" content="' + meta.published + '" />',
    '<meta property="article:modified_time" content="' + lastModified(slug, meta.published) + '" />',
    '<meta property="article:author" content="' + SITE + '/team/#cassian-drefke" />',
    '<link rel="alternate" type="application/rss+xml" title="Veyago field notes" href="' + SITE + '/feed.xml" />',
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
          <p class="byline"><img src="/assets/cassian-drefke-240w.webp" alt="" width="34" height="34" loading="lazy" decoding="async" /><span>By <a href="/team/#cassian-drefke" rel="author">Cassian Drefke</a>, Founder &amp; CEO · published <time datetime="${meta.published}">${esc(longDate(meta.published))}</time> · updated <time datetime="${lastModified(slug, meta.published)}">${esc(longDate(lastModified(slug, meta.published)))}</time></span></p>
        </div>
        <div class="paper-body">
        ${doc.body}
        </div>
        <aside class="author-box">
          <img src="/assets/cassian-drefke-240w.webp" alt="Cassian Drefke" width="64" height="64" loading="lazy" decoding="async" />
          <div>
            <span class="ab-role">Written by</span>
            <h2><a href="/team/#cassian-drefke" rel="author">Cassian Drefke</a> — Founder &amp; CEO, Veyago Inc.</h2>
            <p>Cassian founded Veyago in New York in April 2026 and writes the studio's working papers himself. Each one is the research that precedes a build rather than marketing written after it. Corrections and disagreements to <a href="mailto:hello@veyago.cloud">hello@veyago.cloud</a>.</p>
          </div>
        </aside>
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
      ogImage: meta.ogImage ? SITE + meta.ogImage : DEFAULT_OG_IMAGE,
      ogImageAlt: doc.title + ' — a Veyago working paper',
      extra: headExtra(slug, meta, doc, url)
    },
    body
  });
}

// The papers as feed entries: title and dek from the Markdown, dates from git.
function feedItems() {
  return Object.keys(ESSAYS).map((slug) => {
    const doc = parse(fs.readFileSync(path.join(SRC, slug + '.md'), 'utf8'));
    return {
      title: doc.title,
      url: SITE + '/projects/' + slug + '/',
      description: ESSAYS[slug].description,
      date: lastModified(slug, ESSAYS[slug].published),
      categories: ['Research'],
    };
  });
}

// Every paper, rendered in memory: [{ slug, file, html, title, sections }], where
// `file` is repo-relative (projects/<slug>/index.html). Nothing is written. All
// papers are parsed first so "Read next" can name the other paper's title.
function renderEssays() {
  const slugs = Object.keys(ESSAYS);
  const docs = Object.fromEntries(slugs.map((slug) => [slug, parse(fs.readFileSync(path.join(SRC, slug + '.md'), 'utf8'))]));
  return slugs.map((slug, i) => {
    const nextSlug = slugs[(i + 1) % slugs.length];
    const next = nextSlug !== slug ? { slug: nextSlug, title: docs[nextSlug].title } : null;
    return {
      slug,
      file: path.posix.join(OUT_DIR, slug, 'index.html'),
      html: page(slug, ESSAYS[slug], docs[slug], next),
      title: docs[slug].title,
      sections: docs[slug].toc.length,
    };
  });
}

function main() {
  const pages = renderEssays();
  for (const p of pages) {
    const file = path.join(ROOT, p.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, p.html);
    console.log('built /projects/' + p.slug + '/  (' + p.title + ', ' + p.sections + ' sections)');
  }
  console.log(pages.length + ' essay page(s) generated.');
}

module.exports = { renderEssays, parse, ESSAYS, feedItems };

if (require.main === module) main();
