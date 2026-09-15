/* Tests for _shared/connection-rules.ts — whose a connection is, what may be
   read through it and who may act on it. The functions that use these work
   with the service role, so these rules are all that stands between a manager
   and a colleague's personal mailbox or diary. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'connection-rules.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const ME = 'e-me';
const YOU = 'e-you';

/* ── Addresses ────────────────────────────────────────────────────────── */

test('a studio connection is never a team member\'s own address', () => {
  assert.match(m.labelProblem(null, ME), /cannot be a team member’s own/);
  assert.equal(m.labelProblem(null, null), null, 'hello@ belongs to nobody on the team');
});

test('a personal connection is its owner\'s address, or nobody\'s — never a colleague\'s', () => {
  assert.equal(m.labelProblem(ME, ME), null);
  assert.equal(m.labelProblem(ME, null), null, 'an alias the directory does not know');
  assert.equal(m.labelProblem(ME, YOU), 'This address belongs to another team member.');
});

test('a studio connection that records no consenter is not read: it would read /me', () => {
  const studio = { employee_id: null, account_label: 'hello@veyago.cloud' };
  assert.match(m.connectionProblem({ ...studio, external_id: null }, null), /who consented to it is not recorded/);
  assert.match(m.connectionProblem({ ...studio, external_id: '  ' }, null), /not recorded/);
  assert.equal(m.connectionProblem({ ...studio, external_id: 'sam@veyago.cloud' }, null), null);
  assert.equal(m.connectionProblem({ employee_id: ME, account_label: 'sam@veyago.cloud', external_id: null }, ME), null,
    'a personal connection read as /me is its owner\'s own');
});

/* ── Who acts ─────────────────────────────────────────────────────────── */

test('a function acts on the studio\'s connections and your own — not a colleague\'s', () => {
  assert.equal(m.mayActOn({ employee_id: null }, ME), true);
  assert.equal(m.mayActOn({ employee_id: ME }, ME), true);
  assert.equal(m.mayActOn({ employee_id: YOU }, ME), false);
  assert.equal(m.mayActOn({ employee_id: ME }, null), false, 'nobody known is nobody\'s owner');
});

test('reconnecting: owners and admins the studio\'s, anyone their own, nobody a colleague\'s', () => {
  const ask = (over) => m.connectRefusal({ manager: false, callerEmployeeId: ME, previous: null, saysWho: false, employeeId: null, ...over });
  assert.equal(ask({ manager: true, previous: { employee_id: null } }), null);
  assert.equal(ask({ manager: false, previous: { employee_id: null } }).status, 403);
  assert.equal(ask({ manager: false, previous: { employee_id: ME } }), null, 'staff reconnect their own mailbox');
  const colleague = ask({ manager: true, previous: { employee_id: YOU } });
  assert.equal(colleague.status, 409);
  assert.equal(colleague.message, m.OWNER_KEPT);
  assert.deepEqual({ ...ask({ manager: false, previous: { employee_id: YOU } }) },
    { ...ask({ manager: false, previous: null, saysWho: true }) },
    'to staff, a colleague\'s connection is answered as no connection at all');
  assert.equal(ask({ manager: true, previous: { employee_id: null }, saysWho: true, employeeId: ME }).status, 409,
    'a reconnect never changes whose a connection is');
});

test('connecting something new: owners and admins only, and they say whose it is', () => {
  const ask = (over) => m.connectRefusal({ manager: true, callerEmployeeId: ME, previous: null, saysWho: true, employeeId: null, ...over });
  assert.equal(ask({}), null);
  assert.equal(ask({ employeeId: YOU }), null, 'a manager may connect a colleague\'s own mailbox for them');
  assert.equal(ask({ manager: false }).status, 403);
  assert.equal(ask({ saysWho: false }).status, 400, 'leaving it out used to make it a studio connection');
});

/* ── Grants ───────────────────────────────────────────────────────────── */

test('a stored grant covers a scope however Microsoft wrote it, and a shorter one never covers .Shared', () => {
  const full = 'openid profile https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite.Shared';
  assert.equal(m.grantCovers(full, 'Calendars.ReadWrite.Shared'), true);
  assert.equal(m.grantCovers('Calendars.ReadWrite.Shared offline_access', 'Calendars.ReadWrite.Shared'), true);
  assert.equal(m.grantCovers('https://graph.microsoft.com/Calendars.ReadWrite', 'Calendars.ReadWrite.Shared'), false);
  assert.equal(m.grantCovers('https://graph.microsoft.com/Calendars.ReadWrite.Shared', 'Calendars.ReadWrite'), false,
    'the longer scope is not the shorter one');
  assert.equal(m.grantCovers(null, 'Calendars.ReadWrite.Shared'), false, 'no record is no scope');
});

/* ── The directory ────────────────────────────────────────────────────── */

const TEAM = { 'sam@veyago.cloud': ME, 'ana@veyago.cloud': YOU };
const ownerOf = (address) => TEAM[address] ?? null;
const SAM = { id: 'aad-sam', addresses: ['sam@veyago.cloud', 'sam.smith@veyago.cloud'] };
const ANA = { id: 'aad-ana', addresses: ['ana@veyago.cloud', 'ana.lima@veyago.cloud'] };

test('a directory entry keeps every address the account goes by, once, in lower case', () => {
  assert.deepEqual(m.directoryEntry({ id: 'aad-sam', mail: 'Sam@Veyago.cloud', userPrincipalName: 'sam.smith@veyago.cloud' }), SAM);
  assert.deepEqual(m.directoryEntry({ id: 'aad-hello', mail: 'hello@veyago.cloud', userPrincipalName: 'HELLO@veyago.cloud' }),
    { id: 'aad-hello', addresses: ['hello@veyago.cloud'] });
  assert.equal(m.directoryEntry(null), null);
});

test('a studio connection under a sign-in name the team does not store is still that person\'s own', () => {
  const problem = m.directoryProblem({
    employeeId: null, label: 'sam.smith@veyago.cloud',
    consenter: { id: 'aad-cas', addresses: ['cas@veyago.cloud'] }, found: [SAM], ownerOf,
  });
  assert.match(problem, /cannot be a team member’s own/);
});

test('a studio connection is never the consenting account, whether the directory finds the label or not', () => {
  const consenter = { id: 'aad-x', addresses: ['x@veyago.cloud'] };
  assert.match(m.directoryProblem({ employeeId: null, label: 'x.other@veyago.cloud', consenter, found: [{ id: 'aad-x', addresses: ['x.other@veyago.cloud'] }], ownerOf }),
    /consenting person’s own/);
  assert.match(m.directoryProblem({ employeeId: null, label: ' X@veyago.cloud', consenter, found: [], ownerOf }), /consenting person’s own/);
});

test('a colleague\'s diary shared with a manager becomes neither a studio calendar nor the manager\'s', () => {
  const manager = { id: 'aad-sam', addresses: ['sam@veyago.cloud'] };
  const ask = (employeeId) => m.directoryProblem({ employeeId, label: 'ana.lima@veyago.cloud', consenter: manager, found: [ANA], ownerOf });
  assert.match(ask(null), /team member’s own/);
  assert.equal(ask(ME), 'This address belongs to another team member.');
  assert.equal(ask(YOU), null, 'her own, connected for her');
});

test('the shared inbox, which is nobody on the team, passes', () => {
  assert.equal(m.directoryProblem({
    employeeId: null, label: 'hello@veyago.cloud', consenter: { id: 'aad-sam', addresses: ['sam@veyago.cloud'] },
    found: [{ id: 'aad-hello', addresses: ['hello@veyago.cloud'] }], ownerOf,
  }), null);
});

test('a mailbox read through another account\'s grant is one account the directory knows by that address', () => {
  const sam = { id: 'aad-sam', addresses: ['sam@veyago.cloud'] };
  const alias = (employeeId) => m.directoryProblem({ employeeId, label: 'ana.k@veyago.cloud', consenter: sam, found: [], ownerOf });
  assert.match(alias(null), /no account with this as its main address/, 'an alias of Ana\'s mailbox is not the studio\'s');
  assert.match(alias(ME), /no account/, 'nor read into someone else\'s own connection');
  assert.match(m.directoryProblem({
    employeeId: null, label: 'shared@veyago.cloud', consenter: sam, ownerOf,
    found: [{ id: 'aad-1', addresses: ['shared@veyago.cloud'] }, { id: 'aad-2', addresses: ['shared@veyago.cloud', 'x@veyago.cloud'] }],
  }), /More than one account/);
  assert.equal(m.directoryProblem({ employeeId: ME, label: 'sam@veyago.cloud', consenter: sam, found: [], ownerOf }), null,
    'your own mailbox, read as /me, needs nothing more from the directory');
});

test('a studio connection made before the directory check waits for a reconnect; a personal one does not', () => {
  const before = 'openid offline_access https://graph.microsoft.com/Mail.ReadWrite';
  const after = `${before} https://graph.microsoft.com/User.ReadBasic.All`;
  assert.match(m.grantProblem({ employee_id: null }, before), /Reconnect this studio connection/);
  assert.equal(m.grantProblem({ employee_id: null }, after), null);
  assert.match(m.grantProblem({ employee_id: null }, null), /Reconnect/, 'no grant on record is no check');
  assert.equal(m.grantProblem({ employee_id: ME }, before), null, 'read as its owner\'s own, it shows nobody else anything');
});

test('the directory is asked by mail or sign-in name, with a quote doubled', () => {
  const query = m.directoryQuery(" O'Brien@Veyago.cloud ");
  assert.ok(query.startsWith('/users?$filter='));
  assert.ok(query.endsWith('&$select=id,mail,userPrincipalName'));
  assert.equal(decodeURIComponent(query.slice('/users?$filter='.length, query.indexOf('&$select'))),
    "mail eq 'o''brien@veyago.cloud' or userPrincipalName eq 'o''brien@veyago.cloud'");
});
