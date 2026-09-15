/* finance-figures.js — what the admin's money figures count, the way the
   workspace's Overview counts it (finance_figures, 0041).

   Income and expenses were every positive and every negative transaction. A
   card payment counted twice — as Stripe's charge, and again when Stripe paid
   it into the bank — a move between the studio's own accounts counted as
   income on one side and spending on the other, and every currency was added
   into one figure. This admin and the workspace gave different figures for the
   same month. Each transaction now counts by what it is (counts_as: 'revenue',
   'expense' or neither), in the studio's currency, with the other currencies
   named beside the figure rather than added in.

   Kept free of the page, and tested in finance-figures.test.js. */
(function (root) {
  'use strict';

  var VIEW = 'finance_figures';
  var VIEW_COLUMNS = 'posted_at,amount,currency,counts_as,counted';
  var LEDGER_COLUMNS = 'posted_at,amount,currency';
  /* PostgREST hands back at most its Max Rows — 1,000 on Supabase — whatever
     limit is asked for, so rows are read a page at a time, in a fixed order
     for the pages not to overlap. */
  var PAGE = 1000;
  /* Fifty thousand rows is years of a studio's ledger. Past that, what was
     read is used, and the console says so. */
  var MAX_PAGES = 50;
  var CODE = /^[A-Z]{3}$/;

  /* PostgREST's answer for a table it does not know (PGRST205), and Postgres's
     (42P01): a database from before 0041. */
  function isMissing(error) {
    return Boolean(error) && (error.code === 'PGRST205' || error.code === '42P01');
  }

  /* What a row counts towards. A row from the ledger itself, before 0041, has
     no counts_as and is read by its sign, as everything used to be. */
  function countsAs(row) {
    if (!row) return null;
    if (row.counts_as !== undefined) {
      return row.counts_as === 'revenue' || row.counts_as === 'expense' ? row.counts_as : null;
    }
    var amount = Number(row.amount);
    return amount > 0 ? 'revenue' : amount < 0 ? 'expense' : null;
  }

  function codeOf(currency) {
    return String(currency == null ? '' : currency).trim().toUpperCase() || 'USD';
  }

  /* Every row `build()` asks for, a page at a time. Answers { data, error }, as
     supabase-js does. */
  async function readAll(build) {
    var rows = [];
    for (var page = 0; page < MAX_PAGES; page++) {
      var from = page * PAGE;
      var res = await build().order('posted_at').order('id').range(from, from + PAGE - 1);
      if (res.error) return { data: null, error: res.error };
      var got = res.data || [];
      rows = rows.concat(got);
      if (got.length < PAGE) return { data: rows, error: null };
    }
    console.warn('[finance] more than ' + PAGE * MAX_PAGES + ' transactions: the figures count the first ' + PAGE * MAX_PAGES + '.');
    return { data: rows, error: null };
  }

  /* The rows: from finance_figures, or — while 0041 is not live — from
     finance_transactions, read by sign. `narrow(query, columns)` adds the
     select and the filters. Any other error is reported rather than covered by
     the ledger. */
  async function load(sb, narrow) {
    var res = await readAll(function () { return narrow(sb.from(VIEW), VIEW_COLUMNS); });
    if (!res.error || !isMissing(res.error)) return res;
    return readAll(function () { return narrow(sb.from('finance_transactions'), LEDGER_COLUMNS); });
  }

  /* The studio's currency, as the workspace's Overview shows money in (0041):
     studio_currency() — the base_currency setting, else the first active
     account's code. Before 0041 there is no such function, and when it cannot
     be asked it is the first of `accounts` — the active ones, by name — whose
     currency is a code, else USD. */
  async function studioCurrency(sb, accounts) {
    try {
      var res = await sb.rpc('studio_currency');
      if (res && !res.error && CODE.test(String(res.data || ''))) return res.data;
    } catch (err) {
      /* Asked of the accounts below. */
    }
    var codes = (accounts || [])
      .map(function (a) { return String((a && a.currency) || '').trim().toUpperCase(); })
      .filter(function (code) { return CODE.test(code); });
    return codes.length ? codes[0] : 'USD';
  }

  /* Income, expenses and net in one currency, added up in whole cents: income
     less refunds, and expenses as a positive amount, less what came back. The
     other currencies with anything that counts are listed, never added in. */
  function totals(rows, currency) {
    var main = codeOf(currency);
    var cents = { revenue: 0, expense: 0 };
    var others = {};
    (rows || []).forEach(function (row) {
      var as = countsAs(row);
      if (!as) return;
      var code = codeOf(row.currency);
      if (code !== main) { others[code] = true; return; }
      /* The amount as it counts (0041's counted): a payout counted from
         Stripe's side is money in, though Stripe's ledger has it going out. */
      var value = row.counted !== undefined && row.counted !== null ? row.counted : row.amount;
      var amount = Math.round(Number(value) * 100);
      if (isFinite(amount)) cents[as] += amount;
    });
    return {
      currency: main,
      income: cents.revenue / 100,
      /* 0 - x rather than -x: no expenses is 0, not -0, which prints "-$0.00". */
      expense: (0 - cents.expense) / 100,
      net: (cents.revenue + cents.expense) / 100,
      otherCurrencies: Object.keys(others).sort()
    };
  }

  /* An amount in its own currency — whole units when `digits` is 0 — and a
     code Intl does not take written beside the number rather than thrown. */
  function format(amount, currency, digits) {
    var code = codeOf(currency);
    var whole = digits === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
    try {
      return new Intl.NumberFormat('en-US', Object.assign({ style: 'currency', currency: code }, whole)).format(amount);
    } catch (err) {
      var plain = digits === 0 ? whole : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
      return new Intl.NumberFormat('en-US', plain).format(amount) + ' ' + code;
    }
  }

  root.financeFigures = Object.freeze({
    load: load, totals: totals, countsAs: countsAs, isMissing: isMissing, format: format, studioCurrency: studioCurrency
  });
})(typeof window !== 'undefined' ? window : globalThis);
