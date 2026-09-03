/* Tests for admin/js/invoices.js — the visual-overhaul changes: the invoice
   amount moved out of the muted .adm-item-sub caption into its own .fin-amt
   slot in acts, and the stat cards now lead with dollar amounts instead of
   plain invoice counts. invoices.js had no test file before this pass. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'invoices.js'), 'utf8');

const FIXTURE = `<!doctype html><body>
  <p id="msg-invoices"></p>
  <div id="inv-stats"></div>
  <select id="f-status">
    <option value="open" selected>Open</option>
    <option value="all">All</option>
    <option value="draft">Draft</option>
    <option value="sent">Sent</option>
    <option value="overdue">Overdue</option>
    <option value="paid">Paid</option>
  </select>
  <span id="inv-count"></span>
  <ul id="inv-list"></ul>
  <button id="inv-jump"></button>
  <input id="i-client" /><input id="i-number" /><input id="i-amount" />
  <span id="i-currency"></span>
  <input id="i-issued" /><input id="i-due" /><textarea id="i-notes"></textarea>
  <button id="i-add-btn"></button>
  <span id="i-msg"></span>
</body>`;

function fakeSb(tables) {
  function builder(table, rows) {
    return {
      select: () => builder(table, rows),
      eq: (col, val) => builder(table, rows.filter((r) => r[col] === val)),
      order: () => builder(table, rows),
      limit: (n) => builder(table, rows.slice(0, n)),
      then: (resolve) => resolve({ data: rows, error: null, count: rows.length }),
    };
  }
  return { from: (table) => builder(table, (tables[table] || []).slice()) };
}

/* The one "today" every fixture date is written against. Most of invoices.js
   asks admin.localDate() for the date, which fakeAdmin below answers, but
   "Paid this month" compares paid_on to the window's own clock — so that
   clock is frozen to the same instant (see freezeClock). Without it the
   paid-this-month test only passed during July 2026. */
const TODAY = '2026-07-28T12:00:00Z';

/* Same yyyy-mm-dd formula as admin.localDate() in client.js: local time, not
   UTC, so the fake and the frozen clock agree on the date in every timezone. */
function localYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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
   the frozen instant; a Date built from explicit arguments is untouched. jsdom
   gives each window its own realm, which is why node:test's mock.timers on
   this file's own Date would never reach the code under test. */
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

async function mount(invoices, statusFilter) {
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
  window.sb = fakeSb({ finance_accounts: [], finance_invoices: invoices });
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });
  /* jsdom has no matchMedia; invoices.js calls it at module-load time for the
     NARROW breakpoint that decides row layout below 620px. */
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, addListener: () => {} });

  if (statusFilter) window.document.getElementById('f-status').value = statusFilter;

  vm.runInContext(SRC, dom.getInternalVMContext());
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

  return {
    window,
    statCardCalls: fake.calls,
    rows: [...window.document.querySelectorAll('#inv-list li.adm-item')],
  };
}

function inv(id, over) {
  return Object.assign({
    id, number: '2026-0' + id, client: 'Acme ' + id, amount: 1000 + id,
    currency: 'USD', status: 'sent', issued_on: '2026-06-01', due_on: '2026-08-01',
    paid_on: null, notes: null,
  }, over);
}

/* ── Amount moved out of the sub-line ─────────────────────────────────── */

test('the amount lives in its own .fin-amt slot in acts, not the muted sub-line', async () => {
  const { rows } = await mount([inv(1, { status: 'sent', due_on: '2026-08-15' })], 'all');
  const amt = rows[0].querySelector('.adm-item-acts .fin-amt');
  assert.ok(amt, 'amount must be inside adm-item-acts');
  assert.equal(amt.textContent, '$1,001.00');
  assert.equal(amt.style.color, 'var(--ink)', 'neutral — an invoice has no income/expense direction');
  const sub = rows[0].querySelector('.adm-item-sub');
  assert.ok(!sub.textContent.includes('$'), 'the amount must no longer appear in the sub-line at all');
});

test('a paid invoice with no due date shows a clean sub-line, not a leading separator', async () => {
  /* This is the exact case the amount-removal exposed: the amount used to
     always occupy the first slot, so due/paid/notes could safely be prefixed
     with " · " unconditionally. With it gone, due_on absent + paid_on present
     would render " · paid …" with a stray leading separator unless the join
     logic was rebuilt properly. */
  const { rows } = await mount([inv(1, { status: 'paid', due_on: null, paid_on: '2026-07-20' })], 'all');
  const sub = rows[0].querySelector('.adm-item-sub').innerHTML;
  assert.equal(sub, 'paid 2026-07-20');
  assert.ok(!sub.startsWith(' ') && !sub.startsWith('·'), 'no leading separator');
});

test('due, paid and notes join cleanly with no double separator when all three are present', async () => {
  const { rows } = await mount([inv(1, {
    status: 'paid', due_on: '2026-07-01', paid_on: '2026-07-05', notes: 'thanks',
  })], 'all');
  const sub = rows[0].querySelector('.adm-item-sub').innerHTML;
  assert.equal(sub, 'due 2026-07-01 · paid 2026-07-05 · 📝');
});

test('an overdue invoice still gets the due-over span around its due date', async () => {
  const { rows } = await mount([inv(1, { status: 'sent', due_on: '2026-01-01' })], 'all'); // long past due
  const sub = rows[0].querySelector('.adm-item-sub');
  assert.ok(sub.querySelector('.due-over'), 'overdue due date keeps its distinct styling hook');
});

/* ── Stat cards lead with dollar amounts ─────────────────────────────────
   statCardCalls[0] is renderStats' 4 cards, in order Draft/Sent/Overdue/Paid. */

test('Draft stays a plain count — nothing has been billed yet, there is no amount', async () => {
  const { statCardCalls } = await mount([inv(1, { status: 'draft' }), inv(2, { status: 'draft' })]);
  const draft = statCardCalls[0][0];
  assert.equal(draft.label, 'Draft');
  assert.equal(draft.n, 2, 'still the raw count, not a formatted string');
});

test('Sent leads with the dollar amount, count moves to the subtext', async () => {
  const { statCardCalls } = await mount([inv(1, { status: 'sent', amount: 500 }), inv(2, { status: 'sent', amount: 700 })]);
  const sent = statCardCalls[0][1];
  assert.equal(sent.label, 'Sent');
  assert.equal(sent.n, '$1,200.00');
  assert.match(sent.n2, /2 invoices awaiting payment/);
});

test('Overdue leads with the dollar amount AND carries nColor so the urgency signal survives the swap', async () => {
  const { statCardCalls } = await mount([inv(1, { status: 'sent', due_on: '2026-01-01', amount: 900 })]);
  const overdue = statCardCalls[0][2];
  assert.equal(overdue.label, 'Overdue');
  assert.equal(overdue.n, '$900.00');
  assert.equal(overdue.nColor, 'var(--fg-danger)');
  assert.match(overdue.n2, /1 invoice past due/);
});

test('nothing overdue means no red anywhere, singular/plural still correct in the empty case', async () => {
  const { statCardCalls } = await mount([inv(1, { status: 'sent', due_on: '2026-12-01' })]);
  const overdue = statCardCalls[0][2];
  assert.equal(overdue.n, '$0.00');
  assert.equal(overdue.nColor, null);
  assert.equal(overdue.n2, 'nothing late');
});

test('Paid this month leads with the dollar amount collected', async () => {
  const { statCardCalls } = await mount([
    inv(1, { status: 'paid', paid_on: '2026-07-10', amount: 300 }),
  ]);
  const paid = statCardCalls[0][3];
  assert.equal(paid.label, 'Paid this month');
  assert.equal(paid.n, '$300.00');
  assert.match(paid.n2, /1 invoice collected/);
});
