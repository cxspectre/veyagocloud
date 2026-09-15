/* Where invoice-pdf writes down an invoice it has sent.
 *
 * It used to insert a row on every send, so sending an invoice again — a draft
 * whose first email failed, or a copy for a client who lost theirs — added a
 * second invoice with the same number, and both were counted as owed. A send
 * now names the invoice it is for as `invoice_id`, and that row is updated.
 * With no invoice_id a new invoice is created, exactly as before.
 *
 * A copy that does not go out is written down only as a draft: an invoice the
 * client already has stays exactly as they have it (see shouldSave).
 *
 * The record also says what the invoice is for: the company and the project a
 * request names (0051, checked in links.ts). A request that names neither
 * writes neither, so an invoice sent again keeps its own.
 *
 * No imports, on purpose: record.test.js loads this file in Node on its own,
 * the same way the _shared modules are tested.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* What index.ts renders the document from, and the links it is saved with. */
export interface InvoiceFields {
  number: string;
  client: string;
  clientEmail: string | null;
  amount: number;
  currency: string;
  issuedOn: string | null;
  dueOn: string | null;
  notes: string | null;
  companyId?: string | null;
  projectId?: string | null;
}

/* A stored invoice, whole, as the lookup reads it — so one a send leaves alone
   can be handed back as it stands. These fields decide how it may be sent. */
export interface StoredInvoice {
  id: string;
  number: string;
  status: string;
  issued_on: string | null;
  company_id: string | null;
  project_id: string | null;
  [column: string]: unknown;
}

const INVOICE_COLUMNS =
  'id,number,client,client_email,amount,currency,status,issued_on,due_on,paid_on,notes,company_id,project_id,created_at';

type Db = { from: (table: string) => any };

/* The invoice a request is about, if any.

   `id` on its own is refused rather than ignored: a caller that posts a row
   back with its id — the most natural mistake to make — would otherwise
   quietly create a second invoice, which is the duplicate this exists to
   stop. */
export function invoiceIdFrom(body: unknown): { id: string | null; error: string | null } {
  const fields: Record<string, unknown> = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  const named = fields.invoice_id;
  const rowId = fields.id;

  if (!given(named)) {
    return given(rowId)
      ? { id: null, error: 'Name the invoice to send again as invoice_id, not id.' }
      : { id: null, error: null };
  }
  if (typeof named !== 'string' || !UUID.test(named)) {
    return { id: null, error: 'That is not a valid invoice id.' };
  }
  if (given(rowId) && String(rowId).toLowerCase() !== named.toLowerCase()) {
    return { id: null, error: 'id and invoice_id name different invoices. Send invoice_id only.' };
  }
  return { id: named, error: null };
}

/* The invoice being sent again, or why it may not be. index.ts asks before
   anything is rendered or emailed, for a preview too: an id that matches
   nothing, or an invoice already paid, must not reach the client, and a
   preview of either would show a document that is never sent. A draft, a sent
   and an overdue invoice can all go out again. `sending` is false for a
   preview, which is refused in words that say nothing of a send. */
export async function findInvoiceToSend(
  db: Db,
  id: string,
  sending = true,
): Promise<{ invoice: StoredInvoice | null; status: number; error: string | null }> {
  const { data, error } = await db
    .from('finance_invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { invoice: null, status: 500, error: 'The invoice could not be loaded: ' + error.message };
  if (!data) {
    const gone = sending ? 'That invoice no longer exists, so nothing was sent.' : 'That invoice no longer exists.';
    return { invoice: null, status: 404, error: gone };
  }
  if (data.status === 'paid') {
    const so = sending ? 'so it was not sent again' : 'so it cannot be sent again';
    return { invoice: null, status: 409, error: `Invoice #${data.number} is already paid, ${so}.` };
  }
  return { invoice: data, status: 200, error: null };
}

/* Whether a send is written down at all.

   One that went out always is. One that did not is written only as a draft: a
   new invoice becomes a draft to retry, and a draft keeps the details it was
   retried with. An invoice the client already has — sent or overdue — is left
   exactly as they have it. Nothing new reached them, and writing the retried
   details over it would record a document nobody received. */
export function shouldSave(existing: StoredInvoice | null, sentOk: boolean): boolean {
  return sentOk || !existing || existing.status === 'draft';
}

/* The row to write for a send, whether the invoice is new or not.

   What is on the document comes from the request, since that is what was
   rendered and emailed. The two fields that record the invoice's life only
   ever move forward:
     - status: 'sent' once the email went out — but an overdue invoice stays
       overdue unless it went out with a due date of today or later: a copy of
       a late invoice is still late. When the email did not go out, a new
       invoice is a draft the manager can retry, and an existing one keeps the
       status it had — which, past shouldSave, is only ever a draft's.
     - issued_on: the date on the request, else the one already stored, else
       today once it has actually gone out.
   company_id and project_id are written when the request names them, and left
   out when it does not: an invoice sent again keeps its own, and the database
   links a new one by its client's name (0051).
   id, paid_on and created_at are never written. */
export function invoiceRecord(
  invoice: InvoiceFields,
  sentOk: boolean,
  existing: StoredInvoice | null,
  today: string,
) {
  const issuedOn = invoice.issuedOn ?? existing?.issued_on ?? null;
  const stillOverdue = existing?.status === 'overdue' && (!invoice.dueOn || invoice.dueOn < today);
  return {
    number: invoice.number,
    client: invoice.client,
    client_email: invoice.clientEmail,
    amount: invoice.amount,
    currency: invoice.currency,
    issued_on: sentOk ? (issuedOn ?? today) : issuedOn,
    due_on: invoice.dueOn,
    notes: invoice.notes,
    status: sentOk ? (stillOverdue ? 'overdue' : 'sent') : (existing?.status ?? 'draft'),
    ...(invoice.companyId ? { company_id: invoice.companyId } : {}),
    ...(invoice.projectId ? { project_id: invoice.projectId } : {}),
  };
}

/* Writes the record: an update of the invoice being sent again, or a new row.

   The update also requires the invoice not to be paid, so one marked paid
   while its email was going out keeps its payment. Then — as when it was
   deleted meanwhile — the update finds no row, and that is reported rather
   than the invoice being recreated. */
export async function saveInvoice(
  db: Db,
  existing: StoredInvoice | null,
  record: Record<string, unknown>,
): Promise<{ invoice: Record<string, unknown> | null; error: string | null }> {
  const write = existing
    ? db.from('finance_invoices').update(record).eq('id', existing.id).neq('status', 'paid')
    : db.from('finance_invoices').insert(record);
  const { data, error } = await write.select().single();
  if (!error) return { invoice: data, error: null };
  if (existing && error.code === 'PGRST116') {
    return { invoice: null, error: 'it was deleted or marked paid while it was being sent.' };
  }
  return { invoice: null, error: error.message };
}
