/* Tests for tools/lib/i18n-apply.js - the build-time twin of app.js applyDict().

   The static Dutch page and the live switcher must translate identically, so
   these pin the rules that matter: whole-node matching with whitespace kept,
   the skip list (script, svg, data-i18n-skip, brand, picker), attrs falling
   back to strings, the html map, and meta by page path. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { applyDict, squish, isOpaque } = require('./i18n-apply');

const DICT = {
  strings: { 'Get a quote': 'Vraag een offerte aan', 'Hello there': 'Hallo daar', 'Menu': 'Menu-nl', 'Skip me': 'NOPE', 'Brand text': 'NOPE' },
  attrs: { 'Open menu': 'Menu openen' },
  html: { 'faq.x': 'Zie <a href="/privacy/">privacy</a>.' },
  meta: { '/websites/': { title: 'NL titel', description: 'NL beschrijving' } },
};

function doc(body, head) {
  return new JSDOM('<!doctype html><html><head><title>EN title</title>' +
    '<meta name="description" content="EN desc"><meta property="og:title" content="EN title">' +
    '<meta property="og:description" content="EN desc">' + (head || '') +
    '</head><body>' + body + '</body></html>').window.document;
}

test('translates whole text nodes and keeps their surrounding whitespace', () => {
  const d = doc('<a class="btn">\n  Get a quote\n</a><p>Hello   there</p>');
  const stats = applyDict(d, DICT, '/x/');
  assert.equal(d.querySelector('a').textContent, '\n  Vraag een offerte aan\n');
  assert.equal(d.querySelector('p').textContent, 'Hallo daar');
  assert.equal(stats.translated, 2);
});

test('skips script, svg, data-i18n-skip, data-i18n subtrees, the brand and the picker', () => {
  const d = doc(
    '<script>var x = "Get a quote";</script>' +
    '<svg><text>Get a quote</text></svg>' +
    '<p data-i18n-skip>Skip me</p>' +
    '<a class="brand">Brand text</a>' +
    '<div class="lang"><button>Menu</button></div>' +
    '<p data-i18n="faq.x">Hello there</p>');
  applyDict(d, DICT, '/x/');
  assert.equal(d.querySelector('script').textContent, 'var x = "Get a quote";');
  assert.equal(d.querySelector('svg text').textContent, 'Get a quote');
  assert.equal(d.querySelector('[data-i18n-skip]').textContent, 'Skip me');
  assert.equal(d.querySelector('.brand').textContent, 'Brand text');
  assert.equal(d.querySelector('.lang button').textContent, 'Menu');
  assert.equal(d.querySelector('[data-i18n]').innerHTML, 'Zie <a href="/privacy/">privacy</a>.', 'html map replaces rich content');
});

test('attrs come from the attrs map first, then strings; skipped elements keep theirs', () => {
  const d = doc('<button aria-label="Open menu">x</button><img alt="Get a quote"><img alt="Open menu" data-i18n-skip>');
  const stats = applyDict(d, DICT, '/x/');
  assert.equal(d.querySelector('button').getAttribute('aria-label'), 'Menu openen');
  assert.equal(d.querySelector('img').getAttribute('alt'), 'Vraag een offerte aan');
  assert.equal(d.querySelectorAll('img')[1].getAttribute('alt'), 'Open menu');
  assert.equal(stats.attrs, 2);
});

test('meta is localised by page path, including the og and twitter copies', () => {
  const d = doc('<p>x</p>', '<meta name="twitter:title" content="EN title"><meta name="twitter:description" content="EN desc">');
  const stats = applyDict(d, DICT, '/websites/');
  assert.equal(d.title, 'NL titel');
  assert.equal(d.querySelector('meta[name="description"]').getAttribute('content'), 'NL beschrijving');
  assert.equal(d.querySelector('meta[property="og:title"]').getAttribute('content'), 'NL titel');
  assert.equal(d.querySelector('meta[name="twitter:description"]').getAttribute('content'), 'NL beschrijving');
  assert.equal(stats.meta, true);
  assert.equal(applyDict(doc('<p>x</p>'), DICT, '/other/').meta, false);
});

test('reports what it could not translate, ignoring numbers and punctuation', () => {
  const d = doc('<p>Not in dict</p><span>$699</span><span>·</span><p>Hello there</p>');
  const stats = applyDict(d, DICT, '/x/');
  assert.deepEqual(stats.missed, ['Not in dict']);
});

test('helpers', () => {
  assert.equal(squish('  a \n b  '), 'a b');
  assert.ok(isOpaque('$699 / €750'));
  assert.ok(!isOpaque('From $699'));
});

test('JSON-LD: string leaves are translated and values naming the English page move to the twin', () => {
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Hello there', acceptedAnswer: { '@type': 'Answer', text: 'Get a quote' } }] },
    { '@type': 'Service', '@id': 'https://www.veyago.cloud/websites/#service', url: 'https://www.veyago.cloud/websites/', provider: { '@id': 'https://www.veyago.cloud/#organization' } },
  ] };
  const d = doc('<p>x</p>', '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>');
  const stats = applyDict(d, DICT, '/websites/', { pageUrl: 'https://www.veyago.cloud/websites/', localeUrl: 'https://www.veyago.cloud/nl/websites/' });
  const out = JSON.parse(d.querySelector('script[type="application/ld+json"]').textContent);
  assert.equal(out['@graph'][0].mainEntity[0].name, 'Hallo daar');
  assert.equal(out['@graph'][0].mainEntity[0].acceptedAnswer.text, 'Vraag een offerte aan');
  assert.equal(out['@graph'][1]['@id'], 'https://www.veyago.cloud/nl/websites/#service');
  assert.equal(out['@graph'][1].url, 'https://www.veyago.cloud/nl/websites/');
  assert.equal(out['@graph'][1].provider['@id'], 'https://www.veyago.cloud/#organization', 'other entities untouched');
  assert.equal(out['@context'], 'https://schema.org');
  assert.equal(stats.jsonld, 2);
});
