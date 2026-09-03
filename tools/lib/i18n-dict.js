/* Load one of the site's i18n dictionaries (i18n/<code>.js) in Node.

   Each dictionary is a browser script that calls
   window.__veyagoI18n.register(code, {strings, attrs, html, meta}). Running it
   in a throwaway context with a fake window is the one faithful way to read
   it: the file stays the single source of truth for both the runtime switcher
   and the static locale build, and nothing has to parse JS by regex. */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function loadDict(code, root) {
  var file = path.join(root || path.join(__dirname, '..', '..'), 'i18n', code + '.js');
  var src = fs.readFileSync(file, 'utf8');
  var dict = null;
  var fakeWindow = { __veyagoI18n: { register: function (c, d) { if (c === code) dict = d; } } };
  vm.runInNewContext(src, { window: fakeWindow }, { filename: file, timeout: 2000 });
  if (!dict) throw new Error('i18n/' + code + '.js did not register a dictionary for "' + code + '"');
  return {
    strings: dict.strings || {},
    attrs: dict.attrs || {},
    html: dict.html || {},
    meta: dict.meta || {}
  };
}

module.exports = { loadDict };
