/* Tests for Private | Business: assets/js/side.js (which side a shared page
   shows, before it paints) and the switch in app.js (remembering the side,
   marking the one on show, the logo link). The header markup is the real one
   from tools/lib/chrome.js, so a template change is tested here too. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const chrome = require('../../tools/lib/chrome');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const SIDE = fs.readFileSync(path.join(__dirname, 'side.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');

/* side: 'private' | 'business' | null (shared). stored: what localStorage holds
   before the page loads; storage: false makes every storage call throw. */
function boot(opts) {
  const side = opts.side === undefined ? 'private' : opts.side;
  const html = '<!doctype html><html lang="en"' + chrome.htmlSideAttrs(side) + '><head><title>T</title></head><body>' +
    chrome.header({ side }) + '<main id="main"></main>' + chrome.footer({ side }) + '</body></html>';
  const dom = new JSDOM(html, { url: 'https://www.veyago.cloud' + (opts.path || '/team/'), runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  if (opts.storage === false) {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  } else if (opts.stored) {
    window.localStorage.setItem('veyago.side', opts.stored);
  }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const ctx = dom.getInternalVMContext();
  if (side === null) vm.runInContext(SIDE, ctx);     // only shared pages load side.js
  vm.runInContext(APP, ctx);
  const doc = window.document;
  /* jsdom does not navigate; record where a link would have gone instead. */
  const went = [];
  doc.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a) { went.push(a.getAttribute('href')); e.preventDefault(); }
  });
  return { window, doc, went };
}

const shown = (doc) => doc.documentElement.getAttribute('data-side');
const opt = (doc, s) => doc.querySelector('.side-opt[data-side="' + s + '"]');
const stored = (window) => window.localStorage.getItem('veyago.side');
const key = (doc, el, k) => el.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
const current = (doc) => [...doc.querySelectorAll('.side-opt[aria-current="true"]')].map((a) => a.getAttribute('data-side'));

test('a business page becomes the visitor\'s side and marks its own option', () => {
  const { window, doc } = boot({ side: 'business', path: '/audits/', stored: 'private' });
  assert.equal(shown(doc), 'business');
  assert.equal(stored(window), 'business');
  assert.deepEqual(current(doc), ['business']);
});

test('a private page does the same for Private', () => {
  const { window, doc } = boot({ side: 'private', path: '/apps/', stored: 'business' });
  assert.equal(shown(doc), 'private');
  assert.equal(stored(window), 'private');
  assert.deepEqual(current(doc), ['private']);
});

test('a shared page shows the side the visitor was last on, logo included', () => {
  const { doc } = boot({ side: null, stored: 'business' });
  assert.equal(shown(doc), 'business');
  assert.deepEqual(current(doc), ['business'], 'the mark moves off Private, where the HTML put it');
  assert.equal(doc.querySelector('#site-nav .brand').getAttribute('href'), '/business/');
});

test('a first visit to a shared page opens on Private', () => {
  const { window, doc } = boot({ side: null });
  assert.equal(shown(doc), 'private');
  assert.equal(stored(window), null, 'nothing is written until a side is chosen or visited');
  assert.equal(doc.querySelector('#site-nav .brand').getAttribute('href'), '/');
});

test('a stored value that is not a side is ignored', () => {
  const { doc } = boot({ side: null, stored: 'enterprise' });
  assert.equal(shown(doc), 'private');
});

test('with storage blocked, every page still shows its own side', () => {
  assert.equal(shown(boot({ side: null, storage: false }).doc), 'private');
  assert.equal(shown(boot({ side: 'business', storage: false }).doc), 'business');
});

test('side.js never moves a page that has a side of its own', () => {
  const dom = new JSDOM('<!doctype html><html' + chrome.htmlSideAttrs('business') + '><head></head><body></body></html>',
    { url: 'https://www.veyago.cloud/audits/', runScripts: 'outside-only' });
  dom.window.localStorage.setItem('veyago.side', 'private');
  vm.runInContext(SIDE, dom.getInternalVMContext());
  assert.equal(dom.window.document.documentElement.getAttribute('data-side'), 'business');
});

test('choosing a side remembers it and follows the link', () => {
  const { window, doc, went } = boot({ side: null });
  opt(doc, 'business').click();
  assert.equal(stored(window), 'business');
  assert.deepEqual(went, ['/business/']);
});

test('the switch is two ordinary links: both reachable, and no key leaves the page by itself', () => {
  const { doc, went } = boot({ side: 'private', path: '/' });
  const opts = [...doc.querySelectorAll('.side-opt')];
  assert.equal(doc.querySelector('.side-switch').tagName, 'NAV');
  assert.ok(opts.every((a) => a.tagName === 'A' && a.getAttribute('href') && !a.hasAttribute('tabindex') && !a.hasAttribute('role')));
  opt(doc, 'private').focus();
  ['ArrowRight', 'ArrowLeft', 'ArrowDown', ' ', 'Tab'].forEach((k) => key(doc, opt(doc, 'private'), k));
  assert.deepEqual(went, [], 'arrowing past the options must not load another page');
});

test('the header: a page with a side carries only its own menu, a shared page both', () => {
  const links = (html) => [...new JSDOM(html).window.document.querySelectorAll('.nav-links > a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(links(chrome.header({ side: 'private' })), ['/apps/', '/projects/', '/journal/', '/wallpapers/']);
  assert.deepEqual(links(chrome.header({ side: 'business' })), ['/websites/', '/audits/', '/cockpit/', '/services/']);
  const shared = new JSDOM(chrome.header({ side: null })).window.document;
  assert.equal(shared.querySelectorAll('.nav-links > a[data-for="private"]').length, 4);
  assert.equal(shared.querySelectorAll('.nav-links > a[data-for="business"]').length, 4);
  assert.equal(shared.querySelectorAll('.nav-links > a:not([data-for])').length, 0);
  assert.throws(() => chrome.header({ side: 'enterprise' }), /Unknown side/);
});

test('the header button: the side\'s own, or the page\'s quote form when it has one', () => {
  const doc = (o) => new JSDOM(chrome.header(o)).window.document;
  assert.equal(doc({ side: 'private' }).querySelector('.nav-right .nav-cta').getAttribute('href'), '/apps/');
  assert.equal(doc({ side: 'business' }).querySelector('.nav-right .nav-cta').getAttribute('href'), '/business/#talk');
  const quote = doc({ side: 'business', quote: '#quote' });
  assert.equal(quote.querySelector('.nav-right .nav-quote').getAttribute('href'), '#quote');
  assert.equal(quote.querySelector('.nav-right .nav-cta'), null);
});

test('styles.css hides the other side\'s items and fills the chosen option', () => {
  assert.match(CSS, /html\[data-side="private"\] \[data-for="business"\],\s*html\[data-side="business"\] \[data-for="private"\] \{ display: none !important; \}/);
  assert.match(CSS, /html\[data-side="business"\] \.side-opt\[data-side="business"\]/);
});

const ROOT = path.join(__dirname, '..', '..');
const staticDoc = (rel) => new JSDOM(fs.readFileSync(path.join(ROOT, rel), 'utf8')).window.document;

test('a Dutch or German page\'s switch and logo stay in that language', () => {
  const nlTeam = staticDoc('nl/team/index.html');
  assert.equal(nlTeam.querySelector('.side-opt[data-side="private"]').getAttribute('href'), '/nl/');
  assert.equal(nlTeam.querySelector('.side-opt[data-side="business"]').getAttribute('href'), '/nl/business/');
  const deWebsites = staticDoc('de/websites/index.html');
  assert.equal(deWebsites.querySelector('#site-nav .brand').getAttribute('href'), '/de/business/');
  assert.equal(deWebsites.documentElement.getAttribute('data-page-side'), 'business');
});

test('the journal is shared: an article keeps the side its reader came from', () => {
  const article = staticDoc('journal/what-a-699-website-includes/index.html');
  assert.equal(article.documentElement.getAttribute('data-page-side'), null);
  assert.ok(article.querySelector('head script[src^="/assets/js/side.js"]'));
  assert.ok(article.querySelector('.nav-links > a[data-for="business"][href="/websites/"]'));
});

test('--nav-extra is exactly the height of the phone\'s switch row', () => {
  const block = CSS.slice(CSS.indexOf('@media (max-width: 999.98px) {\n  html[data-side]'));
  const extra = Number(/--nav-extra: (\d+)px/.exec(block)[1]);
  const row = /\.side-switch \{[^}]*height: (\d+)px; margin: 0 0 (\d+)px;/.exec(block);
  assert.equal(extra, Number(row[1]) + Number(row[2]));
});
