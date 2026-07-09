/* Small formatting helpers for the static-export build. */
'use strict';

var { SITE } = require('./chrome');

/* "2026-06-28T..." → "June 28, 2026" (UTC, en-US). Empty string if unparseable. */
function formatDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/* "2026-06-28T..." → "2026-06-28" for <lastmod>. Empty string if unparseable. */
function isoDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/* Resolve a possibly-relative URL to an absolute veyago.cloud URL (for og:image). */
function absoluteUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === '/') return SITE + u;
  return SITE + '/' + u;
}

module.exports = { formatDate, isoDate, absoluteUrl };
