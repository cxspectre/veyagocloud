/* Tests for _shared/mail-store.ts — the decisions a sync makes around storing
   mail. Which folder a conversation belongs in and whether it is read are made
   in the database (store_mail_batch, 0038), atomically and from every stored
   message, and tested in supabase/tests/03-sync-path.sql. What stays here is
   what the function decides before and after that call. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mail-store.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('a refused grant needs a person to reconnect; anything else is worth retrying', () => {
  assert.equal(m.failureStatus('Microsoft refused the refresh: AADSTS70000: invalid_grant'), 'needs_reauth');
  assert.equal(m.failureStatus('Microsoft refused the refresh: interaction_required'), 'needs_reauth');
  assert.equal(m.failureStatus('That connection has no credentials. Connect it again.'), 'needs_reauth');
  assert.equal(m.failureStatus('That connection cannot refresh itself. Connect it again.'), 'needs_reauth');
  assert.equal(m.failureStatus('Could not read the credentials: connection reset'), 'error',
    'a database hiccup is not a revoked grant — needs_reauth takes a mailbox off the schedule');
  assert.equal(m.failureStatus('Could not store the refreshed token: timeout'), 'error');
  assert.equal(m.failureStatus('Graph → 503: Service Unavailable'), 'error');
  assert.equal(m.failureStatus(''), 'error');
});

test('our own addresses are the mailbox and whoever consented to reading it', () => {
  assert.deepEqual(m.ownAddresses({ account_label: 'hello@veyago.cloud', external_id: 'Cassian@Veyago.cloud' }),
    ['hello@veyago.cloud', 'cassian@veyago.cloud']);
  assert.deepEqual(m.ownAddresses({ account_label: 'me@veyago.cloud', external_id: 'ME@veyago.cloud' }),
    ['me@veyago.cloud']);
  assert.deepEqual(m.ownAddresses({ account_label: 'me@veyago.cloud', external_id: null }), ['me@veyago.cloud']);
});

const NOW = Date.parse('2026-09-13T12:00:00Z');

test('an incremental sync starts a little before the last one ended', () => {
  assert.equal(m.syncWindowStart('2026-09-13T11:55:00Z', NOW), '2026-09-13T11:45:00.000Z');
});

test('a first sync looks back three days, and a long outage at most fourteen', () => {
  assert.equal(m.syncWindowStart(null, NOW), '2026-09-10T12:00:00.000Z');
  assert.equal(m.syncWindowStart('not a date', NOW), '2026-09-10T12:00:00.000Z');
  assert.equal(m.syncWindowStart('2026-08-01T00:00:00Z', NOW), '2026-08-30T12:00:00.000Z');
});

test('a last-synced time in the future does not skip mail', () => {
  assert.equal(m.syncWindowStart('2026-09-14T00:00:00Z', NOW), '2026-09-13T11:50:00.000Z');
});

test('mail found in Sent is ours, whatever its From says', () => {
  assert.equal(m.directionFor('sentitems', 'inbound'), 'outbound',
    'a reply sent as hello@ lands in a personal Sent folder with a From that is not the personal label');
  assert.equal(m.directionFor('inbox', 'inbound'), 'inbound');
  assert.equal(m.directionFor('inbox', 'outbound'), 'outbound');
  assert.equal(m.directionFor('archive', 'inbound'), 'inbound');
});
