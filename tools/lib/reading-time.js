/* Estimate reading time (whole minutes) from an article's block body, counting
   the words a reader actually reads: text, headings, quotes, markers, the opening
   answer and the cells of a table. Roughly 200 words/minute (spec §9). Always at
   least 1.

   blockWords() is exported so the BlogPosting's wordCount and the "N min read"
   line on the page can never be computed two different ways. */
'use strict';

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

function countWords(s) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  return t ? t.split(' ').length : 0;
}

function blockWords(blocks) {
  return (blocks || []).reduce(function (words, b) {
    if (!b || !b.type) return words;
    if (b.type === 'text' || b.type === 'answer') return words + countWords(stripTags(b.html));
    if (b.type === 'heading') return words + countWords(b.text);
    if (b.type === 'quote') return words + countWords(b.text) + countWords(b.attribution);
    if (b.type === 'section_marker') return words + countWords(b.text);
    if (b.type === 'image') return words + countWords(b.caption);
    if (b.type === 'table') {
      return words + countWords(b.caption) + countWords((b.columns || []).join(' ')) +
        countWords((b.rows || []).map(function (r) { return r.join(' '); }).join(' '));
    }
    return words;
  }, 0);
}

function readingMinutes(blocks, wordsPerMinute) {
  return Math.max(1, Math.round(blockWords(blocks) / (wordsPerMinute || 200)));
}

module.exports = { readingMinutes, blockWords, countWords, stripTags };
