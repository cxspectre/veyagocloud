/* Tests for admin/js/finance-figures.js — what the admin's money figures count:
   each transaction by what it is (finance_figures, 0041), never by its sign
   alone, in the studio's currency; every row, however many there are; and,
   while 0041 is not live, the ledger read by its sign as before. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ console: { ...console, warn() {} } });
context.window = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, 'finance-figures.js'), 'utf8'), context);
const f = context.financeFigures;

/* supabase-js's chain, as far as the admin uses it: every answer given up
   front, each table asked for with its columns, and each page read. `rpc`
   answers a function call; without it, the function is not there (PGRST202). */
function fakeSb(answers, rpc) {
  const asked = [];
  const pages = [];
  return {
    asked,
    pages,
    rpc: async (name) => (rpc ? rpc(name) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    from: (table) => ({
      select: (columns) => {
        asked.push([table, columns]);
        const answer = answers[table] || { data: [], error: null };
        const chain = {
          gte: () => chain,
          order: () => chain,
          range: (from, to) => {
            pages.push([table, from, to]);
            return Promise.resolve(answer.error ? { data: null, error: answer.error } : { data: answer.data.slice(from, to + 1), error: null });
          },
        };
        return chain;
      },
    }),
  };
}
const narrow = (query, columns) => query.select(columns).gte('posted_at', '2026-09-01');

test('each transaction counts by what it is: a row the view counts as neither is left out of income and expenses', () => {
  const t = f.totals([
    { amount: 100, currency: 'USD', counts_as: 'revenue' },
    { amount: -10, currency: 'USD', counts_as: 'revenue' },
    { amount: 87, currency: 'USD', counts_as: null },
    { amount: -200, currency: 'USD', counts_as: null },
    { amount: -40, currency: 'USD', counts_as: 'expense' },
    { amount: 15, currency: 'USD', counts_as: 'expense' },
  ], 'usd');
  assert.equal(t.currency, 'USD');
  assert.equal(t.income, 90, 'income less a refund, and not the payout of that income');
  assert.equal(t.expense, 25, 'spending less what a merchant gave back, and not the transfer');
  assert.equal(t.net, 65);
});

test('a payout counted from Stripe\'s side is the money it paid out, not its sign on Stripe\'s ledger', () => {
  const t = f.totals([{ amount: -400, counted: 400, currency: 'USD', counts_as: 'revenue' }], 'USD');
  assert.equal(t.income, 400);
  assert.equal(t.net, 400);
});

test('another currency is named beside the figures, never added in', () => {
  const t = f.totals([
    { amount: 100, currency: 'USD', counts_as: 'revenue' },
    { amount: 900, currency: ' eur ', counts_as: 'revenue' },
    { amount: 5, currency: 'GBP', counts_as: null },
  ], 'USD');
  assert.equal(t.income, 100);
  assert.deepEqual([...t.otherCurrencies], ['EUR'], 'a currency with nothing that counts is not named');
});

test('a ledger row from before 0041 is read by its sign; a row the view counts as neither is not', () => {
  assert.equal(f.countsAs({ amount: 5 }), 'revenue');
  assert.equal(f.countsAs({ amount: -5 }), 'expense');
  assert.equal(f.countsAs({ amount: 0 }), null);
  assert.equal(f.countsAs({ amount: 5, counts_as: null }), null);
  assert.equal(f.countsAs({ amount: 5, counts_as: 'something else' }), null);
});

test('cents add up exactly, and no expenses is zero rather than minus zero', () => {
  const t = f.totals([{ amount: 0.1, currency: 'USD', counts_as: 'revenue' }, { amount: 0.2, currency: 'USD', counts_as: 'revenue' }], 'USD');
  assert.equal(t.income, 0.3);
  assert.ok(Object.is(t.expense, 0));
  assert.equal(f.format(t.expense, 'USD'), '$0.00');
});

test('an amount is written in its own currency, and a code Intl cannot take is written beside the number', () => {
  assert.equal(f.format(1234.5, 'eur'), '€1,234.50');
  assert.equal(f.format(1234.5, 'USD', 0), '$1,235');
  assert.equal(f.format(10, 'US$'), '10.00 US$');
});

test('rows come from finance_figures, with what each counts towards', async () => {
  const sb = fakeSb({ finance_figures: { data: [{ amount: 1, counts_as: 'revenue' }], error: null } });
  const res = await f.load(sb, narrow);
  assert.equal(res.error, null);
  assert.equal(res.data.length, 1);
  assert.deepEqual(sb.asked.map((a) => a[0]), ['finance_figures']);
  assert.match(sb.asked[0][1], /counts_as/);
});

test('every row is read, a page at a time, however many PostgREST would hand back at once', async () => {
  const many = Array.from({ length: 2500 }, () => ({ amount: 1, currency: 'USD', counts_as: 'revenue' }));
  const sb = fakeSb({ finance_figures: { data: many, error: null } });
  const res = await f.load(sb, narrow);
  assert.equal(res.data.length, 2500);
  assert.deepEqual(sb.pages.map((p) => [p[1], p[2]]), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(f.totals(res.data, 'USD').income, 2500);
});

test('while 0041 is not live, the ledger is read instead, by its sign', async () => {
  for (const code of ['PGRST205', '42P01']) {
    const sb = fakeSb({
      finance_figures: { data: null, error: { code, message: 'not there' } },
      finance_transactions: { data: [{ amount: -3, currency: 'USD' }], error: null },
    });
    const res = await f.load(sb, narrow);
    assert.equal(res.error, null, code);
    assert.deepEqual(sb.asked.map((a) => a[0]), ['finance_figures', 'finance_transactions']);
    assert.doesNotMatch(sb.asked[1][1], /counts_as/, 'the ledger has no such column');
    assert.equal(f.totals(res.data, 'USD').expense, 3);
  }
});

test('any other error is reported, not covered over with the ledger', async () => {
  const sb = fakeSb({ finance_figures: { data: null, error: { code: '42501', message: 'permission denied' } } });
  const res = await f.load(sb, narrow);
  assert.equal(res.data, null);
  assert.equal(res.error.code, '42501');
  assert.deepEqual(sb.asked.map((a) => a[0]), ['finance_figures']);
});

test('the studio\'s currency is the one the workspace shows money in, and before 0041 the first account\'s that is a code', async () => {
  assert.equal(await f.studioCurrency(fakeSb({}, () => ({ data: 'EUR', error: null })), [{ currency: 'USD' }]), 'EUR');
  assert.equal(await f.studioCurrency(fakeSb({}), [{ currency: 'US$' }, { currency: '' }, { currency: ' gbp ' }]), 'GBP');
  assert.equal(await f.studioCurrency(fakeSb({}), []), 'USD');
  assert.equal(await f.studioCurrency({ rpc: async () => { throw new Error('offline'); } }, [{ currency: 'CHF' }]), 'CHF',
    'a call that fails is not the end of the figures');
});
