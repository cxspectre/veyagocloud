/* Tests for invoice-pdf/record.ts — how an invoice that has been sent is
   written down.

   invoice-pdf used to insert a new row on every send. Sending a draft again —
   its first email failed, say — left two invoices with the same number and
   amount, and both were counted as owed. It now takes the invoice's id and
   updates that row, and only creates one when no id is given. The database is
   a stand-in that holds finance_invoices in memory and logs every call.

   The record also carries what the invoice is for: the company and project a
   request names, and nothing over the ones stored when it names none (0051).
   And an overdue invoice sent again stays overdue, unless it goes out with a
   due date that has not passed. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let r;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'record.ts'), 'utf8');
  r = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const DRAFT_ID = '5b0a4c1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ID = '8e3d7f4b-5c60-4182-9dce-3f4a5b6c7d8e';
const COMPANY_ID = '9f4e8a5c-6d71-4293-aedf-4a5b6c7d8e9f';
const PROJECT_ID = 'b1609c7e-8f93-44b5-80f1-6c7d8e9fa0b1';
const TODAY = '2026-09-14';

/* What index.ts renders from: the request body, in camelCase. */
const INVOICE = {
  number: '2026-014', client: 'Acme GmbH', clientEmail: 'ap@acme.example', amount: 2500,
  currency: 'USD', issuedOn: null, dueOn: '2026-10-14', notes: 'Net 30',
};

function row(id, status, extra) {
  return Object.assign({
    id, number: '2026-014', client: 'Acme GmbH', client_email: 'ap@acme.example', amount: 2500,
    currency: 'USD', status, issued_on: null, due_on: '2026-10-14', paid_on: null, notes: null,
    company_id: null, project_id: null, created_at: '2026-09-01T10:00:00Z',
  }, extra);
}

/* finance_invoices in memory. Rows change only through the calls, and every
   call is logged as { op, filters, values }. `failures[op]` makes that
   operation return a database error instead. */
function fakeDb(initial, failures = {}) {
  let rows = initial.slice();
  const calls = [];

  function from() {
    let op = 'select';
    let values = null;
    let columns = null;  // what a read named; a write hands back the whole row
    const filters = [];
    const matches = (x) => filters.every(([how, col, val]) => (how === 'eq' ? x[col] === val : x[col] !== val));
    const project = (x) => (columns ? Object.fromEntries(columns.map((c) => [c, x[c]])) : x);

    function finish() {
      calls.push({ op, filters: filters.slice(), values });
      if (failures[op]) return { data: null, error: { message: failures[op] } };
      if (op === 'insert') {
        const created = Object.assign({ id: 'new-' + (rows.length + 1), paid_on: null, created_at: 'now' }, values);
        rows = rows.concat([created]);
        return { data: created, error: null };
      }
      const hit = rows.filter(matches);
      if (op === 'update') {
        if (hit.length !== 1) {
          return { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } };
        }
        const updated = Object.assign({}, hit[0], values);
        rows = rows.map((x) => (x === hit[0] ? updated : x));
        return { data: updated, error: null };
      }
      return { data: hit[0] ? project(hit[0]) : null, error: null };
    }

    const b = {
      select: (cols) => {
        if (op === 'select' && cols) columns = cols.split(',').map((c) => c.trim());
        return b;
      },
      insert: (v) => { op = 'insert'; values = v; return b; },
      update: (v) => { op = 'update'; values = v; return b; },
      eq: (col, val) => { filters.push(['eq', col, val]); return b; },
      neq: (col, val) => { filters.push(['neq', col, val]); return b; },
      maybeSingle: async () => finish(),
      single: async () => finish(),
    };
    return b;
  }

  return { from, calls, rows: () => rows };
}

/* ── Which invoice the request is about ───────────────────────────────── */

test('no invoice_id means a new invoice', () => {
  assert.deepEqual(r.invoiceIdFrom({ client: 'Acme' }), { id: null, error: null });
  assert.deepEqual(r.invoiceIdFrom({ invoice_id: null }), { id: null, error: null });
  assert.deepEqual(r.invoiceIdFrom({ invoice_id: '' }), { id: null, error: null });
  assert.deepEqual(r.invoiceIdFrom(null), { id: null, error: null });
});

test('an invoice_id has to be an invoice id', () => {
  assert.deepEqual(r.invoiceIdFrom({ invoice_id: DRAFT_ID }), { id: DRAFT_ID, error: null });
  for (const bad of ['42', 'draft', 42, {}, DRAFT_ID + ' ']) {
    const out = r.invoiceIdFrom({ invoice_id: bad });
    assert.equal(out.id, null, JSON.stringify(bad));
    assert.match(out.error, /not a valid invoice id/i);
  }
});

test('a row id sent under the wrong name is refused rather than quietly creating a second invoice', () => {
  const out = r.invoiceIdFrom({ id: DRAFT_ID, client: 'Acme' });
  assert.equal(out.id, null);
  assert.match(out.error, /invoice_id/);
});

test('id and invoice_id may both be sent, as long as they name the same invoice', () => {
  assert.deepEqual(r.invoiceIdFrom({ id: DRAFT_ID, invoice_id: DRAFT_ID }), { id: DRAFT_ID, error: null });
  const out = r.invoiceIdFrom({ id: OTHER_ID, invoice_id: DRAFT_ID });
  assert.equal(out.id, null);
  assert.match(out.error, /invoice_id/);
});

/* ── Finding the invoice to send again ────────────────────────────────── */

test('a draft, a sent and an overdue invoice can each be sent again', async () => {
  for (const status of ['draft', 'sent', 'overdue']) {
    const db = fakeDb([row(DRAFT_ID, status)]);
    const found = await r.findInvoiceToSend(db, DRAFT_ID);
    assert.equal(found.error, null, status);
    assert.equal(found.invoice.id, DRAFT_ID);
    assert.deepEqual(db.calls.map((c) => c.op), ['select'], 'looking writes nothing');
  }
});

test('a paid invoice is refused, so the client is not asked to pay it twice', async () => {
  const found = await r.findInvoiceToSend(fakeDb([row(DRAFT_ID, 'paid', { paid_on: '2026-09-10' })]), DRAFT_ID);
  assert.equal(found.invoice, null);
  assert.equal(found.status, 409);
  assert.match(found.error, /#2026-014 is already paid/);
});

test('an invoice that no longer exists is refused', async () => {
  const found = await r.findInvoiceToSend(fakeDb([row(OTHER_ID, 'draft')]), DRAFT_ID);
  assert.equal(found.invoice, null);
  assert.equal(found.status, 404);
  assert.match(found.error, /no longer exists/i);
});

test('looked up for a preview, an invoice that is gone or paid is refused without speaking of a send', async () => {
  const gone = await r.findInvoiceToSend(fakeDb([row(OTHER_ID, 'draft')]), DRAFT_ID, false);
  assert.equal(gone.invoice, null);
  assert.equal(gone.status, 404);
  assert.match(gone.error, /no longer exists/i);
  assert.doesNotMatch(gone.error, /sent/, 'a preview sends nothing');

  const paid = await r.findInvoiceToSend(fakeDb([row(DRAFT_ID, 'paid', { paid_on: '2026-09-10' })]), DRAFT_ID, false);
  assert.equal(paid.invoice, null);
  assert.equal(paid.status, 409);
  assert.match(paid.error, /#2026-014 is already paid/);
  assert.doesNotMatch(paid.error, /was not sent/);

  const draft = await r.findInvoiceToSend(fakeDb([row(DRAFT_ID, 'draft')]), DRAFT_ID, false);
  assert.equal(draft.error, null);
  assert.equal(draft.invoice.id, DRAFT_ID);

  const sending = await r.findInvoiceToSend(fakeDb([row(OTHER_ID, 'draft')]), DRAFT_ID);
  assert.match(sending.error, /nothing was sent/, 'a send still says what did not go out');
});

test('a lookup that fails is reported as a failure, not as a missing invoice', async () => {
  const found = await r.findInvoiceToSend(fakeDb([row(DRAFT_ID, 'draft')], { select: 'timeout' }), DRAFT_ID);
  assert.equal(found.invoice, null);
  assert.equal(found.status, 500);
  assert.match(found.error, /could not be loaded: timeout/);
});

test('the lookup reads the whole invoice, links included, so one that is left alone can be handed back as it stands', async () => {
  const stored = row(DRAFT_ID, 'sent', {
    issued_on: '2026-08-01', notes: 'Net 30', company_id: COMPANY_ID, project_id: PROJECT_ID,
  });
  const found = await r.findInvoiceToSend(fakeDb([stored]), DRAFT_ID);
  assert.deepEqual(found.invoice, stored);
});

/* ── Whether a send is written down at all ────────────────────────────── */

test('a send that went out is always written down', () => {
  for (const existing of [null, row(DRAFT_ID, 'draft'), row(DRAFT_ID, 'sent'), row(DRAFT_ID, 'overdue')]) {
    assert.equal(r.shouldSave(existing, true), true, existing ? existing.status : 'new');
  }
});

test('a send that did not go out is written down only as a draft', () => {
  assert.equal(r.shouldSave(null, false), true, 'a new invoice is kept as a draft to retry');
  assert.equal(r.shouldSave(row(DRAFT_ID, 'draft'), false), true, 'a draft keeps the details it was retried with');
  assert.equal(r.shouldSave(row(DRAFT_ID, 'sent'), false), false,
    'the client has the invoice as it was sent; nothing new reached them');
  assert.equal(r.shouldSave(row(DRAFT_ID, 'overdue'), false), false);
});

/* ── What is written ──────────────────────────────────────────────────── */

test('a new invoice that went out is recorded as sent, issued today unless it says otherwise', () => {
  assert.deepEqual(r.invoiceRecord(INVOICE, true, null, TODAY), {
    number: '2026-014', client: 'Acme GmbH', client_email: 'ap@acme.example', amount: 2500,
    currency: 'USD', issued_on: TODAY, due_on: '2026-10-14', notes: 'Net 30', status: 'sent',
  });
  assert.equal(r.invoiceRecord({ ...INVOICE, issuedOn: '2026-09-12' }, true, null, TODAY).issued_on, '2026-09-12');
});

test('a new invoice whose email failed is a draft, with no issue date stamped on it', () => {
  const rec = r.invoiceRecord(INVOICE, false, null, TODAY);
  assert.equal(rec.status, 'draft');
  assert.equal(rec.issued_on, null);
});

test('a draft that goes out on a second try becomes sent', () => {
  const rec = r.invoiceRecord(INVOICE, true, row(DRAFT_ID, 'draft'), TODAY);
  assert.equal(rec.status, 'sent');
  assert.equal(rec.issued_on, TODAY);
});

test('a failed send never moves an invoice backwards', () => {
  assert.equal(r.invoiceRecord(INVOICE, false, row(DRAFT_ID, 'draft'), TODAY).status, 'draft');

  const sent = r.invoiceRecord(INVOICE, false, row(DRAFT_ID, 'sent', { issued_on: '2026-08-01' }), TODAY);
  assert.equal(sent.status, 'sent', 'the client already has it; a copy that failed does not unsend it');
  assert.equal(sent.issued_on, '2026-08-01', 'and the date it was issued is kept');

  assert.equal(r.invoiceRecord(INVOICE, false, row(DRAFT_ID, 'overdue'), TODAY).status, 'overdue');
});

test('an overdue invoice sent again stays overdue while the due date it goes out with has passed, or it has none', () => {
  const overdue = row(DRAFT_ID, 'overdue', { issued_on: '2026-08-01', due_on: '2026-08-31' });
  assert.equal(r.invoiceRecord({ ...INVOICE, dueOn: '2026-08-31' }, true, overdue, TODAY).status, 'overdue',
    'a copy of a late invoice is still late');
  assert.equal(r.invoiceRecord({ ...INVOICE, dueOn: '2026-09-13' }, true, overdue, TODAY).status, 'overdue',
    'yesterday has passed');
  assert.equal(r.invoiceRecord({ ...INVOICE, dueOn: null }, true, overdue, TODAY).status, 'overdue',
    'no due date is no new time to pay');
});

test('an overdue invoice sent again with a due date of today or later is sent', () => {
  const overdue = row(DRAFT_ID, 'overdue', { issued_on: '2026-08-01', due_on: '2026-08-31' });
  assert.equal(r.invoiceRecord({ ...INVOICE, dueOn: TODAY }, true, overdue, TODAY).status, 'sent', 'due today is not late yet');
  assert.equal(r.invoiceRecord({ ...INVOICE, dueOn: '2026-10-14' }, true, overdue, TODAY).status, 'sent');
});

test('only an overdue invoice keeps its status: a new, draft or sent invoice that goes out is sent, whatever its due date', () => {
  const past = { ...INVOICE, dueOn: '2026-08-31' };
  assert.equal(r.invoiceRecord(past, true, null, TODAY).status, 'sent');
  assert.equal(r.invoiceRecord(past, true, row(DRAFT_ID, 'draft'), TODAY).status, 'sent');
  assert.equal(r.invoiceRecord(past, true, row(DRAFT_ID, 'sent'), TODAY).status, 'sent');
});

test('sending again keeps the date it was first issued when the request names none', () => {
  const rec = r.invoiceRecord(INVOICE, true, row(DRAFT_ID, 'sent', { issued_on: '2026-08-01' }), TODAY);
  assert.equal(rec.issued_on, '2026-08-01');
  const named = r.invoiceRecord({ ...INVOICE, issuedOn: '2026-09-01' }, true, row(DRAFT_ID, 'sent', { issued_on: '2026-08-01' }), TODAY);
  assert.equal(named.issued_on, '2026-09-01', 'a date on the document itself wins');
});

test('the record never writes the id, the payment date or when the row was created', () => {
  const rec = r.invoiceRecord(INVOICE, true, row(DRAFT_ID, 'draft'), TODAY);
  for (const key of ['id', 'paid_on', 'created_at']) assert.ok(!(key in rec), key + ' must not be written');
});

test('the company and the project a request names are written', () => {
  const rec = r.invoiceRecord({ ...INVOICE, companyId: COMPANY_ID, projectId: PROJECT_ID }, true, null, TODAY);
  assert.equal(rec.company_id, COMPANY_ID);
  assert.equal(rec.project_id, PROJECT_ID);

  const failed = r.invoiceRecord({ ...INVOICE, companyId: COMPANY_ID, projectId: PROJECT_ID }, false, row(DRAFT_ID, 'draft'), TODAY);
  assert.equal(failed.company_id, COMPANY_ID, 'a draft keeps the links it was retried with');
  assert.equal(failed.project_id, PROJECT_ID);
});

test('one named alone is written alone', () => {
  const project = r.invoiceRecord({ ...INVOICE, projectId: PROJECT_ID }, true, null, TODAY);
  assert.equal(project.project_id, PROJECT_ID);
  assert.ok(!('company_id' in project), 'the database takes the company from the project');

  const company = r.invoiceRecord({ ...INVOICE, companyId: COMPANY_ID, projectId: null }, true, null, TODAY);
  assert.equal(company.company_id, COMPANY_ID);
  assert.ok(!('project_id' in company));
});

test('a request that names neither writes neither, so what is stored stays', () => {
  const stored = row(DRAFT_ID, 'sent', { issued_on: '2026-08-01', company_id: COMPANY_ID, project_id: PROJECT_ID });
  for (const links of [{}, { companyId: null, projectId: null }]) {
    const rec = r.invoiceRecord({ ...INVOICE, ...links }, true, stored, TODAY);
    assert.ok(!('company_id' in rec), 'company_id must not be written: ' + JSON.stringify(links));
    assert.ok(!('project_id' in rec), 'project_id must not be written: ' + JSON.stringify(links));
  }
});

/* ── Saving ───────────────────────────────────────────────────────────── */

test('with no invoice to send again, one new row is inserted', async () => {
  const db = fakeDb([]);
  const out = await r.saveInvoice(db, null, r.invoiceRecord(INVOICE, true, null, TODAY));

  assert.equal(out.error, null);
  assert.deepEqual(db.calls.map((c) => c.op), ['insert']);
  assert.equal(db.rows().length, 1);
  assert.equal(out.invoice.status, 'sent');
});

test('sending a draft again updates that draft instead of adding a second invoice', async () => {
  const db = fakeDb([row(DRAFT_ID, 'draft'), row(OTHER_ID, 'sent', { number: '2026-013' })]);
  const found = await r.findInvoiceToSend(db, DRAFT_ID);
  const out = await r.saveInvoice(db, found.invoice,
    r.invoiceRecord({ ...INVOICE, amount: 2750 }, true, found.invoice, TODAY));

  assert.equal(out.error, null);
  assert.equal(db.rows().length, 2, 'still two invoices');
  assert.ok(!db.calls.some((c) => c.op === 'insert'), 'nothing was inserted');
  assert.deepEqual(db.calls.find((c) => c.op === 'update').filters,
    [['eq', 'id', DRAFT_ID], ['neq', 'status', 'paid']]);
  assert.equal(out.invoice.id, DRAFT_ID);
  assert.equal(out.invoice.status, 'sent');
  assert.equal(out.invoice.amount, 2750);
  assert.equal(db.rows().find((x) => x.id === OTHER_ID).number, '2026-013', 'the other invoice is untouched');
});

test('an invoice sent again naming no links keeps the company and project it has', async () => {
  const stored = row(DRAFT_ID, 'sent', { issued_on: '2026-08-01', company_id: COMPANY_ID, project_id: PROJECT_ID });
  const db = fakeDb([stored]);
  const out = await r.saveInvoice(db, stored, r.invoiceRecord(INVOICE, true, stored, TODAY));

  assert.equal(out.error, null);
  assert.equal(out.invoice.company_id, COMPANY_ID);
  assert.equal(out.invoice.project_id, PROJECT_ID);
});

test('an invoice paid or deleted while its email was going out is left alone, not recreated', async () => {
  const existing = row(DRAFT_ID, 'draft');

  const paidMeanwhile = fakeDb([row(DRAFT_ID, 'paid', { paid_on: TODAY })]);
  const out = await r.saveInvoice(paidMeanwhile, existing, r.invoiceRecord(INVOICE, true, existing, TODAY));
  assert.equal(out.invoice, null);
  assert.match(out.error, /deleted or marked paid/);
  assert.equal(paidMeanwhile.rows()[0].status, 'paid', 'the payment stands');
  assert.ok(!paidMeanwhile.calls.some((c) => c.op === 'insert'));

  const deletedMeanwhile = fakeDb([]);
  const gone = await r.saveInvoice(deletedMeanwhile, existing, r.invoiceRecord(INVOICE, true, existing, TODAY));
  assert.match(gone.error, /deleted or marked paid/);
  assert.equal(deletedMeanwhile.rows().length, 0);
});

test('a database error on save comes back as its message', async () => {
  const insert = await r.saveInvoice(fakeDb([], { insert: 'violates check constraint' }), null,
    r.invoiceRecord(INVOICE, true, null, TODAY));
  assert.deepEqual(insert, { invoice: null, error: 'violates check constraint' });

  const existing = row(DRAFT_ID, 'draft');
  const update = await r.saveInvoice(fakeDb([existing], { update: 'permission denied' }), existing,
    r.invoiceRecord(INVOICE, true, existing, TODAY));
  assert.deepEqual(update, { invoice: null, error: 'permission denied' });
});
