/* External-request scan — every URL a page would make the browser fetch.

   The public site promises to make no third-party calls (docs/security-headers.md).
   The CSP in vercel.json enforces that at runtime by blocking the request; this
   module catches it at review time by reading the source. It looks at everything
   the browser fetches on its own — scripts, stylesheets, icons, preloads, images,
   media, frames, plugins, CSS url()/@import — plus the request-making calls a
   script can contain (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon,
   dynamic import) when their URL is a string literal.

   A plain <a href> is a navigation the visitor chooses, not a request the page
   makes, so links are never reported. Neither is rel="alternate"/"canonical",
   which describe a relationship and fetch nothing. URLs without a network host
   (data:, blob:, mailto:, tel:, #anchor) are skipped for the same reason.

   Every function is pure: source text in, a list of violations out. A URL held
   in a variable cannot be resolved here — the CSP remains the runtime backstop. */
'use strict';

var { JSDOM } = require('jsdom');

var DEFAULT_PAGE_URL = 'https://www.veyago.cloud/';

/* Hosts that are the site itself. Relative URLs resolve to these. */
var DEFAULT_OWN_HOSTS = ['www.veyago.cloud', 'veyago.cloud'];

/* <link rel> values the browser does not fetch: they describe a relationship.
   Every other rel (stylesheet, icon, apple-touch-icon, manifest, preload,
   modulepreload, prefetch, preconnect, dns-prefetch, ...) either fetches the
   URL or opens a connection to its host, so it is checked. */
var NON_FETCH_RELS = [
  'alternate', 'canonical', 'author', 'license', 'help', 'next', 'prev', 'search',
  'bookmark', 'tag', 'me', 'nofollow', 'noopener', 'noreferrer', 'privacy-policy',
  'terms-of-service'
];

/* Schemes that carry no network host. */
var NO_HOST_SCHEME = /^(data|blob|about|javascript|mailto|tel|sms):/i;

/* Attribute-carried URLs. `list` marks a srcset-style comma-separated value. */
var ELEMENT_URLS = [
  { selector: 'script[src]', attr: 'src', where: '<script src>' },
  { selector: 'img[src]', attr: 'src', where: '<img src>' },
  { selector: 'img[srcset]', attr: 'srcset', where: '<img srcset>', list: true },
  { selector: 'source[src]', attr: 'src', where: '<source src>' },
  { selector: 'source[srcset]', attr: 'srcset', where: '<source srcset>', list: true },
  { selector: 'iframe[src]', attr: 'src', where: '<iframe src>' },
  { selector: 'video[src]', attr: 'src', where: '<video src>' },
  { selector: 'video[poster]', attr: 'poster', where: '<video poster>' },
  { selector: 'audio[src]', attr: 'src', where: '<audio src>' },
  { selector: 'track[src]', attr: 'src', where: '<track src>' },
  { selector: 'object[data]', attr: 'data', where: '<object data>' },
  { selector: 'embed[src]', attr: 'src', where: '<embed src>' },
  { selector: 'input[type="image"][src]', attr: 'src', where: '<input type="image" src>' },
  { selector: 'form[action]', attr: 'action', where: '<form action>' },
  { selector: 'image[href]', attr: 'href', where: '<image href> (svg)' },
  { selector: 'use[href]', attr: 'href', where: '<use href> (svg)' }
];

/* Request-making calls whose first argument is a string literal. The literal
   is always capture group 2 (group 1 is its quote). */
var STRING_LITERAL = '([\'"`])((?:(?!\\1)[^\\\\\\n]|\\\\.)*)\\1';
var SCRIPT_CALLS = [
  { where: 'fetch()', prefix: '\\bfetch\\s*\\(\\s*' },
  { where: 'XMLHttpRequest.open()', prefix: '\\.open\\s*\\(\\s*(?:\'[A-Za-z]+\'|"[A-Za-z]+"|`[A-Za-z]+`)\\s*,\\s*' },
  { where: 'new WebSocket()', prefix: '\\bnew\\s+WebSocket\\s*\\(\\s*' },
  { where: 'new EventSource()', prefix: '\\bnew\\s+EventSource\\s*\\(\\s*' },
  { where: 'new Worker()', prefix: '\\bnew\\s+(?:Shared)?Worker\\s*\\(\\s*' },
  { where: 'sendBeacon()', prefix: '\\bsendBeacon\\s*\\(\\s*' },
  { where: 'importScripts()', prefix: '\\bimportScripts\\s*\\(\\s*' },
  { where: 'import()', prefix: '\\bimport\\s*\\(\\s*' },
  { where: 'import from', prefix: '\\bfrom\\s+' }
].map(function (call) {
  return { where: call.where, re: new RegExp(call.prefix + STRING_LITERAL, 'g') };
});

/* CSS: url(...) and @import "..." / @import url(...). Group 2 or 4 is the URL. */
var CSS_URL = /url\(\s*(['"]?)([^'")\s]*)\1\s*\)/g;
var CSS_IMPORT = /@import\s+(?:url\(\s*(['"]?)([^'")\s]*)\1\s*\)|(['"])([^'"]*)\3)/g;
var CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/* Script types the browser executes as JavaScript. Anything else (ld+json,
   importmap, templates) is data, handled separately or ignored. */
function isJavaScriptType(type) {
  var t = String(type || '').trim().toLowerCase();
  return t === '' || t === 'module' || /javascript|ecmascript/.test(t);
}

/* Host of a URL the browser would request, or null when it is not a network
   URL (no host, unparseable, or a scheme the browser never fetches). */
function hostOf(raw, base) {
  var value = String(raw || '').trim();
  if (!value || value.charAt(0) === '#' || NO_HOST_SCHEME.test(value)) return null;
  try {
    var url = new URL(value, base || DEFAULT_PAGE_URL);
    if (!/^(https?|wss?):$/.test(url.protocol)) return null;
    return url.hostname.toLowerCase();
  } catch (err) {
    return null;
  }
}

/* 1-based line of the first occurrence of `needle` in `text`, or null. */
function lineOf(text, needle) {
  var at = needle ? String(text).indexOf(needle) : -1;
  if (at === -1) return null;
  return String(text).slice(0, at).split('\n').length;
}

function lineAt(text, index) {
  return String(text).slice(0, index).split('\n').length;
}

/* srcset = comma-separated "url [descriptor]" candidates. */
function srcsetUrls(value) {
  return String(value || '').split(',')
    .map(function (candidate) { return candidate.trim().split(/\s+/)[0]; })
    .filter(Boolean);
}

function normaliseOpts(opts) {
  var o = opts || {};
  var lower = function (h) { return String(h).toLowerCase(); };
  return {
    pageUrl: o.pageUrl || DEFAULT_PAGE_URL,
    ownHosts: (o.ownHosts || DEFAULT_OWN_HOSTS).map(lower),
    allowedHosts: (o.allowedHosts || []).map(lower)
  };
}

/* A violation for `raw` at `where`, or null when the URL is first-party or allowed. */
function violationFor(raw, where, line, base, o) {
  var host = hostOf(raw, base);
  if (!host) return null;
  if (o.ownHosts.indexOf(host) !== -1 || o.allowedHosts.indexOf(host) !== -1) return null;
  return { where: where, url: String(raw).trim(), host: host, line: line };
}

/* Which rel tokens make a <link> a request. */
function fetchedLinkRel(el) {
  var rel = String(el.getAttribute('rel') || '').trim().toLowerCase();
  if (!rel) return null;
  var fetched = rel.split(/\s+/).some(function (token) { return NON_FETCH_RELS.indexOf(token) === -1; });
  return fetched ? rel : null;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/* Blank out comments while keeping every newline, so line numbers still hold. */
function stripCssComments(css) {
  return String(css).replace(CSS_COMMENT, function (m) { return m.replace(/[^\n]/g, ' '); });
}

function collectMatches(text, re, pick) {
  var out = [];
  var m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out = out.concat([{ url: pick(m), index: m.index }]);
  return out;
}

/* Violations in a stylesheet (or a style="" attribute). `where` labels the
   origin in the report; `lineBase` offsets line numbers for embedded CSS. */
function scanCss(css, opts, where) {
  var o = normaliseOpts(opts);
  var text = stripCssComments(css);
  var imports = collectMatches(text, CSS_IMPORT, function (m) { return m[2] || m[4]; })
    .map(function (hit) { return { url: hit.url, index: hit.index, where: (where || 'css') + ' @import' }; });
  /* An @import's url(...) is the same request: blank the imports before looking for url(). */
  var rest = text.replace(CSS_IMPORT, function (m) { return m.replace(/[^\n]/g, ' '); });
  var urls = collectMatches(rest, CSS_URL, function (m) { return m[2]; })
    .map(function (hit) { return { url: hit.url, index: hit.index, where: (where || 'css') + ' url()' }; });
  return imports.concat(urls)
    .map(function (hit) { return violationFor(hit.url, hit.where, lineAt(text, hit.index), o.pageUrl, o); })
    .filter(Boolean)
    .slice()
    .sort(function (a, b) { return a.line - b.line; });
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

/* Violations in a script: request-making calls with a literal URL. A template
   literal that interpolates (${...}) cannot be resolved and is skipped. */
function scanScript(js, opts, where) {
  var o = normaliseOpts(opts);
  var text = String(js);
  return SCRIPT_CALLS.reduce(function (acc, call) {
    var hits = collectMatches(text, call.re, function (m) { return m[2]; })
      .filter(function (hit) { return hit.url.indexOf('${') === -1; })
      .map(function (hit) { return violationFor(hit.url, (where ? where + ' ' : '') + call.where, lineAt(text, hit.index), o.pageUrl, o); })
      .filter(Boolean);
    return acc.concat(hits);
  }, []);
}

/* An import map can point a bare specifier at a CDN. */
function scanImportMap(json, opts, line) {
  var o = normaliseOpts(opts);
  var map;
  try { map = JSON.parse(json); } catch (err) { return []; }
  var urls = [].concat(
    Object.keys(map.imports || {}).map(function (k) { return map.imports[k]; }),
    Object.keys(map.scopes || {}).reduce(function (acc, scope) {
      return acc.concat(Object.keys(map.scopes[scope]).map(function (k) { return map.scopes[scope][k]; }));
    }, [])
  );
  return urls
    .map(function (url) { return violationFor(url, '<script type="importmap">', line, o.pageUrl, o); })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function scanAttributes(doc, html, base, o) {
  return ELEMENT_URLS.reduce(function (acc, rule) {
    var els = Array.prototype.slice.call(doc.querySelectorAll(rule.selector));
    var found = els.reduce(function (inner, el) {
      var raw = el.getAttribute(rule.attr);
      var candidates = rule.list ? srcsetUrls(raw) : [raw];
      return inner.concat(candidates.map(function (url) {
        return violationFor(url, rule.where, lineOf(html, url), base, o);
      }));
    }, []);
    return acc.concat(found);
  }, []).filter(Boolean);
}

function scanLinks(doc, html, base, o) {
  return Array.prototype.slice.call(doc.querySelectorAll('link[href]'))
    .map(function (el) {
      var rel = fetchedLinkRel(el);
      if (!rel) return null;
      var raw = el.getAttribute('href');
      return violationFor(raw, '<link rel="' + rel + '" href>', lineOf(html, raw), base, o);
    })
    .filter(Boolean);
}

function scanInlineStyles(doc, html, o) {
  var attrs = Array.prototype.slice.call(doc.querySelectorAll('[style]')).reduce(function (acc, el) {
    var css = el.getAttribute('style');
    return acc.concat(scanCss(css, o, 'style=""').map(function (v) {
      return Object.assign({}, v, { line: lineOf(html, v.url) });
    }));
  }, []);
  var blocks = Array.prototype.slice.call(doc.querySelectorAll('style')).reduce(function (acc, el) {
    return acc.concat(scanCss(el.textContent, o, '<style>').map(function (v) {
      return Object.assign({}, v, { line: lineOf(html, v.url) });
    }));
  }, []);
  return attrs.concat(blocks);
}

function scanInlineScripts(doc, html, o) {
  return Array.prototype.slice.call(doc.querySelectorAll('script:not([src])')).reduce(function (acc, el) {
    var type = String(el.getAttribute('type') || '').trim().toLowerCase();
    var found = type === 'importmap'
      ? scanImportMap(el.textContent, o, lineOf(html, '<script'))
      : isJavaScriptType(type) ? scanScript(el.textContent, o, 'inline <script>') : [];
    return acc.concat(found.map(function (v) { return Object.assign({}, v, { line: lineOf(html, v.url) }); }));
  }, []);
}

/* Violations in one HTML document.
     opts.allowedHosts  hosts the CSP lets the page talk to (exact hostnames)
     opts.ownHosts      the site's own hostnames (default: www.veyago.cloud, veyago.cloud)
     opts.pageUrl       the page's URL, for resolving relative references */
function scan(html, opts) {
  var o = normaliseOpts(opts);
  var text = String(html);
  var doc = new JSDOM(text, { url: o.pageUrl }).window.document;
  var base = doc.baseURI;
  var withBase = Object.assign({}, o, { pageUrl: base });
  return [].concat(
    scanAttributes(doc, text, base, withBase),
    scanLinks(doc, text, base, withBase),
    scanInlineStyles(doc, text, withBase),
    scanInlineScripts(doc, text, withBase)
  );
}

/* Dispatch on file extension. */
function scanSource(file, text, opts) {
  var ext = String(file).toLowerCase().replace(/^.*\./, '');
  if (ext === 'html' || ext === 'htm') return scan(text, opts);
  if (ext === 'css') return scanCss(text, opts);
  if (ext === 'js' || ext === 'mjs') return scanScript(text, opts);
  return [];
}

function formatViolation(file, v) {
  return file + (v.line ? ':' + v.line : '') + '  ' + v.where + '  ' + v.url + '  (host: ' + v.host + ')';
}

// ---------------------------------------------------------------------------
// CSP → allowlist
// ---------------------------------------------------------------------------

/* Directives that govern fetches. form-action, base-uri, frame-ancestors and
   report-uri say nothing about what the page requests. */
var FETCH_DIRECTIVES = [
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src',
  'style-src-elem', 'style-src-attr', 'img-src', 'font-src', 'connect-src',
  'media-src', 'frame-src', 'child-src', 'worker-src', 'object-src',
  'manifest-src', 'prefetch-src'
];

/* Hostname a CSP source expression pins, or null. Keywords ('self'), hashes,
   bare schemes (data:, https:) and wildcards (*.example.com) name no single
   host, so they contribute nothing: only an exact host can be allowed. */
function hostFromCspSource(token) {
  if (!token || token.charAt(0) === '\'') return null;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(token)) return null;
  if (token.indexOf('*') !== -1) return null;
  var withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : 'https://' + token;
  try { return new URL(withScheme).hostname.toLowerCase(); } catch (err) { return null; }
}

/* Every exact host a Content-Security-Policy value lets the page fetch from. */
function hostsFromCsp(csp) {
  return String(csp || '').split(';')
    .map(function (d) { return d.trim().split(/\s+/); })
    .filter(function (parts) { return FETCH_DIRECTIVES.indexOf(parts[0].toLowerCase()) !== -1; })
    .reduce(function (hosts, parts) {
      return parts.slice(1).map(hostFromCspSource).filter(Boolean).reduce(function (acc, h) {
        return acc.indexOf(h) === -1 ? acc.concat(h) : acc;
      }, hosts);
    }, []);
}

module.exports = {
  scan, scanCss, scanScript, scanSource, formatViolation, hostsFromCsp,
  hostOf, srcsetUrls, lineOf, DEFAULT_OWN_HOSTS, DEFAULT_PAGE_URL
};
