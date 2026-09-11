#!/usr/bin/env node
/* journal-fixture.js — reconstruct the journal fixture from the committed export.
 *
 *   node tools/journal-fixture.js                    # write data/journal/published.json
 *   node tools/journal-fixture.js --verify           # rebuild from it and diff the bodies
 *
 * The journal's source of truth is Supabase, and `npm run build` needs its
 * credentials. That makes an edit to an article impossible from a checkout
 * alone: you cannot rebuild /journal/ without pulling every row, and rebuilding
 * from a partial fixture would silently drop the articles it does not contain.
 *
 * This reads the committed /journal/<slug>/index.html pages back into the block
 * shape tools/build.js expects, so the whole journal can be rebuilt offline and
 * an article can be edited in one place. --verify proves it is lossless: it
 * re-renders every article from the fixture and compares the .paper-body markup
 * with what is on disk.
 *
 * The fixture is a convenience, not a second source of truth. An edit made here
 * still has to go back into Supabase (or into data/journal/drafts/) or the next
 * `npm run build` will overwrite it.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var ROOT = path.resolve(__dirname, '..');
var JOURNAL = path.join(ROOT, 'journal');
var OUT = path.join(ROOT, 'data', 'journal', 'published.json');

/* The renderer joins blocks with a newline and exactly eight spaces — but a
   multi-line block closes at that same indent ("\n        </blockquote>"), so the
   separator alone would cut a quote in half. Splitting only where something that
   can START a block follows keeps every block whole. */
var BLOCK_START = [
  '<p class="eyebrow paper-marker">',
  '<h2 ', '<h3>',
  '<hr class="paper-rule"',
  '<blockquote class="pull-quote">',
  '<figure class="paper-figure">',
  '<div class="answer-first">',
  '<div class="table-wrap">',
  '<p>', '<ul>', '<ol>', '<table', '<dl>'
];
var BLOCK_SEP = new RegExp('\\n {8}(?=' + BLOCK_START.map(function (t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, function (ch) { return '\\' + ch; });
}).join('|') + ')');

function read(file) { return fs.readFileSync(file, 'utf8'); }

function slugs() {
  return fs.readdirSync(JOURNAL, { withFileTypes: true })
    .filter(function (e) { return e.isDirectory() && fs.existsSync(path.join(JOURNAL, e.name, 'index.html')); })
    .map(function (e) { return e.name; })
    .sort();
}

function meta(doc, selector, attr) {
  var el = doc.querySelector(selector);
  return el ? (el.getAttribute(attr || 'content') || '') : '';
}

/* One rendered chunk → the block it came from. Mirrors tools/lib/render-blocks.js
   in reverse; anything it cannot recognise throws rather than being dropped. */
function toBlock(chunk) {
  var trimmed = chunk.trim();
  if (!trimmed) return null;

  var marker = trimmed.match(/^<p class="eyebrow paper-marker">([\s\S]*)<\/p>$/);
  if (marker) return { type: 'section_marker', text: decode(marker[1]) };

  var h2 = trimmed.match(/^<h2 id="[^"]*">([\s\S]*)<\/h2>$/);
  if (h2) {
    var inner = h2[1].replace(/^<span class="sec-n">([^<]*)<\/span>\s*/, '$1 ');
    return { type: 'heading', level: 2, text: decode(inner) };
  }

  var h3 = trimmed.match(/^<h3>([\s\S]*)<\/h3>$/);
  if (h3) return { type: 'heading', level: 3, text: decode(h3[1]) };

  if (/^<hr class="paper-rule" \/>$/.test(trimmed)) return { type: 'divider' };

  var quote = trimmed.match(/^<blockquote class="pull-quote">\s*<p>([\s\S]*?)<\/p>(?:\s*<cite>([\s\S]*?)<\/cite>)?\s*<\/blockquote>$/);
  if (quote) {
    var q = { type: 'quote', text: decode(quote[1]) };
    if (quote[2]) q.attribution = decode(quote[2]);
    return q;
  }

  var figure = trimmed.match(/^<figure class="paper-figure">\s*<img src="([^"]*)" alt="([^"]*)"[^>]*\/>(?:\s*<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>$/);
  if (figure) {
    var img = { type: 'image', url: figure[1], alt: decode(figure[2]) };
    if (figure[3]) img.caption = decode(figure[3]);
    return img;
  }

  var answer = trimmed.match(/^<div class="answer-first">([\s\S]*)<\/div>$/);
  if (answer) return { type: 'answer', html: answer[1] };

  if (/^<div class="table-wrap">/.test(trimmed)) return tableBlock(trimmed);

  if (/^</.test(trimmed)) return { type: 'text', html: trimmed };

  throw new Error('unrecognised block: ' + trimmed.slice(0, 120));
}

/* A rendered comparison table back into { caption, columns, rows }. */
function tableBlock(markup) {
  var doc = new JSDOM('<div>' + markup + '</div>').window.document;
  var table = doc.querySelector('table.data');
  if (!table) throw new Error('table-wrap with no table.data');
  var caption = table.querySelector('caption');
  var head = Array.prototype.slice.call(table.querySelectorAll('thead th'))
    .map(function (th) { return th.textContent; });
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr')).map(function (tr) {
    return Array.prototype.slice.call(tr.children).map(function (cell) { return cell.textContent; });
  });
  var block = { type: 'table', rows: rows };
  if (caption) block.caption = caption.textContent;
  if (head.length) block.columns = head;
  return block;
}

/* Only the five entities the renderer emits; everything else is already literal. */
function decode(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extract(slug) {
  var html = read(path.join(JOURNAL, slug, 'index.html'));
  var doc = new JSDOM(html).window.document;

  var bodyHtml = html.match(/<div class="paper-body">\n([\s\S]*?)\n {8}<\/div>/);
  if (!bodyHtml) throw new Error(slug + ': could not find .paper-body');

  /* A block whose own markup closed a <div> at the body's indent would end the
     lazy match early and silently drop everything after it. Every nested block
     is indented deeper than the body for exactly that reason; this is the alarm
     if one ever is not. */
  var body = bodyHtml[1];
  var opens = (body.match(/<div\b/g) || []).length;
  var closes = (body.match(/<\/div>/g) || []).length;
  if (opens !== closes) {
    throw new Error(slug + ': .paper-body capture is unbalanced (' + opens + ' <div>, ' + closes +
      ' </div>) — a block is closing a div at the body indent and truncating the capture');
  }

  var blocks = body.split(BLOCK_SEP).map(toBlock).filter(Boolean);

  var dek = doc.querySelector('.paper-dek');
  var cover = doc.querySelector('.paper-cover img');
  var published = meta(doc, 'meta[property="article:published_time"]');
  var modified = meta(doc, 'meta[property="article:modified_time"]');

  var article = {
    slug: slug,
    title: doc.querySelector('.paper-title').textContent.trim(),
    dek: dek ? dek.textContent.trim() : '',
    excerpt: meta(doc, 'meta[name="description"]'),
    status: 'published',
    published_at: published + 'T09:00:00Z'
  };
  if (modified && modified !== published) article.updated_at = modified + 'T09:00:00Z';
  if (cover) article.cover_image_url = cover.getAttribute('src');
  article.body = blocks;
  return article;
}

/* Newest first, the order tools/build.js gets from Supabase. */
function build() {
  var articles = slugs().map(extract).sort(function (a, b) {
    return a.published_at < b.published_at ? 1 : -1;
  });
  return { articles: articles, wallpapers: [] };
}

function verify(fixture) {
  var { renderArticlePage } = require('./lib/journal-pages');
  var problems = [];
  fixture.articles.forEach(function (a) {
    var onDisk = read(path.join(JOURNAL, a.slug, 'index.html'));
    var rebuilt = renderArticlePage(a);
    var want = (onDisk.match(/<div class="paper-body">\n([\s\S]*?)\n\s{8}<\/div>/) || [])[1];
    var got = (rebuilt.match(/<div class="paper-body">\n([\s\S]*?)\n\s{8}<\/div>/) || [])[1];
    if (want !== got) {
      var at = 0;
      while (at < want.length && want[at] === got[at]) at++;
      problems.push(a.slug + ': body differs at character ' + at + '\n        on disk: ' +
        JSON.stringify(want.slice(at, at + 90)) + '\n        rebuilt: ' + JSON.stringify(got.slice(at, at + 90)));
    }
  });
  return problems;
}

function main(argv) {
  var fixture = build();
  var counts = fixture.articles.map(function (a) { return a.slug + ' (' + a.body.length + ' blocks)'; });

  if (argv.indexOf('--verify') !== -1) {
    var problems = verify(fixture);
    console.log(counts.map(function (c) { return '      ' + c; }).join('\n'));
    if (problems.length) {
      problems.forEach(function (p) { console.log('  !   ' + p); });
      console.log('journal fixture: ' + problems.length + ' article(s) do not round-trip.');
      return 1;
    }
    console.log('journal fixture: all ' + fixture.articles.length + ' articles round-trip exactly.');
    return 0;
  }

  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log('wrote data/journal/published.json');
  console.log(counts.map(function (c) { return '      ' + c; }).join('\n'));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { build, extract, verify, toBlock };
