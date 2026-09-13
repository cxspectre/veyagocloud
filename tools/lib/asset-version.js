/* One definition of "which version of styles.css is this".
 *
 * Used by tools/lib/chrome.js (which assembles generated pages) and by
 * tools/version-assets.js (which stamps the hand-written ones). They must
 * agree exactly, or `npm run check` reports the generated tree as stale on
 * every run — two hash functions that drift is a worse bug than the one this
 * whole mechanism exists to fix.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var cache = {};

/* Ten hex characters of SHA-256 over the file's bytes. Long enough that a
   collision is not a thing that happens, short enough to read in a URL. */
function assetVersion(file) {
  if (cache[file]) return cache[file];
  var bytes = fs.readFileSync(path.join(ROOT, file));
  cache[file] = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  return cache[file];
}

/* "/styles.css?v=0df31ccb35" */
function versioned(file) {
  return '/' + file + '?v=' + assetVersion(file);
}

module.exports = { assetVersion: assetVersion, versioned: versioned };
