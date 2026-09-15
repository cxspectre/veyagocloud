/* Tests for _shared/attachment-cleanup.ts — which files in the mail-attachments
   bucket a cleanup run should remove.

   send-mail already removes a message's attachments the moment it sends
   (0038 §5) — what is left behind is only ever a draft that was closed,
   refreshed away, or never finished. There is no table of "pending uploads"
   to check against (compose keeps that in the browser, not the database), so
   the only honest signal left is age: a file nobody has touched in a couple
   of days was never going to be sent. What is here is the decision only — the
   actual Storage list() and remove() calls need live storage, and are the
   cleanup-mail-attachments function's job, not this file's (see its own
   header for why that split is deliberate). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'attachment-cleanup.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const HOUR = 3600_000;
const NOW = Date.parse('2026-09-15T12:00:00Z');

/* ── isStaleAttachment ───────────────────────────────────────────────── */

test('an upload touched within the window is not stale', () => {
  const fresh = { name: 'a/b/c.pdf', updated_at: new Date(NOW - 47 * HOUR).toISOString() };
  assert.equal(m.isStaleAttachment(fresh, NOW), false);
});

test('an upload untouched for the whole window is stale, including right at the edge', () => {
  const atEdge = { name: 'a/b/c.pdf', updated_at: new Date(NOW - 48 * HOUR).toISOString() };
  assert.equal(m.isStaleAttachment(atEdge, NOW), true);
  const wellPast = { name: 'a/b/c.pdf', updated_at: new Date(NOW - 30 * 24 * HOUR).toISOString() };
  assert.equal(m.isStaleAttachment(wellPast, NOW), true);
});

test('created_at stands in when Storage has not recorded an update', () => {
  const obj = { name: 'a/b/c.pdf', created_at: new Date(NOW - 72 * HOUR).toISOString(), updated_at: null };
  assert.equal(m.isStaleAttachment(obj, NOW), true);
});

test('updated_at is trusted over created_at when both are present', () => {
  const obj = {
    name: 'a/b/c.pdf',
    created_at: new Date(NOW - 200 * HOUR).toISOString(),   // uploaded long ago
    updated_at: new Date(NOW - 1 * HOUR).toISOString(),     // but touched an hour ago
  };
  assert.equal(m.isStaleAttachment(obj, NOW), false, 'a recent touch means it is not simply forgotten');
});

test('no timestamp Storage will actually give — or one that will not parse — is left alone, not guessed stale', () => {
  assert.equal(m.isStaleAttachment({ name: 'x' }, NOW), false);
  assert.equal(m.isStaleAttachment({ name: 'x', updated_at: null, created_at: null }, NOW), false);
  assert.equal(m.isStaleAttachment({ name: 'x', updated_at: 'not a date' }, NOW), false);
});

test('a caller may ask for a different window than the default', () => {
  const obj = { name: 'a/b/c.pdf', updated_at: new Date(NOW - 2 * HOUR).toISOString() };
  assert.equal(m.isStaleAttachment(obj, NOW, 1), true, 'one hour: two hours old counts as stale');
  assert.equal(m.isStaleAttachment(obj, NOW, 24), false, 'a day: two hours old does not');
});

test('the default window is two days, deliberately longer than anyone composes a message for', () => {
  assert.equal(m.STALE_AFTER_HOURS, 48);
});

/* ── staleAttachmentPaths ────────────────────────────────────────────── */

test('only the stale paths come back, named the way Storage names them', () => {
  const objects = [
    { name: 'u1/up1/keep.pdf', updated_at: new Date(NOW - 1 * HOUR).toISOString() },
    { name: 'u1/up2/old.pdf', updated_at: new Date(NOW - 100 * HOUR).toISOString() },
    { name: 'u2/up3/unknown.pdf' },
  ];
  assert.deepEqual(m.staleAttachmentPaths(objects, NOW), ['u1/up2/old.pdf']);
});

test('nothing in, nothing stale, out', () => {
  assert.deepEqual(m.staleAttachmentPaths([], NOW), []);
});

/* ── chunkPaths ──────────────────────────────────────────────────────── */

test('paths are grouped for Storage.remove(), which takes a list per call', () => {
  assert.deepEqual(m.chunkPaths(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(m.chunkPaths(['a', 'b'], 2), [['a', 'b']], 'exactly one chunk\'s worth');
  assert.deepEqual(m.chunkPaths([], 2), []);
});

test('a chunk size that is not a positive whole number falls back to one path at a time, never an infinite loop', () => {
  assert.deepEqual(m.chunkPaths(['a', 'b'], 0), [['a'], ['b']]);
  assert.deepEqual(m.chunkPaths(['a', 'b'], -5), [['a'], ['b']]);
  assert.deepEqual(m.chunkPaths(['a', 'b'], 1.5), [['a'], ['b']]);
});
