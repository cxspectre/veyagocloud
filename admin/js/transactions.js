/* The full ledger. Filter by account, category or free text; click any row to
   open an inline editor (description, counterparty, category, note) with save
   and delete; add manual entries from the sticky side panel.
   Managers only — non-managers are bounced to the dashboard. */
(function () {
  'use strict';

  var COLS = 'id,account_id,posted_at,description,counterparty,amount,currency,category_id,status,source,note';
  var PAGE = 200;

  var msg     = document.getElementById('msg-transactions');
  var listEl  = document.getElementById('tx-list');
  var countEl = document.getElementById('tx-count');
  var accEl   = document.getElementById('f-account');
  var catEl   = document.getElementById('f-category');
  var findEl  = document.getElementById('f-search');

  var accounts = [];
  var categories = [];
  var transactions = [];      // current window, newest first
  var truncated = false;      // the window hit PAGE rows — say so in the count
  var expandedId = null;      // transaction whose editor is open
  var reqSeq = 0;             // guards against a slow request overwriting a fast one

  /* Deep link from the Overview tab's recent-activity row:
     /admin/finance?tx=<id>#transactions. */
  var deepLinkId = new URLSearchParams(window.location.search).get('tx');

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

  function accountName(id) {
    var a = accounts.find(function (x) { return x.id === id; });
    return a ? a.name : 'Unknown account';
  }

  function categoryName(id) {
    var c = categories.find(function (x) { return x.id === id; });
    return c ? c.name : 'Uncategorised';
  }

  /* Replace one row immutably — never mutate the loaded model in place. */
  function replaceRow(id, patch) {
    var idx = transactions.findIndex(function (x) { return x.id === id; });
    if (idx === -1) return;
    transactions = transactions.slice(0, idx)
      .concat([Object.assign({}, transactions[idx], patch)], transactions.slice(idx + 1));
  }

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;

    var acc = await window.sb.from('finance_accounts')
      .select('id,name,kind,currency').eq('active', true).order('name');
    if (acc.error) { setMsg('Could not load accounts: ' + acc.error.message, 'err'); return; }
    accounts = acc.data || [];

    var cat = await window.sb.from('finance_categories')
      .select('id,name,kind').order('sort_order');
    if (cat.error) { setMsg('Could not load categories: ' + cat.error.message, 'err'); return; }
    categories = cat.data || [];

    fillSelects();
    document.getElementById('m-date').value = window.admin.localDate();

    await loadTransactions();
    if (deepLinkId) await openDeepLink();
  }

  function fillSelects() {
    accEl.innerHTML = '<option value="all">All accounts</option>';
    accounts.forEach(function (a) {
      var o = document.createElement('option'); o.value = a.id; o.textContent = a.name;
      accEl.appendChild(o);
    });

    catEl.innerHTML = '<option value="all">All categories</option><option value="none">Uncategorised</option>';
    var addCat = document.getElementById('m-category');
    addCat.innerHTML = '<option value="">Uncategorised</option>';
    categories.forEach(function (c) {
      var f = document.createElement('option'); f.value = c.id; f.textContent = c.name;
      catEl.appendChild(f);
      var a = document.createElement('option'); a.value = c.id; a.textContent = c.name;
      addCat.appendChild(a);
    });
  }

  /* A transaction opened by id may sit outside the current window (older than
     PAGE rows, or filtered out), so fetch it directly rather than assuming the
     list already holds it. A cold deep link to a deleted row says so. */
  async function openDeepLink() {
    var id = deepLinkId;
    deepLinkId = null;

    if (!transactions.some(function (t) { return t.id === id; })) {
      var res = await window.sb.from('finance_transactions').select(COLS).eq('id', id).maybeSingle();
      if (res.error || !res.data) {
        setMsg('That transaction could not be opened — it may have been deleted.', 'err');
        return;
      }
      transactions = [res.data].concat(transactions);
    }

    expandedId = id;
    render();
    var row = listEl.querySelector('[data-tx="' + id + '"]');
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ── Loading ───────────────────────────────────────────────────────── */

  /* PostgREST splits or=(…) on commas and parentheses, so a term containing one
     — `Acme, Inc.` — would be read as two unrelated filters and 400. Those go
     through the double-quoted form with quotes and backslashes escaped;
     everything else stays on the plain syntax. */
  function searchFilter(term) {
    if (!/[,()"\\]/.test(term)) {
      return 'description.ilike.%' + term + '%,counterparty.ilike.%' + term + '%';
    }
    var v = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return 'description.ilike."%' + v + '%",counterparty.ilike."%' + v + '%"';
  }

  function filtersActive() {
    return accEl.value !== 'all' || catEl.value !== 'all' || !!(findEl.value || '').trim();
  }

  async function loadTransactions() {
    var seq = ++reqSeq;
    var term = (findEl.value || '').trim();

    var q = window.sb.from('finance_transactions').select(COLS)
      .order('posted_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(PAGE);
    if (accEl.value !== 'all') q = q.eq('account_id', accEl.value);
    if (catEl.value === 'none') q = q.is('category_id', null);
    else if (catEl.value !== 'all') q = q.eq('category_id', catEl.value);
    if (term) q = q.or(searchFilter(term));

    var res = await q;
    /* A slower earlier request must never repaint over a newer one. */
    if (seq !== reqSeq) return;
    if (res.error) { setMsg('Could not load transactions: ' + res.error.message, 'err'); return; }

    setMsg('');
    transactions = res.data || [];
    truncated = transactions.length === PAGE;
    expandedId = null;
    render();
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */

  function renderCount() {
    if (!countEl) return;
    var n = transactions.length;
    countEl.textContent = n + (n === 1 ? ' transaction' : ' transactions') +
      (truncated && n === PAGE ? ' · newest ' + PAGE : '');
  }

  function render() {
    if (!listEl) return;
    renderCount();

    if (!transactions.length) {
      listEl.innerHTML =
        '<div class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>' +
          (filtersActive()
            ? '<p>No transactions match these filters.</p><button class="btn btn-sm" id="tx-clear" type="button">Clear filters</button>'
            : '<p>No transactions yet — sync an account, or add one on the right.</p>') +
        '</div>';
      var clear = document.getElementById('tx-clear');
      if (clear) clear.addEventListener('click', function () {
        accEl.value = 'all'; catEl.value = 'all'; findEl.value = '';
        loadTransactions();
      });
      return;
    }

    /* Naming the account on every row was pure noise once the account filter
       (or reality) meant every visible row was from the same one — "Mercury
       Checking · Apple", "Mercury Checking · Adobe", "Mercury Checking · ..."
       forty-five times over, when the Account filter above the list already
       says which one you're looking at. It only earns its place once this
       view actually mixes more than one. */
    var showAccount = distinctAccountCount(transactions) > 1;

    listEl.innerHTML = '';
    transactions.forEach(function (t) {
      listEl.appendChild(renderRow(t, showAccount));
      /* The editor is a SIBLING of the row, not a child: .fin-row is itself a
         four-column grid, so a nested panel would land in the first column. */
      if (t.id === expandedId) listEl.appendChild(renderDetail(t));
    });
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

  function renderRow(t, showAccount) {
    var isOpen = t.id === expandedId;

    var row = document.createElement('div');
    row.className = 'fin-row';
    row.setAttribute('data-tx', t.id);
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    row.setAttribute('aria-label', t.description + ' — edit transaction');
    row.style.cursor = 'pointer';
    if (isOpen) row.style.background = 'var(--bg-soft)';

    var date = document.createElement('span'); date.className = 'fin-date';
    date.textContent = t.posted_at.slice(5) + (t.status === 'pending' ? ' ⏳' : '');
    date.title = t.posted_at + (t.status === 'pending' ? ' (pending)' : '');

    var desc = document.createElement('div'); desc.className = 'fin-desc';
    var b = document.createElement('b'); b.textContent = t.description; b.title = t.description;
    desc.appendChild(b);
    /* A div carrying .adm-item-sub, not a bare span: the class brings the
       one-line ellipsis, and only a block box can actually clip to it. A span
       would honour nowrap and then spill across the category column. */
    var sub = document.createElement('div');
    sub.className = 'adm-item-sub';
    sub.textContent = [
      showAccount ? accountName(t.account_id) : null,
      t.counterparty || null,
      t.note ? '📝' : null
    ].filter(Boolean).join(' · ');
    sub.title = sub.textContent;
    desc.appendChild(sub);

    var catSel = document.createElement('select');
    /* select-ghost: plain until hovered or focused, rather than a permanently
       bordered control repeated on all 45 rows outweighing the amount next to
       it. Tied to interaction state, not to whether category_id is already
       set — a value-driven toggle would mean a miscategorised-then-cleared
       row silently reverts to ghost styling with no visual cue anything
       changed. */
    catSel.className = 'input input-sm select select-ghost';
    catSel.setAttribute('aria-label', 'Category for ' + t.description);
    catSel.style.width = '100%';
    var none = document.createElement('option'); none.value = ''; none.textContent = '—';
    catSel.appendChild(none);
    categories.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.name;
      if (c.id === t.category_id) o.selected = true;
      catSel.appendChild(o);
    });
    catSel.addEventListener('change', function () { categorise(t, catSel.value || null); });
    /* The select lives inside a role="button" row; stop it toggling the editor. */
    catSel.addEventListener('click', function (ev) { ev.stopPropagation(); });
    catSel.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

    var amt = document.createElement('span'); amt.className = 'fin-amt';
    /* Same tokens finance.js's own recent-activity row uses for this exact
       amount-color decision — admin.css already defines both, this used to
       hardcode a second, driftable copy of the same two hex values. */
    amt.style.color = t.amount >= 0 ? 'var(--fg-success)' : 'var(--fg-danger)';
    var amtText = document.createElement('span');
    amtText.textContent = fmt(Number(t.amount), t.currency);
    /* The only visual sign a row expands used to be a background tint that
       only appeared once you were already hovering it — reusing the same
       chevron component checklist.js/member.js/team.js already use elsewhere
       for exactly this. */
    var chev = document.createElement('span'); chev.className = 'chev' + (isOpen ? ' open' : '');
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="6 9 12 15 18 9"/></svg>';
    amt.appendChild(amtText); amt.appendChild(chev);

    row.appendChild(date); row.appendChild(desc); row.appendChild(catSel); row.appendChild(amt);

    function toggle() {
      expandedId = expandedId === t.id ? null : t.id;
      render();
      /* Keep focus on the row the user activated so keyboard flow survives
         the re-render. */
      var again = listEl.querySelector('[data-tx="' + t.id + '"]');
      if (again) again.focus();
    }

    row.addEventListener('click', function (ev) {
      if (ev.target.closest('select')) return;
      toggle();
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.target !== row) return;
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();      // Space would scroll the page
        toggle();
      }
    });
    return row;
  }

  function categoryOptions(selectedId) {
    return '<option value="">Uncategorised</option>' + categories.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === selectedId ? ' selected' : '') + '>' +
        esc(c.name) + '</option>';
    }).join('');
  }

  /* ── Inline editor ─────────────────────────────────────────────────── */

  function renderDetail(t) {
    var wrap = document.createElement('div');
    wrap.className = 'adm-item-detail';

    wrap.innerHTML =
      '<div class="field"><p class="hint">' +
        esc(accountName(t.account_id)) + ' · ' + esc(t.posted_at) + ' · ' +
        esc(fmt(Number(t.amount), t.currency)) + ' · ' + esc(t.source) + ' · ' + esc(t.status) +
      '</p></div>' +
      '<div class="row-2">' +
        '<div class="field"><label for="d-desc">Description</label>' +
          '<input class="input" id="d-desc" data-f="description" type="text" value="' + esc(t.description) + '" /></div>' +
        '<div class="field"><label for="d-cp">Counterparty</label>' +
          '<input class="input" id="d-cp" data-f="counterparty" type="text" value="' + esc(t.counterparty) + '" placeholder="Who it went to or came from" /></div>' +
      '</div>' +
      '<div class="field"><label for="d-cat">Category</label>' +
        '<select class="input select" id="d-cat" data-f="category_id">' + categoryOptions(t.category_id) + '</select></div>' +
      '<div class="field"><label for="d-note">Note</label>' +
        '<textarea class="input" id="d-note" data-f="note" rows="2" placeholder="Receipt reference, what it was for, who to ask">' + esc(t.note) + '</textarea>' +
        '<p class="hint">Only visible here — nothing is sent to the bank.</p></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="save" type="button">Save changes</button>' +
        '<button class="btn btn-sm" data-act="cancel" type="button">Cancel</button>' +
        '<button class="btn btn-sm btn-danger" data-act="del" type="button">Delete</button>' +
        '<span class="msg" data-slot="msg"></span>' +
      '</div>';

    wrap.querySelector('[data-act="save"]').addEventListener('click', function () { save(t, wrap); });
    wrap.querySelector('[data-act="del"]').addEventListener('click', function () { remove(t, wrap); });
    wrap.querySelector('[data-act="cancel"]').addEventListener('click', function () {
      expandedId = null;
      render();
    });
    return wrap;
  }

  function detailMsg(wrap, t, k) {
    var el = wrap.querySelector('[data-slot="msg"]');
    if (el) { el.textContent = t; el.className = 'msg' + (k ? ' ' + k : ''); }
  }

  async function save(t, wrap) {
    var patch = {};
    wrap.querySelectorAll('[data-f]').forEach(function (el) {
      var v = (el.value || '').trim();
      patch[el.getAttribute('data-f')] = v || null;
    });
    if (!patch.description) { detailMsg(wrap, 'Description is required.', 'err'); return; }

    var btn = wrap.querySelector('[data-act="save"]');
    btn.disabled = true;
    var res = await window.sb.from('finance_transactions').update(patch).eq('id', t.id);
    btn.disabled = false;
    if (res.error) { detailMsg(wrap, 'Save failed: ' + res.error.message, 'err'); return; }

    replaceRow(t.id, patch);
    expandedId = null;
    render();
    window.admin.toast('Transaction saved');
  }

  async function remove(t, wrap) {
    if (!confirm('Delete "' + t.description + '"? This cannot be undone.')) return;
    var res = await window.sb.from('finance_transactions').delete().eq('id', t.id);
    if (res.error) { detailMsg(wrap, 'Delete failed: ' + res.error.message, 'err'); return; }

    transactions = transactions.filter(function (x) { return x.id !== t.id; });
    expandedId = null;
    render();
    window.admin.toast('Transaction deleted');
  }

  /* Patch the in-memory row only. Used when an editor is open, so a category
     change never costs someone the note they were mid-way through typing. */
  function updateRowCategory(id, categoryId) {
    transactions = transactions.map(function (r) {
      return r.id === id ? Object.assign({}, r, { category_id: categoryId }) : r;
    });
  }

  async function categorise(t, categoryId) {
    var res = await window.sb.from('finance_transactions')
      .update({ category_id: categoryId }).eq('id', t.id);
    if (res.error) { setMsg('Could not change category: ' + res.error.message, 'err'); return; }
    setMsg('');

    /* With a category filter on, re-categorising moves the row out of the
       current view — reload so the list keeps telling the truth. */
    if (catEl.value !== 'all') { if (expandedId) { updateRowCategory(t.id, categoryId); } else { loadTransactions(); } return; }
    replaceRow(t.id, { category_id: categoryId });
    if (expandedId === t.id) /* Don't rebuild the list while an editor is open — re-rendering it from
         stored values silently discards whatever the user has typed. */
      if (expandedId) { updateRowCategory(t.id, categoryId); } else { render(); }
    window.admin.toast(categoryId ? 'Filed under ' + categoryName(categoryId) : 'Category cleared');
  }

  /* ── Manual entry ──────────────────────────────────────────────────── */

  function addMsg(t, k) {
    var el = document.getElementById('m-msg');
    if (el) { el.textContent = t || ''; el.className = 'msg' + (k ? ' ' + k : ''); }
  }

  /* Manual entries need somewhere to live; the ledger owns exactly one
     kind==='manual' account and creates it the first time it is needed. */
  async function manualAccount() {
    var found = accounts.find(function (a) { return a.kind === 'manual'; });
    if (found) return found;

    var created = await window.sb.from('finance_accounts')
      .insert({ name: 'Manual entries', kind: 'manual' }).select().single();
    if (created.error) throw new Error('Could not create the manual account: ' + created.error.message);

    accounts = accounts.concat([created.data]);
    fillSelects();
    return created.data;
  }

  var addBtn = document.getElementById('m-add-btn');
  addBtn.addEventListener('click', async function () {
    var desc   = (document.getElementById('m-desc').value || '').trim();
    var amount = parseFloat(document.getElementById('m-amount').value);
    var date   = document.getElementById('m-date').value;

    if (!desc) { addMsg('Enter a description.', 'err'); return; }
    if (!isFinite(amount) || amount === 0) { addMsg('Enter a non-zero amount (negative for expenses).', 'err'); return; }
    if (!date) { addMsg('Pick a date.', 'err'); return; }

    addBtn.disabled = true;
    try {
      var manual = await manualAccount();
      var res = await window.sb.from('finance_transactions').insert({
        account_id: manual.id,
        posted_at: date,
        description: desc,
        amount: amount,
        currency: manual.currency,
        category_id: document.getElementById('m-category').value || null,
        source: 'manual'
      });
      if (res.error) throw new Error('Add failed: ' + res.error.message);

      document.getElementById('m-desc').value = '';
      document.getElementById('m-amount').value = '';
      document.getElementById('m-date').value = window.admin.localDate();
      addMsg('');
      window.admin.toast('Transaction added');
      loadTransactions();
    } catch (err) {
      addMsg(err.message, 'err');
    } finally {
      addBtn.disabled = false;
    }
  });

  /* ── Filters ───────────────────────────────────────────────────────── */

  accEl.addEventListener('change', loadTransactions);
  catEl.addEventListener('change', loadTransactions);

  var findTimer = null;
  findEl.addEventListener('input', function () {
    clearTimeout(findTimer);
    findTimer = setTimeout(loadTransactions, 250);
  });

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
