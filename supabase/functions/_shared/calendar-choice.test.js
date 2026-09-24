/* Tests for _shared/calendar-choice.ts — which calendar a booking goes into.
   The failures this guards against are quiet: client work booked into
   someone's personal calendar is hidden from every colleague (0025, 0026), and
   a private appointment booked into the studio calendar is shown to all of
   them. Nothing errors either way. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'calendar-choice.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const ME = 'e-me';
const connected = (over) => ({ status: 'connected', ...over });
const studio = connected({ id: 'c-studio', account_label: 'hello@veyago.cloud', employee_id: null });
const mine = connected({ id: 'c-mine', account_label: 'sam@veyago.cloud', employee_id: ME });
const theirs = connected({ id: 'c-theirs', account_label: 'ana@veyago.cloud', employee_id: 'e-ana' });
const choose = (calendars, booking) => {
  const choice = m.calendarFor(calendars, booking);
  return [(choice.calendar || {}).id || null, choice.reason];
};

test('client work goes into the studio calendar, even for someone with their own', () => {
  assert.deepEqual(choose([mine, studio, theirs], { employeeId: ME, clientWork: true }), ['c-studio', 'ok']);
});

test('client work with no studio calendar is booked in the workspace, not in a private diary', () => {
  assert.deepEqual(choose([mine, theirs], { employeeId: ME, clientWork: true }), [null, 'no-studio']);
});

test('client work while the studio calendar needs reconnecting is not moved into the booker\'s own', () => {
  const waiting = { ...studio, status: 'needs_reauth' };
  assert.deepEqual(choose([mine, waiting], { employeeId: ME, clientWork: true }), [null, 'studio-needs-reconnect']);
});

test('anything else goes into the booker\'s own calendar, or the studio\'s when they have none', () => {
  assert.deepEqual(choose([studio, mine], { employeeId: ME, clientWork: false }), ['c-mine', 'ok']);
  assert.deepEqual(choose([studio, theirs], { employeeId: ME, clientWork: false }), ['c-studio', 'ok']);
});

test('a private event whose own calendar needs reconnecting is refused, not put in the studio calendar', () => {
  const waiting = { ...mine, status: 'needs_reauth' };
  assert.deepEqual(choose([studio, waiting], { employeeId: ME, clientWork: false }), [null, 'own-needs-reconnect']);
});

test('a calendar whose last sync failed is still booked into: nothing syncs it again by itself', () => {
  assert.deepEqual(choose([studio, { ...mine, status: 'error' }], { employeeId: ME, clientWork: false }), ['c-mine', 'ok']);
  assert.deepEqual(choose([{ ...studio, status: 'error' }, mine], { employeeId: ME, clientWork: true }), ['c-studio', 'ok']);
});

test('a colleague\'s personal calendar is never chosen', () => {
  assert.deepEqual(choose([theirs], { employeeId: ME, clientWork: true }), [null, 'no-studio']);
  assert.deepEqual(choose([theirs], { employeeId: ME, clientWork: false }), [null, 'none']);
  assert.deepEqual(choose([theirs, studio], { employeeId: null, clientWork: false }), ['c-studio', 'ok'],
    'someone with no employee record gets the studio calendar, not the first personal one');
});

test('nothing connected is nothing chosen', () => {
  assert.deepEqual(choose([], { employeeId: ME, clientWork: true }), [null, 'no-studio']);
  assert.deepEqual(choose(null, { employeeId: ME, clientWork: false }), [null, 'none']);
});

test('with several studio calendars, the same one every time', () => {
  const other = connected({ id: 'c-bookings', account_label: 'bookings@veyago.cloud', employee_id: null });
  assert.deepEqual(choose([studio, other], { employeeId: ME, clientWork: true }), ['c-bookings', 'ok']);
  assert.deepEqual(choose([other, studio], { employeeId: ME, clientWork: true }), ['c-bookings', 'ok']);
});
