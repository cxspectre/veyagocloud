/* Render the journal: the index (/journal/) and each article (/journal/<slug>/).
   Articles reuse the existing essay layout (.paper-*) so they match the research
   papers; the body comes from the shared block renderer. */
'use strict';

var { esc, attr } = require('./escape');
var { page, SITE, DEFAULT_OG_IMAGE } = require('./chrome');
var { renderBlocks } = require('./render-blocks');
var { readingMinutes } = require('./reading-time');
var { formatDate, isoDate, absoluteUrl } = require('./format');
var { newsletterSection } = require('./newsletter-embed');
var { articleHeadExtra, indexHeadExtra } = require('./journal-schema');

var JOURNAL_ACCENT = '#0071e3';
var INDEX_TITLE = 'Articles';
var INDEX_LEDE = 'Field notes from the studio on fast, private software: why builder sites are slow, what a fixed-price website really includes, and how we build.';

/* Description used for list cards + social preview. */
function articleSummary(a) {
  return a.excerpt || a.dek || '';
}

function metaLine(a, minutes) {
  var date = formatDate(a.published_at);
  var read = minutes ? minutes + ' min read' : '';
  return [date, read].filter(Boolean).join(' · ');
}

/* The masthead line on an article page. A plain-text date tells a crawler
   nothing; <time datetime> and a linked author do, and the visible byline is
   what a quality rater looks for first. */
function bylineBlock(a, minutes) {
  var published = isoDate(a.published_at);
  var updated = isoDate(a.updated_at);
  var parts = ['<time datetime="' + attr(published) + '">' + esc(formatDate(a.published_at)) + '</time>'];
  if (updated && updated !== published) {
    parts.push('updated <time datetime="' + attr(updated) + '">' + esc(formatDate(a.updated_at)) + '</time>');
  }
  if (minutes) parts.push(esc(minutes + ' min read'));
  return '<p class="byline">' +
    '<img src="/assets/cassian-drefke-240w.webp" alt="" width="34" height="34" loading="lazy" decoding="async" />' +
    '<span>By <a href="/team/#cassian-drefke" rel="author">Cassian Drefke</a>, Founder &amp; CEO · ' +
    parts.join(' · ') + '</span></p>';
}

/* Closing author box: who wrote this, why they would know, and where to go next. */
function authorBox() {
  return `<aside class="author-box">
          <img src="/assets/cassian-drefke-240w.webp" alt="Cassian Drefke" width="64" height="64" loading="lazy" decoding="async" />
          <div>
            <span class="ab-role">Written by</span>
            <h2><a href="/team/#cassian-drefke" rel="author">Cassian Drefke</a> — Founder &amp; CEO, Veyago Inc.</h2>
            <p>Cassian founded Veyago in New York in April 2026. He designs and builds the studio's iOS apps and every client website it ships, which is where the numbers in these notes come from. Write to <a href="mailto:hello@veyago.cloud">hello@veyago.cloud</a> and he answers within one working day.</p>
          </div>
        </aside>`;
}

/* One article page → full HTML document string. `next` is the article a reader
   should go to from here; without it every article was a dead end that only
   pointed back at the index, which is both a worse read and a worse crawl. */
function renderArticlePage(a, next) {
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
          ${bylineBlock(a, minutes)}
        </div>
        ${cover}<div class="paper-body">
        ${rendered.html}
        </div>
        ${authorBox()}
        ${newsletterSection({ id: 'article', heading: 'Want the next field note?' })}
        <footer class="paper-foot">
          <div class="pf-nav">
            <a class="pf-back" href="/journal/">&larr; All articles</a>
            ${readNext(next)}
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
      /* share_image is the card built for the link preview; cover_image_url is
         artwork shown on the page itself. They are different jobs. */
      ogImage: absoluteUrl(a.share_image || a.cover_image_url) || DEFAULT_OG_IMAGE,
      ogImageAlt: a.title + ' — a field note from Veyago',
      extra: articleHeadExtra(a)
    },
    body: body,
    scripts: ['/assets/js/newsletter.js']
  });
}

/* The "read next" link in an article's footer, matching the research papers'. */
function readNext(next) {
  if (!next || !next.slug) return '';
  return '<a class="pf-next" href="/journal/' + attr(next.slug) + '/">' +
    '<span class="pf-next-k">Read next</span>' +
    '<span class="pf-next-t">' + esc(next.title) + ' &rarr;</span></a>';
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
      title: 'Field notes on private software and fast sites | Veyago',
      ogImageAlt: 'Veyago field notes — writing from an independent New York studio',
      description: INDEX_LEDE,
      canonical: SITE + '/journal/',
      ogType: 'website',
      /* An empty index is a placeholder, not a page worth ranking: keep crawlers
         following the links but out of the index until the first article lands. */
      robots: articles && articles.length ? 'index,follow' : 'noindex,follow',
      extra: indexHeadExtra(articles)
    },
    body: body
  });
}

module.exports = { renderArticlePage, renderJournalIndex };
