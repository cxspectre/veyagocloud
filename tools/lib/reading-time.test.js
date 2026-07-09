'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readingMinutes, countWords, stripTags } = require('./reading-time');

test('stripTags removes markup', () => {
  assert.strictEqual(stripTags('<p>Hello <strong>there</strong></p>').trim(), 'Hello  there');
});

test('countWords counts whitespace-separated tokens', () => {
  assert.strictEqual(countWords('one two three'), 3);
  assert.strictEqual(countWords('   '), 0);
  assert.strictEqual(countWords(''), 0);
});

test('readingMinutes is at least 1 even when empty', () => {
  assert.strictEqual(readingMinutes([]), 1);
  assert.strictEqual(readingMinutes(null), 1);
});

test('readingMinutes counts words across readable blocks at ~200 wpm', () => {
  const para = Array(400).fill('word').join(' '); // 400 words
  const blocks = [
    { type: 'heading', level: 2, text: 'A Heading' },        // 2 words
    { type: 'text', html: '<p>' + para + '</p>' },           // 400 words
    { type: 'image', url: 'x', caption: 'one two' },         // 2 words
    { type: 'divider' },                                      // 0
  ];
  // 404 / 200 = 2.02 → rounds to 2
  assert.strictEqual(readingMinutes(blocks), 2);
});
