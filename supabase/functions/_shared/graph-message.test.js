/* Tests for _shared/graph-message.ts.
   The date block is the one that matters. Graph hands back a wall clock with
   no offset plus a Windows timezone name, and the obvious `new Date(dateTime)`
   reads it as server-local — an event quietly an hour or two out, which people
   blame on themselves for weeks before suspecting the sync. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'graph-message.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('a UTC wall clock becomes the right instant', () => {
  assert.equal(m.toInstant({ dateTime: '2026-09-11T09:00:00.0000000', timeZone: 'UTC' }),
    '2026-09-11T09:00:00.000Z');
  assert.equal(m.toInstant({ dateTime: '2026-09-11T09:00:00', timeZone: 'utc' }),
    '2026-09-11T09:00:00.000Z');
});

test('a Windows timezone name is refused rather than guessed at', () => {
  assert.equal(
    m.toInstant({ dateTime: '2026-09-11T09:00:00.0000000', timeZone: 'W. Europe Standard Time' }),
    null,
    'guessing would place the event an hour out; the sync asks Graph for UTC instead');
  assert.equal(m.toInstant({ dateTime: '2026-09-11T09:00:00', timeZone: 'Pacific Standard Time' }), null);
});

test('a value that already carries an offset is trusted', () => {
  assert.equal(m.toInstant({ dateTime: '2026-09-11T11:00:00+02:00' }), '2026-09-11T09:00:00.000Z');
  assert.equal(m.toInstant({ dateTime: '2026-09-11T09:00:00Z', timeZone: 'anything' }),
    '2026-09-11T09:00:00.000Z');
});

test('nonsense dates are null, not Invalid Date', () => {
  assert.equal(m.toInstant(undefined), null);
  assert.equal(m.toInstant({ dateTime: '' }), null);
  assert.equal(m.toInstant({ dateTime: 'not a date', timeZone: 'UTC' }), null);
});

test('addresses are lowercased and names kept', () => {
  assert.deepEqual(m.address({ emailAddress: { name: 'Olivia Chen', address: 'Olivia@Northline.Example' } }),
    { name: 'Olivia Chen', email: 'olivia@northline.example' });
  assert.deepEqual(m.address(undefined), { name: '', email: '' });
  assert.deepEqual(m.addressList([
    { emailAddress: { address: 'A@x.com' } }, { emailAddress: {} }, { emailAddress: { address: 'b@y.com' } }
  ]), ['a@x.com', 'b@y.com']);
});

test('html becomes readable text, tags and entities included', () => {
  const text = m.htmlToText('<style>p{color:red}</style><p>First&nbsp;line.</p><p>Second &amp; last.</p>');
  assert.equal(text, 'First line.\nSecond & last.');
  assert.ok(!text.includes('color:red'), 'style contents must not leak into the preview');
});

test('html to text drops scripts entirely', () => {
  assert.equal(m.htmlToText('<script>steal()</script><p>Hello</p>'), 'Hello');
});

const message = {
  id: 'AAMkAGI1', conversationId: 'AAQkAGI1',
  subject: 'A few thoughts on the homepage',
  bodyPreview: 'The first concept looks great',
  body: { contentType: 'html', content: '<p>Looks great.</p><p>A couple of thoughts.</p>' },
  from: { emailAddress: { name: 'Olivia Chen', address: 'olivia@northline.example' } },
  toRecipients: [{ emailAddress: { address: 'hello@veyago.cloud' } }],
  ccRecipients: [{ emailAddress: { address: 'jamie@veyago.cloud' } }],
  sentDateTime: '2026-09-11T10:42:00Z',
  receivedDateTime: '2026-09-11T10:42:05Z',
  isRead: false,
  flag: { flagStatus: 'flagged' },
};

test('a real message maps across', () => {
  const row = m.toMailRow(message, ['hello@veyago.cloud']);
  assert.equal(row.external_id, 'AAMkAGI1');
  assert.equal(row.thread_external_id, 'AAQkAGI1');
  assert.equal(row.direction, 'inbound');
  assert.equal(row.from_email, 'olivia@northline.example');
  assert.deepEqual(row.to_emails, ['hello@veyago.cloud']);
  assert.deepEqual(row.cc_emails, ['jamie@veyago.cloud']);
  assert.equal(row.body_html, '<p>Looks great.</p><p>A couple of thoughts.</p>');
  assert.equal(row.body_text, 'Looks great.\nA couple of thoughts.');
  assert.equal(row.sent_at, '2026-09-11T10:42:00.000Z');
  assert.equal(row.is_read, false);
  assert.equal(row.is_flagged, true);
});

test('direction follows our own addresses, not the folder', () => {
  assert.equal(m.toMailRow(message, ['olivia@northline.example']).direction, 'outbound');
  assert.equal(m.toMailRow(message, []).direction, 'inbound');
});

test('a message with no conversationId is its own thread', () => {
  const row = m.toMailRow({ ...message, conversationId: undefined });
  assert.equal(row.thread_external_id, 'AAMkAGI1',
    'otherwise every such message shares one null thread');
});

test('a plain-text body is not run through the html stripper', () => {
  const row = m.toMailRow({ ...message, body: { contentType: 'text', content: 'a < b & c' } });
  assert.equal(row.body_text, 'a < b & c');
  assert.equal(row.body_html, '');
});

test('priority, attachments, the internet message id and bcc come across', () => {
  const row = m.toMailRow({
    ...message,
    importance: 'high',
    hasAttachments: true,
    internetMessageId: '<abc123@mail.northline.example>',
    bccRecipients: [{ emailAddress: { address: 'Boss@Veyago.cloud' } }],
  });
  assert.equal(row.importance, 'high');
  assert.equal(row.has_attachments, true);
  assert.equal(row.internet_message_id, '<abc123@mail.northline.example>');
  assert.deepEqual(row.bcc_emails, ['boss@veyago.cloud']);
});

test('no priority, or one Graph does not define, is normal; no message id is null', () => {
  const row = m.toMailRow(message);
  assert.equal(row.importance, 'normal');
  assert.equal(row.has_attachments, false);
  assert.equal(row.internet_message_id, null);
  assert.deepEqual(row.bcc_emails, []);
  assert.equal(m.toMailRow({ ...message, importance: 'URGENT' }).importance, 'normal');
  assert.equal(m.toMailRow({ ...message, importance: 'Low' }).importance, 'low');
});

test('the sync asks Graph for every field the row is built from', () => {
  const fields = m.MESSAGE_SELECT.split(',');
  for (const f of ['id', 'conversationId', 'internetMessageId', 'subject', 'body', 'from',
    'toRecipients', 'ccRecipients', 'bccRecipients', 'sentDateTime', 'receivedDateTime',
    'isRead', 'flag', 'importance', 'hasAttachments']) {
    assert.ok(fields.includes(f), `${f} is missing from $select`);
  }
});

test('folders map to ours', () => {
  assert.equal(m.folderFromWellKnownName('inbox'), 'inbox');
  assert.equal(m.folderFromWellKnownName('sentitems'), 'sent');
  assert.equal(m.folderFromWellKnownName('junkemail'), 'spam');
  assert.equal(m.folderFromWellKnownName('deleteditems'), 'trash');
  assert.equal(m.folderFromWellKnownName('archive'), 'archive');
  assert.equal(m.folderFromWellKnownName(''), 'archive');
});

const event = {
  id: 'AAMkEvent',
  subject: 'Northline design review',
  bodyPreview: 'Walk through the second pass',
  start: { dateTime: '2026-09-11T14:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-11T14:45:00.0000000', timeZone: 'UTC' },
  isAllDay: false, isCancelled: false, showAs: 'busy',
  location: { displayName: 'Teams' },
  attendees: [
    { emailAddress: { name: 'Olivia Chen', address: 'olivia@northline.example' }, status: { response: 'accepted' } },
    { emailAddress: { name: 'Cassian', address: 'cdrefke@veyago.cloud' }, status: { response: 'organizer' } },
  ],
};

test('an event with someone outside the studio reads as client work', () => {
  const row = m.toEventRow(event, 'veyago.cloud');
  assert.equal(row.kind, 'client');
  assert.equal(row.starts_at, '2026-09-11T14:00:00.000Z');
  assert.equal(row.ends_at, '2026-09-11T14:45:00.000Z');
  assert.equal(row.location, 'Teams');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.attendees.length, 2);
});

test('only-us is a team meeting, nobody is focus time', () => {
  const internal = { ...event, attendees: [
    { emailAddress: { address: 'cdrefke@veyago.cloud' } },
    { emailAddress: { address: 'eracz@veyago.cloud' } }] };
  assert.equal(m.toEventRow(internal, 'veyago.cloud').kind, 'team');
  assert.equal(m.toEventRow({ ...event, attendees: [] }, 'veyago.cloud').kind, 'focus');
});

test('cancelled and tentative come through', () => {
  assert.equal(m.toEventRow({ ...event, isCancelled: true }, 'veyago.cloud').status, 'cancelled');
  assert.equal(m.toEventRow({ ...event, showAs: 'tentative' }, 'veyago.cloud').status, 'tentative');
});

test('an event whose start cannot be trusted is skipped, not misplaced', () => {
  const bad = { ...event, start: { dateTime: '2026-09-11T14:00:00', timeZone: 'Romance Standard Time' } };
  assert.equal(m.toEventRow(bad, 'veyago.cloud'), null);
});
