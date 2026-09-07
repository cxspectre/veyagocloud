'use strict';

var test = require('node:test');
var assert = require('node:assert');
var { articleJsonLd, indexJsonLd, articleHeadExtra } = require('./journal-schema');

var ARTICLE = {
  slug: 'why-your-wix-site-is-slow',
  title: 'Why your Wix site is slow',
  dek: 'Where the weight comes from.',
  excerpt: 'A short summary.',
  published_at: '2026-09-03T09:00:00Z',
  updated_at: '2026-09-05T11:00:00Z',
  body: [
    { type: 'text', html: '<p>One two three four five.</p>' },
    { type: 'heading', text: 'A heading' }
  ]
};

function graph(json) { return JSON.parse(json)['@graph']; }
function node(json, type) { return graph(json).filter(function (n) { return n['@type'] === type; })[0]; }

test('an article declares BlogPosting with the fields Google reads', function () {
  var n = node(articleJsonLd(ARTICLE), 'BlogPosting');
  assert.equal(n.headline, 'Why your Wix site is slow');
  assert.equal(n.description, 'A short summary.');
  assert.equal(n.url, 'https://www.veyago.cloud/journal/why-your-wix-site-is-slow/');
  assert.equal(n.datePublished, '2026-09-03');
  assert.equal(n.dateModified, '2026-09-05');
  assert.equal(n.inLanguage, 'en');
  assert.equal(n.isAccessibleForFree, true);
  assert.equal(n.mainEntityOfPage['@id'], n.url);
});

test('author and publisher point at the one Organization node the rest of the site uses', function () {
  var n = node(articleJsonLd(ARTICLE), 'BlogPosting');
  assert.equal(n.author['@id'], 'https://www.veyago.cloud/#organization');
  assert.equal(n.publisher['@id'], 'https://www.veyago.cloud/#organization');
});

test('wordCount counts the body, not the markup', function () {
  var n = node(articleJsonLd(ARTICLE), 'BlogPosting');
  assert.equal(n.wordCount, 7);          // five words + a two-word heading
});

test('dateModified falls back to the publication date when the row has no updated_at', function () {
  var a = Object.assign({}, ARTICLE); delete a.updated_at;
  assert.equal(node(articleJsonLd(a), 'BlogPosting').dateModified, '2026-09-03');
});

test('an article carries a Home > Articles > title breadcrumb', function () {
  var b = node(articleJsonLd(ARTICLE), 'BreadcrumbList');
  assert.equal(b.itemListElement.length, 3);
  assert.deepEqual(b.itemListElement.map(function (i) { return i.name; }),
    ['Home', 'Articles', 'Why your Wix site is slow']);
  assert.equal(b.itemListElement[1].item, 'https://www.veyago.cloud/journal/');
  assert.equal(b.itemListElement[2].position, 3);
});

test('a cover image is used when present, the site default otherwise', function () {
  assert.equal(node(articleJsonLd(ARTICLE), 'BlogPosting').image,
    'https://www.veyago.cloud/assets/og.png');
  var withCover = Object.assign({}, ARTICLE, { cover_image_url: '/assets/cover.png' });
  assert.equal(node(articleJsonLd(withCover), 'BlogPosting').image,
    'https://www.veyago.cloud/assets/cover.png');
});

test('the index declares a Blog listing every article', function () {
  var n = node(indexJsonLd([ARTICLE]), 'Blog');
  assert.equal(n.blogPost.length, 1);
  assert.equal(n.blogPost[0].headline, 'Why your Wix site is slow');
  assert.equal(n.blogPost[0].url, 'https://www.veyago.cloud/journal/why-your-wix-site-is-slow/');
});

test('the index breadcrumb stops at Articles', function () {
  var b = node(indexJsonLd([ARTICLE]), 'BreadcrumbList');
  assert.deepEqual(b.itemListElement.map(function (i) { return i.name; }), ['Home', 'Articles']);
});

test('an empty index still emits a valid graph with no posts', function () {
  var n = node(indexJsonLd([]), 'Blog');
  assert.deepEqual(n.blogPost, []);
});

test('a "</script>" in a title cannot close the script element early', function () {
  var a = Object.assign({}, ARTICLE, { title: 'Bad </script> title' });
  assert.ok(articleJsonLd(a).indexOf('</script>') === -1);
  assert.equal(node(articleJsonLd(a), 'BlogPosting').headline, 'Bad </script> title');
});

test('the head extra carries the JSON-LD and the article Open Graph dates', function () {
  var head = articleHeadExtra(ARTICLE);
  assert.ok(head.indexOf('application/ld+json') !== -1);
  assert.ok(head.indexOf('<meta name="author" content="Veyago Inc." />') !== -1);
  assert.ok(head.indexOf('article:published_time" content="2026-09-03"') !== -1);
  assert.ok(head.indexOf('article:modified_time" content="2026-09-05"') !== -1);
});
