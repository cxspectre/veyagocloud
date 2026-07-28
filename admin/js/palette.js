/* Global command palette — Cmd/Ctrl+K. Load after client.js and roles.js.

   Eighteen screens and, before this, no way to find anything: the only search
   affordance in the whole admin was a description filter on the transactions
   ledger. Everything else was "remember which list it is on, go there, scroll".

   Two kinds of result:
     screens  — static, always available, matched on label and on keywords so
                "invoice" finds Finance and "hire" finds Team
     records  — articles, apps, people, tasks and wallpapers, fetched once per
                open and filtered locally. The dataset is a few hundred rows at
                most, so one round trip on open beats a query per keystroke, and
                typing stays instant.

   Results are scoped by RLS, not by this file: an employee's invoice query
   simply returns nothing. Every fetch is allSettled so one denied table cannot
   take the palette down with it. */
(function () {
  'use strict';

  var CACHE_MS = 30000;   // re-fetch if the palette is reopened after this

  /* label is what you see; keywords are extra things people actually type. */
  var SCREENS = [
    { label: 'Home',          href: '/admin/',             keywords: 'dashboard overview start' },
    { label: 'Journal',       href: '/admin/journal',      keywords: 'articles posts writing field notes blog' },
    { label: 'New article',   href: '/admin/article',      keywords: 'write create post compose draft' },
    { label: 'Wallpapers',    href: '/admin/wallpapers',   keywords: 'images downloads backgrounds' },
    { label: 'Apps',          href: '/admin/apps',         keywords: 'products catalogue ios' },
    { label: 'Announcements', href: '/admin/announcements',keywords: 'banner notice site bar' },
    { label: 'Tasks',         href: '/admin/tasks',        keywords: 'todo board work assignments' },
    { label: 'Team',          href: '/admin/team',         keywords: 'people staff employees hire invite directory' },
    { label: 'Onboarding',    href: '/admin/onboarding',   keywords: 'new hire progress checklist' },
    { label: 'Checklist',     href: '/admin/checklist',    keywords: 'onboarding template items company' },
    { label: 'Finance',       href: '/admin/finance',      keywords: 'money revenue overview accounts' },
    { label: 'Transactions',  href: '/admin/transactions', keywords: 'ledger spend expenses payments money' },
    { label: 'Invoices',      href: '/admin/invoices',     keywords: 'billing clients owed money' },
    { label: 'Account',       href: '/admin/account',      keywords: 'password two factor mfa me profile' },
    { label: 'Settings',      href: '/admin/settings',     keywords: 'publish deploy email integrations stripe mercury' }
  ];

  /* Each source: the table, the columns to search, and how to render a hit.
     `href` returns null when a row has no detail screen, in which case the row
     still shows and lands on the list it lives in. */
  var SOURCES = [
    { kind: 'Article',  table: 'articles',   cols: 'id,title,status',
      select: function (r) { return { title: r.title || '(untitled)', sub: r.status,
        href: '/admin/article?id=' + encodeURIComponent(r.id) }; } },
    { kind: 'App',      table: 'apps',       cols: 'id,name,status',
      select: function (r) { return { title: r.name || '(unnamed)', sub: r.status,
        href: '/admin/apps-editor?id=' + encodeURIComponent(r.id) }; } },
    { kind: 'Person',   table: 'employees',  cols: 'id,full_name,email,role,status',
      select: function (r) { return { title: r.full_name || r.email, sub: r.role + ' · ' + r.status,
        href: '/admin/member?id=' + encodeURIComponent(r.id) }; } },
    { kind: 'Task',     table: 'tasks',      cols: 'id,title,status',
      select: function (r) { return { title: r.title, sub: r.status,
        href: '/admin/task?id=' + encodeURIComponent(r.id) }; } },
    { kind: 'Wallpaper',table: 'wallpapers', cols: 'id,title,status',
      select: function (r) { return { title: r.title || '(untitled)', sub: r.status,
        href: '/admin/wallpapers' }; } }
  ];

  var records = null;
  var fetchedAt = 0;
  var root, input, list, statusEl, overlay;
  var open = false, active = 0, shown = [], lastFocus = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Matching ──────────────────────────────────────────────────────
     Deliberately simple: a hit is a substring match on the haystack, and a
     match at a word boundary outranks one buried mid-word, so typing "inv"
     puts Invoices above "Consulting invoice #12". No fuzzy matching — with
     this little data it produces more surprises than it solves. */
  function score(haystack, q) {
    var h = haystack.toLowerCase();
    var i = h.indexOf(q);
    if (i === -1) return -1;
    if (i === 0) return 0;                               // best: starts with it
    if (/[\s·\-_/]/.test(h.charAt(i - 1))) return 1;     // word boundary
    return 2;                                            // buried
  }

  function search(q) {
    q = q.trim().toLowerCase();
    var out = [];

    SCREENS.forEach(function (s) {
      var best = score(s.label, q);
      if (best === -1 && s.keywords) {
        /* Keyword hits never beat a label hit. */
        best = score(s.keywords, q) === -1 ? -1 : 3;
      }
      if (best !== -1) out.push({ group: 'Go to', title: s.label, sub: '', href: s.href, rank: best });
    });

    (records || []).forEach(function (r) {
      var best = score(r.title, q);
      if (best === -1 && r.search) best = score(r.search, q) === -1 ? -1 : 3;
      if (best !== -1) out.push({ group: r.kind, title: r.title, sub: r.sub, href: r.href, rank: best + 4 });
    });

    out.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.title.localeCompare(b.title);
    });
    return out.slice(0, 40);
  }

  /* ── Data ───────────────────────────────────────────────────────── */
  async function loadRecords() {
    if (records && Date.now() - fetchedAt < CACHE_MS) return;
    if (!window.sb) { records = []; return; }

    var settled = await Promise.allSettled(SOURCES.map(function (s) {
      return window.sb.from(s.table).select(s.cols).limit(200);
    }));

    var acc = [];
    settled.forEach(function (res, i) {
      /* A table the caller cannot read is not an error worth showing — RLS is
         doing its job. Skip it and keep the rest of the palette working. */
      if (res.status !== 'fulfilled' || res.value.error) return;
      var src = SOURCES[i];
      (res.value.data || []).forEach(function (row) {
        var item = src.select(row);
        if (!item.title) return;
        acc.push({
          kind: src.kind, title: item.title, sub: item.sub || '',
          href: item.href, search: (row.email || '') + ' ' + (row.role || '')
        });
      });
    });
    records = acc;
    fetchedAt = Date.now();
  }

  /* ── Rendering ──────────────────────────────────────────────────── */
  function render() {
    if (!shown.length) {
      list.innerHTML = '';
      statusEl.textContent = input.value.trim()
        ? 'No matches for “' + input.value.trim() + '”'
        : 'Type to search screens, articles, people and tasks.';
      statusEl.hidden = false;
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    statusEl.hidden = true;

    var html = '', lastGroup = null;
    shown.forEach(function (r, i) {
      if (r.group !== lastGroup) {
        html += '<li class="cp-group" role="presentation">' + esc(r.group) + '</li>';
        lastGroup = r.group;
      }
      html += '<li class="cp-item' + (i === active ? ' active' : '') + '"' +
              ' id="cp-opt-' + i + '" role="option" aria-selected="' + (i === active) + '"' +
              ' data-i="' + i + '">' +
                '<span class="cp-title">' + esc(r.title) + '</span>' +
                (r.sub ? '<span class="cp-sub">' + esc(r.sub) + '</span>' : '') +
              '</li>';
    });
    list.innerHTML = html;
    input.setAttribute('aria-activedescendant', 'cp-opt-' + active);

    var el = list.querySelector('.cp-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function update() {
    shown = search(input.value);
    active = 0;
    render();
  }

  function go(i) {
    var r = shown[i];
    if (!r) return;
    close();
    /* window.admin.navigate validates before it moves — see client.js. */
    if (window.admin && window.admin.navigate) window.admin.navigate(r.href);
    else window.location.href = r.href;
  }

  /* ── Open / close ───────────────────────────────────────────────── */
  function build() {
    overlay = document.createElement('div');
    overlay.className = 'cp-overlay';
    overlay.hidden = true;

    root = document.createElement('div');
    root.className = 'cp';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Search the admin');

    input = document.createElement('input');
    input.className = 'cp-input';
    input.type = 'text';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'cp-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');
    input.placeholder = 'Search screens, articles, people, tasks…';

    list = document.createElement('ul');
    list.className = 'cp-list';
    list.id = 'cp-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Results');

    statusEl = document.createElement('p');
    statusEl.className = 'cp-status';
    statusEl.setAttribute('role', 'status');

    var hint = document.createElement('p');
    hint.className = 'cp-hint';
    hint.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close';

    root.appendChild(input);
    root.appendChild(statusEl);
    root.appendChild(list);
    root.appendChild(hint);
    overlay.appendChild(root);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    input.addEventListener('input', update);

    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest ? e.target.closest('.cp-item') : null;
      if (!li) return;
      e.preventDefault();
      go(parseInt(li.dataset.i, 10));
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { active = (active + 1) % shown.length; render(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active - 1 + shown.length) % shown.length; render(); } }
      else if (e.key === 'Enter') { e.preventDefault(); go(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); }   // nothing else here is focusable
    });
  }

  function openPalette() {
    if (open) return;
    if (!root) build();
    open = true;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    input.value = '';
    update();
    input.focus();
    /* Records arrive a moment later; re-filter once they do so an early
       keystroke is not stuck showing screens only. */
    loadRecords().then(function () { if (open) update(); });
  }

  function close() {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    /* Put focus back where it was, or the user is dumped at the top of the
       document with no idea where they are. */
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open ? close() : openPalette();
    }
  });

  window.adminPalette = { open: openPalette, close: close, search: search, score: score,
    _setRecords: function (r) { records = r; fetchedAt = Date.now(); } };

  /* Never on the login screen: adminReady resolves null when there is no
     session, and a search box over a sign-in form is noise at best. */
  if (window.adminReady) {
    window.adminReady.then(function (s) { if (s && !root) build(); });
  }
})();
