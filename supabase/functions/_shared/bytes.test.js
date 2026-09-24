/* Tests for _shared/bytes.ts.
   Deno has no Buffer, and the obvious String.fromCharCode(...bytes) throws
   "Maximum call stack size exceeded" on anything the size of a real
   attachment — so the file that works on a test string fails on a PDF. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'bytes.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('bytes become the same base64 Buffer would make', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
  assert.equal(m.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('a file far bigger than one call can spread still encodes', () => {
  const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251);
  assert.equal(m.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('nothing encodes to nothing', () => {
  assert.equal(m.bytesToBase64(new Uint8Array(0)), '');
});
