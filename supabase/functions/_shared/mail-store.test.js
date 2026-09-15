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

test('a refresh failure that says whether it is permanent is believed over its wording', () => {
  assert.equal(m.failureStatusOf({ permanent: false, message: 'Microsoft could not refresh the token (invalid_grant): from a proxy' }),
    'error', 'a 503 whose body happens to say invalid_grant is still an outage');
  assert.equal(m.failureStatusOf({ permanent: true, message: 'anything at all' }), 'needs_reauth');
  assert.equal(m.failureStatusOf(new Error('That connection has no credentials. Connect it again.')), 'needs_reauth');
  assert.equal(m.failureStatusOf(new Error('Graph → 503: Service Unavailable')), 'error');
  assert.equal(m.failureStatusOf('store_mail_batch: deadlock detected'), 'error');
  assert.equal(m.failureStatusOf(null), 'error');
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

/* ── Where the scheduled sync carries on from ─────────────────────────── */

const ME = '/me';
const HELLO = '/users/hello%40veyago.cloud';
const INBOX_LINK = 'https://graph.microsoft.com/v1.0/users/hello%40veyago.cloud/mailFolders/inbox/messages/delta?$deltatoken=A';
const SENT_LINK = 'https://graph.microsoft.com/v1.0/users/hello%40veyago.cloud/mailFolders/sentitems/messages/delta?$skiptoken=B';
const MY_INBOX_LINK = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=C';

test('delta links are kept per folder, together, with how often each has failed', () => {
  const one = m.withCursor(null, HELLO, 'inbox', { link: INBOX_LINK, failures: 0 });
  const two = m.withCursor(one, HELLO, 'sentitems', { link: SENT_LINK, failures: 2 });
  assert.deepEqual(m.readCursors(two, HELLO), {
    inbox: { link: INBOX_LINK, failures: 0 },
    sentitems: { link: SENT_LINK, failures: 2 },
  });
  assert.deepEqual(m.readCursors(m.withCursor(two, HELLO, 'inbox', null), HELLO),
    { sentitems: { link: SENT_LINK, failures: 2 } },
    'clearing one folder leaves the other where it was');
});

test('links made for one mailbox are never followed for another', () => {
  const personal = m.withCursor(null, ME, 'inbox', { link: MY_INBOX_LINK, failures: 0 });
  assert.deepEqual(m.readCursors(personal, HELLO), {},
    'a reconnect that turns /me into the shared mailbox starts again, rather than reading the consenter\'s inbox into it');
  const shared = m.withCursor(personal, HELLO, 'sentitems', { link: SENT_LINK, failures: 0 });
  assert.deepEqual(m.readCursors(shared, HELLO), { sentitems: { link: SENT_LINK, failures: 0 } },
    'writing for the new mailbox drops the old one\'s links');
  assert.deepEqual(m.readCursors(shared, ME), {});
});

test('no cursor, or one that cannot be read, is a fresh start', () => {
  assert.deepEqual(m.readCursors(null, HELLO), {});
  assert.deepEqual(m.readCursors('', HELLO), {});
  assert.deepEqual(m.readCursors('not json', HELLO), {});
  assert.deepEqual(m.readCursors('["x"]', HELLO), {});
  assert.deepEqual(m.readCursors('"a string"', HELLO), {});
  assert.deepEqual(m.readCursors(JSON.stringify({ inbox: INBOX_LINK }), HELLO), {},
    'a cursor that does not say which mailbox it is for is nobody\'s');
  assert.deepEqual(m.readCursors(JSON.stringify({ mailbox: HELLO, folders: [INBOX_LINK] }), HELLO), {});
});

test('a cursor that is not a Graph link is ignored, never followed', () => {
  assert.deepEqual(m.readCursors(JSON.stringify({
    mailbox: HELLO,
    folders: {
      inbox: { link: 'https://evil.example/v1.0/me/mailFolders/inbox/messages/delta', failures: 0 },
      sentitems: { link: 42, failures: 0 },
      archive: { link: 'http://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta', failures: 0 },
    },
  }), HELLO), {});
});

test('a failure count that is not a small whole number counts as none', () => {
  const raw = (failures) => JSON.stringify({ mailbox: HELLO, folders: { inbox: { link: INBOX_LINK, failures } } });
  for (const bad of [-3, 2.5, '2', null, Infinity]) {
    assert.deepEqual(m.readCursors(raw(bad), HELLO), { inbox: { link: INBOX_LINK, failures: 0 } }, `failures: ${bad}`);
  }
});

test('the runs spent asking Graph about a page are kept with its link, and none is left out', () => {
  const asking = m.withCursor(null, HELLO, 'inbox', { link: INBOX_LINK, failures: 1, asks: 3 });
  assert.deepEqual(m.readCursors(asking, HELLO), { inbox: { link: INBOX_LINK, failures: 1, asks: 3 } });
  const moved = m.withCursor(asking, HELLO, 'inbox', { link: INBOX_LINK, failures: 0, asks: 0 });
  assert.equal(moved.includes('asks'), false, 'a place with no asks is kept as it always was');
  const raw = (asks) => JSON.stringify({ mailbox: HELLO, folders: { inbox: { link: INBOX_LINK, failures: 0, asks } } });
  for (const bad of [-1, 1.5, '3', null]) {
    assert.deepEqual(m.readCursors(raw(bad), HELLO), { inbox: { link: INBOX_LINK, failures: 0 } }, `asks: ${bad}`);
  }
});

const NOW = Date.parse('2026-09-13T12:00:00Z');

test('a round starts three days back, or where the last sync left off, but never more than fourteen', () => {
  assert.equal(m.roundStart(NOW, null), '2026-09-10T12:00:00.000Z', 'never synced');
  assert.equal(m.roundStart(NOW, 'not a date'), '2026-09-10T12:00:00.000Z');
  assert.equal(m.roundStart(NOW, '2026-09-13T11:55:00Z'), '2026-09-10T12:00:00.000Z', 'synced a moment ago');
  assert.equal(m.roundStart(NOW, '2026-09-06T12:00:00Z'), '2026-09-06T11:50:00.000Z',
    'away for a week, waiting to be reconnected: from just before the last sync, so the gap is not lost');
  assert.equal(m.roundStart(NOW, '2026-08-01T00:00:00Z'), '2026-08-30T12:00:00.000Z',
    'away for weeks: fourteen days, and a manual sync for the rest');
});
