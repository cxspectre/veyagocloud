/* Budgets tab on /admin/finance — monthly spend vs target per category.
   Follows the same pattern as transactions.js / invoices.js: owns its own
   data, knows nothing about the other tabs, loads on adminReady. */
(function () {
  'use strict';

  var budgets  = [];   // rows from finance_budgets
  var spending = {};   // category → negative amount sum for this month
  var categories = []; // all known transaction categories for the datalist

  var editingId = null;  // uuid of the budget currently being edited, or null

  function setMsg(t, k) {
    var el = document.getElementById('b-msg');
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

  async function load() {
    if (!(await window.adminRoles.isManager())) return;

    var monthEl = document.getElementById('budget-month');
    if (monthEl) monthEl.textContent = monthLabel();

    var rs = await Promise.allSettled([
      window.sb.from('finance_budgets').select('id,category,amount,period').order('category'),
      window.sb.from('finance_transactions')
        .select('category,amount')
        .gte('posted_at', monthStart())
        .lt('amount', 0)  /* expenses only */
        .limit(5000),
      window.sb.from('finance_transactions')
        .select('category').not('category', 'is', null).limit(5000),
    ]);

    if (rs[0].status === 'fulfilled' && !rs[0].value.error) {
      budgets = rs[0].value.data || [];
    }

    spending = {};
    if (rs[1].status === 'fulfilled' && !rs[1].value.error) {
      (rs[1].value.data || []).forEach(function (t) {
        var cat = t.category || 'Uncategorised';
        spending[cat] = (spending[cat] || 0) + Math.abs(Number(t.amount));
      });
    }

    var catSet = {};
    if (rs[2].status === 'fulfilled' && !rs[2].value.error) {
      (rs[2].value.data || []).forEach(function (t) {
        if (t.category) catSet[t.category] = 1;
      });
    }
    categories = Object.keys(catSet).sort();
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

    /* Merge: all budgeted categories + any spent-this-month categories without a budget */
    var budgetMap = {};
    budgets.forEach(function (b) { budgetMap[b.category] = b; });

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
      var spent  = spending[b.category] || 0;
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
