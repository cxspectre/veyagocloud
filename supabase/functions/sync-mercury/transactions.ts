/* Walking one Mercury account's transactions into finance_transactions.
 *
 * Mercury lists an account's transactions a page at a time — at most 500 per
 * request, the next page found by offset. The sync used to ask once and stop,
 * so anything past the first 500 in the window was never stored, silently, on
 * every run. This walks on until a page comes back empty, writing each page as
 * it arrives, so memory stays one page deep and a failure part-way keeps what
 * was already written (the upsert makes the next run finish the job).
 *
 * A page shorter than the limit is not taken as the end: a Mercury that caps
 * lower than asked would otherwise look finished after its first page, which
 * is the same bug again. The next offset is wherever the rows actually
 * received stop.
 *
 * Guards stop an API that misbehaves from looping until the function times
 * out, or from a partial sync being reported as complete:
 *   - a page of transactions this walk has already seen, as long as the
 *     longest page Mercury has sent, means the offset is being ignored, so it
 *     throws rather than fetch that page forever or stop at it. The length is
 *     judged against what Mercury actually sends, not the limit asked for,
 *     since it may cap lower. A shorter page of repeats is just the end — a
 *     transaction arriving mid-walk pushes the last row of one page onto the
 *     next — and so is any page of repeats once Mercury's own total is in hand;
 *   - a response with no list of transactions throws: taken for an empty
 *     page, it ended the walk as if complete;
 *   - a walk that ends with fewer transactions than Mercury's first answer
 *     counted throws, rather than report the rest as synced;
 *   - more than MAX_PAGES pages throws rather than stopping quietly.
 *
 * Payments that leave no money moved (cancelled, failed, reversed or blocked)
 * are not written: finance_transactions can only call a row pending or posted
 * (0005), and stored as posted they counted as money spent. Their ids go to
 * `remove` instead, since an earlier sync may have stored one before it ended
 * that way.
 *
 * Each row says what its transaction is (income, spending, a fee, a transfer
 * between the studio's own accounts, a Stripe payout, interest), from
 * Mercury's kind for it (kind.ts), so the figures (the finance_figures view,
 * 0041) do not guess from the sign. The column arrives with 0041: deploy after
 * it.
 *
 * One import, kind.ts, which has none of its own: transactions.test.js loads
 * both in Node, the same way the _shared modules are tested.
 */

import { mercuryKind } from './kind.ts';
import type { Kind } from './kind.ts';

export const PAGE_SIZE = 500;
export const MAX_PAGES = 200;

/* Mercury's statuses for a payment that leaves no money moved: cancelled and
   failed never went through, reversed was undone after it did, and blocked was
   stopped. Its other two are pending, for money on its way, and sent, for
   money that moved. */
const NEVER_WENT_THROUGH = new Set(['cancelled', 'failed', 'reversed', 'blocked']);

/* The fields of a Mercury transaction the sync reads, as its API names them. */
export interface MercuryTransaction {
  id: string;
  postedAt?: string | null;
  createdAt?: string | null;
  amount: number;
  status?: string | null;
  /* Mercury's name for what the transaction is: 'externalTransfer',
     'debitCardTransaction', 'wireFee' and the rest (kind.ts). */
  kind?: string | null;
  bankDescription?: string | null;
  externalMemo?: string | null;
  note?: string | null;
  counterpartyName?: string | null;
  /* The name the studio gave the counterparty in Mercury, if it gave one. */
  counterpartyNickname?: string | null;
}

/* One response from Mercury's transactions list, as fetchPage hands it on.
   `total` is Mercury's count for the list as a whole, not for this page. */
export interface MercuryPage {
  transactions?: MercuryTransaction[] | null;
  total?: number | null;
}

export interface TransactionRow {
  account_id: string;
  external_id: string;
  posted_at: string;
  description: string;
  counterparty: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'posted';
  source: 'mercury';
  kind: Kind;
}

export function transactionsPath(
  accountId: string,
  page: { since: string; offset: number; limit: number },
): string {
  const query = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
    start: page.since,
  });
  return `/account/${encodeURIComponent(accountId)}/transactions?${query}`;
}

/* The mapping the sync has always used, and what the transaction is (kind.ts).
   Whether a transaction is written at all is for pageRows to say. */
export function transactionRow(t: MercuryTransaction, accountId: string): TransactionRow {
  return {
    account_id: accountId,
    external_id: t.id,
    posted_at: (t.postedAt || t.createdAt || '').slice(0, 10),
    description: t.bankDescription || t.externalMemo || t.note || t.counterpartyName || 'Transaction',
    counterparty: t.counterpartyName || null,
    amount: t.amount,                        // Mercury amounts are already signed
    currency: 'USD',
    status: t.status === 'pending' ? 'pending' : 'posted',
    source: 'mercury',
    kind: mercuryKind(t),
  };
}

/* Mercury's count for the whole list, when it sends one that can be a count. */
function totalOf(body: MercuryPage | null | undefined): number | null {
  const total = body?.total;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null;
}

/* The transactions in one response. A response with no list is not an empty
   page — taken for one, it ended the walk as if complete — unless Mercury's
   total says there is nothing to list. */
function transactionsOf(body: MercuryPage | null | undefined, offset: number): MercuryTransaction[] {
  const list = body?.transactions;
  if (Array.isArray(list)) return list;
  if (totalOf(body) === 0) return [];
  throw new Error(
    `Mercury sent no list of transactions at offset ${offset}; ` +
    'stopped rather than take it for the end.',
  );
}

/* One page as rows to write and ids to remove. Dated transactions only, each
   once: a single upsert that names the same key twice is refused outright by
   Postgres ("cannot affect row a second time"), so a repeat inside one page
   keeps its later copy. A payment that never went through is not written;
   its id is handed back instead, to be removed. */
function pageRows(page: MercuryTransaction[], accountId: string): { rows: TransactionRow[]; dropped: string[] } {
  const byId = new Map<string, TransactionRow | null>();
  for (const t of page) {
    if (NEVER_WENT_THROUGH.has(t.status ?? '')) {
      byId.set(t.id, null);
      continue;
    }
    const row = transactionRow(t, accountId);
    if (row.posted_at) byId.set(row.external_id, row);
  }
  const entries = [...byId.entries()];
  return {
    rows: entries.flatMap(([, row]) => (row ? [row] : [])),
    dropped: entries.flatMap(([id, row]) => (row ? [] : [id])),
  };
}

export async function syncAccountTransactions(opts: {
  accountId: string;
  fetchPage: (offset: number, limit: number) => Promise<MercuryPage>;
  store: (rows: TransactionRow[]) => Promise<void>;
  remove: (externalIds: string[]) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
}): Promise<{ pages: number; stored: number }> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const seen = new Set<string>();
  /* Ids written so far. A row repeated across two pages is written twice — the
     later copy is the fresher — but counted once, since the count is what the
     manager is told was synced. One written and then removed is not counted. */
  const stored = new Set<string>();
  let offset = 0;
  let pages = 0;
  let largest = 0;                       // the longest page Mercury has sent
  let firstTotal: number | null = null;  // what Mercury's first answer counted

  for (;;) {
    const body = await opts.fetchPage(offset, pageSize);
    const page = transactionsOf(body, offset);
    if (pages === 0) firstTotal = totalOf(body);
    if (!page.length) break;

    if (page.every((t) => seen.has(t.id))) {
      const shorter = page.length < largest;
      const allInHand = firstTotal != null && seen.size >= firstTotal;
      if (shorter || allInHand) break;
      throw new Error(
        `Mercury sent the same ${page.length} transactions again at offset ${offset}, so it is not paging; ` +
        'stopped rather than fetch them forever or report the rest as synced.',
      );
    }
    if (pages === maxPages) {
      throw new Error(
        `Mercury listed more than ${maxPages * pageSize} transactions for one account; ` +
        'stopped rather than keep paging. Sync a shorter window.',
      );
    }

    pages += 1;
    largest = Math.max(largest, page.length);
    page.forEach((t) => seen.add(t.id));
    const { rows, dropped } = pageRows(page, opts.accountId);
    if (rows.length) {
      await opts.store(rows);
      rows.forEach((row) => stored.add(row.external_id));
    }
    if (dropped.length) {
      await opts.remove(dropped);
      dropped.forEach((id) => stored.delete(id));
    }
    offset += page.length;
  }

  if (firstTotal != null && seen.size < firstTotal) {
    throw new Error(
      `Mercury counted ${firstTotal} transactions for one account but sent ${seen.size} before its list ended; ` +
      'stopped rather than report a partial sync as complete.',
    );
  }

  return { pages, stored: stored.size };
}
