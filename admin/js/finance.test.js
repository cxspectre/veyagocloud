/* Tests for admin/js/finance.js — the two pieces of new logic from the visual
   overhaul: the Net-this-month card's sign-based color, and the chart's
   per-month net calculation (income minus expense, not grouped bars). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'finance.js'), 'utf8');

const FIXTURE = `<!doctype html><body>
  <p id="msg-overview"></p>
  <div id="fin-stats"></div>
  <div class="fin-chart" id="fin-chart"></div>
  <ul id="fin-accounts"></ul>
  <ul id="inv-summary"></ul>
  <ul id="tx-recent"></ul>
</body>`;

/* Same chainable fake as transactions.test.js — every filter/order method
   narrows or no-ops, resolves via `.then` like the real supabase-js builder. */
function fakeSb(tables) {
  function builder(table, rows) {
    return {
      select: () => builder(table, rows),
      eq: (col, val) => builder(table, rows.filter((r) => r[col] === val)),
      gte: (col, val) => builder(table, rows.filter((r) => r[col] >= val)),
      order: () => builder(table, rows),
      limit: (n) => builder(table, rows.slice(0, n)),
      then: (resolve) => resolve({ data: rows, error: null, count: rows.length }),
    };
  }
  return { from: (table) => builder(table, (tables[table] || []).slice()) };
}

/* A permissive stand-in for the real statCards, capturing what it was called
   with instead of rendering markup — these tests care about which color/value
   the logic computed, not the HTML it produces (that's covered by browser
   verification for this visual pass). */
function fakeAdmin() {
  var calls = [];
  return {
    calls: calls,
    admin: {
      statCards: (wrap, cards) => { calls.push(cards); wrap.innerHTML = ''; },
      toast: () => {},
      localDate: () => '2026-07-28',
    },
  };
}

function todayMinusDays(n) {
  const d = new Date('2026-07-28T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function mount(transactions) {
  const dom = new JSDOM(FIXTURE, {
    url: 'https://veyago.cloud/admin/finance',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const fake = fakeAdmin();

  window.adminRoles = { requireManager: async () => true };
  window.admin = fake.admin;
  window.sb = fakeSb({
    finance_accounts: [{ id: 'a1', name: 'Mercury Checking', kind: 'bank', provider: 'mercury', currency: 'USD', active: true, last_synced_at: null }],
    finance_categories: [],
    finance_transactions: transactions,
    finance_invoices: [],
  });
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });

  vm.runInContext(SRC, dom.getInternalVMContext());
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

  return {
    window,
    statCardCalls: fake.calls,
    chartHtml: window.document.getElementById('fin-chart').innerHTML,
    recentRows: [...window.document.querySelectorAll('#tx-recent > li')],
  };
}

function tx(id, daysAgo, amount) {
  return { id, account_id: 'a1', posted_at: todayMinusDays(daysAgo), created_at: todayMinusDays(daysAgo), amount, currency: 'USD', category_id: null, note: null, status: 'posted' };
}

/* ── Net-this-month card color ───────────────────────────────────────────
   Same test each round: statCardCalls[0] is renderStats' 4 cards, in order
   Income/Expenses/Net/Outstanding — Net is index 2. */

test('a profitable month colors Net success, not the fixed blue it used to be', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), tx(2, 3, -1000)]);
  const net = statCardCalls[0][2];
  assert.equal(net.label, 'Net this month');
  assert.equal(net.color, 'var(--ac-success)');
});

test('a losing month colors Net danger', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 1000), tx(2, 3, -5000)]);
  const net = statCardCalls[0][2];
  assert.equal(net.color, 'var(--ac-danger)');
});

test('an exact break-even keeps the neutral blue rather than forcing green or red', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 1000), tx(2, 3, -1000)]);
  const net = statCardCalls[0][2];
  assert.equal(net.color, 'var(--blue-2)');
});

/* ── Chart: net per month, not grouped income/expense bars ─────────────── */

test('the chart draws exactly one bar per month in the 6-month window, not paired income/expense bars', async () => {
  const { chartHtml } = await mount([tx(1, 2, 5000), tx(2, 40, -1000)]);
  const rectCount = (chartHtml.match(/<rect/g) || []).length;
  assert.equal(rectCount, 6, 'one net bar for each of the 6 months, never two per month');
});

/* Bars render oldest-to-newest left to right (renderChart's months array is
   built by counting DOWN from 5), so the CURRENT month is the LAST <rect> in
   the DOM, not the first — the first is 5 months back and has no activity in
   these fixtures. */
function lastRect(window) {
  const rects = [...window.document.querySelectorAll('#fin-chart svg rect')];
  return rects[rects.length - 1];
}

test('a profitable month bars upward from the baseline in the success color', async () => {
  const { window } = await mount([tx(1, 2, 8000), tx(2, 3, -2000)]);
  const rect = lastRect(window);
  assert.match(rect.getAttribute('style'), /fill:var\(--ac-success\)/);
  const mid = 100; // H=200, mid=100
  assert.ok(Number(rect.getAttribute('y')) < mid, 'a profit bar extends above the mid-height baseline, not below it');
});

test('a losing month bars downward from the baseline in the danger color', async () => {
  const { window } = await mount([tx(1, 2, 1000), tx(2, 3, -9000)]);
  const rect = lastRect(window);
  assert.match(rect.getAttribute('style'), /fill:var\(--ac-danger\)/);
  assert.equal(Number(rect.getAttribute('y')), 100, 'a loss bar starts exactly at the baseline and extends downward');
});

test('the accessible name describes a net chart, not "income and expenses"', async () => {
  const { window } = await mount([tx(1, 2, 100)]);
  const svg = window.document.querySelector('#fin-chart svg');
  assert.match(svg.getAttribute('aria-label'), /net/i);
});

test('axis labels are real HTML text, not SVG <text>, and there are six of them', async () => {
  const { window } = await mount([tx(1, 2, 100)]);
  assert.equal(window.document.querySelectorAll('#fin-chart svg text').length, 0,
    'labels must not live inside the scaled SVG viewBox');
  assert.equal(window.document.querySelectorAll('#fin-chart .fin-chart-labels span').length, 6);
});

test('a month with zero net activity still draws a visible sliver, not a zero-height bar', async () => {
  /* Only this month has any transaction — the other 5 months are genuinely
     empty, matching production's sparse-history chart. */
  const { window } = await mount([tx(1, 2, 500)]);
  const rects = [...window.document.querySelectorAll('#fin-chart svg rect')];
  assert.equal(rects.length, 6, 'one bar per month even when five are empty');
  const heights = rects.map((r) => Number(r.getAttribute('height')));
  assert.ok(heights.every((h) => h >= 2), 'every bar, including empty months, is at least the 2px visibility floor');
});

/* ── Recent activity rows: rebuilt on .adm-item ──────────────────────────
   Was a bespoke 4-column .fin-row, the only list on this tab not using the
   same row component as Accounts/Invoices-summary right next to it, and the
   only place still writing "Uncategorised" into a plain .fin-date-classed
   span rather than a badge. */

test('a row is a real .adm-item, not the old bespoke 4-column grid', async () => {
  const { recentRows } = await mount([tx(1, 1, 100)]);
  assert.equal(recentRows.length, 1);
  const link = recentRows[0].querySelector('a');
  assert.ok(link.classList.contains('adm-item'));
  assert.ok(link.classList.contains('adm-item--link'));
  assert.equal(recentRows[0].querySelector('.fin-row'), null, 'the old row class must be gone');
});

test('category renders as a badge, not a bare .fin-date-classed span', async () => {
  const { recentRows } = await mount([tx(1, 1, -50)]);
  const badge = recentRows[0].querySelector('.adm-item-acts .badge');
  assert.ok(badge, 'category must be a .badge inside the acts column');
  assert.equal(badge.textContent, 'Uncategorised');
  assert.ok(badge.classList.contains('badge-neutral'));
  assert.equal(recentRows[0].querySelector('.fin-date'), null,
    'category must no longer share a class with the date column that used to exist');
});

test('the row icon points in the direction of the transaction, colored to match', async () => {
  const { recentRows: income } = await mount([tx(1, 1, 500)]);
  assert.match(income[0].querySelector('.adm-item-icon svg').getAttribute('stroke'), /--ac-success/);

  const { recentRows: expense } = await mount([tx(1, 1, -500)]);
  assert.match(expense[0].querySelector('.adm-item-icon svg').getAttribute('stroke'), /--ac-danger/);
});

test('the sub-line folds the date in rather than using a separate column, and drops the year', async () => {
  const { recentRows } = await mount([tx(1, 1, 100)]);
  const sub = recentRows[0].querySelector('.adm-item-sub').textContent;
  assert.match(sub, /^[A-Z][a-z]{2} \d{1,2}/, 'starts "Jul 27"-style, no separate date column');
  assert.ok(!/20\d\d/.test(sub), 'no year — everything here is already within the 6-month window');
});

test('the amount still lives in .fin-amt inside the acts column, colored by sign', async () => {
  const { recentRows } = await mount([tx(1, 1, -75.5)]);
  const amt = recentRows[0].querySelector('.adm-item-acts .fin-amt');
  assert.ok(amt, 'amount must be inside adm-item-acts, matching renderInvoiceSummary\'s own pattern');
  assert.match(amt.style.color, /--fg-danger/);
});
