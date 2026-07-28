/* Tests for _shared/mercury-account-name.ts.
   Reported directly from production: two Mercury accounts nicknamed "Mercury
   Checking" and "Mercury Savings" were showing as "Mercury Mercury Checking"
   and "Mercury Mercury Savings ..." (truncated) in the Accounts panel. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mercury-account-name.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('does not double-prefix a nickname that already says Mercury', () => {
  assert.equal(m.accountLabel({ nickname: 'Mercury Checking' }), 'Mercury Checking');
  assert.equal(m.accountLabel({ nickname: 'Mercury Savings' }), 'Mercury Savings');
  assert.equal(m.accountLabel({ nickname: 'mercury checking' }), 'mercury checking',
    'matched case-insensitively but the original casing is kept, not forced');
});

test('prefixes a nickname that does not already say Mercury', () => {
  assert.equal(m.accountLabel({ nickname: 'Operating' }), 'Mercury Operating');
  assert.equal(m.accountLabel({ nickname: 'Payroll reserve' }), 'Mercury Payroll reserve');
});

test('does not match "Mercury" as a substring of a different word', () => {
  assert.equal(m.accountLabel({ nickname: 'Mercuryville Branch' }), 'Mercury Mercuryville Branch',
    'only a real leading "Mercury" word should suppress the prefix');
});

test('falls back through name then kind then a literal default, same as before', () => {
  assert.equal(m.accountLabel({ nickname: null, name: 'Checking ••1234' }), 'Mercury Checking ••1234');
  assert.equal(m.accountLabel({ nickname: '', name: '', kind: 'checking' }), 'Mercury checking');
  assert.equal(m.accountLabel({}), 'Mercury Account');
});

test('an empty-string nickname is treated as absent, not as a literal label', () => {
  assert.equal(m.accountLabel({ nickname: '', name: 'Reserve' }), 'Mercury Reserve');
});
