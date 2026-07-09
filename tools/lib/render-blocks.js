/* Render an article's ordered block array (spec §4) into brand-styled HTML for
   the `.paper-body` column. One shared renderer, used by the static-export build
   (tools/build.js). Maps each block type onto the existing essay/house CSS
   vocabulary (.paper-*, .eyebrow) plus the few new classes added in styles.css
   (.pull-quote, .paper-figure, .paper-rule).

   Block types:
     section_marker { text }                  → uppercase parchment-style label
     heading        { level (2|3), text }      → <h2 id>/<h3>, optional "N." → .sec-n
     text           { html }                   → sanitised rich text (the only raw HTML)
     image          { url, alt, caption }      → <figure class="paper-figure">
     quote          { text, attribution }      → <blockquote class="pull-quote">
     divider        {}                          → <hr class="paper-rule">
*/
'use strict';

var { esc, attr } = require('./escape');
var { slugify } = require('./slugify');
var { sanitizeHtml } = require('./sanitize');

/* "3. Building the spine" → { num: "3.", rest: "Building the spine" }. */
function splitNumber(text) {
  var m = String(text || '').match(/^(\d+\.)\s*([\s\S]*)$/);
  if (m) return { num: m[1], rest: m[2] };
  return { num: null, rest: String(text || '') };
}

function tocLabel(text) {
  return splitNumber(text).rest.split(':')[0].trim() || String(text || '').trim();
}

function headingId(text) {
  var sp = splitNumber(text);
  if (sp.num) return 'section-' + sp.num.replace('.', '');
  return slugify(sp.rest) || 'section';
}

function headingInner(text) {
  var sp = splitNumber(text);
  if (sp.num) return '<span class="sec-n">' + esc(sp.num) + '</span> ' + esc(sp.rest);
  return esc(sp.rest);
}

function renderBlock(b, toc) {
  if (!b || !b.type) return '';
  switch (b.type) {
    case 'section_marker':
      return '<p class="eyebrow paper-marker">' + esc(b.text) + '</p>';

    case 'heading': {
      var level = b.level === 3 ? 3 : 2;
      if (level === 2) {
        var id = headingId(b.text);
        toc.push({ id: id, label: tocLabel(b.text) });
        return '<h2 id="' + attr(id) + '">' + headingInner(b.text) + '</h2>';
      }
      return '<h3>' + esc(b.text) + '</h3>';
    }

    case 'text':
      // The one place raw HTML enters the page — sanitise on the way in (spec §4).
      return sanitizeHtml(b.html);

    case 'image': {
      if (!b.url) return '';
      var cap = b.caption
        ? '\n          <figcaption>' + esc(b.caption) + '</figcaption>'
        : '';
      return '<figure class="paper-figure">\n          <img src="' + attr(b.url) +
        '" alt="' + attr(b.alt || '') + '" loading="lazy" />' + cap + '\n        </figure>';
    }

    case 'quote': {
      if (!b.text) return '';
      var cite = b.attribution
        ? '\n          <cite>' + esc(b.attribution) + '</cite>'
        : '';
      return '<blockquote class="pull-quote">\n          <p>' + esc(b.text) + '</p>' + cite + '\n        </blockquote>';
    }

    case 'divider':
      return '<hr class="paper-rule" />';

    default:
      return '';
  }
}

/* Render the whole body. Returns { html, toc } where toc lists the level-2
   headings (used to decide whether to show the sticky contents column). */
function renderBlocks(blocks) {
  var toc = [];
  var parts = (blocks || []).map(function (b) { return renderBlock(b, toc); }).filter(Boolean);
  return { html: parts.join('\n        '), toc: toc };
}

module.exports = { renderBlocks, renderBlock, headingId, tocLabel };
