/* Tests for _shared/mailbox.ts.
   The failure this guards against does not throw: /me against a shared-mailbox
   connection returns the consenting user's own mail, under a connection
   labelled as the studio inbox. Nothing errors; the wrong mail just arrives. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'mailbox.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

test('a shared mailbox is addressed explicitly', () => {
  const conn = { account_label: 'hello@veyago.cloud', external_id: 'cdrefke@veyago.cloud' };
  assert.equal(m.isShared(conn), true);
  assert.equal(m.mailboxPath(conn), '/users/hello%40veyago.cloud');
});

test('your own mailbox is /me', () => {
  const conn = { account_label: 'cdrefke@veyago.cloud', external_id: 'cdrefke@veyago.cloud' };
  assert.equal(m.isShared(conn), false);
  assert.equal(m.mailboxPath(conn), '/me');
});

test('the comparison ignores case and spacing, as addresses do', () => {
  assert.equal(m.isShared({ account_label: ' CDrefke@Veyago.Cloud ', external_id: 'cdrefke@veyago.cloud' }),
    false, 'the same mailbox written differently is still the same mailbox');
});

test('a connection with no recorded consenter falls back to /me', () => {
  assert.equal(m.mailboxPath({ account_label: 'hello@veyago.cloud' }), '/me');
  assert.equal(m.mailboxPath({ account_label: 'hello@veyago.cloud', external_id: null }), '/me');
  assert.equal(m.mailboxPath({ account_label: 'hello@veyago.cloud', external_id: '' }), '/me');
});

test('an address with characters needing escaping is encoded', () => {
  assert.equal(
    m.mailboxPath({ account_label: "o'brien+support@veyago.cloud", external_id: 'cdrefke@veyago.cloud' }),
    "/users/o'brien%2Bsupport%40veyago.cloud");
});
