/* Tests for _shared/stripe-kind.ts — what a Stripe balance transaction is to
   the figures, and the rows sync-stripe stores for it. Revenue counted a card
   payment twice, once as Stripe's charge and again as the payout's deposit in
   the bank, and Stripe's fees were never an expense; these guard the rows that
   let the database tell them apart (finance_figures, 0041). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'stripe-kind.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const CREATED = Date.parse('2026-09-14T23:30:00Z') / 1000;
const bt = (over) => ({ id: 'txn_1', amount: 10000, fee: 320, currency: 'eur', created: CREATED,
  description: 'Invoice 1042', reporting_category: 'charge', type: 'charge', status: 'available', ...over });

test('a charge is income, a refund or a dispute gives it back, and a fee is a fee', () => {
  assert.equal(m.stripeKind({ type: 'charge' }), 'income');
  assert.equal(m.stripeKind({ type: 'payment', reporting_category: 'charge' }), 'income');
  assert.equal(m.stripeKind({ type: 'refund' }), 'refund');
  assert.equal(m.stripeKind({ type: 'adjustment', reporting_category: 'dispute' }), 'refund',
    'a dispute takes money back as a refund does');
  assert.equal(m.stripeKind({ type: 'stripe_fee' }), 'fee');
});

test('a bank debit that failed takes its income back, and a Climate contribution or an Issuing card payment is spending', () => {
  assert.equal(m.stripeKind({ type: 'payment_reversal' }), 'refund');
  assert.equal(m.stripeKind({ type: 'adjustment', reporting_category: 'charge_failure' }), 'refund');
  for (const type of ['contribution', 'climate_order_purchase', 'climate_order_refund', 'issuing_transaction', 'issuing_dispute']) {
    assert.equal(m.stripeKind({ type }), 'expense', type);
  }
  assert.equal(m.stripeKind({ type: 'something_new', reporting_category: 'issuing_transaction' }), 'expense');
});

test('an amount is in its currency\'s smallest unit: yen whole, dinars in thousandths, euros in cents', () => {
  const [yen, yenFee] = m.stripeRows(bt({ id: 'txn_jpy', amount: 5000, fee: 180, currency: 'jpy' }), 'acct-1', 'usd');
  assert.equal(yen.amount, 5000);
  assert.equal(yenFee.amount, -180);
  const [dinar, dinarFee] = m.stripeRows(bt({ id: 'txn_kwd', amount: 5120, fee: 150, currency: 'kwd' }), 'acct-1', 'usd');
  assert.equal(dinar.amount, 5.12);
  assert.equal(dinarFee.amount, -0.15);
  assert.equal(m.stripeRows(bt({ currency: null, amount: 1000, fee: 0 }), 'acct-1', 'jpy')[0].amount, 1000,
    'the account\'s currency decides when the transaction names none');
});

test('shillings and krónur come in hundredths ending in 00, and forint and Taiwan dollar payouts in hundredths too', () => {
  const [shilling] = m.stripeRows(bt({ id: 'txn_ugx', amount: 500000, fee: 0, currency: 'ugx' }), 'acct-1', 'usd');
  assert.equal(shilling.amount, 5000, 'UGX 5,000, not 500,000');
  const [krona] = m.stripeRows(bt({ id: 'txn_isk', amount: 50000, fee: 0, currency: 'isk' }), 'acct-1', 'usd');
  assert.equal(krona.amount, 500);
  const [forint] = m.stripeRows(bt({ id: 'po_huf', amount: -1000, fee: 0, currency: 'huf', type: 'payout', reporting_category: 'payout' }), 'acct-1', 'usd');
  assert.equal(forint.amount, -10, 'a payout of HUF 10 is written 1000');
  assert.equal(m.fromMinorUnits(80000, 'twd'), 800);
});

test('a payout moves money to the bank, and so does its cancelling or failing', () => {
  for (const type of ['payout', 'payout_cancel', 'payout_failure']) {
    assert.equal(m.stripeKind({ type }), 'payout', type);
  }
  assert.equal(m.stripeKind({ type: 'something_new', reporting_category: 'payout_reversal' }), 'payout');
});

test('a type or category named like an object\'s own property is no kind', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(m.stripeKind({ type: name }), 'adjustment', 'type ' + name);
    assert.equal(m.stripeKind({ type: 'something_new', reporting_category: name }), 'adjustment', 'category ' + name);
  }
});

test('moving money between Stripe balances is a transfer, and anything unknown counts as neither', () => {
  assert.equal(m.stripeKind({ type: 'transfer' }), 'transfer');
  assert.equal(m.stripeKind({ type: 'topup' }), 'transfer');
  assert.equal(m.stripeKind({ type: 'reserve_transaction', reporting_category: 'risk_reserved_funds' }), 'adjustment');
  assert.equal(m.stripeKind({}), 'adjustment', 'never guessed from a sign');
});

test('a charge is stored at its full amount, with what Stripe kept as a fee row of its own', () => {
  const rows = m.stripeRows(bt(), 'acct-1', 'usd');
  assert.deepEqual(rows, [
    { account_id: 'acct-1', external_id: 'txn_1', posted_at: '2026-09-14', description: 'Invoice 1042', counterparty: null,
      amount: 100, currency: 'EUR', status: 'posted', source: 'stripe', kind: 'income' },
    { account_id: 'acct-1', external_id: 'txn_1:fee', posted_at: '2026-09-14', description: 'Stripe fee: Invoice 1042', counterparty: null,
      amount: -3.2, currency: 'EUR', status: 'posted', source: 'stripe', kind: 'fee' },
  ]);
});

test('a payout is one row, marked as a payout; a pending one says so', () => {
  const [payout, ...rest] = m.stripeRows(bt({ id: 'po_1', amount: -9680, fee: 0, description: null,
    reporting_category: 'payout', type: 'payout', status: 'pending', currency: null }), 'acct-1', 'usd');
  assert.deepEqual(rest, []);
  assert.equal(payout.kind, 'payout');
  assert.equal(payout.amount, -96.8);
  assert.equal(payout.description, 'payout', 'the category names it when Stripe gives no description');
  assert.equal(payout.status, 'pending');
  assert.equal(payout.currency, 'USD', 'the account\'s currency when the transaction has none');
});

test('a fee given back nets out, and a fee transaction gets no second fee row', () => {
  const [, refunded] = m.stripeRows(bt({ id: 'txn_2', amount: -10000, fee: -320, type: 'refund', reporting_category: 'refund' }), 'acct-1', 'usd');
  assert.equal(refunded.kind, 'fee');
  assert.equal(refunded.amount, 3.2);
  assert.equal(m.stripeRows(bt({ id: 'txn_3', amount: -500, fee: 500, type: 'stripe_fee', reporting_category: 'fee' }), 'acct-1', 'usd').length, 1);
});
