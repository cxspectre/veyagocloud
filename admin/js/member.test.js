/* Tests for admin/js/member.js — one team member's page.

   Two rules the database enforces are shown here too, so the page never offers
   what will be refused: only an owner changes an owner or makes someone one
   (migration 0042), and phone and notes are not in the team directory — owners,
   admins and the person themself ask employee_private() for them (0043). */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'member.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'member.html'), 'utf8');
const MEMBER_ID = 'e1000000-0000-4000-8000-000000000002';
const SELF_ID = 'e1000000-0000-4000-8000-000000000001';
const FIELDS = ['f-full_name', 'f-title', 'f-phone', 'f-start_date', 'f-role', 'f-status', 'f-notes'];

function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

const turns = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* A query the way supabase-js builds one: every call recorded, answered once
   it is awaited. */
function query(table, calls, answer) {
  const q = { table, select: null, eq: {}, update: null };
  const settle = () => { calls.push(q); return Promise.resolve(answer(q)); };
  const builder = {
    select(columns) { q.select = columns; return builder; },
    eq(column, value) { q.eq[column] = value; return builder; },
    neq() { return builder; },
    order() { return builder; },
    update(patch) { q.update = patch; return builder; },
    upsert(row) { q.upsert = row; return builder; },
    maybeSingle: settle,
    then(ok, fail) { return settle().then(ok, fail); }
  };
  return builder;
}

/* opts:
     callerRole      the signed-in person's role ('owner', 'admin', 'employee')
     member          fields of the record being viewed
     self            the record is the signed-in person's own
     privateDetails  what employee_private answers
     legacy          what selecting phone,notes answers (a database before 0043) */
async function open(opts = {}) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/member?id=' + MEMBER_ID,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  const callerRole = opts.callerRole || 'admin';
  const row = Object.assign({
    id: MEMBER_ID, email: 'sam@example.com', full_name: 'Sam Rivera', role: 'employee', title: null,
    status: 'active', start_date: null, user_id: 'u2', created_at: '2026-01-01T00:00:00Z'
  }, opts.member || {});
  const calls = [];
  const rpcs = [];

  window.admin = { toast() {}, localDate: () => '2026-09-14' };
  window.adminRoles = {
    isManager: async () => callerRole === 'owner' || callerRole === 'admin',
    role: async () => callerRole,
    employee: async () => ({ id: opts.self ? MEMBER_ID : SELF_ID }),
    invokeFn: async () => ({})
  };
  window.sb = {
    from: (table) => query(table, calls, (q) => {
      if (table !== 'employees') return { data: [], error: null };
      if (q.update) return { data: null, error: null };
      if (q.select === 'phone,notes') return opts.legacy || { data: null, error: { message: 'not asked for' } };
      return { data: row, error: null };
    }),
    rpc: async (name, args) => {
      rpcs.push({ name, args });
      return opts.privateDetails || { data: [{ phone: '+49 30 1234', notes: 'Prefers mornings' }], error: null };
    }
  };
  window.adminReady = Promise.resolve({ user: { id: 'u1' } });
  window.eval(SRC);
  await turns();
  const $ = (id) => window.document.getElementById(id);
  return { window, $, calls, rpcs };
}

test('an admin sees an owner’s record but cannot change it', async () => {
  const { $ } = await open({ callerRole: 'admin', member: { role: 'owner' } });
  FIELDS.forEach((id) => assert.equal($(id).disabled, true, id));
  assert.equal($('m-save').hidden, true);
  assert.match($('m-form-msg').textContent, /Only an owner can change an owner/);
  assert.equal($('m-deactivate').hidden, true);
  assert.match($('m-danger-note').textContent, /Only an owner can deactivate an owner/);
});

test('an owner changes another owner’s record', async () => {
  const { $ } = await open({ callerRole: 'owner', member: { role: 'owner' } });
  assert.equal($('f-title').disabled, false);
  assert.equal($('m-save').hidden, false);
  assert.equal($('m-deactivate').hidden, false);
});

test('an admin cannot give anyone the Owner role; an owner can', async () => {
  const admin = await open({ callerRole: 'admin' });
  assert.equal(admin.$('f-role').disabled, false, 'other roles can still be given');
  assert.equal(admin.window.document.querySelector('#f-role option[value="owner"]').disabled, true);
  const owner = await open({ callerRole: 'owner' });
  assert.equal(owner.window.document.querySelector('#f-role option[value="owner"]').disabled, false);
});

test('phone and notes come from employee_private, not from the team directory', async () => {
  const { $, calls, rpcs } = await open({ callerRole: 'admin' });
  const read = calls.find((q) => q.table === 'employees' && q.select && q.select.includes('full_name'));
  assert.ok(read, 'the record is read');
  assert.doesNotMatch(read.select, /phone|notes/);
  assert.deepEqual(rpcs, [{ name: 'employee_private', args: { p_employee_id: MEMBER_ID } }]);
  assert.equal($('f-phone').value, '+49 30 1234');
  assert.equal($('f-notes').value, 'Prefers mornings');
});

test('a colleague who is not an owner or admin is shown neither, and does not ask', async () => {
  const { $, rpcs } = await open({ callerRole: 'employee' });
  assert.equal(rpcs.length, 0);
  assert.equal($('f-phone').closest('.field').hidden, true);
  assert.equal($('f-notes').closest('.field').hidden, true);
});

test('someone on their own record sees their phone number, not the notes about them', async () => {
  const { $ } = await open({
    callerRole: 'employee', self: true,
    privateDetails: { data: [{ phone: '+49 30 1234', notes: null }], error: null }
  });
  assert.equal($('f-phone').closest('.field').hidden, false);
  assert.equal($('f-phone').value, '+49 30 1234');
  assert.equal($('f-notes').closest('.field').hidden, true);
});

test('phone and notes that could not be read are never saved over', async () => {
  const { $, calls } = await open({
    callerRole: 'admin',
    privateDetails: { data: null, error: { code: 'XX000', message: 'the database is busy' } }
  });
  assert.match($('msg').textContent, /Could not load their phone number and notes: the database is busy/);
  assert.equal($('f-phone').disabled, true);
  assert.equal($('f-notes').disabled, true);

  $('f-title').value = 'Designer';
  $('m-save').click();
  await turns();
  const saved = calls.find((q) => q.table === 'employees' && q.update);
  assert.ok(saved, 'the rest still saves');
  assert.equal(saved.update.title, 'Designer');
  assert.equal('phone' in saved.update, false, 'a blank would erase the phone number');
  assert.equal('notes' in saved.update, false, 'a blank would erase the notes');
});

test('a database from before 0043 still gives phone and notes', async () => {
  const { $ } = await open({
    callerRole: 'admin',
    privateDetails: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.employee_private' } },
    legacy: { data: { phone: '+1 555 0100', notes: 'Old notes' }, error: null }
  });
  assert.equal($('f-phone').value, '+1 555 0100');
  assert.equal($('f-notes').value, 'Old notes');
  assert.equal($('f-phone').disabled, false);
});
