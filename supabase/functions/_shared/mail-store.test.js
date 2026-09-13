/* Tests for _shared/mail-store.ts — the rules a sync follows when it sees a
   conversation again. A thread is one row per conversation, but Graph returns
   a conversation's messages from whichever folder they sit in; without these
   rules, syncing Sent Items pulls every conversation we have replied to out of
   the inbox, and a thread reads as "read" because its newest message is ours. */
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

test('mail from outside keeps a conversation in the inbox', () => {
  assert.equal(m.mergedFolder('inbox', 'sent'), 'inbox',
    'our reply sitting in Sent must not pull the conversation out of the inbox');
  assert.equal(m.mergedFolder('sent', 'inbox'), 'inbox',
    'an answer to something we sent lands in the inbox');
});

test('a conversation seen for the first time takes the folder it was found in', () => {
  assert.equal(m.mergedFolder(null, 'sent'), 'sent');
  assert.equal(m.mergedFolder(undefined, 'inbox'), 'inbox');
});

test('a sent copy never moves a conversation that was filed elsewhere', () => {
  assert.equal(m.mergedFolder('archive', 'sent'), 'archive');
});

test('a conversation is unread while any message from outside is unread', () => {
  assert.equal(m.threadIsRead([
    { direction: 'inbound', is_read: true },
    { direction: 'inbound', is_read: false },
  ]), false);
  assert.equal(m.threadIsRead([{ direction: 'outbound', is_read: false }]), true,
    'our own mail is never waiting for us');
  assert.equal(m.threadIsRead([]), true);
});

test('messages group by conversation, keeping the order Graph returned', () => {
  const groups = m.groupByThread([
    { thread_external_id: 'A', external_id: '1' },
    { thread_external_id: 'B', external_id: '2' },
    { thread_external_id: 'A', external_id: '3' },
  ]);
  assert.deepEqual([...groups.keys()], ['A', 'B']);
  assert.deepEqual(groups.get('A').map((r) => r.external_id), ['1', '3']);
});
