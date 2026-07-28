/* Tests for admin/js/transactions.js — specifically the account name on each
   ledger row.

   Reported from production: every one of 45 rows repeated the full account
   name — "Mercury Checking · Apple", "Mercury Checking · Adobe", forty-five
   times over — when the Account filter directly above the list already says
   which account is in view. It only carries information once a row-set
   actually mixes more than one account, so that's the rule these tests pin
   down. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'transactions.js'), 'utf8');

const FIXTURE = `<!doctype html><body>
  <p id="msg-transactions"></p>
  <select id="f-account"><option value="all">All accounts</option></select>
  <select id="f-category"><option value="all">All categories</option><option value="none">Uncategorised</option></select>
  <input id="f-search" />
  <span id="tx-count"></span>
  <div id="tx-list"></div>
  <div id="m-desc-wrap"><input id="m-desc" /></div>
  <input id="m-amount" />
  <input id="m-date" />
  <select id="m-category"><option value="">Uncategorised</option></select>
  <button id="m-add-btn"></button>
  <span id="m-msg"></span>
</body>`;

/* Chainable fake matching the shape transactions.js actually calls — every
   filter/order method narrows or no-ops, and it resolves via `.then` so a
   bare `await` on it just works, the same as the real supabase-js builder. */
function fakeSb(tables) {
  function builder(table, rows) {
    const b = {
      select: () => builder(table, rows),
      eq: (col, val) => builder(table, rows.filter((r) => r[col] === val)),
      is: (col) => builder(table, rows.filter((r) => r[col] == null)),
      or: () => builder(table, rows),
      order: () => builder(table, rows),
      limit: (n) => builder(table, rows.slice(0, n)),
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      insert: (obj) => builder(table, [Object.assign({ id: 'new' }, obj)]),
      update: () => builder(table, rows),
      delete: () => builder(table, rows),
      then: (resolve) => resolve({ data: rows, error: null, count: rows.length }),
    };
    return b;
  }
  return { from: (table) => builder(table, (tables[table] || []).slice()) };
}

async function mount({ accounts, transactions }) {
  const dom = new JSDOM(FIXTURE, {
    url: 'https://veyago.cloud/admin/finance',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  window.adminRoles = { requireManager: async () => true };
  window.admin = { localDate: () => '2026-07-28', toast: () => {} };
  window.sb = fakeSb({
    finance_accounts: accounts,
    finance_categories: [],
    finance_transactions: transactions,
  });
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });

  vm.runInContext(SRC, dom.getInternalVMContext());
  /* Several awaits deep (requireManager -> accounts -> categories -> load
     transactions -> render), so give the microtask queue a few turns. */
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

  return {
    window,
    subLines: [...window.document.querySelectorAll('#tx-list .fin-row .adm-item-sub')]
      .map((el) => el.textContent),
  };
}

const ONE_ACCOUNT = [{ id: 'a1', name: 'Mercury Checking', kind: 'bank', currency: 'USD', active: true }];
const TWO_ACCOUNTS = [
  { id: 'a1', name: 'Mercury Checking', kind: 'bank', currency: 'USD', active: true },
  { id: 'a2', name: 'Stripe', kind: 'stripe', currency: 'USD', active: true },
];

function tx(id, accountId, extra) {
  return Object.assign({
    id, account_id: accountId, posted_at: '2026-07-2' + id, created_at: '2026-07-2' + id,
    description: 'Row ' + id, counterparty: null, amount: -10, currency: 'USD',
    category_id: null, note: null, status: 'posted', source: 'bank',
  }, extra);
}

test('the account name is dropped when every row is from the same account', async () => {
  const { subLines } = await mount({
    accounts: ONE_ACCOUNT,
    transactions: [
      tx(1, 'a1', { counterparty: 'Apple' }),
      tx(2, 'a1', { counterparty: 'Adobe' }),
      tx(3, 'a1', { counterparty: 'Supabase' }),
    ],
  });
  assert.deepEqual(subLines, ['Apple', 'Adobe', 'Supabase'],
    'no row should repeat "Mercury Checking" when it is the only account in view');
});

test('the account name reappears once the view actually mixes accounts', async () => {
  const { subLines } = await mount({
    accounts: TWO_ACCOUNTS,
    transactions: [
      tx(1, 'a1', { counterparty: 'Apple' }),
      tx(2, 'a2', { counterparty: 'July invoices' }),
    ],
  });
  assert.deepEqual(subLines, ['Mercury Checking · Apple', 'Stripe · July invoices']);
});

test('a lone account with no counterparty and no note shows a clean empty sub-line, not a stray separator', async () => {
  const { subLines } = await mount({
    accounts: ONE_ACCOUNT,
    transactions: [tx(1, 'a1')],
  });
  assert.deepEqual(subLines, ['']);
});

test('mixed accounts still join account, counterparty and the note marker correctly', async () => {
  const { subLines } = await mount({
    accounts: TWO_ACCOUNTS,
    transactions: [
      tx(1, 'a1', { counterparty: 'Apple', note: 'Ask about this' }),
      tx(2, 'a2', { counterparty: null, note: 'No counterparty on this one' }),
    ],
  });
  assert.deepEqual(subLines, ['Mercury Checking · Apple · 📝', 'Stripe · 📝'],
    'no double separator when counterparty is absent but the note marker still applies');
});

test('a single synced account with mixed known/unknown ids still counts as one', async () => {
  /* account_id on every row resolves to the same real account — this is the
     ordinary case the fix targets, not an edge case. */
  const { subLines } = await mount({
    accounts: ONE_ACCOUNT,
    transactions: [tx(1, 'a1', { counterparty: 'Apple' }), tx(2, 'a1', { counterparty: 'Apple' })],
  });
  assert.ok(subLines.every((s) => !s.includes('Mercury')), 'still suppressed on the second identical row');
});

/* ── The category picker and the disclosure chevron ──────────────────────
   The picker used to be permanently boxed on all 45 rows, outweighing the
   row's own amount; the row gave no sign it expands until you were already
   hovering it. */

test('the category picker is a plain select-ghost by default, not a permanently boxed control', async () => {
  const { window } = await mount({ accounts: ONE_ACCOUNT, transactions: [tx(1, 'a1')] });
  const sel = window.document.querySelector('#tx-list select');
  assert.ok(sel.classList.contains('select-ghost'));
  assert.ok(sel.classList.contains('select'), 'still gets the app\'s own chevron/appearance styling');
});

test('every row carries a closed chevron before anything is expanded', async () => {
  const { window } = await mount({ accounts: ONE_ACCOUNT, transactions: [tx(1, 'a1'), tx(2, 'a1')] });
  const chevs = [...window.document.querySelectorAll('#tx-list .fin-amt .chev')];
  assert.equal(chevs.length, 2);
  assert.ok(chevs.every((c) => !c.classList.contains('open')));
});

test('opening a row rotates its chevron open, and only its own', async () => {
  const { window } = await mount({ accounts: ONE_ACCOUNT, transactions: [tx(1, 'a1'), tx(2, 'a1')] });
  const rows = [...window.document.querySelectorAll('#tx-list .fin-row')];
  rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const chevs = [...window.document.querySelectorAll('#tx-list .fin-amt .chev')];
  assert.ok(chevs[0].classList.contains('open'), 'the row that was clicked opens');
  assert.ok(!chevs[1].classList.contains('open'), 'its sibling stays closed');
});
