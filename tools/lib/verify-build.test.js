'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkHtmlDocument,
  checkSitemapCoverage,
  summarize,
  verifyBuild,
  findLeakedTokens,
  maskCodeRegions,
  decodeEntities,
  expectedSitemapUrls,
  MIN_PAGE_BYTES,
  SITE,
  GENERATED_APP_MARKER, checkNoCatastrophicShrink } = require('./verify-build');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILLER = 'Long enough to clear the byte floor. '.repeat(20);

/* A minimal but structurally honest page, shaped like tools/lib/chrome.js output. */
function makePage(overrides) {
  const o = Object.assign({
    title: 'A Real Article | Veyago',
    canonical: SITE + '/journal/a-real-article/',
    body: '<main><h1>A Real Article</h1><p>' + FILLER + '</p></main>',
    doctype: '<!DOCTYPE html>\n',
    close: '</body>\n</html>\n'
  }, overrides || {});
  const titleTag = o.title === null ? '' : '<title>' + o.title + '</title>\n  ';
  const canonicalTag = o.canonical === null
    ? ''
    : '<link rel="canonical" href="' + o.canonical + '" />\n  ';
  return o.doctype +
    '<html lang="en">\n<head>\n  ' +
    '<meta charset="UTF-8" />\n  ' +
    titleTag +
    '<meta name="description" content="A description." />\n  ' +
    canonicalTag +
    '<link rel="stylesheet" href="/styles.css" />\n' +
    '</head>\n<body>\n' + o.body + '\n' + o.close;
}

function joined(problems) {
  return problems.join('\n');
}

// ---------------------------------------------------------------------------
// decodeEntities / maskCodeRegions
// ---------------------------------------------------------------------------

test('decodeEntities reverses the escaping the builders apply', () => {
  assert.strictEqual(decodeEntities('Tea &amp; Toast'), 'Tea & Toast');
  assert.strictEqual(decodeEntities('&lt;script&gt;'), '<script>');
  assert.strictEqual(decodeEntities('It&#39;s fine'), "It's fine");
  assert.strictEqual(decodeEntities('It&#x27;s fine'), "It's fine");
  assert.strictEqual(decodeEntities('say &quot;hi&quot;'), 'say "hi"');
});

test('decodeEntities decodes &amp; last so &amp;lt; does not become <', () => {
  assert.strictEqual(decodeEntities('&amp;lt;'), '&lt;');
});

test('maskCodeRegions blanks code samples but preserves length and newlines', () => {
  const html = '<p>a</p><pre>x\ny</pre><p>b</p>';
  const masked = maskCodeRegions(html);
  assert.strictEqual(masked.length, html.length, 'length must be preserved for index math');
  assert.strictEqual((masked.match(/\n/g) || []).length, 1);
  assert.ok(masked.indexOf('<pre>') === -1, 'pre region should be blanked');
  assert.ok(masked.indexOf('<p>a</p>') !== -1, 'markup outside code is untouched');
});

// ---------------------------------------------------------------------------
// checkHtmlDocument — happy path
// ---------------------------------------------------------------------------

test('checkHtmlDocument passes a well-formed page', () => {
  assert.deepStrictEqual(checkHtmlDocument(makePage()), []);
});

test('checkHtmlDocument matches expectTitle as a substring of "<title> | Veyago"', () => {
  assert.deepStrictEqual(
    checkHtmlDocument(makePage(), { expectTitle: 'A Real Article' }),
    []
  );
});

test('checkHtmlDocument compares expectTitle against the DECODED title', () => {
  const html = makePage({ title: 'Tea &amp; Toast | Veyago' });
  assert.deepStrictEqual(checkHtmlDocument(html, { expectTitle: 'Tea & Toast' }), []);
});

test('checkHtmlDocument returns a fresh array and never mutates its input', () => {
  const html = makePage();
  const a = checkHtmlDocument(html);
  const b = checkHtmlDocument(html);
  assert.notStrictEqual(a, b);
  a.push('poison');
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

// ---------------------------------------------------------------------------
// checkHtmlDocument — emptiness and size floor
// ---------------------------------------------------------------------------

test('checkHtmlDocument reports an empty document exactly once', () => {
  const problems = checkHtmlDocument('');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /empty/);
});

test('checkHtmlDocument treats non-strings as empty', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    const problems = checkHtmlDocument(bad);
    assert.strictEqual(problems.length, 1, 'input ' + JSON.stringify(bad));
    assert.match(problems[0], /empty/);
  }
});

test('checkHtmlDocument flags a page under the 500-byte floor', () => {
  const tiny = '<!DOCTYPE html><html><head><title>T</title>' +
    '<link rel="canonical" href="https://www.veyago.cloud/" /></head><body></body></html>';
  assert.ok(Buffer.byteLength(tiny) < MIN_PAGE_BYTES, 'fixture must be under the floor');
  const problems = checkHtmlDocument(tiny);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /suspiciously small/);
  assert.match(problems[0], new RegExp(String(MIN_PAGE_BYTES)));
});

test('checkHtmlDocument reports the byte floor in BYTES, not characters', () => {
  // 260 multi-byte characters = 780 bytes: over the byte floor, under it if
  // someone naively measured .length.
  const body = '<main><p>' + '★'.repeat(260) + '</p></main>';
  const html = makePage({ body });
  assert.ok(html.length < MIN_PAGE_BYTES + 300);
  assert.ok(Buffer.byteLength(html, 'utf8') > MIN_PAGE_BYTES);
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

test('checkHtmlDocument honours a custom minBytes', () => {
  const html = makePage();
  assert.deepStrictEqual(checkHtmlDocument(html, { minBytes: 0 }), []);
  const problems = checkHtmlDocument(html, { minBytes: 1024 * 1024 });
  assert.match(joined(problems), /suspiciously small/);
});

// ---------------------------------------------------------------------------
// checkHtmlDocument — structural failures
// ---------------------------------------------------------------------------

test('checkHtmlDocument flags a missing <title>', () => {
  const problems = checkHtmlDocument(makePage({ title: null }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /missing <title>/);
});

test('checkHtmlDocument flags a whitespace-only <title>', () => {
  const problems = checkHtmlDocument(makePage({ title: '   \n  ' }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /<title> is empty/);
});

test('checkHtmlDocument flags a title that does not contain the expected one', () => {
  const problems = checkHtmlDocument(makePage(), { expectTitle: 'Some Other Post' });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /expected it to contain "Some Other Post"/);
  assert.match(problems[0], /A Real Article/, 'report should show what was actually found');
});

test('checkHtmlDocument ignores a blank expectTitle instead of matching everything', () => {
  assert.deepStrictEqual(checkHtmlDocument(makePage(), { expectTitle: '   ' }), []);
  assert.deepStrictEqual(checkHtmlDocument(makePage(), { expectTitle: null }), []);
});

test('checkHtmlDocument flags a missing canonical link', () => {
  const problems = checkHtmlDocument(makePage({ canonical: null }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /missing <link rel="canonical">/);
});

test('checkHtmlDocument flags a canonical with an empty href', () => {
  const problems = checkHtmlDocument(makePage({ canonical: '' }));
  assert.strictEqual(problems.length, 1, joined(problems));
  assert.match(problems[0], /no href/);
});

test('checkHtmlDocument flags a relative canonical href', () => {
  const problems = checkHtmlDocument(makePage({ canonical: '/journal/a-real-article/' }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /not an absolute URL/);
});

test('checkHtmlDocument does not mistake <link rel="stylesheet"> for the canonical', () => {
  const html = makePage({ canonical: null });
  assert.ok(html.indexOf('rel="stylesheet"') !== -1);
  assert.match(joined(checkHtmlDocument(html)), /missing <link rel="canonical">/);
});

test('checkHtmlDocument flags a missing doctype', () => {
  const problems = checkHtmlDocument(makePage({ doctype: '' }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /missing <!DOCTYPE html>/);
});

test('checkHtmlDocument flags a truncated file with no closing </html>', () => {
  const problems = checkHtmlDocument(makePage({ close: '' }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /truncated/);
});

test('checkHtmlDocument accumulates every independent failure', () => {
  const problems = checkHtmlDocument(makePage({
    title: null,
    canonical: null,
    doctype: '',
    close: '',
    body: '<main><p>' + FILLER + '</p><p>[object Object]</p></main>'
  }));
  const text = joined(problems);
  assert.ok(problems.length >= 5, 'expected 5+ problems, got ' + problems.length);
  assert.match(text, /missing <title>/);
  assert.match(text, /missing <link rel="canonical">/);
  assert.match(text, /missing <!DOCTYPE html>/);
  assert.match(text, /truncated/);
  assert.match(text, /\[object Object\]/);
});

// ---------------------------------------------------------------------------
// checkHtmlDocument — placeholder leakage
// ---------------------------------------------------------------------------

test('checkHtmlDocument catches "undefined" leaked into an attribute', () => {
  const html = makePage({
    body: '<main><img src="undefined" alt="" /><p>' + FILLER + '</p></main>'
  });
  const problems = checkHtmlDocument(html);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /leaked placeholder "undefined attribute"/);
});

test('checkHtmlDocument allows "null" in prose — it is ordinary English here', () => {
  // A software journal legitimately publishes "On the null pointer". Failing the
  // build on the bare word would hard-block a real article with no way past it.
  const html = makePage({ body: '<main><p>A null value is not undefined.</p><p>' + FILLER + '</p></main>' });
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

test('checkHtmlDocument catches "null" as a whole generated path segment', () => {
  const html = makePage({ body: '<main><a href="/journal/null/">Read</a><p>' + FILLER + '</p></main>' });
  assert.match(joined(checkHtmlDocument(html)), /leaked placeholder "undefined path segment"/);
});

test('checkHtmlDocument allows "NaN" in prose — an article may discuss it', () => {
  const html = makePage({ body: '<main><p>NaN is not equal to NaN.</p><p>' + FILLER + '</p></main>' });
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

test('checkHtmlDocument catches a stringified object', () => {
  const html = makePage({ body: '<main><p>[object Object]</p><p>' + FILLER + '</p></main>' });
  assert.match(joined(checkHtmlDocument(html)), /\[object Object\]/);
});

test('checkHtmlDocument catches an unresolved template artifact', () => {
  const html = makePage({ body: '<main><h1>${a.title}</h1><p>' + FILLER + '</p></main>' });
  assert.match(joined(checkHtmlDocument(html)), /\$\{/);
});

test('checkHtmlDocument catches leakage in the <title> and canonical too', () => {
  const html = makePage({
    title: 'undefined | Veyago',
    canonical: SITE + '/journal/undefined/'
  });
  const problems = checkHtmlDocument(html);
  assert.ok(problems.length >= 2, 'both leaks should be reported, got ' + problems.length);
  assert.match(joined(problems), /leaked placeholder "undefined (title|path segment)"/);
});

test('checkHtmlDocument does NOT flag tokens embedded in longer words', () => {
  const html = makePage({
    body: '<main><p>The contract was annulled, so we nullify it and set data-nullable ' +
      'on the Nannette entry. Undefinedly odd, but fine. ' + FILLER + '</p></main>'
  });
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

test('checkHtmlDocument does NOT flag tokens inside <pre>/<code> code samples', () => {
  const html = makePage({
    body: '<main><p>' + FILLER + '</p>' +
      '<pre><code>const x = null;\nif (y === undefined) return NaN;\n' +
      'const s = `${x}`;\nconsole.log(String({})); // [object Object]</code></pre></main>'
  });
  assert.deepStrictEqual(checkHtmlDocument(html), []);
});

test('checkHtmlDocument still flags leakage OUTSIDE a code block on the same page', () => {
  const html = makePage({
    body: '<main><p>[object Object]</p>' +
      '<pre><code>let a = null;</code></pre><p>' + FILLER + '</p></main>'
  });
  const problems = checkHtmlDocument(html);
  assert.strictEqual(problems.length, 1, joined(problems));
  assert.match(problems[0], /\[object Object\]/);
  assert.ok(problems[0].indexOf('"null"') === -1, 'the code sample must stay exempt');
});

test('findLeakedTokens caps repeats so a broken template yields a readable report', () => {
  // Uses an absolute token: prose `undefined` no longer leaks by design.
  const html = 'x'.repeat(50) + '[object Object] '.repeat(30);
  const found = findLeakedTokens(html);
  const objectHits = found.filter(function (f) { return f.token === '[object Object]'; });
  assert.ok(objectHits.length > 0, 'should report the leak');
  assert.ok(objectHits.length <= 10, 'should cap the report, got ' + objectHits.length);
});

test('findLeakedTokens reports context from the ORIGINAL text, not the masked copy', () => {
  const html = '<p>before</p><pre><code>ignored</code></pre><p>[object Object] tail</p>';
  const found = findLeakedTokens(html);
  assert.strictEqual(found.length, 1);
  assert.match(found[0].context, /\[object Object\]/);
  assert.ok(found[0].context.indexOf('\u0000') === -1, 'context must come from the original text');
});

// ---------------------------------------------------------------------------
// checkSitemapCoverage
// ---------------------------------------------------------------------------

function makeSitemap(managedLocs, options) {
  const o = options || {};
  const inner = (managedLocs || [])
    .map((loc) => '  <url><loc>' + loc + '</loc><priority>0.6</priority></url>')
    .join('\n');
  const block = o.omitMarkers
    ? inner
    : '  <!-- BUILD:generated:start -->\n' + inner + '\n  <!-- BUILD:generated:end -->';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url><loc>' + SITE + '/</loc><priority>1.0</priority></url>\n' +
    '  <url><loc>' + SITE + '/company/</loc><priority>0.7</priority></url>\n' +
    block + '\n</urlset>\n';
}

test('checkSitemapCoverage passes when the managed block matches exactly', () => {
  const urls = [SITE + '/journal/', SITE + '/journal/post/', SITE + '/wallpapers/'];
  assert.deepStrictEqual(checkSitemapCoverage(makeSitemap(urls), urls), []);
});

test('checkSitemapCoverage ignores hand-written entries outside the markers', () => {
  const urls = [SITE + '/journal/', SITE + '/wallpapers/'];
  const problems = checkSitemapCoverage(makeSitemap(urls), urls);
  assert.deepStrictEqual(problems, [], 'the / and /company/ entries must not be "extra"');
});

test('checkSitemapCoverage is order-independent', () => {
  const inBlock = [SITE + '/wallpapers/', SITE + '/journal/post/', SITE + '/journal/'];
  const expected = [SITE + '/journal/', SITE + '/journal/post/', SITE + '/wallpapers/'];
  assert.deepStrictEqual(checkSitemapCoverage(makeSitemap(inBlock), expected), []);
});

test('checkSitemapCoverage reports a missing entry', () => {
  const xml = makeSitemap([SITE + '/journal/', SITE + '/wallpapers/']);
  const problems = checkSitemapCoverage(xml, [
    SITE + '/journal/', SITE + '/journal/ghost/', SITE + '/wallpapers/'
  ]);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /missing entry for "https:\/\/www\.veyago\.cloud\/journal\/ghost\/"/);
});

test('checkSitemapCoverage reports a stale extra entry', () => {
  const xml = makeSitemap([SITE + '/journal/', SITE + '/journal/deleted/', SITE + '/wallpapers/']);
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/', SITE + '/wallpapers/']);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /stale entry ".*\/journal\/deleted\/"/);
});

test('checkSitemapCoverage reports missing AND extra in one pass', () => {
  const xml = makeSitemap([SITE + '/journal/', SITE + '/journal/old/']);
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/', SITE + '/journal/new/']);
  assert.strictEqual(problems.length, 2, joined(problems));
  assert.match(joined(problems), /missing entry for ".*\/journal\/new\/"/);
  assert.match(joined(problems), /stale entry ".*\/journal\/old\/"/);
});

test('checkSitemapCoverage flags duplicates', () => {
  const xml = makeSitemap([SITE + '/journal/', SITE + '/journal/', SITE + '/wallpapers/']);
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/', SITE + '/wallpapers/']);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /is listed 2 times/);
});

test('checkSitemapCoverage treats a trailing-slash mismatch as drift', () => {
  const xml = makeSitemap([SITE + '/journal/post']);
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/post/']);
  assert.strictEqual(problems.length, 2, joined(problems));
  assert.match(joined(problems), /missing entry/);
  assert.match(joined(problems), /stale entry/);
});

test('checkSitemapCoverage tolerates whitespace and entities inside <loc>', () => {
  const xml = makeSitemap(['\n    ' + SITE + '/journal/a&amp;b/\n  ']);
  assert.deepStrictEqual(checkSitemapCoverage(xml, [SITE + '/journal/a&b/']), []);
});

test('checkSitemapCoverage reports an empty <loc> entry', () => {
  const xml = makeSitemap(['', SITE + '/journal/']);
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/']);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /<loc> entry with no URL/);
});

test('checkSitemapCoverage reports missing markers and suppresses extras', () => {
  const xml = makeSitemap([SITE + '/journal/'], { omitMarkers: true });
  const problems = checkSitemapCoverage(xml, [SITE + '/journal/', SITE + '/wallpapers/']);
  assert.match(joined(problems), /markers are missing/);
  assert.match(joined(problems), /missing entry for ".*\/wallpapers\/"/);
  assert.ok(joined(problems).indexOf('stale entry') === -1,
    'without markers we cannot tell hand-written entries from generated ones');
});

test('checkSitemapCoverage rejects an empty or non-string sitemap', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    const problems = checkSitemapCoverage(bad, [SITE + '/journal/']);
    assert.strictEqual(problems.length, 1, 'input ' + JSON.stringify(bad));
    assert.match(problems[0], /empty or unreadable/);
  }
});

test('checkSitemapCoverage with no expected URLs flags the whole managed block', () => {
  const xml = makeSitemap([SITE + '/journal/', SITE + '/wallpapers/']);
  const problems = checkSitemapCoverage(xml, []);
  assert.strictEqual(problems.length, 2);
  problems.forEach((p) => assert.match(p, /stale entry/));
});

test('checkSitemapCoverage passes an empty managed block when nothing is expected', () => {
  assert.deepStrictEqual(checkSitemapCoverage(makeSitemap([]), []), []);
});

// ---------------------------------------------------------------------------
// expectedSitemapUrls
// ---------------------------------------------------------------------------

test('expectedSitemapUrls mirrors what build.js writes into the managed block', () => {
  const urls = expectedSitemapUrls(SITE, [{ slug: 'post' }], [{ slug: 'app' }]);
  assert.deepStrictEqual(urls, [
    SITE + '/journal/',
    SITE + '/journal/post/',
    SITE + '/wallpapers/',
    SITE + '/apps/app/'
  ]);
});

test('expectedSitemapUrls always includes both index pages, even when empty', () => {
  assert.deepStrictEqual(expectedSitemapUrls(SITE, [], []), [
    SITE + '/journal/', SITE + '/wallpapers/'
  ]);
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize reports ok for no problems', () => {
  const s = summarize([]);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.count, 0);
  assert.match(s.report, /0 problems found/);
});

test('summarize handles null/undefined input as ok', () => {
  assert.strictEqual(summarize(null).ok, true);
  assert.strictEqual(summarize(undefined).count, 0);
});

test('summarize numbers each problem in the report', () => {
  const s = summarize(['first thing', 'second thing']);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.count, 2);
  assert.match(s.report, /2 problem\(s\) found/);
  assert.match(s.report, /1\. first thing/);
  assert.match(s.report, /2\. second thing/);
});

test('summarize drops falsy entries so they cannot fake a failure', () => {
  const s = summarize([null, '', undefined, 'real problem']);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.ok, false);
  assert.match(s.report, /1\. real problem/);
});

test('summarize of only-falsy entries is ok', () => {
  assert.strictEqual(summarize([null, '', undefined]).ok, true);
});

// ---------------------------------------------------------------------------
// verifyBuild — filesystem walk
// ---------------------------------------------------------------------------

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const ARTICLES = [{ slug: 'first-post', title: 'First Post' }];
const WALLPAPERS = [{ slug: 'dune', title: 'Dune Ridge' }];
const APP_PAGES = [{ slug: 'ledger', name: 'Ledger' }];

/* Build a temp tree that mirrors a healthy `npm run build` output. */
function makeBuildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veyago-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFile(root, 'journal/first-post/index.html', makePage({
    title: 'First Post | Veyago',
    canonical: SITE + '/journal/first-post/'
  }));
  writeFile(root, 'journal/index.html', makePage({
    title: 'Articles | Veyago',
    canonical: SITE + '/journal/',
    body: '<main><h1>Articles</h1><a href="/journal/first-post/">First Post</a><p>' + FILLER + '</p></main>'
  }));
  writeFile(root, 'wallpapers/index.html', makePage({
    title: 'Wallpapers | Veyago',
    canonical: SITE + '/wallpapers/',
    body: '<main><h1>Wallpapers</h1><h3>Dune Ridge</h3><p>' + FILLER + '</p></main>'
  }));
  writeFile(root, 'apps/ledger/index.html', makePage({
    title: 'Ledger | Veyago',
    canonical: SITE + '/apps/ledger/',
    body: '<main>' + GENERATED_APP_MARKER + '<h1>Ledger</h1><p>' + FILLER + '</p></main>'
  }));
  writeFile(root, 'apps/index.html', '<!DOCTYPE html><html><body>hand-authored catalogue</body></html>');
  writeFile(root, 'sitemap.xml', makeSitemap(expectedSitemapUrls(SITE, ARTICLES, APP_PAGES)));
  writeFile(root, 'assets/js/site-config.js',
    'window.VEYAGO_SITE_CONFIG = {\n  "announcement": {\n    "active": false\n  }\n};\n');
  return root;
}

function expectedFor(overrides) {
  return Object.assign({
    articles: ARTICLES,
    wallpapers: WALLPAPERS,
    appPages: APP_PAGES
  }, overrides || {});
}

test('verifyBuild passes a healthy build tree', (t) => {
  const root = makeBuildRoot(t);
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.deepStrictEqual(result.problems, [], result.report);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 0);
});

test('verifyBuild fails loudly when a root does not exist', () => {
  const result = verifyBuild({ root: '/nope/definitely/not/here', expected: expectedFor() });
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /does not exist/);
});

test('verifyBuild fails when no root is given at all', () => {
  assert.strictEqual(verifyBuild({}).ok, false);
  assert.strictEqual(verifyBuild().ok, false);
});

test('verifyBuild catches a MISSING article page', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'journal/first-post'), { recursive: true, force: true });
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /journal\/first-post\/index\.html is MISSING/);
});

test('verifyBuild catches the wiped-/journal disaster', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'journal'), { recursive: true, force: true });
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /journal\/index\.html is MISSING/);
  assert.match(result.report, /journal\/first-post\/index\.html is MISSING/);
});

test('verifyBuild requires the journal index even when nothing is published', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'journal/index.html'), { force: true });
  const result = verifyBuild({
    root,
    expected: expectedFor({ articles: [] , appPages: APP_PAGES })
  });
  assert.match(result.report, /journal\/index\.html is MISSING/);
});

test('verifyBuild catches a page truncated under the byte floor', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'journal/first-post/index.html', '<!DOCTYPE html><html>');
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.strictEqual(result.ok, false);
  assert.match(result.report, /journal\/first-post\/index\.html: suspiciously small/);
});

test('verifyBuild catches a zero-byte page', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'wallpapers/index.html', '');
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /wallpapers\/index\.html: document is empty/);
});

test('verifyBuild catches a wrong-article page (title mismatch)', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'journal/first-post/index.html', makePage({
    title: 'Some Other Post | Veyago',
    canonical: SITE + '/journal/first-post/'
  }));
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /expected it to contain "First Post"/);
});

test('verifyBuild catches an article missing from the journal index', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'journal/index.html', makePage({
    title: 'Articles | Veyago',
    canonical: SITE + '/journal/',
    body: '<main><h1>Articles</h1><p>' + FILLER + '</p></main>'
  }));
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /does not list "First Post"/);
});

test('verifyBuild catches a wallpaper missing from the wallpapers index', (t) => {
  const root = makeBuildRoot(t);
  const result = verifyBuild({
    root,
    expected: expectedFor({ wallpapers: [{ slug: 'dune', title: 'Dune Ridge' }, { slug: 'x', title: 'Missing Wallpaper' }] })
  });
  assert.match(result.report, /wallpapers\/index\.html does not list "Missing Wallpaper"/);
});

test('verifyBuild catches placeholder leakage in a generated page', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'apps/ledger/index.html', makePage({
    title: 'Ledger | Veyago',
    canonical: SITE + '/apps/ledger/',
    body: '<main>' + GENERATED_APP_MARKER + '<img src="undefined" alt="" /><p>' + FILLER + '</p></main>'
  }));
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /apps\/ledger\/index\.html: leaked placeholder "undefined attribute"/);
});

test('verifyBuild catches sitemap drift', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'sitemap.xml', makeSitemap([SITE + '/journal/', SITE + '/wallpapers/']));
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /missing entry for ".*\/journal\/first-post\/"/);
  assert.match(result.report, /missing entry for ".*\/apps\/ledger\/"/);
});

test('verifyBuild catches a missing sitemap.xml', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'sitemap.xml'));
  assert.match(verifyBuild({ root, expected: expectedFor() }).report, /sitemap\.xml is MISSING/);
});

test('verifyBuild catches a stale generated app page left behind', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'apps/unpublished/index.html', makePage({
    title: 'Unpublished | Veyago',
    canonical: SITE + '/apps/unpublished/',
    body: '<main>' + GENERATED_APP_MARKER + '<p>' + FILLER + '</p></main>'
  }));
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /apps\/unpublished\/index\.html is a stale generated page/);
});

test('verifyBuild leaves hand-authored /apps/ pages alone', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'apps/kept/index.html', '<!DOCTYPE html><html><body>bespoke Kept page</body></html>');
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.deepStrictEqual(result.problems, [], result.report);
});

test('verifyBuild catches a missing site-config.js', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'assets/js/site-config.js'));
  assert.match(verifyBuild({ root, expected: expectedFor() }).report, /site-config\.js is MISSING/);
});

test('verifyBuild catches a broken site-config.js', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'assets/js/site-config.js', 'window.SOMETHING_ELSE = {};\n');
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.match(result.report, /does not assign window\.VEYAGO_SITE_CONFIG/);
  assert.match(result.report, /no announcement block/);
});

test('verifyBuild does not flag a literal null in site-config.js', (t) => {
  const root = makeBuildRoot(t);
  writeFile(root, 'assets/js/site-config.js',
    'window.VEYAGO_SITE_CONFIG = {\n  "announcement": {\n    "active": true,\n' +
    '    "linkText": null,\n    "linkHref": null\n  }\n};\n');
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.deepStrictEqual(result.problems, [], result.report);
});

test('verifyBuild can skip the site-config check for fixture builds', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'assets/js/site-config.js'));
  const result = verifyBuild({ root, expected: expectedFor({ siteConfig: false }) });
  assert.deepStrictEqual(result.problems, [], result.report);
});

test('verifyBuild reports an expected article with no slug instead of silently passing', (t) => {
  const root = makeBuildRoot(t);
  const result = verifyBuild({
    root,
    expected: expectedFor({ articles: [{ title: 'Slugless' }] })
  });
  assert.match(result.report, /an expected article has no slug/);
});

test('verifyBuild reports an expected app page with no slug', (t) => {
  const root = makeBuildRoot(t);
  const result = verifyBuild({
    root,
    expected: expectedFor({ appPages: [{ name: 'Slugless App' }] })
  });
  assert.match(result.report, /an expected app page has no slug/);
});

test('verifyBuild tolerates a missing/!array expected block', (t) => {
  const root = makeBuildRoot(t);
  const result = verifyBuild({ root, expected: { articles: null, wallpapers: 'nope', appPages: undefined } });
  // Only sitemap drift for the pages it no longer expects; nothing should throw.
  assert.strictEqual(typeof result.ok, 'boolean');
  assert.match(result.report, /stale entry/);
});

test('verifyBuild returns a report string usable by a non-technical operator', (t) => {
  const root = makeBuildRoot(t);
  fs.rmSync(path.join(root, 'journal/first-post'), { recursive: true, force: true });
  const result = verifyBuild({ root, expected: expectedFor() });
  assert.strictEqual(typeof result.report, 'string');
  assert.ok(Array.isArray(result.problems));
  assert.strictEqual(result.count, result.problems.length);
  assert.match(result.report, /problem\(s\) found/);
});

// ---------------------------------------------------------------------------
// Drift guards — constants copied from other modules must stay in sync.
// Read as text so this test needs no node_modules.
// ---------------------------------------------------------------------------

test('GENERATED_APP_MARKER still matches GEN_MARKER in app-pages.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'app-pages.js'), 'utf8');
  assert.ok(
    src.indexOf("'" + GENERATED_APP_MARKER + "'") !== -1,
    'app-pages.js no longer contains ' + GENERATED_APP_MARKER
  );
});

test('SITE still matches the SITE constant in chrome.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chrome.js'), 'utf8');
  assert.ok(
    src.indexOf("var SITE = '" + SITE + "'") !== -1,
    'chrome.js SITE constant changed — update verify-build.js'
  );
});

test('sitemap markers still match the ones sitemap.js writes', () => {
  const src = fs.readFileSync(path.join(__dirname, 'sitemap.js'), 'utf8');
  assert.ok(src.indexOf('<!-- BUILD:generated:start -->') !== -1);
  assert.ok(src.indexOf('<!-- BUILD:generated:end -->') !== -1);
});

/* ── checkNoCatastrophicShrink ─────────────────────────────────────────────
   The self-referential-verification hole: a short read from Supabase renders a
   valid-but-empty site that every other check passes. These are the tests that
   matter most in this file. */

test('shrink guard: refuses a total wipe', () => {
  const p = checkNoCatastrophicShrink({ articles: 12 }, { articles: 0 });
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /ZERO pages but 12/);
  assert.match(p[0], /refusing to wipe/i);
});

test('shrink guard: refuses a total wipe across several kinds at once', () => {
  const p = checkNoCatastrophicShrink(
    { articles: 12, appPages: 4 }, { articles: 0, appPages: 0 });
  assert.strictEqual(p.length, 2);
});

test('shrink guard: refuses losing most of the site', () => {
  const p = checkNoCatastrophicShrink({ articles: 10 }, { articles: 3 });
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /7 would be deleted, 70%/);
});

test('shrink guard: allows a normal single unpublish', () => {
  assert.deepStrictEqual(checkNoCatastrophicShrink({ articles: 12 }, { articles: 11 }), []);
});

test('shrink guard: allows growth', () => {
  assert.deepStrictEqual(checkNoCatastrophicShrink({ articles: 3 }, { articles: 9 }), []);
});

test('shrink guard: allows an unchanged build', () => {
  assert.deepStrictEqual(checkNoCatastrophicShrink({ articles: 8 }, { articles: 8 }), []);
});

test('shrink guard: a first build from an empty tree is fine', () => {
  assert.deepStrictEqual(checkNoCatastrophicShrink({ articles: 0 }, { articles: 0 }), []);
  assert.deepStrictEqual(checkNoCatastrophicShrink({ articles: 0 }, { articles: 5 }), []);
});

test('shrink guard: threshold is configurable for a deliberate purge', () => {
  assert.strictEqual(checkNoCatastrophicShrink({ articles: 10 }, { articles: 3 }).length, 1);
  assert.deepStrictEqual(
    checkNoCatastrophicShrink({ articles: 10 }, { articles: 3 }, { maxDropRatio: 0.9 }), []);
  // ...but a wipe is refused even then: zero is never a legitimate build.
  assert.strictEqual(
    checkNoCatastrophicShrink({ articles: 10 }, { articles: 0 }, { maxDropRatio: 1 }).length, 1);
});

test('shrink guard: missing/undefined after-counts read as zero, not as pass', () => {
  assert.strictEqual(checkNoCatastrophicShrink({ articles: 5 }, {}).length, 1);
  assert.strictEqual(checkNoCatastrophicShrink({ articles: 5 }, undefined).length, 1);
});
