/* Read and write i18n/<code>.js without disturbing the file.
 *
 * The dictionaries are a one-line JSON object wrapped in a register() call, kept
 * on one line so a diff shows the string that changed rather than a reflow of
 * seven hundred neighbours. Hand-editing a 100 KB single line is how a stray
 * quote gets in, so anything scripted goes through here: parse, change the
 * object, write it back in byte-identical formatting.
 *
 *   var dict = require('./lib/i18n-file');
 *   var nl = dict.read('nl');
 *   nl.meta['/kept/'].title = '…';
 *   dict.write('nl', nl);
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');

function file(code) { return path.join(ROOT, 'i18n', code + '.js'); }

function pattern(code) {
  return new RegExp('(register\\("' + code + '",)([\\s\\S]*)(\\);\\s*)$');
}

/* The exact spacing the committed files use: JSON with one space after every
   key colon and every top-level comma. Reproduced rather than reformatted. */
function serialise(dict) {
  return JSON.stringify(dict)
    .replace(/","/g, '", "')
    .replace(/":"/g, '": "')
    .replace(/":\{/g, '": {')
    .replace(/\},"/g, '}, "');
}

function read(code) {
  var src = fs.readFileSync(file(code), 'utf8');
  var m = src.match(pattern(code));
  if (!m) throw new Error('i18n/' + code + '.js: could not find the register() payload');
  return JSON.parse(m[2]);
}

function write(code, dict) {
  var src = fs.readFileSync(file(code), 'utf8');
  var m = src.match(pattern(code));
  if (!m) throw new Error('i18n/' + code + '.js: could not find the register() payload');
  fs.writeFileSync(file(code), src.replace(pattern(code), function () {
    return m[1] + serialise(dict) + m[3];
  }));
}

/* Every locale that has a dictionary file. */
function locales() {
  return fs.readdirSync(path.join(ROOT, 'i18n'))
    .filter(function (name) { return /\.js$/.test(name); })
    .map(function (name) { return name.replace(/\.js$/, ''); })
    .sort();
}

module.exports = { read, write, serialise, locales, file };
