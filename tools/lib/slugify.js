/* Turn a heading or title into a URL-safe, lowercase slug. */
'use strict';

function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .trim()
    .replace(/['’"]/g, '')          // drop apostrophes/quotes outright
    .replace(/[^a-z0-9]+/g, '-')    // everything else → single hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens
}

module.exports = { slugify };
