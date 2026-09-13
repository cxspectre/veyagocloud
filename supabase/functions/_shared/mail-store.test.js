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
  assert.equal(m.failureStatus('Microsoft refused the refresh (invalid_grant): AADSTS700082: expired'), 'needs_reauth');
  assert.equal(m.failureStatus('Microsoft refused the refresh (interaction_required): consent'), 'needs_reauth');
  assert.equal(m.failureStatus('That connection has no credentials. Connect it again.'), 'needs_reauth');
  assert.equal(m.failureStatus('That connection cannot refresh itself. Connect it again.'), 'needs_reauth');
  assert.equal(m.failureStatus('Could not read the credentials: connection reset'), 'error',
    'a database hiccup is not a revoked grant — needs_reauth takes a mailbox off the schedule');
  assert.equal(m.failureStatus('Microsoft could not refresh the token (temporarily_unavailable): try again'), 'error');
  assert.equal(m.failureStatus('Graph → 503: Service Unavailable'), 'error');
  assert.equal(m.failureStatus(''), 'error');
});

test('our own address is the mailbox itself, not whoever consented to reading it', () => {
  assert.deepEqual(m.ownAddresses({ account_label: 'Hello@Veyago.cloud', external_id: 'cassian@veyago.cloud' }),
    ['hello@veyago.cloud'],
    'mail the consenting person sends TO the shared inbox is mail from outside it; replies sent AS it are caught by directionFor');
  assert.deepEqual(m.ownAddresses({ account_label: ' me@veyago.cloud ', external_id: null }), ['me@veyago.cloud']);
});

test('mail found in Sent is ours, whatever its From says', () => {
  assert.equal(m.directionFor('sentitems', 'inbound'), 'outbound',
    'a reply sent as hello@ lands in a personal Sent folder with a From that is not the personal label');
  assert.equal(m.directionFor('inbox', 'inbound'), 'inbound');
  assert.equal(m.directionFor('inbox', 'outbound'), 'outbound');
  assert.equal(m.directionFor('archive', 'inbound'), 'inbound');
});

const INBOX_LINK = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=A';
const SENT_LINK = 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$skiptoken=B';

test('delta links are kept per folder, together', () => {
  const one = m.withCursor(null, 'inbox', INBOX_LINK);
  const two = m.withCursor(one, 'sentitems', SENT_LINK);
  assert.deepEqual(m.readCursors(two), { inbox: INBOX_LINK, sentitems: SENT_LINK });
  assert.deepEqual(m.readCursors(m.withCursor(two, 'inbox', null)), { sentitems: SENT_LINK },
    'clearing one folder leaves the other where it was');
});

test('no cursor, or one that is not ours to read, is a fresh start', () => {
  assert.deepEqual(m.readCursors(null), {});
  assert.deepEqual(m.readCursors(''), {});
  assert.deepEqual(m.readCursors('not json'), {});
  assert.deepEqual(m.readCursors('["x"]'), {});
  assert.deepEqual(m.readCursors('"a string"'), {});
});

test('a cursor that is not a Graph link is ignored, never followed', () => {
  assert.deepEqual(m.readCursors(JSON.stringify({
    inbox: 'https://evil.example/v1.0/me/mailFolders/inbox/messages/delta',
    sentitems: 42,
    archive: 'http://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta',
  })), {});
});

const NOW = Date.parse('2026-09-13T12:00:00Z');

test('a first delta sync starts three days back', () => {
  assert.equal(m.firstSyncSince(NOW), '2026-09-10T12:00:00.000Z');
});
