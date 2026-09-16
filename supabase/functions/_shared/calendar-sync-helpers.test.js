/* Tests for _shared/calendar-sync-helpers.ts — what sync-outlook-calendar's
   own upsert loop (in _shared/calendar-sync.ts's runCalendarSync) may safely
   write, and which of what it already has has gone. Not tested here (see the
   helpers file's own header): actually calling Graph or Postgres, which
   needs a live tenant and a live database — the same reason
   graph-message.test.js's own neighbours stop where they do. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'calendar-sync-helpers.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* ── nextLinkOf ───────────────────────────────────────────────────────── */

test('nextLinkOf follows a real link and stops on anything else', () => {
  assert.equal(m.nextLinkOf({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }),
    'https://graph.microsoft.com/v1.0/next');
  assert.equal(m.nextLinkOf({ value: [] }), null, 'the last page names no link at all');
  assert.equal(m.nextLinkOf({ value: [], '@odata.nextLink': '' }), null, 'an empty string is not a link');
  assert.equal(m.nextLinkOf({ value: [], '@odata.nextLink': 4 }), null,
    'a page shaped unlike what was asked for is nearer "stop" than "guess a URL"');
});

/* ── vanishedIds ──────────────────────────────────────────────────────── */

test('vanishedIds is what was known minus what the run just saw', () => {
  assert.deepEqual([...m.vanishedIds(['a', 'b', 'c'], new Set(['b']))], ['a', 'c']);
});

test('vanishedIds is empty when the run saw everything it already had', () => {
  assert.deepEqual([...m.vanishedIds(['a', 'b'], new Set(['a', 'b', 'z']))], []);
});

test('vanishedIds of nothing already known is nothing vanished', () => {
  assert.deepEqual([...m.vanishedIds([], new Set(['a']))], []);
});

test('a truncated fetch (MAX_PAGES ran out) vanishes nothing at all, however much looks missing', () => {
  /* The whole reason this matters: a real event past whatever page the fetch
     stopped at looks EXACTLY like a deleted one to plain set subtraction —
     `known` has it, `seen` does not — and cancelling it would be the same bug
     this file exists to fix, just triggered a different way. */
  assert.deepEqual([...m.vanishedIds(['a', 'b', 'c'], new Set(), true)], []);
});

test('truncated defaults to false, so existing callers see no change', () => {
  assert.deepEqual([...m.vanishedIds(['a', 'b'], new Set(['a']))], ['b']);
});

/* ── syncedEventFields ────────────────────────────────────────────────── */

const ROW = {
  external_id: 'ev-1', title: 'Kickoff', detail: 'Zoom', location: null,
  starts_at: '2026-09-20T09:00:00Z', ends_at: '2026-09-20T09:30:00Z', all_day: false,
  kind: 'client', status: 'confirmed', attendees: [{ name: null, email: 'a@northline.example', response: null }],
  organizer_name: 'Ana Lima', organizer_email: 'ana@northline.example', meeting_url: 'https://teams.microsoft.com/l/x', time_zone: 'Europe/Lisbon'
};

test('a row new to this sync gets the fresh guess, along with everything Graph said', () => {
  const fields = m.syncedEventFields(ROW, 'conn-1', 'default', false);
  assert.deepEqual(fields, {
    connection_id: 'conn-1', calendar_id: 'default', external_id: 'ev-1',
    title: 'Kickoff', detail: 'Zoom', location: null,
    starts_at: '2026-09-20T09:00:00Z', ends_at: '2026-09-20T09:30:00Z', all_day: false,
    status: 'confirmed', attendees: ROW.attendees, kind: 'client',
    organizer_name: 'Ana Lima', organizer_email: 'ana@northline.example', meeting_url: 'https://teams.microsoft.com/l/x', time_zone: 'Europe/Lisbon'
  });
});

test('a row this sync already wrote keeps its stored kind — everything else still moves with Graph', () => {
  const moved = { ...ROW, title: 'Kickoff, rescheduled', starts_at: '2026-09-21T09:00:00Z', kind: 'team' };
  const fields = m.syncedEventFields(moved, 'conn-1', 'default', true);
  assert.equal(fields.title, 'Kickoff, rescheduled', 'Graph is still the only source for this');
  assert.equal(fields.starts_at, '2026-09-21T09:00:00Z');
  assert.ok(!('kind' in fields),
    'kind is left out of the upsert entirely, so the column keeps whatever is already stored — ' +
    'the create-calendar-event caller\'s choice, or an earlier sync\'s own guess, whichever it is');
});

test('this is exactly what stops create-calendar-event\'s "client" choice from being reset back to a guess', () => {
  /* The bug, traced through: a booking made with kind "client" is stored that
     way (create-calendar-event's own `kind ?? row.kind`); toEventRow's guess
     for the SAME event, read back by an ordinary sync a moment later, can
     easily differ — an attendee who has not yet accepted, or one Graph does
     not return in exactly the same order, changes nothing about what the
     event actually is. Before this fix the sync's upsert always sent
     `kind: row.kind` and clobbered the choice; now, for a row already known,
     it sends no `kind` field at all. */
  const guessedInternal = { ...ROW, kind: 'internal' };
  const fields = m.syncedEventFields(guessedInternal, 'conn-1', 'default', true);
  assert.ok(!('kind' in fields), 'the "client" already in the database is never overwritten with "internal"');
});
