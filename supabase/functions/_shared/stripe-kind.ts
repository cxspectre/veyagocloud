/* stripe-kind.ts — what a Stripe balance transaction is to the figures
 * (finance_transactions.kind, 0041), and the rows sync-stripe stores for it.
 *
 * A balance transaction's amount is gross: a charge of 100 with a fee of 3
 * reaches the bank as 97. Only the gross was stored, so Stripe's fees were never
 * an expense; and a payout — Stripe moving the balance to the bank — was a
 * negative amount like any spending, while its deposit in the bank counted as
 * income beside the very charges it paid out. Each row now says what it is, and
 * a charge's fee is a row of its own. What counts where is decided in the
 * database (finance_figures, 0041), not here.
 *
 * Kept free of imports so stripe-kind.test.js runs it in node.
 */

export type Kind = 'income' | 'refund' | 'fee' | 'expense' | 'payout' | 'transfer' | 'adjustment';

/* By Stripe's type first — it names payout_cancel and payout_failure, which
   reverse a payout and so are payouts too. A bank debit that failed
   (payment_reversal) takes its income back; a Climate contribution or an
   Issuing card payment is spending, and money back from either lowers it. */
const BY_TYPE: Record<string, Kind> = {
  charge: 'income',
  payment: 'income',
  refund: 'refund',
  refund_failure: 'refund',
  payment_refund: 'refund',
  payment_failure_refund: 'refund',
  payment_reversal: 'refund',
  stripe_fee: 'fee',
  stripe_fx_fee: 'fee',
  tax_fee: 'fee',
  contribution: 'expense',
  climate_order_purchase: 'expense',
  climate_order_refund: 'expense',
  issuing_transaction: 'expense',
  issuing_dispute: 'expense',
  payout: 'payout',
  payout_cancel: 'payout',
  payout_failure: 'payout',
  transfer: 'transfer',
  transfer_cancel: 'transfer',
  transfer_failure: 'transfer',
  transfer_refund: 'transfer',
  topup: 'transfer',
  topup_reversal: 'transfer',
};

/* Then by its reporting category, which also sorts what a plain "adjustment"
   was: a dispute takes money back from us as a refund would. */
const BY_CATEGORY: Record<string, Kind> = {
  charge: 'income',
  platform_earning: 'income',
  refund: 'refund',
  refund_failure: 'refund',
  partial_capture_reversal: 'refund',
  charge_failure: 'refund',
  dispute: 'refund',
  dispute_reversal: 'refund',
  platform_earning_refund: 'refund',
  fee: 'fee',
  network_cost: 'fee',
  tax: 'fee',
  contribution: 'expense',
  climate_order_purchase: 'expense',
  climate_order_refund: 'expense',
  issuing_transaction: 'expense',
  issuing_dispute: 'expense',
  payout: 'payout',
  payout_reversal: 'payout',
  transfer: 'transfer',
  transfer_reversal: 'transfer',
  topup: 'transfer',
  topup_reversal: 'transfer',
};

export type BalanceTransaction = {
  id: string;
  /* Minor units, signed. */
  amount: number;
  /* Minor units: what Stripe kept of it. */
  fee?: number | null;
  currency?: string | null;
  /* Seconds since the epoch. */
  created: number;
  description?: string | null;
  reporting_category?: string | null;
  type?: string | null;
  status?: string | null;
};

export type TransactionRow = {
  account_id: string;
  external_id: string;
  posted_at: string;
  description: string;
  counterparty: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'posted';
  source: 'stripe';
  kind: Kind;
};

/* Anything Stripe adds later is an adjustment — counted as neither revenue nor
   expense — rather than guessed from its sign. */
export function stripeKind(t: Pick<BalanceTransaction, 'type' | 'reporting_category'>): Kind {
  const type = String(t?.type ?? '').toLowerCase();
  const category = String(t?.reporting_category ?? '').toLowerCase();
  /* Own keys only: "constructor" or "__proto__" is no kind, and a value that
     is not one would fail the check constraint for the whole page of rows. */
  if (Object.hasOwn(BY_TYPE, type)) return BY_TYPE[type];
  if (Object.hasOwn(BY_CATEGORY, category)) return BY_CATEGORY[category];
  return 'adjustment';
}

/* Stripe's amounts are in a currency's smallest unit: a hundredth for most,
   the whole unit for a zero-decimal currency such as JPY, and a thousandth for
   a three-decimal one such as KWD. They are stored in whole units, and
   finance_transactions.amount keeps two decimals (0005): a thousandth of a
   dinar is rounded there. The Ugandan shilling and the Icelandic króna have no
   minor unit any more, but Stripe still writes them in hundredths that always
   end in 00, and pays out forints and Taiwan dollars in whole units written in
   hundredths too (docs.stripe.com/currencies, "Special cases") — so none of
   them is zero-decimal here, whatever Stripe's own zero-decimal list says of
   UGX: its Special cases section is what the API does. */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

export function fromMinorUnits(amount: number, currency: string): number {
  const code = String(currency ?? '').toUpperCase();
  const unit = ZERO_DECIMAL.has(code) ? 1 : THREE_DECIMAL.has(code) ? 1000 : 100;
  return Number(amount) / unit;
}

/* The rows for one balance transaction: itself, and what Stripe kept of it as
   a fee row of its own — each under an id of its own, so a sync run again
   updates them rather than adding more. A fee that was given back is a fee row
   with a positive amount, and nets out. */
export function stripeRows(t: BalanceTransaction, accountId: string, fallbackCurrency: string): TransactionRow[] {
  const description = t.description || t.reporting_category || t.type || 'Stripe transaction';
  const currency = String(t.currency || fallbackCurrency || 'usd').toUpperCase();
  const row: TransactionRow = {
    account_id: accountId,
    external_id: t.id,
    posted_at: new Date(t.created * 1000).toISOString().slice(0, 10),
    description,
    counterparty: null,
    amount: fromMinorUnits(t.amount, currency),
    currency,
    /* As Stripe has it: pending until the money is available. The figures
       never count a charge, pending or not: a card payment counts once, as
       its payout reaching the bank, and a payout still pending counts as
       neither (finance_figures, 0041). */
    status: t.status === 'pending' ? 'pending' : 'posted',
    source: 'stripe',
    kind: stripeKind(t),
  };
  const fee = Number(t.fee ?? 0);
  if (!fee || row.kind === 'fee') return [row];
  return [row, { ...row, external_id: `${t.id}:fee`, description: `Stripe fee: ${description}`, amount: -fromMinorUnits(fee, currency), kind: 'fee' }];
}
