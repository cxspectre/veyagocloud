/* Tests for _shared/mail-read-state.ts — which messages a read or starred
   change in update-mail-state actually has to reach.

   update-mail-state used to send Outlook the first fifty of a thread's
   messages, cap there (MAX_MESSAGES), and then mark every one of them read in
   the database regardless — a long thread reported success while most of it
   stayed unread in Outlook, a mismatch nothing but a full resync would ever
   notice. What is here decides the targets from the messages' own current
   state, so update-mail-state can patch exactly what changed in Outlook and
   write the database to match — no more, no less — and a second call (for
   whatever a time budget cut short) asks for only what is left. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mail-read-state.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const msg = (id, direction, is_read, is_flagged) => ({ id, external_id: 'x-' + id, direction, is_read, is_flagged });

/* ── messagesToMarkRead ──────────────────────────────────────────────── */

test('marking read (or unread) only ever touches mail from outside', () => {
  const messages = [
    msg('in-1', 'inbound', false, false),
    msg('out-1', 'outbound', false, false),
  ];
  assert.deepEqual(m.messagesToMarkRead(messages, true).map((x) => x.id), ['in-1'],
    'an outbound copy has no "unread" in Outlook\'s sense');
});

test('read is undefined: nothing to mark', () => {
  assert.deepEqual(m.messagesToMarkRead([msg('a', 'inbound', false, false)], undefined), []);
});

test('a message already at the wanted state is not a target — a repeat click, or the rest of an earlier call, costs nothing', () => {
  const messages = [
    msg('a', 'inbound', true, false),
    msg('b', 'inbound', false, false),
    msg('c', 'inbound', true, false),
  ];
  assert.deepEqual(m.messagesToMarkRead(messages, true).map((x) => x.id), ['b'],
    'a and c are already read; only b needs Outlook told');
  assert.deepEqual(m.messagesToMarkRead(messages, false).map((x) => x.id), ['a', 'c']);
});

test('an empty thread, or one with nothing from outside, marks nothing', () => {
  assert.deepEqual(m.messagesToMarkRead([], true), []);
  assert.deepEqual(m.messagesToMarkRead([msg('a', 'outbound', false, false)], true), []);
});

/* ── messageToFlag / messagesToFlag ─────────────────────────────────── */

test('starring flags the newest message from outside; a thread that is only ours flags its own newest', () => {
  const withInbound = [msg('out-1', 'outbound', true, false), msg('in-1', 'inbound', true, false)];
  assert.equal(m.messageToFlag(withInbound).id, 'in-1');

  const onlyOurs = [msg('out-1', 'outbound', true, false), msg('out-2', 'outbound', true, false)];
  assert.equal(m.messageToFlag(onlyOurs).id, 'out-1', 'the first in the given (newest-first) order');

  assert.equal(m.messageToFlag([]), null);
});

test('messagesToFlag targets only that one message, and only when it is not flagged already', () => {
  const notFlagged = [msg('in-1', 'inbound', true, false)];
  assert.deepEqual(m.messagesToFlag(notFlagged, true).map((x) => x.id), ['in-1']);

  const alreadyFlagged = [msg('in-1', 'inbound', true, true)];
  assert.deepEqual(m.messagesToFlag(alreadyFlagged, true), [], 'already starred: nothing to send');

  assert.deepEqual(m.messagesToFlag([msg('in-1', 'inbound', true, false)], false), [], 'starred is false, not true: not a flag request');
  assert.deepEqual(m.messagesToFlag([msg('in-1', 'inbound', true, false)], undefined), []);
  assert.deepEqual(m.messagesToFlag([], true), [], 'nothing to flag in an empty thread');
});

/* ── messagesToUnflag ────────────────────────────────────────────────── */

test('un-starring clears every flag in the conversation, not only the newest', () => {
  const messages = [
    msg('a', 'inbound', true, true),
    msg('b', 'outbound', true, false),
    msg('c', 'inbound', true, true),
  ];
  assert.deepEqual(m.messagesToUnflag(messages, false).map((x) => x.id).sort(), ['a', 'c'],
    'leaving an older flag would let the next sync find it and star the thread again');
});

test('un-starring also reaches the newest message even when it was never flagged', () => {
  const messages = [msg('out-1', 'outbound', true, false), msg('in-1', 'inbound', true, false)];
  assert.deepEqual(m.messagesToUnflag(messages, false).map((x) => x.id), ['in-1'],
    'the same message starring would have used, cleared defensively even though nothing here says it is flagged');
});

test('un-starring only runs when starred is exactly false', () => {
  assert.deepEqual(m.messagesToUnflag([msg('a', 'inbound', true, true)], true), []);
  assert.deepEqual(m.messagesToUnflag([msg('a', 'inbound', true, true)], undefined), []);
});
