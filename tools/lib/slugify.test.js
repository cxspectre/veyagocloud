'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { slugify } = require('./slugify');

test('slugify lowercases and hyphenates', () => {
  assert.strictEqual(slugify('Building The Spine'), 'building-the-spine');
});

test('slugify drops apostrophes without leaving a hyphen', () => {
  assert.strictEqual(slugify("Don't Panic"), 'dont-panic');
  assert.strictEqual(slugify('The Unkept Life'), 'the-unkept-life');
});

test('slugify collapses runs of punctuation and trims edges', () => {
  assert.strictEqual(slugify('  Hello, World!!  '), 'hello-world');
  assert.strictEqual(slugify('a / b / c'), 'a-b-c');
});

test('slugify handles empty / nullish input', () => {
  assert.strictEqual(slugify(''), '');
  assert.strictEqual(slugify(null), '');
  assert.strictEqual(slugify(undefined), '');
});
