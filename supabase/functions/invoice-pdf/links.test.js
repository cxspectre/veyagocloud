/* Tests for invoice-pdf/links.ts — the CRM company and the client project an
   invoice is for.

   finance_invoices carried only the client's name (0005), so an invoice could
   not be tied to a company or a project. 0051 adds company_id and project_id,
   and invoice-pdf takes both. What a request names is checked before anything
   is rendered or emailed: each must be an id, exist and not be deleted, and
   the project must not be another company's — the database refuses that pair
   too, but only when the invoice is saved, after its email has gone out. The
   database here is a stand-in holding crm_companies and client_projects in
   memory, logging every lookup. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let l;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'links.ts'), 'utf8');
  l = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const COMPANY = '9f4e8a5c-6d71-4293-aedf-4a5b6c7d8e9f';
const OTHER_COMPANY = 'a05f9b6d-7e82-43a4-bfe0-5b6c7d8e9fa0';
const PROJECT = 'b1609c7e-8f93-44b5-80f1-6c7d8e9fa0b1';
const LOOSE_PROJECT = 'd382be90-a1b5-46d7-a213-8e9fa0b1c2d3';
const MISSING = 'c271ad8f-90a4-45c6-9102-7d8e9fa0b1c2';
const DELETED_AT = '2026-09-01T10:00:00Z';

const NONE = { companyId: null, projectId: null };

/* crm_companies and client_projects in memory. Every lookup is logged as
   { table, columns, filters }; `failures[table]` makes that table's lookup
   return a database error instead. */
function fakeDb(over = {}, failures = {}) {
  const tables = Object.assign({
    crm_companies: [{ id: COMPANY, name: 'Acme GmbH', deleted_at: null },
                    { id: OTHER_COMPANY, name: 'Globex BV', deleted_at: null }],
    client_projects: [{ id: PROJECT, name: 'Acme · Website', company_id: COMPANY, deleted_at: null },
                      { id: LOOSE_PROJECT, name: 'Studio · Internal', company_id: null, deleted_at: null }],
  }, over);
  const calls = [];

  function from(table) {
    const filters = [];
    let columns = null;
    const b = {
      select: (cols) => { columns = cols.split(',').map((c) => c.trim()); return b; },
      eq: (col, val) => { filters.push([col, val]); return b; },
      maybeSingle: async () => {
        calls.push({ table, columns, filters: filters.slice() });
        if (failures[table]) return { data: null, error: { message: failures[table] } };
        const hit = (tables[table] || []).find((row) => filters.every(([c, v]) => row[c] === v));
        return { data: hit ? Object.fromEntries(columns.map((c) => [c, hit[c]])) : null, error: null };
      },
    };
    return b;
  }

  return { from, calls };
}

/* ── Reading them off a request ───────────────────────────────────────── */

test('a request that names no company or project links nothing', () => {
  for (const body of [{}, { company_id: null, project_id: null }, { company_id: '', project_id: '' }, null]) {
    assert.deepEqual(l.linksFrom(body), { companyId: null, projectId: null, error: null }, JSON.stringify(body));
  }
});

test('a company and a project are named by their ids', () => {
  assert.deepEqual(l.linksFrom({ company_id: COMPANY, project_id: PROJECT }),
    { companyId: COMPANY, projectId: PROJECT, error: null });
  assert.deepEqual(l.linksFrom({ project_id: PROJECT }), { companyId: null, projectId: PROJECT, error: null });
});

test('ids are read in lower case, as the database hands them back', () => {
  const out = l.linksFrom({ company_id: COMPANY.toUpperCase(), project_id: PROJECT.toUpperCase() });
  assert.equal(out.companyId, COMPANY);
  assert.equal(out.projectId, PROJECT);
});

test('anything but an id is refused, naming which of the two it is', () => {
  for (const bad of ['acme', 42, {}, [], true, COMPANY + ' ', 'Acme GmbH']) {
    const company = l.linksFrom({ company_id: bad });
    assert.equal(company.companyId, null, JSON.stringify(bad));
    assert.match(company.error, /not a valid company id/i, JSON.stringify(bad));

    const project = l.linksFrom({ company_id: COMPANY, project_id: bad });
    assert.equal(project.projectId, null, JSON.stringify(bad));
    assert.match(project.error, /not a valid project id/i, JSON.stringify(bad));
  }
});

/* ── Checking them ────────────────────────────────────────────────────── */

test('with nothing named, nothing is looked up, whatever the invoice already holds', async () => {
  for (const existing of [null, { company_id: COMPANY, project_id: PROJECT }]) {
    const db = fakeDb();
    assert.deepEqual(await l.checkLinks(db, NONE, existing), { status: 200, error: null });
    assert.deepEqual(db.calls, []);
  }
});

test('a company in the CRM, a project of that company, or both, may go on an invoice', async () => {
  for (const links of [
    { companyId: COMPANY, projectId: null },
    { companyId: null, projectId: PROJECT },
    { companyId: COMPANY, projectId: PROJECT },
  ]) {
    assert.deepEqual(await l.checkLinks(fakeDb(), links, null), { status: 200, error: null }, JSON.stringify(links));
  }
});

test('a company is looked up by its id, for whether it is deleted', async () => {
  const db = fakeDb();
  await l.checkLinks(db, { companyId: COMPANY, projectId: null }, null);
  assert.deepEqual(db.calls, [{ table: 'crm_companies', columns: ['id', 'deleted_at'], filters: [['id', COMPANY]] }]);
});

test('a company that is not in the CRM, or was deleted, is refused', async () => {
  const missing = await l.checkLinks(fakeDb(), { companyId: MISSING, projectId: null }, null);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /company is not in the CRM/);

  const deleted = fakeDb({ crm_companies: [{ id: COMPANY, name: 'Acme GmbH', deleted_at: DELETED_AT }] });
  const out = await l.checkLinks(deleted, { companyId: COMPANY, projectId: null }, null);
  assert.equal(out.status, 400);
  assert.match(out.error, /company is not in the CRM/);
});

test('a project that is not in the workspace, or was deleted, is refused', async () => {
  const missing = await l.checkLinks(fakeDb(), { companyId: null, projectId: MISSING }, null);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /project is not in the workspace/);

  const deleted = fakeDb({ client_projects: [{ id: PROJECT, company_id: COMPANY, deleted_at: DELETED_AT }] });
  const out = await l.checkLinks(deleted, { companyId: null, projectId: PROJECT }, null);
  assert.equal(out.status, 400);
  assert.match(out.error, /project is not in the workspace/);
});

test('a project for another company is refused when both are named', async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: OTHER_COMPANY, projectId: PROJECT }, null);
  assert.equal(out.status, 400);
  assert.match(out.error, /project belongs to a different company than the invoice/);
});

test('a project named for an invoice already linked to another company is refused', async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: null, projectId: PROJECT },
    { company_id: OTHER_COMPANY, project_id: null });
  assert.equal(out.status, 400);
  assert.match(out.error, /belongs to a different company/);
});

test("a company named for an invoice under another company's project is refused", async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: OTHER_COMPANY, projectId: null },
    { company_id: COMPANY, project_id: PROJECT });
  assert.equal(out.status, 400);
  assert.match(out.error, /belongs to a different company/);
});

test("a project named for an invoice with no company goes on it: the database takes the project's company", async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: null, projectId: PROJECT },
    { company_id: null, project_id: null });
  assert.deepEqual(out, { status: 200, error: null });
});

test('a project with no company goes with any company', async () => {
  assert.deepEqual(await l.checkLinks(fakeDb(), { companyId: OTHER_COMPANY, projectId: LOOSE_PROJECT }, null),
    { status: 200, error: null });
  assert.deepEqual(await l.checkLinks(fakeDb(), { companyId: OTHER_COMPANY, projectId: null },
    { company_id: null, project_id: LOOSE_PROJECT }), { status: 200, error: null });
});

test('a company named again beside the project it already goes with is fine', async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: COMPANY, projectId: null },
    { company_id: COMPANY, project_id: PROJECT });
  assert.deepEqual(out, { status: 200, error: null });
});

test('an invoice with no company, under a project, may not be given another company', async () => {
  const out = await l.checkLinks(fakeDb(), { companyId: OTHER_COMPANY, projectId: null },
    { company_id: null, project_id: PROJECT });
  assert.equal(out.status, 400);
  assert.match(out.error, /belongs to a different company/);
});

/* ── An invoice whose project has since moved ─────────────────────────── */

/* PROJECT has moved from COMPANY to OTHER_COMPANY since an invoice was filed
   under it, and the invoice kept COMPANY, as 0051 lets it. The database
   refuses a write only when the write is what makes the pair disagree. */
const THIRD_COMPANY = 'e493cfa1-b2c6-47e8-b324-9fa0b1c2d3e4';
const OTHER_PROJECT = 'f5a4d0b2-c3d7-48f9-8435-a0b1c2d3e4f5';
const APART = { company_id: COMPANY, project_id: PROJECT };

function movedDb() {
  return fakeDb({
    crm_companies: [{ id: COMPANY, name: 'Acme GmbH', deleted_at: null },
                    { id: OTHER_COMPANY, name: 'Globex BV', deleted_at: null },
                    { id: THIRD_COMPANY, name: 'Initech LLC', deleted_at: null }],
    client_projects: [{ id: PROJECT, name: 'Acme · Website', company_id: OTHER_COMPANY, deleted_at: null },
                      { id: OTHER_PROJECT, name: 'Globex · App', company_id: OTHER_COMPANY, deleted_at: null }],
  });
}

test('the links such an invoice already has may be named again', async () => {
  for (const links of [
    { companyId: COMPANY, projectId: PROJECT },
    { companyId: COMPANY, projectId: null },
    { companyId: null, projectId: PROJECT },
  ]) {
    assert.deepEqual(await l.checkLinks(movedDb(), links, APART), { status: 200, error: null }, JSON.stringify(links));
  }
});

test('such an invoice may be given another company, as the database lets it', async () => {
  for (const links of [
    { companyId: THIRD_COMPANY, projectId: null },
    { companyId: THIRD_COMPANY, projectId: PROJECT },
  ]) {
    assert.deepEqual(await l.checkLinks(movedDb(), links, APART), { status: 200, error: null }, JSON.stringify(links));
  }
});

test('but such an invoice filed under another project is held to that project\'s company', async () => {
  for (const links of [
    { companyId: null, projectId: OTHER_PROJECT },
    { companyId: THIRD_COMPANY, projectId: OTHER_PROJECT },
  ]) {
    const out = await l.checkLinks(movedDb(), links, APART);
    assert.equal(out.status, 400, JSON.stringify(links));
    assert.match(out.error, /belongs to a different company/, JSON.stringify(links));
  }
  assert.deepEqual(await l.checkLinks(movedDb(), { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT }, APART),
    { status: 200, error: null }, 'a project named with its own company is fine');
});

test('a new invoice is held to the company of its project, whatever other invoices were let keep', async () => {
  const out = await l.checkLinks(movedDb(), { companyId: COMPANY, projectId: PROJECT }, null);
  assert.equal(out.status, 400);
  assert.match(out.error, /belongs to a different company/);
});

test('a lookup that fails is reported as a failure, not as a missing company or project', async () => {
  const company = await l.checkLinks(fakeDb({}, { crm_companies: 'timeout' }), { companyId: COMPANY, projectId: null }, null);
  assert.equal(company.status, 500);
  assert.match(company.error, /company could not be checked: timeout/);

  const project = await l.checkLinks(fakeDb({}, { client_projects: 'timeout' }), { companyId: null, projectId: PROJECT }, null);
  assert.equal(project.status, 500);
  assert.match(project.error, /project could not be checked: timeout/);
});
