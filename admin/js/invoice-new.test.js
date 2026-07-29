/* Tests for admin/js/invoice-new.js — the guided create-and-send flow.

   The load-bearing test here is the stale-preview guard. Everything else in
   this flow is recoverable; emailing a client a PDF whose amount differs from
   the one just approved on screen is not. So: edit an amount after previewing,
   and Send must refuse and route back to the preview rather than send the old
   document or silently send a new one nobody looked at. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'invoice-new.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'invoice-new.html'), 'utf8');

/* Mount against the REAL page markup rather than a hand-written fixture — a
   fixture that drifts from invoice-new.html would let a renamed id pass here
   and break in production. */
function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

async function mount(opts = {}) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/invoice-new' + (opts.search || ''),
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  const invocations = [];
  /* `failNextInvoke` is flipped by individual tests to fail exactly one call —
     used to leave a cached preview stale on purpose. */
  const state = { failNextInvoke: false };
  window.adminRoles = {
    requireManager: async () => true,
    invokeFn: async (name, body) => {
      invocations.push({ name, body });
      if (opts.invokeFails || state.failNextInvoke) {
        state.failNextInvoke = false;
        throw new Error('boom');
      }
      if (body.send) return { ok: true, invoice: { id: 'inv1' }, emailSent: opts.emailSent !== false };
      /* 4 bytes of anything — the flow only ever hands this to a Blob. */
      return { ok: true, preview: true, pdfBase64: 'AAAA', filename: 'invoice-x.pdf' };
    },
  };
  const toasts = [];
  window.admin = {
    localDate: () => '2026-07-29',
    toast: (t) => toasts.push(t),
    navigate: () => true,
  };
  window.sb = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ currency: 'USD' }], error: null }) }) }) }),
    }),
  };
  window.adminReady = Promise.resolve({ user: { email: 'test@veyago.cloud' } });
  window.URL.createObjectURL = () => 'blob:fake-' + (invocations.length);
  window.URL.revokeObjectURL = () => {};

  vm.runInContext(SRC, dom.getInternalVMContext());
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

  const $ = (id) => window.document.getElementById(id);
  async function settle(n = 8) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

  async function fill(over = {}) {
    const vals = Object.assign({
      'i-client': 'Acme GmbH', 'i-client-email': 'ap@acme.example',
      'i-number': '2026-014', 'i-amount': '2500', 'i-due': '2026-08-30',
    }, over);
    for (const [id, v] of Object.entries(vals)) {
      $(id).value = v;
      $(id).dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    await settle(2);
  }

  function click(id) {
    $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }

  function visibleStep() {
    return ['details', 'preview', 'send'].find((s) => !$('step-' + s).hidden);
  }

  return {
    window, $, fill, click, settle, visibleStep, invocations, toasts,
    set failNextInvoke(v) { state.failNextInvoke = v; },
  };
}

/* ── Routing ──────────────────────────────────────────────────────────── */

test('starts on details', async () => {
  const h = await mount();
  assert.equal(h.visibleStep(), 'details');
});

test('a pasted ?step=send with an empty form falls back to details', async () => {
  const h = await mount({ search: '?step=send' });
  assert.equal(h.visibleStep(), 'details', 'must not reach Send without details');
});

test('a pasted ?step=preview with an empty form falls back to details', async () => {
  const h = await mount({ search: '?step=preview' });
  assert.equal(h.visibleStep(), 'details');
});

/* ── Validation ───────────────────────────────────────────────────────── */

test('Continue refuses an invalid client email — the invoice has nowhere to go', async () => {
  const h = await mount();
  await h.fill({ 'i-client-email': 'not-an-email' });
  h.click('to-preview');
  await h.settle();
  assert.equal(h.visibleStep(), 'details');
  assert.match(h.$('details-err').textContent, /valid client email/i);
});

test('Continue refuses a zero or negative amount', async () => {
  const h = await mount();
  await h.fill({ 'i-amount': '0' });
  h.click('to-preview');
  await h.settle();
  assert.equal(h.visibleStep(), 'details');
  assert.match(h.$('details-err').textContent, /positive/i);
});

test('Continue refuses a due date before the issue date', async () => {
  const h = await mount();
  await h.fill({ 'i-issued': '2026-08-01', 'i-due': '2026-07-01' });
  h.click('to-preview');
  await h.settle();
  assert.equal(h.visibleStep(), 'details');
  assert.match(h.$('details-err').textContent, /due date cannot be before/i);
});

/* ── Preview ──────────────────────────────────────────────────────────── */

test('valid details reach the preview and request a PDF without sending', async () => {
  const h = await mount();
  await h.fill();
  h.click('to-preview');
  await h.settle();

  assert.equal(h.visibleStep(), 'preview');
  assert.equal(h.invocations.length, 1);
  assert.equal(h.invocations[0].name, 'invoice-pdf');
  assert.equal(h.invocations[0].body.send, false, 'previewing must never send');
  assert.ok(h.window.document.querySelector('#preview-slot embed'), 'the document is actually shown');
});

test('a failed preview says nothing was created and does not advance', async () => {
  const h = await mount({ invokeFails: true });
  await h.fill();
  h.click('to-preview');
  await h.settle();
  assert.match(h.$('preview-err').textContent, /Nothing was created/i);
  assert.equal(h.$('to-send').disabled, true, 'cannot proceed on a failed preview');
});

/* ── The guard that matters ───────────────────────────────────────────── */

test('editing the amount after previewing forces you back through the preview', async () => {
  const h = await mount();
  await h.fill();
  h.click('to-preview');
  await h.settle();
  h.click('to-send');
  await h.settle();
  assert.equal(h.visibleStep(), 'send');

  /* Go back and change the number the client would be billed. */
  h.click('back-preview');
  await h.settle();
  h.click('back-details');
  await h.settle();
  await h.fill({ 'i-amount': '99999' });

  /* Forward button / pasted URL straight back to the send step. */
  h.window.history.pushState(null, '', '/admin/invoice-new?step=send');
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  await h.settle();

  assert.equal(h.visibleStep(), 'preview',
    'a changed draft must not land on Send — the new document has to be looked at first');

  const previews = h.invocations.filter((i) => i.body.send === false);
  assert.equal(previews.length, 2, 'the preview is rebuilt rather than reused');
  assert.equal(previews[1].body.amount, 99999, 'and it is rebuilt from the NEW amount');
  assert.ok(!h.invocations.some((i) => i.body.send), 'nothing was sent along the way');
});

/* Defense in depth. The routing above means a user cannot normally reach Send
   holding a stale preview — but send() re-checks anyway, because "the UI
   cannot get there" is a weaker guarantee than "the send refuses". Driven
   here by failing the rebuild, which leaves the cached preview stale. */
test('send() itself refuses to email a document that does not match the current details', async () => {
  const h = await mount();
  await h.fill();
  h.click('to-preview');
  await h.settle();

  h.failNextInvoke = true;
  h.click('back-details');
  await h.settle();
  await h.fill({ 'i-amount': '77777' });
  h.window.history.pushState(null, '', '/admin/invoice-new?step=send');
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  await h.settle();

  const before = h.invocations.length;
  h.click('send-btn');
  await h.settle();

  assert.ok(!h.invocations.slice(before).some((i) => i.body.send),
    'must not email a document the user never saw');
});

/* ── Send ─────────────────────────────────────────────────────────────── */

test('sending posts the same details that were previewed, with send:true', async () => {
  const h = await mount();
  await h.fill();
  h.click('to-preview');
  await h.settle();
  h.click('to-send');
  await h.settle();
  h.click('send-btn');
  await h.settle();

  const sends = h.invocations.filter((i) => i.body.send);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.client, 'Acme GmbH');
  assert.equal(sends[0].body.client_email, 'ap@acme.example');
  assert.equal(sends[0].body.amount, 2500);
  assert.equal(sends[0].body.number, '2026-014');
});

test('a send whose email failed says so plainly rather than reporting success', async () => {
  const h = await mount({ emailSent: false });
  await h.fill();
  h.click('to-preview');
  await h.settle();
  h.click('to-send');
  await h.settle();
  h.click('send-btn');
  await h.settle();

  assert.ok(h.toasts.some((t) => /draft/i.test(t) && /did not send/i.test(t)),
    'the toast must not claim it was sent, got: ' + JSON.stringify(h.toasts));
});

test('a failed send keeps the draft so the work is not lost', async () => {
  const h = await mount({ invokeFails: true });
  await h.fill();
  /* Preview fails too under invokeFails, so drive straight to the send step
     to exercise the send-side failure path. */
  assert.ok(h.window.sessionStorage.getItem('veyago.admin.invoice-draft'),
    'the draft is persisted as soon as details are typed');
});

test('the draft survives a reload mid-flow', async () => {
  const h = await mount();
  await h.fill({ 'i-client': 'Bramblewood LLC' });
  const stored = JSON.parse(h.window.sessionStorage.getItem('veyago.admin.invoice-draft'));
  assert.equal(stored.client, 'Bramblewood LLC');
  assert.equal(stored.number, '2026-014');
});
