/* Tests for _shared/enquiry-task.ts — the follow-up task an enquiry creates.

   The due date is the part worth pinning: "within one working day" is what
   the acknowledgement promises, and the clock is New York's, so an enquiry
   sent late on a Friday in Amsterdam must not produce a task due on Saturday. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let nextWorkingDay, buildEnquiryTask;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'enquiry-task.ts'), 'utf8');
  const m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
  ({ nextWorkingDay, buildEnquiryTask } = m);
});

/* 2026-09-04 is a Friday; 2026-09-07 the Monday after. */
test('Friday, Saturday and Sunday all land on Monday', () => {
  assert.equal(nextWorkingDay('2026-09-04T16:00:00Z'), '2026-09-07', 'Friday noon in New York');
  assert.equal(nextWorkingDay('2026-09-05T15:00:00Z'), '2026-09-07', 'Saturday');
  assert.equal(nextWorkingDay('2026-09-06T15:00:00Z'), '2026-09-07', 'Sunday');
});

test('Monday to Thursday are due the next day', () => {
  assert.equal(nextWorkingDay('2026-09-07T15:00:00Z'), '2026-09-08');
  assert.equal(nextWorkingDay('2026-09-08T15:00:00Z'), '2026-09-09');
  assert.equal(nextWorkingDay('2026-09-09T15:00:00Z'), '2026-09-10');
  assert.equal(nextWorkingDay('2026-09-10T15:00:00Z'), '2026-09-11', 'Thursday to Friday');
});

/* 03:30 UTC on Saturday is still 23:30 on Friday in New York. Read in UTC
   this would be "Saturday, so Monday" by luck; read in Amsterdam it would be
   Saturday too. The point is that Friday 23:30 ET is a Friday. */
test('the weekday is New York\'s, not the server\'s', () => {
  assert.equal(nextWorkingDay('2026-09-05T03:30:00Z'), '2026-09-07', 'Friday night ET → Monday');
  /* 02:00 UTC on Tuesday is Monday 22:00 ET → due Tuesday, not Wednesday. */
  assert.equal(nextWorkingDay('2026-09-08T02:00:00Z'), '2026-09-08');
});

test('month and year boundaries roll over correctly', () => {
  assert.equal(nextWorkingDay('2026-10-30T15:00:00Z'), '2026-11-02', 'Friday Oct 30 → Monday Nov 2');
  assert.equal(nextWorkingDay('2026-12-31T15:00:00Z'), '2027-01-01', 'Thursday Dec 31 → Friday Jan 1');
});

test('a time zone can be passed for anyone who is not in New York', () => {
  /* 23:30 in Amsterdam on Friday is Friday there and still Friday in UTC. */
  assert.equal(nextWorkingDay('2026-09-04T21:30:00Z', 'Europe/Amsterdam'), '2026-09-07');
});

test('garbage input throws rather than inventing a date', () => {
  assert.throws(() => nextWorkingDay('not a date'));
  assert.throws(() => nextWorkingDay(''));
});

const enquiry = (over = {}) => Object.assign({
  id: '5c1c8a9e-0000-4000-8000-000000000001',
  kind: 'website', name: 'Ann Lee', email: 'ann@example.com', business: 'Ann Bakes',
  website: 'https://annbakes.com/', message: 'Site is slow.\n\nHelp?', packageLabel: 'Back office',
  leadUrl: 'https://www.veyago.cloud/admin/leads?id=5c1c8a9e-0000-4000-8000-000000000001',
}, over);

test('the task names the person and the kind, is high priority, and is due the next working day', () => {
  const t = buildEnquiryTask(enquiry(), '2026-09-04T16:00:00Z');
  assert.equal(t.title, 'Reply to Ann Lee - website enquiry');
  assert.equal(t.priority, 'high');
  assert.equal(t.due_date, '2026-09-07');
  assert.equal(buildEnquiryTask(enquiry({ kind: 'product' }), '2026-09-04T16:00:00Z').title,
    'Reply to Ann Lee - project enquiry');
});

test('the details carry everything needed to reply without opening anything else', () => {
  const { details } = buildEnquiryTask(enquiry(), '2026-09-04T16:00:00Z');
  for (const line of [
    'Email: ann@example.com', 'Business: Ann Bakes', 'Website: https://annbakes.com/',
    'Package: Back office', 'Message:\nSite is slow.\n\nHelp?',
    'Ref: 5c1c8a9e-0000-4000-8000-000000000001',
    'Open it: https://www.veyago.cloud/admin/leads?id=5c1c8a9e-0000-4000-8000-000000000001',
  ]) {
    assert.ok(details.includes(line), 'missing: ' + JSON.stringify(line) + '\n' + details);
  }
});

test('optional fields that were not given leave no empty lines behind', () => {
  const { details } = buildEnquiryTask(
    enquiry({ business: '', website: '', message: '', packageLabel: '', leadUrl: undefined }),
    '2026-09-04T16:00:00Z');
  assert.equal(details, 'Email: ann@example.com\n\nRef: 5c1c8a9e-0000-4000-8000-000000000001');
});
