/* Apply a dictionary to a document - the same walk app.js does at runtime.

   Every rule here has a twin in app.js applyDict(): skip <script>/<style>/
   <noscript>/<textarea>, SVG subtrees, [data-i18n] and [data-i18n-skip]
   subtrees, the brand and the language picker; translate whole squished text
   nodes only; replace [data-i18n] innerHTML from the html map; translate alt,
   aria-label and title from attrs (falling back to strings); localise
   <title> and the meta description by page path. If the two ever drift, the
   static Dutch page and the live switcher would disagree, so change both. */
'use strict';

var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
var SHOW_TEXT = 4;
var FILTER_ACCEPT = 1;
var FILTER_REJECT = 2;

function squish(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/* Text that is never a translation miss: numbers, prices, punctuation. */
function isOpaque(s) { return /^[\W\d_]+$/.test(s); }

function acceptsNode(doc, node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return FILTER_REJECT;
  var el = node.parentNode;
  while (el && el.nodeType === 1 && el !== doc.body) {
    if (SKIP_TAGS[el.tagName]) return FILTER_REJECT;
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') !== -1) return FILTER_REJECT;
    if (el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-skip')) return FILTER_REJECT;
    if (el.classList && (el.classList.contains('brand') || el.classList.contains('lang'))) return FILTER_REJECT;
    el = el.parentNode;
  }
  return FILTER_ACCEPT;
}

/* Structured data is the one place the runtime walk never looks (scripts are
   skipped), but a FAQPage whose questions do not match the visible page loses
   its rich result, and a Service whose url/@id names the English page claims
   the wrong URL. So JSON-LD gets its string leaves translated through the same
   dictionary, and any value that names the English page is repointed. */
function localiseJsonLd(doc, strings, opts) {
  var count = 0;
  var from = opts && opts.pageUrl;
  var to = opts && opts.localeUrl;
  function walk(v) {
    if (typeof v === 'string') {
      if (from && to && (v === from || v.indexOf(from + '#') === 0)) return to + v.slice(from.length);
      var t = strings[squish(v)];
      if (t != null && t !== v) { count++; return t; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = walk(v[k]); });
      return out;
    }
    return v;
  }
  var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < scripts.length; i++) {
    var parsed;
    try { parsed = JSON.parse(scripts[i].textContent); } catch (e) { continue; }
    scripts[i].textContent = '\n  ' + JSON.stringify(walk(parsed), null, 2).replace(/\n/g, '\n  ') + '\n  ';
  }
  return count;
}

/* @param {Document} doc      a jsdom document
   @param {object}   dict     {strings, attrs, html, meta}
   @param {string}   pathKey  the page path used to look up meta, e.g. "/websites/"
   @param {object}   [opts]   {pageUrl, localeUrl}: the English page's absolute URL and
                              the twin's, so JSON-LD url/@id values move with the page
   @returns {{translated:number, missed:string[], attrs:number, html:number, meta:boolean, jsonld:number}} */
function applyDict(doc, dict, pathKey, opts) {
  var strings = dict.strings || {};
  var attrsMap = dict.attrs || {};
  var htmlMap = dict.html || {};
  var stats = { translated: 0, missed: [], attrs: 0, html: 0, meta: false, jsonld: 0 };

  var walker = doc.createTreeWalker(doc.body, SHOW_TEXT, {
    acceptNode: function (node) { return acceptsNode(doc, node); }
  });
  var nodes = [], n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(function (node) {
    var raw = node.nodeValue;
    var lead = (raw.match(/^\s*/) || [''])[0];
    var trail = (raw.match(/\s*$/) || [''])[0];
    var core = squish(raw);
    var t = strings[core];
    if (t != null && t !== core) { node.nodeValue = lead + t + trail; stats.translated++; }
    else if (t == null && !isOpaque(core)) stats.missed.push(core);
  });

  var richEls = doc.querySelectorAll('[data-i18n]');
  for (var i = 0; i < richEls.length; i++) {
    var key = richEls[i].getAttribute('data-i18n');
    if (htmlMap[key]) { richEls[i].innerHTML = htmlMap[key]; stats.html++; }
  }

  var attrEls = doc.querySelectorAll('[alt],[aria-label],[title]');
  for (var j = 0; j < attrEls.length; j++) {
    ['alt', 'aria-label', 'title'].forEach(function (a) {
      var el = attrEls[j];
      if (!el.hasAttribute(a) || el.hasAttribute('data-i18n-skip')) return;
      var v = squish(el.getAttribute(a) || '');
      if (!v) return;
      var t = (attrsMap[v] != null ? attrsMap[v] : strings[v]);
      if (t != null && t !== v) { el.setAttribute(a, t); stats.attrs++; }
    });
  }

  var m = dict.meta && dict.meta[pathKey];
  if (m) {
    if (m.title) {
      doc.title = m.title;
      setMeta(doc, 'meta[property="og:title"]', m.title);
      setMeta(doc, 'meta[name="twitter:title"]', m.title);
    }
    if (m.description) {
      setMeta(doc, 'meta[name="description"]', m.description);
      setMeta(doc, 'meta[property="og:description"]', m.description);
      setMeta(doc, 'meta[name="twitter:description"]', m.description);
    }
    stats.meta = true;
  }

  stats.jsonld = localiseJsonLd(doc, strings, opts);
  return stats;
}

function setMeta(doc, selector, value) {
  var el = doc.querySelector(selector);
  if (el) el.setAttribute('content', value);
}

module.exports = { applyDict, localiseJsonLd, squish, isOpaque };
