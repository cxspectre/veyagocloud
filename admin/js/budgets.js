/* Budgets tab on /admin/finance — monthly spend vs target per category.
   Follows the same pattern as transactions.js / invoices.js: owns its own
   data, knows nothing about the other tabs, loads on adminReady. */
(function () {
  'use strict';

  /* Where spending with no category is counted — the same word the ledger
     shows for it (transactions.js, finance.js). */
  var UNCATEGORISED = 'Uncategorised';

  var budgets  = [];   // rows from finance_budgets
  var budgetsFailed = false;  // the budgets themselves could not be read
  var spending = {};   // categoryKey(name) → money out this month
  var categories = []; // names for the datalist: expense categories, then Uncategorised

  /* Rows per request for this month's spending — see monthSpending. */
  var SPEND_PAGE = 1000;

  var editingId = null;  // uuid of the budget currently being edited, or null

  function setMsg(t, k) {
    var el = document.getElementById('b-msg');
    if (!el) return;
    el.textContent = t || '';
    el.className = 'msg' + (k ? ' ' + k : '');
  }

  /* The tab's own message line, above the tracker — for reads that failed. */
  function setLoadMsg(t, k) {
    var el = document.getElementById('msg-budgets');
    if (!el) return;
    el.textContent = t || '';
    el.className = 'msg' + (k ? ' ' + k : '');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(n) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }).format(n);
  }

  function monthLabel() {
    return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function monthStart() {
    var t = window.admin.localDate();
    return t.slice(0, 8) + '01';
  }

  /* A budget names its category in free text; a transaction points at a
     finance_categories row by id. They meet on the category's name, compared
     without regard to case or stray spaces. "Uncategorized" is taken for
     Uncategorised: typed the American way, a budget would otherwise count
     nothing, every month, without a word. */
  function categoryKey(name) {
    var key = String(name == null ? '' : name).trim().toLowerCase();
    return key === 'uncategorized' ? UNCATEGORISED.toLowerCase() : key;
  }

  /* One query's outcome from allSettled: its rows, or why there are none. */
  function outcome(r) {
    if (r.status !== 'fulfilled') {
      return { rows: [], error: String((r.reason && r.reason.message) || r.reason) };
    }
    if (r.value.error) return { rows: [], error: r.value.error.message };
    return { rows: r.value.data || [], error: null };
  }

  /* Money out per category key. Spending with no category — everything the
     syncs bring in, until someone files it — counts under Uncategorised.
     Spending filed under a category whose name did not load is left out
     rather than guessed at. */
  function spendingByCategory(transactions, nameById) {
    var totals = {};
    transactions.forEach(function (t) {
      var name = t.category_id == null ? UNCATEGORISED : nameById[t.category_id];
      if (name == null) return;
      var key = categoryKey(name);
      totals[key] = (totals[key] || 0) + Math.abs(Number(t.amount));
    });
    return totals;
  }

  /* This month's money out, every row of it. PostgREST hands back at most its
     max-rows setting per request — 1000 on Supabase unless raised — whatever
     .limit() asks for. A list cut short can say so (transactions.js shows
     "newest 200"); a total summed from one is just wrong. So it is read a page
     at a time, in a fixed order, until the count the database reports is
     reached. Resolves like a query, { data, error }, for outcome(). */
  async function monthSpending(since) {
    var rows = [];
    for (;;) {
      var res = await window.sb.from('finance_transactions')
        .select('id,category_id,amount', { count: 'exact' })
        .gte('posted_at', since)
        .lt('amount', 0)  /* expenses only */
        .order('id')
        .range(rows.length, rows.length + SPEND_PAGE - 1);
      if (res.error) return { data: null, error: res.error };
      var got = res.data || [];
      rows = rows.concat(got);
      /* An empty page ends it too, so a missing or stale count cannot keep it asking. */
      if (!got.length || (res.count != null && rows.length >= res.count)) {
        return { data: rows, error: null };
      }
    }
  }

  /* The datalist: expense categories in their set order, then Uncategorised —
     the one budget that counts spending nobody has filed, which is everything
     the syncs bring in. */
  function suggestions(categoryRows) {
    var names = categoryRows
      .filter(function (c) { return c.kind === 'expense'; })
      .map(function (c) { return c.name; });
    var key = categoryKey(UNCATEGORISED);
    var listed = names.some(function (n) { return categoryKey(n) === key; });
    return listed ? names : names.concat([UNCATEGORISED]);
  }

  async function load() {
    if (!(await window.adminRoles.isManager())) return;

    var monthEl = document.getElementById('budget-month');
    if (monthEl) monthEl.textContent = monthLabel();

    /* finance_transactions has no category column — only category_id, whose
       name lives on finance_categories (0005). This used to select a
       `category` that does not exist; both reads failed, silently, and every
       budget showed $0 spent. */
    var rs = await Promise.allSettled([
      window.sb.from('finance_budgets').select('id,category,amount,period').order('category'),
      window.sb.from('finance_categories').select('id,name,kind,sort_order').order('sort_order'),
      monthSpending(monthStart()),
    ]);
    var budgetRes = outcome(rs[0]);
    var categoryRes = outcome(rs[1]);
    var spendRes = outcome(rs[2]);

    var nameById = {};
    categoryRes.rows.forEach(function (c) { nameById[c.id] = c.name; });

    budgets = budgetRes.rows;
    budgetsFailed = !!budgetRes.error;
    spending = spendingByCategory(spendRes.rows, nameById);
    categories = suggestions(categoryRes.rows);

    /* Said out loud: a read that failed looks exactly like a month with
       nothing spent. */
    var problems = [];
    if (budgetRes.error) problems.push('Could not load budgets: ' + budgetRes.error + '.');
    if (categoryRes.error) {
      problems.push('Could not load categories, so spending filed under one is not counted: ' + categoryRes.error + '.');
    }
    if (spendRes.error) problems.push('Could not load this month’s spending: ' + spendRes.error + '.');
    setLoadMsg(problems.join(' '), problems.length ? 'err' : '');

    fillDatalist();
    render();
  }

  function fillDatalist() {
    var dl = document.getElementById('b-category-list');
    if (!dl) return;
    dl.innerHTML = '';
    categories.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      dl.appendChild(opt);
    });
  }

  function render() {
    var listEl = document.getElementById('budget-list');
    if (!listEl) return;

    /* The message above already says why; "No budgets set yet" would be a
       second, wrong explanation. */
    if (budgetsFailed) { listEl.innerHTML = ''; return; }

    /* Only show rows where a budget is set (spending-only rows have no target). */
    if (!budgets.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>' +
          '<p>No budgets set yet. Add one on the right to start tracking spending.</p>' +
        '</li>';
      return;
    }

    listEl.innerHTML = '';
    budgets.forEach(function (b) {
      var spent  = spending[categoryKey(b.category)] || 0;
      var limit  = Number(b.amount);
      var pct    = limit > 0 ? Math.min(spent / limit, 1) : 0;
      var over   = spent > limit;
      var barColor = over ? 'var(--fg-danger)' : (pct >= 0.75 ? 'var(--fg-warn)' : 'var(--fg-success)');

      var li = document.createElement('li');
      li.className = 'adm-item';
      li.style.flexDirection = 'column';
      li.style.alignItems = 'stretch';
      li.style.gap = '6px';

      /* Header row */
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%';

      var nameEl = document.createElement('div');
      nameEl.className = 'adm-item-title';
      nameEl.style.flex = '1';
      nameEl.textContent = b.category;

      var spentEl = document.createElement('div');
      spentEl.className = 'adm-item-sub';
      spentEl.style.cssText = 'white-space:nowrap;font-variant-numeric:tabular-nums';
      spentEl.innerHTML =
        '<span style="color:' + barColor + ';font-weight:600">' + esc(fmt(spent)) + '</span>' +
        ' <span style="color:var(--muted)">of ' + esc(fmt(limit)) + '</span>';

      var acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:6px;flex-shrink:0';

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.dataset.budgetId = b.id;
      editBtn.addEventListener('click', function () { startEdit(b); });

      var delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm';
      delBtn.style.color = 'var(--fg-danger)';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', function () { removeBudget(b.id); });

      acts.appendChild(editBtn);
      acts.appendChild(delBtn);
      row.appendChild(nameEl);
      row.appendChild(spentEl);
      row.appendChild(acts);

      /* Progress bar */
      var track = document.createElement('div');
      track.style.cssText = 'height:6px;border-radius:3px;background:var(--hair);overflow:hidden';
      var fill = document.createElement('div');
      fill.style.cssText = 'height:100%;border-radius:3px;background:' + barColor +
        ';width:' + Math.round(pct * 100) + '%;transition:width .3s';
      track.appendChild(fill);

      /* Remaining label */
      var rem = document.createElement('div');
      rem.className = 'adm-item-sub';
      rem.style.fontSize = 'var(--t-eyebrow)';
      if (over) {
        rem.innerHTML = '<span style="color:var(--fg-danger)">' + esc(fmt(spent - limit)) + ' over budget</span>';
      } else {
        rem.textContent = fmt(limit - spent) + ' remaining · ' + Math.round(pct * 100) + '% used';
      }

      li.appendChild(row);
      li.appendChild(track);
      li.appendChild(rem);
      listEl.appendChild(li);
    });

    renderUncategorisedNote(listEl);
  }

  /* Spending with no category counts only against a budget named
     Uncategorised. Without one it counts against nothing and would vanish from
     this page — and the syncs file nothing, so that is usually most of the
     month. Say how much there is. */
  function renderUncategorisedNote(listEl) {
    var key = categoryKey(UNCATEGORISED);
    var loose = spending[key] || 0;
    var counted = budgets.some(function (b) { return categoryKey(b.category) === key; });
    if (loose <= 0 || counted) return;

    var note = document.createElement('li');
    note.id = 'budget-uncategorised';
    note.className = 'adm-item-sub';
    note.style.cssText = 'list-style:none;padding:10px 2px 0';
    note.textContent = fmt(loose) + ' spent this month has no category yet, so no budget counts it. ' +
      'File it on the Transactions tab, or set a budget named ' + UNCATEGORISED + '.';
    listEl.appendChild(note);
  }

  function startEdit(b) {
    editingId = b.id;
    var catEl    = document.getElementById('b-category');
    var amtEl    = document.getElementById('b-amount');
    var titleEl  = document.getElementById('budget-form-title');
    var cancelEl = document.getElementById('b-cancel');
    if (catEl)    { catEl.value = b.category; catEl.disabled = true; }
    if (amtEl)    amtEl.value = b.amount;
    if (titleEl)  titleEl.textContent = 'Edit budget';
    if (cancelEl) cancelEl.hidden = false;
    var saveBtn = document.getElementById('b-save');
    if (saveBtn) saveBtn.textContent = 'Update budget';
    if (amtEl) amtEl.focus();
  }

  function cancelEdit() {
    editingId = null;
    var catEl    = document.getElementById('b-category');
    var amtEl    = document.getElementById('b-amount');
    var titleEl  = document.getElementById('budget-form-title');
    var cancelEl = document.getElementById('b-cancel');
    if (catEl)    { catEl.value = ''; catEl.disabled = false; }
    if (amtEl)    amtEl.value = '';
    if (titleEl)  titleEl.textContent = 'Set a budget';
    if (cancelEl) cancelEl.hidden = true;
    var saveBtn = document.getElementById('b-save');
    if (saveBtn) saveBtn.textContent = 'Save budget';
    setMsg('');
  }

  async function saveBudget() {
    var catEl = document.getElementById('b-category');
    var amtEl = document.getElementById('b-amount');
    var cat   = catEl ? catEl.value.trim() : '';
    var amt   = amtEl ? Number(amtEl.value) : 0;

    if (!cat) { setMsg('Category is required.', 'err'); return; }
    if (!amt || amt <= 0) { setMsg('Enter a positive monthly amount.', 'err'); return; }

    var saveBtn = document.getElementById('b-save');
    if (saveBtn) saveBtn.disabled = true;
    setMsg('');

    var res;
    if (editingId) {
      res = await window.sb.from('finance_budgets')
        .update({ amount: amt, updated_at: new Date().toISOString() })
        .eq('id', editingId);
    } else {
      res = await window.sb.from('finance_budgets')
        .upsert({ category: cat, amount: amt, period: 'monthly', updated_at: new Date().toISOString() },
                { onConflict: 'category,period' });
    }

    if (saveBtn) saveBtn.disabled = false;
    if (res.error) { setMsg('Could not save: ' + res.error.message, 'err'); return; }

    cancelEdit();
    window.admin.toast('Budget saved');
    load();
  }

  async function removeBudget(id) {
    var res = await window.sb.from('finance_budgets').delete().eq('id', id);
    if (res.error) { setMsg('Could not remove: ' + res.error.message, 'err'); return; }
    window.admin.toast('Budget removed');
    load();
  }

  var saveBtn = document.getElementById('b-save');
  if (saveBtn) saveBtn.addEventListener('click', saveBudget);

  var cancelBtn = document.getElementById('b-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelEdit);

  window.adminReady.then(function (s) { if (s) load(); });
})();
