/* Invoice management: stat strip, status filter, invoices grouped by where
   they are in their life (overdue first), inline editing, and a sticky
   create panel. An invoice counts as overdue the moment a SENT one passes its
   due date — nobody has to remember to flip the stored status.
   Managers only — non-managers are bounced to the dashboard. */
(function () {
  'use strict';

  var COLS = 'id,number,client,amount,currency,status,issued_on,due_on,paid_on,notes';
  var PAGE = 200;

  var msg     = document.getElementById('msg-invoices');
  var listEl  = document.getElementById('inv-list');
  var countEl = document.getElementById('inv-count');
  var filtEl  = document.getElementById('f-status');

  var invoices = [];          // every loaded invoice, unfiltered
  var currency = 'USD';
  var expandedId = null;      // invoice whose editor is open

  var BADGE = { draft: 'badge-neutral', sent: 'badge-info', paid: 'badge-success', overdue: 'badge-danger' };
  var NEXT  = { draft: 'sent', sent: 'paid', overdue: 'paid' };
  var NEXT_LABEL = { draft: 'Mark sent', sent: 'Mark paid', overdue: 'Mark paid' };
  var STATUSES = ['draft', 'sent', 'paid', 'overdue'];

  /* .adm-item--stack switches the row to flex-wrap. It is needed while the
     editor is open (the panel takes its own line) and on narrow screens, where
     the badge plus three actions cannot share a line with the client name — an
     unwrapped row there is wider than the page and scrolls it sideways. Left on
     permanently it doubles the height of every closed row on desktop, so it is
     applied per render. 620px is the breakpoint admin.css already uses. */
  var NARROW = window.matchMedia('(max-width: 620px)');

  var GROUPS = [
    { key: 'overdue', label: 'Overdue', danger: true },
    { key: 'draft',   label: 'Draft' },
    { key: 'sent',    label: 'Sent' },
    { key: 'paid',    label: 'Paid' }
  ];

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

  function fmt(n, cur) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: cur || currency, maximumFractionDigits: 2
    }).format(n);
  }

  function today() { return window.admin.localDate(); }

  /* Local-time YYYY-MM. toISOString() would shift a local first-of-month back
     a day east of UTC and drop the current month from "paid this month". */
  function thisMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /* A 'sent' invoice past its due date reads as overdue whether or not anyone
     has updated the stored status. */
  function effStatus(inv, t0) {
    if (inv.status === 'sent' && inv.due_on && inv.due_on < t0) return 'overdue';
    return inv.status;
  }

  /* Replace one row immutably — never mutate the loaded model in place. */
  function replaceRow(id, patch) {
    var idx = invoices.findIndex(function (x) { return x.id === id; });
    if (idx === -1) return;
    invoices = invoices.slice(0, idx)
      .concat([Object.assign({}, invoices[idx], patch)], invoices.slice(idx + 1));
  }

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;

    /* Invoices are billed in the currency of the first active account, the
       same rule the rest of Finance uses. Still needed after the create panel
       moved to the guided flow — every amount this list renders is formatted
       with it. */
    var acc = await window.sb.from('finance_accounts')
      .select('currency').eq('active', true).order('name').limit(1);
    if (!acc.error && acc.data && acc.data.length) currency = acc.data[0].currency;

    await loadInvoices();
  }

  async function loadInvoices() {
    var res = await window.sb.from('finance_invoices').select(COLS)
      .order('due_on', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(PAGE);
    if (res.error) { setMsg('Could not load invoices: ' + res.error.message, 'err'); return; }

    setMsg('');
    invoices = res.data || [];
    renderStats();
    render();
  }

  /* ── Stat strip (always unfiltered) ────────────────────────────────── */

  function renderStats() {
    var wrap = document.getElementById('inv-stats');
    if (!wrap) return;
    var t0 = today(), month = thisMonth();

    var draft = 0, sent = 0, overdue = 0, paidMonth = 0;
    var sentAmt = 0, overdueAmt = 0, paidAmt = 0;
    invoices.forEach(function (inv) {
      var s = effStatus(inv, t0);
      var a = Number(inv.amount);
      if (s === 'draft') draft++;
      else if (s === 'sent')    { sent++;    sentAmt += a; }
      else if (s === 'overdue') { overdue++; overdueAmt += a; }
      else if (s === 'paid' && inv.paid_on && inv.paid_on.slice(0, 7) === month) { paidMonth++; paidAmt += a; }
    });

    /* Tokens, not hex — admin.css already defines every one of these. Draft
       used to be purple here (#5856d6, actually --role-admin's badge color,
       borrowed for an unrelated reason) while the Overview tab's own invoice
       summary has always shown Draft as neutral grey via badge-neutral. Same
       page now, one click apart, so it needed to be one color: neutral, same
       as everywhere else "draft" appears in this product. */

    /* Sent/Overdue/Paid used to lead with a plain invoice COUNT and bury the
       dollar figure in the small muted subtext below — the opposite of what
       a finance dashboard's stat row should emphasize. Draft is left as a
       count on purpose: nothing has been billed yet, so there is no amount
       to lead with. */
    function plural(n, noun) { return n + ' ' + noun + (n === 1 ? '' : 's'); }

    window.admin.statCards(wrap, [
      { n: draft, label: 'Draft', color: 'var(--muted-2)',
        n2: draft ? 'not sent yet' : 'nothing waiting',
        icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
      { n: fmt(sentAmt), label: 'Sent', color: 'var(--blue-2)',
        n2: sent ? plural(sent, 'invoice') + ' awaiting payment' : 'nothing outstanding',
        icon: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>' },
      { n: fmt(overdueAmt), label: 'Overdue', color: overdue ? 'var(--ac-danger)' : 'var(--muted-2)',
        /* nColor carries the same red emphasis n2Color used to put on the
           subtext count — now that the dollar figure is what's actually in
           the hero slot, the urgency signal has to move with it or it just
           disappears. */
        nColor: overdue ? 'var(--fg-danger)' : null,
        n2: overdue ? plural(overdue, 'invoice') + ' past due' : 'nothing late',
        icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
      { n: fmt(paidAmt), label: 'Paid this month', color: 'var(--ac-success)',
        n2: paidMonth ? plural(paidMonth, 'invoice') + ' collected' : 'nothing in yet',
        icon: '<polyline points="20 6 9 17 4 12"/>' }
    ]);
  }

  /* ── List ──────────────────────────────────────────────────────────── */

  function visible() {
    var want = filtEl.value;
    var t0 = today();
    return invoices.filter(function (inv) {
      var s = effStatus(inv, t0);
      if (want === 'all') return true;
      if (want === 'open') return s !== 'paid';
      return s === want;
    });
  }

  function render() {
    if (!listEl) return;
    var t0 = today();
    var rows = visible();

    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? ' invoice' : ' invoices');

    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
          (invoices.length
            ? '<p>No invoices with that status.</p>'
            : '<p>No invoices tracked yet — create the first one on the right.</p>') +
        '</li>';
      return;
    }

    var buckets = {};
    rows.forEach(function (inv) {
      var s = effStatus(inv, t0);
      (buckets[s] = buckets[s] || []).push(inv);
    });

    listEl.innerHTML = '';
    GROUPS.forEach(function (g) {
      var inGroup = buckets[g.key];
      if (!inGroup || !inGroup.length) return;
      /* Paid invoices read best newest-first; everything else stays in
         due-date order from the query. slice() first — never sort in place. */
      if (g.key === 'paid') {
        inGroup = inGroup.slice().sort(function (a, b) {
          return String(b.paid_on || '').localeCompare(String(a.paid_on || ''));
        });
      }
      var head = document.createElement('li');
      head.className = 'adm-subhead' + (g.danger ? ' danger' : '');
      head.innerHTML = g.label + ' <span class="n">' + inGroup.length + '</span>';
      listEl.appendChild(head);
      inGroup.forEach(function (inv) { listEl.appendChild(renderRow(inv, t0)); });
    });
  }

  function renderRow(inv, t0) {
    var status = effStatus(inv, t0);

    var isOpen = inv.id === expandedId;
    var li = document.createElement('li');
    li.className = 'adm-item' + (isOpen || NARROW.matches ? ' adm-item--stack' : '');
    li.setAttribute('data-inv', inv.id);

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="' +
      (status === 'overdue' ? 'var(--fg-danger)' : status === 'paid' ? 'var(--fg-success)' : 'var(--muted-2)') +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title';
    title.textContent = inv.client + ' · #' + inv.number;
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    /* The row carries only what you scan for — dates that are still in play.
       The amount used to live here too, in the same muted caption type as
       these dates; it now has its own slot in acts, matching what every
       other money figure on this page (the stat cards, Overview's own
       recent-activity rows) already does. Issue date and the note itself
       live in the editor.

       Built as an array and joined rather than concatenated with each part
       prefixed by " · " — the amount used to always occupy the first slot,
       so a leading separator could never show. With it gone, a paid invoice
       that was never given a due date (paid_on set, due_on null) would
       otherwise render " · paid …" with a stray leading separator. */
    var subParts = [];
    if (inv.due_on) {
      subParts.push(status === 'overdue'
        ? '<span class="due-over">due ' + esc(inv.due_on) + '</span>'
        : 'due ' + esc(inv.due_on));
    }
    if (inv.paid_on) subParts.push('paid ' + esc(inv.paid_on));
    if (inv.notes) subParts.push('📝');
    sub.innerHTML = subParts.join(' · ');
    sub.title = inv.notes || '';
    main.appendChild(title); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    /* var(--ink), not success/danger — an invoice amount has no income/expense
       "direction" the way a ledger transaction does. The status badge right
       next to it already carries overdue/paid; coloring the amount too would
       just double-encode the same signal. */
    var amt = document.createElement('span'); amt.className = 'fin-amt';
    amt.style.color = 'var(--ink)';
    amt.textContent = fmt(Number(inv.amount), inv.currency);
    acts.appendChild(amt);
    var badge = document.createElement('span');
    badge.className = 'badge ' + (BADGE[status] || 'badge-neutral');
    badge.textContent = status;
    acts.appendChild(badge);

    if (NEXT[status]) {
      var adv = document.createElement('button');
      adv.className = 'btn btn-sm btn-primary'; adv.type = 'button';
      adv.textContent = NEXT_LABEL[status];
      adv.addEventListener('click', function () { advance(inv, status); });
      acts.appendChild(adv);
    }

    var edit = document.createElement('button');
    edit.className = 'btn btn-sm'; edit.type = 'button';
    edit.title = isOpen ? 'Close editor' : 'Edit invoice';
    edit.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="13" height="13"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    edit.addEventListener('click', function () {
      expandedId = isOpen ? null : inv.id;
      render();
      var again = listEl.querySelector('[data-inv="' + inv.id + '"] button[aria-expanded]');
      if (again) again.focus();
    });
    acts.appendChild(edit);

    var del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger'; del.type = 'button'; del.title = 'Delete invoice';
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
    del.addEventListener('click', function () { remove(inv); });
    acts.appendChild(del);

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    if (isOpen) li.appendChild(renderDetail(inv));
    return li;
  }

  /* ── Inline editor ─────────────────────────────────────────────────── */

  function statusOptions(selected) {
    return STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
  }

  function renderDetail(inv) {
    var wrap = document.createElement('div');
    wrap.className = 'adm-item-detail';

    wrap.innerHTML =
      '<div class="row-2">' +
        '<div class="field"><label for="e-client">Client</label>' +
          '<input class="input" id="e-client" data-f="client" type="text" value="' + esc(inv.client) + '" /></div>' +
        '<div class="field"><label for="e-number">Invoice #</label>' +
          '<input class="input" id="e-number" data-f="number" type="text" value="' + esc(inv.number) + '" /></div>' +
      '</div>' +
      '<div class="row-2">' +
        '<div class="field"><label for="e-amount">Amount (' + esc(inv.currency || currency) + ')</label>' +
          '<input class="input" id="e-amount" data-f="amount" type="number" step="0.01" min="0" value="' + esc(inv.amount) + '" /></div>' +
        '<div class="field"><label for="e-status">Status</label>' +
          '<select class="input select" id="e-status" data-f="status">' + statusOptions(inv.status) + '</select>' +
          '<p class="hint">Marking it paid stamps today unless it already has a paid date.</p></div>' +
      '</div>' +
      '<div class="row-2">' +
        '<div class="field"><label for="e-issued">Issue date</label>' +
          '<input class="input" id="e-issued" data-f="issued_on" type="date" value="' + esc(inv.issued_on) + '" /></div>' +
        '<div class="field"><label for="e-due">Due date</label>' +
          '<input class="input" id="e-due" data-f="due_on" type="date" value="' + esc(inv.due_on) + '" /></div>' +
      '</div>' +
      '<div class="field"><label for="e-notes">Notes</label>' +
        '<textarea class="input" id="e-notes" data-f="notes" rows="3" placeholder="PO number, what it covers, payment terms">' + esc(inv.notes) + '</textarea></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="save" type="button">Save changes</button>' +
        '<button class="btn btn-sm" data-act="cancel" type="button">Cancel</button>' +
        '<span class="msg" data-slot="msg"></span>' +
      '</div>';

    wrap.querySelector('[data-act="save"]').addEventListener('click', function () { save(inv, wrap); });
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

  async function save(inv, wrap) {
    var patch = {};
    wrap.querySelectorAll('[data-f]').forEach(function (el) {
      var v = (el.value || '').trim();
      patch[el.getAttribute('data-f')] = v || null;
    });

    if (!patch.client)  { detailMsg(wrap, 'The client name is required.', 'err'); return; }
    if (!patch.number)  { detailMsg(wrap, 'The invoice number is required.', 'err'); return; }
    var amount = parseFloat(patch.amount);
    if (!isFinite(amount) || amount <= 0) { detailMsg(wrap, 'Enter a positive amount.', 'err'); return; }
    patch.amount = amount;
    if (patch.issued_on && patch.due_on && patch.due_on < patch.issued_on) {
      detailMsg(wrap, 'The due date cannot be before the issue date.', 'err'); return;
    }

    /* paid_on is derived, never typed: it exists exactly while the invoice is
       paid, and an already-recorded payment date is preserved. */
    patch.paid_on = patch.status === 'paid' ? (inv.paid_on || today()) : null;

    var btn = wrap.querySelector('[data-act="save"]');
    btn.disabled = true;
    var res = await window.sb.from('finance_invoices').update(patch).eq('id', inv.id);
    btn.disabled = false;
    if (res.error) { detailMsg(wrap, 'Save failed: ' + res.error.message, 'err'); return; }

    replaceRow(inv.id, patch);
    expandedId = null;
    renderStats();
    render();
    window.admin.toast('Invoice #' + patch.number + ' saved');
  }

  /* ── Row actions ───────────────────────────────────────────────────── */

  async function advance(inv, status) {
    var next = NEXT[status];
    if (!next) return;
    var patch = { status: next };
    if (next === 'sent' && !inv.issued_on) patch.issued_on = today();
    if (next === 'paid') patch.paid_on = inv.paid_on || today();

    var res = await window.sb.from('finance_invoices').update(patch).eq('id', inv.id);
    if (res.error) { setMsg('Update failed: ' + res.error.message, 'err'); return; }
    setMsg('');
    replaceRow(inv.id, patch);
    renderStats();
    render();
    window.admin.toast('#' + inv.number + ' marked ' + next);
  }

  async function remove(inv) {
    if (!confirm('Delete invoice #' + inv.number + ' for ' + inv.client + '? This cannot be undone.')) return;
    var res = await window.sb.from('finance_invoices').delete().eq('id', inv.id);
    if (res.error) { setMsg('Delete failed: ' + res.error.message, 'err'); return; }
    setMsg('');
    invoices = invoices.filter(function (x) { return x.id !== inv.id; });
    if (expandedId === inv.id) expandedId = null;
    renderStats();
    render();
    window.admin.toast('Invoice deleted');
  }

  /* Creating an invoice lives in the guided flow at /admin/invoice-new, not
     here — it renders the real PDF, shows it, and sends it to the client. The
     sticky create panel that used to sit beside this list could do none of
     that, and two ways to create the same object is one too many. */

  filtEl.addEventListener('change', function () {
    expandedId = null;
    render();
  });

  /* Re-lay the rows when the viewport crosses the wrap threshold.
     addListener is the pre-Safari-14 spelling. */
  if (NARROW.addEventListener) NARROW.addEventListener('change', render);
  else if (NARROW.addListener) NARROW.addListener(render);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
