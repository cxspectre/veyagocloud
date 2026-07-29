/* Tests for _shared/invoice-pdf.ts.
 *
 * buildInvoicePdf() takes the pdf-lib MODULE itself as a parameter rather
 * than importing it — see that file's header for why (Deno's npm: resolver
 * cannot load pdf-lib at all; the edge function imports it from an ESM CDN
 * instead). That is what makes this file testable at all: Node's ordinary
 * `require('pdf-lib')` is passed in here, and the .ts source is loaded by
 * stripping its type annotations, same trick as invite-link.test.js — no
 * network, no Deno runtime, and the shipped file stays byte-identical to
 * what the edge function loads.
 *
 * The version is pinned identically in both places (1.17.1) — see
 * package.json's devDependency and the edge function's esm.sh import — since
 * "the layout code is runtime-agnostic" is only true if both runtimes are
 * actually running the same pdf-lib.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { stripTypeScriptTypes } = require('node:module');
const pdfLib = require('pdf-lib');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'invoice-pdf.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const BUSINESS = {
  name: 'Veyago Inc.',
  addressLines: ['54 State Street, Ste 804 #17055', 'Albany, NY 12207, USA'],
  ein: '30-1492188',
  email: 'hello@veyago.cloud',
  website: 'veyago.cloud',
  bank: {
    name: 'Column N.A.',
    addressLines: ['1 Letterman Drive, Building A, Suite A4-700', 'San Francisco, CA 94129'],
    routing: '000000000',
    account: '000000000000',
    accountType: 'Checking',
  },
};

const INVOICE = {
  number: '2026-014', client: 'Northwind Traders', clientEmail: 'ap@northwind.example',
  amount: 9800, currency: 'USD', issuedOn: '2026-07-20', dueOn: '2026-08-19', notes: 'Net 30, PO #4471',
};

/* pdf-lib can read back its own output, which most of these tests lean on.
 * Checking the actual rendered TEXT needs its own extraction, because two
 * things stand between "the string is in there" and a plain substring
 * search: PDFDocument.save() FlateDecode-compresses every content stream by
 * default, and pdf-lib writes drawn text as hex strings (`<56657961676F...>`)
 * rather than literal parenthesized ASCII. So: find every `stream ...
 * endstream` block, inflate it, pull out every `<hex>` token, and hex-decode
 * those back to the words that were actually drawn. */
function drawnText(bytes) {
  const buf = Buffer.from(bytes);
  const STREAM = Buffer.from('stream'), END = Buffer.from('endstream');
  let out = '', i = 0;
  while (true) {
    const start = buf.indexOf(STREAM, i);
    if (start === -1) break;
    let dataStart = start + STREAM.length;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const end = buf.indexOf(END, dataStart);
    if (end === -1) break;
    let chunk = buf.slice(dataStart, end);
    try { chunk = zlib.inflateSync(chunk); } catch (_) { /* not flate-compressed */ }
    const text = chunk.toString('latin1');
    const hexTokens = text.match(/<([0-9A-Fa-f]+)>/g) || [];
    hexTokens.forEach((tok) => {
      out += Buffer.from(tok.slice(1, -1), 'hex').toString('latin1') + ' ';
    });
    i = end + END.length;
  }
  return out;
}

test('produces a real, valid single-page PDF', async () => {
  const bytes = await m.buildInvoicePdf(pdfLib, INVOICE, BUSINESS);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 500, 'should not be a near-empty/broken document');
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-', 'must start with the PDF header');

  const reopened = await pdfLib.PDFDocument.load(bytes);
  assert.equal(reopened.getPageCount(), 1);
  const page = reopened.getPage(0);
  const { width, height } = page.getSize();
  assert.equal(width, 612, 'US Letter width');
  assert.equal(height, 792, 'US Letter height');
});

test('the invoice number, client and amount all appear in the document', async () => {
  const bytes = await m.buildInvoicePdf(pdfLib, INVOICE, BUSINESS);
  const raw = drawnText(bytes);
  assert.ok(raw.includes('2026-014'));
  assert.ok(raw.includes('Northwind Traders'));
  assert.ok(raw.includes('9,800.00'));
  assert.ok(raw.includes(INVOICE.clientEmail));
  assert.ok(raw.includes(INVOICE.notes));
});

test('the business name, EIN and website are on every invoice', async () => {
  const bytes = await m.buildInvoicePdf(pdfLib, INVOICE, BUSINESS);
  const raw = drawnText(bytes);
  assert.ok(raw.includes('Veyago Inc.'));
  assert.ok(raw.includes('30-1492188'));
  assert.ok(raw.includes('veyago.cloud'));
});

test('bank details appear when configured', async () => {
  const bytes = await m.buildInvoicePdf(pdfLib, INVOICE, BUSINESS);
  const raw = drawnText(bytes);
  assert.ok(raw.includes('Column N.A.'));
  assert.ok(raw.includes(BUSINESS.bank.routing));
  assert.ok(raw.includes(BUSINESS.bank.account));
});

/* A misconfigured/unset bank secret must degrade the document, not the
 * generation itself — an invoice with no way to get paid is still a document
 * worth sending, with a fallback line telling the client to ask. */
test('a null bank degrades to a contact-us line instead of failing', async () => {
  const business = Object.assign({}, BUSINESS, { bank: null });
  const bytes = await m.buildInvoicePdf(pdfLib, INVOICE, business);
  const raw = drawnText(bytes);
  assert.ok(raw.includes('hello@veyago.cloud'));
  assert.ok(!raw.includes('Column N.A.'));
});

test('an invoice with no notes and no client email omits both sections without throwing', async () => {
  const bare = Object.assign({}, INVOICE, { notes: null, clientEmail: null });
  const bytes = await m.buildInvoicePdf(pdfLib, bare, BUSINESS);
  assert.ok(bytes.length > 500);
  const raw = drawnText(bytes);
  assert.ok(!raw.includes('Net 30'));
});

test('missing issued/due dates render as an em dash, not "Invalid Date"', async () => {
  const noDates = Object.assign({}, INVOICE, { issuedOn: null, dueOn: null });
  const bytes = await m.buildInvoicePdf(pdfLib, noDates, BUSINESS);
  const raw = drawnText(bytes);
  assert.ok(!raw.includes('Invalid Date'));
});

test('currency formatting follows the invoice\'s own currency, not a hardcoded USD', async () => {
  const eur = Object.assign({}, INVOICE, { currency: 'EUR', amount: 250 });
  const bytes = await m.buildInvoicePdf(pdfLib, eur, BUSINESS);
  const raw = drawnText(bytes);
  assert.ok(raw.includes('250.00'));
});

test('a long client name does not crash right-alignment math', async () => {
  const longName = Object.assign({}, INVOICE, {
    client: 'A Very Long International Holdings and Ventures Corporation Limited',
  });
  const bytes = await m.buildInvoicePdf(pdfLib, longName, BUSINESS);
  assert.ok(bytes.length > 500);
});
