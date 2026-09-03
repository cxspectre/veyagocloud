/* Render the journal: the index (/journal/) and each article (/journal/<slug>/).
   Articles reuse the existing essay layout (.paper-*) so they match the research
   papers; the body comes from the shared block renderer. */
'use strict';

var { esc, attr } = require('./escape');
var { page, SITE, DEFAULT_OG_IMAGE } = require('./chrome');
var { renderBlocks } = require('./render-blocks');
var { readingMinutes } = require('./reading-time');
var { formatDate, absoluteUrl } = require('./format');
var { newsletterSection } = require('./newsletter-embed');

var JOURNAL_ACCENT = '#0071e3';
var INDEX_TITLE = 'Articles';
var INDEX_LEDE = 'Build logs, research notes, and the occasional opinion from the studio.';

/* Description used for list cards + social preview. */
function articleSummary(a) {
  return a.excerpt || a.dek || '';
}

function metaLine(a, minutes) {
  var date = formatDate(a.published_at);
  var read = minutes ? minutes + ' min read' : '';
  return [date, read].filter(Boolean).join(' · ');
}

/* One article page → full HTML document string. */
function renderArticlePage(a) {
  var rendered = renderBlocks(a.body || []);
  var minutes = a.reading_minutes || readingMinutes(a.body || []);
  var canonical = SITE + '/journal/' + a.slug + '/';

  var tocCol = rendered.toc.length >= 2
    ? '<nav class="paper-toc" aria-label="Contents">\n        <p class="ptoc-label">Contents</p>\n        <ol>\n          ' +
      rendered.toc.map(function (s) {
        return '<li><a href="#' + attr(s.id) + '">' + esc(s.label) + '</a></li>';
      }).join('\n          ') +
      '\n        </ol>\n      </nav>'
    : '';

  var cover = a.cover_image_url
    ? '<figure class="paper-cover"><img src="' + attr(a.cover_image_url) + '" alt="' + attr(a.title) + '" /></figure>\n        '
    : '';

  var dek = a.dek ? '<p class="paper-dek">' + esc(a.dek) + '</p>' : '';

  var body = `  <article class="paper paper-journal" style="--st:${JOURNAL_ACCENT}">
    <div class="paper-shell">
      ${tocCol}
      <div class="paper-main">
        <div class="paper-masthead">
          <p class="paper-kicker"><a href="/journal/">&larr; Articles</a></p>
          <h1 class="paper-title">${esc(a.title)}</h1>
          ${dek}
          <p class="paper-meta">${esc(metaLine(a, minutes))}</p>
        </div>
        ${cover}<div class="paper-body">
        ${rendered.html}
        </div>
        ${newsletterSection({ id: 'article', heading: 'Want the next field note?' })}
        <footer class="paper-foot">
          <div class="pf-nav">
            <a class="pf-back" href="/journal/">&larr; All articles</a>
          </div>
        </footer>
      </div>
    </div>
  </article>`;

  return page({
    lang: 'en',
    head: {
      title: a.title + ' | Veyago',
      description: articleSummary(a),
      canonical: canonical,
      ogType: 'article',
      ogImage: a.cover_image_url ? absoluteUrl(a.cover_image_url) : DEFAULT_OG_IMAGE
    },
    body: body,
    scripts: ['/assets/js/newsletter.js']
  });
}

/* One list card for the index. */
function articleCard(a) {
  var minutes = a.reading_minutes || readingMinutes(a.body || []);
  var cover = a.cover_image_url
    ? '<div class="jc-cover"><img src="' + attr(a.cover_image_url) + '" alt="" loading="lazy" /></div>'
    : '';
  var summary = articleSummary(a);
  return `<a class="card journal-card" href="/journal/${attr(a.slug)}/">
          ${cover}
          <div class="jc-body">
            <p class="eyebrow">${esc(metaLine(a, minutes))}</p>
            <h3 class="jc-title">${esc(a.title)}</h3>
            ${summary ? '<p class="jc-dek">' + esc(summary) + '</p>' : ''}
          </div>
        </a>`;
}

/* The /journal/ index page → full HTML document string. */
function renderJournalIndex(articles) {
  var cards = (articles || []).map(articleCard).join('\n        ');
  var grid = articles && articles.length
    ? '<div class="journal-grid">\n        ' + cards + '\n      </div>'
    : '<p class="ji-empty">No articles yet — the first field note is on its way.</p>';

  var body = `  <main class="journal-index" id="main">
    <section class="section">
      <div class="wrap">
        <header class="ji-head">
          <p class="eyebrow">Articles</p>
          <h1>Field notes</h1>
          <p class="lede">${INDEX_LEDE}</p>
        </header>
        ${grid}
      </div>
    </section>
  </main>`;

  return page({
    lang: 'en',
    head: {
      title: 'Articles | Veyago',
      description: INDEX_LEDE,
      canonical: SITE + '/journal/',
      ogType: 'website',
      /* An empty index is a placeholder, not a page worth ranking: keep crawlers
         following the links but out of the index until the first article lands. */
      robots: articles && articles.length ? 'index,follow' : 'noindex,follow'
    },
    body: body
  });
}

module.exports = { renderArticlePage, renderJournalIndex };
