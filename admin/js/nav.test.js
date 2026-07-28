/* Tests for admin/js/nav.js — specifically which sidebar item is marked active.

   Seven admin screens are the second level of a section (an article belongs to
   Journal, a member to Team) and appear in no NAV entry. They previously matched
   nothing, so the sidebar highlighted no item at all on exactly the screens where
   the user is deepest. These tests pin the parent mapping down. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'nav.js'), 'utf8');

/* Mount nav.js against a given admin path and report the sidebar it built.

   The document must have finished parsing first: nav.js defers to
   DOMContentLoaded while readyState is 'loading', which is exactly what a fresh
   JSDOM reports. Running the source before then registers the listener and
   mounts nothing. */
async function mountAt(pathname, { role = 'owner', cachedRole = role, session = {}, pending = null } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="adm-shell"><main class="adm-main"></main></div></body></html>',
    {
      url: 'https://veyago.cloud' + pathname,
      runScripts: 'outside-only',
      virtualConsole: new VirtualConsole()
    }
  );

  const { window } = dom;

  /* Give nav.js the real shape it sees in production: a resolved adminReady
     promise plus an async role check. Stubbing adminReady to null would skip
     the reveal branch entirely — the branch production always takes. */
  const manager = role === 'owner' || role === 'admin';
  const publisher = manager || role === 'assistant';
  window.adminRoles = {
    cachedRole: () => cachedRole,
    isManager: async () => manager,
    isPublisher: async () => publisher,
    resolve: async () => ({ role, employee: { full_name: 'Test Person' } })
  };
  window.adminReady = session === null ? Promise.resolve(null)
                                       : Promise.resolve({ user: { email: 'test@veyago.cloud' } });

  /* Only stubbed when a test cares: nav.js bails out when window.sb is absent,
     which is also what happens on a page that failed to boot Supabase. */
  if (pending !== null) {
    window.sb = {
      from: () => ({
        select: () => ({
          eq: async () => (pending === 'error'
            ? { count: null, error: { message: 'relation does not exist' } }
            : { count: pending, error: null })
        })
      })
    };
  }

  if (window.document.readyState === 'loading') {
    await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }
  vm.runInContext(SRC, dom.getInternalVMContext());

  /* Let the adminReady.then chain and its two awaits settle. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const active = [...window.document.querySelectorAll('.adm-nav a.active')];
  return {
    window,
    activeLabels: active.map((a) => a.textContent.trim()),
    activeHrefs: active.map((a) => a.getAttribute('href')),
    ariaCurrent: active.map((a) => a.getAttribute('aria-current')),
    allHrefs: [...window.document.querySelectorAll('.adm-nav a')].map((a) => a.getAttribute('href'))
  };
}

test('the sidebar lists every screen a user can navigate to', async () => {
  const { allHrefs } = await mountAt('/admin/');
  assert.deepEqual(allHrefs, [
    '/admin/', '/admin/journal', '/admin/wallpapers', '/admin/apps', '/admin/announcements',
    '/admin/publish',
    '/admin/tasks', '/admin/team', '/admin/onboarding', '/admin/checklist',
    '/admin/finance', '/admin/transactions', '/admin/invoices'
  ]);
});

/* Transactions and Invoices own every finance write and had no entry at all;
   Checklist edits every employee's list from one small header button. */
test('the finance write screens and the checklist template are reachable from the nav', async () => {
  const { allHrefs } = await mountAt('/admin/');
  for (const href of ['/admin/transactions', '/admin/invoices', '/admin/checklist']) {
    assert.ok(allHrefs.includes(href), href + ' must be in the sidebar');
  }
});

test('second-level destinations render indented and without an icon', async () => {
  const { window } = await mountAt('/admin/');
  for (const href of ['/admin/checklist', '/admin/transactions', '/admin/invoices']) {
    const a = window.document.querySelector('.adm-nav a[href="' + href + '"]');
    assert.ok(a.classList.contains('adm-nav-sub'), href + ' is a sub item');
    assert.equal(a.querySelector('svg'), null, href + ' carries no icon');
  }
  // ...and top-level items still do have one.
  assert.ok(window.document.querySelector('.adm-nav a[href="/admin/finance"] svg'));
});

/* Detail screens are not destinations, so they light their parent instead.
   Each of these used to highlight nothing at all. */
const PARENT_CASES = [
  ['/admin/article',      '/admin/journal',    'Journal'],
  ['/admin/apps-editor',  '/admin/apps',       'Apps'],
  ['/admin/member',       '/admin/team',       'Team'],
  ['/admin/member-new',   '/admin/team',       'Team'],
  ['/admin/task',         '/admin/tasks',      'Tasks']
];

/* member-new must not fall through to the `member` prefix by accident — it is
   its own file and needs its own entry. */
test('member-new maps to Team in its own right, not via member', async () => {
  const { activeHrefs } = await mountAt('/admin/member-new?step=review');
  assert.deepEqual(activeHrefs, ['/admin/team']);
});

/* These are first-class now, so they highlight themselves rather than a parent. */
test('checklist, transactions and invoices highlight themselves', async () => {
  for (const [route, label] of [
    ['/admin/checklist', 'Checklist'],
    ['/admin/transactions', 'Transactions'],
    ['/admin/invoices', 'Invoices']
  ]) {
    const { activeHrefs, activeLabels } = await mountAt(route);
    assert.deepEqual(activeHrefs, [route], route);
    assert.deepEqual(activeLabels, [label], route);
  }
});

for (const [route, expectedHref, expectedLabel] of PARENT_CASES) {
  test(`${route} highlights its parent, ${expectedLabel}`, async () => {
    const { activeHrefs, activeLabels } = await mountAt(route);
    assert.deepEqual(activeHrefs, [expectedHref]);
    assert.deepEqual(activeLabels, [expectedLabel]);
  });

  test(`${route}.html highlights the same parent as its clean URL`, async () => {
    const { activeHrefs } = await mountAt(route + '.html');
    assert.deepEqual(activeHrefs, [expectedHref]);
  });
}

/* Query strings are how every detail screen is actually reached. */
test('a detail route with ?id= still highlights its parent', async () => {
  const { activeHrefs } = await mountAt('/admin/member?id=abc-123');
  assert.deepEqual(activeHrefs, ['/admin/team']);
});

test('top-level screens still highlight themselves', async () => {
  for (const [route, label] of [
    ['/admin/journal', 'Journal'], ['/admin/team', 'Team'],
    ['/admin/tasks', 'Tasks'], ['/admin/finance', 'Finance'],
    ['/admin/wallpapers', 'Wallpapers'], ['/admin/apps', 'Apps'],
    ['/admin/announcements', 'Announcements'], ['/admin/onboarding', 'Onboarding']
  ]) {
    const { activeLabels } = await mountAt(route);
    assert.deepEqual(activeLabels, [label], route);
  }
});

test('every form of the dashboard route highlights Home', async () => {
  for (const route of ['/admin/', '/admin/index.html', '/admin/index']) {
    const { activeLabels } = await mountAt(route);
    assert.deepEqual(activeLabels, ['Home'], route);
  }
});

test('exactly one item is ever active', async () => {
  const routes = ['/admin/', '/admin/journal', '/admin/article', '/admin/member',
                  '/admin/invoices', '/admin/task', '/admin/checklist'];
  for (const route of routes) {
    assert.equal((await mountAt(route)).activeHrefs.length, 1, route);
  }
});

test('the active item is exposed to assistive tech as the current page', async () => {
  const { ariaCurrent } = await mountAt('/admin/article');
  assert.deepEqual(ariaCurrent, ['page']);
});

test('non-active items carry no aria-current', async () => {
  const { window } = await mountAt('/admin/article');
  const marked = [...window.document.querySelectorAll('.adm-nav a[aria-current]')];
  assert.equal(marked.length, 1);
  assert.equal(marked[0].getAttribute('href'), '/admin/journal');
});

/* Finance is manager-only. These run the real adminReady path, so they cover
   the async reveal rather than just the cached-role first paint. */
test('an employee on a finance sub-screen never gets Finance revealed', async () => {
  const { window } = await mountAt('/admin/invoices', { role: 'employee' });
  const finance = window.document.querySelector('.adm-nav a[href="/admin/finance"]');
  assert.equal(finance.hidden, true, 'still hidden after the async isManager() check');
});

test('a manager sees Finance after the async check', async () => {
  const { window } = await mountAt('/admin/finance', { role: 'admin' });
  const finance = window.document.querySelector('.adm-nav a[href="/admin/finance"]');
  assert.equal(finance.hidden, false);
});

/* The cached role drives first paint; the async check is what corrects it. A
   manager whose cache is cold must still end up with Finance visible. */
test('a manager with no cached role gets Finance revealed by the async check', async () => {
  const { window } = await mountAt('/admin/', { role: 'owner', cachedRole: null });
  const finance = window.document.querySelector('.adm-nav a[href="/admin/finance"]');
  assert.equal(finance.hidden, false, 'the reveal must not depend on the cache');
});

test('a stale manager cache is corrected for a real employee', async () => {
  const { window } = await mountAt('/admin/', { role: 'employee', cachedRole: 'admin' });
  const finance = window.document.querySelector('.adm-nav a[href="/admin/finance"]');
  assert.equal(finance.hidden, true, 'the async check must be able to re-hide');
});

/* Publish is the first item visible to assistants but not to employees — a
   third tier, not a rename of `manager`. */
test('an assistant sees Publish but not the manager-only items', async () => {
  const { window } = await mountAt('/admin/', { role: 'assistant' });
  const pub = window.document.querySelector('.adm-nav a[href="/admin/publish"]');
  const fin = window.document.querySelector('.adm-nav a[href="/admin/finance"]');
  assert.equal(pub.hidden, false, 'Publish is reachable');
  assert.equal(fin.hidden, true, 'Finance is not');
});

test('an employee sees neither', async () => {
  const { window } = await mountAt('/admin/', { role: 'employee' });
  assert.equal(window.document.querySelector('.adm-nav a[href="/admin/publish"]').hidden, true);
  assert.equal(window.document.querySelector('.adm-nav a[href="/admin/finance"]').hidden, true);
});

test('a manager sees Publish too', async () => {
  const { window } = await mountAt('/admin/', { role: 'admin' });
  assert.equal(window.document.querySelector('.adm-nav a[href="/admin/publish"]').hidden, false);
});

test('a stale employee cache is corrected for a real assistant', async () => {
  const { window } = await mountAt('/admin/', { role: 'assistant', cachedRole: 'employee' });
  assert.equal(window.document.querySelector('.adm-nav a[href="/admin/publish"]').hidden, false,
    'the async check must be able to reveal, not just hide');
});

/* There is no notification mechanism anywhere in this admin, so the count is
   the only always-visible signal that an approval is waiting. */
test('a waiting approval shows a count on Publish, for managers', async () => {
  const { window } = await mountAt('/admin/', { role: 'admin', pending: 3 });
  const link = window.document.querySelector('.adm-nav a[href="/admin/publish"]');
  const badge = link.querySelector('.adm-nav-count');
  assert.ok(badge, 'badge rendered');
  assert.equal(badge.textContent, '3');
  assert.match(link.getAttribute('aria-label'), /3 waiting for approval/,
    'the count must reach the accessible name, not just the pixels');
});

test('an assistant gets no count — they cannot act on it', async () => {
  const { window } = await mountAt('/admin/', { role: 'assistant', pending: 3 });
  const link = window.document.querySelector('.adm-nav a[href="/admin/publish"]');
  assert.equal(link.hidden, false, 'they can still reach the screen');
  assert.equal(link.querySelector('.adm-nav-count'), null);
});

test('nothing waiting means no badge at all, not a zero', async () => {
  const { window } = await mountAt('/admin/', { role: 'admin', pending: 0 });
  assert.equal(window.document.querySelector('.adm-nav-count'), null);
});

/* Before migration 0011 the table does not exist. Silence is the right
   failure — an error in the chrome would be worse than no badge. */
test('a failed count fails silent rather than breaking the sidebar', async () => {
  const { window } = await mountAt('/admin/', { role: 'admin', pending: 'error' });
  assert.equal(window.document.querySelector('.adm-nav-count'), null);
  assert.ok(window.document.querySelector('.adm-nav a[href="/admin/publish"]'), 'nav still intact');
});

/* The sidebar is fourteen tab stops and comes before the content in source
   order on every screen. */
test('a skip link is injected once, and points at a real target', async () => {
  const { window } = await mountAt('/admin/');
  const skips = window.document.querySelectorAll('.adm-skip');
  assert.equal(skips.length, 1, 'exactly one');
  const target = window.document.querySelector(skips[0].getAttribute('href'));
  assert.ok(target, 'href resolves to an element');
  assert.equal(target.getAttribute('tabindex'), '-1', 'and that element can take focus');
  assert.equal(window.document.body.firstElementChild, skips[0], 'first thing in the tab order');
});

/* The drawer is a modal on mobile. aria-expanded was absent from the DOM
   entirely — confirmed in a live browser before this change. */
test('the drawer toggle exposes its state', async () => {
  const { window } = await mountAt('/admin/');
  const toggle = window.document.getElementById('adm-toggle');
  const sidebar = window.document.getElementById('adm-sidebar');

  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'adm-sidebar');

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(sidebar.classList.contains('open'));

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('Escape closes the drawer and returns focus to the toggle', async () => {
  const { window } = await mountAt('/admin/');
  const toggle = window.document.getElementById('adm-toggle');
  const sidebar = window.document.getElementById('adm-sidebar');

  toggle.focus();
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.notEqual(window.document.activeElement, toggle, 'focus moved into the drawer');

  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  assert.equal(sidebar.classList.contains('open'), false);
  assert.equal(window.document.activeElement, toggle, 'focus came back');
});

test('Escape does nothing while the drawer is closed', async () => {
  const { window } = await mountAt('/admin/');
  const ev = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.document.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
});

test('the signed-in identity chip is filled from the resolved role', async () => {
  const { window } = await mountAt('/admin/', { role: 'owner' });
  const chip = window.document.getElementById('adm-user');
  assert.equal(chip.hidden, false);
  assert.equal(window.document.getElementById('adm-user-name').textContent, 'Test Person');
  assert.equal(window.document.getElementById('adm-user-role').textContent, 'owner');
  assert.equal(window.document.getElementById('adm-user-avatar').textContent, 'TP');
});

test('with no session the sidebar still mounts but stays anonymous', async () => {
  const { window } = await mountAt('/admin/', { session: null });
  assert.ok(window.document.getElementById('adm-sidebar'), 'sidebar is present');
  assert.equal(window.document.getElementById('adm-user').hidden, true, 'no identity chip');
});
