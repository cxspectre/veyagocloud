/* Finance OVERVIEW. Read-only on purpose: headline stats, the 6-month chart,
   the accounts panel, the eight most recent transactions and an invoice
   summary. Everything you can DO lives on its own page —
   /admin/transactions (the full ledger) and /admin/invoices (invoice
   management) — so this page never grows a form again.
   Managers only — non-managers are bounced to the dashboard. */
(function () {
  'use strict';

  var msg = document.getElementById('msg');

  var accounts = [];
  var catById = {};        // category id → name, for the recent-activity column
  var chartRows = [];      // 6-month unfiltered (posted_at, amount)

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  /* Escapes for BOTH text and quoted-attribute contexts — see team.js:esc. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmt(n, currency) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2
    }).format(n);
  }

  function mainCurrency() { return accounts.length ? accounts[0].currency : 'USD'; }

  function timeAgo(iso) {
    if (!iso) return 'never synced';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'synced just now';
    if (mins < 60) return 'synced ' + mins + 'm ago';
    if (mins < 2880) return 'synced ' + Math.round(mins / 60) + 'h ago';
    return 'synced ' + Math.round(mins / 1440) + 'd ago';
  }

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;

    var acc = await window.sb.from('finance_accounts')
      .select('id,name,kind,provider,currency,last_synced_at').eq('active', true).order('name');
    if (acc.error) { setMsg('Could not load accounts: ' + acc.error.message, 'err'); return; }
    accounts = acc.data || [];

    var cat = await window.sb.from('finance_categories')
      .select('id,name,kind').order('sort_order');
    if (cat.error) { setMsg('Could not load categories: ' + cat.error.message, 'err'); return; }
    catById = {};
    (cat.data || []).forEach(function (c) { catById[c.id] = c.name; });

    renderAccounts();
    await Promise.all([loadOverview(), loadRecent()]);
  }

  /* ── Overview: stats + chart, ALWAYS unfiltered so nothing can silently
     skew the headline numbers. ──────────────────────────────────────── */

  /* Local-time YYYY-MM — toISOString() would shift a local first-of-month
     back a day in any TZ east of UTC, mis-bucketing the whole chart. */
  function ym(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /* First day of the month N months back. Built via the Date constructor, not
     setMonth() — setMonth keeps the day-of-month and rolls FORWARD on overflow
     (Feb 31 → Mar 3), which silently dropped the earliest month from the query
     while the chart still drew an empty column for it. */
  function monthStart(monthsBack) {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  }

  async function loadOverview() {
    var since = ym(monthStart(5)) + '-01';

    var res = await window.sb.from('finance_transactions')
      .select('posted_at,amount').gte('posted_at', since).limit(5000);
    if (res.error) { setMsg('Could not load overview: ' + res.error.message, 'err'); return; }
    chartRows = res.data || [];

    var inv = await window.sb.from('finance_invoices')
      .select('amount,status,due_on,paid_on').limit(500);
    if (inv.error) { setMsg('Could not load invoices: ' + inv.error.message, 'err'); return; }
    var summary = summarise(inv.data || []);

    renderStats(summary.outstanding);
    renderChart();
    renderInvoiceSummary(summary);
  }

  function renderStats(outstanding) {
    var wrap = document.getElementById('fin-stats');
    if (!wrap) return;
    var thisMonth = ym(new Date());
    var income = 0, expense = 0;
    chartRows.forEach(function (t) {
      if (t.posted_at.slice(0, 7) !== thisMonth) return;
      var a = Number(t.amount);
      if (a >= 0) income += a; else expense += Math.abs(a);
    });
    var cur = mainCurrency();

    window.admin.statCards(wrap, [
      { color: '#34c759', label: 'Income this month',   n: fmt(income, cur),
        icon: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' },
      { color: '#ff3b30', label: 'Expenses this month', n: fmt(expense, cur),
        icon: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>' },
      { color: '#0071e3', label: 'Net this month',      n: fmt(income - expense, cur),
        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>' },
      { color: '#ff9500', label: 'Outstanding invoices', n: fmt(outstanding, cur),
        href: '/admin/invoices',
        icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' }
    ]);
  }

  /* Grouped monthly bars, inline SVG — income vs expense per month. */
  function renderChart() {
    var wrap = document.getElementById('fin-chart');
    if (!wrap) return;

    var months = [];
    for (var i = 5; i >= 0; i--) months.push(ym(monthStart(i)));
    var totals = {};
    months.forEach(function (m) { totals[m] = { income: 0, expense: 0 }; });
    chartRows.forEach(function (t) {
      var m = t.posted_at.slice(0, 7);
      if (!totals[m]) return;
      if (t.amount >= 0) totals[m].income += Number(t.amount);
      else totals[m].expense += Math.abs(Number(t.amount));
    });

    var max = 1;
    months.forEach(function (m) { max = Math.max(max, totals[m].income, totals[m].expense); });

    var W = 640, H = 240, PAD = 28, plotH = H - PAD - 20;
    var groupW = (W - PAD * 2) / months.length;
    var barW = Math.min(30, groupW / 3);

    var bars = '';
    months.forEach(function (m, i) {
      var x0 = PAD + i * groupW + groupW / 2;
      var hIn = Math.max(2, Math.round((totals[m].income  / max) * plotH));
      var hEx = Math.max(2, Math.round((totals[m].expense / max) * plotH));
      bars +=
        '<rect x="' + (x0 - barW - 2) + '" y="' + (20 + plotH - hIn) + '" width="' + barW + '" height="' + hIn + '" rx="3" fill="#34c759"><title>' + m + ' income: ' + totals[m].income.toFixed(2) + '</title></rect>' +
        '<rect x="' + (x0 + 2) + '" y="' + (20 + plotH - hEx) + '" width="' + barW + '" height="' + hEx + '" rx="3" fill="#ff3b30" opacity="0.85"><title>' + m + ' expenses: ' + totals[m].expense.toFixed(2) + '</title></rect>' +
        '<text x="' + x0 + '" y="' + (H - 4) + '" text-anchor="middle" font-size="11" fill="#86868b">' + m.slice(5) + '/' + m.slice(2, 4) + '</text>';
    });

    wrap.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Monthly income and expenses">' +
        '<line x1="' + PAD + '" y1="' + (20 + plotH) + '" x2="' + (W - PAD) + '" y2="' + (20 + plotH) + '" stroke="#e8e8ed" stroke-width="1"/>' +
        bars +
        '<g font-size="11"><rect x="' + PAD + '" y="2" width="10" height="10" rx="2" fill="#34c759"/><text x="' + (PAD + 14) + '" y="11" fill="#86868b">Income</text>' +
        '<rect x="' + (PAD + 78) + '" y="2" width="10" height="10" rx="2" fill="#ff3b30" opacity="0.85"/><text x="' + (PAD + 92) + '" y="11" fill="#86868b">Expenses</text></g>' +
      '</svg>';
  }

  /* ── Accounts panel ────────────────────────────────────────────────── */

  var KIND_ICON = {
    bank:   '<path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/>',
    stripe: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    paypal: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    manual: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>'
  };

  function renderAccounts() {
    var listEl = document.getElementById('fin-accounts');
    if (!listEl) return;
    if (!accounts.length) {
      listEl.innerHTML = '<li class="dash-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg><p>No accounts yet — sync Mercury or add a manual transaction.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    accounts.forEach(function (a) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (KIND_ICON[a.kind] || KIND_ICON.manual) + '</svg>';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.name;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = a.currency + (a.provider ? ' · ' + timeAgo(a.last_synced_at) : ' · manual');
      main.appendChild(t); main.appendChild(s);
      li.appendChild(icon); li.appendChild(main);
      listEl.appendChild(li);
    });
  }

  /* ── Recent activity: newest eight, read-only. The editable ledger is
     /admin/transactions. ───────────────────────────────────────────────── */

  async function loadRecent() {
    var listEl = document.getElementById('tx-recent');
    if (!listEl) return;

    var res = await window.sb.from('finance_transactions')
      .select('id,account_id,posted_at,description,counterparty,amount,currency,category_id,status')
      .order('posted_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(8);
    if (res.error) { setMsg('Could not load transactions: ' + res.error.message, 'err'); return; }

    var rows = res.data || [];
    if (!rows.length) {
      listEl.innerHTML =
        '<div class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>' +
          '<p>No transactions yet — sync an account or add one on the ledger.</p>' +
          '<a class="btn btn-sm btn-primary" href="/admin/transactions">Open the ledger</a>' +
        '</div>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (t) { listEl.appendChild(recentRow(t)); });
  }

  function recentRow(t) {
    var row = document.createElement('a');
    row.className = 'fin-row adm-item--link';
    row.href = '/admin/transactions?tx=' + encodeURIComponent(t.id);

    var date = document.createElement('span'); date.className = 'fin-date';
    date.textContent = t.posted_at.slice(5) + (t.status === 'pending' ? ' ⏳' : '');
    date.title = t.posted_at + (t.status === 'pending' ? ' (pending)' : '');

    var desc = document.createElement('div'); desc.className = 'fin-desc';
    var b = document.createElement('b'); b.textContent = t.description; b.title = t.description;
    desc.appendChild(b);
    var acctName = (accounts.find(function (a) { return a.id === t.account_id; }) || {}).name || '';
    /* A div carrying .adm-item-sub, not a bare span: the class brings the
       one-line ellipsis, and only a block box can actually clip to it. */
    var sub = document.createElement('div');
    sub.className = 'adm-item-sub';
    sub.textContent = acctName + (t.counterparty ? ' · ' + t.counterparty : '');
    sub.title = sub.textContent;
    desc.appendChild(sub);

    var cat = document.createElement('span'); cat.className = 'fin-date';
    cat.textContent = catById[t.category_id] || 'Uncategorised';

    var amt = document.createElement('span'); amt.className = 'fin-amt';
    amt.style.color = t.amount >= 0 ? '#1a7f37' : '#b3261e';
    amt.textContent = fmt(Number(t.amount), t.currency);

    row.appendChild(date); row.appendChild(desc); row.appendChild(cat); row.appendChild(amt);
    return row;
  }

  /* ── Invoice summary ───────────────────────────────────────────────── */

  /* A 'sent' invoice past its due date reads as overdue even if nobody has
     flipped the stored status yet — same rule as /admin/invoices. */
  function effectiveStatus(inv, t0) {
    if (inv.status === 'sent' && inv.due_on && inv.due_on < t0) return 'overdue';
    return inv.status;
  }

  function summarise(rows) {
    var t0 = window.admin.localDate();
    var month = ym(new Date());
    var out = { draft: 0, sent: 0, overdue: 0, paidMonth: 0, outstanding: 0 };
    rows.forEach(function (inv) {
      var s = effectiveStatus(inv, t0);
      if (s === 'draft') out.draft++;
      else if (s === 'sent')    { out.sent++;    out.outstanding += Number(inv.amount); }
      else if (s === 'overdue') { out.overdue++; out.outstanding += Number(inv.amount); }
      else if (s === 'paid' && inv.paid_on && inv.paid_on.slice(0, 7) === month) out.paidMonth++;
    });
    return out;
  }

  var SUMMARY_ROWS = [
    { key: 'draft',     label: 'Draft',          badge: 'badge-neutral' },
    { key: 'sent',      label: 'Sent',           badge: 'badge-info' },
    { key: 'overdue',   label: 'Overdue',        badge: 'badge-danger' },
    { key: 'paidMonth', label: 'Paid this month', badge: 'badge-success' }
  ];

  function renderInvoiceSummary(summary) {
    var listEl = document.getElementById('inv-summary');
    if (!listEl) return;
    listEl.innerHTML = '';

    SUMMARY_ROWS.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = r.label;
      main.appendChild(t);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (summary[r.key] ? r.badge : 'badge-neutral');
      badge.textContent = summary[r.key];
      acts.appendChild(badge);
      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });

    var li2 = document.createElement('li'); li2.className = 'adm-item';
    var main2 = document.createElement('div'); main2.className = 'adm-item-main';
    var t2 = document.createElement('div'); t2.className = 'adm-item-title'; t2.textContent = 'Outstanding';
    var s2 = document.createElement('div'); s2.className = 'adm-item-sub'; s2.textContent = 'sent + overdue';
    main2.appendChild(t2); main2.appendChild(s2);
    var acts2 = document.createElement('div'); acts2.className = 'adm-item-acts';
    var amt = document.createElement('span'); amt.className = 'fin-amt';
    amt.textContent = fmt(summary.outstanding, mainCurrency());
    if (summary.overdue) amt.style.color = '#b3261e';
    acts2.appendChild(amt);
    li2.appendChild(main2); li2.appendChild(acts2);
    listEl.appendChild(li2);
  }

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
