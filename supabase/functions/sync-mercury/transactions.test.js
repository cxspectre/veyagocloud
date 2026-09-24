/* Tests for sync-mercury/transactions.ts — how one Mercury account's
   transactions are walked, page by page, into finance_transactions.

   The sync used to ask Mercury for `limit=500` once and stop there, so an
   account with more than 500 transactions in the window lost every one past
   the first page, silently, on every run. Mercury and the database are
   stand-ins that record each call, so what is asked for, in what order, and
   what gets written is what is tested. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/* A .ts module as a data: URL Node can import: types stripped, and each module
   it imports from beside it (transactions.ts imports ./kind.ts) loaded the same
   way, since a module loaded from a data: URL has no folder to find them in. */
function tsModuleUrl(file) {
  const src = stripTypeScriptTypes(fs.readFileSync(file, 'utf8')).replace(
    /(\bfrom\s+)'(\.\/[\w.-]+\.ts)'/g,
    (_, from, spec) => from + JSON.stringify(tsModuleUrl(path.join(path.dirname(file), spec))),
  );
  return 'data:text/javascript,' + encodeURIComponent(src);
}

let m;
test.before(async () => {
  m = await import(tsModuleUrl(path.join(__dirname, 'transactions.ts')));
});

/* A Mercury transaction as the API sends it. */
function tx(n, extra) {
  return Object.assign({
    id: 'tx-' + n,
    postedAt: '2026-09-' + String((n % 28) + 1).padStart(2, '0') + 'T15:04:05.000Z',
    createdAt: '2026-09-01T09:00:00.000Z',
    amount: -n,
    status: 'sent',
    kind: 'debitCardTransaction',
    bankDescription: 'CARD ' + n,
    counterpartyName: 'Vendor ' + n,
  }, extra);
}

function ledger(count) {
  return Array.from({ length: count }, (_, i) => tx(i + 1));
}

/* Mercury answers by offset from `all`, never more than `cap` rows at a time,
   with the total it counts for the whole list, as the API does.
   `answer(offset, limit)` replaces that outright: it returns a response body,
   or a bare list for a response that carries no total. Every request, write
   and removal is kept, in order. */
function harness(all, opts = {}) {
  const requests = [];
  const writes = [];
  const removals = [];
  const run = (over = {}) => m.syncAccountTransactions(Object.assign({
    accountId: 'acct-1',
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
    fetchPage: async (offset, limit) => {
      requests.push({ offset, limit });
      if (opts.answer) {
        const body = opts.answer(offset, limit);
        return Array.isArray(body) ? { transactions: body } : body;
      }
      return { total: all.length, transactions: all.slice(offset, offset + Math.min(limit, opts.cap || limit)) };
    },
    store: async (rows) => { writes.push(rows); },
    remove: async (ids) => { removals.push(ids); },
  }, over));
  return {
    run, requests, writes, removals,
    offsets: () => requests.map((r) => r.offset),
    written: () => writes.flat().map((r) => r.external_id),
    removed: () => removals.flat(),
  };
}

/* ── Paging ───────────────────────────────────────────────────────────── */

test('every page is fetched, not just the first', async () => {
  const h = harness(ledger(5), { pageSize: 2 });
  const out = await h.run();
  assert.deepEqual(h.offsets(), [0, 2, 4, 5], 'walks on, each page starting where the last ended, until one comes back empty');
  assert.deepEqual(h.written(), ['tx-1', 'tx-2', 'tx-3', 'tx-4', 'tx-5']);
  assert.equal(out.stored, 5);
});

test('it asks for pages of 500 unless told otherwise', async () => {
  const h = harness(ledger(3));
  await h.run();
  assert.equal(m.PAGE_SIZE, 500);
  assert.deepEqual(h.requests, [{ offset: 0, limit: 500 }, { offset: 3, limit: 500 }]);
});

test('a page shorter than asked for is not taken as the end', async () => {
  /* A Mercury that hands back fewer rows than the limit — a lower cap than
     documented, say — must still be walked to the end, and each next page
     starts where the rows actually received stop. */
  const h = harness(ledger(5), { pageSize: 4, cap: 2 });
  await h.run();
  assert.deepEqual(h.offsets(), [0, 2, 4, 5]);
  assert.equal(h.written().length, 5);
});

test('each page is written as it arrives, in the shape the upsert keys on', async () => {
  const h = harness(ledger(3), { pageSize: 2 });
  await h.run();
  assert.equal(h.writes.length, 2, 'one write per page that had rows');
  for (const row of h.writes.flat()) {
    assert.equal(row.account_id, 'acct-1');
    assert.equal(row.source, 'mercury');
    assert.ok(row.external_id, 'external_id is half of the (account_id, external_id) key');
  }
});

test('a transaction with no date is left out, and the next page still starts after it', async () => {
  const h = harness([tx(1), tx(2, { postedAt: null, createdAt: null }), tx(3)], { pageSize: 2 });
  const out = await h.run();
  assert.deepEqual(h.offsets(), [0, 2, 3]);
  assert.deepEqual(h.written(), ['tx-1', 'tx-3']);
  assert.equal(out.stored, 2);
});

test('a transaction listed twice in one page is written once', async () => {
  /* One upsert that names the same key twice is refused by Postgres outright
     ("cannot affect row a second time"), which would fail the whole sync. */
  const h = harness([], {
    pageSize: 2,
    answer: (offset) => (offset === 0 ? [tx(1), tx(1, { status: 'pending' })] : []),
  });
  await h.run();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].map((r) => [r.external_id, r.status]), [['tx-1', 'pending']],
    'the later copy wins');
});

/* ── When Mercury misbehaves ──────────────────────────────────────────── */

test('a Mercury that ignores the offset fails loudly instead of looping', async () => {
  const all = ledger(4);
  const h = harness(all, { pageSize: 2, answer: (offset, limit) => all.slice(0, limit) });
  await assert.rejects(h.run(), /not paging/);
  assert.equal(h.requests.length, 2, 'stops at the first page it has already seen');
  assert.deepEqual(h.written(), ['tx-1', 'tx-2']);
});

test('a Mercury that ignores the offset fails loudly even when its pages are short', async () => {
  /* A short page is no sign of the end — Mercury may cap lower than asked —
     so a page of repeats is not let off for falling short of the limit. It
     is judged against the pages Mercury has actually sent. Here every
     request gets the same first 100 of 1,234, which used to finish as a
     sync of 100. */
  const all = ledger(1234);
  const h = harness(all, { answer: (o, l) => all.slice(0, 100) });
  await assert.rejects(h.run(), /not paging/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.written().length, 100, 'the first page is kept');

  const counted = harness(all, { answer: () => ({ total: 1234, transactions: all.slice(0, 100) }) });
  await assert.rejects(counted.run(), /not paging/, 'the same with Mercury\'s total in the response');
});

test('a page sent again in full is the end when Mercury\'s total says every transaction is in hand', async () => {
  /* An account whose window fits in one page. A new transaction arriving
     between requests pushes the one it has onto page two, which is page one
     again and no shorter; a Mercury that ignores the offset repeats the page
     the same way. Either way nothing is missing, and Mercury's total says so. */
  const one = tx(1);
  const pushed = harness([], { answer: (offset) => ({ total: offset === 0 ? 1 : 2, transactions: [one] }) });
  assert.equal((await pushed.run()).stored, 1);
  assert.equal(pushed.requests.length, 2);

  const all = ledger(3);
  const repeated = harness(all, { answer: () => ({ total: 3, transactions: all }) });
  assert.equal((await repeated.run()).stored, 3);

  await assert.rejects(harness(all, { answer: () => all }).run(), /not paging/,
    'with no total to say so, the same repeat is a Mercury that is not paging');
});

test('a list that ends short of Mercury\'s own total is an error, not a finished sync', async () => {
  /* An empty page ends the walk, and an empty page is all a Mercury that
     gives up part-way — at an offset it will not go past, say — would send. */
  const all = ledger(6);
  const h = harness(all, {
    pageSize: 2,
    answer: (offset, limit) => ({ total: 6, transactions: offset < 4 ? all.slice(offset, offset + limit) : [] }),
  });
  await assert.rejects(h.run(), /counted 6 transactions .*sent 4 /);
  assert.deepEqual(h.written(), ['tx-1', 'tx-2', 'tx-3', 'tx-4'], 'what did arrive is kept');
});

test('a response with no list of transactions is an error, not the end of the list', async () => {
  const all = ledger(4);
  const h = harness(all, { pageSize: 2, answer: (offset, limit) => (offset === 0 ? all.slice(0, limit) : {}) });
  await assert.rejects(h.run(), /no list of transactions at offset 2/);
  assert.deepEqual(h.written(), ['tx-1', 'tx-2']);

  const idle = harness([], { answer: () => ({ total: 0 }) });
  assert.equal((await idle.run()).stored, 0, 'unless Mercury\'s total says there is nothing to list');
});

test('a transaction pushed onto the next page mid-walk is counted once', async () => {
  /* A new transaction at the top of the list shifts every row down one, so a
     page can start with the row the last one ended on. Writing it again is
     harmless — the upsert keys on it — but the count is what the manager is
     told was synced. */
  const h = harness([], {
    pageSize: 2,
    answer: (offset) => (offset === 0 ? [tx(1), tx(2)] : offset === 2 ? [tx(2), tx(3)] : []),
  });
  const out = await h.run();
  assert.deepEqual(h.written(), ['tx-1', 'tx-2', 'tx-2', 'tx-3']);
  assert.equal(out.stored, 3);
});

test('a short page of rows already seen is the end of the list, not an error', async () => {
  /* A transaction arriving mid-walk pushes the last row of one page onto the
     start of the next, so the final page can repeat what was just written. */
  const h = harness([], {
    pageSize: 2,
    answer: (offset) => (offset === 0 ? [tx(1), tx(2)] : offset === 2 ? [tx(2)] : []),
  });
  const out = await h.run();
  assert.deepEqual(h.written(), ['tx-1', 'tx-2']);
  assert.equal(out.stored, 2);
});

test('more pages than the ceiling is an error, not a sync reported as complete', async () => {
  const h = harness(ledger(10), { pageSize: 2, maxPages: 2 });
  await assert.rejects(h.run(), /more than 4 transactions/);
  assert.deepEqual(h.written(), ['tx-1', 'tx-2', 'tx-3', 'tx-4'], 'what came before the ceiling is kept');
});

test('a ledger that exactly fills the ceiling still completes', async () => {
  const h = harness(ledger(4), { pageSize: 2, maxPages: 2 });
  const out = await h.run();
  assert.equal(out.stored, 4);
  assert.deepEqual(h.offsets(), [0, 2, 4]);
});

test('a failed write stops the walk, and its error is what comes back', async () => {
  const h = harness(ledger(6), { pageSize: 2 });
  let stores = 0;
  await assert.rejects(
    h.run({
      store: async () => {
        stores += 1;
        if (stores === 2) throw new Error('Transaction upsert failed: boom');
      },
    }),
    /Transaction upsert failed: boom/,
  );
  assert.deepEqual(h.offsets(), [0, 2], 'nothing more is fetched once a page cannot be saved');
});

test('a failed request is what comes back', async () => {
  const h = harness([], {
    answer: () => { throw new Error('Mercury /account/acct-1/transactions → 429: slow down'); },
  });
  await assert.rejects(h.run(), /429/);
});

/* ── Payments that never went through ─────────────────────────────────── */

test('a cancelled or failed transaction is neither written nor counted', async () => {
  /* Mercury lists payments that never went through beside the ones that did.
     finance_transactions can only call a row pending or posted (0005), so
     these were stored as posted — money that moved — and every budget and
     figure counted them. */
  const h = harness([tx(1), tx(2, { status: 'failed' }), tx(3, { status: 'cancelled' }), tx(4, { status: 'pending' })],
    { pageSize: 2 });
  const out = await h.run();
  assert.deepEqual(h.written(), ['tx-1', 'tx-4']);
  assert.equal(out.stored, 2);
  assert.deepEqual(h.offsets(), [0, 2, 4], 'the next page still starts where the rows received stop');
});

test('each one is handed back to be removed, in case an earlier sync stored it while pending', async () => {
  const h = harness([tx(1), tx(2, { status: 'failed' }), tx(3), tx(4, { status: 'cancelled' })], { pageSize: 2 });
  await h.run();
  assert.deepEqual(h.removals, [['tx-2'], ['tx-4']], 'a page at a time, as it arrives');

  const clean = harness(ledger(3), { pageSize: 2 });
  await clean.run();
  assert.deepEqual(clean.removals, [], 'nothing to remove, nothing asked');
});

test('the later copy of a transaction decides whether it is written or removed', async () => {
  /* Within a page, as for any repeat; and across pages, where a payment that
     fails mid-walk can be pushed onto the next page after it was written. */
  const within = harness([], {
    pageSize: 2,
    answer: (offset) => (offset === 0 ? [tx(1, { status: 'pending' }), tx(1, { status: 'failed' })] : []),
  });
  const a = await within.run();
  assert.deepEqual(within.written(), []);
  assert.deepEqual(within.removed(), ['tx-1']);
  assert.equal(a.stored, 0);

  const across = harness([], {
    pageSize: 2,
    answer: (offset) => (offset === 0 ? [tx(1), tx(2, { status: 'pending' })]
      : offset === 2 ? [tx(2, { status: 'failed' }), tx(3)] : []),
  });
  const b = await across.run();
  assert.deepEqual(across.written(), ['tx-1', 'tx-2', 'tx-3']);
  assert.deepEqual(across.removed(), ['tx-2']);
  assert.equal(b.stored, 2, 'written, then removed, so not counted');
});

test('a reversed or blocked transaction is dropped the same way: not written, not counted, handed back to be removed', async () => {
  /* Mercury's other two ends for a payment that leaves no money moved:
     reversed, undone after it went through, and blocked, stopped before it
     did. An earlier sync may have stored either, sent or pending. */
  const h = harness([tx(1), tx(2, { status: 'reversed' }), tx(3, { status: 'blocked' }), tx(4, { status: 'pending' })],
    { pageSize: 2 });
  const out = await h.run();
  assert.deepEqual(h.written(), ['tx-1', 'tx-4']);
  assert.equal(out.stored, 2);
  assert.deepEqual(h.removals, [['tx-2'], ['tx-3']], 'a page at a time, as it arrives');
});

/* ── The row and the request ──────────────────────────────────────────── */

test('a transaction row keeps the mapping the sync has always used, and says what the transaction is', () => {
  assert.deepEqual(m.transactionRow(tx(7, { status: 'pending' }), 'acct-1'), {
    account_id: 'acct-1',
    external_id: 'tx-7',
    posted_at: '2026-09-08',
    description: 'CARD 7',
    counterparty: 'Vendor 7',
    amount: -7,
    currency: 'USD',
    status: 'pending',
    source: 'mercury',
    kind: 'expense',
  });

  const bare = m.transactionRow({ id: 'x', createdAt: '2026-08-31T23:00:00Z', amount: 12.5, status: 'sent' }, 'acct-1');
  assert.equal(bare.posted_at, '2026-08-31', 'not posted yet: the created date stands in');
  assert.equal(bare.description, 'Transaction');
  assert.equal(bare.counterparty, null);
  assert.equal(bare.status, 'posted');

  const at = { id: 'y', postedAt: '2026-09-01' };
  assert.equal(m.transactionRow({ ...at, externalMemo: 'memo', note: 'note', counterpartyName: 'who' }, 'a').description, 'memo');
  assert.equal(m.transactionRow({ ...at, note: 'note', counterpartyName: 'who' }, 'a').description, 'note');
  assert.equal(m.transactionRow({ ...at, counterpartyName: 'who' }, 'a').description, 'who');
});

test('every row the walk writes says what its transaction is', async () => {
  /* What each kind is, and which money Stripe moved, is kind.test.js's to
     test; this is that every row written carries it. */
  const h = harness([
    tx(1, { kind: 'externalTransfer', amount: 870, counterpartyName: 'Stripe', bankDescription: 'STRIPE TRANSFER ST-1' }),
    tx(2, { kind: 'incomingDomesticWire', amount: 500, counterpartyName: 'Blue Stripes Ltd', bankDescription: 'WIRE IN 0914' }),
    tx(3, { kind: 'internalTransfer', amount: -200, counterpartyName: 'Mercury Savings' }),
    tx(4),
  ], { pageSize: 2 });
  await h.run();
  assert.deepEqual(h.writes.flat().map((r) => [r.external_id, r.kind]),
    [['tx-1', 'payout'], ['tx-2', 'income'], ['tx-3', 'transfer'], ['tx-4', 'expense']]);
});

test('the request names the page size, the offset and the start of the window', () => {
  assert.equal(
    m.transactionsPath('acct-1', { since: '2026-06-16', offset: 1000, limit: 500 }),
    '/account/acct-1/transactions?limit=500&offset=1000&start=2026-06-16',
  );
});
