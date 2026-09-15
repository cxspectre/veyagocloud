/* What one Mercury transaction is to the figures: finance_transactions.kind
 * (0041), which the finance_figures view reads to decide whether it counts as
 * revenue, as an expense, or as neither.
 *
 * Revenue used to be every positive transaction. A Stripe payout landing in
 * Mercury counted as income beside the Stripe charges it paid out, a move to
 * savings counted as spending on one side and income on the other, and a
 * refund to a card counted as income. Mercury names each transaction's kind
 * (docs.mercury.com); this says what that kind is:
 *
 *   - money moved between the studio's own accounts, or to and from its
 *     treasury, is a transfer;
 *   - a card payment, a payment sent, a reimbursement or a returned currency
 *     payment is spending whichever way it went, so one coming back lowers
 *     what was spent rather than counting as income;
 *   - a fee is a fee, and so is a fee given back; a deposited check is income;
 *     interest is interest;
 *   - money someone else moved (an ACH transfer, a wire, a drawdown, 'other',
 *     or a kind Mercury adds later or leaves out) is a payout when Stripe moved
 *     it, and otherwise income coming in and spending going out.
 *
 * Stripe moved it when the counterparty's name, or the nickname the studio
 * gave it in Mercury, is Stripe's own ("Stripe", "Stripe, Inc.", "Stripe
 * Payments …"), or when the bank's description starts with the word STRIPE.
 * Nothing looser: studios have clients called Pinstripe, Blue Stripes or
 * Stripes & Co, and a client's income taken for a payout drops out of revenue
 * while Stripe is synced. A card payment to a business that bills through
 * Stripe ("STRIPE* FIGMA") is spending by its kind, and never reaches that test.
 *
 * A payout is a payout whichever way it went: in, Stripe paying out the
 * balance its charges built; out, Stripe taking back a balance that refunds or
 * disputes left negative. Both are the other side of what the Stripe sync
 * records, so neither is income or spending of its own.
 *
 * Rows stored before kind existed carry 0041's guess (finance_kind_guess); the
 * sync replaces it on every row it reads again.
 *
 * Kept free of imports so kind.test.js runs it in node.
 */

export type Kind = 'income' | 'fee' | 'expense' | 'payout' | 'transfer' | 'interest';

/* The fields of a Mercury transaction read here, as its API names them. */
export interface KindFields {
  amount: number;
  kind?: string | null;
  counterpartyName?: string | null;
  counterpartyNickname?: string | null;
  bankDescription?: string | null;
}

/* What a transaction is when its kind alone says, by Mercury's names for its
   kinds. A Map, so a kind named like something every object has ('toString')
   is not found in it. */
const BY_KIND = new Map<string, Kind>([
  ['internalTransfer', 'transfer'],
  ['treasuryTransfer', 'transfer'],

  ['outgoingPayment', 'expense'],
  ['expenseReimbursement', 'expense'],
  ['creditCardTransaction', 'expense'],
  ['debitCardTransaction', 'expense'],
  ['creditCardCredit', 'expense'],
  ['debitCardCredit', 'expense'],
  ['currencyCloudReturn', 'expense'],

  ['wireFee', 'fee'],
  ['cardInternationalTransactionFee', 'fee'],
  ['cardInternationalTransactionFeeRebate', 'fee'],
  ['cardInternationalTransactionFeeReversal', 'fee'],
  ['cardInternationalTransactionFeeRebateReversal', 'fee'],
  ['personalBankingSubscriptionFee', 'fee'],
  ['billingEngineSubscriptionFee', 'fee'],

  ['checkDeposit', 'income'],
  ['interestPayment', 'interest'],
]);

/* Stripe's own names: "Stripe" alone or with its legal form ("Stripe, Inc.",
   "STRIPE LLC"), and its companies "Stripe Payments …" and "Stripe Technology …".
   Not "Stripe Studio", "Stripes & Co" or "Pinstripe". */
const STRIPE_ITSELF =
  /^stripe(?:,?\s+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company))?\.?$|^stripe\s+(?:payments|technology)\b/i;

/* The word STRIPE first, as in "STRIPE TRANSFER ST-…". Not STRIPES or STRIPED. */
const STRIPE_FIRST = /^stripe\b/i;

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value.trim());
}

function movedByStripe(t: KindFields): boolean {
  return matches(t.counterpartyName, STRIPE_ITSELF)
    || matches(t.counterpartyNickname, STRIPE_ITSELF)
    || matches(t.bankDescription, STRIPE_FIRST);
}

export function mercuryKind(t: KindFields): Kind {
  const known = typeof t.kind === 'string' ? BY_KIND.get(t.kind) : undefined;
  if (known) return known;
  if (movedByStripe(t)) return 'payout';
  return Number(t.amount) > 0 ? 'income' : 'expense';
}
