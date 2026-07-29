/* Tests for admin/js/task-status.js and admin/js/task-notify.js.

   Both files exist because the same logic was previously written twice and the
   two copies disagreed. These tests are mostly about that: one status machine,
   one answer to "will this actually email anyone". */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

function loadInto(files) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://veyago.cloud/admin/tasks',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), dom.getInternalVMContext());
  });
  return dom.window;
}

/* ── The status machine ───────────────────────────────────────────────── */

const TS = loadInto(['task-status.js']).adminTaskStatus;

test('the four states are exactly the four the database allows', () => {
  /* 0005's CHECK constraint on tasks.status permits todo/in_progress/blocked/
     done and nothing else — a fifth key here would be a write that fails. */
  assert.deepEqual(Object.keys(TS.LABEL).sort(), ['blocked', 'done', 'in_progress', 'todo']);
  assert.deepEqual(Object.keys(TS.BADGE).sort(), ['blocked', 'done', 'in_progress', 'todo']);
});

/* The regression this module exists for: the board's map had no `done` entry,
   so a task could be completed from the board and then only reopened from its
   own page. */
test('every state offers a next move, including done', () => {
  ['todo', 'in_progress', 'blocked', 'done'].forEach((s) => {
    assert.ok(TS.next(s), s + ' must offer a next move');
    assert.ok(TS.nextLabel(s), s + ' must have a label for it');
  });
  assert.equal(TS.next('done'), 'todo', 'a finished task can be reopened');
  assert.equal(TS.nextLabel('done'), 'Reopen');
});

test('every next state is itself a real state', () => {
  Object.values(TS.NEXT).forEach((s) => {
    assert.ok(TS.LABEL[s], s + ' is not one of the four states');
  });
});

test('an unknown status degrades instead of rendering blank', () => {
  assert.equal(TS.label('nonsense'), 'nonsense');
  assert.equal(TS.badge('nonsense'), 'badge-neutral');
  assert.equal(TS.next('nonsense'), null);
});

test('priority sorts urgent first and low last, with unknowns treated as normal', () => {
  const order = ['low', 'urgent', 'normal', 'high']
    .slice().sort((a, b) => TS.priorityRank(a) - TS.priorityRank(b));
  assert.deepEqual(order, ['urgent', 'high', 'normal', 'low']);
  assert.equal(TS.priorityRank('nonsense'), TS.priorityRank('normal'),
    'an unrecognised priority is not evidence of urgency in either direction');
});

test('only urgent and high get a badge — four badges would be four kinds of noise', () => {
  assert.ok(TS.PRIORITY_BADGE.urgent);
  assert.ok(TS.PRIORITY_BADGE.high);
  assert.equal(TS.PRIORITY_BADGE.normal, undefined);
  assert.equal(TS.PRIORITY_BADGE.low, undefined);
  /* ...but all four still have a NAME, so nothing is nameless. */
  assert.deepEqual(Object.keys(TS.PRIORITY_LABEL).sort(), ['high', 'low', 'normal', 'urgent']);
});

/* ── Would this actually email someone? ───────────────────────────────── */

const notifyWin = loadInto(['task-notify.js']);
const TN = notifyWin.adminTaskNotify;
const SELF = { id: 'me', full_name: 'Me', email: 'me@veyago.cloud', status: 'active' };

test('wouldNotify mirrors every one of notify-task\'s own skip conditions', () => {
  assert.equal(TN.wouldNotify(null, SELF), false, 'unassigned');
  assert.equal(TN.wouldNotify(SELF, SELF), false, 'self-assigned');
  assert.equal(TN.wouldNotify({ id: 'x', full_name: 'X', email: null, status: 'active' }, SELF), false,
    'no email on file');
  assert.equal(TN.wouldNotify({ id: 'x', full_name: 'X', email: 'x@a.co', status: 'inactive' }, SELF), false,
    'deactivated');
  assert.equal(TN.wouldNotify({ id: 'x', full_name: 'X', email: 'x@a.co', status: 'active' }, SELF), true,
    'a real, active colleague with an address');
});

/* The board's quick-add always assigns to you or to nobody. Both are skip
   cases, which is exactly what makes that path safe to fire repeatedly with
   no disclosure and no confirmation. */
test('the quick-add assignment shapes can never email anyone', () => {
  assert.equal(TN.wouldNotify(SELF, SELF), false, 'assigned to yourself');
  assert.equal(TN.wouldNotify(null, SELF), false, 'assigned to nobody');
});

/* ── Reading the answer, not the promise ──────────────────────────────── */

function notifyHarness(response) {
  const win = loadInto(['task-notify.js']);
  const toasts = [];
  win.admin = { toast: (t, k) => toasts.push({ t, k }) };
  win.adminRoles = {
    invokeFn: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { win, toasts };
}

test('a real send says nothing — delivery is the expected state', async () => {
  const h = notifyHarness({ ok: true });
  const out = await h.win.adminTaskNotify.notify('t1', 'Alex');
  assert.equal(out.emailed, true);
  assert.deepEqual(h.toasts, [], 'no news is good news');
});

test('the silent skips stay silent', async () => {
  for (const why of ['unassigned', 'self-assigned', 'already done']) {
    const h = notifyHarness({ ok: true, skipped: why });
    const out = await h.win.adminTaskNotify.notify('t1', 'Alex');
    assert.equal(out.emailed, false);
    assert.equal(out.silent, true, why + ' is the correct outcome, not a problem');
    assert.deepEqual(h.toasts, [], why + ' must not produce a toast');
  }
});

/* These are the ones worth interrupting for: the user believes a colleague was
   told, and they were not. */
test('a skip the user would not expect is reported, and names the person', async () => {
  const h = notifyHarness({ ok: true, skipped: 'no email on file' });
  await h.win.adminTaskNotify.notify('t1', 'Alex Chen');
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].t, /Alex Chen/);
  assert.match(h.toasts[0].t, /no email on file/i);
  assert.equal(h.toasts[0].k, 'err');
});

test('a deactivated assignee is reported distinctly', async () => {
  const h = notifyHarness({ ok: true, skipped: 'inactive' });
  await h.win.adminTaskNotify.notify('t1', 'Alex Chen');
  assert.match(h.toasts[0].t, /deactivated/i);
});

/* The failure this shape exists to prevent: {ok:false} carries NO `skipped`,
   so anything keying off `skipped` alone would read a refused send as a
   success. */
test('a refused send is reported even though the promise resolved', async () => {
  const h = notifyHarness({ ok: false });
  const out = await h.win.adminTaskNotify.notify('t1', 'Alex Chen');
  assert.equal(out.emailed, false);
  assert.equal(h.toasts.length, 1, 'resolving is not the same as delivering');
  assert.match(h.toasts[0].t, /could not be emailed/i);
});

test('a thrown error is reported rather than escaping into the console', async () => {
  const h = notifyHarness(new Error('network down'));
  const out = await h.win.adminTaskNotify.notify('t1', 'Alex Chen');
  assert.equal(out.emailed, false);
  assert.match(h.toasts[0].t, /network down/);
});

test('notify never rejects — a mail problem must not read as a failed save', async () => {
  const h = notifyHarness(new Error('boom'));
  await assert.doesNotReject(() => h.win.adminTaskNotify.notify('t1', 'Alex'));
});
