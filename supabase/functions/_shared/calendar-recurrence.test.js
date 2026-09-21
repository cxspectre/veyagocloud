/* Tests for _shared/calendar-recurrence.ts — 0068's series, reminder and
   time-zone reading.

   The zone block is the one that matters, for the same reason graph-message.
   test.js's date block does: a Windows timezone name reaching a browser's
   Intl.DateTimeFormat throws a RangeError, and one GUESSED at instead puts a
   label an hour out. Null is the only honest answer for a name nobody mapped.

   Not tested here: fetching a series master from Graph, which needs a live
   tenant — see the boundary graph-message.test.js's neighbours already keep. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'calendar-recurrence.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* ── recurrenceTypeOf / isRecurring ───────────────────────────────────── */

test('Graph’s four event types are kept, anything else is a single meeting', () => {
  assert.equal(m.recurrenceTypeOf('occurrence'), 'occurrence');
  assert.equal(m.recurrenceTypeOf('exception'), 'exception');
  assert.equal(m.recurrenceTypeOf('seriesMaster'), 'seriesMaster');
  assert.equal(m.recurrenceTypeOf('singleInstance'), 'singleInstance');
  assert.equal(m.recurrenceTypeOf('weekly'), 'singleInstance', 'a word Graph never sends');
  assert.equal(m.recurrenceTypeOf(undefined), 'singleInstance', 'a hand-made row has no type at all');
  assert.equal(m.recurrenceTypeOf('OCCURRENCE'), 'singleInstance', 'Graph’s own spelling, or nothing');
});

test('everything but a single instance is part of a series', () => {
  assert.equal(m.isRecurring('occurrence'), true);
  assert.equal(m.isRecurring('exception'), true, 'an occurrence somebody moved still repeats');
  assert.equal(m.isRecurring('seriesMaster'), true);
  assert.equal(m.isRecurring('singleInstance'), false);
  assert.equal(m.isRecurring(null), false);
});

/* ── recurrenceSummary ────────────────────────────────────────────────── */

test('a daily pattern reads as every day, or every N days', () => {
  assert.equal(m.recurrenceSummary({ pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd' } }),
    'Every day');
  assert.equal(m.recurrenceSummary({ pattern: { type: 'daily', interval: 3 }, range: { type: 'noEnd' } }),
    'Every 3 days');
});

test('a weekly pattern names its days, in Graph’s order, without an Oxford comma', () => {
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: { type: 'noEnd' } }),
    'Every week on Monday');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'thursday'] }, range: { type: 'noEnd' } }),
    'Every 2 weeks on Monday and Thursday');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday', 'friday'] }, range: { type: 'noEnd' } }),
    'Every week on Monday, Wednesday and Friday');
});

test('a monthly pattern reads by day of the month, or by which weekday of it', () => {
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 }, range: { type: 'noEnd' } }),
    'Every month on day 15');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'relativeMonthly', interval: 1, index: 'second', daysOfWeek: ['tuesday'] }, range: { type: 'noEnd' } }),
    'Every month on the second Tuesday');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'relativeMonthly', interval: 3, index: 'last', daysOfWeek: ['friday'] }, range: { type: 'noEnd' } }),
    'Every 3 months on the last Friday',
    '"last" is a real index, not a count');
});

test('a yearly pattern names the month', () => {
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: 21, month: 9 }, range: { type: 'noEnd' } }),
    'Every year on 21 September');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'relativeYearly', interval: 1, index: 'first', daysOfWeek: ['monday'], month: 5 }, range: { type: 'noEnd' } }),
    'Every year on the first Monday of May');
});

test('how long it runs for is appended, and a series with no end says nothing extra', () => {
  const weekly = days => ({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: days });
  assert.equal(m.recurrenceSummary(weekly({ type: 'noEnd' })), 'Every week on Monday');
  assert.equal(m.recurrenceSummary(weekly({ type: 'endDate', endDate: '2026-12-03' })),
    'Every week on Monday, until 3 December 2026');
  assert.equal(m.recurrenceSummary(weekly({ type: 'numbered', numberOfOccurrences: 10 })),
    'Every week on Monday, 10 times');
  assert.equal(m.recurrenceSummary(weekly({ type: 'numbered', numberOfOccurrences: 1 })),
    'Every week on Monday, 1 time');
});

test('an end date is read by its parts, so a machine west of Greenwich does not print the day before', () => {
  /* new Date('2026-01-01') is midnight UTC — 31 December in New York. The
     whole reason toInstant() exists is this trap in the other direction. */
  const summary = m.recurrenceSummary({
    pattern: { type: 'daily', interval: 1 },
    range: { type: 'endDate', endDate: '2026-01-01' },
  });
  assert.equal(summary, 'Every day, until 1 January 2026');
});

test('a pattern nobody can read says nothing rather than half a sentence', () => {
  assert.equal(m.recurrenceSummary(null), null);
  assert.equal(m.recurrenceSummary(undefined), null);
  assert.equal(m.recurrenceSummary({}), null);
  assert.equal(m.recurrenceSummary({ pattern: { type: 'lunar', interval: 1 } }), null,
    'a pattern type from some future API version');
});

test('nonsense inside a pattern is left unsaid, not printed', () => {
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 0 }, range: { type: 'noEnd' } }),
    'Every month', 'there is no day 0');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['funday'] }, range: { type: 'noEnd' } }),
    'Every week', 'a weekday nobody recognises');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'daily', interval: 0 }, range: { type: 'noEnd' } }),
    'Every day', '"every 0 days" is not a thing');
  assert.equal(
    m.recurrenceSummary({ pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', endDate: 'soon' } }),
    'Every day', 'an end date that is not a date is simply not mentioned');
});

/* ── ianaZone ─────────────────────────────────────────────────────────── */

test('the Windows names Graph actually sends become zones Intl can use', () => {
  assert.equal(m.ianaZone('W. Europe Standard Time'), 'Europe/Amsterdam');
  assert.equal(m.ianaZone('GMT Standard Time'), 'Europe/London');
  assert.equal(m.ianaZone('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(m.ianaZone('Eastern Standard Time'), 'America/New_York');
  assert.equal(m.ianaZone('UTC'), 'UTC');
});

test('the lookup does not care how Graph capitalised or padded the name', () => {
  assert.equal(m.ianaZone('  w. europe standard time  '), 'Europe/Amsterdam');
});

test('a name that is already IANA passes straight through', () => {
  assert.equal(m.ianaZone('Europe/Amsterdam'), 'Europe/Amsterdam');
  assert.equal(m.ianaZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires',
    'three parts is a real IANA name');
});

test('a Windows name nobody mapped is null, never a guess', () => {
  assert.equal(m.ianaZone('Kamchatka Standard Time'), null,
    'guessing would put a label an hour out; a page prints the raw name instead');
  assert.equal(m.ianaZone('Some Unmapped Standard Time'), null);
  assert.equal(m.ianaZone(''), null);
  assert.equal(m.ianaZone(undefined), null);
  assert.equal(m.ianaZone(null), null);
});

test('every mapped zone is IANA-shaped, so nothing in the table can fail the database check', () => {
  /* calendar_events_time_zone_iana_shape (0068) refuses anything with a space
     in it. A typo in the table above would otherwise only show up as a failed
     upsert on somebody's real calendar. */
  for (const windows of [
    'W. Europe Standard Time', 'GMT Standard Time', 'Romance Standard Time', 'Tokyo Standard Time',
    'India Standard Time', 'Argentina Standard Time', 'Hawaiian Standard Time', 'UTC',
  ]) {
    const zone = m.ianaZone(windows);
    assert.ok(zone && !/\s/.test(zone), `${windows} mapped to something with a space: ${zone}`);
    assert.ok(/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+){0,2}$/.test(zone), `${windows} -> ${zone}`);
  }
});

/* ── reminderMinutes ──────────────────────────────────────────────────── */

test('a reminder is a whole number of minutes, zero included', () => {
  assert.equal(m.reminderMinutes(15), 15);
  assert.equal(m.reminderMinutes(0), 0, '"at the time of the event" is a setting, not an absence');
  assert.equal(m.reminderMinutes(m.MAX_REMINDER_MINUTES), m.MAX_REMINDER_MINUTES);
});

test('anything that is not a sane number of minutes is "not known"', () => {
  assert.equal(m.reminderMinutes(-5), null);
  assert.equal(m.reminderMinutes(1.5), null);
  assert.equal(m.reminderMinutes(m.MAX_REMINDER_MINUTES + 1), null, 'past Outlook’s own four-week ceiling');
  assert.equal(m.reminderMinutes(undefined), null);
  assert.equal(m.reminderMinutes('fifteen'), null);
  assert.equal(m.reminderMinutes(null), null, 'Number(null) is 0, which would be the wrong answer');
});

/* ── eventExtraFields ─────────────────────────────────────────────────── */

test('an occurrence carries its series, and the words its master supplied', () => {
  const fields = m.eventExtraFields(
    { type: 'occurrence', seriesMasterId: 'master-1', isReminderOn: true, reminderMinutesBeforeStart: 15,
      originalStartTimeZone: 'W. Europe Standard Time' },
    { seriesSummary: 'Every week on Monday' },
  );
  assert.deepEqual(fields, {
    recurrence_type: 'occurrence',
    series_master_id: 'master-1',
    recurrence_summary: 'Every week on Monday',
    reminder_on: true,
    reminder_minutes: 15,
    time_zone_iana: 'Europe/Amsterdam',
  });
});

test('a series master reads its own pattern rather than being told one', () => {
  const fields = m.eventExtraFields({
    type: 'seriesMaster',
    recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['friday'] }, range: { type: 'noEnd' } },
  }, { seriesSummary: 'something else entirely' });
  assert.equal(fields.recurrence_summary, 'Every week on Friday');
});

test('a single meeting never claims to repeat, however it arrived', () => {
  const fields = m.eventExtraFields({ type: 'singleInstance' }, { seriesSummary: 'Every week on Monday' });
  assert.equal(fields.recurrence_type, 'singleInstance');
  assert.equal(fields.recurrence_summary, null, 'printing "Every week" under a one-off is worse than saying nothing');
  assert.equal(fields.series_master_id, null);
});

test('a series whose master could not be read still says it repeats', () => {
  const fields = m.eventExtraFields({ type: 'occurrence', seriesMasterId: 'master-1' }, {});
  assert.equal(fields.recurrence_type, 'occurrence');
  assert.equal(fields.recurrence_summary, null, 'no words, but the agenda can still mark it');
});

test('a reminder switched off carries no minutes, so the two columns cannot disagree', () => {
  const fields = m.eventExtraFields({ isReminderOn: false, reminderMinutesBeforeStart: 15 }, {});
  assert.equal(fields.reminder_on, false);
  assert.equal(fields.reminder_minutes, null,
    'calendar_events_reminder_minutes_sane (0068) refuses the other combination outright');
});

test('an unmapped zone leaves time_zone_iana null while time_zone keeps the raw name elsewhere', () => {
  assert.equal(m.eventExtraFields({ originalStartTimeZone: 'Kamchatka Standard Time' }, {}).time_zone_iana, null);
});

test('a private event in the studio calendar says nothing about repeating, reminders or zones', () => {
  const fields = m.eventExtraFields(
    { type: 'occurrence', seriesMasterId: 'master-1', isReminderOn: true, reminderMinutesBeforeStart: 15,
      originalStartTimeZone: 'W. Europe Standard Time' },
    { seriesSummary: 'Every week on Monday', hidden: true },
  );
  assert.deepEqual(fields, {
    recurrence_type: 'singleInstance',
    series_master_id: null,
    recurrence_summary: null,
    reminder_on: false,
    reminder_minutes: null,
    time_zone_iana: null,
  });
});

test('an event Graph sent nothing extra about is a plain single meeting', () => {
  assert.deepEqual(m.eventExtraFields({}, {}), {
    recurrence_type: 'singleInstance',
    series_master_id: null,
    recurrence_summary: null,
    reminder_on: false,
    reminder_minutes: null,
    time_zone_iana: null,
  });
});
