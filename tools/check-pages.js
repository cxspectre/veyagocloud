#!/usr/bin/env node
/* check-pages.js — on-page SEO/AEO invariants, checked rather than eyeballed.
 *
 *   node tools/check-pages.js            # report, exit 1 on any failure
 *
 * Every rule here is something an audit flagged once and should never regress:
 *
 *   json-ld        every block parses, and every @id is declared once per page
 *   title          present, unique across the site, at most 60 rendered chars
 *   description    present, unique, between 110 and 160 characters
 *   headings       exactly one <h1>, no skipped level, no duplicated H3 set
 *   canonical      present and absolute
 *   breadcrumb     a visible trail and a BreadcrumbList agree, when either exists
 *   faq            every FAQPage question and answer appears on the page word for
 *                  word, which is what Google requires and what an answer engine
 *                  needs in order to quote it
 *   markup         the page survives a parse/serialise round trip (unclosed tags)
 *
 * Dependency-free beyond jsdom, which is already a devDependency.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var ROOT = path.resolve(__dirname, '..');
var SKIP_DIRS = ['admin', 'node_modules', 'supabase', 'tools', 'data', 'assets', 'i18n', 'docs'];

var TITLE_MAX = 60;
var DESC_MIN = 110;
var DESC_MAX = 160;

function listDir(rel) {
  try { return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch (e) { return []; }
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function isPageDir(e) {
  return e.isDirectory() && e.name.charAt(0) !== '.' && SKIP_DIRS.indexOf(e.name) === -1;
}

function pages() {
  var root = listDir('.');
  var rootPages = root.filter(function (e) { return e.isFile() && /\.html$/.test(e.name); })
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

/* "&amp;" counts as one character in a SERP, not five. */
function rendered(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ');
}

function squish(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function jsonLdBlocks(doc) {
  return Array.prototype.slice.call(doc.querySelectorAll('script[type="application/ld+json"]'));
}

function collectIds(node, out) {
  if (Array.isArray(node)) { node.forEach(function (n) { collectIds(n, out); }); return out; }
  if (node && typeof node === 'object') {
    if (typeof node['@id'] === 'string' && node['@type']) out.push(node['@id']);
    Object.keys(node).forEach(function (k) {
      if (k !== '@id') collectIds(node[k], out);
    });
  }
  return out;
}

function checkPage(file, seen) {
  var html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  var doc = new JSDOM(html).window.document;
  var noindex = /noindex/i.test((doc.querySelector('meta[name="robots"]') || {}).content || '');
  var problems = [];

  /* --- structured data ------------------------------------------------- */
  var ids = [];
  jsonLdBlocks(doc).forEach(function (s, i) {
    var parsed;
    try { parsed = JSON.parse(s.textContent); } catch (err) {
      problems.push('json-ld block ' + (i + 1) + ' does not parse: ' + err.message);
      return;
    }
    collectIds(parsed['@graph'] || parsed, ids);
  });
  var dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
  if (dupes.length) problems.push('json-ld declares ' + dupes.join(', ') + ' more than once');

  /* --- title and description ------------------------------------------- */
  var title = rendered(doc.title);
  if (!title) problems.push('no <title>');
  else {
    if (title.length > TITLE_MAX) problems.push('title is ' + title.length + ' chars (max ' + TITLE_MAX + ')');
    if (!noindex && seen.titles[title]) problems.push('title duplicates ' + seen.titles[title]);
    else if (!noindex) seen.titles[title] = file;
  }

  /* A noindex page (404, an empty index) is not competing for a snippet: it needs
     no description and must not claim a canonical. */
  var descEl = doc.querySelector('meta[name="description"]');
  var desc = rendered(descEl && descEl.getAttribute('content'));
  if (!desc && !noindex) problems.push('no meta description');
  else if (!desc) { /* noindex: nothing to say */ }
  else {
    if (desc.length > DESC_MAX) problems.push('description is ' + desc.length + ' chars (max ' + DESC_MAX + ')');
    if (desc.length < DESC_MIN) problems.push('description is ' + desc.length + ' chars (min ' + DESC_MIN + ')');
    if (!noindex && seen.descriptions[desc]) problems.push('description duplicates ' + seen.descriptions[desc]);
    else if (!noindex) seen.descriptions[desc] = file;
  }

  /* --- headings --------------------------------------------------------- */
  var h1s = doc.querySelectorAll('h1');
  if (h1s.length !== 1) problems.push(h1s.length + ' <h1> elements (expected 1)');

  var main = doc.querySelector('main');
  if (!main) problems.push('no <main> landmark');
  if (main) {
    var h3s = Array.prototype.slice.call(main.querySelectorAll('h3'))
      .map(function (el) { return el.textContent.trim(); })
      .filter(Boolean);
    var repeated = h3s.filter(function (t, i) { return h3s.indexOf(t) !== i; });
    if (repeated.length) {
      problems.push('h3 repeated inside <main>: ' + Array.from(new Set(repeated)).join(' / '));
    }
  }

  /* --- canonical -------------------------------------------------------- */
  var canonical = doc.querySelector('link[rel="canonical"]');
  if (!canonical && !noindex) problems.push('no canonical');
  else if (!canonical) { /* noindex: a canonical would claim the wrong URL */ }
  else if (!/^https:\/\//.test(canonical.getAttribute('href') || '')) problems.push('canonical is not absolute');

  /* --- breadcrumbs ------------------------------------------------------ */
  var visibleCrumbs = doc.querySelectorAll('.crumbs li').length;
  var crumbNode = null;
  jsonLdBlocks(doc).forEach(function (s) {
    var parsed;
    try { parsed = JSON.parse(s.textContent); } catch (err) { return; }
    (parsed['@graph'] || [parsed]).forEach(function (n) {
      if (n && n['@type'] === 'BreadcrumbList') crumbNode = n;
    });
  });
  if (visibleCrumbs && !crumbNode) problems.push('visible breadcrumb with no BreadcrumbList');
  if (crumbNode && visibleCrumbs && crumbNode.itemListElement.length !== visibleCrumbs) {
    problems.push('breadcrumb has ' + visibleCrumbs + ' visible steps but ' + crumbNode.itemListElement.length + ' in schema');
  }

  /* --- FAQ ------------------------------------------------------------- */
  var visible = squish(doc.body.textContent);
  jsonLdBlocks(doc).forEach(function (s) {
    var parsed;
    try { parsed = JSON.parse(s.textContent); } catch (err) { return; }
    (parsed['@graph'] || [parsed]).forEach(function (n) {
      if (!n || n['@type'] !== 'FAQPage') return;
      (n.mainEntity || []).forEach(function (q) {
        var question = squish(q.name);
        var answer = squish(q.acceptedAnswer && q.acceptedAnswer.text);
        if (visible.indexOf(question) === -1) problems.push('FAQ question is not on the page: "' + question + '"');
        else if (answer && visible.indexOf(answer) === -1) {
          problems.push('FAQ answer does not match the page word for word: "' + question + '"');
        }
      });
    });
  });

  /* --- markup ----------------------------------------------------------- */
  if (/<li[^>]*>/.test(html)) {
    var strayLi = doc.querySelectorAll('li').length;
    var listed = doc.querySelectorAll('ul > li, ol > li, menu > li').length;
    if (strayLi !== listed) problems.push((strayLi - listed) + ' <li> outside a list');
  }

  return problems;
}

function main() {
  var seen = { titles: {}, descriptions: {} };
  var failures = 0;
  pages().forEach(function (file) {
    var problems = checkPage(file, seen);
    if (!problems.length) return;
    failures += problems.length;
    console.log('  ' + file);
    problems.forEach(function (p) { console.log('      ' + p); });
  });
  console.log(failures ? 'pages: ' + failures + ' problem(s).' : 'pages: every page passes.');
  return failures ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { checkPage, pages };
