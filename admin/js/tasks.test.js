/* Tests for admin/js/tasks.js — the board.

   Two things carry most of the weight here. The filters now live in the URL,
   which is what makes leaving and coming back non-destructive — and which
   opens a door for malformed input, since a query string is something anyone
   can type. And the quick-add must provably never email anyone, because that
   is the whole reason it is allowed to be a one-line control with no
   confirmation. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'tasks.html'), 'utf8');
const DEPS = ['task-status.js', 'task-notify.js', 'tasks.js'];

/* Mounted against the REAL page markup — a hand-written fixture that drifts
   would let a renamed id pass here and break in production. */
function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

const EMPLOYEES = [
  { id: 'e1', full_name: 'Alex Chen', status: 'active' },
  { id: 'e2', full_name: 'Sam Rivera', status: 'active' },
];

function task(over) {
  return Object.assign({
    id: 't1', title: 'A task', details: null, assignee_id: 'e1',
    status: 'todo', priority: 'normal', due_date: null, completed_at: null,
  }, over);
}

async function mount(opts = {}) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/tasks' + (opts.search || ''),
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  const queries = [];   // every tasks query, with the filters applied
  const inserts = [];
  const updates = [];

  function builder(table, rows, state) {
    state = state || {};
    const b = {
      select: () => builder(table, rows, state),
      eq: (col, val) => { state[col] = val; return builder(table, rows.filter((r) => r[col] === val), state); },
      neq: (col, val) => { state['neq_' + col] = val; return builder(table, rows.filter((r) => r[col] !== val), state); },
      order: () => builder(table, rows, state),
      limit: (n) => builder(table, rows.slice(0, n), state),
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      single: async () => ({ data: rows[0] || null, error: null }),
      insert: (obj) => { inserts.push(obj); return builder(table, [Object.assign({ id: 'new-id' }, obj)], state); },
      update: (patch) => { updates.push(patch); return builder(table, rows, state); },
      delete: () => builder(table, rows, state),
      then: (resolve) => {
        if (table === 'tasks') queries.push(state);
        return resolve({ data: rows, error: null, count: rows.length });
      },
    };
    return b;
  }

  window.adminRoles = {
    isManager: async () => opts.role !== 'employee',
    employee: async () => opts.selfEmployee !== undefined ? opts.selfEmployee : EMPLOYEES[0],
    invokeFn: async () => ({ ok: true }),
  };
  const toasts = [];
  window.admin = {
    localDate: (d) => {
      const x = new Date('2026-07-29T12:00:00Z');
      if (d) x.setUTCDate(x.getUTCDate() + d);
      return x.toISOString().slice(0, 10);
    },
    toast: (t, k) => toasts.push({ t, k }),
    session: async () => ({ user: { id: 'u1' } }),
    statCards: () => {},
  };
  window.sb = {
    from: (t) => builder(t, (t === 'employees' ? EMPLOYEES : (opts.tasks || [])).slice()),
  };
  window.adminReady = Promise.resolve({ user: { email: 't@veyago.cloud' } });

  DEPS.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), dom.getInternalVMContext());
  });
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

  const $ = (id) => window.document.getElementById(id);
  return {
    window, $, queries, inserts, updates, toasts,
    settle: async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); },
  };
}

/* ── Filters in the URL ───────────────────────────────────────────────── */

test('a ?status= in the URL selects that filter', async () => {
  const h = await mount({ search: '?status=blocked' });
  assert.equal(h.$('f-status').value, 'blocked');
});

test('a ?assignee= in the URL selects that person — the Team page deep link', async () => {
  const h = await mount({ search: '?assignee=e2' });
  assert.equal(h.$('f-assignee').value, 'e2');
});

/* Was a real break: an unrecognised value set select.value to '', and
   loadTasks then issued .eq('status','') which Postgres rejects as an invalid
   enum — so a bad link produced a database error instead of a board. */
test('a nonsense ?status= falls back to the default rather than querying for it', async () => {
  const h = await mount({ search: '?status=nonsense' });
  assert.equal(h.$('f-status').value, 'open', 'falls back to Open');
  const last = h.queries[h.queries.length - 1];
  assert.notEqual(last.status, '', 'must never send an empty status to the database');
});

/* Was a real break: the assignee was matched by building a selector string,
   so a crafted value threw a SyntaxError out of querySelector and left the
   board stuck on skeletons forever. */
test('a crafted ?assignee= cannot throw out of the selector', async () => {
  const h = await mount({ search: '?assignee=' + encodeURIComponent('a"]') });
  assert.equal(h.$('f-assignee').value, 'all', 'unknown assignee falls back to Everyone');
  assert.ok(h.window.document.querySelector('#task-list'), 'the board still rendered');
});

test('changing a filter writes it to the URL', async () => {
  const h = await mount();
  h.$('f-status').value = 'done';
  h.$('f-status').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  assert.match(h.window.location.search, /status=done/);
});

test('the default filters keep the URL clean rather than spelling themselves out', async () => {
  const h = await mount({ search: '?status=done' });
  h.$('f-status').value = 'open';
  h.$('f-status').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  assert.equal(h.window.location.search, '', 'back to a bare /admin/tasks');
});

test('both filters round-trip together', async () => {
  const h = await mount();
  h.$('f-status').value = 'blocked';
  h.$('f-status').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  h.$('f-assignee').value = 'e2';
  h.$('f-assignee').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  assert.match(h.window.location.search, /status=blocked/);
  assert.match(h.window.location.search, /assignee=e2/);
});

/* ── Quick add ────────────────────────────────────────────────────────── */

test('quick-add assigns to you, so it can never email anyone', async () => {
  const h = await mount();
  h.$('q-title').value = 'Call the plumber';
  h.$('quick-add').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();

  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0].title, 'Call the plumber');
  assert.equal(h.inserts[0].assignee_id, 'e1', 'assigned to self — a notify-task skip case');
});

test('quick-add with no employees row leaves the task unassigned, still a skip case', async () => {
  const h = await mount({ selfEmployee: null });
  h.$('q-title').value = 'Something';
  h.$('quick-add').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(h.inserts[0].assignee_id, null);
});

test('quick-add sets no priority or due date — it is a to-do, not a project', async () => {
  const h = await mount();
  h.$('q-title').value = 'x';
  h.$('quick-add').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(h.inserts[0].due_date, undefined);
  assert.equal(h.inserts[0].priority, undefined, 'the column default applies');
});

test('quick-add ignores an empty title instead of inserting a blank task', async () => {
  const h = await mount();
  h.$('q-title').value = '   ';
  h.$('quick-add').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(h.inserts.length, 0);
});

test('quick-add clears the field so the next one can be typed straight away', async () => {
  const h = await mount();
  h.$('q-title').value = 'One';
  h.$('quick-add').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.settle();
  assert.equal(h.$('q-title').value, '');
});

/* ── The board itself ─────────────────────────────────────────────────── */

/* ?status=all because the default 'open' filter excludes done tasks — you
   have to be able to SEE a finished task before reopening it is a question. */
test('a done task can be reopened from the board, not only from its own page', async () => {
  const h = await mount({ tasks: [task({ status: 'done' })], search: '?status=all' });
  const labels = [...h.window.document.querySelectorAll('#task-list button')].map((b) => b.textContent);
  assert.ok(labels.includes('Reopen'),
    'the board and the detail page share one status machine now; got ' + JSON.stringify(labels));
});

test('urgent sorts above low inside the same due-date group', async () => {
  const h = await mount({
    tasks: [
      task({ id: 'low', title: 'Low one', priority: 'low' }),
      task({ id: 'urg', title: 'Urgent one', priority: 'urgent' }),
    ],
  });
  const titles = [...h.window.document.querySelectorAll('#task-list .adm-item-title')].map((e) => e.textContent);
  assert.deepEqual(titles, ['Urgent one', 'Low one']);
});

test('the due date renders human, not as a raw ISO string', async () => {
  const h = await mount({ tasks: [task({ due_date: '2026-08-30' })] });
  const sub = h.window.document.querySelector('#task-list .adm-item-sub').textContent;
  assert.match(sub, /Aug 30/);
  assert.ok(!sub.includes('2026-08-30'), 'the ISO form belongs in the title attribute, not the line');
});

test('urgent and high are named, not just tinted', async () => {
  const h = await mount({ tasks: [task({ priority: 'urgent' })] });
  const badges = [...h.window.document.querySelectorAll('#task-list .badge')].map((b) => b.textContent);
  assert.ok(badges.includes('Urgent'), 'got ' + JSON.stringify(badges));
});

test('the empty state distinguishes "nothing to do" from "nothing matches"', async () => {
  const plain = await mount({ tasks: [] });
  assert.match(plain.window.document.querySelector('#task-list').textContent, /enjoy the quiet/i);

  const filtered = await mount({ tasks: [], search: '?status=blocked' });
  assert.match(filtered.window.document.querySelector('#task-list').textContent, /match these filters/i);
});

test('the empty state no longer points at a panel that has moved', async () => {
  const h = await mount({ tasks: [] });
  assert.ok(!/on the right/i.test(h.window.document.querySelector('#task-list').textContent),
    'the create panel is gone — that copy was also wrong on narrow screens before it moved');
});
