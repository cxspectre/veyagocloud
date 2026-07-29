/* The invoice PDF itself — letterhead, bill-to, one line item, total, and
 * bank remittance details, drawn with pdf-lib's coordinate API (US Letter,
 * origin bottom-left).
 *
 * DELIBERATELY TAKES pdf-lib AS A PARAMETER RATHER THAN IMPORTING IT.
 * `npm:pdf-lib` throws immediately in Deno — its bundled tslib is CJS/UMD,
 * not valid ESM, and Deno's npm: resolver cannot destructure it
 * (github.com/Hopding/pdf-lib/issues/1752, open, unfixed). The edge function
 * imports the library from an ESM CDN instead (`https://esm.sh/pdf-lib@1.17.1`),
 * which Node cannot import directly with a bare specifier. Rather than fork
 * this file per runtime, or duplicate the import boilerplate, the caller
 * creates the PDFDocument and embeds the fonts — using WHICHEVER copy of
 * pdf-lib its runtime can actually load — and hands the resulting objects in.
 * Everything below is then plain pdf-lib API calls, identical in both
 * runtimes as long as the version matches (pinned at 1.17.1 in both places;
 * see invoice-pdf.test.js and the edge function's import line).
 *
 * Business and bank details are parameters too, not constants in this file —
 * the bank routing/account numbers are real and live in Supabase secrets,
 * never in a committed file. `bank` is nullable: if the secrets are not set,
 * the invoice still generates, just without a remittance section, so a
 * misconfigured secret degrades the document rather than blocking it.
 */

const PAGE_W = 612, PAGE_H = 792; // US Letter, points
const MARGIN = 54;

export type Business = {
  name: string;
  addressLines: string[];
  ein: string;
  email: string;
  website: string;
  bank: {
    name: string;
    addressLines: string[];
    routing: string;
    account: string;
    accountType: string;
  } | null;
};

export type InvoiceInput = {
  number: string;
  client: string;
  clientEmail?: string | null;
  amount: number;
  currency: string;
  issuedOn?: string | null; // YYYY-MM-DD
  dueOn?: string | null;
  notes?: string | null;
};

function money(n: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
}

/* YYYY-MM-DD -> "Jul 28, 2026". Falls back to the raw string for anything
 * that doesn't parse as a plain date, rather than showing "Invalid Date". */
function humanDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function buildInvoicePdf(
  pdfLib: any,
  invoice: InvoiceInput,
  business: Business,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.11, 0.11, 0.12);     // ~ #1d1d1f, this system's --ink
  const muted = rgb(0.43, 0.43, 0.45);   // ~ #6e6e73, this system's admin --muted-2
  const hair = rgb(0.82, 0.82, 0.84);    // ~ #d2d2d7, this system's --hair

  function text(s: string, x: number, y: number, opts: { font?: any; size?: number; color?: any; align?: 'left' | 'right' | 'center' } = {}) {
    const font = opts.font || regular;
    const size = opts.size || 9;
    const color = opts.color || ink;
    let drawX = x;
    if (opts.align === 'right') drawX = x - font.widthOfTextAtSize(s, size);
    else if (opts.align === 'center') drawX = x - font.widthOfTextAtSize(s, size) / 2;
    page.drawText(s, { x: drawX, y, size, font, color });
  }

  function hLine(y: number) {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: hair });
  }

  const rightX = PAGE_W - MARGIN;
  let y = PAGE_H - MARGIN;

  /* ── Letterhead: business on the left, invoice meta on the right ─────── */
  text(business.name, MARGIN, y, { font: bold, size: 15 });
  text('INVOICE', rightX, y, { font: bold, size: 18, align: 'right' });
  y -= 16;

  const leftLines = business.addressLines.concat([
    'EIN ' + business.ein,
    business.email + '  ·  ' + business.website,
  ]);
  const rightLines = [
    '#' + invoice.number,
    'Issued ' + humanDate(invoice.issuedOn),
    'Due ' + humanDate(invoice.dueOn),
  ];
  const metaRows = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < metaRows; i++) {
    if (leftLines[i]) text(leftLines[i], MARGIN, y, { size: 9, color: muted });
    if (rightLines[i]) text(rightLines[i], rightX, y, { size: 10, align: 'right', color: i === 0 ? ink : muted });
    y -= 13;
  }

  y -= 18;
  hLine(y);
  y -= 26;

  /* ── Bill to ──────────────────────────────────────────────────────── */
  text('BILL TO', MARGIN, y, { font: bold, size: 8, color: muted });
  y -= 15;
  text(invoice.client, MARGIN, y, { font: bold, size: 12 });
  y -= 14;
  if (invoice.clientEmail) { text(invoice.clientEmail, MARGIN, y, { size: 9, color: muted }); y -= 14; }

  y -= 20;

  /* ── Line item ────────────────────────────────────────────────────── */
  text('DESCRIPTION', MARGIN, y, { font: bold, size: 8, color: muted });
  text('AMOUNT', rightX, y, { font: bold, size: 8, color: muted, align: 'right' });
  y -= 10;
  hLine(y);
  y -= 20;

  text('Professional services', MARGIN, y, { size: 10 });
  text(money(invoice.amount, invoice.currency), rightX, y, { size: 10, align: 'right' });
  y -= 18;
  hLine(y);
  y -= 24;

  text('TOTAL', MARGIN, y, { font: bold, size: 11 });
  text(money(invoice.amount, invoice.currency), rightX, y, { font: bold, size: 14, align: 'right' });
  y -= 40;

  /* ── Notes ────────────────────────────────────────────────────────── */
  if (invoice.notes) {
    text('NOTES', MARGIN, y, { font: bold, size: 8, color: muted });
    y -= 14;
    text(invoice.notes, MARGIN, y, { size: 9, color: muted });
    y -= 30;
  }

  /* ── Payment instructions ─────────────────────────────────────────── */
  text('PAYMENT', MARGIN, y, { font: bold, size: 8, color: muted });
  y -= 15;
  if (business.bank) {
    const b = business.bank;
    const lines = [b.name].concat(b.addressLines, [
      'Routing ' + b.routing + '   ·   Account ' + b.account + '   ·   ' + b.accountType,
    ]);
    lines.forEach((line) => { text(line, MARGIN, y, { size: 9 }); y -= 13; });
  } else {
    text('Contact ' + business.email + ' for payment instructions.', MARGIN, y, { size: 9, color: muted });
    y -= 13;
  }

  /* ── Footer ───────────────────────────────────────────────────────── */
  hLine(60);
  text(business.name + '  ·  ' + business.email + '  ·  ' + business.website, PAGE_W / 2, 42,
    { size: 8, color: muted, align: 'center' });

  return doc.save();
}
