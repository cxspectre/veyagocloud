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
  assert.equal(admin.safeAdminPath('/admin/finance?tx=9#transactions'), '/admin/finance?tx=9#transactions');
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

/* ── statCards ────────────────────────────────────────────────────────────
   Used by 7 admin pages (dashboard, team, tasks, checklist, and Finance's own
   3 tabs) — shared, high blast radius if the size/color logic drifts. */

const { JSDOM: JSDOM2 } = require('jsdom');
function wrapEl() {
  return new JSDOM2('<!doctype html><div id="w"></div>').window.document.getElementById('w');
}

test('a plain count stays at full size regardless of digit count', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: 123456789, label: 'Count' }]);
  const n = wrap.querySelector('.dash-stat-n');
  assert.equal(n.getAttribute('style'), null, 'a number is never shrunk, no matter how long');
});

test('a short currency figure keeps the full 2rem hero size', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: '$524.16', label: 'Income this month' }]);
  const n = wrap.querySelector('.dash-stat-n');
  assert.equal(n.getAttribute('style'), null,
    'a short dollar amount must not be shrunk just for containing a $ and a .');
});

test('a genuinely long currency figure still shrinks to fit', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: '$12,345,678.90', label: 'Lifetime revenue' }]);
  const n = wrap.querySelector('.dash-stat-n');
  assert.match(n.getAttribute('style') || '', /font-size:\s*1\.45rem/);
});

test('nColor tints the hero number without forcing the shrink path', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: '-$524.16', label: 'Net this month', nColor: 'var(--ac-danger)' }]);
  const n = wrap.querySelector('.dash-stat-n');
  assert.match(n.getAttribute('style'), /color:var\(--ac-danger\)/);
  assert.ok(!/font-size/.test(n.getAttribute('style')), 'a short figure with a color must not also shrink');
});

test('nColor and the shrink path combine when both apply', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: '-$12,345,678.90', label: 'Net', nColor: 'var(--ac-danger)' }]);
  const style = wrap.querySelector('.dash-stat-n').getAttribute('style');
  assert.match(style, /font-size:\s*1\.45rem/);
  assert.match(style, /color:var\(--ac-danger\)/);
});

test('n2Color is unaffected by the nColor addition', () => {
  const wrap = wrapEl();
  admin.statCards(wrap, [{ n: 3, label: 'Overdue', n2: '$400 past due', n2Color: 'var(--fg-danger)' }]);
  const n2 = wrap.querySelector('.dash-stat-n2');
  assert.match(n2.getAttribute('style'), /color:var\(--fg-danger\)/);
});
