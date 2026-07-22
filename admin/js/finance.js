/* Finance page: accent stat cards (honest, always unfiltered), 6-month chart,
   accounts panel, column-aligned ledger, invoices + side forms.
   Managers only — non-managers are bounced to the dashboard. */
(function () {
  'use strict';

  var msg = document.getElementById('msg');

  var accounts = [];
  var categories = [];
  var transactions = [];   // filtered ledger window, newest first
  var chartRows = [];      // 6-month unfiltered (posted_at, amount)

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

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
    if (!(await window.adminRoles.isManager())) { window.location.href = '/admin/'; return; }

    var acc = await window.sb.from('finance_accounts')
      .select('id,name,kind,provider,currency,last_synced_at').eq('active', true).order('name');
    if (acc.error) { setMsg('Could not load accounts: ' + acc.error.message, 'err'); return; }
    accounts = acc.data || [];

    var cat = await window.sb.from('finance_categories')
      .select('id,name,kind').order('sort_order');
    if (cat.error) { setMsg('Could not load categories: ' + cat.error.message, 'err'); return; }
    categories = cat.data || [];

    fillSelects();
    renderAccounts();
    await Promise.all([loadOverview(), loadTransactions(), loadInvoices()]);
  }

  function fillSelects() {
    var accSel = document.getElementById('f-account');
    accSel.innerHTML = '<option value="all">All accounts</option>';
    accounts.forEach(function (a) {
      var o = document.createElement('option'); o.value = a.id; o.textContent = a.name;
      accSel.appendChild(o);
    });

    var catSel = document.getElementById('m-category');
    catSel.innerHTML = '<option value="">Uncategorised</option>';
    categories.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.name;
      catSel.appendChild(o);
    });
  }

  /* ── Overview: stats + chart, ALWAYS unfiltered so the account filter
     can't silently skew the headline numbers. ───────────────────────── */

  /* Local-time YYYY-MM — toISOString() would shift a local first-of-month
     back a day in any TZ east of UTC, mis-bucketing the whole chart. */
  function ym(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  async function loadOverview() {
    var sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    var since = ym(sixMonthsAgo) + '-01';

    var res = await window.sb.from('finance_transactions')
      .select('posted_at,amount').gte('posted_at', since).limit(5000);
    if (res.error) { setMsg('Could not load overview: ' + res.error.message, 'err'); return; }
    chartRows = res.data || [];

    var inv = await window.sb.from('finance_invoices')
      .select('amount,status,due_on').in('status', ['sent', 'overdue']);
    var outstanding = (inv.data || []).reduce(function (sum, i) { return sum + Number(i.amount); }, 0);

    renderStats(outstanding);
    renderChart();
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

    var cards = [
      { color: '#34c759', label: 'Income this month',   n: fmt(income, cur),
        icon: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' },
      { color: '#ff3b30', label: 'Expenses this month', n: fmt(expense, cur),
        icon: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>' },
      { color: '#0071e3', label: 'Net this month',      n: fmt(income - expense, cur),
        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>' },
      { color: '#ff9500', label: 'Outstanding invoices', n: fmt(outstanding, cur),
        icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' }
    ];

    wrap.innerHTML = cards.map(function (c) {
      return '<div class="dash-stat" style="--stat-color:' + c.color + ';cursor:default">' +
        '<div class="dash-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="' + c.color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + c.icon + '</svg></div>' +
        '<div class="dash-stat-n" style="font-size:1.45rem">' + c.n + '</div>' +
        '<div class="dash-stat-label">' + c.label + '</div>' +
      '</div>';
    }).join('');
  }

  /* Grouped monthly bars, inline SVG — income vs expense per month. */
  function renderChart() {
    var wrap = document.getElementById('fin-chart');
    if (!wrap) return;

    var months = [];
    var now = new Date();
    for (var i = 5; i >= 0; i--) {
      months.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    }
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
      listEl.innerHTML = '<li class="adm-empty"><p>No accounts yet — sync Mercury or add a manual transaction.</p></li>';
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

  /* ── Ledger ────────────────────────────────────────────────────────── */

  async function loadTransactions() {
    var accountId = document.getElementById('f-account').value;
    var q = window.sb.from('finance_transactions')
      .select('id,account_id,posted_at,description,counterparty,amount,currency,category_id,status,source')
      .order('posted_at', { ascending: false })
      .limit(200);
    if (accountId !== 'all') q = q.eq('account_id', accountId);
    var res = await q;
    if (res.error) { setMsg('Could not load transactions: ' + res.error.message, 'err'); return; }
    transactions = res.data || [];
    renderTransactions();
  }

  function renderTransactions() {
    var listEl = document.getElementById('tx-list');
    if (!listEl) return;
    if (!transactions.length) {
      listEl.innerHTML = '<div class="adm-empty"><p>No transactions yet — sync Mercury/Stripe or add one manually.</p></div>';
      return;
    }
    listEl.innerHTML = '';
    transactions.forEach(function (t) {
      var row = document.createElement('div'); row.className = 'fin-row';

      var date = document.createElement('span'); date.className = 'fin-date';
      date.textContent = t.posted_at.slice(5) + (t.status === 'pending' ? ' ⏳' : '');
      date.title = t.posted_at + (t.status === 'pending' ? ' (pending)' : '');

      var desc = document.createElement('div'); desc.className = 'fin-desc';
      var b = document.createElement('b'); b.textContent = t.description; b.title = t.description;
      desc.appendChild(b);
      var acctName = (accounts.find(function (a) { return a.id === t.account_id; }) || {}).name || '';
      var span = document.createElement('span');
      span.textContent = acctName + (t.counterparty ? ' · ' + t.counterparty : '');
      desc.appendChild(span);

      var catSel = document.createElement('select'); catSel.className = 'input input-sm';
      catSel.style.width = '100%';
      var none = document.createElement('option'); none.value = ''; none.textContent = '—';
      catSel.appendChild(none);
      categories.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.id; o.textContent = c.name;
        if (c.id === t.category_id) o.selected = true;
        catSel.appendChild(o);
      });
      catSel.addEventListener('change', function () { categorise(t, catSel.value || null); });

      var amt = document.createElement('span'); amt.className = 'fin-amt';
      amt.style.color = t.amount >= 0 ? '#1a7f37' : '#b3261e';
      amt.textContent = fmt(Number(t.amount), t.currency);

      row.appendChild(date); row.appendChild(desc); row.appendChild(catSel); row.appendChild(amt);
      listEl.appendChild(row);
    });
  }

  async function categorise(t, categoryId) {
    var res = await window.sb.from('finance_transactions')
      .update({ category_id: categoryId }).eq('id', t.id);
    if (res.error) { setMsg('Categorise failed: ' + res.error.message, 'err'); return; }
    setMsg('');
  }

  /* ── Sync buttons ──────────────────────────────────────────────────── */

  function wireSync(btnId, fnName, label) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      setMsg('Syncing ' + label + '…');
      try {
        var out = await window.adminRoles.invokeFn(fnName, {});
        setMsg(label + ' synced — ' + (out.transactions || 0) + ' transactions.', 'ok');
        await load();
      } catch (err) {
        setMsg(label + ' sync failed: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }
  wireSync('sync-mercury', 'sync-mercury', 'Mercury');
  wireSync('sync-stripe',  'sync-stripe',  'Stripe');

  /* ── Manual entry ──────────────────────────────────────────────────── */

  document.getElementById('m-add-btn').addEventListener('click', async function () {
    var desc   = (document.getElementById('m-desc').value || '').trim();
    var amount = parseFloat(document.getElementById('m-amount').value);
    var date   = document.getElementById('m-date').value;
    if (!desc) { setMsg('Enter a description.', 'err'); return; }
    if (!isFinite(amount) || amount === 0) { setMsg('Enter a non-zero amount (negative for expenses).', 'err'); return; }
    if (!date) { setMsg('Pick a date.', 'err'); return; }

    var manual = accounts.find(function (a) { return a.kind === 'manual'; });
    if (!manual) {
      var created = await window.sb.from('finance_accounts')
        .insert({ name: 'Manual entries', kind: 'manual' }).select().single();
      if (created.error) { setMsg('Could not create manual account: ' + created.error.message, 'err'); return; }
      manual = created.data;
      accounts = accounts.concat([manual]);
      fillSelects();
      renderAccounts();
    }

    var res = await window.sb.from('finance_transactions').insert({
      account_id: manual.id,
      posted_at: date,
      description: desc,
      amount: amount,
      currency: manual.currency,
      category_id: document.getElementById('m-category').value || null,
      source: 'manual'
    });
    if (res.error) { setMsg('Add failed: ' + res.error.message, 'err'); return; }
    document.getElementById('m-desc').value = '';
    document.getElementById('m-amount').value = '';
    setMsg('Transaction added.', 'ok');
    loadOverview();
    loadTransactions();
  });

  /* ── Invoices ──────────────────────────────────────────────────────── */

  var INV_BADGE = { draft: 'badge-inactive', sent: 'badge-scheduled', paid: 'badge-published', overdue: 'badge-draft' };
  var INV_NEXT  = { draft: 'sent', sent: 'paid', overdue: 'paid' };
  var INV_NEXT_LABEL = { draft: 'Mark sent', sent: 'Mark paid', overdue: 'Mark paid' };

  async function loadInvoices() {
    var res = await window.sb.from('finance_invoices')
      .select('id,number,client,amount,currency,status,due_on,paid_on')
      .order('created_at', { ascending: false }).limit(50);
    if (res.error) { setMsg('Could not load invoices: ' + res.error.message, 'err'); return; }
    renderInvoices(res.data || []);
  }

  function renderInvoices(rows) {
    var listEl = document.getElementById('inv-list');
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No invoices tracked yet — add one on the right.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    var t0 = new Date().toISOString().slice(0, 10);
    rows.forEach(function (inv) {
      var status = (inv.status === 'sent' && inv.due_on && inv.due_on < t0) ? 'overdue' : inv.status;

      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title';
      t.textContent = inv.client + ' · #' + inv.number;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      var due = inv.due_on ? ' · due ' + inv.due_on : '';
      s.innerHTML = fmt(Number(inv.amount), inv.currency) +
        (status === 'overdue' ? ' · <span class="due-over">due ' + inv.due_on + '</span>' : due) +
        (inv.paid_on ? ' · paid ' + inv.paid_on : '');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (INV_BADGE[status] || 'badge-inactive');
      badge.textContent = status;
      acts.appendChild(badge);

      if (INV_NEXT[status]) {
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary'; btn.type = 'button';
        btn.textContent = INV_NEXT_LABEL[status];
        btn.addEventListener('click', async function () {
          var next = INV_NEXT[status];
          var patch = { status: next, paid_on: next === 'paid' ? t0 : null };
          var res2 = await window.sb.from('finance_invoices').update(patch).eq('id', inv.id);
          if (res2.error) { setMsg('Update failed: ' + res2.error.message, 'err'); return; }
          loadOverview();
          loadInvoices();
        });
        acts.appendChild(btn);
      }

      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  document.getElementById('i-add-btn').addEventListener('click', async function () {
    var client = (document.getElementById('i-client').value || '').trim();
    var number = (document.getElementById('i-number').value || '').trim();
    var amount = parseFloat(document.getElementById('i-amount').value);
    if (!client || !number) { setMsg('Enter the client and invoice number.', 'err'); return; }
    if (!isFinite(amount) || amount <= 0) { setMsg('Enter a positive invoice amount.', 'err'); return; }

    var res = await window.sb.from('finance_invoices').insert({
      client: client,
      number: number,
      amount: amount,
      currency: mainCurrency(),
      issued_on: new Date().toISOString().slice(0, 10),
      due_on: document.getElementById('i-due').value || null,
      status: 'draft'
    });
    if (res.error) { setMsg('Add failed: ' + res.error.message, 'err'); return; }
    document.getElementById('i-client').value = '';
    document.getElementById('i-number').value = '';
    document.getElementById('i-amount').value = '';
    setMsg('Invoice added.', 'ok');
    loadOverview();
    loadInvoices();
  });

  document.getElementById('f-account').addEventListener('change', loadTransactions);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
