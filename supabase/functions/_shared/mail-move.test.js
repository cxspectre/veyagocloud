/* Tests for _shared/mail-move.ts — where a conversation may go, and which of
   its messages actually go there. The rules worth holding onto: only the three
   folders the owner named (2026-09-21), only messages still in a folder the
   workspace lists, and junk never carries our own replies along with it. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mail-move.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const msg = (id, folder, direction) => ({ id, external_id: `graph-${id}`, folder, direction });

test('the workspace folder words map onto Graph\'s own names, and nothing else does', () => {
  assert.equal(m.graphDestination('archive'), 'archive');
  assert.equal(m.graphDestination('spam'), 'junkemail');
  assert.equal(m.graphDestination('trash'), 'deleteditems');
  assert.equal(m.graphDestination('TRASH'), 'deleteditems');
  for (const to of ['inbox', 'sent', 'starred', 'junkemail', 'deleteditems', '', null, undefined]) {
    assert.equal(m.graphDestination(to), null, String(to));
  }
});

test('the three the owner named are the three on offer', () => {
  assert.deepEqual([...m.MOVE_TO].sort(), ['archive', 'spam', 'trash']);
});

test('only messages still in a folder the workspace lists are moved', () => {
  const messages = [
    msg('a', 'inbox', 'inbound'),
    msg('b', 'sent', 'outbound'),
    msg('c', 'archive', 'inbound'),      // the sync filed it already (0045)
    msg('d', 'trash', 'inbound'),
    msg('e', 'spam', 'inbound'),
  ];
  assert.deepEqual(m.messagesToMove(messages, 'archive').map((x) => x.id), ['a', 'b']);
  assert.deepEqual(m.messagesToMove(messages, 'trash').map((x) => x.id), ['a', 'b']);
});

/* Marking our own reply as junk teaches Outlook that our own address sends
   junk — which then filters our mail for the recipient too, not only for us. */
test('junk takes only mail from outside; archive and delete take our side too', () => {
  const messages = [msg('in', 'inbox', 'inbound'), msg('out', 'sent', 'outbound')];
  assert.deepEqual(m.messagesToMove(messages, 'spam').map((x) => x.id), ['in']);
  assert.deepEqual(m.messagesToMove(messages, 'archive').map((x) => x.id), ['in', 'out']);
  assert.deepEqual(m.messagesToMove(messages, 'trash').map((x) => x.id), ['in', 'out']);
});

test('a destination that is not one of the three moves nothing at all', () => {
  const messages = [msg('a', 'inbox', 'inbound')];
  for (const to of ['inbox', 'deleteditems', 'recoverable', '', null]) {
    assert.deepEqual(m.messagesToMove(messages, to), [], String(to));
  }
});

test('nothing to move is an answer, not silence', () => {
  assert.deepEqual(m.messagesToMove([], 'archive'), []);
  assert.deepEqual(m.messagesToMove(null, 'archive'), []);
  assert.match(m.nothingToMoveNote('archive'), /already archived/);
  assert.match(m.nothingToMoveNote('spam'), /already marked as junk/);
  assert.match(m.nothingToMoveNote('trash'), /already in Deleted Items/);
});
