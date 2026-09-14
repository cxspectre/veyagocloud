/* Tests for _shared/delta-loop.ts — how the scheduled sync walks one folder's
   Graph delta: what it saves, when it stops, and what a failure costs. Graph,
   the database and the cursor are stand-ins that record every call, so the
   order of fetching, storing and saving is what is tested. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let d;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'delta-loop.ts'), 'utf8');
  d = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const LINK = (n) => `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=${n}`;
const DONE = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done';
const FRESH = { link: null, failures: 0 };

function graphError(status) {
  return Object.assign(new Error(`Graph → ${status}: refused`), { status });
}

/* respond(from, call) answers a fetch, or throws. The log reads in order. */
function harness(respond, overrides = {}) {
  const log = [];
  const deps = {
    fetchPage: async (from) => {
      log.push(['fetch', from]);
      return respond(from, log.filter(([what]) => what === 'fetch').length);
    },
    store: async (items) => {
      log.push(['store', items.length]);
      return { threads: items.length, messages: items.length, routedToTickets: 0 };
    },
    save: async (cursor) => {
      log.push(['save', { ...cursor }]);
    },
    ...overrides,
  };
  const saved = () => log.filter(([what]) => what === 'save').map(([, cursor]) => cursor);
  const fetched = () => log.filter(([what]) => what === 'fetch').map(([, from]) => from);
  return { deps, log, saved, fetched };
}

/* ── What a failure costs the saved link ──────────────────────────────── */

test('a link Graph says has gone is dropped at once', () => {
  assert.deepEqual(d.afterFolderFailure({ link: LINK(1), failures: 0 }, graphError(410)), FRESH);
});

test('a link Graph refuses gets three tries, then a fresh start', () => {
  const first = d.afterFolderFailure({ link: LINK(1), failures: 0 }, graphError(400));
  assert.deepEqual(first, { link: LINK(1), failures: 1 });
  const second = d.afterFolderFailure(first, graphError(404));
  assert.deepEqual(second, { link: LINK(1), failures: 2 });
  assert.deepEqual(d.afterFolderFailure(second, graphError(400)), FRESH);
});

test('a link the guard will not follow is treated like one Graph refuses', () => {
  assert.deepEqual(
    d.afterFolderFailure({ link: LINK(1), failures: 2 }, new Error('Graph call not allowed: GET https://elsewhere')),
    FRESH,
  );
});

test('an outage, a rate limit, a lost grant or a database error never costs the link', () => {
  const cursor = { link: LINK(1), failures: 1 };
  for (const err of [graphError(401), graphError(403), graphError(429), graphError(500), graphError(503),
                     new Error('store_mail_batch: deadlock detected'), 'a string', null]) {
    assert.deepEqual(d.afterFolderFailure(cursor, err), cursor, String(err && err.message || err));
  }
});

test('a fresh start that fails has no link to lose', () => {
  assert.deepEqual(d.afterFolderFailure(FRESH, graphError(400)), FRESH);
  assert.deepEqual(d.afterFolderFailure(FRESH, graphError(410)), FRESH);
});

/* ── Walking a folder ─────────────────────────────────────────────────── */

test('every page is stored, then saved, before the next is fetched', async () => {
  const h = harness((from) => from === null
    ? { items: [1, 2], removed: 0, nextLink: LINK(2), deltaLink: null }
    : { items: [3], removed: 1, nextLink: null, deltaLink: DONE });
  const result = await d.syncFolder(FRESH, h.deps, 10);

  assert.deepEqual(h.log, [
    ['fetch', null], ['store', 2], ['save', { link: LINK(2), failures: 0 }],
    ['fetch', LINK(2)], ['store', 1], ['save', { link: DONE, failures: 0 }],
  ]);
  assert.deepEqual({ ...result }, {
    threads: 3, messages: 3, routedToTickets: 0, removed: 1, pages: 2,
    caughtUp: true, restarted: false, error: null,
  });
});

test('a run that reaches its page limit stops where it is, to carry on next time', async () => {
  const h = harness((from, call) => ({ items: [call], removed: 0, nextLink: LINK(call + 1), deltaLink: null }));
  const result = await d.syncFolder({ link: LINK(1), failures: 0 }, h.deps, 3);

  assert.deepEqual(h.fetched(), [LINK(1), LINK(2), LINK(3)]);
  assert.deepEqual(h.saved().at(-1), { link: LINK(4), failures: 0 });
  assert.equal(result.caughtUp, false);
  assert.equal(result.pages, 3);
});

test('a link that has gone starts the folder again, once, in the same run', async () => {
  const h = harness((from) => {
    if (from === LINK(9)) throw graphError(410);
    return { items: [1], removed: 0, nextLink: null, deltaLink: DONE };
  });
  const result = await d.syncFolder({ link: LINK(9), failures: 0 }, h.deps, 10);

  assert.deepEqual(h.fetched(), [LINK(9), null]);
  assert.deepEqual(h.saved(), [FRESH, { link: DONE, failures: 0 }]);
  assert.equal(result.restarted, true);
  assert.equal(result.caughtUp, true);
  assert.equal(result.error, null);
});

test('a fresh round that fails as well is reported, not retried in a loop', async () => {
  const h = harness(() => { throw graphError(410); });
  const result = await d.syncFolder({ link: LINK(9), failures: 0 }, h.deps, 10);

  assert.deepEqual(h.fetched(), [LINK(9), null]);
  assert.match(result.error, /410/);
  assert.equal(result.caughtUp, false);
  assert.equal(result.restarted, true);
});

test('a refused link keeps its place, and counts the failure', async () => {
  const h = harness(() => { throw graphError(400); });
  const result = await d.syncFolder({ link: LINK(5), failures: 0 }, h.deps, 10);

  assert.deepEqual(h.fetched(), [LINK(5)]);
  assert.deepEqual(h.saved(), [{ link: LINK(5), failures: 1 }]);
  assert.match(result.error, /400/);
  assert.equal(result.restarted, false);
});

test('an outage saves nothing, and loses nothing', async () => {
  const h = harness(() => { throw graphError(503); });
  const result = await d.syncFolder({ link: LINK(5), failures: 2 }, h.deps, 10);

  assert.deepEqual(h.saved(), []);
  assert.match(result.error, /503/);
});

test('a page that cannot be stored is not skipped', async () => {
  const h = harness(() => ({ items: [1], removed: 0, nextLink: LINK(6), deltaLink: null }), {
    store: async () => { throw new Error('store_mail_batch: deadlock detected'); },
  });
  const result = await d.syncFolder({ link: LINK(5), failures: 0 }, h.deps, 10);

  assert.deepEqual(h.saved(), [], 'the link still points at the page that was not stored');
  assert.match(result.error, /deadlock/);
  assert.equal(result.messages, 0);
});

test('what was stored before a failure still counts, and stays saved', async () => {
  const h = harness((from) => {
    if (from === LINK(2)) throw graphError(503);
    return { items: [1, 2], removed: 0, nextLink: LINK(2), deltaLink: null };
  });
  const result = await d.syncFolder({ link: LINK(1), failures: 0 }, h.deps, 10);

  assert.deepEqual(h.saved(), [{ link: LINK(2), failures: 0 }]);
  assert.equal(result.messages, 2);
  assert.equal(result.caughtUp, false);
  assert.match(result.error, /503/);
});

test('a cursor that cannot be saved stops the folder rather than running ahead of it', async () => {
  const h = harness(() => ({ items: [1], removed: 0, nextLink: LINK(3), deltaLink: null }), {
    save: async () => { throw new Error('Could not save how far the sync got: timeout'); },
  });
  const result = await d.syncFolder({ link: LINK(2), failures: 0 }, h.deps, 10);

  assert.equal(result.pages, 1);
  assert.match(result.error, /Could not save/);
});
