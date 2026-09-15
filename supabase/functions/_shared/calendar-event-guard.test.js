/* Tests for _shared/calendar-event-guard.ts — whether a synced event, as
   Graph has it right now, may be changed or removed from the workspace. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'calendar-event-guard.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const PLAIN = { type: 'singleInstance', isCancelled: false, sensitivity: 'normal' };

test('an ordinary, single, live event may be changed', () => {
  assert.equal(m.eventChangeRefusal(PLAIN, true), null);
  assert.equal(m.eventChangeRefusal(PLAIN, false), null);
});

test('a cancelled event is refused, whatever else it is', () => {
  assert.match(m.eventChangeRefusal({ ...PLAIN, isCancelled: true }, true), /already cancelled/);
});

test('every kind of recurring occurrence is refused, only a plain single event goes through', () => {
  assert.match(m.eventChangeRefusal({ ...PLAIN, type: 'occurrence' }, true), /recurring series/);
  assert.match(m.eventChangeRefusal({ ...PLAIN, type: 'exception' }, true), /recurring series/);
  assert.match(m.eventChangeRefusal({ ...PLAIN, type: 'seriesMaster' }, true), /recurring series/);
  assert.equal(m.eventChangeRefusal({ ...PLAIN, type: 'singleInstance' }, true), null);
  assert.equal(m.eventChangeRefusal({ type: undefined, isCancelled: false, sensitivity: 'normal' }, true), null,
    'an older row with no type at all reads as ordinary rather than refused');
});

test('a private event is refused only in the studio calendar — its own owner already sees it as it is', () => {
  const secret = { ...PLAIN, sensitivity: 'private' };
  assert.match(m.eventChangeRefusal(secret, true), /marked private/);
  assert.equal(m.eventChangeRefusal(secret, false), null, 'read as /me, never hidden from its own owner');
  assert.match(m.eventChangeRefusal({ ...PLAIN, sensitivity: 'personal' }, true), /marked private/);
  assert.match(m.eventChangeRefusal({ ...PLAIN, sensitivity: 'CONFIDENTIAL' }, true), /marked private/,
    'Graph\'s casing is not guaranteed, so this is not either');
});

test('cancelled is checked before recurrence or privacy, so the most useful reason wins', () => {
  const messy = { type: 'occurrence', isCancelled: true, sensitivity: 'private' };
  assert.match(m.eventChangeRefusal(messy, true), /already cancelled/);
});
