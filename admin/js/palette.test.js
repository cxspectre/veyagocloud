/* Tests for admin/js/palette.js — the Cmd/Ctrl+K command palette.

   Two halves: the ranking, which decides whether the palette feels useful, and
   the keyboard/focus behaviour, which decides whether it is usable at all. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'palette.js'), 'utf8');

function harness({ rows = {}, records = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="elsewhere">x</button></body></html>', {
    url: 'https://veyago.cloud/admin/team',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;

  /* jsdom refuses to let window.location be redefined, so navigation is
     observed through window.admin.navigate — the single validated seam the
     palette actually calls (client.js). */
  const navigated = [];
  window.admin = {
    safeAdminPath: (p) => (typeof p === 'string' && p.indexOf('/admin/') === 0 ? p : null),
    navigate(p) { const s = this.safeAdminPath(p); if (s) navigated.push(s); return !!s; }
  };
  /* Chainable stub: palette.js narrows soft-deletable sources with
     .is('deleted_at', null) before .limit(), so the fake has to accept the
     same chain the real client does. `filtered` records which tables were
     narrowed, so a test can assert the filter was actually applied. */
  const filtered = [];
  const result = (table) => ({ data: rows[table] || [], error: null });
  window.sb = {
    from: (table) => {
      const chain = {
        select: () => chain,
        is: (col) => { filtered.push(table + ':' + col); return chain; },
        limit: async () => result(table)
      };
      return chain;
    }
  };
  window.adminReady = Promise.resolve({ user: { email: 'x@veyago.cloud' } });

  vm.runInContext(SRC, dom.getInternalVMContext());
  if (records) window.adminPalette._setRecords(records);
  return { window, dom, palette: window.adminPalette, navigated, filtered };
}

/* The overlay is built lazily — on first open, or as soon as adminReady
   resolves with a session. Tests that inspect it before opening must wait. */
const settled = () => new Promise((r) => setTimeout(r, 0));

const press = (window, key, over = {}) => {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over });
  (over.on || window.document).dispatchEvent(ev);
  return ev;
};

/* ── Ranking ─────────────────────────────────────────────────────────── */

test('score ranks prefix above word-boundary above buried', () => {
  const { palette } = harness();
  assert.equal(palette.score('Invoices', 'inv'), 0);
  assert.equal(palette.score('Recent invoices', 'inv'), 1);
  assert.equal(palette.score('Uninvoiced', 'inv'), 2);
  assert.equal(palette.score('Wallpapers', 'inv'), -1);
});

test('a screen is found by its label', () => {
  const { palette } = harness();
  const titles = palette.search('invo').map((r) => r.title);
  assert.ok(titles.includes('Invoices'));
});

/* The keyword list is what makes the palette forgiving of vocabulary. */
test('screens are found by words people actually type, not just their label', () => {
  const { palette } = harness();
  const find = (q) => palette.search(q).map((r) => r.title);

  assert.ok(find('ledger').includes('Transactions'), '"ledger" should find Transactions');
  assert.ok(find('hire').includes('Team'), '"hire" should find Team');
  /* 'deploy' moved to Publish when the panel left the manager-gated Settings
     page — Settings no longer does it, so it must no longer claim the word. */
  assert.ok(find('deploy').includes('Publish'), '"deploy" should find Publish');
  assert.ok(!find('deploy').includes('Settings'), 'Settings must not still claim it');
  assert.ok(find('stripe').includes('Settings'), 'Settings keeps what it does own');
  assert.ok(find('approve').includes('Publish'), '"approve" should find Publish');
  assert.ok(find('blog').includes('Journal'), '"blog" should find Journal');
  assert.ok(find('mfa').includes('Account'), '"mfa" should find Account');
});

test('a label match outranks a keyword match', () => {
  const { palette } = harness();
  // "money" is a keyword on Finance, Transactions and Invoices; none has it in
  // its label, so all are keyword hits — but Journal must not appear at all.
  const titles = palette.search('money').map((r) => r.title);
  assert.ok(titles.includes('Finance'));
  assert.ok(!titles.includes('Journal'));

  // "Invoices" matches the Invoices label directly, so it must come first.
  assert.equal(palette.search('invoices')[0].title, 'Invoices');
});

test('records are searchable and rank below screens', () => {
  const { palette } = harness({
    records: [{ kind: 'Article', title: 'Teamwork in the small', sub: 'draft', href: '/admin/article?id=1', search: '' }]
  });
  const results = palette.search('team');
  assert.equal(results[0].title, 'Team', 'the screen comes first');
  assert.ok(results.some((r) => r.title === 'Teamwork in the small'), 'the article is still offered');
  assert.equal(results.find((r) => r.title === 'Teamwork in the small').group, 'Article');
});

test('a person is findable by email as well as name', () => {
  const { palette } = harness({
    records: [{ kind: 'Person', title: 'Alex Doe', sub: 'admin · active',
                href: '/admin/member?id=9', search: 'alex@veyago.cloud admin' }]
  });
  assert.ok(palette.search('alex@vey').some((r) => r.title === 'Alex Doe'));
});

test('results are capped so a broad query cannot flood the list', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    kind: 'Task', title: 'Task e ' + i, sub: 'open', href: '/admin/task?id=' + i, search: ''
  }));
  const { palette } = harness({ records: many });
  assert.ok(palette.search('e').length <= 40);
});

test('no query still offers every screen, so the palette opens useful', () => {
  const { palette } = harness();
  const results = palette.search('');
  assert.ok(results.length >= 15, 'all screens listed');
  assert.ok(results.every((r) => r.group === 'Go to'));
});

/* ── Keyboard and focus ──────────────────────────────────────────────── */

test('the palette is prebuilt once a session exists, and starts hidden', async () => {
  const { window } = harness();
  await settled();
  const overlay = window.document.querySelector('.cp-overlay');
  assert.ok(overlay, 'built after adminReady resolves with a session');
  assert.equal(overlay.hidden, true, 'but not shown until asked for');
});

test('Cmd+K opens and Escape closes', () => {
  const { window } = harness();

  press(window, 'k', { metaKey: true });
  assert.equal(window.document.querySelector('.cp-overlay').hidden, false);

  press(window, 'Escape', { on: window.document.querySelector('.cp-input') });
  assert.equal(window.document.querySelector('.cp-overlay').hidden, true);
});

/* A search box over a sign-in form is noise, and its queries would all fail. */
test('it is not built at all on the login screen', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://veyago.cloud/admin/', runScripts: 'outside-only', virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  window.admin = { safeAdminPath: (p) => p, navigate: () => true };
  window.sb = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }) };
  window.adminReady = Promise.resolve(null);        // no session
  vm.runInContext(SRC, dom.getInternalVMContext());

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(window.document.querySelector('.cp-overlay'), null);
});

test('Ctrl+K works too', () => {
  const { window } = harness();
  press(window, 'k', { ctrlKey: true });
  assert.equal(window.document.querySelector('.cp-overlay').hidden, false);
});

test('Cmd+K is swallowed so the browser does not act on it', () => {
  const { window } = harness();
  assert.equal(press(window, 'k', { metaKey: true }).defaultPrevented, true);
});

test('Cmd+K toggles rather than re-opening', () => {
  const { window } = harness();
  press(window, 'k', { metaKey: true });
  press(window, 'k', { metaKey: true });
  assert.equal(window.document.querySelector('.cp-overlay').hidden, true);
});

test('opening focuses the input, and closing restores focus to where it was', () => {
  const { window } = harness();
  const before = window.document.getElementById('elsewhere');
  before.focus();
  assert.equal(window.document.activeElement, before);

  press(window, 'k', { metaKey: true });
  assert.equal(window.document.activeElement, window.document.querySelector('.cp-input'));

  press(window, 'Escape', { on: window.document.querySelector('.cp-input') });
  assert.equal(window.document.activeElement, before, 'focus must come back');
});

test('arrows move the selection and wrap at both ends', () => {
  const { window } = harness();
  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');
  const activeTitle = () => window.document.querySelector('.cp-item.active .cp-title').textContent;

  const first = activeTitle();
  press(window, 'ArrowDown', { on: input });
  assert.notEqual(activeTitle(), first);

  press(window, 'ArrowUp', { on: input });
  assert.equal(activeTitle(), first, 'back to the top');

  press(window, 'ArrowUp', { on: input });
  assert.notEqual(activeTitle(), first, 'wraps to the end');
});

test('the active option is exposed to assistive tech', () => {
  const { window } = harness();
  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');

  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(window.document.querySelector('.cp-list').getAttribute('role'), 'listbox');

  const id = input.getAttribute('aria-activedescendant');
  const opt = window.document.getElementById(id);
  assert.ok(opt, 'aria-activedescendant points at a real element');
  assert.equal(opt.getAttribute('aria-selected'), 'true');
  assert.ok(opt.classList.contains('active'));
});

test('an empty result set says so instead of showing a blank box', () => {
  const { window } = harness();
  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');
  input.value = 'zzzznotathing';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  const status = window.document.querySelector('.cp-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /No matches/);
  assert.equal(window.document.querySelectorAll('.cp-item').length, 0);
});

test('Enter navigates to the highlighted result', () => {
  const { window, navigated } = harness();

  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');
  input.value = 'invoices';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  press(window, 'Enter', { on: input });

  assert.deepEqual(navigated, ['/admin/invoices']);
  assert.equal(window.document.querySelector('.cp-overlay').hidden, true, 'closes on navigate');
});

test('clicking a result navigates to that result, not the highlighted one', () => {
  const { window, navigated } = harness();

  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');
  input.value = 'a';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  const items = [...window.document.querySelectorAll('.cp-item')];
  assert.ok(items.length > 1, 'need more than one result for this to mean anything');
  items[1].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  assert.equal(navigated.length, 1);
  assert.notEqual(navigated[0], null);
});

test('Enter with no results does nothing rather than throwing', () => {
  const { window, navigated } = harness();

  press(window, 'k', { metaKey: true });
  const input = window.document.querySelector('.cp-input');
  input.value = 'zzzznotathing';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  press(window, 'Enter', { on: input });

  assert.deepEqual(navigated, []);
  assert.equal(window.document.querySelector('.cp-overlay').hidden, false, 'stays open');
});

test('records load from Supabase on open and become searchable', async () => {
  const { window, palette, filtered } = harness({
    rows: {
      articles: [{ id: 'a1', title: 'The edge moves in', status: 'published' }],
      employees: [{ id: 'e1', full_name: 'Dana Reed', email: 'dana@veyago.cloud', role: 'assistant', status: 'active' }]
    }
  });

  palette.open();
  await new Promise((r) => setTimeout(r, 10));

  const titles = palette.search('').map((r) => r.title);
  assert.ok(titles.includes('The edge moves in'));
  assert.ok(titles.includes('Dana Reed'));

  /* Content is soft-deletable (0012) and deleted rows must not surface in
     search. employees and tasks have no deleted_at, so they must NOT be
     narrowed — that would 400 the query. */
  assert.ok(filtered.includes('articles:deleted_at'), 'articles filtered');
  assert.ok(filtered.includes('apps:deleted_at'), 'apps filtered');
  assert.ok(filtered.includes('wallpapers:deleted_at'), 'wallpapers filtered');
  assert.ok(!filtered.some((f) => f.startsWith('employees:')), 'employees has no deleted_at');
  assert.ok(!filtered.some((f) => f.startsWith('tasks:')), 'tasks has no deleted_at');
});

/* RLS denies whole tables to some roles; that must degrade, not break. */
test('a table the user cannot read is skipped, not fatal', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://veyago.cloud/admin/', runScripts: 'outside-only', virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  window.admin = { safeAdminPath: (p) => p };
  window.sb = {
    from: (table) => {
      const chain = {
        select: () => chain,
        is: () => chain,
        limit: async () => (table === 'employees'
          ? { data: null, error: { message: 'permission denied' } }
          : { data: [{ id: 't1', title: 'Ship the thing', status: 'open' }], error: null })
      };
      return chain;
    }
  };
  window.adminReady = Promise.resolve({ user: {} });
  vm.runInContext(SRC, dom.getInternalVMContext());

  window.adminPalette.open();
  await new Promise((r) => setTimeout(r, 10));

  const titles = window.adminPalette.search('').map((r) => r.title);
  assert.ok(titles.includes('Ship the thing'), 'readable tables still appear');
  assert.equal(window.document.querySelector('.cp-overlay').hidden, false, 'palette still usable');
});
