/* Tests for sync-mercury/index.ts — the Edge Function as a whole, run in Node.

   There is no Deno here, so index.ts is loaded the way the _shared tests load
   their modules — types stripped — with each import swapped for a stand-in:
   Mercury is a fetch that answers by offset, and the database is the two
   tables the sync writes, kept in memory and upserted the way Postgres does.
   What Mercury is asked for and what lands in finance_transactions is what is
   tested. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  MERCURY_API_KEY: 'secret-token:mercury_test',
};

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

function importTs(file) {
  return import(tsModuleUrl(file));
}

/* index.ts with every import replaced by modules[specifier] (a value, or a
   function that makes one), and Deno.serve caught so the handler can be
   called with a Request. An import with no stand-in fails the load rather
   than being skipped. */
async function loadHandler(file, modules) {
  const IMPORT = /^import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+'([^']+)';/gm;
  const stripped = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  const resolved = {};
  for (const [, , , spec] of stripped.matchAll(IMPORT)) {
    if (!(spec in modules)) throw new Error(`index.ts imports ${spec}, which has no stand-in here`);
    resolved[spec] = typeof modules[spec] === 'function' ? await modules[spec]() : modules[spec];
  }
  const src = stripped.replace(IMPORT, (_, star, names, spec) => {
    const from = `globalThis.__edgeImports[${JSON.stringify(spec)}]`;
    return star ? `const ${star} = ${from};` : `const {${names.replace(/\s+as\s+/g, ': ')}} = ${from};`;
  });
  if (/^\s*import\s/m.test(src)) throw new Error('index.ts has an import this loader cannot replace');

  let handler = null;
  globalThis.__edgeImports = resolved;
  globalThis.Deno = { serve: (fn) => { handler = fn; }, env: { get: (key) => ENV[key] } };
  await import('data:text/javascript,' + encodeURIComponent(src));
  if (!handler) throw new Error('index.ts never called Deno.serve');
  return handler;
}

/* ── The world the function runs against, rebuilt for every test ────────── */

let world;

function fresh(over = {}) {
  world = Object.assign({
    user: { id: 'manager-1' },
    isManager: true,
    accounts: [],
    ledger: {},          // Mercury account id -> its transactions, newest first
    failOffset: null,    // a transactions page Mercury answers with a 503
    noListAt: null,      // a transactions page Mercury answers with no list in it
    endAt: null,         // the offset from which Mercury sends empty pages, its total unchanged
    pageCap: 500,        // the most transactions Mercury sends at once
    ignoreOffset: false, // a Mercury that answers every page from the top
    failDelete: false,   // finance_transactions refuses deletes
    requests: [],
    accountRows: new Map(),  // Mercury account id -> its finance_accounts row
    accountUpserts: [],      // what each account upsert sent
    transactions: new Map(),
    conflictTargets: [],
    deletes: [],             // the external ids each delete named
  }, over);
  return world;
}

function account(id, nickname) {
  return { id, nickname, name: nickname, kind: 'checking' };
}

function many(accountId, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${accountId}-tx-${i + 1}`,
    postedAt: '2026-09-01T12:00:00Z',
    amount: -(i + 1),
    status: 'sent',
    kind: 'debitCardTransaction',
    bankDescription: 'CARD',
    counterpartyName: 'Vendor',
  }));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/* Mercury's API: /accounts, and /account/:id/transactions paged by offset. */
async function mercuryFetch(input, init) {
  const url = new URL(String(input));
  world.requests.push({ url, auth: init && init.headers && init.headers.Authorization });
  if (url.pathname === '/api/v1/accounts') return jsonResponse({ accounts: world.accounts });

  const match = /^\/api\/v1\/account\/([^/]+)\/transactions$/.exec(url.pathname);
  if (!match) return new Response('no such route', { status: 404 });
  const offset = Number(url.searchParams.get('offset') || 0);
  if (world.failOffset === offset) return new Response('upstream unavailable', { status: 503 });
  const limit = Math.min(Number(url.searchParams.get('limit') || 500), world.pageCap);
  const all = world.ledger[match[1]] || [];
  if (world.noListAt === offset) return jsonResponse({ total: all.length });
  if (world.endAt != null && offset >= world.endAt) return jsonResponse({ total: all.length, transactions: [] });
  const from = world.ignoreOffset ? 0 : offset;
  return jsonResponse({ total: all.length, transactions: all.slice(from, from + limit) });
}

function callerClient() {
  return {
    auth: {
      getUser: async () => (world.user
        ? { data: { user: world.user }, error: null }
        : { data: { user: null }, error: { message: 'Auth session missing!' } }),
    },
    rpc: async (name) => ({ data: name === 'is_manager' && world.isManager, error: null }),
  };
}

function serviceClient() {
  return {
    from(table) {
      if (table === 'finance_accounts') {
        return {
          /* Merged the way PostgREST merges: a row that exists keeps every
             column the upsert does not name. */
          upsert: (row, opts) => ({
            select: () => ({
              single: async () => {
                if (opts.onConflict !== 'external_id') return { data: null, error: { message: 'wrong conflict target' } };
                world.accountUpserts.push(row);
                const saved = { id: 'fa-' + row.external_id, last_synced_at: null, ...world.accountRows.get(row.external_id), ...row };
                world.accountRows.set(row.external_id, saved);
                return { data: saved, error: null };
              },
            }),
          }),
          update: (values) => ({
            eq: async (col, val) => {
              for (const [key, saved] of world.accountRows) {
                if (saved[col] === val) world.accountRows.set(key, { ...saved, ...values });
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === 'finance_transactions') {
        /* What 0041's check lets finance_transactions.kind be. */
        const kinds = ['income', 'refund', 'fee', 'expense', 'payout', 'transfer', 'adjustment', 'interest'];
        return {
          /* Upserted the way PostgREST upserts: a row that exists keeps every
             column the upsert does not name. A kind 0041's check refuses
             fails the whole write, as Postgres would. */
          upsert: async (rows, opts) => {
            world.conflictTargets.push(opts.onConflict);
            const keys = rows.map((r) => r.account_id + '|' + r.external_id);
            if (new Set(keys).size !== keys.length) {
              return { error: { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } };
            }
            if (rows.some((r) => r.kind != null && !kinds.includes(r.kind))) {
              return { error: { message: 'new row for relation "finance_transactions" violates check constraint "finance_transactions_kind_check"' } };
            }
            rows.forEach((r, i) => world.transactions.set(keys[i], { ...world.transactions.get(keys[i]), ...r }));
            return { error: null };
          },
          /* Only the one shape a delete may take here — one account's rows,
             by their Mercury ids — so a delete that is not held to the
             account being synced fails the test instead of passing it. */
          delete: () => ({
            eq: (col, accountId) => ({
              in: async (idCol, ids) => {
                if (col !== 'account_id' || idCol !== 'external_id') {
                  return { error: { message: `unexpected delete filter ${col}, ${idCol}` } };
                }
                world.deletes.push(ids);
                if (world.failDelete) return { error: { message: 'permission denied for table finance_transactions' } };
                for (const [key, row] of world.transactions) {
                  if (row.account_id === accountId && ids.includes(row.external_id)) world.transactions.delete(key);
                }
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error('sync-mercury has no business with ' + table);
    },
  };
}

let handler;
test.before(async () => {
  globalThis.fetch = mercuryFetch;
  handler = await loadHandler(path.join(__dirname, 'index.ts'), {
    'npm:@supabase/supabase-js@2': {
      createClient: (url, key) => (key === ENV.SUPABASE_ANON_KEY ? callerClient() : serviceClient()),
    },
    '../_shared/mercury-account-name.ts': () => importTs(path.join(__dirname, '..', '_shared', 'mercury-account-name.ts')),
    './transactions.ts': () => importTs(path.join(__dirname, 'transactions.ts')),
  });
});

async function sync(body) {
  const res = await handler(new Request('https://project.supabase.co/functions/v1/sync-mercury', {
    method: 'POST',
    headers: { Authorization: 'Bearer caller-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

function offsetsFor(accountId) {
  return world.requests
    .filter((r) => r.url.pathname === `/api/v1/account/${accountId}/transactions`)
    .map((r) => Number(r.url.searchParams.get('offset') || 0));
}

/* ── Completeness ─────────────────────────────────────────────────────── */

test('an account with more transactions than one page holds is synced in full', async () => {
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1234) } });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.transactions, 1234);
  assert.equal(world.transactions.size, 1234, 'every transaction reached finance_transactions');
  assert.deepEqual(offsetsFor('acc-1'), [0, 500, 1000, 1234]);
  assert.ok(world.requests.every((r) => r.auth === 'Bearer ' + ENV.MERCURY_API_KEY));
});

test('syncing again updates the rows it wrote instead of adding more', async () => {
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1234) } });
  await sync({});
  const again = await sync({});

  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(world.transactions.size, 1234);
  assert.ok(world.conflictTargets.length > 0);
  assert.ok(world.conflictTargets.every((t) => t === 'account_id,external_id'),
    'every write upserts on the (account_id, external_id) key');
});

test('each account is paged on its own', async () => {
  fresh({
    accounts: [account('acc-1', 'Checking'), account('acc-2', 'Savings')],
    ledger: { 'acc-1': many('acc-1', 3), 'acc-2': many('acc-2', 501) },
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.accounts, 2);
  assert.equal(out.body.transactions, 504);
  assert.deepEqual(offsetsFor('acc-1'), [0, 3]);
  assert.deepEqual(offsetsFor('acc-2'), [0, 500, 501]);
  const owners = new Set([...world.transactions.values()].map((r) => r.account_id));
  assert.deepEqual([...owners].sort(), ['fa-acc-1', 'fa-acc-2']);
});

test('a Mercury failure part-way through is reported, not counted as a finished sync', async (t) => {
  t.mock.method(console, 'error', () => {});
  const earlier = '2026-09-01T06:00:00.000Z';
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': many('acc-1', 1234) },
    failOffset: 500,
    accountRows: new Map([['acc-1', { id: 'fa-acc-1', external_id: 'acc-1', name: 'Checking', last_synced_at: earlier }]]),
  });
  const out = await sync({});

  assert.equal(out.status, 500);
  assert.match(out.body.error, /503/);
  assert.equal(world.accountRows.get('acc-1').last_synced_at, earlier,
    'the account still says when a sync last finished, so it can read as stale');
  assert.equal(world.transactions.size, 500, 'the page that did arrive is kept');
});

test('a Mercury that sends the same short page at every offset is reported, not counted as a finished sync', async (t) => {
  /* 1,234 transactions, and every request answered with the first 100: this
     used to come back as a sync of 100, stamped fresh. */
  t.mock.method(console, 'error', () => {});
  const earlier = '2026-09-01T06:00:00.000Z';
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': many('acc-1', 1234) },
    pageCap: 100,
    ignoreOffset: true,
    accountRows: new Map([['acc-1', { id: 'fa-acc-1', external_id: 'acc-1', name: 'Checking', last_synced_at: earlier }]]),
  });
  const out = await sync({});

  assert.equal(out.status, 500);
  assert.match(out.body.error, /not paging/);
  assert.equal(world.accountRows.get('acc-1').last_synced_at, earlier);
  assert.equal(world.transactions.size, 100);
});

test('a response with no list of transactions part-way through is reported, not taken for the end', async (t) => {
  t.mock.method(console, 'error', () => {});
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1234) }, noListAt: 500 });
  const out = await sync({});

  assert.equal(out.status, 500);
  assert.match(out.body.error, /no list of transactions/);
  assert.equal(world.accountRows.get('acc-1').last_synced_at, null, 'not marked synced');
});

test('a list that runs out before Mercury\'s own total is reported, not counted as a finished sync', async (t) => {
  /* An empty page ends the walk; Mercury's total, handed through with every
     page, is what tells a list that ran out from one that was finished. */
  t.mock.method(console, 'error', () => {});
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1234) }, endAt: 1000 });
  const out = await sync({});

  assert.equal(out.status, 500);
  assert.match(out.body.error, /counted 1234 transactions .*sent 1000 /);
  assert.equal(world.accountRows.get('acc-1').last_synced_at, null, 'not marked synced');
  assert.equal(world.transactions.size, 1000, 'what did arrive is kept');
});

test('an account is marked synced only once all of its transactions are stored', async () => {
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1234) } });
  const before = Date.now();
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(Date.parse(world.accountRows.get('acc-1').last_synced_at) >= before, 'stamped by this sync');
  assert.ok(world.accountUpserts.length > 0);
  assert.ok(world.accountUpserts.every((row) => !('last_synced_at' in row)),
    'not stamped up front, before anything has been fetched');
});

test('the window starts the number of days asked for back, at most two years', async () => {
  fresh({ accounts: [account('acc-1', 'Checking')], ledger: { 'acc-1': many('acc-1', 1) } });
  const out = await sync({ days: 5000 });

  const start = world.requests.find((r) => r.url.pathname.endsWith('/transactions')).url.searchParams.get('start');
  assert.equal(start, out.body.since);
  const back = Math.round((Date.now() - Date.parse(start + 'T00:00:00Z')) / 86400000);
  assert.ok(back === 730 || back === 731, 'capped at 730 days, got ' + back);
});

/* ── Payments that never went through ─────────────────────────────────── */

test('cancelled and failed payments are not stored, and a copy stored while one was pending is removed', async () => {
  const txs = many('acc-1', 4).map((t, i) => (i === 1 ? { ...t, status: 'failed' } : i === 2 ? { ...t, status: 'cancelled' } : t));
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': txs },
    /* Written by an earlier sync, while the payment was still pending. */
    transactions: new Map([['fa-acc-1|acc-1-tx-2', {
      account_id: 'fa-acc-1', external_id: 'acc-1-tx-2', posted_at: '2026-09-01', amount: -2, status: 'pending', source: 'mercury',
    }]]),
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual([...world.transactions.values()].map((r) => r.external_id).sort(), ['acc-1-tx-1', 'acc-1-tx-4'],
    'no money that never moved is left to count against a budget');
  assert.equal(out.body.transactions, 2, 'only what went through is counted as synced');
});

test('a long run of them is deleted a batch at a time, to keep each request short', async () => {
  /* The ids travel in the request URL, external_id=in.(…). */
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': many('acc-1', 250).map((t) => ({ ...t, status: 'failed' })) },
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(world.deletes.length > 1, 'more than one request');
  assert.ok(world.deletes.every((ids) => ids.length <= 100), 'none naming more than 100 ids');
  assert.equal(new Set(world.deletes.flat()).size, 250, 'every one of them named');
});

test('a delete that fails is reported, and the account is not marked synced', async (t) => {
  t.mock.method(console, 'error', () => {});
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': many('acc-1', 1).map((tx) => ({ ...tx, status: 'failed' })) },
    failDelete: true,
  });
  const out = await sync({});

  assert.equal(out.status, 500);
  assert.match(out.body.error, /Transaction delete failed: permission denied/);
  assert.equal(world.accountRows.get('acc-1').last_synced_at, null);
});

test('reversed and blocked payments are not stored either, and a copy an earlier sync stored is removed', async () => {
  const txs = many('acc-1', 4).map((t, i) => (i === 1 ? { ...t, status: 'reversed' } : i === 2 ? { ...t, status: 'blocked' } : t));
  const earlier = (n, status) => [`fa-acc-1|acc-1-tx-${n}`, {
    account_id: 'fa-acc-1', external_id: `acc-1-tx-${n}`, posted_at: '2026-09-01', amount: -n, status, source: 'mercury', kind: 'expense',
  }];
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': txs },
    /* Written by earlier syncs: one sent before it was reversed, one pending before it was blocked. */
    transactions: new Map([earlier(2, 'posted'), earlier(3, 'pending')]),
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual([...world.transactions.values()].map((r) => r.external_id).sort(), ['acc-1-tx-1', 'acc-1-tx-4'],
    'no money that did not stay moved is left to count');
  assert.equal(out.body.transactions, 2);
});

/* ── What each transaction is ─────────────────────────────────────────── */

test('every transaction stored says what it is, so a Stripe payout is not counted as income again', async () => {
  const at = (day) => `2026-09-0${day}T12:00:00Z`;
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': [
      { id: 'payout', postedAt: at(1), amount: 870, status: 'sent', kind: 'externalTransfer',
        counterpartyName: 'Stripe', bankDescription: 'STRIPE TRANSFER ST-A1B2C3D4E5F6' },
      { id: 'client', postedAt: at(2), amount: 500, status: 'sent', kind: 'incomingDomesticWire',
        counterpartyName: 'Pinstripe Studio', bankDescription: 'WIRE IN 0902' },
      { id: 'savings', postedAt: at(3), amount: -200, status: 'sent', kind: 'internalTransfer',
        counterpartyName: 'Mercury Savings', bankDescription: 'Transfer to Savings' },
      { id: 'figma', postedAt: at(4), amount: -12, status: 'pending', kind: 'debitCardTransaction',
        counterpartyName: 'Figma', bankDescription: 'STRIPE* FIGMA' },
      { id: 'wire-fee', postedAt: at(5), amount: -5, status: 'sent', kind: 'wireFee', counterpartyName: 'Mercury' },
      { id: 'interest', postedAt: at(6), amount: 2.13, status: 'sent', kind: 'interestPayment', counterpartyName: 'Mercury' },
    ] },
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  const kinds = Object.fromEntries([...world.transactions.values()].map((r) => [r.external_id, r.kind]));
  assert.deepEqual(kinds, {
    payout: 'payout', client: 'income', savings: 'transfer', figma: 'expense', 'wire-fee': 'fee', interest: 'interest',
  });
});

test('syncing again replaces the kind a row was given before the sync wrote one', async () => {
  /* Rows stored before kind existed are given a guess (0041), and a guess can
     be wrong: here a client called Stripes & Co taken for Stripe. The upsert
     changes only the columns it names, so the sync has to name kind. */
  fresh({
    accounts: [account('acc-1', 'Checking')],
    ledger: { 'acc-1': [{ id: 'acc-1-tx-1', postedAt: '2026-09-01T12:00:00Z', amount: 500, status: 'sent',
      kind: 'externalTransfer', counterpartyName: 'Stripes & Co', bankDescription: 'STRIPES & CO INV 1042' }] },
    transactions: new Map([['fa-acc-1|acc-1-tx-1', {
      account_id: 'fa-acc-1', external_id: 'acc-1-tx-1', posted_at: '2026-09-01', description: 'STRIPES & CO INV 1042',
      counterparty: 'Stripes & Co', amount: 500, currency: 'USD', status: 'posted', source: 'mercury', kind: 'payout',
    }]]),
  });
  const out = await sync({});

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(world.transactions.get('fa-acc-1|acc-1-tx-1').kind, 'income');
});

/* ── Who may run it ───────────────────────────────────────────────────── */

test('only a signed-in manager can run it, and Mercury is asked nothing otherwise', async () => {
  fresh({ user: null, accounts: [account('acc-1', 'Checking')] });
  assert.equal((await sync({})).status, 401);
  assert.equal(world.requests.length, 0);

  fresh({ isManager: false, accounts: [account('acc-1', 'Checking')] });
  assert.equal((await sync({})).status, 403);
  assert.equal(world.requests.length, 0);
  assert.equal(world.transactions.size, 0);
});
