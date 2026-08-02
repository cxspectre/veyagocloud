/* invoice-pdf — renders an invoice as a real PDF, and optionally creates the
   invoice and emails it to the client.

   Deploy:  supabase functions deploy invoice-pdf
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
    const issuedOn = body.issued_on ? String(body.issued_on) : null;
    const dueOn = body.due_on ? String(body.due_on) : null;
    const notes = body.notes ? String(body.notes).trim() : null;
    const send = body.send === true;

    if (!client) return json({ error: 'The client name is required.' }, 400);
    if (!number) return json({ error: 'The invoice number is required.' }, 400);
    if (!isFinite(amount) || amount <= 0) return json({ error: 'Enter a positive invoice amount.' }, 400);
    if (issuedOn && dueOn && dueOn < issuedOn) {
      return json({ error: 'The due date cannot be before the issue date.' }, 400);
    }
    /* Checked even on preview: the flow lets you preview before filling in an
       address, but reaching Send without one is a dead end worth catching
       before anything is created. */
    if (send && !clientEmail) return json({ error: 'A client email is required to send the invoice.' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

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

    /* The row is written AFTER the send, and its status records what actually
       happened rather than what was intended: a failed send leaves a draft the
       manager can retry, not a row claiming to have been sent. issued_on is
       stamped only on a real send, for the same reason. */
    const { data: created, error: insErr } = await admin
      .from('finance_invoices')
      .insert({
        number,
        client,
        client_email: clientEmail,
        amount,
        currency,
        issued_on: sent.ok ? (issuedOn ?? new Date().toISOString().slice(0, 10)) : issuedOn,
        due_on: dueOn,
        notes,
        status: sent.ok ? 'sent' : 'draft',
      })
      .select()
      .single();
    if (insErr) return json({ error: 'The invoice could not be saved: ' + insErr.message }, 400);

    await admin.from('email_log').insert({
      to_email: clientEmail,
      kind: 'invoice',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
    });

    return json({
      ok: true,
      invoice: created,
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
