/* Tests for the language logic in app.js: the static-twin handling added with
   tools/build-locales.js. A wrong path here is a redirect loop or a 404 for
   every visitor with a stored preference, so the runtime script is exercised
   for real in jsdom, with window.__veyagoNavigate standing in for location. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');

const ALT = '<link rel="alternate" hreflang="x-default" href="https://www.veyago.cloud/websites/">' +
  '<link rel="alternate" hreflang="en" href="https://www.veyago.cloud/websites/">' +
  '<link rel="alternate" hreflang="nl" href="https://www.veyago.cloud/nl/websites/">';

const CHROME = '<header class="nav"><div class="wrap"><a class="brand" href="/">Veyago</a>' +
  '<div class="nav-right"><button class="nav-toggle" id="nav-toggle"></button></div></div></header>' +
  '<div class="nav-scrim" id="nav-scrim"></div><aside class="nav-drawer" id="nav-drawer"><nav class="nav-drawer-links"></nav></aside>' +
  '<main id="main"><h1>Your business, properly online.</h1></main>';

function boot(opts) {
  const html = '<!doctype html><html lang="en"' + (opts.staticLang ? ' data-i18n-static="' + opts.staticLang + '"' : '') +
    '><head><title>T</title><meta name="description" content="D">' + (opts.alternates ? ALT : '') + '</head><body>' + CHROME + '</body></html>';
  const dom = new JSDOM(html, { url: 'https://www.veyago.cloud' + opts.path, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  if (opts.stored) window.localStorage.setItem('veyago.lang', opts.stored); else window.localStorage.removeItem('veyago.lang');
  const nav = [];
  window.__veyagoNavigate = (p, replace) => { nav.push({ path: p, replace }); };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  vm.runInContext(SRC, dom.getInternalVMContext());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, nav, pick: (code) => window.document.querySelector('#lang-switch [data-setlang="' + code + '"]').click() };
}

test('a stored Dutch preference sends the English page to its Dutch twin, by replacement', () => {
  const { nav } = boot({ path: '/websites/', alternates: true, stored: 'nl' });
  assert.deepEqual(nav, [{ path: '/nl/websites/', replace: true }]);
});

test('a first-time visitor is never redirected', () => {
  const { window, nav } = boot({ path: '/websites/', alternates: true });
  assert.deepEqual(nav, []);
  assert.equal(window.document.documentElement.lang, 'en');
});

test('on the Dutch twin with a stored Dutch preference: no redirect, no dictionary load, lang nl', () => {
  const { window, nav } = boot({ path: '/nl/websites/', alternates: true, staticLang: 'nl', stored: 'nl' });
  assert.deepEqual(nav, []);
  assert.equal(window.document.documentElement.lang, 'nl');
  assert.equal(window.document.querySelector('script[src^="/i18n/"]'), null);
  assert.equal(window.document.querySelector('#lang-switch .lang-opt.active').textContent, 'Nederlands');
});

test('on the Dutch twin a stored English preference goes back to the English page', () => {
  const { nav } = boot({ path: '/nl/websites/', alternates: true, staticLang: 'nl', stored: 'en' });
  assert.deepEqual(nav, [{ path: '/websites/', replace: true }]);
});

test('picking a language on the English page navigates to its twin and remembers the choice', () => {
  const { window, nav, pick } = boot({ path: '/websites/', alternates: true });
  pick('nl');
  assert.deepEqual(nav, [{ path: '/nl/websites/', replace: false }]);
  assert.equal(window.localStorage.getItem('veyago.lang'), 'nl');
});

test('picking a language with no twin while on the Dutch twin goes to the English source, where it applies', () => {
  const { window, nav, pick } = boot({ path: '/nl/websites/', alternates: true, staticLang: 'nl', stored: 'nl' });
  pick('fr');
  assert.deepEqual(nav, [{ path: '/websites/', replace: false }]);
  assert.equal(window.localStorage.getItem('veyago.lang'), 'fr');
});

test('a page with no twins keeps the runtime path: no redirect, dictionary requested', () => {
  const { window, nav } = boot({ path: '/services/', stored: 'nl' });
  assert.deepEqual(nav, []);
  const s = window.document.querySelector('script[src^="/i18n/"]');
  assert.ok(s && s.getAttribute('src') === '/i18n/nl.js');
});
