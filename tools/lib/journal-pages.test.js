'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderJournalIndex } = require('./journal-pages');

const ARTICLE = {
  slug: 'first-post', title: 'First Post', dek: 'A dek', published_at: '2026-06-28T10:00:00Z',
  body: [{ type: 'paragraph', text: 'Hello there.' }],
};

test('an empty journal index is noindex,follow', () => {
  const html = renderJournalIndex([]);
  assert.match(html, /<meta name="robots" content="noindex,follow" \/>/);
  assert.match(html, /No articles yet/);
});

test('a journal index with articles is index,follow', () => {
  const html = renderJournalIndex([ARTICLE]);
  assert.match(html, /<meta name="robots" content="index,follow" \/>/);
  assert.match(html, /href="\/journal\/first-post\/"/);
});

test('generated pages carry the skip link, a single #main, and h3 footer headings', () => {
  const html = renderJournalIndex([]);
  assert.match(html, /<body>\n  <a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.strictEqual((html.match(/id="main"/g) || []).length, 1);
  assert.strictEqual((html.match(/<h3>/g) || []).length, 4);
  assert.doesNotMatch(html, /<h5>/);
});
