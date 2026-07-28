/* Tests for admin/js/finance-tabs.js.

   member.js has run the same hash-routed tab pattern in production for a
   while with no test of its own — this file exists so the SECOND copy of that
   pattern (not a shared one; see finance-tabs.js's header for why the two stay
   separate) does not repeat that gap. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'finance-tabs.js'), 'utf8');

const PANEL_HTML =
  '<div class="adm-tabs" role="tablist">' +
    '<button class="adm-tab active" id="tab-overview" role="tab" aria-selected="true">Overview</button>' +
    '<button class="adm-tab" id="tab-transactions" role="tab" aria-selected="false" tabindex="-1">Transactions</button>' +
    '<button class="adm-tab" id="tab-invoices" role="tab" aria-selected="false" tabindex="-1">Invoices</button>' +
  '</div>' +
  '<section id="panel-overview">overview content</section>' +
  '<section id="panel-transactions" hidden>transactions content</section>' +
  '<section id="panel-invoices" hidden>invoices content</section>';

function mountAt(hash) {
  const dom = new JSDOM('<!doctype html><body>' + PANEL_HTML + '</body>', {
    url: 'https://veyago.cloud/admin/finance' + (hash || ''),
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  vm.runInContext(SRC, dom.getInternalVMContext());
  return dom.window;
}

function visiblePanels(window) {
  return ['overview', 'transactions', 'invoices']
    .filter((t) => !window.document.getElementById('panel-' + t).hidden);
}

/* jsdom dispatches 'hashchange' asynchronously, same as a real browser — a
   direct hash assignment or a click that sets one needs a tick before its
   effect is observable. Same convention as nav.test.js's drawer/hashchange
   tests. */
function tick(window) {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/* ── Initial state ────────────────────────────────────────────────────── */

test('defaults to overview with no hash', () => {
  const w = mountAt('');
  assert.equal(w.adminFinanceTabs.currentTab(), 'overview');
  assert.deepEqual(visiblePanels(w), ['overview']);
});

test('an unrecognised hash also falls back to overview', () => {
  const w = mountAt('#not-a-real-tab');
  assert.equal(w.adminFinanceTabs.currentTab(), 'overview');
  assert.deepEqual(visiblePanels(w), ['overview']);
});

test('loading straight into a hash shows that tab from the start', () => {
  const w = mountAt('#invoices');
  assert.deepEqual(visiblePanels(w), ['invoices']);
  assert.equal(w.document.getElementById('tab-invoices').getAttribute('aria-selected'), 'true');
  assert.equal(w.document.getElementById('tab-overview').getAttribute('aria-selected'), 'false');
});

/* ── Exactly one visible, always ─────────────────────────────────────── */

test('exactly one panel is ever visible', () => {
  for (const hash of ['', '#overview', '#transactions', '#invoices', '#garbage']) {
    assert.equal(visiblePanels(mountAt(hash)).length, 1, hash);
  }
});

/* ── Clicking ─────────────────────────────────────────────────────────── */

test('clicking a tab navigates the hash and switches the panel', async () => {
  const w = mountAt('');
  w.document.getElementById('tab-transactions').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.location.hash, '#transactions');
  await tick(w);
  assert.deepEqual(visiblePanels(w), ['transactions']);
});

test('clicking the already-active tab is a no-op that still shows it', () => {
  const w = mountAt('#invoices');
  const before = w.location.hash;
  w.document.getElementById('tab-invoices').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.location.hash, before);
  assert.deepEqual(visiblePanels(w), ['invoices']);
});

test('switching tabs updates aria-selected and tabindex on both the old and new tab', async () => {
  const w = mountAt('');
  w.document.getElementById('tab-invoices').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(w);

  const nowActive = w.document.getElementById('tab-invoices');
  const nowInactive = w.document.getElementById('tab-overview');
  assert.equal(nowActive.getAttribute('aria-selected'), 'true');
  assert.equal(nowActive.tabIndex, 0);
  assert.ok(nowActive.classList.contains('active'));
  assert.equal(nowInactive.getAttribute('aria-selected'), 'false');
  assert.equal(nowInactive.tabIndex, -1);
  assert.ok(!nowInactive.classList.contains('active'));
});

/* ── Anything else that changes the hash — back/forward, an in-panel
   "Manage invoices →" link — must move the tab too, not just a click. ──── */

test('a hashchange from something other than a tab click still switches the panel', async () => {
  const w = mountAt('');
  w.location.hash = 'invoices';
  await tick(w);
  assert.deepEqual(visiblePanels(w), ['invoices'], 'assigning the hash directly must react the same as a click');
});

/* ── Keyboard navigation ──────────────────────────────────────────────── */

test('ArrowRight moves to the next tab, focuses it, and shows its panel', async () => {
  const w = mountAt('');
  const overview = w.document.getElementById('tab-overview');
  overview.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(w.location.hash, '#transactions');
  assert.equal(w.document.activeElement.id, 'tab-transactions');
  await tick(w);
  assert.deepEqual(visiblePanels(w), ['transactions']);
});

test('ArrowLeft wraps from the first tab to the last', () => {
  const w = mountAt('');
  const overview = w.document.getElementById('tab-overview');
  overview.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(w.location.hash, '#invoices');
});

test('Home and End jump to the first and last tab', () => {
  const w = mountAt('#transactions');
  const current = w.document.getElementById('tab-transactions');
  current.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(w.location.hash, '#invoices');

  current.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  assert.equal(w.location.hash, '#overview');
});

test('an unrelated key does nothing', () => {
  const w = mountAt('');
  const overview = w.document.getElementById('tab-overview');
  const ev = new w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
  overview.dispatchEvent(ev);
  assert.equal(w.location.hash, '');
  assert.equal(ev.defaultPrevented, false);
});
