#!/usr/bin/env node
/* version-assets.js — stamp styles.css and app.js with a content hash.
 *
 *   node tools/version-assets.js            # rewrite every page's links
 *   node tools/version-assets.js --check    # report drift, exit 1 (the gate)
 *
 * WHY THIS EXISTS. vercel.json caches these two files for a day and serves
 * them stale for a week:
 *
 *     Cache-Control: public, max-age=86400, stale-while-revalidate=604800
 *
 * HTML is not cached that long. So a commit that changes markup AND stylesheet
 * together — which is most of them — ships new HTML to a browser still holding
 * last week's CSS. On 2026-09-13 that put a 462px `</>` glyph through the
 * middle of the homepage for every returning visitor: the new markup used
 * .cap-ic, the cached stylesheet had never heard of it, and the only rule left
 * matching a bare SVG was `img, svg { max-width: 100% }`.
 *
 * A content hash in the query string makes the URL change whenever the file
 * does, so a stale copy can never be paired with fresh HTML. Anyone who has
 * never visited sees it correctly either way — which is exactly why this class
 * of bug survives review and reaches production.
 *
 * The hash is of the file's bytes, so `--check` also catches the other half of
 * the mistake: editing the CSS and forgetting to re-stamp.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var assets = require('./lib/asset-version');

var ROOT = path.resolve(__dirname, '..');
var ASSETS = ['styles.css', 'app.js'];
/* Generated trees are rewritten by their own builders; stamping them here
   would be undone on the next build and show up as drift in `npm run check`. */
var SKIP_DIRS = ['admin', 'node_modules', 'supabase', 'tools', 'data', 'i18n', 'docs', '.git',
                 /* Written by their own builders, which use the same helper. */
                 'nl', 'de', 'projects', 'journal', 'wallpapers'];

function htmlFiles(dir, found) {
  found = found || [];
  fs.readdirSync(path.join(ROOT, dir || '.'), { withFileTypes: true }).forEach(function (entry) {
    var rel = dir ? dir + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.charAt(0) === '.' || SKIP_DIRS.indexOf(entry.name) !== -1) return;
      htmlFiles(rel, found);
    } else if (/\.html$/.test(entry.name)) {
      found.push(rel);
    }
  });
  return found;
}

/* Matches the link with or without an existing ?v=, so re-stamping is
   idempotent and a hand-edited page is repaired rather than doubled. */
function pattern(asset) {
  return new RegExp('(["\'])/' + asset.replace('.', '\\.') + '(\\?v=[A-Za-z0-9]+)?\\1', 'g');
}

function main() {
  var check = process.argv.indexOf('--check') !== -1;
  var hashes = {};
  ASSETS.forEach(function (a) { hashes[a] = assets.assetVersion(a); });

  var files = htmlFiles('');
  var changed = [];
  var stale = [];

  files.forEach(function (file) {
    var full = path.join(ROOT, file);
    var before = fs.readFileSync(full, 'utf8');
    var after = before;

    ASSETS.forEach(function (asset) {
      after = after.replace(pattern(asset), function (match, quote) {
        return quote + '/' + asset + '?v=' + hashes[asset] + quote;
      });
    });

    if (after !== before) {
      if (check) stale.push(file);
      else { fs.writeFileSync(full, after); changed.push(file); }
    }
  });

  if (check) {
    if (stale.length) {
      console.log('FAIL  asset versions are stale on ' + stale.length + ' page(s)');
      stale.slice(0, 8).forEach(function (f) { console.log('        ' + f); });
      if (stale.length > 8) console.log('        …and ' + (stale.length - 8) + ' more');
      console.log('      Run: node tools/version-assets.js   (then rebuild the locale twins)');
      process.exit(1);
    }
    console.log('PASS  asset versions match the files  (' +
      ASSETS.map(function (a) { return a + '@' + hashes[a]; }).join(', ') + ')');
    return;
  }

  console.log('Stamped ' + changed.length + ' of ' + files.length + ' pages:');
  ASSETS.forEach(function (a) { console.log('  /' + a + '?v=' + hashes[a]); });
  if (changed.length) console.log('\nNow rebuild the locale twins:  npm run build:locales');
}

main();
