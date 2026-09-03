#!/usr/bin/env node
/* sitemap-lastmod.js — refresh <lastmod> on the hand-written sitemap entries.
 *
 *   npm run sitemap:lastmod                 # rewrite sitemap.xml in place
 *   node tools/sitemap-lastmod.js --dry-run # show what would change
 *   node tools/sitemap-lastmod.js --skip /,/services/,/websites/
 *
 * Each <url> outside the BUILD:generated block maps to a file in the repo
 * (https://www.veyago.cloud/apps/ → apps/index.html). Its <lastmod> becomes the
 * date of the last commit that touched that file — or today, when the working
 * tree has uncommitted changes to it, since that is what the next commit will
 * carry. Entries whose file cannot be found are left alone.
 *
 * The block between the BUILD:generated markers belongs to tools/build.js
 * (journal, wallpapers, generated app pages) and is never touched here.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { execFileSync } = require('child_process');

var { SITE } = require('./lib/chrome');
var { START, END } = require('./lib/sitemap');

var ROOT = path.resolve(__dirname, '..');
var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/* Sitemap <loc> → repo-relative file the page is served from, or null when the
   URL is not one of ours. Mirrors Vercel's cleanUrls: a trailing-slash URL is a
   directory index; a bare path is <path>.html. */
function locToFile(loc, site) {
  site = site || SITE;
  if (typeof loc !== 'string' || loc.indexOf(site) !== 0) return null;
  var p = loc.slice(site.length);
  if (p === '' || p === '/') return 'index.html';
  if (p.charAt(0) !== '/') return null;
  if (p.slice(-1) === '/') return p.slice(1) + 'index.html';
  return p.slice(1) + '.html';
}

/* Return a copy of `xml` with <lastmod> refreshed for every hand-written <url>.
   `dateFor(loc)` returns 'YYYY-MM-DD' or null (null = leave that entry as it is).
   `opts.skip` is a list of <loc> paths ("/", "/services/") to leave untouched. */
function updateLastmods(xml, dateFor, opts) {
  opts = opts || {};
  var skip = (opts.skip || []).map(function (p) { return SITE + p; });
  var s = xml.indexOf(START);
  var e = xml.indexOf(END);
  var hasBlock = s !== -1 && e !== -1 && e > s;
  var head = hasBlock ? xml.slice(0, s) : xml;
  var block = hasBlock ? xml.slice(s, e + END.length) : '';
  var tail = hasBlock ? xml.slice(e + END.length) : '';
  var changes = [];

  var entry = /(<url>\s*<loc>([^<]+)<\/loc>)(\s*<lastmod>([^<]*)<\/lastmod>)?/g;
  function rewrite(part) {
    return part.replace(entry, function (m, open, loc, lastmodTag, oldDate) {
      if (skip.indexOf(loc) !== -1) return m;
      var date = dateFor(loc);
      if (!date || !ISO_DAY.test(date)) return m;
      if (oldDate === date) return m;
      changes.push({ loc: loc, from: oldDate || null, to: date });
      return open + '<lastmod>' + date + '</lastmod>';
    });
  }
  return { xml: rewrite(head) + block + rewrite(tail), changes: changes };
}

// ---------------------------------------------------------------------------
// Git-backed date lookup
// ---------------------------------------------------------------------------
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd: cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (err) {
    return '';
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* Date for one file: today if it has uncommitted changes, else its last commit. */
function fileDate(file, root) {
  root = root || ROOT;
  if (!fs.existsSync(path.join(root, file))) return null;
  if (git(['status', '--porcelain', '--', file], root)) return today();
  var committed = git(['log', '-1', '--format=%cs', '--', file], root);
  return ISO_DAY.test(committed) ? committed : null;
}

function makeDateFor(root) {
  return function (loc) {
    var file = locToFile(loc);
    return file ? fileDate(file, root) : null;
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  var out = { dryRun: false, skip: [] };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--skip') out.skip = out.skip.concat((argv[++i] || '').split(',').filter(Boolean));
    else { process.stderr.write('sitemap-lastmod: unknown argument ' + argv[i] + '\n'); process.exit(2); }
  }
  return out;
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  var file = path.join(ROOT, 'sitemap.xml');
  var xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write('sitemap-lastmod: cannot read sitemap.xml (' + err.message + ')\n');
    process.exit(2);
  }
  var result = updateLastmods(xml, makeDateFor(ROOT), { skip: args.skip });
  result.changes.forEach(function (c) {
    console.log((args.dryRun ? 'would set ' : 'set ') + c.loc + '  ' + (c.from || '(none)') + ' → ' + c.to);
  });
  if (!result.changes.length) console.log('sitemap.xml already up to date');
  else if (!args.dryRun) fs.writeFileSync(file, result.xml);
}

if (require.main === module) main();

module.exports = { locToFile, updateLastmods, fileDate, makeDateFor, parseArgs };
