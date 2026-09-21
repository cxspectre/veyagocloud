/* Tests for _shared/calendar-response.ts — 0068's side of answering an
   invitation: what a caller may say, where the reply is sent, and the four
   reasons there is nothing to answer.

   Not tested here: the POST itself, which needs a live Microsoft tenant — the
   same boundary update-calendar-event and delete-calendar-event already stop
   at (see their headers). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'calendar-response.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* An invitation waiting to be answered — the ordinary case every refusal below
   is a departure from. */
const INVITED = { isCancelled: false, isOrganizer: false, responseStatus: { response: 'notResponded' } };

/* ── responseStatusOf ─────────────────────────────────────────────────── */

test('Graph’s six words come back unchanged, and nothing else does', () => {
  for (const word of ['none', 'organizer', 'tentativelyAccepted', 'accepted', 'declined', 'notResponded']) {
    assert.equal(m.responseStatusOf(word), word);
  }
  assert.equal(m.responseStatusOf('maybe'), 'none', 'a word Graph never sends');
  assert.equal(m.responseStatusOf('Accepted'), 'none', 'Graph’s own spelling, or nothing');
  assert.equal(m.responseStatusOf(undefined), 'none');
  assert.equal(m.responseStatusOf(null), 'none');
});

/* ── responseAction ───────────────────────────────────────────────────── */

test('the three answers a person may send map to Graph’s own actions', () => {
  assert.equal(m.responseAction('accepted'), 'accept');
  assert.equal(m.responseAction('tentativelyAccepted'), 'tentativelyAccept');
  assert.equal(m.responseAction('declined'), 'decline');
});

test('a state Graph puts you in is not an answer you can give', () => {
  assert.equal(m.responseAction('organizer'), null);
  assert.equal(m.responseAction('notResponded'), null);
  assert.equal(m.responseAction('none'), null);
});

test('a spelling the database would refuse is refused before the request is built', () => {
  /* calendar_events_response_status_known (0068) checks the same six words, so
     letting 'TENTATIVE' through here would only move the failure downstream. */
  assert.equal(m.responseAction('TENTATIVE'), null);
  assert.equal(m.responseAction('tentative'), null);
  assert.equal(m.responseAction(''), null);
  assert.equal(m.responseAction(undefined), null);
  assert.equal(m.responseAction({ response: 'accepted' }), null);
});

/* ── responseRefusal ──────────────────────────────────────────────────── */

test('an invitation waiting for an answer can be answered', () => {
  assert.equal(m.responseRefusal(INVITED), null);
  assert.equal(m.responseRefusal({ ...INVITED, responseStatus: { response: 'accepted' } }), null,
    'changing your mind is still answering');
});

test('a meeting cancelled since the last sync is refused, not cheerfully accepted', () => {
  const why = m.responseRefusal({ ...INVITED, isCancelled: true });
  assert.match(String(why), /cancelled/i);
});

test('an organiser has no invitation to answer, whichever way Graph says so', () => {
  assert.match(String(m.responseRefusal({ ...INVITED, isOrganizer: true })), /organised/i);
  assert.match(String(m.responseRefusal({ isCancelled: false, responseStatus: { response: 'organizer' } })), /organised/i);
});

test('an appointment nobody was invited to is not an invitation', () => {
  assert.match(String(m.responseRefusal({ isCancelled: false, responseStatus: { response: 'none' } })), /not an invitation/i);
  assert.match(String(m.responseRefusal({})), /not an invitation/i, 'no responseStatus at all reads as none');
});

test('a private meeting in the STUDIO calendar cannot be answered in the studio’s name', () => {
  for (const sensitivity of ['personal', 'private', 'confidential', 'PRIVATE']) {
    assert.match(String(m.responseRefusal({ ...INVITED, sensitivity }, true)), /private/i, sensitivity);
  }
});

test('the same meeting in your OWN calendar is yours to answer — it was never hidden from you', () => {
  assert.equal(m.responseRefusal({ ...INVITED, sensitivity: 'private' }, false), null);
  assert.equal(m.responseRefusal({ ...INVITED, sensitivity: 'private' }), null, 'studio defaults to false');
});

test('an ordinary meeting in the studio calendar is still answerable', () => {
  assert.equal(m.responseRefusal({ ...INVITED, sensitivity: 'normal' }, true), null);
});

test('a recurring occurrence is answerable, unlike an edit — the two guards differ on purpose', () => {
  /* calendar-event-guard.ts's eventChangeRefusal refuses every one of these,
     because editing one occurrence means writing an exception back. Graph's
     accept/decline work on an occurrence exactly as on a single meeting. */
  for (const type of ['occurrence', 'exception', 'seriesMaster']) {
    assert.equal(m.responseRefusal({ ...INVITED, type }), null, type);
  }
});

/* ── responseTarget ───────────────────────────────────────────────────── */

test('answering this occurrence sends to this occurrence', () => {
  assert.equal(m.responseTarget('occurrence', { external_id: 'occ-2', series_master_id: 'master-1' }), 'occ-2');
  assert.equal(m.responseTarget(undefined, { external_id: 'occ-2', series_master_id: 'master-1' }), 'occ-2');
});

test('answering the series sends to its master, which every occurrence already knows', () => {
  assert.equal(m.responseTarget('series', { external_id: 'occ-2', series_master_id: 'master-1' }), 'master-1');
});

test('a meeting with no series answers for itself, rather than refusing', () => {
  assert.equal(m.responseTarget('series', { external_id: 'one-off', series_master_id: null }), 'one-off');
  assert.equal(m.responseTarget('series', { external_id: 'one-off' }), 'one-off');
});

/* ── respondPayload ───────────────────────────────────────────────────── */

test('the organiser is told by default, because one who is not cannot plan a room', () => {
  assert.deepEqual(m.respondPayload(), { sendResponse: true });
  assert.deepEqual(m.respondPayload({}), { sendResponse: true });
  assert.deepEqual(m.respondPayload({ sendResponse: false }), { sendResponse: false });
});

test('a note is trimmed, and an empty one is left out rather than sent as an empty paragraph', () => {
  assert.deepEqual(m.respondPayload({ comment: '  Can we start at ten?  ' }),
    { comment: 'Can we start at ten?', sendResponse: true });
  assert.deepEqual(m.respondPayload({ comment: '   ' }), { sendResponse: true });
  assert.deepEqual(m.respondPayload({ comment: null }), { sendResponse: true });
});

test('a note arriving from a browser form is capped rather than forwarded whole', () => {
  const payload = m.respondPayload({ comment: 'x'.repeat(m.MAX_COMMENT + 500) });
  assert.equal(payload.comment.length, m.MAX_COMMENT);
});

/* ── responseFields ───────────────────────────────────────────────────── */

test('the calendar owner’s own answer, and whether they organised it, become two columns', () => {
  assert.deepEqual(m.responseFields({ isOrganizer: false, responseStatus: { response: 'accepted' } }),
    { response_status: 'accepted', is_organizer: false });
  assert.deepEqual(m.responseFields({ isOrganizer: true, responseStatus: { response: 'organizer' } }),
    { response_status: 'organizer', is_organizer: true });
});

test('an event Graph sent no responseStatus for is nobody’s invitation', () => {
  assert.deepEqual(m.responseFields({}), { response_status: 'none', is_organizer: false });
});

test('a private event in the studio calendar says nothing about who answered it', () => {
  assert.deepEqual(
    m.responseFields({ isOrganizer: true, responseStatus: { response: 'accepted' } }, { hidden: true }),
    { response_status: 'none', is_organizer: false });
});
