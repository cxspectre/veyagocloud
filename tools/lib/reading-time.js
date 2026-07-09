/* Estimate reading time (whole minutes) from an article's block body, counting
   the words a reader actually reads: text, headings, quotes, markers. Roughly
   200 words/minute (spec §9). Always at least 1. */
'use strict';

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

function countWords(s) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  return t ? t.split(' ').length : 0;
}

function readingMinutes(blocks, wordsPerMinute) {
  var wpm = wordsPerMinute || 200;
  var words = 0;
  (blocks || []).forEach(function (b) {
    if (!b || !b.type) return;
    if (b.type === 'text') words += countWords(stripTags(b.html));
    else if (b.type === 'heading') words += countWords(b.text);
    else if (b.type === 'quote') words += countWords(b.text) + countWords(b.attribution);
    else if (b.type === 'section_marker') words += countWords(b.text);
    else if (b.type === 'image') words += countWords(b.caption);
  });
  return Math.max(1, Math.round(words / wpm));
}

module.exports = { readingMinutes, countWords, stripTags };
