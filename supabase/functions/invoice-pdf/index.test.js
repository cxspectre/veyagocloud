/* Tests for invoice-pdf/index.ts — the Edge Function as a whole, run in Node.

   There is no Deno here, so index.ts is loaded with its types stripped and
   each import swapped for a stand-in: the PDF builder and the mailer record
   what they were handed, and the database is finance_invoices, crm_companies,
   client_projects, email_log and workspace_settings in memory. So the order
   that matters — who is let in, what is refused before an email goes out, and
   whether a send inserts or updates — is tested on the real handler. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

function importTs(file) {
  const src = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  return import('data:text/javascript,' + encodeURIComponent(src));
}

/* index.ts with every import replaced by modules[specifier] (a value, or a
   function that makes one), and Deno.serve caught so the handler can be
   called with a Request. An import with no stand-in fails the load rather
   than being skipped. */
async function loadHandler(file, modules) {
  const IMPORT = /^import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+'([^']+)';/gm;
  const stripped = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  const resolved = {};
  for (const [, , , spec] of stripped.matchAll(IMPORT)) {
    if (!(spec in modules)) throw new Error(`index.ts imports ${spec}, which has no stand-in here`);
    resolved[spec] = typeof modules[spec] === 'function' ? await modules[spec]() : modules[spec];
  }
  const src = stripped.replace(IMPORT, (_, star, names, spec) => {
    const from = `globalThis.__edgeImports[${JSON.stringify(spec)}]`;
    return star ? `const ${star} = ${from};` : `const {${names.replace(/\s+as\s+/g, ': ')}} = ${from};`;
  });
  if (/^\s*import\s/m.test(src)) throw new Error('index.ts has an import this loader cannot replace');

  let handler = null;
  globalThis.__edgeImports = resolved;
  globalThis.Deno = { serve: (fn) => { handler = fn; }, env: { get: (key) => ENV[key] } };
  await import('data:text/javascript,' + encodeURIComponent(src));
  if (!handler) throw new Error('index.ts never called Deno.serve');
  return handler;
}

/* ── The world the function runs against, rebuilt for every test ────────── */

const DRAFT = '5b0a4c1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b';
const SENT = '6c1b5d2f-3a4e-4f60-9bac-1d2e3f4a5b6c';
const PAID = '7d2c6e3a-4b5f-4071-8cbd-2e3f4a5b6c7d';
const MISSING = '8e3d7f4b-5c60-4182-9dce-3f4a5b6c7d8e';
const OVERDUE = '9a4f8e5d-6b7c-4d8e-9f0a-4b5c6d7e8f90';

const COMPANY = '9f4e8a5c-6d71-4293-aedf-4a5b6c7d8e9f';
const OTHER_COMPANY = 'a05f9b6d-7e82-43a4-bfe0-5b6c7d8e9fa0';
const PROJECT = 'b1609c7e-8f93-44b5-80f1-6c7d8e9fa0b1';
const GONE = 'c271ad8f-90a4-45c6-9102-7d8e9fa0b1c2';

let world;

function fresh(over = {}) {
  const { invoices = [], companies = [], projects = [], ...rest } = over;
  world = Object.assign({
    user: { id: 'manager-1', email: 'boss@veyago.cloud' },
    isManager: true,
    roleError: null,
    sendResult: { ok: true, id: 're_1' },
    tables: {
      finance_invoices: invoices, crm_companies: companies, client_projects: projects,
      workspace_settings: [], email_log: [],
    },
    writes: [],          // [op, table], in order
    reads: [],           // table, for every read, in order
    rendered: [],        // what buildInvoicePdf was handed
    emails: [],          // what sendEmail was handed
    beforeUpdate: null,  // runs just before an update lands
  }, rest);
  return world;
}

function invoiceRow(id, status, extra) {
  return Object.assign({
    id, number: '2026-014', client: 'Acme GmbH', client_email: 'ap@acme.example', amount: 2500,
    currency: 'USD', status, issued_on: null, due_on: '2026-10-14', paid_on: null, notes: 'Net 30',
    company_id: null, project_id: null, created_at: '2026-09-01T10:00:00Z',
  }, extra);
}

const companyRow = (id, extra) => Object.assign({ id, name: 'Acme GmbH', deleted_at: null }, extra);
const projectRow = (id, companyId, extra) =>
  Object.assign({ id, name: 'Acme · Website', company_id: companyId, deleted_at: null }, extra);

const DETAILS = {
  client: 'Acme GmbH', client_email: 'ap@acme.example', number: '2026-014', amount: 2500,
  currency: 'USD', issued_on: null, due_on: '2026-10-14', notes: 'Net 30',
};

const NO_ROW = { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' };

/* A table query in memory: select / insert / update, eq / neq / in, and
   maybeSingle / single / await, answering the way PostgREST does. */
function table(name) {
  const state = { op: 'select', values: null, filters: [], columns: null };
  const matches = (row) => state.filters.every(([how, col, val]) =>
    how === 'eq' ? row[col] === val : how === 'neq' ? row[col] !== val : val.includes(row[col]));
  /* A read hands back the columns it named; a write's .select() the whole row. */
  const project = (row) => (state.columns ? Object.fromEntries(state.columns.map((c) => [c, row[c]])) : row);

  function run(mode) {
    if (state.op === 'insert') {
      const rows = world.tables[name];
      const created = [].concat(state.values).map((v, i) => Object.assign(
        { id: `${name}-${rows.length + i + 1}`, created_at: '2026-09-14T09:00:00Z' }, v));
      world.tables[name] = rows.concat(created);
      world.writes.push(['insert', name]);
      return mode === 'one' ? { data: created[0], error: null } : { data: null, error: null };
    }
    if (state.op === 'update') {
      if (world.beforeUpdate) world.beforeUpdate();
      const hit = world.tables[name].filter(matches).map((r) => r.id);
      world.tables[name] = world.tables[name].map((r) => (hit.includes(r.id) ? Object.assign({}, r, state.values) : r));
      world.writes.push(['update', name]);
      const updated = world.tables[name].filter((r) => hit.includes(r.id));
      if (mode !== 'one') return { data: null, error: null };
      return updated.length === 1 ? { data: updated[0], error: null } : { data: null, error: NO_ROW };
    }
    world.reads.push(name);
    const hit = world.tables[name].filter(matches).map(project);
    if (mode === 'maybe') return { data: hit[0] || null, error: null };
    if (mode === 'one') return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: NO_ROW };
    return { data: hit, error: null };
  }

  const q = {
    select: (cols) => {
      if (state.op === 'select' && cols) state.columns = cols.split(',').map((c) => c.trim());
      return q;
    },
    insert: (values) => { state.op = 'insert'; state.values = values; return q; },
    update: (values) => { state.op = 'update'; state.values = values; return q; },
    eq: (col, val) => { state.filters.push(['eq', col, val]); return q; },
    neq: (col, val) => { state.filters.push(['neq', col, val]); return q; },
    in: (col, vals) => { state.filters.push(['in', col, vals]); return q; },
    maybeSingle: async () => run('maybe'),
    single: async () => run('one'),
    then: (resolve, reject) => Promise.resolve().then(() => run('many')).then(resolve, reject),
  };
  return q;
}

function callerClient() {
  return {
    auth: {
      getUser: async () => (world.user
        ? { data: { user: world.user }, error: null }
        : { data: { user: null }, error: { message: 'Auth session missing!' } }),
    },
    rpc: async (name) => (world.roleError
      ? { data: null, error: { message: world.roleError } }
      : { data: name === 'is_manager' && world.isManager, error: null }),
  };
}

let handler;
test.before(async () => {
  handler = await loadHandler(path.join(__dirname, 'index.ts'), {
    'npm:@supabase/supabase-js@2': {
      createClient: (url, key) => (key === ENV.SUPABASE_ANON_KEY ? callerClient() : { from: table }),
    },
    'https://esm.sh/pdf-lib@1.17.1': {},
    '../_shared/invoice-pdf.ts': {
      buildInvoicePdf: async (pdfLib, invoice) => {
        world.rendered.push(invoice);
        return new Uint8Array([37, 80, 68, 70]); // %PDF
      },
    },
    '../_shared/email.ts': {
      invoiceEmail: (o) => ({ subject: `Invoice ${o.number} from Veyago — ${o.amountFormatted}`, html: '<p>Invoice</p>', text: 'Invoice' }),
      sendEmail: async (o) => { world.emails.push(o); return world.sendResult; },
    },
    './record.ts': () => importTs(path.join(__dirname, 'record.ts')),
    './links.ts': () => importTs(path.join(__dirname, 'links.ts')),
  });
});

async function post(body) {
  const res = await handler(new Request('https://project.supabase.co/functions/v1/invoice-pdf', {
    method: 'POST',
    headers: { Authorization: 'Bearer caller-jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const invoiceWrites = () => world.writes.filter(([, t]) => t === 'finance_invoices').map(([op]) => op);
const linkReads = () => world.reads.filter((t) => t === 'crm_companies' || t === 'client_projects');

/* Nothing rendered, emailed or written. */
function nothingWentOut(label) {
  assert.equal(world.rendered.length, 0, `${label}: nothing rendered`);
  assert.equal(world.emails.length, 0, `${label}: nothing emailed`);
  assert.deepEqual(world.writes, [], `${label}: nothing written`);
}

/* ── Creating, and sending again ──────────────────────────────────────── */

test('with no invoice_id, sending creates the invoice, as it always has', async () => {
  fresh();
  const out = await post({ ...DETAILS, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(invoiceWrites(), ['insert']);
  assert.equal(world.tables.finance_invoices.length, 1);
  assert.equal(out.body.invoice.status, 'sent');
  assert.equal(out.body.emailSent, true);
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, 'ap@acme.example');
  assert.equal(world.tables.email_log.length, 1);
  assert.equal(world.tables.email_log[0].requested_by, 'manager-1');
});

test('sending a draft again with its invoice_id updates that draft, and no second invoice appears', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')] });
  const out = await post({ ...DETAILS, amount: 2750, invoice_id: DRAFT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(invoiceWrites(), ['update'], 'nothing inserted');
  assert.equal(world.tables.finance_invoices.length, 1, 'still one invoice');
  const [only] = world.tables.finance_invoices;
  assert.equal(only.id, DRAFT);
  assert.equal(only.status, 'sent');
  assert.equal(only.amount, 2750);
  assert.equal(out.body.invoice.id, DRAFT);
  assert.equal(world.emails.length, 1);
});

test('sending an invoice again with no issue date prints the date it was issued, not a dash', async () => {
  fresh({ invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01' })] });
  const out = await post({ ...DETAILS, issued_on: null, invoice_id: SENT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(world.rendered.length, 1);
  assert.equal(world.rendered[0].issuedOn, '2026-08-01', 'the document the client gets says when it was issued');
  assert.equal(world.tables.finance_invoices[0].issued_on, '2026-08-01', 'and the record says the same');
});

test('an overdue invoice sent again under a due date that has passed stays overdue; with a new one ahead, it is sent', async () => {
  const stored = () => invoiceRow(OVERDUE, 'overdue', { issued_on: '2020-01-01', due_on: '2020-01-31' });

  fresh({ invoices: [stored()] });
  const late = await post({ ...DETAILS, due_on: '2020-01-31', invoice_id: OVERDUE, send: true });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(world.tables.finance_invoices[0].status, 'overdue', 'a reminder does not make a late invoice current');
  assert.equal(late.body.invoice.status, 'overdue');

  fresh({ invoices: [stored()] });
  const extended = await post({ ...DETAILS, due_on: '2999-12-31', invoice_id: OVERDUE, send: true });
  assert.equal(extended.status, 200, JSON.stringify(extended.body));
  assert.equal(world.tables.finance_invoices[0].status, 'sent', 'given a new due date, it is not late');
});

test('a copy that fails to go out leaves an invoice the client already has exactly as it was', async () => {
  const stored = invoiceRow(SENT, 'sent', { issued_on: '2026-08-01' });
  fresh({ invoices: [stored], sendResult: { ok: false, error: 'Resend answered 500' } });
  const out = await post({ ...DETAILS, amount: 2750, invoice_id: SENT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.emailSent, false);
  assert.equal(out.body.emailError, 'Resend answered 500');
  assert.deepEqual(invoiceWrites(), [], 'nothing new reached the client, so nothing is written over what they have');
  assert.deepEqual(world.tables.finance_invoices, [stored]);
  assert.deepEqual(out.body.invoice, stored, 'the invoice comes back as it stands');
  assert.equal(world.tables.email_log.length, 1, 'the failed attempt is on record');
});

test('a draft that fails to go out again keeps the details it was retried with, and stays a draft', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')], sendResult: { ok: false, skipped: true } });
  const out = await post({ ...DETAILS, amount: 2750, invoice_id: DRAFT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.emailSent, false);
  assert.match(out.body.emailError, /RESEND_API_KEY/);
  assert.deepEqual(invoiceWrites(), ['update']);
  assert.equal(world.tables.finance_invoices.length, 1);
  assert.equal(world.tables.finance_invoices[0].status, 'draft');
  assert.equal(world.tables.finance_invoices[0].amount, 2750);
  assert.equal(world.tables.finance_invoices[0].issued_on, null, 'not issued until it goes out');
});

test('a preview that names an invoice renders the document and writes nothing', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')] });
  const out = await post({ ...DETAILS, invoice_id: DRAFT, send: false });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.preview, true);
  assert.equal(out.body.pdfBase64, 'JVBERg==');
  assert.equal(world.emails.length, 0);
  assert.deepEqual(world.writes, []);
});

test('a preview of an invoice sent again with no issue date shows the date it was issued, as its send does', async () => {
  fresh({ invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01' })] });
  const out = await post({ ...DETAILS, issued_on: null, invoice_id: SENT, send: false });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.preview, true);
  assert.equal(world.rendered.length, 1);
  assert.equal(world.rendered[0].issuedOn, '2026-08-01', 'the preview is the document the send would email');
  assert.equal(world.emails.length, 0);
  assert.deepEqual(world.writes, []);
});

test('a preview naming an invoice that no longer exists, or one already paid, is refused as its send would be', async () => {
  const cases = [
    ['gone', MISSING, [invoiceRow(DRAFT, 'draft')], 404, /no longer exists/],
    ['paid', PAID, [invoiceRow(PAID, 'paid', { issued_on: '2026-08-01', paid_on: '2026-09-10' })], 409, /#2026-014 is already paid/],
  ];
  for (const [label, id, invoices, status, message] of cases) {
    fresh({ invoices });
    const out = await post({ ...DETAILS, invoice_id: id, send: false });

    assert.equal(out.status, status, label);
    assert.match(out.body.error, message, label);
    assert.doesNotMatch(out.body.error, /nothing was sent|was not sent/, `${label}: a preview sends nothing, so it says nothing of a send`);
    nothingWentOut(label);
  }
});

/* ── What the invoice is for ──────────────────────────────────────────── */

test('a new invoice stores the company and the project it is for', async () => {
  fresh({ companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)] });
  const out = await post({ ...DETAILS, company_id: COMPANY, project_id: PROJECT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(invoiceWrites(), ['insert']);
  const [only] = world.tables.finance_invoices;
  assert.equal(only.company_id, COMPANY);
  assert.equal(only.project_id, PROJECT);
  assert.equal(out.body.invoice.company_id, COMPANY);
  assert.equal(out.body.invoice.project_id, PROJECT);
});

test('an invoice sent again stores the company and the project the request names', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')], companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)] });
  const out = await post({ ...DETAILS, company_id: COMPANY, project_id: PROJECT, invoice_id: DRAFT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(invoiceWrites(), ['update']);
  assert.equal(world.tables.finance_invoices[0].company_id, COMPANY);
  assert.equal(world.tables.finance_invoices[0].project_id, PROJECT);
});

test('an invoice sent again without them keeps the company and the project it has', async () => {
  fresh({
    invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01', company_id: COMPANY, project_id: PROJECT })],
    companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)],
  });
  const out = await post({ ...DETAILS, invoice_id: SENT, send: true });

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(invoiceWrites(), ['update']);
  assert.equal(world.tables.finance_invoices[0].company_id, COMPANY);
  assert.equal(world.tables.finance_invoices[0].project_id, PROJECT);
  assert.equal(out.body.invoice.company_id, COMPANY);
  assert.deepEqual(linkReads(), [], 'nothing named, nothing to look up');
});

test('an invoice whose project has since moved to another company is previewed and sent again under the links it already has', async () => {
  /* 0051 lets the invoice keep its company when its project moves, and lets
     both be written back as they stand (suite 16, LATER). */
  const world0 = () => fresh({
    companies: [companyRow(COMPANY), companyRow(OTHER_COMPANY)],
    projects: [projectRow(PROJECT, OTHER_COMPANY)],
    invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01', company_id: COMPANY, project_id: PROJECT })],
  });
  const links = { company_id: COMPANY, project_id: PROJECT, invoice_id: SENT };

  world0();
  const preview = await post({ ...DETAILS, ...links, send: false });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));

  world0();
  const sent = await post({ ...DETAILS, ...links, send: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(world.emails.length, 1);
  assert.deepEqual(invoiceWrites(), ['update']);
  assert.equal(world.tables.finance_invoices[0].company_id, COMPANY);
  assert.equal(world.tables.finance_invoices[0].project_id, PROJECT);
});

/* ── Refused before anything goes out ─────────────────────────────────── */

test('a paid invoice is refused before anything is rendered or emailed', async () => {
  fresh({ invoices: [invoiceRow(PAID, 'paid', { issued_on: '2026-08-01', paid_on: '2026-09-10' })] });
  const out = await post({ ...DETAILS, invoice_id: PAID, send: true });

  assert.equal(out.status, 409);
  assert.match(out.body.error, /already paid/);
  assert.equal(world.rendered.length, 0);
  assert.equal(world.emails.length, 0);
  assert.deepEqual(world.writes, []);
  assert.equal(world.tables.finance_invoices[0].status, 'paid');
});

test('an invoice_id that matches no invoice is refused before anything is emailed', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')] });
  const out = await post({ ...DETAILS, invoice_id: MISSING, send: true });

  assert.equal(out.status, 404);
  assert.equal(world.emails.length, 0);
  assert.deepEqual(world.writes, []);
});

test('an invoice_id that is not an id, or a row id under the wrong name, is refused', async () => {
  for (const body of [{ ...DETAILS, invoice_id: 'draft-1', send: true }, { ...DETAILS, id: DRAFT, send: true }]) {
    fresh({ invoices: [invoiceRow(DRAFT, 'draft')] });
    const out = await post(body);
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.equal(world.emails.length, 0);
    assert.deepEqual(world.writes, []);
  }
});

test('a due date before the issue date the request gives is refused before anything goes out', async () => {
  fresh();
  const out = await post({ ...DETAILS, issued_on: '2026-09-14', due_on: '2026-09-01', send: true });

  assert.equal(out.status, 400);
  assert.match(out.body.error, /due date cannot be before the issue date/);
  nothingWentOut('given dates');
});

test('a due date before the date an invoice was issued is refused, when sending it again names no issue date', async () => {
  fresh({ invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01' })] });
  const out = await post({ ...DETAILS, issued_on: null, due_on: '2026-07-15', invoice_id: SENT, send: true });

  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.match(out.body.error, /due date cannot be before the issue date/);
  nothingWentOut('stored issue date');
  assert.equal(world.tables.finance_invoices[0].due_on, '2026-10-14');
});

test('a preview with a due date before the date the invoice was issued is refused, as its send is', async () => {
  fresh({ invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01' })] });
  const out = await post({ ...DETAILS, issued_on: null, due_on: '2026-07-15', invoice_id: SENT, send: false });

  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.match(out.body.error, /due date cannot be before the issue date/);
  nothingWentOut('preview, stored issue date');
});

test('a company_id or project_id that is not an id is refused before anything is looked up', async () => {
  for (const bad of [{ company_id: 'Acme GmbH' }, { company_id: 42 }, { project_id: {} }, { project_id: PROJECT + ' ' }]) {
    fresh({ companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)] });
    const out = await post({ ...DETAILS, ...bad, send: true });

    assert.equal(out.status, 400, JSON.stringify(bad));
    assert.match(out.body.error, /not a valid (company|project) id/);
    assert.deepEqual(world.reads, [], JSON.stringify(bad));
    nothingWentOut(JSON.stringify(bad));
  }
});

test('a company or a project that is not in the workspace, or was deleted, is refused before anything is rendered or emailed', async () => {
  const deleted = '2026-09-01T10:00:00Z';
  const cases = [
    [{ company_id: GONE }, {}, /company is not in the CRM/],
    [{ company_id: COMPANY }, { companies: [companyRow(COMPANY, { deleted_at: deleted })] }, /company is not in the CRM/],
    [{ project_id: GONE }, {}, /project is not in the workspace/],
    [{ project_id: PROJECT }, { projects: [projectRow(PROJECT, COMPANY, { deleted_at: deleted })] }, /project is not in the workspace/],
  ];
  for (const send of [true, false]) {
    for (const [links, over, message] of cases) {
      fresh(Object.assign({ companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)] }, over));
      const out = await post({ ...DETAILS, ...links, send });
      const label = JSON.stringify({ ...links, send });

      assert.equal(out.status, 400, label);
      assert.match(out.body.error, message, label);
      nothingWentOut(label);
    }
  }
});

test('a project for another company is refused before anything is rendered or emailed', async () => {
  const both = { companies: [companyRow(COMPANY), companyRow(OTHER_COMPANY)], projects: [projectRow(PROJECT, COMPANY)] };
  const cases = [
    ['named together', {}, { company_id: OTHER_COMPANY, project_id: PROJECT }],
    ['a project for an invoice linked to another company',
      { invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01', company_id: OTHER_COMPANY })] },
      { project_id: PROJECT, invoice_id: SENT }],
    ['a company for an invoice under another company\'s project',
      { invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01', company_id: COMPANY, project_id: PROJECT })] },
      { company_id: OTHER_COMPANY, invoice_id: SENT }],
  ];
  for (const [label, over, links] of cases) {
    fresh(Object.assign({}, both, over));
    const stored = JSON.stringify(world.tables.finance_invoices);
    const out = await post({ ...DETAILS, ...links, send: true });

    assert.equal(out.status, 400, label);
    assert.match(out.body.error, /project belongs to a different company than the invoice/, label);
    nothingWentOut(label);
    assert.equal(JSON.stringify(world.tables.finance_invoices), stored, label);
  }
});

test("a preview naming another company for an invoice under a project is refused, as its send is", async () => {
  fresh({
    companies: [companyRow(COMPANY), companyRow(OTHER_COMPANY)], projects: [projectRow(PROJECT, COMPANY)],
    invoices: [invoiceRow(SENT, 'sent', { issued_on: '2026-08-01', company_id: COMPANY, project_id: PROJECT })],
  });
  const out = await post({ ...DETAILS, company_id: OTHER_COMPANY, invoice_id: SENT, send: false });

  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.match(out.body.error, /project belongs to a different company than the invoice/);
  nothingWentOut('preview, stored project');
});

test('an invoice deleted while its email goes out is not recreated, and the send is still logged', async () => {
  fresh({ invoices: [invoiceRow(DRAFT, 'draft')] });
  world.beforeUpdate = () => { world.tables.finance_invoices = []; };
  const out = await post({ ...DETAILS, invoice_id: DRAFT, send: true });

  assert.equal(out.status, 400);
  assert.match(out.body.error, /was emailed/, 'the error must not read as though nothing went out');
  assert.match(out.body.error, /deleted or marked paid/);
  assert.equal(world.tables.finance_invoices.length, 0);
  assert.equal(world.tables.email_log.length, 1, 'the email that went out is on record');
});

/* ── Who may call it ──────────────────────────────────────────────────── */

test('only a signed-in manager may call it, and nobody else gets anything rendered, emailed or written', async () => {
  const cases = [[{ user: null }, 401], [{ isManager: false }, 403], [{ roleError: 'permission denied' }, 403]];
  for (const [over, status] of cases) {
    fresh({ ...over, invoices: [invoiceRow(DRAFT, 'draft')] });
    const out = await post({ ...DETAILS, invoice_id: DRAFT, send: true });
    assert.equal(out.status, status, JSON.stringify(over));
    assert.equal(world.rendered.length, 0);
    assert.equal(world.emails.length, 0);
    assert.deepEqual(world.writes, []);
  }
});

test('nobody but a manager has a company or a project looked up', async () => {
  for (const [over, status] of [[{ user: null }, 401], [{ isManager: false }, 403]]) {
    fresh({ ...over, companies: [companyRow(COMPANY)], projects: [projectRow(PROJECT, COMPANY)] });
    const out = await post({ ...DETAILS, company_id: COMPANY, project_id: PROJECT, send: true });

    assert.equal(out.status, status, JSON.stringify(over));
    assert.deepEqual(world.reads, [], JSON.stringify(over));
  }
});
