/* invoice-pdf — renders an invoice as a real PDF, and optionally creates the
   invoice and emails it to the client.

   Deploy:  supabase functions deploy invoice-pdf — once migration 0051 is
            live: the invoice lookup reads its company_id and project_id.
   Secrets: the bank details that appear on the document. Real account numbers,
            so they live here and never in a committed file:
              supabase secrets set BANK_NAME="Column N.A."
              supabase secrets set BANK_ADDRESS="1 Letterman Drive, Building A, Suite A4-700|San Francisco, CA 94129"
              supabase secrets set BANK_ROUTING=...
              supabase secrets set BANK_ACCOUNT=...
              supabase secrets set BANK_ACCOUNT_TYPE=Checking
            All optional — with none set the invoice still renders, minus the
            remittance block (see _shared/invoice-pdf.ts).

   Two modes, one function, because they must produce a byte-identical
   document: `send: false` is what the guided flow's Preview step shows, and
   `send: true` is what the client actually receives. Splitting them across two
   functions would let the preview drift from the thing that gets sent, which
   is the whole point of previewing.

   An invoice that already exists — a draft whose email failed, or a copy for a
   client who lost theirs — is sent again by naming it: `invoice_id` in the
   body, along with the details to send, as for a new one. That row is updated
   instead of a second invoice being created, and a paid invoice is refused
   before anything goes out. When the copy does not go out, a draft keeps the
   new details and an invoice the client already has is left as it was (see
   record.ts). Without invoice_id a new invoice is created, as before. A copy
   sent without an issue date carries the one the invoice already has. A
   preview that names an invoice is rendered and checked against that invoice
   the same way, and refused where its send would be, so it stays the document
   that goes out.

   What the invoice is for: `company_id` (a CRM company) and `project_id` (a
   client project), both optional. Each must be an id, exist and not be
   deleted, and the project must not be another company's, unless the invoice
   already names that pair as it stands — checked before anything is rendered
   or emailed, preview included (see links.ts). They are
   stored on the invoice created or sent again, and one sent again without them
   keeps its own. With neither, the database links the company the client's
   name belongs to (0051).

   Caller must be a manager — verified against their JWT, same as every other
   finance surface. */

import { createClient } from 'npm:@supabase/supabase-js@2';
/* NOT `npm:pdf-lib`. Deno's npm resolver cannot load it — its bundled tslib is
   CJS/UMD and PDFDocument.create() throws on import
   (github.com/Hopding/pdf-lib/issues/1752, open). esm.sh serves a real ESM
   build. Pinned to the same 1.17.1 the Node-side test runs against, so the
   shared layout module is exercised against the same library in both. */
import * as pdfLib from 'https://esm.sh/pdf-lib@1.17.1';
import { buildInvoicePdf } from '../_shared/invoice-pdf.ts';
import { invoiceEmail, sendEmail } from '../_shared/email.ts';
import { findInvoiceToSend, invoiceIdFrom, invoiceRecord, saveInvoice, shouldSave } from './record.ts';
import { checkLinks, linksFrom } from './links.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* Deno has no Buffer. btoa needs a binary string, and String.fromCharCode(...)
   spread over a whole PDF would blow the argument limit on a large document,
   so chunk it. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any);
  }
  return btoa(binary);
}

/* Public company facts — these are on the website's own legal page, so they
   are constants rather than secrets. The BANK block below is the opposite. */
const BUSINESS_BASE = {
  name: 'Veyago Inc.',
  addressLines: ['54 State Street, Ste 804 #17055', 'Albany, NY 12207, USA'],
  ein: '30-1492188',
  email: 'hello@veyago.cloud',
  website: 'veyago.cloud',
};

/* Read bank details from workspace_settings (DB), falling back to env
   secrets for backwards compatibility. DB wins when both are present. */
async function bankDetails(admin: ReturnType<typeof createClient>) {
  const KEYS = ['bank_routing', 'bank_account', 'bank_name', 'bank_address', 'bank_account_type'];
  const { data } = await admin
    .from('workspace_settings')
    .select('key,value')
    .in('key', KEYS);

  const kv: Record<string, string> = {};
  (data ?? []).forEach((r: { key: string; value: string | null }) => {
    if (r.value) kv[r.key] = r.value;
  });

  const routing = kv['bank_routing'] ?? Deno.env.get('BANK_ROUTING') ?? '';
  const account = kv['bank_account'] ?? Deno.env.get('BANK_ACCOUNT') ?? '';
  if (!routing || !account) return null;

  return {
    name: kv['bank_name'] ?? Deno.env.get('BANK_NAME') ?? 'Bank',
    addressLines: (kv['bank_address'] ?? Deno.env.get('BANK_ADDRESS') ?? '')
      .split('|').map((s) => s.trim()).filter(Boolean),
    routing,
    account,
    accountType: kv['bank_account_type'] ?? Deno.env.get('BANK_ACCOUNT_TYPE') ?? 'Checking',
  };
}

async function business(admin: ReturnType<typeof createClient>) {
  return { ...BUSINESS_BASE, bank: await bankDetails(admin) };
}

function money(n: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isManager, error: roleErr } = await asCaller.rpc('is_manager');
    if (roleErr || !isManager) return json({ error: 'Managers only' }, 403);

    const body = await req.json();
    const client = String(body.client ?? '').trim();
    const clientEmail = body.client_email ? String(body.client_email).trim() : null;
    const number = String(body.number ?? '').trim();
    const amount = Number(body.amount);
    const currency = String(body.currency ?? 'USD').trim() || 'USD';
    const issuedOnGiven = body.issued_on ? String(body.issued_on) : null;
    const dueOn = body.due_on ? String(body.due_on) : null;
    const notes = body.notes ? String(body.notes).trim() : null;
    const send = body.send === true;
    const target = invoiceIdFrom(body);
    const links = linksFrom(body);

    if (target.error) return json({ error: target.error }, 400);
    if (links.error) return json({ error: links.error }, 400);
    if (!client) return json({ error: 'The client name is required.' }, 400);
    if (!number) return json({ error: 'The invoice number is required.' }, 400);
    if (!isFinite(amount) || amount <= 0) return json({ error: 'Enter a positive invoice amount.' }, 400);
    /* Checked even on preview: the flow lets you preview before filling in an
       address, but reaching Send without one is a dead end worth catching
       before anything is created. */
    if (send && !clientEmail) return json({ error: 'A client email is required to send the invoice.' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* The invoice a request names: found before anything is rendered or
       emailed, so an id that matches nothing, or an invoice already paid, is
       refused with nothing having gone out. A preview looks as well — looking
       only reads — because it must be the document the send would email: the
       same issue date, and the same checks against what the invoice holds. */
    const found = target.id ? await findInvoiceToSend(admin, target.id, send) : null;
    if (found?.error) return json({ error: found.error }, found.status);
    const existing = found?.invoice ?? null;

    /* One issue date for the document, the record and the check below: the
       request's, else the one the invoice being sent again already has. A copy
       sent without a date used to print "Issued —" while its record kept the
       stored date, and a due date before that stored date got through. */
    const issuedOn = issuedOnGiven ?? existing?.issued_on ?? null;
    if (issuedOn && dueOn && dueOn < issuedOn) {
      return json({ error: 'The due date cannot be before the issue date.' }, 400);
    }

    /* The company and project named, against what the invoice will hold. The
       database refuses a project for another company too, but only when the
       invoice is saved — after its email has gone out. */
    const linked = await checkLinks(admin, links, existing);
    if (linked.error) return json({ error: linked.error }, linked.status);

    const invoice = { number, client, clientEmail, amount, currency, issuedOn, dueOn, notes };
    const pdf = await buildInvoicePdf(pdfLib, invoice, await business(admin));

    if (!send) {
      /* Base64 in JSON rather than raw bytes: the browser reaches this through
         supabase-js functions.invoke, which parses JSON. The client turns it
         back into a Blob for the preview frame. */
      return json({ ok: true, preview: true, pdfBase64: toBase64(pdf), filename: `invoice-${number}.pdf` });
    }

    const tpl = invoiceEmail({
      clientName: client,
      number,
      amountFormatted: money(amount, currency),
      dueOn,
    });
    const sent = await sendEmail({
      to: clientEmail!,
      ...tpl,
      attachments: [{ filename: `invoice-${number}.pdf`, content: toBase64(pdf) }],
    });

    /* Logged before the invoice is saved, so the record of what reached the
       client does not hang on the save succeeding. */
    await admin.from('email_log').insert({
      to_email: clientEmail,
      kind: 'invoice',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
    });

    /* The row is written AFTER the send, and its status records what actually
       happened rather than what was intended: a failed send leaves a draft the
       manager can retry, not a row claiming to have been sent. issued_on is
       stamped only on a real send, for the same reason. An invoice sent again
       is updated where it stands and never moves backwards, and one the client
       already has is not written over by a copy that did not go out
       (record.ts). */
    const today = new Date().toISOString().slice(0, 10);
    const record = invoiceRecord(
      { ...invoice, companyId: links.companyId, projectId: links.projectId },
      sent.ok,
      existing,
      today,
    );
    const saved = shouldSave(existing, sent.ok)
      ? await saveInvoice(admin, existing, record)
      : { invoice: existing, error: null };
    if (saved.error) {
      const said = sent.ok ? 'The invoice was emailed, but could not be saved: ' : 'The invoice could not be saved: ';
      return json({ error: said + saved.error }, 400);
    }

    return json({
      ok: true,
      invoice: saved.invoice,
      emailSent: sent.ok,
      emailError: sent.ok ? null : (sent.skipped
        ? 'Email is not configured yet (RESEND_API_KEY is not set), so nothing was delivered.'
        : sent.error),
    });
  } catch (err) {
    console.error('invoice-pdf error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
