/* Tests for the shared helpers in admin/js/client.js.

   Focus is safeAdminPath, which gates every value that reaches location.href
   from storage or the address bar. Getting it wrong is an open redirect, so the
   rejection cases matter more than the acceptance ones.

   client.js builds a Supabase client at load, so the harness stubs
   window.supabase before running it. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

function load() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://veyago.cloud/admin/team',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  const noop = () => {};
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: noop,
        signOut: async () => ({})
      },
      from: () => ({}),
      functions: { invoke: async () => ({}) }
    })
  };
  window.VEYAGO_SUPABASE = { url: 'https://x.supabase.co', anonKey: 'anon' };
  vm.runInContext(SRC, dom.getInternalVMContext());
  return window.admin;
}

const admin = load();

test('accepts a plain admin path', () => {
  assert.equal(admin.safeAdminPath('/admin/team'), '/admin/team');
  assert.equal(admin.safeAdminPath('/admin/member?id=abc-123'), '/admin/member?id=abc-123');
  assert.equal(admin.safeAdminPath('/admin/transactions?tx=9#row'), '/admin/transactions?tx=9#row');
});

/* Each of these is a valid value for location.href that leaves the site. */
test('rejects anything that could navigate off-origin', () => {
  for (const evil of [
    'https://evil.com',
    'http://evil.com/admin/team',
    '//evil.com',
    '//evil.com/admin/team',
    '/\\evil.com',
    '/\\/evil.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '\\\\evil.com'
  ]) {
    assert.equal(admin.safeAdminPath(evil), null, evil + ' must be rejected');
  }
});

test('rejects paths outside the admin', () => {
  for (const p of ['/', '/journal', '/wallpapers/', '/adminx/team', '/admin', 'admin/team']) {
    assert.equal(admin.safeAdminPath(p), null, p + ' must be rejected');
  }
});

/* "Return to where you were" must never resolve to the login screen — that is
   the redirect loop this guard exists to prevent. */
test('rejects the login page itself', () => {
  for (const p of ['/admin/', '/admin/index', '/admin/index.html', '/admin/?x=1', '/admin/index.html#y']) {
    assert.equal(admin.safeAdminPath(p), null, p + ' is not a destination');
  }
});

test('rejects non-strings and empty values', () => {
  for (const v of [null, undefined, '', 0, 42, {}, [], true]) {
    assert.equal(admin.safeAdminPath(v), null, JSON.stringify(v) + ' must be rejected');
  }
});

test('a backslash anywhere is rejected rather than normalised', () => {
  assert.equal(admin.safeAdminPath('/admin/team\\..\\..\\evil'), null);
  assert.equal(admin.safeAdminPath('/admin\\team'), null);
});
