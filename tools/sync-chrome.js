#!/usr/bin/env node
/* sync-chrome.js - write the site header and the footer tagline into every
 * hand-authored page, from tools/lib/chrome.js.
 *
 *   npm run sync:chrome             # rewrite the pages
 *   npm run sync:chrome -- --check  # report drift, write nothing, exit 1 if any
 *
 * The header is on every page, and since the Private | Business switch it
 * comes in three versions: Private, Business, and shared (both menus, one shown
 * by the visitor's last side). Keeping 26 copies of that in step by hand is how
 * menus drift, so each page's side is decided once, in SIDE_OF below, and the
 * markup comes from the same header() the generated pages use.
 *
 * Per page it writes:
 *   - the header, scrim and mobile drawer (from <header id="site-nav"> to the
 *     drawer's </aside>)
 *   - data-side / data-page-side on <html>
 *   - assets/js/side.js in the <head> of shared pages, and only there
 *   - the footer's tagline, and the Audits link in the footer's Company column
 *
 * A page with its own quote form (id="quote") gets a header button that
 * scrolls to it and stays on screen at every width, as /websites/ always had.
 *
 * The /nl/ and /de/ twins are skipped: tools/build-locales.js regenerates them
 * from the English pages, so they inherit whatever this writes.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var chrome = require('./lib/chrome');
var assets = require('./lib/asset-version');

var ROOT = path.resolve(__dirname, '..');

var SKIP_DIRS = ['admin', 'node_modules', 'nl', 'de', 'supabase', 'tools', 'data', 'assets', 'i18n', 'docs'];

/* Which side each page is on, by its first path segment ('' is the home page).
   null means shared: the page carries both menus. A new page with the site
   header must be added here - the tool refuses to guess. */
var SIDE_OF = {
  '': 'private',
  apps: 'private',
  provisum: 'private',
  'provisum-privacy': 'private',
  veyago: 'private',
  projects: 'private',
  wallpapers: 'private',

  business: 'business',
  websites: 'business',
  audits: 'business',
  cockpit: 'business',
  services: 'business',

  /* Articles serve both sides - "What a $699 website includes" is read from
     /websites/ - so they keep whichever side the reader came from. */
  journal: null,
  company: null,
  team: null,
  approach: null,
  support: null,
  legal: null,
  terms: null,
  privacy: null
};

var SIDE_SCRIPT = 'assets/js/side.js';

function listDir(rel) {
  try {
    return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true });
  } catch (err) {
    return [];
  }
}

function isPageDir(entry) {
  return entry.isDirectory() && entry.name.charAt(0) !== '.' && SKIP_DIRS.indexOf(entry.name) === -1;
}

/* Every page that carries the site header: root *.html plus <dir>/index.html
   and <dir>/<sub>/index.html. */
function pages() {
  var root = listDir('.');
  var candidates = root
    .filter(function (e) { return e.isFile() && /\.html$/.test(e.name); })
    .map(function (e) { return e.name; });
  root.filter(isPageDir).forEach(function (dir) {
    candidates.push(dir.name + '/index.html');
    listDir(dir.name).filter(isPageDir).forEach(function (sub) {
      candidates.push(dir.name + '/' + sub.name + '/index.html');
    });
  });
  return candidates
    .filter(function (rel) { return fs.existsSync(path.join(ROOT, rel)); })
    .filter(function (rel) { return /id="site-nav"/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')); })
    .sort();
}

function sideOf(rel) {
  var first = rel === 'index.html' ? '' : rel.split('/')[0];
  if (!Object.prototype.hasOwnProperty.call(SIDE_OF, first)) {
    throw new Error(rel + ' has the site header but no side - add "' + first + '" to SIDE_OF in tools/sync-chrome.js');
  }
  return SIDE_OF[first];
}

/* The header, the scrim and the drawer, as one block - anchored on the drawer
   itself so a page's own <aside> can never be taken for it. */
var HEADER_RE = /<header class="nav" id="site-nav">[\s\S]*?<\/header>\s*(?:<!--[^>]*-->\s*)?<div class="nav-scrim" id="nav-scrim"><\/div>\s*<aside class="nav-drawer"[\s\S]*?<\/aside>/;
var HTML_RE = /<html\b([^>]*)>/;
var SIDE_SCRIPT_RE = /\n[ \t]*<script src="\/assets\/js\/side\.js(?:\?v=[A-Za-z0-9]+)?"><\/script>/g;
var STYLESHEET_RE = /(\n([ \t]*)<link rel="stylesheet" href="\/styles\.css(?:\?v=[A-Za-z0-9]+)?" \/>)/;
/* The copyright span (with the year inside it), then any number of plain
   tagline spans, then the closing div. Anything else is refused, not guessed. */
var FOOTER_BASE_RE = /(<div class="footer-base">\s*<span>[^<]*<span id="year">[^<]*<\/span>[^<]*<\/span>)((?:\s*<span[^>]*>[^<]*<\/span>)*)(\s*<\/div>)/;
var FOOTER_WEBSITES = '<a href="/websites/">Websites</a><a href="/services/">Services</a>';
var FOOTER_WITH_AUDITS = '<a href="/websites/">Websites</a><a href="/audits/">Audits</a><a href="/services/">Services</a>';

function syncHtmlTag(html, side) {
  return html.replace(HTML_RE, function (whole, attrs) {
    var kept = attrs.replace(/\s+data-(?:page-)?side="[^"]*"/g, '');
    return '<html' + kept + chrome.htmlSideAttrs(side) + '>';
  });
}

function syncSideScript(html, side) {
  var without = html.replace(SIDE_SCRIPT_RE, '');
  if (side !== null) return without;
  if (!STYLESHEET_RE.test(without)) throw new Error('no styles.css link to put side.js after');
  return without.replace(STYLESHEET_RE, function (whole, line, indent) {
    return line + '\n' + indent + '<script src="' + assets.versioned(SIDE_SCRIPT) + '"></script>';
  });
}

function syncFooter(html, side) {
  var out = html.split(FOOTER_WEBSITES).join(FOOTER_WITH_AUDITS);
  if (out.indexOf('class="footer-base"') === -1) return out;
  if (!FOOTER_BASE_RE.test(out)) throw new Error('a footer-base this tool does not recognise');
  return out.replace(FOOTER_BASE_RE, function (whole, first, middle, close) {
    var line = close.match(/\n([ \t]*)/);
    var lead = line ? '\n' + line[1] + '  ' : '';
    return first + lead + chrome.footerTagline(side) + close;
  });
}

/* The synced page, and which parts changed. */
function syncPage(rel, html) {
  var side = sideOf(rel);
  if (!HEADER_RE.test(html)) throw new Error(rel + ': no <header id="site-nav"> followed by the scrim and the nav-drawer');
  var quote = side === 'business' && /\bid="quote"/.test(html) ? '#quote' : null;

  var steps = [
    ['header', function (h) { return h.replace(HEADER_RE, function () { return chrome.header({ side: side, quote: quote }); }); }],
    ['html side', function (h) { return syncHtmlTag(h, side); }],
    ['side.js', function (h) { return syncSideScript(h, side); }],
    ['footer', function (h) {
      try { return syncFooter(h, side); } catch (err) { throw new Error(rel + ': ' + err.message); }
    }]
  ];
  var changed = [];
  var out = steps.reduce(function (acc, step) {
    var next = step[1](acc);
    if (next !== acc) changed.push(step[0]);
    return next;
  }, html);
  return { html: out, changed: changed };
}

function main() {
  var check = process.argv.indexOf('--check') !== -1;
  var drifted = [];
  pages().forEach(function (rel) {
    var file = path.join(ROOT, rel);
    var result = syncPage(rel, fs.readFileSync(file, 'utf8'));
    if (!result.changed.length) return;
    drifted.push(rel + ' - ' + result.changed.join(', '));
    if (!check) fs.writeFileSync(file, result.html);
  });
  if (check) {
    if (drifted.length) {
      console.error('Site chrome out of step with tools/lib/chrome.js:\n  ' + drifted.join('\n  ') +
        '\n\nRun `npm run sync:chrome` to rewrite them.');
      process.exit(1);
    }
    console.log('every page carries the header and footer from tools/lib/chrome.js');
    return;
  }
  console.log(drifted.length ? 'Rewrote:\n  ' + drifted.join('\n  ') : 'Nothing to change.');
}

if (require.main === module) main();

module.exports = { pages: pages, syncPage: syncPage, sideOf: sideOf, SIDE_OF: SIDE_OF };
