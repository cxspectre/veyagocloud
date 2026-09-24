/* Tests for _shared/inbox-sweep.ts — keeping the workspace inbox to what
   Outlook's holds. Filing mail away on a wrong answer hides a customer's email
   while it sits unread in Outlook, and dropping a removal leaves it pinned in
   the inbox for good — so what these guard is that nothing is filed on a guess,
   and nothing confirmed or still to ask about is lost. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'inbox-sweep.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const NOW = Date.parse('2026-09-14T12:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms).toISOString();

/* ── When, and how far back ───────────────────────────────────────────── */

test('the comparison is due once a day, and at once when it has never run', () => {
  assert.equal(m.sweepDue(NOW, null), true);
  assert.equal(m.sweepDue(NOW, 'not a date'), true);
  assert.equal(m.sweepDue(NOW, ago(23 * HOUR)), false);
  assert.equal(m.sweepDue(NOW, ago(24 * HOUR)), true);
});

test('a listing holds the whole inbox when it ran out, or else back to the oldest message in it', () => {
  assert.equal(m.coveredSince({ receivedAt: [ago(DAY)], complete: true }), '-infinity');
  assert.equal(m.coveredSince({ receivedAt: [], complete: true }), '-infinity', 'an inbox emptied in Outlook is all of it');
  assert.equal(m.coveredSince({ receivedAt: [ago(2 * DAY), ago(90 * DAY), ago(4 * DAY)], complete: false }), ago(90 * DAY));
  assert.equal(m.coveredSince({ receivedAt: [], complete: false }), null, 'nothing listed holds nothing');
});

test('"not now" is a rate limit, an outage, an expired token or no answer; "no" is a refusal', () => {
  for (const status of [401, 429, 500, 503]) assert.equal(m.isTransient({ status }), true, String(status));
  assert.equal(m.isTransient(new Error('fetch failed')), true);
  for (const status of [400, 403, 404]) assert.equal(m.isTransient({ status }), false, String(status));
  assert.equal(m.isTransient(new Error('Graph call not allowed: GET https://elsewhere')), false,
    'a call the guard will not make would be refused again');
});

/* ── Asking Graph ─────────────────────────────────────────────────────── */

function graph(folders, overrides = {}) {
  const asked = [];
  return {
    asked,
    inboxId: async () => 'INBOX',
    folderOf: async (id) => {
      asked.push(id);
      const answer = folders[id];
      if (answer instanceof Error) throw answer;
      return answer === undefined ? null : answer;
    },
    ...overrides,
  };
}

const throttled = () => Object.assign(new Error('Graph → 429: slow down'), { status: 429 });
const denied = () => Object.assign(new Error('Graph → 403: denied'), { status: 403 });

test('a message Graph still finds in the inbox stays; one it cannot find, or finds elsewhere, has gone', async () => {
  const asked = await m.goneFromInbox(['here', 'archived', 'deleted'], graph({ here: 'INBOX', archived: 'ARCHIVE', deleted: null }));
  assert.deepEqual(asked, { gone: ['archived', 'deleted'], refused: [], unasked: [], error: null, refusal: null });
});

test('a message found without a folder is kept: that is not an answer', async () => {
  assert.deepEqual((await m.goneFromInbox(['odd'], graph({ odd: '' }))).gone, []);
});

test('a failure keeps what was already confirmed, and hands back what was not answered', async () => {
  const refusal = throttled();
  const asked = await m.goneFromInbox(['a', 'b', 'c', 'd', 'e'], graph({ a: null, b: refusal, c: 'ARCHIVE', d: null, e: null }), { atOnce: 3 });
  assert.deepEqual(asked.gone, ['a', 'c'], 'the rest of the round still counts');
  assert.deepEqual(asked.unasked, ['b', 'd', 'e']);
  assert.equal(asked.error, refusal);
});

test('a refusal keeps that message, and the rest are still asked about', async () => {
  const first = denied();
  const g = graph({ a: null, b: first, c: 'ARCHIVE', d: null, e: denied() });
  const asked = await m.goneFromInbox(['a', 'b', 'c', 'd', 'e'], g, { atOnce: 2 });
  assert.deepEqual(asked.gone, ['a', 'c', 'd']);
  assert.deepEqual(asked.refused, ['b', 'e']);
  assert.deepEqual(asked.unasked, []);
  assert.equal(asked.error, null, 'a refusal does not stop the asking: stopping left everything after it unasked, run after run');
  assert.equal(asked.refusal, first, 'the first refusal says why');
  assert.deepEqual(g.asked, ['a', 'b', 'c', 'd', 'e']);
});

test('an inbox Graph will not show keeps everything; one it cannot show now leaves everything to ask', async () => {
  const refused = await m.goneFromInbox(['a', 'b'], graph({}, { inboxId: async () => { throw denied(); } }));
  assert.deepEqual(refused.refused, ['a', 'b']);
  assert.deepEqual(refused.unasked, []);
  assert.equal(refused.error, null);
  const later = await m.goneFromInbox(['a', 'b'], graph({}, { inboxId: async () => { throw throttled(); } }));
  assert.deepEqual(later.unasked, ['a', 'b']);
  assert.deepEqual(later.refused, []);
  assert.equal(later.error.status, 429);
});

test('without the inbox\'s own id nothing is compared, and everything waits', async () => {
  const asked = await m.goneFromInbox(['a', 'b'], graph({}, { inboxId: async () => '' }));
  assert.deepEqual(asked.gone, []);
  assert.deepEqual(asked.unasked, ['a', 'b']);
  assert.match(String(asked.error.message), /inbox/);
});

test('when the run\'s time is up, nothing more is asked and the rest waits', async () => {
  let clock = 0;
  const g = graph({ a: null, b: null, c: null, d: null });
  const timed = { ...g, folderOf: async (id) => { clock += 10; return g.folderOf(id); } };
  const asked = await m.goneFromInbox(['a', 'b', 'c', 'd'], timed, { atOnce: 2, deadline: 15, now: () => clock });
  assert.deepEqual(asked, { gone: ['a', 'b'], refused: [], unasked: ['c', 'd'], error: null, refusal: null });
});

test('each message is asked about once, and no messages ask nothing', async () => {
  const g = graph({});
  assert.deepEqual((await m.goneFromInbox(['a', 'a', '', 'b'], g)).gone, ['a', 'b']);
  assert.deepEqual([...g.asked].sort(), ['a', 'b']);
  let inboxAsked = false;
  const quiet = graph({}, { inboxId: async () => { inboxAsked = true; return 'INBOX'; } });
  assert.deepEqual(await m.goneFromInbox([], quiet), { gone: [], refused: [], unasked: [], error: null, refusal: null });
  assert.equal(inboxAsked, false);
});

test('a few questions at a time: Outlook takes four per mailbox, and the sync is not alone', async () => {
  let running = 0;
  let peak = 0;
  const g = {
    inboxId: async () => 'INBOX',
    folderOf: async (id) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return id === 'c' ? 'INBOX' : null;
    },
  };
  assert.deepEqual((await m.goneFromInbox(['a', 'b', 'c', 'd', 'e', 'f', 'g'], g)).gone, ['a', 'b', 'd', 'e', 'f', 'g']);
  assert.equal(peak, m.ASK_AT_ONCE);
  assert.ok(m.ASK_AT_ONCE < 4);
});

/* ── For the delta ────────────────────────────────────────────────────── */

test('"not now" files what was confirmed and reads the page again; "no" keeps the message and goes on', async () => {
  const warnings = [];
  const warn = (w) => warnings.push(w);

  assert.deepEqual(await m.confirmedGone(['a', 'b'], graph({ a: null, b: throttled() }), {}, warn),
    { gone: ['a'], retry: 'Graph → 429: slow down', waiting: 1 });

  assert.deepEqual(await m.confirmedGone(['a', 'b', 'c', 'd'], graph({ a: null, b: denied(), c: null, d: null }), {}, warn),
    { gone: ['a', 'c', 'd'], retry: null, waiting: 0 }, 'the messages after a refusal are still asked about');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 message\(s\).*403/);

  assert.deepEqual(await m.confirmedGone(['a'], graph({ a: null }), { deadline: 0, now: () => 1 }, warn),
    { gone: [], retry: 'the run’s time was up', waiting: 1 });

  assert.deepEqual(await m.confirmedGone(['a'], graph({ a: 'INBOX' }), {}, warn), { gone: [], retry: null, waiting: 0 });
  assert.equal(warnings.length, 1, 'an answer is not a warning');
});

/* ── Which messages a comparison asks about ───────────────────────────── */

test('a comparison asks about a different stretch of what it found each day, and the same stretch all day', () => {
  const ids = Array.from({ length: 320 }, (_, i) => `m${i}`);
  const first = m.sweepSlice(ids, 0);
  assert.equal(first.length, m.SWEEP_MAX);
  assert.deepEqual(m.sweepSlice(ids, 23 * HOUR), first, 'a run that filed some carries on where it was');
  assert.notDeepEqual(m.sweepSlice(ids, DAY), first,
    'a stretch Graph keeps its answer about no longer holds up everything after it');
  const seen = new Set([...first, ...m.sweepSlice(ids, DAY), ...m.sweepSlice(ids, 2 * DAY)]);
  assert.equal(seen.size, ids.length, 'every message is asked about within as many days as there are stretches');
  assert.deepEqual(m.sweepSlice(ids, 3 * DAY), first);
  assert.deepEqual(m.sweepSlice(ids.slice(0, 10), 5 * DAY), ids.slice(0, 10), 'fewer than a stretch is all of them');
  assert.ok(m.SWEEP_LOOKAHEAD >= m.SWEEP_MAX);
});

/* ── When the comparison runs again ───────────────────────────────────── */

test('due again in a day; in an hour after a pause, or a run out of time that filed nothing; next run while it files', () => {
  assert.equal(m.sweepDueAgainIn({ filed: 3, more: false }), DAY);
  assert.equal(m.sweepDueAgainIn({ filed: 0, more: true }), DAY, 'what Graph kept is not asked about every five minutes');
  assert.equal(m.sweepDueAgainIn({ filed: 1, more: true, retry: true }), HOUR);
  assert.equal(m.sweepDueAgainIn({ filed: 0, more: true, timeUp: true }), HOUR,
    'a run whose time ran out compared nothing: recording a day skipped one');
  assert.equal(m.sweepDueAgainIn({ filed: 5, more: true, timeUp: true }), null, 'it is filing, so the next run carries on');
  assert.equal(m.sweepDueAgainIn({ filed: 5, more: true }), null);
  assert.equal(m.sweepDueAgainIn({ filed: 0, more: false, unavailable: true }), null, 'no comparison was made, so none is recorded');
});

test('a note about unconfirmed mail clears once a day\'s comparison of the whole inbox has asked about everything it found missing', () => {
  const whole = '-infinity';
  assert.equal(m.sweepSettlesNote({ filed: 3, more: false, covered: whole }), true);
  assert.equal(m.sweepSettlesNote({ filed: 0, more: false, covered: whole }), true, 'nothing gone is an answer too');
  assert.equal(m.sweepSettlesNote({ filed: 0, more: false, covered: '2026-03-01T00:00:00.000Z' }), false,
    'the listing stopped at the newest messages, and the mail the note is about may be older');
  assert.equal(m.sweepSettlesNote({ filed: 0, more: false, covered: null }), false, 'nothing was compared');
  assert.equal(m.sweepSettlesNote({ filed: 0, more: true, covered: whole }), false,
    'the rest waits for another day\'s stretch, and the mail the note is about may be in it');
  assert.equal(m.sweepSettlesNote({ filed: 2, more: false, covered: whole, retry: true }), false, 'Graph asked for a pause');
  assert.equal(m.sweepSettlesNote({ filed: 0, more: true, covered: null, timeUp: true }), false, 'the run ran out of time');
  assert.equal(m.sweepSettlesNote({ filed: 5, more: true, covered: whole }), false, 'still filing');
  assert.equal(m.sweepSettlesNote({ filed: 0, more: false, covered: whole, unavailable: true }), false, 'no comparison was made');
});
