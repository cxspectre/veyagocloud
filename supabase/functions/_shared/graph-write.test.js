/* Tests for _shared/graph-write.ts.
   Both halves fail quietly in production if they are wrong: a recipient shape
   Graph does not recognise is dropped rather than refused, and a date sent
   without its zone is read in the mailbox's own timezone. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'graph-write.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('recipients take both a bare address and a named one', () => {
  assert.deepEqual(m.recipients(['a@b.com', { name: 'Olivia', email: 'o@x.com' }]), [
    { emailAddress: { address: 'a@b.com' } },
    { emailAddress: { address: 'o@x.com', name: 'Olivia' } },
  ]);
});

test('empty and malformed recipients are dropped, not sent as blanks', () => {
  assert.deepEqual(m.recipients(undefined), []);
  assert.deepEqual(m.recipients(['', { email: '' }, 'ok@x.com']),
    [{ emailAddress: { address: 'ok@x.com' } }]);
});

test('a date is sent with its zone stated separately and no trailing Z', () => {
  const d = m.graphDateTime('2026-09-11T14:00:00.000Z');
  assert.deepEqual(d, { dateTime: '2026-09-11T14:00:00', timeZone: 'UTC' });
  assert.ok(!d.dateTime.endsWith('Z'),
    'Graph 400s when the field carries an offset as well as timeZone');
});

test('graphDateTime accepts a Date and refuses nonsense', () => {
  assert.equal(m.graphDateTime(new Date('2026-01-02T03:04:05Z')).dateTime, '2026-01-02T03:04:05');
  assert.throws(() => m.graphDateTime('not a date'), /Not a date/);
});

test('a message carries HTML, recipients and lands in Sent by default', () => {
  const p = m.sendMailPayload({ to: ['o@x.com'], subject: 'Re: hello [#VYG-7]', html: '<p>Hi</p>' });
  assert.equal(p.message.subject, 'Re: hello [#VYG-7]');
  assert.equal(p.message.body.contentType, 'HTML');
  assert.deepEqual(p.message.toRecipients, [{ emailAddress: { address: 'o@x.com' } }]);
  assert.equal(p.saveToSentItems, true,
    'a reply the studio cannot find in Sent is one nobody can prove was made');
});

test('cc and replyTo appear only when given', () => {
  const bare = m.sendMailPayload({ to: ['a@b.com'], subject: 's', html: 'h' });
  assert.ok(!('ccRecipients' in bare.message));
  assert.ok(!('replyTo' in bare.message));
  const full = m.sendMailPayload({
    to: ['a@b.com'], subject: 's', html: 'h',
    cc: ['c@d.com'], replyTo: ['support@veyago.cloud'],
  });
  assert.deepEqual(full.message.ccRecipients, [{ emailAddress: { address: 'c@d.com' } }]);
  assert.deepEqual(full.message.replyTo, [{ emailAddress: { address: 'support@veyago.cloud' } }]);
});

test('a message with no recipient or no subject is refused here, not by Graph', () => {
  assert.throws(() => m.sendMailPayload({ to: [], subject: 's', html: 'h' }), /recipient/);
  assert.throws(() => m.sendMailPayload({ to: ['a@b.com'], subject: '  ', html: 'h' }), /subject/);
});

test('an event carries start and end with zones', () => {
  const p = m.eventPayload({
    title: 'Northline design review',
    startsAt: '2026-09-11T14:00:00Z',
    endsAt: '2026-09-11T14:45:00Z',
    location: 'Teams',
    detail: 'Second pass',
  });
  assert.equal(p.subject, 'Northline design review');
  assert.deepEqual(p.start, { dateTime: '2026-09-11T14:00:00', timeZone: 'UTC' });
  assert.deepEqual(p.end, { dateTime: '2026-09-11T14:45:00', timeZone: 'UTC' });
  assert.equal(p.location.displayName, 'Teams');
  assert.equal(p.body.content, 'Second pass');
  assert.equal(p.isAllDay, false);
});

test('an event with no end becomes half an hour', () => {
  const p = m.eventPayload({ title: 'Focus', startsAt: '2026-09-11T09:00:00Z' });
  assert.deepEqual(p.end, { dateTime: '2026-09-11T09:30:00', timeZone: 'UTC' });
});

test('an event that ends before it starts is refused', () => {
  assert.throws(() => m.eventPayload({
    title: 'x', startsAt: '2026-09-11T14:00:00Z', endsAt: '2026-09-11T13:00:00Z',
  }), /end before it starts/);
});

test('attendees are marked required, and omitted when there are none', () => {
  const withPeople = m.eventPayload({
    title: 'x', startsAt: '2026-09-11T09:00:00Z',
    attendees: [{ name: 'Olivia', email: 'o@x.com' }],
  });
  assert.deepEqual(withPeople.attendees, [
    { emailAddress: { address: 'o@x.com', name: 'Olivia' }, type: 'required' },
  ]);
  assert.ok(!('attendees' in m.eventPayload({ title: 'x', startsAt: '2026-09-11T09:00:00Z' })));
});

test('a draft carries only what it is given, so a PATCH never blanks what Graph filled in', () => {
  assert.deepEqual(m.draftMessagePayload({ html: '<p>Hi</p>' }),
    { body: { contentType: 'HTML', content: '<p>Hi</p>' } });
  assert.deepEqual(m.draftMessagePayload({
    to: ['a@b.com'], cc: ['c@d.com'], bcc: ['e@f.com'],
    subject: 'Plan', html: '<p>x</p>', importance: 'high',
  }), {
    subject: 'Plan',
    body: { contentType: 'HTML', content: '<p>x</p>' },
    toRecipients: [{ emailAddress: { address: 'a@b.com' } }],
    ccRecipients: [{ emailAddress: { address: 'c@d.com' } }],
    bccRecipients: [{ emailAddress: { address: 'e@f.com' } }],
    importance: 'high',
  });
});

test('an empty recipient list is sent when given, so removing everyone from Cc sticks', () => {
  assert.deepEqual(m.draftMessagePayload({ cc: [] }), { ccRecipients: [] });
});

test('importance is low, normal or high, and nothing else', () => {
  assert.equal(m.draftMessagePayload({ importance: 'low' }).importance, 'low');
  assert.throws(() => m.draftMessagePayload({ importance: 'urgent' }), /importance/);
});

test('a file attachment is the shape Graph expects', () => {
  assert.deepEqual(
    m.fileAttachmentPayload({ name: 'plan.pdf', contentType: 'application/pdf', contentBase64: 'SGVsbG8=' }),
    { '@odata.type': '#microsoft.graph.fileAttachment', name: 'plan.pdf',
      contentType: 'application/pdf', contentBytes: 'SGVsbG8=' });
  assert.equal(m.fileAttachmentPayload({ name: 'x', contentBase64: 'AA==' }).contentType,
    'application/octet-stream');
});

test('a large file goes through an upload session, in ranges that cover every byte once', () => {
  assert.deepEqual(m.uploadSessionPayload({ name: 'walkthrough.mp4', size: 9000000 }),
    { AttachmentItem: { attachmentType: 'file', name: 'walkthrough.mp4', size: 9000000 } });
  const ranges = m.uploadRanges(7500000, 3 * 1024 * 1024);
  assert.deepEqual(ranges, [
    { start: 0, end: 3145727 },
    { start: 3145728, end: 6291455 },
    { start: 6291456, end: 7499999 },
  ]);
  assert.deepEqual(m.uploadRanges(0), []);
  assert.ok(m.uploadRanges(10).every((r) => r.end - r.start + 1 <= 4 * 1024 * 1024),
    'Graph asks for pieces under 4 MB');
});

test('an untitled event is refused', () => {
  assert.throws(() => m.eventPayload({ title: '   ', startsAt: '2026-09-11T09:00:00Z' }), /title/);
});
