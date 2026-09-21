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

test('an attachment carries its name, kind, size and — for an inline image — its cid', () => {
  const row = m.toAttachmentRow({
    id: 'AAMk-1', name: 'invoice.pdf', contentType: 'application/pdf', size: 2048, isInline: false,
  });
  assert.deepEqual(row, {
    external_id: 'AAMk-1', name: 'invoice.pdf', content_type: 'application/pdf',
    size: 2048, is_inline: false, content_id: null,
  });

  const inline = m.toAttachmentRow({
    id: 'AAMk-2', name: 'logo.png', contentType: 'image/png', size: 512, isInline: true, contentId: 'logo123',
  });
  assert.equal(inline.is_inline, true);
  assert.equal(inline.content_id, 'logo123');
});

test('an attachment missing a name, type or size is stored anyway, never as something untrue', () => {
  assert.equal(m.toAttachmentRow({ id: 'x' }).name, 'attachment', 'nameless is labelled, not blank');
  assert.equal(m.toAttachmentRow({ id: 'x', name: '  ' }).name, 'attachment', 'whitespace is still nameless');
  assert.equal(m.toAttachmentRow({ id: 'x' }).content_type, 'application/octet-stream');
  for (const size of [undefined, null, -4, 1.5, NaN, 'nine']) {
    assert.equal(m.toAttachmentRow({ id: 'x', size }).size, 0, `size: ${size}`);
  }
  assert.equal(m.toAttachmentRow({ id: 'x', size: 0 }).size, 0, 'a genuinely empty file is not confused with "unknown"');
  assert.equal(m.toAttachmentRow({ id: 'x', isInline: 'yes' }).is_inline, false, 'only Graph\'s own true counts');
  assert.equal(m.toAttachmentRow({ id: 'x', contentId: '' }).content_id, null);
});

test('the attachment list is asked for as metadata only — never $expand, never the bytes', () => {
  const fields = m.ATTACHMENT_SELECT.split(',');
  for (const f of ['id', 'name', 'contentType', 'size', 'isInline']) {
    assert.ok(fields.includes(f), `${f} is missing from the attachment $select`);
  }
  /* contentId is only on the derived type. Asked for bare, Graph refuses the
     whole request, the list comes back empty, and nothing is stored at all —
     which is exactly what happened until 2026-09-21. */
  assert.ok(fields.includes('microsoft.graph.fileAttachment/contentId'),
    'contentId must be asked for through microsoft.graph.fileAttachment');
  assert.ok(!fields.includes('contentId'),
    'a bare contentId makes Graph refuse the whole attachment list');
  assert.ok(!m.ATTACHMENT_SELECT.toLowerCase().includes('contentbytes'),
    'contentBytes would pull the whole file into the sync for every attachment, every run');
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

test('an event marked private in a studio calendar keeps its time and nothing else', () => {
  const secret = { ...event, sensitivity: 'private' };
  const hidden = m.toEventRow(secret, 'veyago.cloud', { hidePrivate: true });
  assert.equal(hidden.title, 'Private');
  assert.equal(hidden.detail, null);
  assert.equal(hidden.location, null);
  assert.deepEqual(hidden.attendees, []);
  assert.equal(hidden.kind, 'personal');
  assert.equal(hidden.starts_at, '2026-09-11T14:00:00.000Z', 'when it is still shows, so nobody double-books it');
  assert.equal(m.toEventRow({ ...event, sensitivity: 'confidential' }, 'veyago.cloud', { hidePrivate: true }).title, 'Private');
  assert.equal(m.toEventRow(secret, 'veyago.cloud').title, 'Northline design review',
    'a person\'s own calendar shows them everything');
  assert.equal(m.toEventRow({ ...event, sensitivity: 'normal' }, 'veyago.cloud', { hidePrivate: true }).title,
    'Northline design review');
});

test('an event marked personal is hidden in a studio calendar too', () => {
  const row = m.toEventRow({ ...event, sensitivity: 'personal' }, 'veyago.cloud', { hidePrivate: true });
  assert.equal(row.title, 'Private');
  assert.equal(row.location, null);
});

/* ── Who organised it, its meeting link, and the zone it was booked in ──── */

test('the organiser is kept, lower-cased by address', () => {
  const organized = { ...event, organizer: { emailAddress: { name: 'Dana Reyes', address: 'Dana@Northline.example' } } };
  const row = m.toEventRow(organized, 'veyago.cloud');
  assert.equal(row.organizer_name, 'Dana Reyes');
  assert.equal(row.organizer_email, 'dana@northline.example');
});

test('an event with no organizer field keeps null, not empty strings mistaken for one', () => {
  const row = m.toEventRow(event, 'veyago.cloud');
  assert.equal(row.organizer_name, null);
  assert.equal(row.organizer_email, null);
});

test('a hidden event keeps no organiser either: that is still something else about it', () => {
  const secret = { ...event, sensitivity: 'private', organizer: { emailAddress: { name: 'Dana Reyes', address: 'dana@northline.example' } } };
  const row = m.toEventRow(secret, 'veyago.cloud', { hidePrivate: true });
  assert.equal(row.organizer_name, null);
  assert.equal(row.organizer_email, null);
});

test('an https join link is kept; anything else is thrown away rather than trusted', () => {
  const withLink = { ...event, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } };
  assert.equal(m.toEventRow(withLink, 'veyago.cloud').meeting_url, 'https://teams.microsoft.com/l/meetup-join/abc');

  const http = { ...event, onlineMeeting: { joinUrl: 'http://teams.microsoft.com/l/meetup-join/abc' } };
  assert.equal(m.toEventRow(http, 'veyago.cloud').meeting_url, null, 'http:// is not accepted, only https://');

  const javascriptUri = { ...event, onlineMeeting: { joinUrl: 'javascript:alert(1)' } };
  assert.equal(m.toEventRow(javascriptUri, 'veyago.cloud').meeting_url, null);

  const noScheme = { ...event, onlineMeeting: { joinUrl: 'teams.microsoft.com/l/meetup-join/abc' } };
  assert.equal(m.toEventRow(noScheme, 'veyago.cloud').meeting_url, null);

  assert.equal(m.toEventRow(event, 'veyago.cloud').meeting_url, null, 'no onlineMeeting at all is simply none');
});

test('the detail still says "Online meeting" when there is a link and nothing else to preview, only for a link that is kept', () => {
  const noPreview = { ...event, bodyPreview: '', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } };
  assert.equal(m.toEventRow(noPreview, 'veyago.cloud').detail, 'Online meeting');
  const rejectedLink = { ...event, bodyPreview: '', onlineMeeting: { joinUrl: 'http://not-https.example' } };
  assert.equal(m.toEventRow(rejectedLink, 'veyago.cloud').detail, null,
    'a link that was thrown away must not still switch the detail to "Online meeting"');
});

test('a hidden event keeps no meeting link either', () => {
  const secret = { ...event, sensitivity: 'confidential', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } };
  assert.equal(m.toEventRow(secret, 'veyago.cloud', { hidePrivate: true }).meeting_url, null);
});

test('the organiser\'s own zone is kept for context, trimmed, and blank reads as none', () => {
  const zoned = { ...event, originalStartTimeZone: 'Europe/Amsterdam' };
  assert.equal(m.toEventRow(zoned, 'veyago.cloud').time_zone, 'Europe/Amsterdam');
  assert.equal(m.toEventRow(event, 'veyago.cloud').time_zone, null);
  assert.equal(m.toEventRow({ ...event, originalStartTimeZone: '  ' }, 'veyago.cloud').time_zone, null);
});
