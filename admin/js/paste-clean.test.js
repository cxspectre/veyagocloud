/* Tests for admin/js/paste-clean.js.

   The point of this file is the last block: paste-clean.js and
   tools/lib/sanitize.js are two independent implementations of one allowlist,
   and if they ever disagree the editor goes back to lying — showing the author
   something the build will delete. So the two are compared directly, over real
   paste payloads, rather than each being tested against its own expectations. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'paste-clean.js'), 'utf8');
const { sanitizeHtml, ALLOWED_TAGS } = require('../../tools/lib/sanitize');

function load() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://veyago.cloud/admin/article',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  vm.runInContext(SRC, dom.getInternalVMContext());
  return dom.window.adminPasteClean;
}

const pc = load();
const clean = (h) => pc.clean(h).html;

/* ── The allowlist ────────────────────────────────────────────────────── */

test('keeps exactly the tags the build keeps', () => {
  assert.equal(clean('<p>Hello <strong>there</strong> and <em>hi</em></p>'),
               '<p>Hello <strong>there</strong> and <em>hi</em></p>');
  assert.equal(clean('<ul><li>one</li><li>two</li></ul>'),
               '<ul><li>one</li><li>two</li></ul>');
  assert.equal(clean('line<br>break'), 'line<br>break');
});

/* A heading pasted from Word is the single most common case, and the one that
   used to vanish between Publish and the live site. */
test('unwraps a disallowed element but keeps its words', () => {
  assert.equal(clean('<h2>A real heading</h2>'), 'A real heading');
  assert.equal(clean('<div><span>nested</span> text</div>'), 'nested text');
  assert.equal(clean('<table><tr><td>cell</td></tr></table>'), 'cell');
});

test('drops void media entirely — there are no words to keep', () => {
  assert.equal(clean('<p>before</p><img src="https://x/y.png"><p>after</p>'),
               '<p>before</p><p>after</p>');
});

/* Keeping the text of a <style> block would paste CSS into the article. */
test('drops script and style along with their contents', () => {
  assert.equal(clean('<style>p{color:red}</style><p>ok</p>'), '<p>ok</p>');
  assert.equal(clean('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>');
});

/* ── Attributes ───────────────────────────────────────────────────────── */

test('strips every attribute off allowed tags', () => {
  assert.equal(clean('<p class="x" style="color:red" data-id="9">t</p>'), '<p>t</p>');
  assert.equal(clean('<strong style="font-weight:900">b</strong>'), '<strong>b</strong>');
});

test('keeps a safe href and adds the same rel the build adds', () => {
  const out = clean('<a href="https://example.com" class="x">link</a>');
  assert.match(out, /href="https:\/\/example\.com"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.ok(!out.includes('class='));
});

test('relative links and anchors survive', () => {
  assert.match(clean('<a href="/journal/x">a</a>'), /href="\/journal\/x"/);
  assert.match(clean('<a href="#top">a</a>'), /href="#top"/);
});

/* A paste is untrusted input that lands in a contenteditable on an
   authenticated page, so this is a real boundary, not just fidelity. */
test('a dangerous href becomes plain text rather than a live link', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>',
                     'JaVaScRiPt:alert(1)', 'vbscript:x']) {
    const out = clean('<a href="' + bad + '">click me</a>');
    assert.equal(out, 'click me', bad + ' must not survive as an anchor');
  }
});

test('event handlers never survive', () => {
  const out = clean('<p onclick="steal()" onmouseover="x()">t</p><img src=x onerror="y()">');
  assert.ok(!/onclick|onmouseover|onerror/i.test(out));
});

/* ── What the user is told ────────────────────────────────────────────── */

test('describes what was dropped in words, not tag names', () => {
  assert.equal(pc.describe(pc.clean('<h2>a</h2><h3>b</h3>').dropped), '2 headings');
  assert.equal(pc.describe(pc.clean('<img src="x">').dropped), '1 image');
  assert.equal(pc.describe(pc.clean('<h2>a</h2><img src="x">').dropped),
               '1 heading and 1 image');
});

/* Word and Notion wrap everything in spans and divs. Reporting those would
   make the notice fire on every paste and mean nothing. */
test('says nothing when only structural noise was removed', () => {
  assert.equal(pc.describe(pc.clean('<div><span>plain words</span></div>').dropped), null);
  assert.equal(pc.describe(pc.clean('<p>clean already</p>').dropped), null);
});

/* ── The agreement that matters ───────────────────────────────────────── */

test('its allowlist is identical to the build\'s', () => {
  assert.deepEqual([...pc.ALLOWED].sort(), [...ALLOWED_TAGS].sort(),
    'paste-clean.js and tools/lib/sanitize.js must permit the same tags');
});

/* Real payload shapes, normalised for attribute order and self-closing style
   before comparison — the question is whether the same CONTENT survives, not
   whether two libraries serialise identically. */
const CORPUS = [
  '<h1>Title</h1><p>Body text</p>',
  '<div><p>Word-style <span style="font-weight:700">bold</span> text</p></div>',
  '<p>Keep <strong>this</strong> and <em>this</em></p>',
  '<ul><li>one</li><li>two</li></ul>',
  '<ol><li>first</li></ol>',
  '<table><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>',
  '<blockquote>quoted words</blockquote>',
  '<pre><code>const x = 1;</code></pre>',
  '<p>before</p><img src="https://example.com/a.png" alt="a"><p>after</p>',
  '<p>text with <a href="https://example.com">a link</a></p>',
  '<h2>Heading</h2><p>Para</p><h3>Sub</h3><p>More</p>',
  '<section><article><p>deeply nested</p></article></section>',
  '<p>line one<br>line two</p>',
  '<font face="Arial"><p>legacy markup</p></font>',
  '<p></p><p>empty sibling</p>',
];

function textOf(html) {
  /* Compare the words that survive, and the tags that survive, separately —
     that is what "the same thing shipped" actually means here. */
  const d = new JSDOM('<!doctype html><body>' + html + '</body>');
  return d.window.document.body.textContent.replace(/\s+/g, ' ').trim();
}
function tagsOf(html) {
  const d = new JSDOM('<!doctype html><body>' + html + '</body>');
  return [...d.window.document.body.querySelectorAll('*')]
    .map((e) => e.tagName.toLowerCase()).sort().join(',');
}

for (const input of CORPUS) {
  test(`browser and build agree on: ${input.slice(0, 46)}`, () => {
    const browser = clean(input);
    const build = sanitizeHtml(input);
    assert.equal(textOf(browser), textOf(build), 'surviving text must match');
    assert.equal(tagsOf(browser), tagsOf(build), 'surviving tags must match');
  });
}

/* If the editor and the build disagree, the editor is lying again — so a
   round-trip through both must be a no-op on the second pass. */
test('build sanitising an already-cleaned paste changes nothing', () => {
  for (const input of CORPUS) {
    const once = clean(input);
    assert.equal(textOf(sanitizeHtml(once)), textOf(once),
      'the build must not remove anything the editor kept: ' + input.slice(0, 40));
  }
});
