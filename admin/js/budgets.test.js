/* Tests for admin/js/budgets.js — the Budgets tab on /admin/finance.

   finance_transactions has no `category` column. A transaction points at a
   finance_categories row through category_id (0005), and the syncs never set
   even that. The tab asked for `category` all the same: PostgREST refused both
   of its transaction queries, the refusals were dropped, and every budget read
   $0 spent, with no suggestions and nothing on screen to say why.

   The stand-in database knows each table's real columns and refuses any other
   the way PostgREST does, so reading a column that does not exist fails here
   the way it failed in production. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'budgets.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'finance.html'), 'utf8');

/* Mounted against the real page markup — see invoice-new.test.js. */
function bodyOf(html) {
  return html.replace(/[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

/* Every column of each table the tab reads, from 0005 and 0018. */
const COLUMNS = {
  finance_budgets: ['id', 'category', 'amount', 'period', 'created_at', 'updated_at'],
  finance_categories: ['id', 'name', 'kind', 'sort_order'],
  finance_transactions: ['id', 'account_id', 'external_id', 'posted_at', 'description', 'counterparty',
    'amount', 'currency', 'category_id', 'status', 'source', 'note', 'created_at'],
};

/* A chainable query over `tables`, resolving via `.then` like supabase-js.
   `failures[table]` makes every query on that table return that error.
   `maxRows` is PostgREST's max-rows setting: no response carries more rows
   than that, whatever .limit() or .range() asks for, while
   select(…, { count: 'exact' }) still reports every row that matched. */
function fakeSb(tables, failures = {}, maxRows = Infinity) {
  const refused = [];

  function refuse(table, col) {
    const message = `column ${table}.${col} does not exist`;
    refused.push(message);
    return { code: '42703', message };
  }

  /* `page` is { count, from, to }: what the response will count and cut. */
  function builder(table, rows, error, page) {
    const next = (r, e, p) => builder(table, r, e, p || page);
    const known = (col) => COLUMNS[table].includes(col);
    const narrow = (col, keep) => {
      if (error) return next(rows, error);
      if (!known(col)) return next(rows, refuse(table, col));
      return next(rows.filter(keep), null);
    };
    return {
      select: (cols, opts) => {
        const counted = Object.assign({}, page, { count: !!(opts && opts.count) });
        if (error) return next(rows, error, counted);
        const unknown = String(cols || '*').split(',').map((c) => c.trim()).find((c) => c !== '*' && !known(c));
        return next(rows, unknown ? refuse(table, unknown) : null, counted);
      },
      eq: (col, val) => narrow(col, (r) => r[col] === val),
      gte: (col, val) => narrow(col, (r) => r[col] >= val),
      lt: (col, val) => narrow(col, (r) => r[col] < val),
      is: (col, val) => narrow(col, (r) => (val === null ? r[col] == null : r[col] === val)),
      not: (col, op, val) => narrow(col, (r) => !(op === 'is' && val === null ? r[col] == null : r[col] === val)),
      order: (col, opts) => {
        const dir = opts && opts.ascending === false ? -1 : 1;
        return narrow(col, () => true).sorted(col, dir);
      },
      sorted: (col, dir) => next(rows.slice().sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0)), error),
      limit: (n) => next(rows, error, Object.assign({}, page, { to: (page.from || 0) + n - 1 })),
      range: (from, to) => next(rows, error, Object.assign({}, page, { from, to })),
      then: (resolve, reject) => {
        if (error) return Promise.resolve({ data: null, error, count: null }).then(resolve, reject);
        const from = page.from || 0;
        const to = page.to == null ? rows.length - 1 : page.to;
        const data = rows.slice(from, Math.min(to + 1, from + maxRows));
        return Promise.resolve({ data, error: null, count: page.count ? rows.length : null }).then(resolve, reject);
      },
    };
  }

  return {
    refused,
    from: (table) => builder(table, (tables[table] || []).slice(), failures[table] ? { message: failures[table] } : null, {}),
  };
}

const TODAY = '2026-09-14';

async function mount({ budgets = [], categories = [], transactions = [], failures, maxRows } = {}) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/finance#budgets',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const sb = fakeSb({
    finance_budgets: budgets,
    finance_categories: categories,
    finance_transactions: transactions,
  }, failures, maxRows);

  window.sb = sb;
  window.adminRoles = { isManager: async () => true };
  window.admin = { localDate: () => TODAY, toast: () => {} };
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });

  vm.runInContext(SRC, dom.getInternalVMContext());
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

  const $ = (id) => window.document.getElementById(id);
  return {
    window, $,
    refused: sb.refused,
    rows: () => [...window.document.querySelectorAll('#budget-list > li.adm-item')].map((li) => ({
      name: li.querySelector('.adm-item-title').textContent,
      spent: li.querySelector('.adm-item-sub').textContent.replace(/\s+/g, ' ').trim(),
    })),
    suggestions: () => [...window.document.querySelectorAll('#b-category-list option')].map((o) => o.value),
    note: () => ($('budget-uncategorised') ? $('budget-uncategorised').textContent : null),
    message: () => $('msg-budgets'),
  };
}

const MARKETING = { id: 'c-mkt', name: 'Marketing', kind: 'expense', sort_order: 60 };
const SOFTWARE = { id: 'c-sw', name: 'Software & tools', kind: 'expense', sort_order: 30 };
const SALES = { id: 'c-sales', name: 'Sales', kind: 'income', sort_order: 10 };

function budget(id, category, amount) {
  return { id, category, amount, period: 'monthly', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };
}

let serial = 0;
function tx(postedAt, amount, categoryId) {
  serial += 1;
  return {
    id: 'tx' + serial, account_id: 'a1', external_id: 'm' + serial, posted_at: postedAt,
    description: 'Row ' + serial, counterparty: null, amount, currency: 'USD',
    category_id: categoryId, status: 'posted', source: 'mercury', note: null,
    created_at: postedAt + 'T12:00:00Z',
  };
}

/* ── Spending against budgets ─────────────────────────────────────────── */

test('this month\'s spending counts against the budget for the category it is filed under', async () => {
  const h = await mount({
    categories: [SALES, SOFTWARE, MARKETING],
    budgets: [budget('b1', 'Marketing', 500), budget('b2', 'Software & tools', 200)],
    transactions: [
      tx('2026-09-02', -120, 'c-mkt'),
      tx('2026-09-10', -30, 'c-mkt'),
      tx('2026-08-28', -999, 'c-mkt'),  // last month
      tx('2026-09-11', 400, 'c-mkt'),   // money in, not spending
      tx('2026-09-12', -45, 'c-sw'),
    ],
  });

  assert.deepEqual(h.rows(), [
    { name: 'Marketing', spent: '$150 of $500' },
    { name: 'Software & tools', spent: '$45 of $200' },
  ]);
  assert.equal(h.message().textContent, '');
});

test('nothing is read from a column the tables do not have', async () => {
  const h = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', 'Marketing', 500)],
    transactions: [tx('2026-09-02', -120, 'c-mkt')],
  });
  assert.deepEqual(h.refused, []);
});

test('a budget finds its category whatever case or spacing it was typed with', async () => {
  const h = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', ' marketing ', 500)],
    transactions: [tx('2026-09-02', -150, 'c-mkt')],
  });
  assert.deepEqual(h.rows(), [{ name: ' marketing ', spent: '$150 of $500' }]);
});

/* ── With no categories ───────────────────────────────────────────────── */

test('with no categories at all, budgets still list and uncategorised spending counts under Uncategorised', async () => {
  const h = await mount({
    categories: [],
    budgets: [budget('b1', 'Marketing', 500), budget('b2', 'Uncategorised', 1000)],
    transactions: [tx('2026-09-02', -200, null), tx('2026-09-03', -100, null)],
  });

  assert.deepEqual(h.rows(), [
    { name: 'Marketing', spent: '$0 of $500' },
    { name: 'Uncategorised', spent: '$300 of $1,000' },
  ]);
  assert.deepEqual(h.suggestions(), ['Uncategorised'], 'the one budget that can count anything yet');
  assert.equal(h.message().textContent, '');
  assert.equal(h.note(), null, 'an Uncategorised budget already counts it');
});

test('a budget spelled Uncategorized counts the same spending', async () => {
  const h = await mount({
    budgets: [budget('b1', 'Uncategorized', 1000)],
    transactions: [tx('2026-09-02', -300, null)],
  });
  assert.deepEqual(h.rows(), [{ name: 'Uncategorized', spent: '$300 of $1,000' }]);
  assert.equal(h.note(), null);
});

test('spending no budget counts is called out rather than silently left off the page', async () => {
  const h = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', 'Marketing', 500)],
    transactions: [tx('2026-09-02', -150, 'c-mkt'), tx('2026-09-03', -300, null)],
  });
  assert.match(h.note() || '', /\$300/);
  assert.match(h.note() || '', /no category/i);

  const tidy = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', 'Marketing', 500)],
    transactions: [tx('2026-09-02', -150, 'c-mkt')],
  });
  assert.equal(tidy.note(), null, 'no note when everything is filed');
});

test('the suggestions are the expense categories in their set order, then Uncategorised', async () => {
  const h = await mount({ categories: [MARKETING, SALES, SOFTWARE], budgets: [budget('b1', 'Marketing', 500)] });
  assert.deepEqual(h.suggestions(), ['Software & tools', 'Marketing', 'Uncategorised']);
});

test('a category already called Uncategorised is not suggested twice', async () => {
  const h = await mount({ categories: [{ id: 'c-u', name: 'uncategorised', kind: 'expense', sort_order: 90 }] });
  assert.deepEqual(h.suggestions(), ['uncategorised']);
});

/* ── A busy month ─────────────────────────────────────────────────────── */

function busyMonth(count, amount, categoryId) {
  return Array.from({ length: count }, () => tx('2026-09-05', amount, categoryId));
}

test('a month with more spending than one response holds is counted in full', async () => {
  /* Supabase answers at most 1000 rows a request unless that is raised,
     whatever .limit() asks for. The tab asked for 5000 and summed whatever
     came back, so a busy month read low without a word. */
  const h = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', 'Marketing', 5000)],
    transactions: busyMonth(2345, -1, 'c-mkt'),
    maxRows: 1000,
  });
  assert.deepEqual(h.rows(), [{ name: 'Marketing', spent: '$2,345 of $5,000' }]);
  assert.equal(h.message().textContent, '');
});

test('it is counted in full even when the server allows fewer rows than a page', async () => {
  const h = await mount({
    budgets: [budget('b1', 'Uncategorised', 5000)],
    transactions: busyMonth(700, -2, null),
    maxRows: 250,
  });
  assert.deepEqual(h.rows(), [{ name: 'Uncategorised', spent: '$1,400 of $5,000' }]);
});

/* ── When a read fails ────────────────────────────────────────────────── */

test('spending that fails to load says so, instead of showing every budget at $0', async () => {
  const h = await mount({
    categories: [MARKETING],
    budgets: [budget('b1', 'Marketing', 500)],
    failures: { finance_transactions: 'canceling statement due to statement timeout' },
  });
  assert.match(h.message().textContent, /spending/i);
  assert.match(h.message().textContent, /statement timeout/);
  assert.match(h.message().className, /\berr\b/);
  assert.equal(h.rows().length, 1, 'the budgets themselves still show');
});

test('categories that fail to load say so, and filed spending is not passed off as uncategorised', async () => {
  const h = await mount({
    budgets: [budget('b1', 'Marketing', 500), budget('b2', 'Uncategorised', 1000)],
    transactions: [tx('2026-09-02', -150, 'c-mkt'), tx('2026-09-03', -300, null)],
    failures: { finance_categories: 'permission denied' },
  });
  assert.match(h.message().textContent, /categories/i);
  assert.deepEqual(h.rows(), [
    { name: 'Marketing', spent: '$0 of $500' },
    { name: 'Uncategorised', spent: '$300 of $1,000' },
  ]);
});

test('budgets that fail to load say so, instead of claiming none are set', async () => {
  const h = await mount({ failures: { finance_budgets: 'permission denied' } });
  assert.match(h.message().textContent, /budgets/i);
  assert.doesNotMatch(h.$('budget-list').textContent, /No budgets set yet/);
});
