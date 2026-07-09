/* Render the wallpapers gallery (/wallpapers/). A grid of previews; each card
   carries one labelled download button per variant (spec §10). Files are served
   first-party from the repo (the build pulls them in), so the `download` attribute
   actually saves the file. */
'use strict';

var { esc, attr } = require('./escape');
var { page, SITE } = require('./chrome');
var { newsletterSection } = require('./newsletter-embed');

var INDEX_LEDE = 'Free to download — made for the brand and for your home screen. Nothing tracked, nothing sold.';

function variantButton(v) {
  if (!v || !v.url) return '';
  var dims = (v.width && v.height)
    ? ' <span class="wp-dim">' + esc(v.width) + '×' + esc(v.height) + '</span>'
    : '';
  return '<a class="wp-dl" href="' + attr(v.url) + '" download>' + esc(v.label || 'Download') + dims + '</a>';
}

function wallpaperCard(w) {
  var cat = w.category ? '<p class="eyebrow">' + esc(w.category) + '</p>' : '';
  var desc = w.description ? '<p class="wp-desc">' + esc(w.description) + '</p>' : '';
  var dls = (w.variants || []).map(variantButton).filter(Boolean).join('\n              ');
  return `<article class="card wp-card">
          <div class="wp-preview"><img src="${attr(w.preview_url)}" alt="${attr(w.title)}" loading="lazy" /></div>
          <div class="wp-body">
            ${cat}
            <h3 class="wp-title">${esc(w.title)}</h3>
            ${desc}
            <div class="wp-downloads">
              ${dls || '<span class="wp-soon">Coming soon</span>'}
            </div>
          </div>
        </article>`;
}

function renderWallpapersIndex(wallpapers) {
  var cards = (wallpapers || []).map(wallpaperCard).join('\n        ');
  var grid = wallpapers && wallpapers.length
    ? '<div class="wp-grid">\n        ' + cards + '\n      </div>'
    : '<p class="ji-empty">No wallpapers published yet.</p>';

  var body = `  <main class="wallpapers-index">
    <section class="section">
      <div class="wrap">
        <header class="ji-head">
          <p class="eyebrow">Wallpapers</p>
          <h1>Wallpapers</h1>
          <p class="lede">${INDEX_LEDE}</p>
        </header>
        ${newsletterSection({ id: 'wallpapers', heading: 'Subscribers get the new drop each month', dek: 'A fresh wallpaper set lands monthly. Subscribe and never miss one.' })}
        ${grid}
      </div>
    </section>
  </main>`;

  return page({
    lang: 'en',
    head: {
      title: 'Wallpapers | Veyago',
      description: INDEX_LEDE,
      canonical: SITE + '/wallpapers/',
      ogType: 'website'
    },
    body: body,
    scripts: ['/assets/js/newsletter.js']
  });
}

module.exports = { renderWallpapersIndex };
