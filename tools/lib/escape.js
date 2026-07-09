/* HTML escaping helpers shared by the static-export builders. */
'use strict';

/* Escape text destined for element content. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Escape a value destined for a double-quoted attribute. */
function attr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

module.exports = { esc, attr };
