#!/usr/bin/env node
/* verify-cli.js — the gate between `npm run build` and `git commit`.
 *
 *   node tools/verify-cli.js [--root <dir>] [--build-log <file>]
 *                            [--expected <file.json>] [--report <file>]
 *
 * `npm run build` deletes /journal and regenerates it from whatever Supabase
 * returned. A partial read (RLS change, network blip, expired key) therefore
 * produces a *successful* build of an emptied site. Locally that is caught by
 * the person running it; in CI nobody is looking, so nothing may be committed
 * until this passes.
 *
 * Checks run in two layers:
 *   1. build-log consistency — everything that was fetched was also rendered
 *      (this file, cheap, catches a truncated or half-failed run)
 *   2. tools/lib/verify-build.js — the real inspection of the generated tree
 *
 * Exit codes:
 *   0  verified — safe to commit
 *   1  verification failed — the report says why; do NOT commit
 *   2  the verifier could not run (bad arguments, unreadable input, missing
 *      module). Also a refusal: an unusable gate never waves a build through.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT_DEFAULT = path.resolve(__dirname, '..');

var USAGE = [
  'usage: node tools/verify-cli.js [options]',
  '',
  '  --root <dir>        tree to verify (default: the repo root)',
  '  --build-log <file>  stdout of `npm run build`; expectations are derived from it',
  '  --expected <file>   JSON expectations, overrides anything from --build-log',
  '  --report <file>     also write the report here (for CI job summaries)',
  '  --before <file>     JSON page counts from the COMMITTED tree, taken before the',
  '                      build ran. Without it the build is only checked against',
  '                      itself, so a short read from Supabase that empties the site',
  '                      verifies clean. Strongly recommended in CI.',
  '  --help              show this message',
  ''
].join('\n');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function refuse(message) {
  process.stderr.write('verify: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  var out = { root: ROOT_DEFAULT, buildLog: null, expected: null, report: null };
  var takesValue = { '--root': 'root', '--build-log': 'buildLog', '--expected': 'expected', '--report': 'report', '--before': 'before' };
  for (var i = 0; i < argv.length; i++) {
    var flag = argv[i];
    if (flag === '--help' || flag === '-h') { process.stdout.write(USAGE); process.exit(0); }
    var key = takesValue[flag];
    if (!key) refuse('unknown argument "' + flag + '"\n\n' + USAGE);
    var value = argv[++i];
    if (value == null || value === '') refuse('missing value for ' + flag + '\n\n' + USAGE);
    out[key] = key === 'root' ? path.resolve(value) : value;
  }
  return out;
}

function readFile(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    refuse('could not read ' + what + ' "' + file + '": ' + err.message);
  }
}

function readJson(file) {
  var raw = readFile(file, 'expectations file');
  try {
    return JSON.parse(raw);
  } catch (err) {
    refuse('"' + file + '" is not valid JSON: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Build-log parsing
//
// tools/build.js prints a fixed set of lines. We read back what it *fetched*
// and what it *rendered*, which gives both the expectations handed to
// verifyBuild and a cheap self-consistency check.
//
//   supabase: 3 article(s), 2 wallpaper(s), 4 app(s), announcement active
//     built /journal/some-slug/  (Some Title)
//     built /journal/  (3 card(s))
//     built /wallpapers/  (2 wallpaper(s))
//     built /apps/some-app/  (Some App)
// ---------------------------------------------------------------------------
var RE_FETCHED = /^\s*(?:supabase|fixture):\s*(\d+) article\(s\), (\d+) wallpaper\(s\), (\d+) app\(s\)/;
var RE_ARTICLE_PAGE = /^\s*built \/journal\/([^/\s]+)\/\s+\((.*)\)\s*$/;
var RE_APP_PAGE = /^\s*built \/apps\/([^/\s]+)\/\s+\((.*)\)\s*$/;
var RE_WALLPAPER_INDEX = /^\s*built \/wallpapers\/\s+\((\d+) wallpaper/;

function parseBuildLog(text) {
  var out = { fetched: null, articles: [], appPages: [], wallpapers: null };
  text.split('\n').forEach(function (line) {
    var m = line.match(RE_FETCHED);
    if (m) { out.fetched = { articles: Number(m[1]), wallpapers: Number(m[2]), apps: Number(m[3]) }; return; }
    m = line.match(RE_ARTICLE_PAGE);
    if (m) { out.articles.push({ slug: m[1], title: m[2] }); return; }
    m = line.match(RE_APP_PAGE);
    if (m) { out.appPages.push({ slug: m[1], name: m[2] }); return; }
    m = line.match(RE_WALLPAPER_INDEX);
    if (m) { out.wallpapers = Number(m[1]); }
  });
  return out;
}

/* Problems visible from the log alone. Anything here means the build did not
   finish the way build.js is written to finish. */
function buildLogProblems(log) {
  var problems = [];
  if (!log.fetched) {
    problems.push('build log has no "N article(s), N wallpaper(s), N app(s)" line — the build never got past reading Supabase.');
    return problems;
  }
  if (log.wallpapers == null) {
    problems.push('build log has no "built /wallpapers/" line — the build stopped before it finished.');
  }
  if (log.articles.length !== log.fetched.articles) {
    problems.push('fetched ' + log.fetched.articles + ' article(s) but rendered ' +
      log.articles.length + ' article page(s) — the build did not render everything it read.');
  }
  if (log.wallpapers != null && log.wallpapers !== log.fetched.wallpapers) {
    problems.push('fetched ' + log.fetched.wallpapers + ' wallpaper(s) but the index lists ' +
      log.wallpapers + '.');
  }
  // App pages are legitimately fewer than fetched apps: bespoke slugs and apps
  // without a layout are skipped on purpose. More than fetched is impossible.
  if (log.appPages.length > log.fetched.apps) {
    problems.push('rendered ' + log.appPages.length + ' app page(s) from only ' +
      log.fetched.apps + ' fetched app(s).');
  }
  return problems;
}

/* What the generated tree should contain, in the shape verifyBuild expects:
   { articles: [{slug, title}], wallpapers: [{title}], appPages: [{slug, name}] }.
   The log gives wallpaper titles nowhere — only a count — so wallpapers is left
   empty and the count is checked by buildLogProblems() above instead. */
function expectationsFrom(log) {
  return {
    articles: log.articles,
    wallpapers: [],
    appPages: log.appPages
  };
}

// ---------------------------------------------------------------------------
// verify-build.js bridge
// ---------------------------------------------------------------------------
function loadVerifier() {
  try {
    return require('./lib/verify-build');
  } catch (err) {
    refuse('could not load tools/lib/verify-build.js: ' + err.message);
  }
}

/* Fail closed. A result we cannot read as an explicit pass is a failure — a
   gate that cannot tell must never let a build through to production. */
function passed(result) {
  if (!result || typeof result !== 'object') return false;
  if (typeof result.ok === 'boolean') return result.ok;
  if (typeof result.passed === 'boolean') return result.passed;
  if (Array.isArray(result.problems)) return result.problems.length === 0;
  if (Array.isArray(result.errors)) return result.errors.length === 0;
  return false;
}

/* verifyBuild already carries the rendered report; summarize(problems) is the
   fallback for a result that only came back with a problem list. */
function reportFor(summarize, result) {
  if (result && typeof result.report === 'string' && result.report.trim()) return result.report;
  try {
    var summary = summarize(result && result.problems);
    if (typeof summary === 'string' && summary.trim()) return summary;
    if (summary && typeof summary.report === 'string' && summary.report.trim()) return summary.report;
  } catch (err) {
    return 'summarize() threw: ' + err.message + '\n\n' + JSON.stringify(result, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  var args = parseArgs(process.argv.slice(2));
  var verifier = loadVerifier();
  if (typeof verifier.verifyBuild !== 'function') refuse('verify-build.js does not export verifyBuild()');
  if (typeof verifier.summarize !== 'function') refuse('verify-build.js does not export summarize()');

  var sections = [];
  var logProblems = [];
  var expected = null;

  if (args.buildLog) {
    var log = parseBuildLog(readFile(args.buildLog, 'build log'));
    logProblems = buildLogProblems(log);
    expected = expectationsFrom(log);
    if (log.fetched) {
      sections.push('Fetched from Supabase: ' + log.fetched.articles + ' article(s), ' +
        log.fetched.wallpapers + ' wallpaper(s), ' + log.fetched.apps + ' app(s).');
      sections.push('Rendered: ' + log.articles.length + ' article page(s), ' +
        (log.wallpapers == null ? '?' : log.wallpapers) + ' wallpaper(s), ' +
        log.appPages.length + ' app page(s).');
    }
    if (logProblems.length) {
      sections.push('Build-log problems:\n' + logProblems.map(function (p) { return '  - ' + p; }).join('\n'));
    }
  }

  if (args.expected) expected = readJson(args.expected);

  var result = await verifier.verifyBuild({ root: args.root, expected: expected });
  sections.push(reportFor(verifier.summarize, result));

  /* Compare against the committed tree. Everything above validates the build
     against the build's own log; only this can catch a build that succeeded at
     rendering nothing. */
  var shrinkProblems = [];
  if (args.before) {
    if (typeof verifier.checkNoCatastrophicShrink !== 'function') {
      refuse('verify-build.js does not export checkNoCatastrophicShrink()');
    }
    var before = readJson(args.before);
    var after = {
      articles: expected && expected.articles ? expected.articles.length : 0,
      appPages: expected && expected.appPages ? expected.appPages.length : 0
    };
    shrinkProblems = verifier.checkNoCatastrophicShrink(before, after, {
      maxDropRatio: process.env.ALLOW_LARGE_DELETION === '1' ? 1 : undefined
    });
    sections.push('Published now vs already live: ' +
      JSON.stringify(after) + ' vs ' + JSON.stringify(before) +
      (shrinkProblems.length ? '' : ' — no unexpected loss.'));
    if (shrinkProblems.length) {
      sections.push('REFUSING TO PUBLISH:\n' +
        shrinkProblems.map(function (p) { return '  - ' + p; }).join('\n'));
    }
  }

  var report = sections.join('\n\n');
  var ok = logProblems.length === 0 && shrinkProblems.length === 0 && passed(result);

  process.stdout.write(report.replace(/\s*$/, '') + '\n');
  if (args.report) {
    try {
      fs.writeFileSync(args.report, report.replace(/\s*$/, '') + '\n');
    } catch (err) {
      process.stderr.write('verify: could not write report to "' + args.report + '": ' + err.message + '\n');
    }
  }

  if (!ok) {
    process.stderr.write('\nverify: build FAILED verification — refusing to publish.\n');
    process.exit(1);
  }
  process.stdout.write('\nverify: build looks good.\n');
}

/* Only run when invoked directly, so the parsing helpers stay unit-testable. */
if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write('verify: crashed — ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(2);
  });
}

module.exports = { parseBuildLog, buildLogProblems, expectationsFrom, passed };
