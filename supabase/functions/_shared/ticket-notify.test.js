/* Tests for _shared/ticket-notify.ts's notifyRecipient — the one decision
   both notify-ticket/index.ts (assigned) and mail-sync.ts (a customer's
   reply) have to agree on: who actually hears about a ticket. The email
   composition and the database/network side (notifyRepliedTickets) are not
   unit tested here — no live Postgres or Resend in this suite, the same
   reason notify-task/index.ts itself has no test file; this is the part of
   that same shape that is pure enough to be worth testing on its own. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let notifyRecipient;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'ticket-notify.ts'), 'utf8');
  const js = stripTypeScriptTypes(src);
  // email.ts is not needed for notifyRecipient; stub its two imports away
  // rather than pull in the whole template module and its Deno.env reads.
  const stubbed = js.replace(/^import \{ sendEmail, ticketCustomerReplyEmail \} from '\.\/email\.ts';$/m,
    'const sendEmail = null, ticketCustomerReplyEmail = null;');
  if (stubbed === js) throw new Error('ticket-notify.test.js: the email.ts import line has changed shape — update the stub');
  ({ notifyRecipient } = await import('data:text/javascript,' + encodeURIComponent(stubbed)));
});

const employee = (over = {}) => ({ full_name: 'Sam Rivera', email: 'sam@veyago.cloud', status: 'active', user_id: 'u-sam', ...over });

test('nobody assigned is nobody to tell', () => {
  assert.deepEqual(notifyRecipient(null), { notify: false, reason: 'unassigned' });
  assert.deepEqual(notifyRecipient(undefined), { notify: false, reason: 'unassigned' });
});

test('an assignee with no email on file cannot be told', () => {
  assert.deepEqual(notifyRecipient(employee({ email: null })), { notify: false, reason: 'no email on file' });
  assert.deepEqual(notifyRecipient(employee({ email: '' })), { notify: false, reason: 'no email on file' });
});

test('an inactive assignee is not told', () => {
  assert.deepEqual(notifyRecipient(employee({ status: 'inactive' })), { notify: false, reason: 'inactive' });
});

test('the person who just caused this is not told about their own action', () => {
  assert.deepEqual(notifyRecipient(employee({ user_id: 'u-sam' }), 'u-sam'), { notify: false, reason: 'self' });
});

test('a reachable, active assignee — not the acting person — is told', () => {
  assert.deepEqual(notifyRecipient(employee(), 'u-someone-else'), { notify: true });
  assert.deepEqual(notifyRecipient(employee()), { notify: true }, 'no acting person given at all (a mail sync, not a browser click)');
});

test('inactive is judged before self, and no email before either', () => {
  assert.deepEqual(notifyRecipient(employee({ status: 'inactive', user_id: 'u-sam' }), 'u-sam'), { notify: false, reason: 'inactive' });
  assert.deepEqual(notifyRecipient(employee({ email: null, status: 'inactive' })), { notify: false, reason: 'no email on file' });
});
