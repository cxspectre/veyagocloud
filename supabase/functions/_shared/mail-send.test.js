/* Tests for _shared/mail-send.ts — what the workspace may ask send-mail to do.
   The browser is not trusted to have checked any of this: a request that
   reaches Graph half-formed fails there with a message nobody can act on, and
   an attachment path that is not the sender's own would mail out somebody
   else's upload. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mail-send.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const CONN = 'c0000000-0000-4000-8000-00000000000b';
const MSG = 'e0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000001';
const VICTIM = 'b0000000-0000-4000-8000-000000000002';
const UPLOAD = 'f0000001-0000-4000-8000-000000000000';

function ok(payload) {
  const result = m.parseSendRequest(payload);
  assert.equal(result.ok, true, result.error);
  return result.value;
}

function refused(payload, pattern) {
  const result = m.parseSendRequest(payload);
  assert.equal(result.ok, false, 'expected a refusal');
  assert.match(result.error, pattern);
}

const newMail = (over = {}) => ({ connectionId: CONN, to: ['anna@client.com'], subject: 'Launch', html: '<p>Hi</p>', ...over });

test('a new message needs a mailbox, a recipient, a subject and something to say', () => {
  const v = ok(newMail());
  assert.equal(v.mode, 'new');
  assert.equal(v.importance, 'normal');
  assert.deepEqual(v.cc, []);
  assert.deepEqual(v.bcc, []);
  assert.equal(v.messageId, null);
  refused(newMail({ connectionId: '' }), /mailbox/);
  refused(newMail({ to: [] }), /recipient/);
  refused(newMail({ subject: '   ' }), /subject/);
  refused(newMail({ html: '<p> &nbsp; </p>' }), /empty/);
  refused(null, /mailbox/);
});

test('replies and forwards name the message they answer; a reply may leave To to Outlook', () => {
  const reply = ok({ connectionId: CONN, mode: 'reply', messageId: MSG, html: '<p>Thanks</p>' });
  assert.equal(reply.mode, 'reply');
  assert.equal(reply.messageId, MSG);
  assert.equal(reply.subject, '');
  ok({ connectionId: CONN, mode: 'replyAll', messageId: MSG, html: '<p>All</p>' });
  refused({ connectionId: CONN, mode: 'reply', html: '<p>x</p>' }, /which message/);
  refused({ connectionId: CONN, mode: 'forward', messageId: MSG, html: '<p>x</p>' }, /recipient/);
  refused({ connectionId: CONN, mode: 'delete', messageId: MSG, html: '<p>x</p>' }, /mode/);
});

test('a reply that removes every recipient is refused before Outlook sees it', () => {
  refused({ connectionId: CONN, mode: 'reply', messageId: MSG, to: [], html: '<p>x</p>' }, /recipient/);
  refused({ connectionId: CONN, mode: 'replyAll', messageId: MSG, to: [], cc: [], bcc: [], html: '<p>x</p>' }, /recipient/);
  ok({ connectionId: CONN, mode: 'reply', messageId: MSG, to: [], cc: ['pm@client.com'], html: '<p>x</p>' });
});

test('addresses are trimmed, de-duplicated across fields, and a bad one is named', () => {
  const v = ok(newMail({
    to: [' Anna@Client.com ', 'anna@client.com'],
    cc: ['ANNA@client.com', 'pm@client.com'],
    bcc: ['pm@client.com', 'boss@veyago.cloud'],
  }));
  assert.deepEqual(v.to, ['Anna@Client.com']);
  assert.deepEqual(v.cc, ['pm@client.com'], 'already in To');
  assert.deepEqual(v.bcc, ['boss@veyago.cloud'], 'already in Cc');
  refused(newMail({ to: ['not-an-address'] }), /not-an-address/);
  refused(newMail({ cc: 'pm@client.com' }), /Cc/);
});

test('more than 500 recipients is refused, as Exchange would', () => {
  const many = Array.from({ length: 501 }, (_, i) => `p${i}@x.com`);
  refused(newMail({ to: many }), /500/);
});

test('importance defaults to normal and refuses anything else', () => {
  assert.equal(ok(newMail({ importance: 'high' })).importance, 'high');
  refused(newMail({ importance: 'urgent' }), /importance/);
});

const file = (n, size) => ({
  path: `${USER}/f000000${n}-0000-4000-8000-000000000000/plan.pdf`,
  name: 'Plan (final).pdf', size, contentType: 'application/pdf',
});

test('attachments are counted, capped, and are something to send on their own', () => {
  const v = ok(newMail({ html: '', attachments: [file(1, 1000)] }));
  assert.equal(v.attachments.length, 1);
  assert.equal(v.attachments[0].name, 'Plan (final).pdf', 'the display name travels apart from the path');
  refused(newMail({ attachments: [{ ...file(1, 10), path: '../etc/passwd' }] }), /attachment/);
  refused(newMail({ attachments: [{ ...file(1, 10), size: -1 }] }), /attachment/);
  refused(newMail({ attachments: [file(1, 20 * 1024 * 1024), file(2, 6 * 1024 * 1024)] }), /25 MB/);
  refused(newMail({ attachments: Array.from({ length: 21 }, (_, i) => file(i % 9, 10)) }), /20 attachments/);
});

test('an upload path is exactly <your id>/<upload id>/<plain name>', () => {
  assert.equal(m.ownsAttachment(`${USER}/${UPLOAD}/plan.pdf`, USER), true);
  assert.equal(m.ownsAttachment(`${USER.toUpperCase()}/${UPLOAD}/plan.pdf`, USER), true,
    'ids compare without regard to case');
  assert.equal(m.ownsAttachment(`${USER}/${UPLOAD}/plan.pdf`, ''), false);
  assert.equal(m.ownsAttachment(`${USER}/${UPLOAD}/plan.pdf`, 'not-a-uuid'), false);
});

test('a path that starts with your id but walks into someone else\'s folder is refused', () => {
  /* fetch resolves %2e%2e to .. BEFORE the request is sent, so this path —
     which begins with the caller's own id — used to download the victim's file. */
  for (const bad of [
    `${USER}/${UPLOAD}/%2e%2e/%2e%2e/${VICTIM}/${UPLOAD}/contract.pdf`,
    `${USER}/x/%2e%2e/%2e%2e/${VICTIM}/${UPLOAD}/contract.pdf`,
    `${USER}/${UPLOAD}/.%2E`,
    `${USER}/${UPLOAD}/..`,
    `${USER}/${UPLOAD}/.`,
    `${USER}/${UPLOAD}/a%2Fb.pdf`,
    `${USER}/${UPLOAD}/a?b.pdf`,
    `${USER}/${UPLOAD}/a#b.pdf`,
    `${USER}/${UPLOAD}/sub/plan.pdf`,
    `${USER}/x/plan.pdf`,
    `/${USER}/${UPLOAD}/plan.pdf`,
    `${VICTIM}/${UPLOAD}/plan.pdf`,
    'someone-else/x/plan.pdf',
  ]) {
    assert.equal(m.ownsAttachment(bad, USER), false, bad);
  }
  refused(newMail({ attachments: [{ ...file(1, 10), path: `${USER}/${UPLOAD}/%2e%2e/%2e%2e/${VICTIM}/${UPLOAD}/c.pdf` }] }),
    /attachment/);
});

test('outgoing html loses scripts, handlers and javascript: links, and keeps its formatting', () => {
  const clean = m.sanitizeOutgoingHtml(
    '<p style="color:red" onclick="x()">Hi <b>there</b></p><script>alert(1)</script>' +
    '<a href="javascript:alert(1)">bad</a><a href="https://veyago.cloud">site</a>' +
    '<iframe src="https://e.example"></iframe><img src="x" onerror=alert(1)>');
  assert.ok(!/<script|onclick|onerror|javascript:|<iframe/i.test(clean), clean);
  assert.match(clean, /<p style="color:red">Hi <b>there<\/b><\/p>/);
  assert.match(clean, /<a href="https:\/\/veyago\.cloud">site<\/a>/);
});

test('our text goes above the quoted original, inside its body tag', () => {
  assert.equal(
    m.prependToBody('<html><body dir="ltr"><div>quoted</div></body></html>', '<p>Reply</p>'),
    '<html><body dir="ltr"><p>Reply</p><div>quoted</div></body></html>');
  assert.equal(m.prependToBody('<div>quoted</div>', '<p>Reply</p>'), '<p>Reply</p><div>quoted</div>');
  assert.equal(m.prependToBody('', '<p>Reply</p>'), '<p>Reply</p>');
});

test('files of 3 MB or more take an upload session; smaller ones go in one request', () => {
  const plan = m.attachmentPlan([
    { name: 'a', size: 10 },
    { name: 'b', size: 3 * 1024 * 1024 },
    { name: 'c', size: 3 * 1024 * 1024 - 1 },
  ]);
  assert.deepEqual(plan.map((p) => p.method), ['inline', 'session', 'inline']);
  assert.equal(plan[1].name, 'b');
});
