'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseBuildLog, buildLogProblems, expectationsFrom, passed } = require('./verify-cli');

const GOOD_LOG = [
  'supabase: 2 article(s), 3 wallpaper(s), 4 app(s), announcement active',
  '  wrote assets/js/site-config.js',
  '  built /journal/alpha/  (Alpha Title)',
  '  built /journal/beta/  (Beta)',
  '  built /journal/  (2 card(s))',
  '  built /wallpapers/  (3 wallpaper(s))',
  '  skipped /apps/kept/  (bespoke page — see /kept/)',
  '  built /apps/zeta/  (Zeta)',
  '  updated sitemap.xml',
  'done.'
].join('\n');

test('parseBuildLog reads the fetched counts and the rendered pages', () => {
  const log = parseBuildLog(GOOD_LOG);
  assert.deepStrictEqual(log.fetched, { articles: 2, wallpapers: 3, apps: 4 });
  assert.deepStrictEqual(log.articles, [
    { slug: 'alpha', title: 'Alpha Title' },
    { slug: 'beta', title: 'Beta' }
  ]);
  assert.deepStrictEqual(log.appPages, [{ slug: 'zeta', name: 'Zeta' }]);
  assert.strictEqual(log.wallpapers, 3);
});

test('parseBuildLog keeps a title that contains brackets', () => {
  const log = parseBuildLog('  built /journal/x/  (Kept (v2) — notes)');
  assert.deepStrictEqual(log.articles, [{ slug: 'x', title: 'Kept (v2) — notes' }]);
});

test('parseBuildLog does not mistake the journal index for an article page', () => {
  const log = parseBuildLog('  built /journal/  (0 card(s))');
  assert.deepStrictEqual(log.articles, []);
});

test('parseBuildLog ignores skipped app pages', () => {
  const log = parseBuildLog('  skipped /apps/kept/  (bespoke page — see /kept/)');
  assert.deepStrictEqual(log.appPages, []);
});

test('a complete build log has no problems', () => {
  assert.deepStrictEqual(buildLogProblems(parseBuildLog(GOOD_LOG)), []);
});

test('fewer rendered article pages than fetched articles is a problem', () => {
  const log = parseBuildLog([
    'supabase: 2 article(s), 0 wallpaper(s), 0 app(s), no active announcement',
    '  built /journal/alpha/  (Alpha)',
    '  built /wallpapers/  (0 wallpaper(s))'
  ].join('\n'));
  const problems = buildLogProblems(log);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /rendered 1 article page/);
});

test('a log that never reached Supabase is a problem on its own', () => {
  const problems = buildLogProblems(parseBuildLog('build failed: boom'));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /never got past reading Supabase/);
});

test('a log that stops before the wallpapers index is a problem', () => {
  const log = parseBuildLog([
    'supabase: 1 article(s), 0 wallpaper(s), 0 app(s), no active announcement',
    '  built /journal/alpha/  (Alpha)'
  ].join('\n'));
  assert.ok(buildLogProblems(log).some((p) => /stopped before it finished/.test(p)));
});

test('a wallpaper index that lists fewer than were fetched is a problem', () => {
  const log = parseBuildLog([
    'supabase: 0 article(s), 3 wallpaper(s), 0 app(s), no active announcement',
    '  built /wallpapers/  (1 wallpaper(s))'
  ].join('\n'));
  assert.ok(buildLogProblems(log).some((p) => /fetched 3 wallpaper\(s\)/.test(p)));
});

test('fewer app pages than fetched apps is fine (bespoke + layout-less apps are skipped)', () => {
  const log = parseBuildLog([
    'supabase: 0 article(s), 0 wallpaper(s), 5 app(s), no active announcement',
    '  built /wallpapers/  (0 wallpaper(s))'
  ].join('\n'));
  assert.deepStrictEqual(buildLogProblems(log), []);
});

test('expectationsFrom speaks verifyBuild\'s expected shape', () => {
  assert.deepStrictEqual(expectationsFrom(parseBuildLog(GOOD_LOG)), {
    articles: [
      { slug: 'alpha', title: 'Alpha Title' },
      { slug: 'beta', title: 'Beta' }
    ],
    wallpapers: [],
    appPages: [{ slug: 'zeta', name: 'Zeta' }]
  });
});

test('passed() reads the explicit verdicts', () => {
  assert.strictEqual(passed({ ok: true }), true);
  assert.strictEqual(passed({ ok: false }), false);
  assert.strictEqual(passed({ passed: true }), true);
  assert.strictEqual(passed({ problems: [] }), true);
  assert.strictEqual(passed({ problems: ['broken'] }), false);
  assert.strictEqual(passed({ errors: [] }), true);
});

test('passed() fails closed on results it cannot read', () => {
  assert.strictEqual(passed(null), false);
  assert.strictEqual(passed(undefined), false);
  assert.strictEqual(passed('ok'), false);
  assert.strictEqual(passed({}), false);
  assert.strictEqual(passed({ status: 'green' }), false);
});
