'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { locToFile, updateLastmods, parseArgs } = require('./sitemap-lastmod');

const SITE = 'https://www.veyago.cloud';

test('locToFile maps clean URLs to the files Vercel serves', () => {
  assert.strictEqual(locToFile(SITE + '/'), 'index.html');
  assert.strictEqual(locToFile(SITE), 'index.html');
  assert.strictEqual(locToFile(SITE + '/apps/'), 'apps/index.html');
  assert.strictEqual(locToFile(SITE + '/projects/the-unkept-life/'), 'projects/the-unkept-life/index.html');
  assert.strictEqual(locToFile(SITE + '/admin/team'), 'admin/team.html');
  assert.strictEqual(locToFile('https://example.com/'), null);
  assert.strictEqual(locToFile(null), null);
});

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>' + SITE + '/</loc><lastmod>2026-06-07</lastmod><priority>1.0</priority></url>',
  '  <url><loc>' + SITE + '/apps/</loc><lastmod>2026-06-12</lastmod><priority>0.9</priority></url>',
  '  <url><loc>' + SITE + '/team/</loc><priority>0.6</priority></url>',
  '  <!-- BUILD:generated:start -->',
  '  <url><loc>' + SITE + '/journal/</loc><lastmod>2026-01-01</lastmod><priority>0.8</priority></url>',
  '  <!-- BUILD:generated:end -->',
  '  <url><loc>' + SITE + '/legal/</loc><lastmod>2026-06-07</lastmod><priority>0.3</priority></url>',
  '</urlset>',
].join('\n');

const dates = {
  [SITE + '/']: '2026-09-01',
  [SITE + '/apps/']: '2026-06-12',   // unchanged
  [SITE + '/team/']: '2026-08-16',   // had no <lastmod>
  [SITE + '/journal/']: '2026-09-02', // inside the managed block: must be ignored
  [SITE + '/legal/']: '2026-08-16',
};
const dateFor = (loc) => dates[loc] || null;

test('updateLastmods rewrites, inserts, and reports only real changes', () => {
  const { xml, changes } = updateLastmods(XML, dateFor);
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/<\/loc><lastmod>2026-09-01<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/team\/<\/loc><lastmod>2026-08-16<\/lastmod><priority>0\.6<\/priority>/);
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/legal\/<\/loc><lastmod>2026-08-16<\/lastmod>/);
  assert.deepStrictEqual(changes, [
    { loc: SITE + '/', from: '2026-06-07', to: '2026-09-01' },
    { loc: SITE + '/team/', from: null, to: '2026-08-16' },
    { loc: SITE + '/legal/', from: '2026-06-07', to: '2026-08-16' },
  ]);
});

test('updateLastmods never touches the build-managed block', () => {
  const { xml } = updateLastmods(XML, dateFor);
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/journal\/<\/loc><lastmod>2026-01-01<\/lastmod>/);
});

test('updateLastmods honours --skip and unknown dates', () => {
  const { xml, changes } = updateLastmods(XML, (loc) => (loc.endsWith('/legal/') ? 'not-a-date' : dateFor(loc)), { skip: ['/'] });
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/<\/loc><lastmod>2026-06-07<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/www\.veyago\.cloud\/legal\/<\/loc><lastmod>2026-06-07<\/lastmod>/);
  assert.deepStrictEqual(changes.map((c) => c.loc), [SITE + '/team/']);
});

test('updateLastmods is a pure function of its input', () => {
  const before = XML;
  updateLastmods(XML, dateFor);
  assert.strictEqual(XML, before);
});

test('parseArgs reads --dry-run and comma-separated --skip', () => {
  assert.deepStrictEqual(parseArgs(['--dry-run', '--skip', '/,/services/']), { dryRun: true, skip: ['/', '/services/'] });
  assert.deepStrictEqual(parseArgs([]), { dryRun: false, skip: [] });
});
