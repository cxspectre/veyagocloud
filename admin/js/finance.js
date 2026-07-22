/* Finance page: synced + manual ledger, monthly summary chart, invoices.
   Managers only — non-managers are bounced to the dashboard (RLS would return
   empty data anyway; the redirect is just honest UX). */
(function () {
  'use strict';

  var msg = document.getElementById('msg');

  var accounts = [];
  var categories = [];
  var transactions = [];   // most recent window, newest first

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function fmt(n, currency) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2
    }).format(n);
  }

  async function load() {
    if (!(await window.adminRoles.isManager())) { window.location.href = '/admin/'; return; }

    var acc = await window.sb.from('finance_accounts')
      .select('id,name,kind,currency,last_synced_at').eq('active', true).order('name');
    if (acc.error) { setMsg('Could not load accounts: ' + acc.error.message, 'err'); return; }
    accounts = acc.data || [];

    var cat = await window.sb.from('finance_categories')
      .select('id,name,kind').order('sort_order');
    if (cat.error) { setMsg('Could not load categories: ' + cat.error.message, 'err'); return; }
    categories = cat.data || [];

    fillSelects();
    await Promise.all([loadTransactions(), loadInvoices()]);
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
    renderStats();
    renderChart();
    renderTransactions();
  }

  /* ── Stats + chart ─────────────────────────────────────────────────── */

  function monthKey(dateStr) { return dateStr.slice(0, 7); }

  function monthlyTotals() {
    var months = [];
    var now = new Date();
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.toISOString().slice(0, 7));
    }
    var totals = {};
    months.forEach(function (m) { totals[m] = { income: 0, expense: 0 }; });
    transactions.forEach(function (t) {
      var m = monthKey(t.posted_at);
      if (!totals[m]) return;
      if (t.amount >= 0) totals[m].income += Number(t.amount);
      else totals[m].expense += Math.abs(Number(t.amount));
    });
    return { months: months, totals: totals };
  }

  function renderStats() {
    var wrap = document.getElementById('fin-stats');
    if (!wrap) return;
    var thisMonth = monthKey(new Date().toISOString());
    var income = 0, expense = 0, net = 0;
    transactions.forEach(function (t) {
      if (monthKey(t.posted_at) !== thisMonth) return;
      var a = Number(t.amount);
      net += a;
      if (a >= 0) income += a; else expense += Math.abs(a);
    });
    var cur = accounts.length ? accounts[0].currency : 'USD';
    var cards = [
      { label: 'Income this month',   value: fmt(income, cur) },
      { label: 'Expenses this month', value: fmt(expense, cur) },
      { label: 'Net this month',      value: fmt(net, cur) },
      { label: 'Accounts',            value: String(accounts.length) }
    ];
    wrap.innerHTML = cards.map(function (c) {
      return '<div class="adm-stat"><div class="adm-stat-n">' + c.value +
             '</div><div class="adm-stat-l">' + c.label + '</div></div>';
    }).join('');
  }

  /* Grouped monthly bars, inline SVG — income vs expense per month. */
  function renderChart() {
    var wrap = document.getElementById('fin-chart');
    if (!wrap) return;
    var data = monthlyTotals();
    var max = 1;
    data.months.forEach(function (m) {
      max = Math.max(max, data.totals[m].income, data.totals[m].expense);
    });

    var W = 640, H = 220, PAD = 28, plotH = H - PAD - 20;
    var groupW = (W - PAD * 2) / data.months.length;
    var barW = Math.min(26, groupW / 3);

    var bars = '';
    data.months.forEach(function (m, i) {
      var x0 = PAD + i * groupW + groupW / 2;
      var hIn = Math.round((data.totals[m].income  / max) * plotH);
      var hEx = Math.round((data.totals[m].expense / max) * plotH);
      bars +=
        '<rect x="' + (x0 - barW - 2) + '" y="' + (20 + plotH - hIn) + '" width="' + barW + '" height="' + hIn + '" rx="3" fill="#1a7f37"><title>' + m + ' income: ' + data.totals[m].income.toFixed(2) + '</title></rect>' +
        '<rect x="' + (x0 + 2) + '" y="' + (20 + plotH - hEx) + '" width="' + barW + '" height="' + hEx + '" rx="3" fill="#c0392b"><title>' + m + ' expenses: ' + data.totals[m].expense.toFixed(2) + '</title></rect>' +
        '<text x="' + x0 + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + m.slice(5) + '/' + m.slice(2, 4) + '</text>';
    });

    wrap.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Monthly income and expenses">' +
        '<line x1="' + PAD + '" y1="' + (20 + plotH) + '" x2="' + (W - PAD) + '" y2="' + (20 + plotH) + '" stroke="var(--muted-2)" stroke-width="1"/>' +
        bars +
        '<g font-size="11"><rect x="' + PAD + '" y="2" width="10" height="10" rx="2" fill="#1a7f37"/><text x="' + (PAD + 14) + '" y="11" fill="var(--muted)">Income</text>' +
        '<rect x="' + (PAD + 74) + '" y="2" width="10" height="10" rx="2" fill="#c0392b"/><text x="' + (PAD + 88) + '" y="11" fill="var(--muted)">Expenses</text></g>' +
      '</svg>';
  }

  /* ── Transactions list ─────────────────────────────────────────────── */

  function renderTransactions() {
    var listEl = document.getElementById('tx-list');
    if (!listEl) return;
    if (!transactions.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No transactions yet — sync Mercury/Stripe or add one manually below.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    transactions.forEach(function (t) {
      var li = document.createElement('li'); li.className = 'adm-item';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var title = document.createElement('div'); title.className = 'adm-item-title';
      title.textContent = t.description;
      var acctName = (accounts.find(function (a) { return a.id === t.account_id; }) || {}).name || '';
      var sub = document.createElement('div'); sub.className = 'adm-item-sub';
      sub.textContent = t.posted_at + ' · ' + acctName + (t.counterparty ? ' · ' + t.counterparty : '') +
        (t.status === 'pending' ? ' · pending' : '');
      main.appendChild(title); main.appendChild(sub);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var amt = document.createElement('span');
      amt.className = 'adm-item-title';
      amt.style.color = t.amount >= 0 ? '#1a7f37' : '#c0392b';
      amt.textContent = fmt(Number(t.amount), t.currency);
      acts.appendChild(amt);

      var catSel = document.createElement('select'); catSel.className = 'input input-sm';
      var none = document.createElement('option'); none.value = ''; none.textContent = '—';
      catSel.appendChild(none);
      categories.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.id; o.textContent = c.name;
        if (c.id === t.category_id) o.selected = true;
        catSel.appendChild(o);
      });
      catSel.addEventListener('change', function () { categorise(t, catSel.value || null); });
      acts.appendChild(catSel);

      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
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
      accounts.push(manual);
      fillSelects();
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
    loadTransactions();
  });

  /* ── Invoices ──────────────────────────────────────────────────────── */

  var INV_BADGE = { draft: 'badge-draft', sent: 'badge-beta', paid: 'badge-published', overdue: 'badge-live' };
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
      listEl.innerHTML = '<li class="adm-empty"><p>No invoices tracked yet.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    var today = new Date().toISOString().slice(0, 10);
    rows.forEach(function (inv) {
      var status = (inv.status === 'sent' && inv.due_on && inv.due_on < today) ? 'overdue' : inv.status;

      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title';
      t.textContent = inv.client + ' · #' + inv.number;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = fmt(Number(inv.amount), inv.currency) +
        (inv.due_on ? ' · due ' + inv.due_on : '') + (inv.paid_on ? ' · paid ' + inv.paid_on : '');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (INV_BADGE[status] || 'badge-draft');
      badge.textContent = status;
      acts.appendChild(badge);

      if (INV_NEXT[status]) {
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary'; btn.type = 'button';
        btn.textContent = INV_NEXT_LABEL[status];
        btn.addEventListener('click', async function () {
          var next = INV_NEXT[status];
          var patch = { status: next, paid_on: next === 'paid' ? today : null };
          var res2 = await window.sb.from('finance_invoices').update(patch).eq('id', inv.id);
          if (res2.error) { setMsg('Update failed: ' + res2.error.message, 'err'); return; }
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
      currency: accounts.length ? accounts[0].currency : 'USD',
      issued_on: new Date().toISOString().slice(0, 10),
      due_on: document.getElementById('i-due').value || null,
      status: 'draft'
    });
    if (res.error) { setMsg('Add failed: ' + res.error.message, 'err'); return; }
    document.getElementById('i-client').value = '';
    document.getElementById('i-number').value = '';
    document.getElementById('i-amount').value = '';
    setMsg('Invoice added.', 'ok');
    loadInvoices();
  });

  document.getElementById('f-account').addEventListener('change', loadTransactions);
  document.addEventListener('admin:authed', load);
})();
