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
const FIGURES = fs.readFileSync(path.join(__dirname, 'finance-figures.js'), 'utf8');

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
      range: (from, to) => builder(table, rows.slice(from, to + 1)),
      then: (resolve) => resolve({ data: rows, error: null, count: rows.length }),
    };
  }
  /* A table given as { error } answers every query with that error. */
  function failing(error) {
    const chain = {
      select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: () => chain, range: () => chain,
      then: (resolve) => resolve({ data: null, error }),
    };
    return chain;
  }
  return {
    /* A function the fixture answers, or one that is not there (PGRST202). */
    rpc: async (name) => ((tables.__rpc && tables.__rpc[name])
      || { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    from: (table) => (tables[table] && tables[table].error
      ? failing(tables[table].error)
      : builder(table, (tables[table] || []).slice())),
  };
}

/* What finance_figures (0041) answers for a transaction: the row with what it
   counts towards — by its sign, unless the fixture says otherwise. */
function countedBySign(t) {
  if (t.counts_as !== undefined) return t;
  const amount = Number(t.amount);
  return { ...t, counts_as: amount > 0 ? 'revenue' : amount < 0 ? 'expense' : null };
}

/* Every fixture date is relative to this one "today". finance.js reads the
   clock itself — new Date() and Date.now() — to decide what "this month" is,
   so the clock inside the jsdom window is frozen to the same instant (see
   freezeClock). Without that, these tests only passed during July 2026. */
const TODAY = '2026-07-28T12:00:00Z';

/* Same yyyy-mm-dd formula as admin.localDate() in client.js: local time, not
   UTC, so the fake localDate, the fixture dates and finance.js's own "this
   month" all agree on what day it is in every timezone. */
function localYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayMinusDays(n) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return localYmd(d);
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
      localDate: () => localYmd(new Date(TODAY)),
    },
  };
}

/* Pin the window's Date to TODAY. A bare `new Date()` or `Date.now()` returns
   the frozen instant; a Date built from explicit arguments is untouched, so
   finance.js's months-back arithmetic still works. jsdom gives each window its
   own realm, which is why node:test's mock.timers on this file's own Date
   would never reach the code under test. */
function freezeClock(window, iso) {
  const RealDate = window.Date;
  const fixed = new RealDate(iso).getTime();
  function FrozenDate() {
    if (!new.target) return new RealDate(fixed).toString();
    return arguments.length === 0 ? new RealDate(fixed) : new RealDate(...arguments);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = () => fixed;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;
}

async function mount(transactions, options = {}) {
  const dom = new JSDOM(FIXTURE, {
    url: 'https://veyago.cloud/admin/finance',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const fake = fakeAdmin();
  freezeClock(window, TODAY);

  window.adminRoles = { requireManager: async () => true };
  window.admin = fake.admin;
  window.sb = fakeSb({
    finance_accounts: options.accounts || [{ id: 'a1', name: 'Mercury Checking', kind: 'bank', provider: 'mercury', currency: 'USD', active: true, last_synced_at: null }],
    __rpc: options.rpc || null,
    finance_categories: [],
    finance_transactions: transactions,
    finance_figures: options.figures || transactions.map(countedBySign),
    finance_invoices: [],
  });
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });

  vm.runInContext(FIGURES, dom.getInternalVMContext());
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

/* ── What counts: by what each transaction is (finance_figures, 0041) ──── */

test('Income and Expenses count by what each transaction is: a row the view counts as neither is left out of both', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), tx(2, 3, -1000), { ...tx(3, 2, 870), counts_as: null }, { ...tx(4, 2, -2000), counts_as: null }]);
  const [income, expenses, net] = statCardCalls[0];
  assert.equal(income.n, '$5,000.00');
  assert.equal(expenses.n, '$1,000.00');
  assert.equal(net.n, '$4,000.00');
});

test('another currency is named under the month\'s figures, never added into them', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), { ...tx(2, 2, 900), currency: 'EUR' }]);
  const [income, , net] = statCardCalls[0];
  assert.equal(income.n, '$5,000.00');
  assert.equal(income.n2, 'also EUR');
  assert.equal(net.n2, 'also EUR');
});

test('the month is counted in the studio\'s currency, as the workspace shows it, not the first account\'s', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), { ...tx(2, 2, 900), currency: 'EUR' }], {
    accounts: [{ id: 'a0', name: 'A euro account', kind: 'bank', provider: 'mercury', currency: 'EUR', active: true, last_synced_at: null }],
    rpc: { studio_currency: { data: 'USD', error: null } },
  });
  const [income] = statCardCalls[0];
  assert.equal(income.n, '$5,000.00');
  assert.equal(income.n2, 'also EUR');
});

test('a currency anyone typed is escaped where the figures name it', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), { ...tx(2, 2, 900), currency: '<img src=x onerror=alert(1)>' }]);
  const [income] = statCardCalls[0];
  assert.doesNotMatch(income.n2, /<img/i, 'statCards puts n2 into the page as it is given');
  assert.equal(income.n2, 'also &lt;IMG SRC=X ONERROR=ALERT(1)&gt;');
});

test('before 0041 the ledger is read by its sign, as it was', async () => {
  const { statCardCalls } = await mount([tx(1, 2, 5000), tx(2, 3, -1000)],
    { figures: { error: { code: 'PGRST205', message: 'Could not find the table public.finance_figures' } } });
  const [income, expenses] = statCardCalls[0];
  assert.equal(income.n, '$5,000.00');
  assert.equal(expenses.n, '$1,000.00');
});

test('any other error says the overview could not load, rather than showing zeros', async () => {
  const { window, statCardCalls } = await mount([tx(1, 2, 5000)], { figures: { error: { code: '42501', message: 'permission denied' } } });
  assert.equal(statCardCalls.length, 0);
  assert.match(window.document.getElementById('msg-overview').textContent, /Could not load overview: permission denied/);
});

test('the chart nets each month by what its transactions are', async () => {
  const { window } = await mount([tx(1, 2, 1000), { ...tx(2, 3, 9000), counts_as: null }, tx(3, 3, -3000)]);
  assert.match(lastRect(window).getAttribute('style'), /fill:var\(--ac-danger\)/,
    'a payout of 9,000 into the bank does not turn a losing month into a profit');
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
