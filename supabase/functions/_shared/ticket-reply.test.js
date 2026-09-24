/* Tests for _shared/ticket-reply.ts.
   The first block is the one that matters: an internal note reaching the
   customer is the worst thing this feature could do, so it is asserted from
   several directions rather than trusted to one `if`. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'ticket-reply.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const ticket = { number: 142, subject: 'Subscription not restoring on new device' };

test('the rate limit\'s filter quotes its message, so what is in it stays in it', () => {
  assert.equal(m.notRefusedBy('More than 20 replies in 5 minutes. Wait a few minutes before sending more.'),
    'delivery_error.is.null,delivery_error.neq."More than 20 replies in 5 minutes. Wait a few minutes before sending more."');
  assert.equal(m.notRefusedBy('Too many (20), "slow down" \\ please'),
    'delivery_error.is.null,delivery_error.neq."Too many (20), \\"slow down\\" \\\\ please"',
    'a quote or a backslash is escaped, and a comma or parenthesis stays inside the quotes');
});

test('an internal note is never sent, whatever else is true', () => {
  const d = m.decideSend({ direction: 'internal', body: 'Receipt looks valid.', toEmail: 'a@b.com' });
  assert.equal(d.send, false);
  assert.match(d.reason, /Internal/);
});

test('an inbound message is not sent back to the sender', () => {
  assert.equal(m.decideSend({ direction: 'inbound', body: 'hi', toEmail: 'a@b.com' }).send, false);
});

test('an outbound reply with an address is sent', () => {
  assert.deepEqual(m.decideSend({ direction: 'outbound', body: 'On it.', toEmail: 'a@b.com' }),
    { send: true });
});

test('no contact email means saved but not sent, and says so', () => {
  const d = m.decideSend({ direction: 'outbound', body: 'On it.', toEmail: null });
  assert.equal(d.send, false);
  assert.match(d.reason, /saved but not sent/);
});

test('an empty reply is not sent', () => {
  assert.equal(m.decideSend({ direction: 'outbound', body: '   ', toEmail: 'a@b.com' }).send, false);
});

test('an obviously broken address is refused before the provider sees it', () => {
  assert.equal(m.decideSend({ direction: 'outbound', body: 'x', toEmail: 'not-an-address' }).send, false);
  assert.equal(m.decideSend({ direction: 'outbound', body: 'x', toEmail: 'a@b' }).send, false);
  // …but a valid address with unusual parts is allowed through to the provider.
  assert.equal(m.decideSend({ direction: 'outbound', body: 'x', toEmail: "o'brien+tag@sub.example.co.uk" }).send, true);
});

test('a reply goes to the linked contact, or — the CRM has none — the raw address the ticket came in on', () => {
  assert.equal(m.replyAddress({ contactEmail: 'ana@northline.example', requesterEmail: 'guest@example.invalid' }),
    'ana@northline.example', 'a linked contact always wins, even over a requester address on file');
  assert.equal(m.replyAddress({ contactEmail: null, requesterEmail: 'guest@example.invalid' }), 'guest@example.invalid');
  assert.equal(m.replyAddress({ contactEmail: '', requesterEmail: '  guest@example.invalid  ' }), 'guest@example.invalid',
    'trimmed, the way a typed address is everywhere else');
  assert.equal(m.replyAddress({}), null, 'neither is nothing to send to');
  assert.equal(m.replyAddress({ contactEmail: '   ', requesterEmail: null }), null, 'blank is the same as none');
});

test('the subject carries the reference and does not stack Re:', () => {
  assert.equal(m.replySubject(ticket),
    'Re: Subscription not restoring on new device [#VYG-142]');
  assert.equal(m.replySubject({ number: 7, subject: 'Re: Re: hello' }), 'Re: hello [#VYG-7]');
  assert.equal(m.replySubject({ number: 7, subject: '' }), 'Re: Your message [#VYG-7]');
});

test('the reference survives a round trip through a subject line', () => {
  const subject = m.replySubject(ticket);
  assert.equal(m.ticketNumberFromSubject(subject), 142);
  assert.equal(m.ticketNumberFromSubject('RE: something [#vyg-9] fwd'), 9);
  assert.equal(m.ticketNumberFromSubject('no reference here'), null);
  assert.equal(m.ticketNumberFromSubject(''), null);
});

test('blank lines become paragraphs, single newlines stay inside one', () => {
  const html = m.bodyToHtml('First thought.\n\nSecond thought.\nStill the second.');
  assert.equal((html.match(/<p /g) || []).length, 2);
  assert.match(html, /Still the second/);
  assert.match(html, /Second thought\.<br>/);
});

test('the body is escaped — a customer reply is untrusted text', () => {
  const html = m.bodyToHtml('<script>alert(1)</script> & "quotes"');
  assert.ok(!html.includes('<script>'), 'script tag must not survive');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('the email greets by first name and signs off with the sender', () => {
  const mail = m.ticketReplyEmail({
    ticket, body: 'We have found it.', fromName: 'Cassian Drefke', contactName: 'Olivia Chen'
  });
  assert.equal(mail.subject, 'Re: Subscription not restoring on new device [#VYG-142]');
  assert.match(mail.bodyHtml, /Hi Olivia,/);
  assert.match(mail.bodyHtml, /Cassian Drefke/);
  assert.match(mail.bodyHtml, /#VYG-142/);
  assert.match(mail.text, /Hi Olivia,/);
  assert.match(mail.text, /We have found it\./);
});

test('a nameless contact still gets a sensible greeting', () => {
  const mail = m.ticketReplyEmail({ ticket, body: 'Hello.' });
  assert.match(mail.bodyHtml, /Hi,/);
  assert.match(mail.bodyHtml, /Veyago/);
});

const studio = { id: 's', account_label: 'hello@veyago.cloud', employee_id: null, status: 'connected' };
const personal = { id: 'p', account_label: 'cassian@veyago.cloud', employee_id: 'e1', status: 'connected' };

test('a support reply leaves from a studio mailbox, never from a person\'s own', () => {
  assert.equal(m.pickTicketMailbox([personal, studio]).id, 's');
  assert.equal(m.pickTicketMailbox([personal]), null,
    'better Resend from the studio address than a customer answered from a private inbox');
  assert.equal(m.pickTicketMailbox([{ ...studio, status: 'needs_reauth' }]), null);
  assert.equal(m.pickTicketMailbox([]), null);
  assert.equal(m.pickTicketMailbox(undefined), null);
});

test('with two studio mailboxes the choice does not depend on row order', () => {
  const support = { ...studio, id: 'a', account_label: 'support@veyago.cloud' };
  assert.equal(m.pickTicketMailbox([support, studio]).id, 's');
  assert.equal(m.pickTicketMailbox([studio, support]).id, 's');
});

test('a contact name that is markup cannot break out of the greeting', () => {
  const mail = m.ticketReplyEmail({ ticket, body: 'x', contactName: '<b>Ann</b> Smith' });
  assert.ok(!mail.bodyHtml.includes('<b>Ann</b>'));
  assert.match(mail.bodyHtml, /&lt;b&gt;Ann&lt;\/b&gt;/);
});
