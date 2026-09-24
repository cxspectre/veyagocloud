/* Tests for the navigation logic in app.js: which link is marked as the
   current page. The old check compared the last path segment with hrefs like
   "/services/", which never matched under clean URLs, so the highlight had
   silently been dead since the site dropped .html. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');

const NAV = '<header class="nav" id="site-nav"><div class="wrap"><a class="brand" href="/">Veyago</a>' +
  '<nav class="nav-links"><a href="/apps/">Apps</a>' +
  '<div class="nav-item" id="business-nav"><button class="nav-drop-btn">Business</button>' +
  '<div class="nav-dropdown"><a href="/business/">All offers</a><a href="/websites/">Websites</a><a href="/cockpit/">Veyago Cockpit</a><a href="/services/">Product work</a></div></div>' +
  '<div class="nav-item" id="company-nav"><button class="nav-drop-btn">Company</button>' +
  '<div class="nav-dropdown"><a href="/company/">About</a><a href="/team/">Team</a></div></div></nav>' +
  '<div class="nav-right"><a class="nav-cta" href="mailto:x@y.z">Contact</a><button class="nav-toggle" id="nav-toggle"></button></div></div></header>' +
  '<div class="nav-scrim" id="nav-scrim"></div><aside class="nav-drawer" id="nav-drawer"><nav class="nav-drawer-links">' +
  '<a href="/apps/">Apps</a><a href="/services/">Services</a><a href="/websites/">Websites</a><a class="nm-sub" href="/team/">Team</a></nav></aside>' +
  '<main id="main"></main>';

function boot(pathname) {
  const dom = new JSDOM('<!doctype html><html lang="en"><head><title>T</title></head><body>' + NAV + '</body></html>',
    { url: 'https://www.veyago.cloud' + pathname, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  vm.runInContext(SRC, dom.getInternalVMContext());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return window.document;
}

const current = (doc) => [...doc.querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href'));

test('a clean URL marks its link in the row and in the drawer', () => {
  const doc = boot('/services/');
  assert.deepEqual(current(doc), ['/services/', '/services/']);
  assert.ok(doc.querySelector('.nav-links a[href="/services/"]').classList.contains('active'));
});

test('the same page without its trailing slash is still that page', () => {
  assert.deepEqual(current(boot('/services')), ['/services/', '/services/']);
});

test('a Dutch or German twin highlights the page it is a twin of', () => {
  assert.deepEqual(current(boot('/nl/websites/')), ['/websites/', '/websites/']);
  assert.deepEqual(current(boot('/de/websites/')), ['/websites/', '/websites/']);
});

test('a dropdown page lights its own link and the Company button', () => {
  const doc = boot('/team/');
  assert.deepEqual(current(doc), ['/team/', '/team/']);
  assert.ok(doc.querySelector('#company-nav .nav-drop-btn').classList.contains('active'));
  assert.ok(!doc.querySelector('#business-nav .nav-drop-btn').classList.contains('active'));
});

test('a business offer lights the Business button, not Company', () => {
  const doc = boot('/cockpit/');
  assert.deepEqual(current(doc), ['/cockpit/']);
  assert.ok(doc.querySelector('#business-nav .nav-drop-btn').classList.contains('active'));
  assert.ok(!doc.querySelector('#company-nav .nav-drop-btn').classList.contains('active'));
});

const isOpen = (doc, id) => doc.getElementById(id).classList.contains('open');
const click = (doc, el) => el.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));

test('each dropdown opens on click, and opening one closes the other', () => {
  const doc = boot('/');
  click(doc, doc.querySelector('#business-nav .nav-drop-btn'));
  assert.ok(isOpen(doc, 'business-nav'));
  assert.equal(doc.querySelector('#business-nav .nav-drop-btn').getAttribute('aria-expanded'), 'true');
  click(doc, doc.querySelector('#company-nav .nav-drop-btn'));
  assert.ok(isOpen(doc, 'company-nav'));
  assert.ok(!isOpen(doc, 'business-nav'));
  assert.equal(doc.querySelector('#business-nav .nav-drop-btn').getAttribute('aria-expanded'), 'false');
});

test('a click elsewhere or Escape closes an open dropdown', () => {
  const doc = boot('/');
  click(doc, doc.querySelector('#business-nav .nav-drop-btn'));
  click(doc, doc.getElementById('main'));
  assert.ok(!isOpen(doc, 'business-nav'));
  click(doc, doc.querySelector('#company-nav .nav-drop-btn'));
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(!isOpen(doc, 'company-nav'));
});

test('the home page and unknown pages mark nothing', () => {
  assert.deepEqual(current(boot('/')), []);
  assert.deepEqual(current(boot('/journal/some-article/')), []);
});
