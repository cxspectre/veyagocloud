/* Maintain a build-managed block of <url> entries inside the hand-written
   sitemap.xml. Hand-written entries outside the markers are left untouched. */
'use strict';

var START = '  <!-- BUILD:generated:start -->';
var END = '  <!-- BUILD:generated:end -->';

function urlEntry(e) {
  var lastmod = e.lastmod ? '<lastmod>' + e.lastmod + '</lastmod>' : '';
  var priority = e.priority != null ? '<priority>' + e.priority + '</priority>' : '';
  return '  <url><loc>' + e.loc + '</loc>' + lastmod + priority + '</url>';
}

/* Replace (or insert before </urlset>) the managed block with the given entries. */
function applySitemap(xml, entries) {
  var inner = (entries || []).map(urlEntry).join('\n');
  var block = START + '\n' + inner + '\n' + END;
  var s = xml.indexOf(START);
  var e = xml.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    return xml.slice(0, s) + block + xml.slice(e + END.length);
  }
  if (xml.indexOf('</urlset>') !== -1) {
    return xml.replace('</urlset>', block + '\n</urlset>');
  }
  return xml + '\n' + block + '\n';
}

module.exports = { applySitemap, START: START, END: END };
