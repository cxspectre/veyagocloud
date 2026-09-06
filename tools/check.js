#!/usr/bin/env node
/* check.js — the pre-merge gate: `npm run check`.
 *
 * Runs, in order, and reports each:
 *   1. external requests  no public page, stylesheet or script asks the browser
 *                         to fetch from a host the public CSP in vercel.json does
 *                         not allow (tools/lib/external-requests.js). The
 *                         allowlist is read from that CSP, so adding a third-party
 *                         host is one deliberate change there.
 *   2. locale coverage    `node tools/build-locales.js --check`: every string on a
 *                         page with a static twin has a translation.
 *   3. generated files    the committed essays (/projects/<slug>/) and locale twins
 *                         (/nl/, /de/) are byte-identical to what their builders
 *                         produce from the current sources — built in memory here,
 *                         nothing is written.
 *   4. generated tree     `node tools/verify-cli.js --root .`: the Supabase export
 *                         on disk (journal, wallpapers, apps, sitemap) is sound.
 *                         Its tree-only mode needs no network and no secrets.
 *
 * Exit 0 when everything passes, 1 otherwise, with a summary at the end. A check
 * that throws counts as a failure: an unusable gate never waves a change through.
 * Dependency-free beyond node built-ins and the jsdom already in devDependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { spawnSync } = require('child_process');
var requests = require('./lib/external-requests');

var ROOT = path.resolve(__dirname, '..');

/* The `source` of the header block in vercel.json that covers the public site. */
var PUBLIC_CSP_SOURCE = '/((?!admin).*)';

/* Top-level directories that are not public pages. Dot-directories are skipped too. */
var EXCLUDED_DIRS = ['admin', 'node_modules'];

/* Shipped stylesheets and scripts outside the pages themselves. */
var STYLESHEETS = ['styles.css'];
var STYLESHEET_DIRS = ['assets/css'];
var SCRIPTS = ['app.js'];
var SCRIPT_DIRS = ['assets/js', 'i18n'];
var TEST_FILE = /\.test\.js$/;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function listDir(rel) {
  try {
    return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true });
  } catch (err) {
    return [];
  }
}

function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

function isPublicDir(entry) {
  return entry.isDirectory() && entry.name.charAt(0) !== '.' && EXCLUDED_DIRS.indexOf(entry.name) === -1;
}

/* Every public page: root *.html, <dir>/index.html and <dir>/<sub>/index.html. */
function publicPages() {
  var root = listDir('.');
  var rootPages = root
    .filter(function (e) { return e.isFile() && /\.html$/.test(e.name); })
    .map(function (e) { return e.name; });
  var nested = root.filter(isPublicDir).reduce(function (acc, dir) {
    var own = [dir.name + '/index.html'].filter(exists);
    var sub = listDir(dir.name).filter(isPublicDir)
      .map(function (e) { return dir.name + '/' + e.name + '/index.html'; })
      .filter(exists);
    return acc.concat(own, sub);
  }, []);
  return rootPages.concat(nested).sort();
}

function filesIn(dir, keep) {
  return listDir(dir)
    .filter(function (e) { return e.isFile() && keep(e.name); })
    .map(function (e) { return dir + '/' + e.name; });
}

/* Shipped CSS and JS (tests excluded). */
function publicAssets() {
  var css = STYLESHEETS.filter(exists).concat(STYLESHEET_DIRS.reduce(function (acc, dir) {
    return acc.concat(filesIn(dir, function (name) { return /\.css$/.test(name); }));
  }, []));
  var js = SCRIPTS.filter(exists).concat(SCRIPT_DIRS.reduce(function (acc, dir) {
    return acc.concat(filesIn(dir, function (name) { return /\.js$/.test(name) && !TEST_FILE.test(name); }));
  }, []));
  return css.concat(js).sort();
}

/* The public site's Content-Security-Policy value from vercel.json. */
function publicCsp() {
  var vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  var block = (vercel.headers || []).filter(function (h) { return h.source === PUBLIC_CSP_SOURCE; })[0];
  var header = ((block && block.headers) || []).filter(function (h) { return /^content-security-policy$/i.test(h.key); })[0];
  if (!header || !header.value) {
    throw new Error('vercel.json has no Content-Security-Policy for source "' + PUBLIC_CSP_SOURCE + '"');
  }
  return header.value;
}

// ---------------------------------------------------------------------------
// Check 1: external requests
// ---------------------------------------------------------------------------
function pageUrlFor(file) {
  return requests.DEFAULT_PAGE_URL + file.replace(/(^|\/)index\.html$/, '$1');
}

function checkExternalRequests() {
  var allowed = requests.hostsFromCsp(publicCsp());
  var files = publicPages().concat(publicAssets());
  var violations = files.reduce(function (acc, file) {
    var text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    var found = requests.scanSource(file, text, { allowedHosts: allowed, pageUrl: pageUrlFor(file) });
    return acc.concat(found.map(function (v) { return requests.formatViolation(file, v); }));
  }, []);
  var summary = 'scanned ' + files.length + ' file(s); hosts the public CSP allows: ' + (allowed.join(', ') || '(none)');
  var advice = [
    '',
    'The public site makes no third-party requests. If one is genuinely needed, decide it in',
    'docs/security-headers.md and add the host to the public CSP in vercel.json first.'
  ];
  return { ok: violations.length === 0, lines: [summary].concat(violations.length ? violations.concat(advice) : []) };
}

// ---------------------------------------------------------------------------
// Check 2 and 4: existing CLIs, spawned so their own exit codes decide
// ---------------------------------------------------------------------------
function runNode(args) {
  var r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  var output = ((r.stdout || '') + (r.stderr || '')).replace(/\s+$/, '');
  var lines = output ? output.split('\n') : [];
  if (r.error) return { ok: false, lines: lines.concat(['could not run: ' + r.error.message]) };
  return { ok: r.status === 0, lines: lines };
}

function checkLocaleCoverage() {
  var r = runNode(['tools/build-locales.js', '--check']);
  var advice = ['', 'Add the missing strings to i18n/<code>.js, then run `npm run build:locales`.'];
  return { ok: r.ok, lines: r.ok ? r.lines : r.lines.concat(advice) };
}

function checkGeneratedTree() {
  return runNode(['tools/verify-cli.js', '--root', ROOT]);
}

// ---------------------------------------------------------------------------
// Check 3: generated files are fresh
// ---------------------------------------------------------------------------
function firstDifference(a, b) {
  var la = String(a).split('\n');
  var lb = String(b).split('\n');
  var n = Math.max(la.length, lb.length);
  for (var i = 0; i < n; i++) if (la[i] !== lb[i]) return i + 1;
  return null;
}

function compareGenerated(expected) {
  var abs = path.join(ROOT, expected.file);
  var actual = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (actual === expected.html) return { ok: true, line: 'fresh  ' + expected.file };
  var why = actual === null
    ? 'missing'
    : 'stale (first difference at line ' + firstDifference(actual, expected.html) + ')';
  return { ok: false, line: 'STALE  ' + expected.file + ' — ' + why + '; regenerate with `' + expected.regenerate + '`' };
}

function expectedEssays() {
  return require('./build-essays').renderEssays().map(function (p) {
    return { file: p.file, html: p.html, regenerate: 'npm run build:essays' };
  });
}

function expectedTwins() {
  var { buildLocalePage, PAGES } = require('./build-locales');
  var { loadDict } = require('./lib/i18n-dict');
  return PAGES.reduce(function (acc, page) {
    var html = fs.readFileSync(path.join(ROOT, page.src), 'utf8');
    return acc.concat(page.locales.map(function (code) {
      var built = buildLocalePage(html, loadDict(code, ROOT), { src: page.src, path: page.path, locale: code, locales: page.locales });
      return { file: path.posix.join(code, page.path, 'index.html'), html: built.html, regenerate: 'npm run build:locales' };
    }));
  }, []);
}

function checkGeneratedFresh() {
  var results = expectedEssays().concat(expectedTwins()).map(compareGenerated);
  return {
    ok: results.every(function (r) { return r.ok; }),
    lines: results.map(function (r) { return r.line; })
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
var CHECKS = [
  { name: 'external requests — public pages, styles and scripts', run: checkExternalRequests },
  { name: 'locale coverage — tools/build-locales.js --check', run: checkLocaleCoverage },
  { name: 'generated files are fresh — essays and locale twins', run: checkGeneratedFresh },
  { name: 'generated tree is sound — tools/verify-cli.js', run: checkGeneratedTree }
];

function runCheck(check) {
  try {
    return Object.assign({ name: check.name }, check.run());
  } catch (err) {
    return { name: check.name, ok: false, lines: ['crashed: ' + (err && err.stack ? err.stack : err)] };
  }
}

function report(result) {
  console.log((result.ok ? 'PASS' : 'FAIL') + '  ' + result.name);
  result.lines.forEach(function (line) { console.log('      ' + line); });
  console.log('');
}

function main() {
  var results = CHECKS.map(function (check) {
    var result = runCheck(check);
    report(result);
    return result;
  });
  var failed = results.filter(function (r) { return !r.ok; });
  var summary = 'check: ' + (results.length - failed.length) + ' of ' + results.length + ' passed';
  console.log(failed.length ? summary + ' — FAILED: ' + failed.map(function (r) { return r.name; }).join('; ') : summary + '.');
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { publicPages, publicAssets, publicCsp, firstDifference, CHECKS };
