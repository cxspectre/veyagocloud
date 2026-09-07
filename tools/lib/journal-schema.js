/* Structured data for /journal/ — the article pages and the index.

   The research papers under /projects/ have declared Report schema since they
   shipped (tools/build-essays.js); the journal never did, so every article went
   out with no machine-readable author, date or publisher at all. These are the
   pages meant to earn search traffic, so that gap is worth closing.

   Both graphs reference the same Organization node the hand-authored pages
   declare (https://www.veyago.cloud/#organization) rather than restating it, so
   the site resolves to one publisher rather than a dozen look-alikes. */
'use strict';

var { SITE, DEFAULT_OG_IMAGE } = require('./chrome');
var { isoDate, absoluteUrl } = require('./format');
var { countWords, stripTags } = require('./reading-time');

var ORG_ID = SITE + '/#organization';
var JOURNAL_URL = SITE + '/journal/';

function articleUrl(a) { return SITE + '/journal/' + a.slug + '/'; }

function summary(a) { return a.excerpt || a.dek || ''; }

/* The words a reader actually reads — the same accounting reading time uses, so
   the two numbers can never disagree on the page. */
function wordCount(blocks) {
  return (blocks || []).reduce(function (n, b) {
    if (!b || !b.type) return n;
    if (b.type === 'text') return n + countWords(stripTags(b.html));
    if (b.type === 'heading') return n + countWords(b.text);
    if (b.type === 'quote') return n + countWords(b.text) + countWords(b.attribution);
    if (b.type === 'section_marker') return n + countWords(b.text);
    if (b.type === 'image') return n + countWords(b.caption);
    return n;
  }, 0);
}

/* A crawler reads the raw bytes, not the parsed string: an unescaped "</script>"
   inside a title would end the block early and leave the rest as page text. */
function serialise(data) {
  return JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');
}

function breadcrumb(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(function (step, i) {
      var item = { '@type': 'ListItem', position: i + 1, name: step.name };
      if (step.url) item.item = step.url;
      return item;
    })
  };
}

function blogPosting(a) {
  var url = articleUrl(a);
  var published = isoDate(a.published_at);
  return {
    '@type': 'BlogPosting',
    '@id': url + '#article',
    headline: a.title,
    description: summary(a),
    url: url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: a.cover_image_url ? absoluteUrl(a.cover_image_url) : DEFAULT_OG_IMAGE,
    inLanguage: 'en',
    isAccessibleForFree: true,
    wordCount: wordCount(a.body),
    datePublished: published,
    dateModified: isoDate(a.updated_at) || published,
    author: { '@type': 'Organization', '@id': ORG_ID, name: 'Veyago Inc.', url: SITE + '/' },
    publisher: { '@id': ORG_ID },
    isPartOf: { '@type': 'Blog', '@id': JOURNAL_URL + '#blog' }
  };
}

/* One article page's graph: the post itself plus where it sits in the site. */
function articleJsonLd(a) {
  return serialise({
    '@context': 'https://schema.org',
    '@graph': [
      blogPosting(a),
      breadcrumb([
        { name: 'Home', url: SITE + '/' },
        { name: 'Articles', url: JOURNAL_URL },
        { name: a.title }
      ])
    ]
  });
}

/* The index's graph: the Blog and everything on it. */
function indexJsonLd(articles) {
  return serialise({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Blog',
        '@id': JOURNAL_URL + '#blog',
        name: 'Field notes',
        description: 'Build logs, research notes, and the occasional opinion from the studio.',
        url: JOURNAL_URL,
        inLanguage: 'en',
        publisher: { '@id': ORG_ID },
        blogPost: (articles || []).map(blogPosting)
      },
      breadcrumb([
        { name: 'Home', url: SITE + '/' },
        { name: 'Articles' }
      ])
    ]
  });
}

/* Extra <head> markup for an article: the graph plus the Open Graph article
   properties, which og:type="article" implies but does not supply. */
function articleHeadExtra(a) {
  var published = isoDate(a.published_at);
  return [
    '<meta name="author" content="Veyago Inc." />',
    '<meta property="article:published_time" content="' + published + '" />',
    '<meta property="article:modified_time" content="' + (isoDate(a.updated_at) || published) + '" />',
    '<meta property="article:publisher" content="' + SITE + '/" />',
    '<script type="application/ld+json">\n  ' + articleJsonLd(a).replace(/\n/g, '\n  ') + '\n  </script>'
  ].join('\n  ');
}

/* Extra <head> markup for the index. */
function indexHeadExtra(articles) {
  return '<script type="application/ld+json">\n  ' +
    indexJsonLd(articles).replace(/\n/g, '\n  ') + '\n  </script>';
}

module.exports = { articleJsonLd, indexJsonLd, articleHeadExtra, indexHeadExtra, wordCount };
