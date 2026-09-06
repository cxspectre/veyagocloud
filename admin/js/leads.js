/* Leads — /admin/leads. Every Get-a-quote enquiry from /websites/ and
   /services/, newest first, and the small amount of state that turns an
   enquiry into an answered one: a status, some notes, a follow-up date.

   Managers only — guarded here and enforced by RLS. 0019 lets managers read;
   0020 lets them update status, notes and next_follow_up_on and nothing else,
   and it is the column grant, not this file, that stops a browser rewriting
   what the visitor wrote.

   Deliberately not a CRM. The reply itself happens in your mail client (the
   Reply button is a mailto: with the reference in the subject), the follow-up
   task the Edge Function created sits on the board like any other work, and a
   lead lives here until it is won, lost or spam. Each row opens in place —
   one screen of facts and three small edits does not earn its own page. */
(function () {
  'use strict';

  var msg    = document.getElementById('msg');
  var listEl = document.getElementById('lead-list');

  var allRows = [];        // last DB result — replaced, never mutated
  var expandedId = null;   // the one open row
  var totalCount = 0;      // every lead, any status — tells "nothing open" from "nothing yet"

  var SELECT_COLS = 'id,kind,name,email,business,website,message,locale,page,package,' +
                    'status,notes,next_follow_up_on,notified_at,ack_sent_at,created_at';

  /* The states are the database's (0019's CHECK constraint); this is only what
     to call each one and how loud to be about it:
     amber = needs a reply, blue = in flight, green = won, grey = closed. */
  var STATUSES = ['new', 'replied', 'quoted', 'won', 'lost', 'spam'];
  var OPEN_STATUSES = ['new', 'replied', 'quoted'];
  var STATUS_LABEL = { new: 'New', replied: 'Replied', quoted: 'Quoted', won: 'Won', lost: 'Lost', spam: 'Spam' };
  var STATUS_BADGE = { new: 'badge-warn', replied: 'badge-info', quoted: 'badge-info', won: 'badge-success', lost: 'badge-neutral', spam: 'badge-neutral' };
  var KIND_LABEL = { website: 'Website', product: 'Project' };
  /* Mirrors PACKAGE_LABEL in supabase/functions/_shared/enquiry.ts. */
  var PACKAGE_LABEL = { launch: 'Launch', business: 'Business', backoffice: 'Back office', unsure: 'Not sure yet' };

  var ICON = {
    website: '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
    product: '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>'
  };
  var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="6 9 12 15 18 9"/></svg>';
  var EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>';

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function today() { return window.admin.localDate(); }

  function timeAgo(iso) {
    if (!iso) return '';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 2880) return Math.round(mins / 60) + 'h ago';
    if (mins < 43200) return Math.round(mins / 1440) + 'd ago';
    return fmtStamp(iso, true);
  }

  /* Full timestamptz → 'Jul 30, 2026, 2:05 PM' (or just the day). */
  function fmtStamp(iso, dayOnly) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return '';
    return dayOnly
      ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function packageLabel(p) { return p && Object.prototype.hasOwnProperty.call(PACKAGE_LABEL, p) ? PACKAGE_LABEL[p] : ''; }
  function whereFrom(l) { return [(l.locale || 'en').toUpperCase(), l.page].filter(Boolean).join(' '); }
  function isOpen(l) { return OPEN_STATUSES.indexOf(l.status) !== -1; }

  /* mailto: with the reference in the subject, so the thread that comes back
     can be matched to the lead. The address is percent-encoded except for the
     @, so a crafted local part cannot smuggle a second header in. */
  function replyHref(l) {
    var what = l.kind === 'product' ? 'project' : 'website';
    return 'mailto:' + encodeURIComponent(l.email).replace(/%40/g, '@') +
      '?subject=' + encodeURIComponent('Re: your ' + what + ' enquiry (ref ' + l.id + ')');
  }

  /* ── Filters live in the URL, like the task board ────────────────────── */

  function filterValue() { return document.getElementById('f-status').value; }

  function readFilters() {
    var params = new URLSearchParams(window.location.search);
    var sel = document.getElementById('f-status');
    if (params.get('status') === 'all') sel.value = 'all';
    /* The follow-up task carries /admin/leads?id=<uuid>; open that row. Only
       an id-shaped value is honoured — it goes into a selector later. */
    var id = params.get('id');
    if (id && /^[A-Za-z0-9-]{1,64}$/.test(id)) expandedId = id;
  }

  function writeFilters() {
    var q = new URLSearchParams();
    if (filterValue() !== 'open') q.set('status', filterValue());
    if (expandedId) q.set('id', expandedId);
    var qs = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  /* ── Load ────────────────────────────────────────────────────────────── */

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;
    readFilters();
    /* Stats first: the empty state needs the total to say the right thing. */
    await loadStats();
    await loadLeads();
  }

  async function loadStats() {
    var wrap = document.getElementById('lead-stats');
    var res = await window.sb.from('website_enquiries').select('status,next_follow_up_on').limit(2000);
    if (res.error) return;
    var rows = res.data || [];
    var t = today();
    totalCount = rows.length;
    var fresh = rows.filter(function (r) { return r.status === 'new'; }).length;
    var open  = rows.filter(isOpen).length;
    var due   = rows.filter(function (r) { return isOpen(r) && r.next_follow_up_on && r.next_follow_up_on <= t; }).length;
    var won   = rows.filter(function (r) { return r.status === 'won'; }).length;
    if (!wrap) return;
    window.admin.statCards(wrap, [
      { n: fresh, label: 'New', color: fresh ? 'var(--ac-warn)' : 'var(--muted-2)',
        n2: fresh ? 'waiting for a reply' : 'all answered', href: '/admin/leads',
        icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/>' },
      { n: open, label: 'Open', color: 'var(--blue-2)', n2: 'in conversation', href: '/admin/leads',
        icon: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>' },
      { n: due, label: 'Follow-ups due', color: due ? 'var(--ac-danger)' : 'var(--muted-2)',
        n2: due ? 'today or overdue' : 'nothing due', n2Color: due ? 'var(--fg-danger)' : null,
        icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
      { n: won, label: 'Won', color: 'var(--ac-success)', n2: 'all time', href: '/admin/leads?status=all',
        icon: '<polyline points="20 6 9 17 4 12"/>' }
    ]);
  }

  async function loadLeads() {
    var q = window.sb.from('website_enquiries').select(SELECT_COLS)
      .order('created_at', { ascending: false });
    if (filterValue() === 'open') q = q.in('status', OPEN_STATUSES);
    var res = await q;
    if (res.error) { setMsg('Could not load leads: ' + res.error.message, 'err'); return; }
    allRows = res.data || [];
    render(allRows);
    if (expandedId) {
      var row = listEl.querySelector('[data-lead="' + expandedId + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    }
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  /* The DB filter is re-applied client-side so a row that just left the
     "open" set (marked won, lost or spam) disappears without a reload. */
  function visible(rows) {
    return filterValue() === 'open' ? rows.filter(isOpen) : rows;
  }

  function render(rows) {
    if (!listEl) return;
    rows = visible(rows);
    var countEl = document.getElementById('lead-count');
    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? ' lead' : ' leads');
    if (!rows.length) {
      var copy = !totalCount
        ? 'No enquiries yet. When someone asks for a quote on the site, it lands here first.'
        : filterValue() === 'open'
          ? 'Nothing open — every enquiry has been answered or closed.'
          : 'No enquiries to show.';
      listEl.innerHTML = '<li class="dash-empty-state">' + EMPTY_ICON + '<p></p></li>';
      listEl.querySelector('p').textContent = copy;
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (l) { listEl.appendChild(renderRow(l)); });
  }

  function badge(cls, text, title) {
    var b = el('span', 'badge ' + cls, text);
    if (title) b.title = title;
    return b;
  }

  function renderRow(l) {
    var open = l.id === expandedId;
    var li = el('li', 'adm-item adm-item--stack');
    li.setAttribute('data-lead', l.id);
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-expanded', open ? 'true' : 'false');
    li.setAttribute('aria-label', l.name + ' — ' + (open ? 'close' : 'open') + ' enquiry');
    li.style.cursor = 'pointer';

    var icon = el('div', 'adm-item-icon');
    icon.innerHTML = ICON[l.kind] || ICON.website;

    var main = el('div', 'adm-item-main');
    main.appendChild(el('div', 'adm-item-title', l.name + (l.business ? ' · ' + l.business : '')));
    var sub = el('div', 'adm-item-sub',
      [timeAgo(l.created_at), KIND_LABEL[l.kind] || l.kind, packageLabel(l.package), whereFrom(l)].filter(Boolean).join(' · '));
    sub.title = fmtStamp(l.created_at) + ' · ' + l.email;
    main.appendChild(sub);

    var acts = el('div', 'adm-item-acts');
    /* Two delivery flags. Red because "we were never told" is the one failure
       that turns a lead into a stranger who was ignored; the missing
       acknowledgement is grey because we can still reply, just without the
       visitor having been told to expect it. */
    if (!l.notified_at) acts.appendChild(badge('badge-danger', 'not notified', 'The email to us did not go out. Nobody was told about this enquiry until now.'));
    if (!l.ack_sent_at) acts.appendChild(badge('badge-neutral', 'no acknowledgement', 'The visitor did not get the confirmation email.'));
    if (l.next_follow_up_on && isOpen(l) && l.next_follow_up_on <= today()) {
      acts.appendChild(badge('badge-danger', 'follow up', 'Follow-up due ' + l.next_follow_up_on));
    }
    acts.appendChild(badge(STATUS_BADGE[l.status] || 'badge-neutral', STATUS_LABEL[l.status] || l.status));
    var chev = el('span', 'chev' + (open ? ' open' : ''));
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = CHEVRON;
    acts.appendChild(chev);

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    if (open) li.appendChild(renderDetail(l));

    function toggle() {
      expandedId = expandedId === l.id ? null : l.id;
      writeFilters();
      render(allRows);
      var again = listEl.querySelector('[data-lead="' + l.id + '"]');
      if (again) again.focus();
    }
    li.addEventListener('click', function (ev) {
      /* The panel is full of controls; only the row itself toggles. */
      if (ev.target.closest('.adm-item-detail')) return;
      toggle();
    });
    li.addEventListener('keydown', function (ev) {
      if (ev.target !== li) return;
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();      // Space would scroll the page
        toggle();
      }
    });
    return li;
  }

  /* ── Detail panel ────────────────────────────────────────────────────── */

  function renderDetail(l) {
    var box = el('div', 'adm-item-detail');
    /* Keys pressed in the notes field belong to the notes field. */
    box.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
    var split = el('div', 'adm-split adm-split--wide');
    var left = el('div', 'u-min0');
    var right = el('div', 'u-min0');
    left.appendChild(facts(l));
    right.appendChild(replyBlock(l));
    right.appendChild(statusBlock(l));
    right.appendChild(notesForm(l));
    split.appendChild(left); split.appendChild(right);
    box.appendChild(split);
    return box;
  }

  function link(href, text, external) {
    var a = el('a', null, text);
    a.href = href;
    a.style.color = 'var(--blue)';
    if (external) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  }

  function facts(l) {
    var dl = el('dl', 'adm-facts');
    function row(label, value) {
      dl.appendChild(el('dt', null, label));
      var dd = el('dd');
      if (typeof value === 'string') dd.textContent = value; else dd.appendChild(value);
      dl.appendChild(dd);
    }
    row('Email', link('mailto:' + encodeURIComponent(l.email).replace(/%40/g, '@'), l.email));
    row('Business', l.business || '—');
    row('Website', l.website
      ? (/^https?:\/\//i.test(l.website) ? link(l.website, l.website, true) : l.website)
      : '—');
    row('Package', packageLabel(l.package) || 'Not chosen');
    if (l.message) {
      var m = el('div', null, l.message);
      m.style.whiteSpace = 'pre-wrap';
      m.style.wordBreak = 'break-word';
      row('Message', m);
    } else {
      row('Message', '—');
    }
    row('Sent from', whereFrom(l) || 'unknown');
    row('Received', fmtStamp(l.created_at));
    row('Notified', l.notified_at ? fmtStamp(l.notified_at) : 'not sent — check the email log on Settings');
    row('Acknowledged', l.ack_sent_at ? fmtStamp(l.ack_sent_at) : 'not sent');
    var ref = el('code', null, l.id);
    ref.style.fontSize = 'var(--t-small)';
    row('Reference', ref);
    return dl;
  }

  function replyBlock(l) {
    var wrap = el('div', 'field');
    var a = el('a', 'btn btn-primary', 'Reply');
    a.href = replyHref(l);
    a.setAttribute('data-reply', '');
    wrap.appendChild(a);
    wrap.appendChild(el('p', 'hint', 'Opens your mail client with the reference in the subject. Mark the lead replied once it has gone.'));
    return wrap;
  }

  function statusBlock(l) {
    var wrap = el('div', 'field');
    wrap.appendChild(el('label', null, 'Status'));
    var chips = el('div', 'adm-actions');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Status');
    STATUSES.forEach(function (s) {
      var b = el('button', 'btn btn-sm' + (s === l.status ? ' btn-primary' : ''), STATUS_LABEL[s]);
      b.type = 'button';
      b.setAttribute('data-status', s);
      b.setAttribute('aria-pressed', s === l.status ? 'true' : 'false');
      b.addEventListener('click', function () { if (s !== l.status) setStatus(l, s); });
      chips.appendChild(b);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  function notesForm(l) {
    var form = el('form');
    form.setAttribute('data-notes-form', l.id);

    var f1 = el('div', 'field');
    var lab1 = el('label', null, 'Notes');
    lab1.htmlFor = 'notes-' + l.id;
    var ta = el('textarea', 'input');
    ta.id = 'notes-' + l.id;
    ta.rows = 4;
    ta.placeholder = 'What they need, what you quoted, what was agreed.';
    ta.value = l.notes || '';
    f1.appendChild(lab1); f1.appendChild(ta);

    var f2 = el('div', 'field');
    var lab2 = el('label', null, 'Next follow-up');
    lab2.htmlFor = 'follow-' + l.id;
    var date = el('input', 'input');
    date.id = 'follow-' + l.id;
    date.type = 'date';
    date.value = l.next_follow_up_on || '';
    f2.appendChild(lab2); f2.appendChild(date);
    f2.appendChild(el('p', 'hint', 'Shows up as a red "follow up" flag on the day, and counts under Follow-ups due.'));

    var actions = el('div', 'form-actions');
    var btn = el('button', 'btn btn-sm', 'Save notes');
    btn.type = 'submit';
    var m = el('span', 'msg');
    m.setAttribute('role', 'status');
    actions.appendChild(btn); actions.appendChild(m);

    form.appendChild(f1); form.appendChild(f2); form.appendChild(actions);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveNotes(l, ta.value, date.value, btn, m);
    });
    return form;
  }

  /* ── Writes ──────────────────────────────────────────────────────────── */

  /* Read the row back. Without .select(), RLS refusing the update is
     indistinguishable from success — PostgREST returns no error for an UPDATE
     that matched no rows. */
  async function patchLead(l, patch) {
    var res = await window.sb.from('website_enquiries').update(patch).eq('id', l.id)
      .select(SELECT_COLS).maybeSingle();
    if (res.error) { setMsg('Could not save: ' + res.error.message, 'err'); return null; }
    if (!res.data) { setMsg('That lead was not changed — you may not have permission to.', 'err'); return null; }
    setMsg('');
    return res.data;
  }

  function replaceRow(row) {
    allRows = allRows.map(function (r) { return r.id === row.id ? row : r; });
    render(allRows);
    var again = listEl.querySelector('[data-lead="' + row.id + '"]');
    if (again) again.focus();
  }

  async function setStatus(l, status) {
    var row = await patchLead(l, { status: status });
    if (!row) return;
    replaceRow(row);
    window.admin.toast('Marked ' + (STATUS_LABEL[status] || status).toLowerCase());
    loadStats();
  }

  async function saveNotes(l, notes, date, btn, msgEl) {
    btn.disabled = true;
    var row = await patchLead(l, {
      notes: (notes || '').trim() || null,
      next_follow_up_on: date || null
    });
    btn.disabled = false;
    if (!row) { msgEl.textContent = 'Not saved.'; msgEl.className = 'msg err'; return; }
    replaceRow(row);
    window.admin.toast('Notes saved');
    loadStats();
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  document.getElementById('f-status').addEventListener('change', function () {
    writeFilters();
    loadLeads();
  });

  /* Back button restores the page from the bfcache with a list that may now
     be stale — the row you just edited on another tab, for instance. */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { loadStats(); loadLeads(); }
  });

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
