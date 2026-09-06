/* Tests for assets/js/enquiry.js - the Get-a-quote form.

   The form is the site's only first-party write path, and it has to degrade
   to a mailto: whenever the endpoint is missing, slow, rate-limited or down,
   so a lead is never silently lost. These run the real script in a jsdom
   window with a fake fetch and check each of those paths, plus the honeypot
   and the "faster than a human" guard. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'enquiry.js'), 'utf8');

const FORM = `
<form class="enq" data-enquiry="website" action="mailto:hello@veyago.cloud" method="post">
  <div class="enq-fields">
    <input name="name" /><input name="email" /><input name="business" /><input name="website" />
    <textarea name="message"></textarea>
    <input name="hp_ref" />
    <button type="submit">Send</button>
  </div>
  <p class="enq-status" hidden></p>
  <div class="enq-done" hidden><h3>Thanks.</h3></div>
  <div class="enq-msgs" hidden>
    <span data-msg="sending">Sending…</span>
    <span data-msg="invalid">Check fields.</span>
    <span data-msg="error">Did not go through.</span>
    <span data-msg="rate-limited">Too many.</span>
    <span data-msg="fallback-link">Send by email</span>
  </div>
</form>`;

function mount(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body>' + FORM + '</body></html>', {
    url: 'https://veyago.cloud/websites/',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const calls = [];
  window.fetch = fetchImpl ? (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); } : undefined;
  vm.runInContext(SRC, dom.getInternalVMContext());
  const form = window.document.querySelector('form');
  /* The script stamps when the form was drawn; pretend that was a while ago
     so submissions look human unless a test says otherwise. */
  form.setAttribute('data-rendered-at', String(Date.now() - 60000));
  return { window, form, calls };
}

function fill(form, v) {
  Object.keys(v).forEach((k) => { form.elements[k].value = v[k]; });
}
function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return new Promise((r) => setTimeout(r, 10));
}
const okResponse = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
const status = (form) => form.querySelector('.enq-status');

test('a valid submission posts JSON to the endpoint and shows the thank-you', async () => {
  const { window, form, calls } = mount(okResponse);
  fill(form, { name: 'Ann Lee', email: 'ann@example.com', business: 'Ann Bakes', website: 'annbakes.com', message: 'Hi' });
  await submit(window, form);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/functions\/v1\/website-enquiry$/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.kind, 'website');
  assert.equal(body.email, 'ann@example.com');
  assert.equal(body.page, '/websites/');
  assert.equal(body.hp_ref, '', 'honeypot travels empty');
  assert.ok(body.t > 0, 'render timestamp travels with it');
  assert.equal(form.querySelector('.enq-done').hidden, false);
  assert.equal(form.querySelector('.enq-fields').hidden, true);
});

test('client-side validation blocks the post and names the field', async () => {
  const { window, form, calls } = mount(okResponse);
  fill(form, { name: 'A', email: 'nope', website: 'not a site' });
  await submit(window, form);
  assert.equal(calls.length, 0);
  assert.equal(status(form).textContent, 'Check fields.');
  assert.ok(form.elements.name.classList.contains('enq-invalid'));
  assert.ok(form.elements.email.classList.contains('enq-invalid'));
  assert.ok(form.elements.website.classList.contains('enq-invalid'));
  assert.equal(form.elements.email.getAttribute('aria-invalid'), 'true');
});

test('a filled honeypot never reaches the endpoint; the visitor just sees the email fallback', async () => {
  const { window, form, calls } = mount(okResponse);
  fill(form, { name: 'Ann Lee', email: 'ann@example.com', hp_ref: 'bot' });
  await submit(window, form);
  assert.equal(calls.length, 0);
  const a = status(form).querySelector('a');
  assert.ok(a && a.href.startsWith('mailto:hello@veyago.cloud?subject=Website%20enquiry'));
});

test('submitting within seconds of the form appearing is treated the same way', async () => {
  const { window, form, calls } = mount(okResponse);
  form.setAttribute('data-rendered-at', String(Date.now()));
  fill(form, { name: 'Ann Lee', email: 'ann@example.com' });
  await submit(window, form);
  assert.equal(calls.length, 0);
  assert.ok(status(form).querySelector('a'));
});

test('a network failure falls back to a pre-filled mailto with everything typed', async () => {
  const { window, form } = mount(() => Promise.reject(new Error('offline')));
  fill(form, { name: 'Ann Lee', email: 'ann@example.com', business: 'Ann Bakes', website: 'annbakes.com', message: 'Slow site' });
  await submit(window, form);
  const a = status(form).querySelector('a');
  assert.ok(a, 'fallback link present');
  const href = decodeURIComponent(a.getAttribute('href'));
  assert.ok(href.startsWith('mailto:hello@veyago.cloud?subject=Website enquiry - Ann Bakes'));
  assert.ok(href.includes('Name: Ann Lee'));
  assert.ok(href.includes('Current site: annbakes.com'));
  assert.ok(href.includes('Slow site'));
  assert.equal(form.querySelector('button').disabled, false, 'button re-enabled');
});

test('rate limiting and server errors also fall back rather than dead-end', async () => {
  for (const [code, msg] of [[429, 'Too many.'], [500, 'Did not go through.']]) {
    const { window, form } = mount(() => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({ ok: false }) }));
    fill(form, { name: 'Ann Lee', email: 'ann@example.com' });
    await submit(window, form);
    assert.ok(status(form).textContent.startsWith(msg), String(code));
    assert.ok(status(form).querySelector('a'), String(code) + ' has a mailto');
  }
});

test('a 400 with a server message shows that message instead of the fallback', async () => {
  const { window, form } = mount(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ ok: false, error: 'That website address does not look right.' }) }));
  fill(form, { name: 'Ann Lee', email: 'ann@example.com' });
  await submit(window, form);
  assert.equal(status(form).textContent, 'That website address does not look right.');
});

test('with no fetch at all (very old browser) it goes straight to the mailto path', async () => {
  const { window, form } = mount(undefined);
  fill(form, { name: 'Ann Lee', email: 'ann@example.com' });
  await submit(window, form);
  assert.ok(status(form).querySelector('a'));
});

test('the two real forms stay in sync: same field names, same status-message keys', () => {
  const pages = ['websites/index.html', 'services/index.html'].map((p) => {
    const doc = new JSDOM(fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8')).window.document;
    const form = doc.querySelector('form[data-enquiry]');
    return {
      page: p,
      fields: [...new Set([...form.querySelectorAll('input, textarea')].map((el) => el.name))].sort(),
      msgs: [...form.querySelectorAll('[data-msg]')].map((el) => el.getAttribute('data-msg')).sort(),
      honeypotLabel: form.querySelector('.enq-hp label').textContent,
    };
  });
  assert.deepEqual(pages[0].fields, pages[1].fields);
  assert.deepEqual(pages[0].msgs, pages[1].msgs);
  assert.deepEqual([...new Set(pages[0].fields)], ['business', 'email', 'hp_ref', 'message', 'name', 'package', 'website']);
  assert.deepEqual(pages[0].msgs, ['error', 'fallback-address', 'fallback-link', 'invalid', 'invalid-email', 'invalid-name', 'invalid-website', 'rate-limited', 'sending']);
  for (const p of pages) assert.equal(p.honeypotLabel, 'Leave this field empty', p.page + ': honeypot must not look like a real field to autofill');
});

test('a 400 naming a field highlights that field and uses the translated generic message', async () => {
  const { window, form } = mount(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ ok: false, error: 'That website address does not look right.', field: 'website' }) }));
  fill(form, { name: 'Ann Lee', email: 'ann@example.com', website: 'annbakes.com' });
  await submit(window, form);
  assert.ok(form.elements.website.classList.contains('enq-invalid'));
  assert.equal(status(form).textContent, 'Check fields.');
});
