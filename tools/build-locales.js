/* Static locale pages - a crawlable twin of a page in another language.

   The site's language switcher is client-side: English HTML plus a dictionary
   applied at runtime. Search engines only ever see the English, so nothing
   could rank for a Dutch query. This build takes an English page, applies the
   same dictionary the switcher would, and writes the result as its own URL
   (/nl/websites/), with lang, canonical, og:locale and a full hreflang set, so
   both versions are indexable and point at each other.

   The dictionary stays the single source of truth: translate a string once in
   i18n/<code>.js and both the live switcher and this static page pick it up.
   app.js recognises the generated page by data-i18n-static on <html> and does
   not translate it again; its picker navigates between the hreflang siblings.

   Usage:  node tools/build-locales.js          (writes every page in PAGES)
           node tools/build-locales.js --check  (build in memory, report misses, exit 1 on any) */
'use strict';

var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');
var { loadDict } = require('./lib/i18n-dict');
var { applyDict } = require('./lib/i18n-apply');

var ROOT = path.join(__dirname, '..');
var SITE = 'https://www.veyago.cloud';

/* Which pages get a static twin, and in which languages. Add a locale here
   once its dictionary covers the page (run with --check to see the gaps). */
var PAGES = [
  { src: 'websites/index.html', path: '/websites/', locales: ['nl', 'de'] },
  { src: 'services/index.html', path: '/services/', locales: ['nl', 'de'] },
  { src: 'index.html', path: '/', locales: ['nl', 'de'] },
  { src: 'company/index.html', path: '/company/', locales: ['nl', 'de'] },
  { src: 'team/index.html', path: '/team/', locales: ['nl', 'de'] },
  { src: 'approach/index.html', path: '/approach/', locales: ['nl', 'de'] }
];

/* Which paths have a twin in a given locale - so a twin's internal links can
   point at sibling twins instead of dropping the visitor back into English. */
function twinPaths(locale) {
  return PAGES.filter(function (p) { return p.locales.indexOf(locale) !== -1; }).map(function (p) { return p.path; });
}

var EUR_FIRST = { nl: true, de: true };

var OG_LOCALE = { en: 'en_US', nl: 'nl_NL', de: 'de_DE', fr: 'fr_FR', es: 'es_ES' };

function localeUrl(pagePath, code) {
  return SITE + (code === 'en' ? '' : '/' + code) + pagePath;
}

function setLink(doc, selector, attrs) {
  var el = doc.querySelector(selector);
  if (!el) { el = doc.createElement('link'); doc.head.appendChild(el); }
  Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}

/* The hreflang cluster is identical on every member: each lists all of them,
   itself included, plus x-default pointing at English. */
function hreflangCluster(doc, pagePath, locales) {
  doc.querySelectorAll('link[rel="alternate"][hreflang]').forEach(function (el) { el.remove(); });
  var all = ['en'].concat(locales);
  var canonical = doc.querySelector('link[rel="canonical"]');
  all.forEach(function (code) {
    var el = doc.createElement('link');
    el.setAttribute('rel', 'alternate');
    el.setAttribute('hreflang', code);
    el.setAttribute('href', localeUrl(pagePath, code));
    canonical.parentNode.insertBefore(el, canonical.nextSibling);
  });
  var def = doc.createElement('link');
  def.setAttribute('rel', 'alternate');
  def.setAttribute('hreflang', 'x-default');
  def.setAttribute('href', localeUrl(pagePath, 'en'));
  canonical.parentNode.insertBefore(def, canonical.nextSibling);
}

/* Pure: English HTML in, localised HTML + stats out. */
function buildLocalePage(html, dict, opts) {
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var url = localeUrl(opts.path, opts.locale);
  var stats = applyDict(doc, dict, opts.path, { pageUrl: localeUrl(opts.path, 'en'), localeUrl: url });
  var twins = twinPaths(opts.locale);
  /* Internal links stay inside the twin cluster where a twin exists. */
  doc.querySelectorAll('a[href^="/"]').forEach(function (a) {
    var href = a.getAttribute('href');
    var m = /^(\/[^#?]*)(.*)$/.exec(href);
    if (!m || a.hasAttribute('hreflang')) return;
    var pathOnly = m[1].replace(/index\.html$/, '');
    if (!/\/$/.test(pathOnly)) pathOnly += '/';
    if (twins.indexOf(pathOnly) !== -1) a.setAttribute('href', '/' + opts.locale + pathOnly + m[2]);
  });
  /* The crawlable language row marks the language it is now in. */
  doc.querySelectorAll('.lang-row a').forEach(function (a) {
    if (a.getAttribute('hreflang') === opts.locale) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  /* A share card of its own, when one exists for this page and locale. */
  var assetExists = opts.assetExists || function (p) { return fs.existsSync(path.join(ROOT, p)); };
  var ogImg = doc.querySelector('meta[property="og:image"]');
  if (ogImg) {
    var base = (ogImg.getAttribute('content') || '').replace(/^https?:\/\/[^\/]+/, '');
    var localised = base.replace(/\.png$/, '-' + opts.locale + '.png');
    if (base !== localised && assetExists(localised)) {
      ogImg.setAttribute('content', SITE + localised);
      var tw = doc.querySelector('meta[name="twitter:image"]');
      if (tw) tw.setAttribute('content', SITE + localised);
    }
  }
  /* Euro markets read the euro price first; the dollar becomes the alt line,
     both in the locale's own number format. */
  if (EUR_FIRST[opts.locale]) {
    doc.querySelectorAll('.tier').forEach(function (tier) {
      var price = tier.querySelector('.tier-price');
      var alt = tier.querySelector('.tier-alt');
      if (!price || !alt) return;
      var usd = /\$[\d,]+/.exec(price.innerHTML); var eur = /(?:€\s?\d[\d.,]*|\d[\d.,]*\s?€)/.exec(alt.textContent);
      if (!usd || !eur) return;
      var eurNum = eur[0].replace(/[€\s]/g, '').replace(',', '.');
      var usdNum = usd[0].replace('$', '').replace(',', '.');
      price.innerHTML = price.innerHTML.replace(usd[0], opts.locale === 'de' ? eurNum + ' €' : '€ ' + eurNum);
      alt.textContent = alt.textContent.replace(eur[0], '$ ' + usdNum);
    });
  }
  doc.documentElement.setAttribute('lang', opts.locale);
  doc.documentElement.setAttribute('data-i18n-static', opts.locale);
  setLink(doc, 'link[rel="canonical"]', { rel: 'canonical', href: url });
  var ogUrl = doc.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', url);
  var ogLocale = doc.querySelector('meta[property="og:locale"]');
  if (ogLocale) ogLocale.setAttribute('content', OG_LOCALE[opts.locale] || opts.locale);
  hreflangCluster(doc, opts.path, opts.locales);

  var banner = '<!-- Generated by tools/build-locales.js from ' + opts.src + ' + i18n/' + opts.locale + '.js.\n' +
               '     Do not edit: change the English page or the dictionary and run `npm run build:locales`. -->\n';
  var out = dom.serialize().replace(/^<!DOCTYPE html>\s*/i, '<!DOCTYPE html>\n' + banner);
  return { html: out, stats: stats, url: url };
}

function build(opts) {
  opts = opts || {};
  var failures = 0;
  PAGES.forEach(function (page) {
    var srcFile = path.join(ROOT, page.src);
    var html = fs.readFileSync(srcFile, 'utf8');
    if (!opts.check) {
      var withCluster = ensureSourceCluster(html, page);
      if (withCluster !== html) { fs.writeFileSync(srcFile, withCluster); html = withCluster; console.log('  hreflang cluster written into ' + page.src); }
    }
    page.locales.forEach(function (code) {
      var dict = loadDict(code, ROOT);
      var result = buildLocalePage(html, dict, {
        src: page.src, path: page.path, locale: code, locales: page.locales,
        assetExists: function (p) { return fs.existsSync(path.join(ROOT, p)); }
      });
      var missed = result.stats.missed.filter(function (m, i, a) { return a.indexOf(m) === i; });
      var line = '  ' + code + ' ' + page.path + ': ' + result.stats.translated + ' strings, ' +
                 result.stats.attrs + ' attrs, meta ' + (result.stats.meta ? 'yes' : 'NO') +
                 ', ' + missed.length + ' untranslated';
      console.log(line);
      missed.slice(0, opts.verbose ? missed.length : 8).forEach(function (m) { console.log('      - ' + m.slice(0, 90)); });
      if (missed.length > 8 && !opts.verbose) console.log('      ... (' + (missed.length - 8) + ' more; --verbose lists all)');
      if (missed.length) failures++;
      if (!opts.check) {
        var outFile = path.join(ROOT, code, page.path, 'index.html');
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, result.html);
        console.log('    -> ' + path.relative(ROOT, outFile));
      }
    });
  });
  return failures;
}

/* Keep the English source's hreflang cluster in step with PAGES. Idempotent:
   replaces the block of rel=alternate links that follows the canonical. */
function ensureSourceCluster(html, page) {
  var links = ['en'].concat(page.locales).map(function (code) {
    return '  <link rel="alternate" hreflang="' + code + '" href="' + localeUrl(page.path, code) + '" />';
  }).concat(['  <link rel="alternate" hreflang="x-default" href="' + localeUrl(page.path, 'en') + '" />']).join('\n');
  var stripped = html.replace(/(\n  <link rel="alternate" hreflang="[^"]+" href="[^"]+" \/>)+/g, '');
  return stripped.replace(/(  <link rel="canonical" href="[^"]+" \/>)/, '$1\n' + links);
}

module.exports = { buildLocalePage, PAGES, localeUrl, twinPaths, ensureSourceCluster };

if (require.main === module) {
  var args = process.argv.slice(2);
  var failures = build({ check: args.indexOf('--check') !== -1, verbose: args.indexOf('--verbose') !== -1 });
  if (args.indexOf('--check') !== -1 && failures) process.exit(1);
}
