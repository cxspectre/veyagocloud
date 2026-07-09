'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderBlocks, headingId, tocLabel } = require('./render-blocks');

test('section_marker renders as an .eyebrow label and escapes text', () => {
  const { html } = renderBlocks([{ type: 'section_marker', text: 'Field Notes <x>' }]);
  assert.ok(html.includes('class="eyebrow paper-marker"'));
  assert.ok(html.includes('Field Notes &lt;x&gt;'));
});

test('level-2 heading gets an id and enters the toc; level-3 does not', () => {
  const { html, toc } = renderBlocks([
    { type: 'heading', level: 2, text: 'Building the spine' },
    { type: 'heading', level: 3, text: 'A sub point' },
  ]);
  assert.ok(html.includes('<h2 id="building-the-spine">Building the spine</h2>'));
  assert.ok(html.includes('<h3>A sub point</h3>'));
  assert.deepStrictEqual(toc, [{ id: 'building-the-spine', label: 'Building the spine' }]);
});

test('numbered heading renders a .sec-n number and section-N id', () => {
  const { html, toc } = renderBlocks([{ type: 'heading', level: 2, text: '3. The middle' }]);
  assert.ok(html.includes('<h2 id="section-3"><span class="sec-n">3.</span> The middle</h2>'));
  assert.strictEqual(toc[0].id, 'section-3');
  assert.strictEqual(toc[0].label, 'The middle');
});

test('text block is sanitised (script stripped, link hardened)', () => {
  const { html } = renderBlocks([
    { type: 'text', html: '<p>Read <a href="https://x.io">this</a></p><script>evil()</script>' },
  ]);
  assert.ok(!/script/i.test(html));
  assert.ok(html.includes('target="_blank"'));
});

test('image renders a figure with alt and optional caption', () => {
  const withCap = renderBlocks([{ type: 'image', url: '/a.png', alt: 'Alt "q"', caption: 'A cap' }]).html;
  assert.ok(withCap.includes('<figure class="paper-figure">'));
  assert.ok(withCap.includes('src="/a.png"'));
  assert.ok(withCap.includes('alt="Alt &quot;q&quot;"'));
  assert.ok(withCap.includes('<figcaption>A cap</figcaption>'));
  assert.ok(withCap.includes('loading="lazy"'));

  const noCap = renderBlocks([{ type: 'image', url: '/a.png', alt: '' }]).html;
  assert.ok(!noCap.includes('figcaption'));

  const noUrl = renderBlocks([{ type: 'image', alt: 'x' }]).html;
  assert.strictEqual(noUrl, '');
});

test('quote renders a pull-quote with optional attribution', () => {
  const withAttr = renderBlocks([{ type: 'quote', text: 'The backbone is yours.', attribution: 'Veyago OS' }]).html;
  assert.ok(withAttr.includes('<blockquote class="pull-quote">'));
  assert.ok(withAttr.includes('<p>The backbone is yours.</p>'));
  assert.ok(withAttr.includes('<cite>Veyago OS</cite>'));

  const noAttr = renderBlocks([{ type: 'quote', text: 'No source.' }]).html;
  assert.ok(!noAttr.includes('<cite>'));
});

test('divider renders a hairline rule', () => {
  assert.ok(renderBlocks([{ type: 'divider' }]).html.includes('<hr class="paper-rule" />'));
});

test('unknown / malformed blocks are skipped', () => {
  const { html } = renderBlocks([{ type: 'mystery' }, null, {}, { type: 'divider' }]);
  assert.strictEqual(html, '<hr class="paper-rule" />');
});

test('headingId and tocLabel helpers behave', () => {
  assert.strictEqual(headingId('Plain Title'), 'plain-title');
  assert.strictEqual(headingId('2. Numbered'), 'section-2');
  assert.strictEqual(tocLabel('Topic: subtitle here'), 'Topic');
});
