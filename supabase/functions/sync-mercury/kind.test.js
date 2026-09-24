/* Tests for sync-mercury/kind.ts — what each Mercury transaction is to the
   figures (finance_transactions.kind, 0041).

   Revenue was every positive transaction. A Stripe payout landing in Mercury
   counted as income beside the Stripe charges it paid out, a move to savings
   counted as spending on one side and income on the other, and a refund to a
   card counted as income. Mercury names each transaction's kind; these guard
   what the sync makes of it, and that Stripe is recognised by its own names
   only, since studios have clients called Pinstripe or Blue Stripes. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'kind.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* What 0041's check lets finance_transactions.kind be. */
const ALLOWED = ['income', 'refund', 'fee', 'expense', 'payout', 'transfer', 'adjustment', 'interest'];

/* Mercury's transaction kinds, as its API documents them, grouped by what they are. */
const OWN_ACCOUNTS = ['internalTransfer', 'treasuryTransfer'];
const MOVED_BY_SOMEONE_ELSE = ['externalTransfer', 'incomingDomesticWire', 'incomingInternationalWire',
  'exogenousWireDrawdown', 'other'];
const SPENDING = ['outgoingPayment', 'expenseReimbursement', 'creditCardTransaction', 'debitCardTransaction',
  'creditCardCredit', 'debitCardCredit', 'currencyCloudReturn'];
const FEES = ['wireFee', 'cardInternationalTransactionFee', 'cardInternationalTransactionFeeRebate',
  'cardInternationalTransactionFeeReversal', 'cardInternationalTransactionFeeRebateReversal',
  'personalBankingSubscriptionFee', 'billingEngineSubscriptionFee'];
const EVERY_KIND = [...OWN_ACCOUNTS, ...MOVED_BY_SOMEONE_ELSE, 'checkDeposit', 'interestPayment', ...SPENDING, ...FEES];

/* A Mercury transaction as the API sends it: from a client, unless told otherwise. */
function tx(kind, amount, extra) {
  return Object.assign({
    id: 'tx-1',
    kind,
    amount,
    status: 'sent',
    counterpartyName: 'Factor Co',
    counterpartyNickname: null,
    bankDescription: 'FACTOR CO PAYMENT 1042',
  }, extra);
}

/* Moved by Stripe, as one of its payouts reaches the bank. */
const STRIPE = { counterpartyName: 'Stripe', bankDescription: 'STRIPE TRANSFER ST-A1B2C3D4E5F6' };

/* ── What the kind alone says ─────────────────────────────────────────── */

test('money moved between the studio\'s own accounts is a transfer, whichever way it went', () => {
  for (const kind of OWN_ACCOUNTS) {
    assert.equal(m.mercuryKind(tx(kind, -200)), 'transfer', kind + ' out');
    assert.equal(m.mercuryKind(tx(kind, 200)), 'transfer', kind + ' in');
  }
});

test('a card payment, a payment sent or a reimbursement is spending, and one coming back lowers it rather than counting as income', () => {
  for (const kind of SPENDING) {
    assert.equal(m.mercuryKind(tx(kind, -40)), 'expense', kind + ' out');
    assert.equal(m.mercuryKind(tx(kind, 15)), 'expense', kind + ' coming back');
  }
});

test('a fee is a fee, and so is a fee given back', () => {
  for (const kind of FEES) {
    assert.equal(m.mercuryKind(tx(kind, -25)), 'fee', kind);
    assert.equal(m.mercuryKind(tx(kind, 25)), 'fee', kind + ' given back');
  }
});

test('a deposited check is income, and interest is interest', () => {
  assert.equal(m.mercuryKind(tx('checkDeposit', 1200)), 'income');
  assert.equal(m.mercuryKind(tx('checkDeposit', -1200)), 'income', 'a check that bounced takes its income back');
  assert.equal(m.mercuryKind(tx('interestPayment', 2.13)), 'interest');
});

/* ── Money someone else moved ─────────────────────────────────────────── */

test('money a client or a supplier moved is income coming in and spending going out', () => {
  for (const kind of MOVED_BY_SOMEONE_ELSE) {
    assert.equal(m.mercuryKind(tx(kind, 500)), 'income', kind + ' in');
    assert.equal(m.mercuryKind(tx(kind, -500)), 'expense', kind + ' out');
  }
  assert.equal(m.mercuryKind(tx('other', 0)), 'expense', 'nothing coming in is not income');
});

test('money Stripe moved is a payout, whichever way it went', () => {
  /* In, Stripe paying out the balance its charges built; out, Stripe taking
     back a balance that refunds or disputes left negative. Both are the other
     side of what the Stripe sync records, so neither is income or spending. */
  for (const kind of MOVED_BY_SOMEONE_ELSE) {
    assert.equal(m.mercuryKind(tx(kind, 870, STRIPE)), 'payout', kind + ' from Stripe');
    assert.equal(m.mercuryKind(tx(kind, -120, STRIPE)), 'payout', kind + ' to Stripe');
  }
});

test('a kind Mercury has not named, or none at all, is read the same way', () => {
  for (const kind of [undefined, null, '', 'someKindMercuryAddsLater', 'toString', '__proto__', 'constructor', 42]) {
    assert.equal(m.mercuryKind(tx(kind, 500)), 'income', String(kind) + ' in');
    assert.equal(m.mercuryKind(tx(kind, -500)), 'expense', String(kind) + ' out');
    assert.equal(m.mercuryKind(tx(kind, 870, STRIPE)), 'payout', String(kind) + ' from Stripe');
  }
  assert.equal(m.mercuryKind({ amount: 5 }), 'income', 'nothing but an amount');
});

/* ── Which money Stripe moved ─────────────────────────────────────────── */

test('Stripe is known by its own name, or the nickname it was given in Mercury', () => {
  const names = ['Stripe', 'STRIPE', 'stripe', '  Stripe ', 'Stripe.', 'Stripe, Inc.', 'Stripe Inc', 'STRIPE LLC',
    'Stripe Payments Company', 'Stripe Payments Europe, Ltd.', 'Stripe Technology Europe Limited'];
  const plain = { bankDescription: 'ACH CREDIT 0914' };
  for (const name of names) {
    assert.equal(m.mercuryKind(tx('externalTransfer', 870, { ...plain, counterpartyName: name })), 'payout',
      'named ' + name);
    assert.equal(m.mercuryKind(tx('externalTransfer', 870, { ...plain, counterpartyName: null, counterpartyNickname: name })),
      'payout', 'nicknamed ' + name);
  }
});

test('or by a bank description that starts with the word STRIPE', () => {
  for (const bankDescription of ['STRIPE TRANSFER ST-A1B2C3D4E5F6', 'Stripe; TRANSFER; Veyago LLC', '  STRIPE']) {
    assert.equal(m.mercuryKind(tx('externalTransfer', 870, { counterpartyName: null, bankDescription })), 'payout',
      bankDescription);
  }
});

test('a client with stripe somewhere in its name is not Stripe', () => {
  const clients = ['Pinstripe Studio', 'Blue Stripes Ltd', 'Stripes & Co', 'Striped Media', 'Pinstripe',
    'Stripe Studio', 'The Stripe Agency'];
  for (const name of clients) {
    assert.equal(m.mercuryKind(tx('incomingDomesticWire', 500, { counterpartyName: name, bankDescription: 'WIRE IN 0914' })),
      'income', 'named ' + name);
    assert.equal(m.mercuryKind(tx('externalTransfer', 500, { counterpartyNickname: name })), 'income', 'nicknamed ' + name);
  }
  for (const bankDescription of ['PINSTRIPE STUDIO PAYMENT', 'BLUE STRIPES LTD INV 1042', 'STRIPES & CO',
    'STRIPED MEDIA ACH', 'STRIPESCO']) {
    assert.equal(m.mercuryKind(tx('externalTransfer', 500, { counterpartyName: null, bankDescription })), 'income',
      bankDescription);
  }
});

test('a card payment to a business that bills through Stripe is spending, not a payout', () => {
  const figma = { counterpartyName: 'Figma', bankDescription: 'STRIPE* FIGMA' };
  assert.equal(m.mercuryKind(tx('debitCardTransaction', -12, figma)), 'expense');
  assert.equal(m.mercuryKind(tx('creditCardCredit', 12, figma)), 'expense', 'nor is its refund income');
  assert.equal(m.mercuryKind(tx('creditCardTransaction', -49, STRIPE)), 'expense', 'nor paying Stripe itself by card');
});

/* ── Whatever arrives ─────────────────────────────────────────────────── */

test('every kind is one 0041 allows, and fields of the wrong type are not taken for Stripe', () => {
  const blank = { counterpartyName: null, counterpartyNickname: null, bankDescription: null };
  for (const kind of [...EVERY_KIND, 'someKindMercuryAddsLater', undefined]) {
    for (const extra of [{}, STRIPE, blank]) {
      for (const amount of [-1, 0, 1]) {
        const got = m.mercuryKind(tx(kind, amount, extra));
        assert.ok(ALLOWED.includes(got), `${kind} ${amount}: ${got}`);
      }
    }
  }
  const odd = { counterpartyName: 42, counterpartyNickname: ['Stripe'], bankDescription: { text: 'STRIPE' } };
  assert.equal(m.mercuryKind(tx('other', 5, odd)), 'income');
});
