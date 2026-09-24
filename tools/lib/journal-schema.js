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
var entity = require('./entity');
var { isoDate, absoluteUrl } = require('./format');
var { blockWords } = require('./reading-time');

var ORG_ID = SITE + '/#organization';
var JOURNAL_URL = SITE + '/journal/';

function articleUrl(a) { return SITE + '/journal/' + a.slug + '/'; }

function summary(a) { return a.excerpt || a.dek || ''; }

/* The words a reader actually reads — the same accounting reading time uses, so
   the two numbers can never disagree on the page. */
function wordCount(blocks) {
  return blockWords(blocks);
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
  var post = {
    '@type': 'BlogPosting',
    '@id': url + '#article',
    headline: a.title,
    description: summary(a),
    url: url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: absoluteUrl(a.share_image || a.cover_image_url) || DEFAULT_OG_IMAGE,
    inLanguage: 'en',
    isAccessibleForFree: true,
    wordCount: wordCount(a.body),
    datePublished: published,
    dateModified: isoDate(a.updated_at) || published,
    author: entity.authorRef(),
    publisher: { '@id': ORG_ID },
    isPartOf: { '@id': JOURNAL_URL + '#blog' },
    /* Answer engines lift the first 40-60 words of an article far more often
       than any other passage, so the draft names it explicitly. */
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.paper-title', '.answer-first'] }
  };
  if (a.keywords) post.keywords = a.keywords;
  if (a.about) post.about = a.about;
  if (Array.isArray(a.citation) && a.citation.length) post.citation = a.citation;
  return post;
}

/* A procedure inside an article, when the draft declares one. Google no longer
   draws HowTo rich results, but the markup still tells an answer engine which
   paragraphs are the ordered steps of a task. */
function howTo(a) {
  if (!a.howto || !Array.isArray(a.howto.step) || !a.howto.step.length) return null;
  var url = articleUrl(a);
  var node = {
    '@type': 'HowTo',
    '@id': url + '#howto',
    name: a.howto.name,
    description: a.howto.description || '',
    isPartOf: { '@id': url + '#article' },
    step: a.howto.step.map(function (st, i) {
      return {
        '@type': 'HowToStep',
        position: i + 1,
        name: st.name,
        text: st.text,
        url: url + (st.anchor ? '#' + st.anchor : '#howto')
      };
    })
  };
  if (a.howto.totalTime) node.totalTime = a.howto.totalTime;
  if (a.howto.tool) node.tool = a.howto.tool.map(function (t) { return { '@type': 'HowToTool', name: t }; });
  return node;
}

/* One article page's graph: the post itself, the founder who wrote it, any
   procedure it contains, and where it sits in the site. */
function articleJsonLd(a) {
  return serialise({
    '@context': 'https://schema.org',
    '@graph': [
      blogPosting(a),
      entity.founder(),
      breadcrumb([
        { name: 'Home', url: SITE + '/' },
        { name: 'Articles', url: JOURNAL_URL },
        { name: a.title }
      ])
    ].concat(howTo(a) || [])
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
        description: 'Field notes from the studio on fast, private software: why builder sites are slow, what a fixed-price website really includes, and how we build.',
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
    '<meta name="author" content="Cassian Drefke" />',
    '<link rel="alternate" type="application/rss+xml" title="Veyago field notes" href="' + SITE + '/feed.xml" />',
    '<meta property="article:published_time" content="' + published + '" />',
    '<meta property="article:modified_time" content="' + (isoDate(a.updated_at) || published) + '" />',
    '<meta property="article:author" content="' + SITE + '/team/#cassian-drefke" />',
    '<meta property="article:publisher" content="' + SITE + '/" />',
    '<script type="application/ld+json">\n  ' + articleJsonLd(a).replace(/\n/g, '\n  ') + '\n  </script>'
  ].join('\n  ');
}

/* Extra <head> markup for the index. */
function indexHeadExtra(articles) {
  return '<link rel="alternate" type="application/rss+xml" title="Veyago field notes" href="' + SITE + '/feed.xml" />\n  ' +
    '<script type="application/ld+json">\n  ' +
    indexJsonLd(articles).replace(/\n/g, '\n  ') + '\n  </script>';
}

module.exports = { articleJsonLd, indexJsonLd, articleHeadExtra, indexHeadExtra, wordCount };
