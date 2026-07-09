/* Render an app product page (/apps/<slug>/) from the layout composed in
   /admin/apps-editor.html. The section markup here is the published twin of the
   editor's live canvas (admin/js/apps-editor.js → bodyByType): same classes, same
   structure, minus the contenteditable / toolbar scaffolding. The .reveal class is
   added to the same elements the hand-authored product pages use (feat-row, step,
   card) so app.js animates them in on scroll. Keep the two in lockstep. */
'use strict';

var { esc, attr } = require('./escape');
var { page, SITE, DEFAULT_OG_IMAGE } = require('./chrome');
var { absoluteUrl } = require('./format');

/* Stamped into every generated app page so the build can identify (and clean up)
   its own /apps/<slug>/ output without ever touching the hand-authored
   /apps/index.html or any future bespoke /apps/<slug>/ page. */
var GEN_MARKER = '<!-- veyago:generated-app-page -->';

/* Feature-card icon set — identical to the editor's ICONS so a published card
   shows the exact glyph the author picked. */
var ICONS = {
  lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2"/></svg>',
  bell:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16h12l-1.6-2.2V10a4.4 4.4 0 0 0-8.8 0v3.8L6 16z"/><path d="M10.4 19a1.7 1.7 0 0 0 3.2 0"/></svg>',
  scan:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="17" height="12.5" rx="2.4"/><circle cx="12" cy="13.2" r="3.1"/><path d="M8.5 7l1.4-2h4.2l1.4 2"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/></svg>',
  doc:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.6h7L18.4 8v11a1.6 1.6 0 0 1-1.6 1.6H7A1.6 1.6 0 0 1 5.4 19V5.2A1.6 1.6 0 0 1 7 3.6z"/><path d="M13.6 3.6V8h4.4"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l7.4 2.8v5.2c0 4.6-3.2 7.8-7.4 9.2-4.2-1.4-7.4-4.6-7.4-9.2V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  tag:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.6V5.4A1.4 1.4 0 0 1 5.4 4h7.2a1.4 1.4 0 0 1 1 .4l6 6a1.4 1.4 0 0 1 0 2l-7.2 7.2a1.4 1.4 0 0 1-2 0l-6-6a1.4 1.4 0 0 1-.4-1z"/><circle cx="8.4" cy="8.4" r="1.2"/></svg>'
};

var APPLE_SVG = '<svg viewBox="0 0 814 1000" aria-hidden="true"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-42.4-150.3-109.3C76.7 726.2 30.4 600.4 30.4 480.4c0-109.8 55.7-167.2 96.5-205.2 53.2-49.5 104-60.9 148.8-60.9 65.7 0 118.4 44.3 158.3 44.3 37.7 0 97.5-47.8 170.7-47.8 23.4 0 108.2 2.7 156.3 75.6zm-237.5-325.3c23.4-27.8 38.1-64.2 38.1-100.6 0-5.8-.5-11.7-1.6-16.4-35.6 1.3-78.5 23.9-104 51.5-22.8 25.2-41 61.6-41 98.6 0 6.5.6 13 1.1 15.1 2.2.4 5.8.8 9.4.8 32.5 0 74.7-21.7 98-48.9z" fill="#fff"/></svg>';

/* Emit <tag class>value</tag> only when value is non-empty (no empty tags on the
   published page, unlike the editor which always shows placeholders). */
function el(tag, cls, value) {
  if (value == null || String(value).trim() === '') return '';
  return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>' + esc(value) + '</' + tag + '>';
}

/* The screenshot device. eager on the hero (it's the LCP), lazy below the fold. */
function media(s, eager) {
  if (!s.image) return '';
  return '<div class="device"><img src="' + attr(s.image) + '" alt="' + attr(s.imageAlt || '') + '"' +
    (eager ? '' : ' loading="lazy"') + ' /></div>';
}

function heroActions(s) {
  var out = '';
  if (s.ctaKind === 'appstore') {
    out += '<a class="badge-as" href="' + attr(s.ctaHref || '#') + '">' + APPLE_SVG +
      '<span><span class="bas-sub">' + esc(s.ctaSub || 'Coming soon to the') + '</span>' +
      '<span class="bas-name">' + esc(s.ctaLabel || 'App Store') + '</span></span></a>';
  } else if (s.ctaKind === 'button' && s.ctaLabel) {
    out += '<a class="btn btn-blue" href="' + attr(s.ctaHref || '#') + '">' + esc(s.ctaLabel) + '</a>';
  }
  if (s.linkLabel) out += '<a class="link" href="' + attr(s.linkHref || '#') + '">' + esc(s.linkLabel) + '</a>';
  return out ? '<div class="actions">' + out + '</div>' : '';
}

/* The header block (eyebrow + headline) shared by steps/cards sections. */
function sectionHead(s) {
  var inner = el('p', 'eyebrow', s.eyebrow) + el('h2', 'section-headline', s.headline);
  return inner ? '<div class="wrap">' + inner + '</div>' : '';
}

function renderSection(s) {
  if (!s || !s.type) return '';

  if (s.type === 'hero') {
    return '<section class="section hero split"><div class="wrap">' +
        '<div class="hero-text">' +
          el('p', 'eyebrow', s.eyebrow) +
          el('h1', 'headline', s.headline) +
          el('p', 'lead', s.lead) +
          heroActions(s) +
        '</div>' +
        '<div class="hero-media">' + media(s, true) + '</div>' +
      '</div></section>';
  }

  if (s.type === 'feature') {
    return '<section class="section feat-section' + (s.soft ? ' soft' : '') + '">' +
        '<div class="feat-row reveal' + (s.flip ? ' flip' : '') + '">' +
          '<div class="fr-body">' +
            el('p', 'eyebrow', s.eyebrow) +
            el('h2', 'section-headline', s.headline) +
            el('p', 'lead', s.lead) +
          '</div>' +
          '<div class="fr-media">' + media(s, false) + '</div>' +
        '</div></section>';
  }

  if (s.type === 'steps') {
    var steps = (s.items || []).map(function (it, j) {
      return '<div class="step reveal">' +
        '<div class="num">' + (j + 1) + '</div>' +
        el('h4', '', it.title) +
        el('p', '', it.text) +
      '</div>';
    }).join('');
    return '<section class="section">' +
        sectionHead(s) +
        '<div class="wrap"><div class="steps">' + steps + '</div></div></section>';
  }

  if (s.type === 'cards') {
    var items = s.items || [];
    var cards = items.map(function (it) {
      return '<div class="card reveal">' +
        '<div class="ic ' + attr(it.tone || 'ic-blue') + '">' + (ICONS[it.icon] || ICONS.spark) + '</div>' +
        el('h3', '', it.title) +
        el('p', '', it.text) +
      '</div>';
    }).join('');
    return '<section class="section' + (s.soft ? ' soft' : '') + '">' +
        sectionHead(s) +
        '<div class="cards' + (items.length <= 2 ? ' two' : '') + '">' + cards + '</div></section>';
  }

  if (s.type === 'cta') {
    var actions = s.linkLabel
      ? '<div class="actions"><a class="link" href="' + attr(s.linkHref || '#') + '">' + esc(s.linkLabel) + '</a></div>'
      : '';
    return '<section class="section dark"><div class="wrap">' +
        el('h2', 'section-headline', s.headline) +
        el('p', 'lead', s.lead) +
        actions +
      '</div></section>';
  }

  return '';
}

/* Short social/SEO description: the catalogue tagline, else the first hero/lead line. */
function appSummary(app) {
  if (app.tagline) return app.tagline;
  var layout = app.layout || [];
  for (var i = 0; i < layout.length; i++) {
    if (layout[i] && layout[i].lead) return layout[i].lead;
  }
  return app.description || '';
}

/* og:image — the icon if it's a real image, else the first hero screenshot, else default. */
function appOgImage(app) {
  if (app.icon_url) return absoluteUrl(app.icon_url);
  var layout = app.layout || [];
  for (var i = 0; i < layout.length; i++) {
    if (layout[i] && layout[i].type === 'hero' && layout[i].image) return absoluteUrl(layout[i].image);
  }
  return DEFAULT_OG_IMAGE;
}

/* One app product page → full HTML document string. */
function renderAppPage(app) {
  var layout = Array.isArray(app.layout) ? app.layout : [];
  var sections = layout.map(renderSection).filter(Boolean).join('\n    ');
  var body = '  <main class="app-page">\n    ' + sections + '\n  </main>';

  return page({
    lang: 'en',
    head: {
      title: (app.name || 'App') + ' | Veyago',
      description: appSummary(app),
      canonical: SITE + '/apps/' + app.slug + '/',
      ogType: 'website',
      ogImage: appOgImage(app),
      extra: GEN_MARKER
    },
    body: body
  });
}

module.exports = { renderAppPage, renderSection, GEN_MARKER };
