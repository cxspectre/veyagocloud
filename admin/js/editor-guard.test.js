/* Tests for admin/js/editor-guard.js — the unsaved-work protection shared by the
   article and app editors.

   editor-guard.js is a browser IIFE that assigns window.adminEditorGuard, so it
   is loaded into a jsdom window rather than required. jsdom is already a
   devDependency (used by tools/lib/sanitize.js). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'editor-guard.js'), 'utf8');
const MIRROR_MS = 1000;   // must match the constant in editor-guard.js

/* Build a fresh jsdom window with the guard loaded and a minimal editor DOM. */
function harness(opts = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div class="ae-root">
         <header class="ae-topbar"><p class="ae-save-hint" id="save-hint"></p></header>
         <div class="ae-body"><input id="f" /></div>
       </div>
       <button id="adm-signout">Sign out</button>
       <a id="away" href="/admin/journal">Journal</a>
     </body></html>`,
    /* runScripts is required for getInternalVMContext; 'outside-only' gives the
       window the script globals without executing any markup-embedded script.
       The virtual console swallows jsdom's "navigation not implemented" notice,
       which is the expected outcome of the tests that let a link through. */
    { url: 'https://veyago.cloud/admin/article', runScripts: 'outside-only', virtualConsole }
  );

  const { window } = dom;
  /* Collect uncaught in-page errors so tests can assert the guard swallowed a
     failure rather than throwing out of a timer. */
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));

  vm.runInContext(SRC, dom.getInternalVMContext());

  // Mutable test state the guard reads through its callbacks.
  const state = {
    recordId: opts.recordId ?? null,
    rowStamp: opts.rowStamp ?? null,
    payload: { title: 'draft title' },
    restored: null,
    saves: []
  };

  const guard = window.adminEditorGuard.create({
    kind: 'article',
    root: window.document.querySelector('.ae-root'),
    status: window.document.getElementById('save-hint'),
    publishHref: '/admin/settings',
    snapshot: () => state.payload,
    restore: (p) => { state.restored = p; },
    recordId: () => state.recordId,
    rowStamp: () => state.rowStamp,
    save: (publish) => {
      state.saves.push(publish);
      return state.saveImpl ? state.saveImpl() : Promise.resolve();
    }
  });

  return {
    dom, window, guard, state, jsdomErrors,
    key: (id) => 'veyago.admin.draft.article.' + (id ?? 'new')
  };
}

test('starts clean, and marking dirty reports the state in the status line', () => {
  const { window, guard } = harness();
  assert.equal(guard.isDirty(), false);

  guard.markDirty();

  assert.equal(guard.isDirty(), true);
  assert.equal(window.document.getElementById('save-hint').textContent, 'Unsaved changes');
});

test('typing anywhere under the root marks dirty via the delegated listener', () => {
  const { window, guard } = harness();
  const input = window.document.getElementById('f');

  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(guard.isDirty(), true);
});

test('the mirror is written only after the debounce elapses', async () => {
  const { window, guard, key } = harness();

  guard.markDirty();
  assert.equal(window.localStorage.getItem(key(null)), null, 'must not write synchronously');

  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  const stored = JSON.parse(window.localStorage.getItem(key(null)));
  assert.deepEqual(stored.payload, { title: 'draft title' });
  assert.ok(stored.savedAt > 0);
});

test('markClean drops the mirror and renders saved-but-not-live with a publish link', async () => {
  const { window, guard, key } = harness();

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  assert.ok(window.localStorage.getItem(key(null)), 'precondition: mirror exists');

  guard.markClean('Saved');

  assert.equal(guard.isDirty(), false);
  assert.equal(window.localStorage.getItem(key(null)), null, 'mirror must be cleared');

  const hint = window.document.getElementById('save-hint');
  assert.match(hint.textContent, /not live yet/);
  const link = hint.querySelector('a');
  assert.equal(link.getAttribute('href'), '/admin/settings');
});

test('the pre-id mirror is removed once the row gets an id, so it cannot resurface', async () => {
  const { window, guard, state, key } = harness({ recordId: null });

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  assert.ok(window.localStorage.getItem(key(null)), 'precondition: "new" mirror exists');

  // First save assigns an id, exactly as save() does in both editors.
  state.recordId = 'abc-123';
  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  assert.equal(window.localStorage.getItem(key(null)), null, 'stale "new" mirror must be gone');
  assert.ok(window.localStorage.getItem(key('abc-123')), 'mirror moved to the real id');
});

test('offerRecovery does nothing when there is no mirror', () => {
  const { window, guard } = harness();

  assert.equal(guard.offerRecovery(window.document.querySelector('.ae-root')), false);
  assert.equal(window.document.querySelector('.ae-recover'), null);
});

test('offerRecovery surfaces a mirror without applying it', async () => {
  const { window, guard, state } = harness();

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  const shown = guard.offerRecovery(window.document.querySelector('.ae-root'));

  assert.equal(shown, true);
  assert.equal(state.restored, null, 'must never auto-apply the recovered draft');

  const bar = window.document.querySelector('.ae-recover');
  assert.ok(bar, 'a recovery banner is mounted');
  assert.match(bar.textContent, /Unsaved changes from/);
});

test('Restore applies the mirror and leaves the editor dirty so it can be saved', async () => {
  const { window, guard, state } = harness();

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  guard.offerRecovery(window.document.querySelector('.ae-root'));

  const buttons = [...window.document.querySelectorAll('.ae-recover button')];
  buttons.find((b) => /Restore/.test(b.textContent)).click();

  assert.deepEqual(state.restored, { title: 'draft title' });
  assert.equal(guard.isDirty(), true, 'restored work is unsaved work');
  assert.equal(window.document.querySelector('.ae-recover'), null, 'banner dismissed');
});

test('Discard removes the mirror and does not apply it', async () => {
  const { window, guard, state, key } = harness();

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  guard.offerRecovery(window.document.querySelector('.ae-root'));

  const buttons = [...window.document.querySelectorAll('.ae-recover button')];
  buttons.find((b) => /Discard/.test(b.textContent)).click();

  assert.equal(state.restored, null);
  assert.equal(window.localStorage.getItem(key(null)), null);
  assert.equal(window.document.querySelector('.ae-recover'), null);
});

/* The correctness case that matters most: recovering a mirror over a row that
   has since been saved elsewhere would be the same data loss in reverse. */
test('a mirror older than the stored row is discarded, not offered', async () => {
  const { window, guard, state, key } = harness({ recordId: 'abc-123' });

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  assert.ok(window.localStorage.getItem(key('abc-123')), 'precondition: mirror exists');

  // The row was saved well beyond the clock-skew allowance (5 min) after the
  // mirror was written, so the mirror genuinely holds superseded work.
  state.rowStamp = new Date(Date.now() + 30 * 60_000).toISOString();

  assert.equal(guard.offerRecovery(window.document.querySelector('.ae-root')), false);
  assert.equal(window.localStorage.getItem(key('abc-123')), null, 'stale mirror is cleared');
  assert.equal(state.restored, null);
});

test('a mirror newer than the stored row is still offered', async () => {
  const { window, guard, state } = harness({ recordId: 'abc-123' });

  state.rowStamp = new Date(Date.now() - 60_000).toISOString();
  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  assert.equal(guard.offerRecovery(window.document.querySelector('.ae-root')), true);
});

test('an unparseable rowStamp does not suppress recovery', async () => {
  const { window, guard, state } = harness({ recordId: 'abc-123' });

  state.rowStamp = 'not-a-date';
  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  assert.equal(guard.offerRecovery(window.document.querySelector('.ae-root')), true);
});

function press(window, over = {}) {
  const ev = new window.KeyboardEvent('keydown', {
    key: 's', metaKey: true, bubbles: true, cancelable: true, ...over
  });
  window.document.dispatchEvent(ev);
  return ev;
}

test('Cmd+S saves only when there is something to save', () => {
  const { window, guard, state } = harness();

  press(window);
  assert.deepEqual(state.saves, [], 'nothing dirty, nothing saved');

  guard.markDirty();
  press(window);
  assert.deepEqual(state.saves, [false], 'saves as a draft, never publishes');
});

/* Without preventDefault the browser opens its own "Save Page As…" over the
   editor, so it must fire whether or not there is anything to save. */
test('Cmd+S always suppresses the browser save dialog', () => {
  const { window, guard } = harness();

  assert.equal(press(window).defaultPrevented, true, 'clean editor');
  guard.markDirty();
  assert.equal(press(window).defaultPrevented, true, 'dirty editor');
});

test('Ctrl+S works too, so the shortcut is not Mac-only', () => {
  const { window, guard, state } = harness();
  guard.markDirty();

  press(window, { metaKey: false, ctrlKey: true });

  assert.deepEqual(state.saves, [false]);
});

test('Shift+Cmd+S still saves — the uppercase key arm is live', () => {
  const { window, guard, state } = harness();
  guard.markDirty();

  press(window, { key: 'S', shiftKey: true });

  assert.deepEqual(state.saves, [false]);
});

/* Before the first save the record has no id, so a second save() would take the
   insert branch again and create a duplicate row. */
test('repeated Cmd+S does not fire a second save while one is in flight', async () => {
  const { window, guard, state } = harness();

  let release;
  state.saveImpl = () => new Promise((r) => { release = r; });
  guard.markDirty();

  press(window);
  press(window);
  press(window);
  assert.equal(state.saves.length, 1, 'only the first press starts a save');

  release();
  await new Promise((r) => setTimeout(r, 10));

  press(window);
  assert.equal(state.saves.length, 2, 'the lock releases once the save settles');
});

test('auto-repeat keydowns are ignored', () => {
  const { window, guard, state } = harness();
  guard.markDirty();

  press(window, { repeat: true });

  assert.deepEqual(state.saves, [], 'a held key must not save repeatedly');
});

test('leaving via an in-page link is blocked when the user cancels the prompt', () => {
  const { window, guard } = harness();
  guard.markDirty();

  window.confirm = () => false;
  const link = window.document.getElementById('away');
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true, 'navigation must be prevented');
});

test('leaving via an in-page link proceeds when the user accepts', () => {
  const { window, guard } = harness();
  guard.markDirty();

  window.confirm = () => true;
  const link = window.document.getElementById('away');
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, false);
});

test('a clean editor never prompts on navigation', () => {
  const { window } = harness();
  let asked = false;
  window.confirm = () => { asked = true; return true; };

  window.document.getElementById('away')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(asked, false);
});

test('in-page anchors and new-tab links are never intercepted', () => {
  const { window, guard } = harness();
  guard.markDirty();

  let asked = 0;
  window.confirm = () => { asked++; return true; };

  const hash = window.document.createElement('a');
  hash.href = '#section';
  window.document.body.appendChild(hash);
  hash.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  const blank = window.document.createElement('a');
  blank.href = 'https://veyago.cloud';
  blank.target = '_blank';
  window.document.body.appendChild(blank);
  blank.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(asked, 0, 'neither should ask');
});

test('signing out with unsaved work asks first', () => {
  const { window, guard } = harness();
  guard.markDirty();

  window.confirm = () => false;
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  window.document.getElementById('adm-signout').dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true);
});

test('beforeunload prompts only while dirty', () => {
  const { window, guard } = harness();

  const fire = () => {
    const ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev;
  };

  assert.equal(fire().defaultPrevented, false, 'clean: no prompt');

  guard.markDirty();
  assert.equal(fire().defaultPrevented, true, 'dirty: prompt');
});

test('a snapshot that cannot be serialised fails quiet instead of throwing', async () => {
  const { window, guard, state, jsdomErrors, key } = harness();

  const cyclic = {};
  cyclic.self = cyclic;
  state.payload = cyclic;

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  // The write happens inside a timer, so an uncaught throw would surface as a
  // jsdomError rather than failing the assertion below.
  assert.deepEqual(jsdomErrors, [], 'must not throw out of the debounce timer');
  assert.equal(window.localStorage.getItem(key(null)), null, 'nothing half-written');
  assert.equal(guard.isDirty(), true, 'the other three guards still apply');

  // And it recovers: a serialisable snapshot afterwards still writes.
  state.payload = { title: 'fine now' };
  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key(null))).payload, { title: 'fine now' });
});

/* Anchors in the preview canvas are content being edited, not exits. */
test('clicking a link inside the preview canvas does not prompt', () => {
  const { window, guard } = harness();
  guard.markDirty();

  let asked = 0;
  window.confirm = () => { asked++; return true; };

  const canvas = window.document.createElement('div');
  canvas.className = 'ae-canvas';
  const inner = window.document.createElement('a');
  inner.href = 'https://apps.apple.com/app/id123';
  canvas.appendChild(inner);
  window.document.querySelector('.ae-body').appendChild(canvas);

  inner.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(asked, 0, 'editing content must not raise a leave prompt');
  assert.equal(guard.isDirty(), true, 'and must not clear the dirty flag');
});

/* Leaving dirty set would hand the same decision to beforeunload, so an
   intentional exit would be prompted twice with different wording. */
test('accepting the leave prompt clears dirty so beforeunload does not ask again', () => {
  const { window, guard } = harness();
  guard.markDirty();

  window.confirm = () => true;
  window.document.getElementById('away')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(guard.isDirty(), false);

  const ev = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'no second dialog');
});

test('declining the leave prompt keeps the work dirty and protected', () => {
  const { window, guard } = harness();
  guard.markDirty();

  window.confirm = () => false;
  window.document.getElementById('away')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(guard.isDirty(), true);
});

/* savedAt is a browser clock reading and rowStamp a Postgres one; treating a
   small backwards skew as "already saved" would delete live work. */
test('a mirror is kept when the row stamp is only slightly ahead (clock skew)', async () => {
  const { window, guard, state } = harness({ recordId: 'abc-123' });

  guard.markDirty();
  await new Promise((r) => setTimeout(r, MIRROR_MS + 120));

  state.rowStamp = new Date(Date.now() + 60_000).toISOString();   // 1 min ahead

  assert.equal(guard.offerRecovery(window.document.querySelector('.ae-root')), true,
    'within the skew allowance the mirror must survive');
});
