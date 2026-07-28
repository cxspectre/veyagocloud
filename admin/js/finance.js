/* Finance OVERVIEW tab. Read-only on purpose: headline stats, the 6-month
   chart, the accounts panel, the eight most recent transactions and an
   invoice summary. Everything you can DO lives in the other two tabs on this
   same page — Transactions (transactions.js, the full ledger) and Invoices
   (invoices.js, invoice management) — so this tab never grows a form again.
   Managers only — non-managers are bounced to the dashboard. */
(function () {
  'use strict';

  /* Scoped to this panel — finance.js, transactions.js and invoices.js now
     share one document (/admin/finance's three tabs), and each had its own
     unscoped #msg. */
  var msg = document.getElementById('msg-overview');

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
    var netAmt = income - expense;
    /* The one card here whose sign changes what it MEANS, not just its value
       — a fixed blue told the same story whether the month was profitable or
       not. Green over zero, red under it, the existing blue for an exact
       break-even (no signal either way is itself a kind of signal). */
    var netColor = netAmt > 0 ? 'var(--ac-success)' : netAmt < 0 ? 'var(--ac-danger)' : 'var(--blue-2)';

    /* Each color below is a CSS custom property, not a literal — admin.css
       already defines --ac-success/--ac-danger/--ac-warn/--blue-2 as the exact
       hex this used to hardcode a second time. Feeding the DOM a var()
       reference instead of a copy of the value means there is only one place
       these colors live; if admin.css's palette ever moves (a theme, a dark
       mode), this stat row moves with it instead of quietly going stale. */
    window.admin.statCards(wrap, [
      { color: 'var(--ac-success)', label: 'Income this month',   n: fmt(income, cur),
        icon: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' },
      { color: 'var(--ac-danger)', label: 'Expenses this month', n: fmt(expense, cur),
        icon: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>' },
      { color: netColor, label: 'Net this month',      n: fmt(netAmt, cur),
        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>' },
      { color: 'var(--ac-warn)', label: 'Outstanding invoices', n: fmt(outstanding, cur),
        href: '#invoices',
        icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' }
    ]);
  }

  /* Net per month, not grouped income/expense bars. "Am I profitable this
     month" is a trend-of-one-number question — a paired bar chart makes the
     reader do the subtraction themselves, twelve times, before they can
     answer it. A losing month now reads as a bar below the line, not as
     "the red bar happens to be taller than the green one this time."

     Two things NOT done in inline SVG on purpose, both because an SVG's
     internal coordinate system scales with the viewBox on resize while real
     text does not: the axis-month labels and the legend are ordinary HTML
     siblings of the <svg>, not <text> elements inside it, sized by this
     system's own type tokens so they hold their actual pixel size at every
     viewport width instead of stretching with the chart. */
  function renderChart() {
    var wrap = document.getElementById('fin-chart');
    if (!wrap) return;

    var months = [];
    for (var i = 5; i >= 0; i--) months.push(ym(monthStart(i)));
    var net = {};
    months.forEach(function (m) { net[m] = 0; });
    chartRows.forEach(function (t) {
      var m = t.posted_at.slice(0, 7);
      if (m in net) net[m] += Number(t.amount);
    });

    var maxAbs = 1;
    months.forEach(function (m) { maxAbs = Math.max(maxAbs, Math.abs(net[m])); });

    var W = 640, H = 200, PAD_V = 14, mid = H / 2, plotHalf = mid - PAD_V;
    var groupW = W / months.length;
    var barW = Math.min(36, groupW * 0.5);
    var cur = mainCurrency();

    var bars = '';
    months.forEach(function (m, i) {
      var x0 = i * groupW + groupW / 2;
      var h = Math.max(2, Math.round((Math.abs(net[m]) / maxAbs) * plotHalf));
      var up = net[m] >= 0;
      /* style="", not a bare fill attribute — style="" is unambiguously CSS,
         so var() always resolves there. */
      bars += '<rect x="' + (x0 - barW / 2) + '" y="' + (up ? mid - h : mid) + '" width="' + barW + '" height="' + h +
        '" rx="3" style="fill:var(' + (up ? '--ac-success' : '--ac-danger') + ')">' +
        '<title>' + m + ' net: ' + fmt(net[m], cur) + '</title></rect>';
    });

    wrap.innerHTML =
      '<div class="fin-chart-legend">' +
        '<span><i style="background:var(--ac-success)"></i>Profit</span>' +
        '<span><i style="background:var(--ac-danger)"></i>Loss</span>' +
      '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Net profit or loss by month, last 6 months">' +
        '<line x1="0" y1="' + mid + '" x2="' + W + '" y2="' + mid + '" style="stroke:var(--hair-soft)" stroke-width="1"/>' +
        bars +
      '</svg>' +
      '<div class="fin-chart-labels">' +
        months.map(function (m) { return '<span>' + m.slice(5) + '/' + m.slice(2, 4) + '</span>'; }).join('') +
      '</div>';
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
     the Transactions tab. ─────────────────────────────────────────────── */

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
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>' +
          '<p>No transactions yet — sync an account or add one on the ledger.</p>' +
          '<a class="btn btn-sm btn-primary" href="#transactions">Open the ledger</a>' +
        '</li>';
      return;
    }

    /* Naming the account on every row was pure noise once there was really
       only one with any activity — "Mercury Checking · Apple", "Mercury
       Checking · Adobe", "Mercury Checking · ..." eight times over, when the
       Accounts panel two cards up already says there is one account. It only
       earns its place once these eight rows actually come from more than
       one. */
    var showAccount = distinctAccountCount(rows) > 1;

    listEl.innerHTML = '';
    rows.forEach(function (t) { listEl.appendChild(recentRow(t, showAccount)); });
  }

  /* How many DIFFERENT accounts a set of transactions touches — capped at
     stopping the moment it passes one, since every caller only asks "one, or
     more than one?". */
  function distinctAccountCount(rows) {
    var seen = {}, n = 0;
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].account_id;
      if (!seen[id]) { seen[id] = true; n++; if (n > 1) return n; }
    }
    return n;
  }

  /* "Jul 15", not the toLocaleDateString(...,{year:'numeric'}) every other
     date in this admin uses — those are standalone dates with room to spare;
     this one shares a single sub-line with the account and counterparty, and
     everything here is within the current 6-month window anyway, so the year
     is not information, just width. */
  function shortDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* Built on .adm-item, the same row component every other list in this admin
     uses — it used to be a bespoke 4-column .fin-row (a component that exists
     for the ledger's per-row category <select>, which this list doesn't
     have), the only list on this tab not sharing the rest of the product's
     look. */
  function recentRow(t, showAccount) {
    var li = document.createElement('li');
    var row = document.createElement('a');
    row.className = 'adm-item adm-item--link';
    /* Must be a real query string, not "#transactions?tx=…" — everything after
       a "#" is the fragment, and transactions.js reads its deep link from
       location.search (which a fragment is invisible to). The query differs
       from the current page's, so this is a full navigation rather than an
       in-page hash swap — same as when this pointed at the separate
       /admin/transactions page, just landing on the shared document now. */
    row.href = '/admin/finance?tx=' + encodeURIComponent(t.id) + '#transactions';

    var isIncome = Number(t.amount) >= 0;
    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    /* Same up/down arrow paths the Income/Expenses stat cards already use —
       a direction glyph, not a person's initials, since a transaction has no
       "who" the way a team member row does. */
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="' + (isIncome ? 'var(--ac-success)' : 'var(--ac-danger)') +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (isIncome
        ? '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'
        : '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>') +
      '</svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title';
    title.textContent = t.description;
    var acctName = showAccount ? ((accounts.find(function (a) { return a.id === t.account_id; }) || {}).name || '') : '';
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    sub.textContent = [
      shortDate(t.posted_at) + (t.status === 'pending' ? ' ⏳' : ''),
      acctName,
      t.counterparty
    ].filter(Boolean).join(' · ');
    sub.title = t.posted_at + (t.status === 'pending' ? ' (pending)' : '');
    main.appendChild(title); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var cat = document.createElement('span'); cat.className = 'badge badge-neutral';
    cat.textContent = catById[t.category_id] || 'Uncategorised';
    var amt = document.createElement('span'); amt.className = 'fin-amt';
    amt.style.color = isIncome ? 'var(--fg-success)' : 'var(--fg-danger)';
    amt.textContent = fmt(Number(t.amount), t.currency);
    acts.appendChild(cat); acts.appendChild(amt);

    row.appendChild(icon); row.appendChild(main); row.appendChild(acts);
    li.appendChild(row);
    return li;
  }

  /* ── Invoice summary ───────────────────────────────────────────────── */

  /* A 'sent' invoice past its due date reads as overdue even if nobody has
     flipped the stored status yet — same rule invoices.js uses on its own tab. */
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
    if (summary.overdue) amt.style.color = 'var(--fg-danger)';
    acts2.appendChild(amt);
    li2.appendChild(main2); li2.appendChild(acts2);
    listEl.appendChild(li2);
  }

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
