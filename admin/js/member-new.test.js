/* Tests for admin/js/member-new.js — adding a team member.

   Only an owner makes someone an owner (migration 0042), and invite-employee
   refuses anyone else. So the form never lets an admin choose the role — it
   shows the card and says why — and a saved draft that chose it is set back. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'member-new.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'member-new.html'), 'utf8');
const DRAFT_KEY = 'veyago.admin.invite-draft';
const PERSON = { name: 'Alex Doe', email: 'alex@example.com', title: '', start: '' };

function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

const turns = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* Every query answers empty: nobody on the team yet, no checklist item. */
function query() {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    order() { return builder; },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then(ok, fail) { return Promise.resolve({ data: [], error: null }).then(ok, fail); }
  };
  return builder;
}

/* The access step, opened by someone with this role, with this draft saved. */
async function open(callerRole, draft) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/member-new?step=access',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  window.admin = { toast() {}, localDate: () => '2026-09-21' };
  window.adminRoles = {
    requireManager: async () => true,
    role: async () => callerRole,
    invokeFn: async () => ({})
  };
  window.sb = { from: query };
  window.adminReady = Promise.resolve({ user: { id: 'u1' } });
  window.eval(SRC);
  await turns();
  return window;
}

test('an admin sees the Owner card, and why it cannot be chosen', async () => {
  const window = await open('admin', { ...PERSON, role: '' });
  const owner = window.document.querySelector('#role-cards input[value="owner"]');
  assert.ok(owner, 'the card is still there');
  assert.equal(owner.disabled, true);
  assert.match(owner.closest('label').textContent, /Only an owner can make someone an owner\./);
  assert.equal(window.document.querySelector('#role-cards input[value="admin"]').disabled, false,
    'an admin still makes admins');
});

test('a draft that chose Owner is set back when an admin opens it', async () => {
  const window = await open('admin', { ...PERSON, role: 'owner' });
  assert.equal(window.document.querySelector('#role-cards input:checked'), null);
  assert.equal(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY)).role, '');
});

test('an owner chooses Owner', async () => {
  const window = await open('owner', { ...PERSON, role: 'owner' });
  const owner = window.document.querySelector('#role-cards input[value="owner"]');
  assert.equal(owner.disabled, false);
  assert.equal(owner.checked, true);
});
