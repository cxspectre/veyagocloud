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
const FINANCE_HTML = fs.readFileSync(path.join(__dirname, '..', 'finance.html'), 'utf8');

/* A copy of finance.html's tab strip, not the real thing, so each test can
   start from a known hash. The guard tests at the bottom pin this copy to the
   real markup and the real markup to finance-tabs.js's TABS list. */
const PANEL_HTML =
  '<div class="adm-tabs" role="tablist">' +
    '<button class="adm-tab active" id="tab-overview" role="tab" aria-selected="true">Overview</button>' +
    '<button class="adm-tab" id="tab-transactions" role="tab" aria-selected="false" tabindex="-1">Transactions</button>' +
    '<button class="adm-tab" id="tab-invoices" role="tab" aria-selected="false" tabindex="-1">Invoices</button>' +
    '<button class="adm-tab" id="tab-budgets" role="tab" aria-selected="false" tabindex="-1">Budgets</button>' +
  '</div>' +
  '<section id="panel-overview">overview content</section>' +
  '<section id="panel-transactions" hidden>transactions content</section>' +
  '<section id="panel-invoices" hidden>invoices content</section>' +
  '<section id="panel-budgets" hidden>budgets content</section>';

/* Parse a chunk of markup the way a browser would. The guards at the bottom
   compare three copies of the tab strip, so they must read tab ids reliably —
   a tab this cannot understand throws, it never quietly vanishes from the
   list and shows up as "that tab does not exist". */
function parse(html) {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

function tabIdsIn(html) {
  return [...parse(html).querySelectorAll('button[role="tab"]')].map((button) => {
    const m = /^tab-(.+)$/.exec(button.id);
    if (!m) throw new Error('tab button without a tab-* id: ' + button.outerHTML);
    return m[1];
  });
}

/* The one list of tabs this file knows about. Every other list below derives
   from it, so a tab added to PANEL_HTML is covered everywhere at once. */
const FIXTURE_TABS = tabIdsIn(PANEL_HTML);

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
  return FIXTURE_TABS.filter((t) => !window.document.getElementById('panel-' + t).hidden);
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
  for (const hash of ['', ...FIXTURE_TABS.map((t) => '#' + t), '#garbage']) {
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
  assert.equal(w.location.hash, '#budgets');
});

test('Home and End jump to the first and last tab', () => {
  const w = mountAt('#transactions');
  const current = w.document.getElementById('tab-transactions');
  current.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(w.location.hash, '#budgets');

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

/* ── The tab strip exists in two places — finance-tabs.js's TABS and the
   buttons in finance.html — and PANEL_HTML above is a third. Budgets was
   added to the first two while the fixture stayed at three tabs, and the
   keyboard tests above quietly began asserting the wrong "last" tab. Pin the
   fixture to the real markup and the real markup to TABS, so the next added
   tab fails here, loudly. ─────────────────────────────────────────────── */

test('TABS in finance-tabs.js matches the tab buttons in finance.html, in order', () => {
  const w = mountAt('');
  // Array.from: TABS was built inside the jsdom realm, and a strict deep
  // comparison also checks prototypes, which differ across realms.
  assert.deepStrictEqual(Array.from(w.adminFinanceTabs.TABS), tabIdsIn(FINANCE_HTML));
});

test('this fixture carries every tab finance.html does', () => {
  assert.deepStrictEqual(FIXTURE_TABS, tabIdsIn(FINANCE_HTML));
});

test('every tab button in finance.html has the panel it controls', () => {
  const doc = parse(FINANCE_HTML);
  for (const t of tabIdsIn(FINANCE_HTML)) {
    assert.ok(doc.getElementById('panel-' + t), 'finance.html has no #panel-' + t + ' for #tab-' + t);
  }
});
