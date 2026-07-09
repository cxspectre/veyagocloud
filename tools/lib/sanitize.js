/* Allowlist sanitiser for the one place raw HTML enters an article: the `text`
   block (spec §4). Runs at BUILD time only (Node) — never shipped to the browser.
   Permits only p, strong, em, a, ul, ol, li, br and strips everything else; all
   links are forced to safe, off-site defaults. */
'use strict';

var createDOMPurify = require('dompurify');
var { JSDOM } = require('jsdom');

var ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br'];
var ALLOWED_ATTR = ['href', 'target', 'rel'];

var window = new JSDOM('').window;
var DOMPurify = createDOMPurify(window);

/* Make every surviving link open safely off-site. The hook runs after attribute
   sanitisation, so DOMPurify keeps what we set here. javascript:/data: URIs are
   already dropped by DOMPurify's default URI policy. */
DOMPurify.addHook('afterSanitizeAttributes', function (node) {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function sanitizeHtml(html) {
  if (!html) return '';
  // Note: do NOT pass USE_PROFILES here — it re-expands the tag set and would
  // defeat the explicit ALLOWED_TAGS allowlist below.
  return DOMPurify.sanitize(String(html), {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false
  });
}

module.exports = { sanitizeHtml, ALLOWED_TAGS, ALLOWED_ATTR };
