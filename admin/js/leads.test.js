/* Tests for admin/js/leads.js — the enquiry inbox.

   Mounted against the REAL page markup with the real sidebar (nav.js), so a
   renamed id or a dropped nav entry fails here rather than in production.
   The Supabase client is a chainable fake that records every query and every
   update, because the two things worth proving are what the screen ASKS the
   database for (newest first, open statuses only) and what it WRITES back
   (status, notes and follow-up date — nothing else, ever). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'leads.html'), 'utf8');
const SCRIPTS = ['nav.js', 'leads.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'));

function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

function lead(over) {
  return Object.assign({
    id: 'l1', kind: 'website', name: 'Ann Lee', email: 'ann@example.com', business: 'Ann Bakes',
    website: 'https://annbakes.com/', message: 'Site is slow.\n\nHelp?', locale: 'nl', page: '/websites/',
    package: 'backoffice', status: 'new', notes: null, next_follow_up_on: null,
    notified_at: '2026-09-04T10:00:00Z', ack_sent_at: '2026-09-04T10:00:01Z', created_at: '2026-09-04T09:59:00Z',
  }, over);
}

async function mount(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyOf(HTML) + '</body></html>', {
    url: 'https://veyago.cloud/admin/leads' + (opts.search || ''),
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  const queries = [];    // every read, with the filters and ordering applied
  const updates = [];    // every write: { table, patch, where }
  const toasts = [];
  const redirects = [];

  function builder(table, rows, state) {
    state = state || {};
    const next = (r) => builder(table, r, state);
    const done = () => {
      if (state.update) updates.push({ table, patch: state.update, where: state.eq || {} });
      else queries.push(Object.assign({ table }, state));
    };
    return {
      select: () => next(rows),
      eq: (col, val) => { state.eq = Object.assign({}, state.eq, { [col]: val }); return next(rows.filter((r) => r[col] === val)); },
      in: (col, vals) => { state.in = { col, vals }; return next(rows.filter((r) => vals.includes(r[col]))); },
      order: (col, o) => { state.order = (state.order || []).concat([[col, o && o.ascending === false ? 'desc' : 'asc']]); return next(rows); },
      limit: (n) => next(rows.slice(0, n)),
      update: (patch) => { state.update = patch; return next(rows.map((r) => Object.assign({}, r, patch))); },
      maybeSingle: async () => { done(); return { data: rows[0] || null, error: null }; },
      then: (resolve) => { done(); return resolve({ data: rows, error: null, count: rows.length }); },
    };
  }

  const role = opts.role || 'owner';
  const manager = role === 'owner' || role === 'admin';
  window.adminRoles = {
    cachedRole: () => role,
    isManager: async () => manager,
    isPublisher: async () => manager || role === 'assistant',
    resolve: async () => ({ role, employee: { full_name: 'Test Person' } }),
    requireManager: async () => { if (manager) return true; redirects.push('/admin/'); return false; },
  };
  window.admin = {
    localDate: (d) => {
      const x = new Date('2026-09-04T12:00:00Z');
      if (d) x.setUTCDate(x.getUTCDate() + d);
      return x.toISOString().slice(0, 10);
    },
    toast: (t, k) => toasts.push({ t, k }),
    statCards: (wrap, cards) => { wrap.setAttribute('data-cards', JSON.stringify(cards.map((c) => [c.label, c.n]))); },
  };
  window.sb = {
    from: (t) => builder(t, (t === 'website_enquiries' ? (opts.leads || []) : []).slice()),
  };
  window.adminReady = Promise.resolve({ user: { email: 't@veyago.cloud' } });

  /* nav.js defers to DOMContentLoaded while the document is still parsing. */
  if (window.document.readyState === 'loading') {
    await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }
  SCRIPTS.forEach((src) => vm.runInContext(src, dom.getInternalVMContext()));
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  await settle();

  const $ = (id) => window.document.getElementById(id);
  const rows = () => [...window.document.querySelectorAll('#lead-list [data-lead]')];
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const open = async (id) => { click(window.document.querySelector('[data-lead="' + id + '"] .adm-item-title')); await settle(); };
  return { window, $, rows, click, open, settle, queries, updates, toasts, redirects };
}

/* ── The page and its chrome ─────────────────────────────────────────── */

test('the page mounts with the sidebar, Leads lit, and the list rendered', async () => {
  const h = await mount({ leads: [lead()] });
  const active = h.window.document.querySelector('.adm-nav a.active');
  assert.equal(active.getAttribute('href'), '/admin/leads');
  assert.equal(active.hidden, false, 'a manager sees the entry');
  assert.equal(h.window.document.querySelector('h1').textContent, 'Leads');
  assert.equal(h.rows().length, 1);
  assert.match(h.$('lead-count').textContent, /1 lead$/);
});

test('an employee is bounced and nothing is fetched', async () => {
  const h = await mount({ role: 'employee', leads: [lead()] });
  assert.deepEqual(h.redirects, ['/admin/']);
  assert.equal(h.queries.filter((q) => q.table === 'website_enquiries').length, 0);
  assert.equal(h.window.document.querySelector('.adm-nav a[href="/admin/leads"]').hidden, true, 'and the nav entry stays hidden');
});

test('the empty state tells "nothing yet" from "nothing open"', async () => {
  const none = await mount({ leads: [] });
  assert.match(none.$('lead-list').textContent, /No enquiries yet/);

  const allClosed = await mount({ leads: [lead({ status: 'won' })] });
  assert.match(allClosed.$('lead-list').textContent, /Nothing open/);
});

/* ── What is asked of the database ───────────────────────────────────── */

test('leads are fetched newest first, and Open means new + replied + quoted', async () => {
  const h = await mount({ leads: [] });
  const q = h.queries.find((x) => x.table === 'website_enquiries' && x.order);
  assert.deepEqual(q.order, [['created_at', 'desc']]);
  assert.deepEqual(q.in, { col: 'status', vals: ['new', 'replied', 'quoted'] });
});

test('?status=all selects the filter, drops the status clause, and round-trips to the URL', async () => {
  const h = await mount({ leads: [lead({ status: 'lost' })], search: '?status=all' });
  assert.equal(h.$('f-status').value, 'all');
  const q = h.queries.find((x) => x.table === 'website_enquiries' && x.order);
  assert.equal(q.in, undefined, 'no status clause when showing everything');
  assert.equal(h.rows().length, 1, 'a lost lead is visible under All');

  h.$('f-status').value = 'open';
  h.$('f-status').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  assert.equal(h.window.location.search, '', 'the default keeps the URL clean');
});

/* ── The row ─────────────────────────────────────────────────────────── */

test('a row shows who, when, what kind, which package and where from', async () => {
  const h = await mount({ leads: [lead()] });
  const row = h.rows()[0];
  assert.equal(row.querySelector('.adm-item-title').textContent, 'Ann Lee · Ann Bakes');
  const sub = row.querySelector('.adm-item-sub').textContent;
  assert.match(sub, /Website/);
  assert.match(sub, /Back office/);
  assert.match(sub, /NL \/websites\//);
  const badges = [...row.querySelectorAll('.badge')].map((b) => b.textContent);
  assert.deepEqual(badges, ['New'], 'a delivered lead carries only its status');
});

test('a lead nobody was told about is flagged red; a missing acknowledgement grey', async () => {
  const h = await mount({ leads: [lead({ notified_at: null, ack_sent_at: null })] });
  const badges = [...h.rows()[0].querySelectorAll('.badge')];
  const notified = badges.find((b) => b.textContent === 'not notified');
  const ack = badges.find((b) => b.textContent === 'no acknowledgement');
  assert.ok(notified && notified.classList.contains('badge-danger'));
  assert.ok(ack && ack.classList.contains('badge-neutral'));
});

test('a follow-up due today or earlier is flagged on an open lead, not a closed one', async () => {
  const h = await mount({
    leads: [lead({ id: 'due', next_follow_up_on: '2026-09-04' }), lead({ id: 'later', next_follow_up_on: '2026-09-10' }),
            lead({ id: 'closed', status: 'won', next_follow_up_on: '2026-09-01' })],
    search: '?status=all',
  });
  const flags = (id) => [...h.window.document.querySelectorAll('[data-lead="' + id + '"] .badge')].map((b) => b.textContent);
  assert.ok(flags('due').includes('follow up'));
  assert.ok(!flags('later').includes('follow up'));
  assert.ok(!flags('closed').includes('follow up'));
});

test('a stored name is text, never markup', async () => {
  const h = await mount({ leads: [lead({ name: '<img src=x onerror=alert(1)>' })] });
  assert.equal(h.window.document.querySelector('#lead-list img'), null);
  assert.match(h.rows()[0].querySelector('.adm-item-title').textContent, /<img/);
});

/* ── The detail panel ────────────────────────────────────────────────── */

test('clicking a row opens every field, and the Reply link carries the reference', async () => {
  const h = await mount({ leads: [lead()] });
  assert.equal(h.window.document.querySelector('.adm-item-detail'), null, 'closed to begin with');
  await h.open('l1');
  const row = h.rows()[0];
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  const panel = row.querySelector('.adm-item-detail');
  assert.ok(panel, 'panel opened in place');
  const text = panel.textContent;
  for (const s of ['ann@example.com', 'Ann Bakes', 'https://annbakes.com/', 'Back office', 'Site is slow.', 'NL /websites/', 'l1']) {
    assert.ok(text.includes(s), 'missing ' + s);
  }
  const site = panel.querySelector('a[href="https://annbakes.com/"]');
  assert.equal(site.getAttribute('rel'), 'noopener');

  const reply = panel.querySelector('[data-reply]');
  const [addr, query] = reply.getAttribute('href').split('?');
  assert.equal(addr, 'mailto:ann@example.com');
  assert.equal(decodeURIComponent(query), 'subject=Re: your website enquiry (ref l1)');
});

test('opening a second row closes the first, and clicking inside the panel does not close it', async () => {
  const h = await mount({ leads: [lead({ id: 'a' }), lead({ id: 'b', name: 'Bo' })] });
  await h.open('a');
  await h.open('b');
  assert.equal(h.window.document.querySelectorAll('.adm-item-detail').length, 1);
  assert.equal(h.window.document.querySelector('[data-lead="b"] .adm-item-detail') !== null, true);

  h.click(h.window.document.querySelector('[data-lead="b"] textarea'));
  await h.settle();
  assert.ok(h.window.document.querySelector('[data-lead="b"] .adm-item-detail'), 'still open');
});

test('Enter on a focused row opens it — the row is a real button to the keyboard', async () => {
  const h = await mount({ leads: [lead()] });
  const row = h.rows()[0];
  assert.equal(row.getAttribute('role'), 'button');
  assert.equal(row.getAttribute('tabindex'), '0');
  row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await h.settle();
  assert.ok(h.rows()[0].querySelector('.adm-item-detail'));
});

test('?id= in the URL opens that row — the follow-up task deep link', async () => {
  const h = await mount({ leads: [lead({ id: 'a' }), lead({ id: 'b' })], search: '?id=b' });
  assert.ok(h.window.document.querySelector('[data-lead="b"] .adm-item-detail'));
  assert.equal(h.window.document.querySelector('[data-lead="a"] .adm-item-detail'), null);
});

/* ── Writes ──────────────────────────────────────────────────────────── */

test('the status chips write status and only status, and the row re-renders', async () => {
  const h = await mount({ leads: [lead()] });
  await h.open('l1');
  const chips = [...h.window.document.querySelectorAll('[data-status]')].map((b) => b.getAttribute('data-status'));
  assert.deepEqual(chips, ['new', 'replied', 'quoted', 'won', 'lost', 'spam']);
  assert.equal(h.window.document.querySelector('[data-status="new"]').getAttribute('aria-pressed'), 'true');

  h.click(h.window.document.querySelector('[data-status="replied"]'));
  await h.settle();
  assert.deepEqual(h.updates, [{ table: 'website_enquiries', patch: { status: 'replied' }, where: { id: 'l1' } }]);
  assert.equal(h.window.document.querySelector('[data-status="replied"]').getAttribute('aria-pressed'), 'true');
  assert.ok([...h.rows()[0].querySelectorAll('.badge')].some((b) => b.textContent === 'Replied'));
  assert.equal(h.toasts[0].t, 'Marked replied');
});

test('a lead marked won leaves the Open view without a reload', async () => {
  const h = await mount({ leads: [lead()] });
  await h.open('l1');
  h.click(h.window.document.querySelector('[data-status="won"]'));
  await h.settle();
  assert.equal(h.rows().length, 0);
  assert.match(h.$('lead-list').textContent, /Nothing open/);
});

test('notes and the follow-up date save together; blanks go back as null', async () => {
  const h = await mount({ leads: [lead()] });
  await h.open('l1');
  h.$('notes-l1').value = '  Quoted Business, waiting on their logo.  ';
  h.$('follow-l1').value = '2026-09-11';
  h.window.document.querySelector('[data-notes-form="l1"]').dispatchEvent(
    new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.deepEqual(h.updates, [{
    table: 'website_enquiries',
    patch: { notes: 'Quoted Business, waiting on their logo.', next_follow_up_on: '2026-09-11' },
    where: { id: 'l1' },
  }]);
  assert.equal(h.$('notes-l1').value, 'Quoted Business, waiting on their logo.', 're-rendered from the saved row');
  assert.equal(h.toasts[0].t, 'Notes saved');

  h.$('notes-l1').value = '';
  h.$('follow-l1').value = '';
  h.window.document.querySelector('[data-notes-form="l1"]').dispatchEvent(
    new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.deepEqual(h.updates[1].patch, { notes: null, next_follow_up_on: null });
});

test('nothing the screen writes can touch what the visitor wrote', async () => {
  const h = await mount({ leads: [lead()] });
  await h.open('l1');
  h.click(h.window.document.querySelector('[data-status="quoted"]'));
  h.window.document.querySelector('[data-notes-form="l1"]').dispatchEvent(
    new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  const written = new Set(h.updates.flatMap((u) => Object.keys(u.patch)));
  assert.deepEqual([...written].sort(), ['next_follow_up_on', 'notes', 'status'],
    'exactly the three columns 0020 grants — the same list, so the grant and the screen cannot drift apart unnoticed');
});
