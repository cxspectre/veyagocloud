'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeHtml } = require('./sanitize');

test('keeps the allowlisted inline + list tags', () => {
  const out = sanitizeHtml('<p>Hello <strong>bold</strong> and <em>italic</em></p>');
  assert.strictEqual(out, '<p>Hello <strong>bold</strong> and <em>italic</em></p>');
  const list = sanitizeHtml('<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(list, '<ul><li>a</li><li>b</li></ul>');
});

test('strips <script> entirely', () => {
  const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
  assert.ok(!/script/i.test(out), 'script tag/content removed');
  assert.ok(out.includes('<p>ok</p>'));
});

test('strips disallowed tags but keeps their text', () => {
  const out = sanitizeHtml('<div onclick="x()">text <img src=x onerror=alert(1)></div>');
  assert.ok(!/<div/i.test(out));
  assert.ok(!/<img/i.test(out));
  assert.ok(!/onerror|onclick/i.test(out));
  assert.ok(out.includes('text'));
});

test('forces target=_blank and rel=noopener on links', () => {
  const out = sanitizeHtml('<p><a href="https://example.com">x</a></p>');
  assert.ok(out.includes('href="https://example.com"'));
  assert.ok(out.includes('target="_blank"'));
  assert.ok(/rel="noopener/.test(out));
});

test('drops javascript: URLs', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out), 'javascript: scheme removed');
});

test('empty / nullish input returns empty string', () => {
  assert.strictEqual(sanitizeHtml(''), '');
  assert.strictEqual(sanitizeHtml(null), '');
  assert.strictEqual(sanitizeHtml(undefined), '');
});
