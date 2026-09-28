/* Tests for tools/sync-chrome.js: every hand-authored page gets the header,
   side and footer tagline tools/lib/chrome.js makes for it. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sync = require('./sync-chrome');
const chrome = require('./lib/chrome');

const PAGE = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <title>T</title>',
  '  <link rel="stylesheet" href="/styles.css?v=abc" />',
  '</head>',
  '<body>',
  '  <header class="nav" id="site-nav"><div class="wrap">old</div></header>',
  '',
  '  <!-- Mobile navigation drawer -->',
  '  <div class="nav-scrim" id="nav-scrim"></div>',
  '  <aside class="nav-drawer" id="nav-drawer">old drawer</aside>',
  '  <main id="main"><p>Body</p></main>',
  '  <footer class="footer"><div class="wrap">',
  '      <div><h3>Company</h3><a href="/websites/">Websites</a><a href="/services/">Services</a></div>',
  '      <div class="footer-base">',
  '        <span>© <span id="year">2026</span> Veyago Inc · New York C-Corp</span>',
  '        <span>Private apps and proper websites · New York</span>',
  '      </div>',
  '  </div></footer>',
  '</body>',
  '</html>'
].join('\n');

test('each page has a side, and a page nobody placed is refused', () => {
  assert.equal(sync.sideOf('index.html'), 'private');
  assert.equal(sync.sideOf('journal/some-article/index.html'), null, 'articles serve both sides');
  assert.equal(sync.sideOf('projects/the-edge-moves-in/index.html'), 'private');
  assert.equal(sync.sideOf('audits/index.html'), 'business');
  assert.equal(sync.sideOf('team/index.html'), null);
  assert.throws(() => sync.sideOf('partners/index.html'), /add "partners" to SIDE_OF/);
});

test('a business page gets the business header, its side on <html>, no side.js', () => {
  const { html, changed } = sync.syncPage('cockpit/index.html', PAGE);
  assert.deepEqual(changed, ['header', 'html side', 'footer']);
  assert.ok(html.includes('<html lang="en" data-side="business" data-page-side="business">'));
  assert.ok(html.includes(chrome.header({ side: 'business' })));
  assert.ok(!html.includes('side.js'));
  assert.ok(!html.includes('Mobile navigation drawer'), 'the old drawer block is replaced whole');
  assert.ok(html.includes('<a href="/websites/">Websites</a><a href="/audits/">Audits</a><a href="/services/">Services</a>'));
  assert.ok(html.includes('<span>Proper websites, honest audits, one place to run it all · New York</span>'));
  assert.ok(html.includes('<main id="main"><p>Body</p></main>'), 'the page itself is untouched');
});

test('a shared page gets both menus, starts on Private and loads side.js in the head', () => {
  const { html } = sync.syncPage('team/index.html', PAGE);
  assert.ok(html.includes('<html lang="en" data-side="private">'));
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css\?v=abc" \/>\n  <script src="\/assets\/js\/side\.js\?v=[0-9a-f]{10}"><\/script>/);
  assert.ok(html.includes('<span data-for="private">Private apps, made with care · New York</span><span data-for="business">'));
});

test('a page with its own quote form keeps its button pointed at the form', () => {
  const withForm = PAGE.replace('<p>Body</p>', '<section id="quote"></section>');
  const { html } = sync.syncPage('websites/index.html', withForm);
  assert.ok(html.includes('<a class="nav-quote" href="#quote">Get a quote</a>'));
});

test('syncing twice changes nothing the second time', () => {
  ['index.html', 'business/index.html', 'company/index.html'].forEach((rel) => {
    const once = sync.syncPage(rel, PAGE).html;
    assert.deepEqual(sync.syncPage(rel, once).changed, [], rel);
  });
});

test('a page that moves from shared to a side of its own loses side.js', () => {
  const shared = sync.syncPage('team/index.html', PAGE).html;
  const moved = sync.syncPage('audits/index.html', shared);
  assert.ok(!moved.html.includes('side.js'));
  assert.ok(moved.html.includes('data-page-side="business"'));
  assert.ok(!moved.html.includes('data-for='));
});

test('a header without the drawer after it is refused, never matched against a later <aside>', () => {
  const noDrawer = PAGE.replace(/\n  <!-- Mobile[\s\S]*?<\/aside>/, '')
    .replace('<main id="main"><p>Body</p></main>', '<main id="main"><aside class="note">Keep me</aside><p>Body</p></main>');
  assert.throws(() => sync.syncPage('team/index.html', noDrawer), /scrim and the nav-drawer/);
});

test('a footer-base on one line keeps its closing tag', () => {
  const oneLine = PAGE.replace(/<div class="footer-base">[\s\S]*?<\/div>/,
    '<div class="footer-base"><span>© <span id="year">2026</span> Veyago Inc · New York C-Corp</span><span>Old</span></div>');
  const { html } = sync.syncPage('audits/index.html', oneLine);
  assert.ok(html.includes('New York C-Corp</span><span>Proper websites, honest audits, one place to run it all · New York</span></div>'));
  assert.equal((html.match(/<div/g) || []).length, (html.match(/<\/div>/g) || []).length);
});

test('a footer-base it does not recognise is an error, not a silent skip', () => {
  const odd = PAGE.replace('<span>Private apps and proper websites · New York</span>', '<p>Something else</p>');
  assert.throws(() => sync.syncPage('team/index.html', odd), /team\/index\.html: a footer-base this tool does not recognise/);
});

test('a doubled side.js tag is cleaned up to exactly one', () => {
  const once = sync.syncPage('team/index.html', PAGE).html;
  const twice = once.replace(/(\n  <script src="\/assets\/js\/side\.js[^"]*"><\/script>)/, '$1$1');
  const { html } = sync.syncPage('team/index.html', twice);
  assert.equal((html.match(/side\.js/g) || []).length, 1);
});
