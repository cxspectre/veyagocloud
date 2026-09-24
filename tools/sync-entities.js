#!/usr/bin/env node
/* sync-entities.js — write the canonical Organization and WebSite nodes into
 * every hand-authored page.
 *
 *   npm run sync:entities           # rewrite the pages
 *   npm run sync:entities -- --check  # report drift, write nothing, exit 1 if any
 *
 * The nodes live in tools/lib/entity.js. Every public page repeats them so a
 * crawler that lands anywhere gets the full company entity, but repetition is
 * how they drifted in the first place — three descriptions, telephone on one
 * page, contactType disagreeing page to page. This makes the repetition
 * mechanical: one definition, written out identically wherever it appears.
 *
 * Only nodes whose @id already matches are replaced. A page that does not
 * declare the Organization is left alone, and every other node in its @graph
 * (MobileApplication, Service, FAQPage, Person …) is preserved in place.
 *
 * The /nl/ and /de/ twins are skipped: tools/build-locales.js regenerates them
 * from the English source, so they inherit whatever this writes.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var entity = require('./lib/entity');

var ROOT = path.resolve(__dirname, '..');

/* Directories that are not hand-authored public pages: the admin app and the
   locale twins, which tools/build-locales.js regenerates from the English source
   and would overwrite anything written here.

   /journal/ and /projects/ are NOT skipped. Their sub-pages are generated, but
   those reference the Organization by @id rather than declaring it, so they are
   passed over on their own merits — while /projects/index.html, which is
   hand-authored, does declare it and needs syncing like any other page. */
var SKIP_DIRS = ['admin', 'node_modules', 'nl', 'de', 'supabase', 'tools', 'data', 'assets', 'i18n', 'docs'];

function listDir(rel) {
  try {
    return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true });
  } catch (err) {
    return [];
  }
}

function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

function isPageDir(entry) {
  return entry.isDirectory() && entry.name.charAt(0) !== '.' && SKIP_DIRS.indexOf(entry.name) === -1;
}

/* Root *.html plus <dir>/index.html and <dir>/<sub>/index.html. */
function pages() {
  var root = listDir('.');
  var rootPages = root
    .filter(function (e) { return e.isFile() && /\.html$/.test(e.name); })
    .map(function (e) { return e.name; });
  var nested = root.filter(isPageDir).reduce(function (acc, dir) {
    var own = [dir.name + '/index.html'].filter(exists);
    var sub = listDir(dir.name).filter(isPageDir)
      .map(function (e) { return dir.name + '/' + e.name + '/index.html'; })
      .filter(exists);
    return acc.concat(own, sub);
  }, []);
  return rootPages.concat(nested).sort();
}

/* The hand-authored blocks and the ones tools/lib/i18n-apply.js re-serialises
   use the same shape: two spaces of page indent, two per JSON level. Matching it
   keeps the diff to the values that actually changed. */
function serialise(data) {
  return '\n  ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ').replace(/<\//g, '<\\/') + '\n  ';
}

var CANONICAL = {};
CANONICAL[entity.ORG_ID] = entity.organization;
CANONICAL[entity.WEBSITE_ID] = entity.website;

/* Replace matching nodes in one @graph. Returns the ids that actually changed. */
function syncGraph(graph) {
  var changed = [];
  var next = graph.map(function (node) {
    var make = node && CANONICAL[node['@id']];
    if (!make) return node;
    var canonical = make();
    if (JSON.stringify(node) === JSON.stringify(canonical)) return node;
    changed.push(node['@id']);
    return canonical;
  });
  return { graph: next, changed: changed };
}

/* Every <script type="application/ld+json"> block in a page, with its offsets so
   the body can be spliced without a DOM parse (the pages are the source of
   truth for their own whitespace). */
var BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function syncPage(html) {
  var changed = [];
  var out = html.replace(BLOCK, function (whole, json) {
    var parsed;
    try {
      parsed = JSON.parse(json.replace(/<\\\//g, '</'));
    } catch (err) {
      return whole;
    }
    if (!parsed || !Array.isArray(parsed['@graph'])) return whole;
    var result = syncGraph(parsed['@graph']);
    if (!result.changed.length) return whole;
    changed = changed.concat(result.changed);
    parsed['@graph'] = result.graph;
    return '<script type="application/ld+json">' + serialise(parsed) + '</script>';
  });
  return { html: out, changed: changed };
}

function main(argv) {
  var check = argv.indexOf('--check') !== -1;
  var drifted = [];
  var touched = 0;

  pages().forEach(function (rel) {
    var file = path.join(ROOT, rel);
    var html = fs.readFileSync(file, 'utf8');
    var result = syncPage(html);
    if (!result.changed.length) return;
    drifted.push(rel + ' — ' + result.changed.join(', '));
    if (!check) {
      fs.writeFileSync(file, result.html);
      touched++;
    }
  });

  if (check) {
    if (drifted.length) {
      console.log('entities: ' + drifted.length + ' page(s) differ from tools/lib/entity.js');
      drifted.forEach(function (line) { console.log('      ' + line); });
      return 1;
    }
    console.log('entities: every page matches tools/lib/entity.js.');
    return 0;
  }

  drifted.forEach(function (line) { console.log('  sync  ' + line); });
  console.log('entities: ' + touched + ' page(s) rewritten.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { syncPage, syncGraph, serialise, pages };
