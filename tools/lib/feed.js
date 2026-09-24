/* /feed.xml — one RSS 2.0 feed for everything the studio publishes.
 *
 * Perplexity and Bing (which feeds ChatGPT Search) both pick new writing up from
 * a feed faster than from a crawl, and the site had none. Journal articles and
 * the research papers go in the same feed: they are the same author writing at
 * different lengths, and a reader who wants one wants the other.
 *
 * RSS 2.0 rather than Atom because more readers accept it unchanged, with the
 * Atom self-link included, which is the one thing RSS 2.0 lacks.
 */
'use strict';

var { esc } = require('./escape');

var SITE = 'https://www.veyago.cloud';
var FEED_URL = SITE + '/feed.xml';
var TITLE = 'Veyago — field notes and research';
var DESCRIPTION =
  'Writing from Veyago Inc., an independent New York software studio: field notes on fast, ' +
  'private websites and the working papers behind the apps.';

/* RSS dates are RFC 822. "2026-09-03" → "Thu, 03 Sep 2026 09:00:00 GMT". */
function rfc822(iso) {
  var d = new Date(/T/.test(iso) ? iso : iso + 'T09:00:00Z');
  return isNaN(d.getTime()) ? '' : d.toUTCString();
}

function item(it) {
  var parts = [
    '    <title>' + esc(it.title) + '</title>',
    '    <link>' + esc(it.url) + '</link>',
    '    <guid isPermaLink="true">' + esc(it.url) + '</guid>',
    '    <description>' + esc(it.description || '') + '</description>',
    '    <dc:creator>' + esc(it.author || 'Cassian Drefke') + '</dc:creator>'
  ];
  var date = rfc822(it.date);
  if (date) parts.push('    <pubDate>' + date + '</pubDate>');
  (it.categories || []).forEach(function (c) {
    parts.push('    <category>' + esc(c) + '</category>');
  });
  return '  <item>\n' + parts.join('\n') + '\n  </item>';
}

/* items: [{ title, url, description, date, author?, categories? }], any order —
   the feed sorts newest first and caps at `limit`. */
function renderFeed(items, opts) {
  opts = opts || {};
  var limit = opts.limit || 40;
  var sorted = (items || [])
    .filter(function (i) { return i && i.title && i.url; })
    .sort(function (a, b) { return String(a.date) < String(b.date) ? 1 : -1; })
    .slice(0, limit);

  var built = sorted.length ? rfc822(sorted[0].date) : '';

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    '<channel>\n' +
    '  <title>' + esc(TITLE) + '</title>\n' +
    '  <link>' + SITE + '/</link>\n' +
    '  <atom:link href="' + FEED_URL + '" rel="self" type="application/rss+xml" />\n' +
    '  <description>' + esc(DESCRIPTION) + '</description>\n' +
    '  <language>en</language>\n' +
    '  <copyright>Veyago Inc.</copyright>\n' +
    '  <managingEditor>hello@veyago.cloud (Cassian Drefke)</managingEditor>\n' +
    '  <webMaster>hello@veyago.cloud (Cassian Drefke)</webMaster>\n' +
    (built ? '  <lastBuildDate>' + built + '</lastBuildDate>\n' : '') +
    '  <image>\n' +
    '    <url>' + SITE + '/assets/apple-touch-icon.png</url>\n' +
    '    <title>' + esc(TITLE) + '</title>\n' +
    '    <link>' + SITE + '/</link>\n' +
    '  </image>\n' +
    sorted.map(item).join('\n') + (sorted.length ? '\n' : '') +
    '</channel>\n</rss>\n';
}

/* Journal rows (the shape tools/build.js already holds) → feed items. */
function articleItems(articles) {
  return (articles || []).map(function (a) {
    return {
      title: a.title,
      url: SITE + '/journal/' + a.slug + '/',
      description: a.excerpt || a.dek || '',
      date: a.updated_at || a.published_at,
      categories: ['Field notes']
    };
  });
}

module.exports = { renderFeed, articleItems, rfc822, SITE, FEED_URL, TITLE, DESCRIPTION };
