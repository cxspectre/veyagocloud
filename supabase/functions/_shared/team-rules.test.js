/* Tests for _shared/team-rules.ts — who may give whom which role.
   invite-employee writes employees with the service role, which the
   database's guard on employees (migration 0042) lets through, so these are
   the only questions asked before an invitation rewrites someone's role. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'team-rules.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const member = (role, email, status = 'active', userId = 'u-someone') => ({ email, role, status, user_id: userId });
const ask = (over) => m.inviteRefusal({
  callerRole: 'admin', callerUserId: ADMIN, email: 'new@veyago.cloud', role: 'employee', existing: [], ...over
});

test('only an owner can make someone an owner', () => {
  assert.equal(ask({ role: 'owner' }), 'Only an owner can make someone an owner.');
  assert.equal(ask({ callerRole: 'owner', callerUserId: OWNER, role: 'owner' }), null);
});

test('an admin cannot re-invite an owner, whatever role the invitation carries', () => {
  const owner = [member('owner', 'ana@veyago.cloud', 'active', OWNER)];
  for (const role of ['employee', 'assistant', 'admin']) {
    assert.equal(ask({ email: 'ana@veyago.cloud', role, existing: owner }), 'Only an owner can re-invite an owner.', role);
  }
  assert.equal(ask({ callerRole: 'owner', callerUserId: 'u-co-owner', email: 'ana@veyago.cloud', role: 'admin', existing: owner }), null,
    'another owner may: the database still keeps an owner who can sign in');
});

test('an owner is recognised whatever case their address was stored in', () => {
  assert.equal(ask({ email: 'ana@veyago.cloud', existing: [member('owner', 'Ana@Veyago.cloud', 'active', OWNER)] }),
    'Only an owner can re-invite an owner.');
  assert.match(ask({ email: 'sam@veyago.cloud', existing: [member('admin', 'Sam@Veyago.cloud', 'active', ADMIN)] }),
    /re-invite yourself/);
});

test('nobody re-invites themselves, owner or admin', () => {
  assert.match(ask({ role: 'owner', email: 'sam@veyago.cloud', existing: [member('admin', 'sam@veyago.cloud', 'active', ADMIN)] }),
    /re-invite yourself/);
  assert.match(ask({ callerRole: 'owner', callerUserId: OWNER, email: 'ana@veyago.cloud', existing: [member('owner', 'ana@veyago.cloud', 'active', OWNER)] }),
    /re-invite yourself/);
});

test('an admin still invites and re-invites everyone else', () => {
  assert.equal(ask({ role: 'admin' }), null);
  assert.equal(ask({ email: 'jo@veyago.cloud', existing: [member('assistant', 'jo@veyago.cloud', 'inactive')] }), null);
  assert.equal(ask({ email: 'jo@veyago.cloud', role: 'assistant', existing: [member('employee', 'jo@veyago.cloud', 'invited', null)] }), null,
    'a row nobody has signed in to yet belongs to nobody, not to the caller');
});

test('the same person written in another case is not added a second time', () => {
  assert.equal(ask({ callerRole: 'owner', callerUserId: OWNER, email: 'jo@veyago.cloud', existing: [member('employee', 'Jo@Veyago.cloud')] }),
    'Jo@Veyago.cloud is already on the team. Re-invite them from their profile.');
});

test('without a role of their own, nobody is an owner', () => {
  assert.equal(ask({ callerRole: null, role: 'owner' }), 'Only an owner can make someone an owner.');
  assert.equal(ask({ callerRole: null, email: 'ana@veyago.cloud', existing: [member('owner', 'ana@veyago.cloud', 'active', OWNER)] }),
    'Only an owner can re-invite an owner.');
});

test('addresses are the same mailbox whatever their case or surrounding space', () => {
  assert.equal(m.sameAddress(' Ana@Veyago.Cloud ', 'ana@veyago.cloud'), true);
  assert.equal(m.sameAddress('ana@veyago.cloud', 'anna@veyago.cloud'), false);
  assert.equal(m.sameAddress('', ''), false, 'no address is nobody');
  assert.equal(m.sameAddress(null, undefined), false);
});

test('a new sign-in link leaves someone active; anyone else is invited', () => {
  assert.equal(m.statusAfterInvite(member('employee', 'a@b.c', 'active')), 'active');
  assert.equal(m.statusAfterInvite(member('employee', 'a@b.c', 'inactive')), 'invited');
  assert.equal(m.statusAfterInvite(member('employee', 'a@b.c', 'invited')), 'invited');
  assert.equal(m.statusAfterInvite(null), 'invited');
});

test('a member who can sign in is only ever invited at their own account\'s address', () => {
  const linked = member('employee', 'jo@veyago.cloud', 'active', 'u-jo');
  assert.equal(m.signInRefusal(linked, 'Jo@Veyago.cloud', 'jo@veyago.cloud'), null, 'the same account, whatever the case');
  assert.equal(m.signInRefusal(linked, 'jo.private@example.com', 'jo@veyago.cloud'),
    'jo@veyago.cloud signs in with a different address. Deactivate them and invite the new address instead.',
    'a new account for this address would take over their row');
  assert.equal(m.signInRefusal(linked, null, 'jo@veyago.cloud') !== null, true, 'an account with no address is not a match');
  assert.equal(m.signInRefusal(member('employee', 'jo@veyago.cloud', 'invited', null), null, 'jo@veyago.cloud'), null,
    'nobody has signed in to this row yet');
  assert.equal(m.signInRefusal(null, null, 'new@veyago.cloud'), null, 'a new member');
});

test('a sign-in link is handed back only for an account the invitation created', () => {
  const link = 'https://veyago.cloud/auth/v1/verify?token=t';
  assert.equal(m.linkToHandBack({ emailSent: false, existingAccount: false, actionLink: link }), link,
    'the rescue for a new hire whose email did not arrive');
  assert.equal(m.linkToHandBack({ emailSent: false, existingAccount: true, actionLink: link }), null,
    'for an existing login it would be a password reset for someone else\'s account');
  assert.equal(m.linkToHandBack({ emailSent: true, existingAccount: false, actionLink: link }), null,
    'a link that went by email is not also handed to the sender');
});
