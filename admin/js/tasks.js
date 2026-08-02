/* Tasks page: stat strip, filter toolbar, due-date-grouped board, sticky
   new-task panel. RLS: managers edit anything, assignees update their own,
   all staff can read the board and create tasks. */
(function () {
  'use strict';

  var msg    = document.getElementById('msg');
  var listEl = document.getElementById('task-list');

  var isManager = false;
  var selfEmployee = null;
  var employees = [];   // active employees for assignment + filter
  var byId = {};        // employee id → row
  var allRows = [];     // last DB result — search re-filters this client-side

  /* One shared status machine — see task-status.js. These used to be declared
     here AND in task.js and had drifted: the board's NEXT_STATUS had no `done`
     entry, so a task could be completed from the board but only reopened from
     its own page. */
  var TS = window.adminTaskStatus;
  var STATUS_LABEL = TS.LABEL;
  var STATUS_BADGE = TS.BADGE;
  var NEXT_STATUS = TS.NEXT;
  var NEXT_LABEL  = TS.NEXT_LABEL;

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  /* Escapes for both text and quoted-attribute contexts — see team.js:esc. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function today() { return window.admin.localDate(); }

  /* 'YYYY-MM-DD' → 'Jul 30'. Built from the parts, never new Date(str): a bare
     date string parses as UTC midnight, which renders as the previous day for
     anyone west of UTC. The year is dropped because the board is a
     this-and-next-few-weeks surface; the full date rides along in the row's
     title attribute for anything genuinely far out. */
  function shortDate(d) {
    var p = String(d || '').split('-');
    if (p.length !== 3) return String(d || '');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isNaN(dt.getTime())
      ? String(d)
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* Near-term dates as scannable relative labels; further dates fall back to
     the short "Jul 30" format so the calendar stays legible. */
  function relativeDate(d, t0) {
    if (!d) return '';
    var p  = String(d).split('-');
    var p0 = String(t0).split('-');
    if (p.length !== 3 || p0.length !== 3) return shortDate(d);
    var dt = new Date(Number(p[0]),  Number(p[1])  - 1, Number(p[2]));
    var td = new Date(Number(p0[0]), Number(p0[1]) - 1, Number(p0[2]));
    if (isNaN(dt.getTime()) || isNaN(td.getTime())) return shortDate(d);
    var diff = Math.round((dt - td) / 86400000);
    if (diff === 0)  return 'today';
    if (diff === 1)  return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff >= 2  && diff <= 13)  return 'in ' + diff + ' days';
    if (diff <= -2 && diff >= -13) return Math.abs(diff) + ' days ago';
    return shortDate(d);
  }

  /* Applied on top of the DB-filtered result set so text search is instant
     without an extra round-trip. Searches title and details. */
  function filterRows(rows) {
    var el = document.getElementById('f-search');
    var q = el ? (el.value || '').trim().toLowerCase() : '';
    if (!q) return rows;
    return rows.filter(function (t) {
      return (t.title   || '').toLowerCase().indexOf(q) !== -1 ||
             (t.details || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  async function load() {
    isManager    = await window.adminRoles.isManager();
    selfEmployee = await window.adminRoles.employee();

    var emps = await window.sb.from('employees')
      .select('id,full_name,status').neq('status', 'inactive').order('full_name');
    if (emps.error) { setMsg('Could not load team: ' + emps.error.message, 'err'); return; }
    employees = emps.data || [];
    byId = {};
    employees.forEach(function (e) { byId[e.id] = e; });
    /* Mine button is only useful when there is an employee row to filter to. */
    var mineBtn = document.getElementById('f-mine');
    if (mineBtn && selfEmployee) mineBtn.hidden = false;

    fillSelects();
    await Promise.all([loadStats(), loadTasks()]);
  }

  function fillSelects() {
    var assignSel = document.getElementById('t-assignee');
    var filterSel = document.getElementById('f-assignee');
    if (assignSel) {
      assignSel.innerHTML = '<option value="">Unassigned</option>';
      employees.forEach(function (e) {
        var o = document.createElement('option'); o.value = e.id; o.textContent = e.full_name;
        assignSel.appendChild(o);
      });
      if (!isManager && selfEmployee) assignSel.value = selfEmployee.id;
    }
    if (filterSel && filterSel.options.length <= 1) {
      employees.forEach(function (e) {
        var o = document.createElement('option'); o.value = e.id; o.textContent = e.full_name;
        filterSel.appendChild(o);
      });
    }
    /* Seeded from the URL — both the ?assignee= deep link the Team page has
       always produced (member.js), and now ?status= too. Outside the
       options.length guard: the guard exists so the option list is built once,
       but the selection has to be re-applied whenever the URL says so. */
    readFilters();
  }

  /* ── Stat strip (always unfiltered) ────────────────────────────────── */

  async function loadStats() {
    var wrap = document.getElementById('task-stats');
    if (!wrap) return;
    var res = await window.sb.from('tasks').select('status,due_date,completed_at').limit(2000);
    if (res.error) return;
    var rows = res.data || [];
    var t = today();
    var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    var open    = rows.filter(function (r) { return r.status !== 'done'; }).length;
    var overdue = rows.filter(function (r) { return r.status !== 'done' && r.due_date && r.due_date < t; }).length;
    var blocked = rows.filter(function (r) { return r.status === 'blocked'; }).length;
    var doneWk  = rows.filter(function (r) { return r.status === 'done' && r.completed_at && r.completed_at >= weekAgo; }).length;

    /* Tokens, not hex. Every value here duplicated one admin.css already
       defines — and '#86868b' was the grey the token block explicitly
       RETIRED for failing AA on this background ("3.33:1 ... below AA",
       admin.css:69-72), reintroduced by hand.

       Open and Blocked link to the filter that shows exactly them, so a number
       you are looking at is a way in rather than a dead end. The other two
       stay unlinked ON PURPOSE, because no filter expresses them: `overdue`
       is derived from due_date and is not a status, and the Done filter is not
       time-bounded so it would answer "everything ever finished" rather than
       "this week". A link that lands somewhere adjacent is worse than none —
       and overdue tasks are already the first group on the board below. */
    window.admin.statCards(wrap, [
      { n: open, label: 'Open', color: 'var(--blue-2)', n2: 'still to do',
        href: '/admin/tasks?status=open',
        icon: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>' },
      { n: overdue, label: 'Overdue', color: overdue ? 'var(--ac-danger)' : 'var(--muted-2)',
        n2: overdue ? 'past their due date' : 'nothing late',
        n2Color: overdue ? 'var(--fg-danger)' : null,
        icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
      { n: blocked, label: 'Blocked', color: blocked ? 'var(--ac-warn)' : 'var(--muted-2)',
        n2: blocked ? 'needs unblocking' : 'nothing stuck',
        href: '/admin/tasks?status=blocked',
        icon: '<circle cx="12" cy="12" r="9"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>' },
      { n: doneWk, label: 'Done this week', color: 'var(--ac-success)', n2: 'completed in 7 days',
        icon: '<polyline points="20 6 9 17 4 12"/>' }
    ]);
  }

  /* ── Board ─────────────────────────────────────────────────────────── */

  async function loadTasks(highlightId) {
    var status   = document.getElementById('f-status').value;
    var assignee = document.getElementById('f-assignee').value;

    var q = window.sb.from('tasks')
      .select('id,title,details,assignee_id,status,priority,due_date,completed_at')
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (status === 'open') q = q.neq('status', 'done');
    else if (status !== 'all') q = q.eq('status', status);
    if (assignee !== 'all') q = q.eq('assignee_id', assignee);

    var res = await q;
    if (res.error) { setMsg('Could not load tasks: ' + res.error.message, 'err'); return; }
    allRows = res.data || [];
    render(filterRows(allRows), highlightId);
  }

  /* ── Filters live in the URL ─────────────────────────────────────────
     They used to live only in the two <select> elements, which meant opening
     a task and coming back reset your triage, and no filtered view could be
     shared, bookmarked or reloaded. */

  /* Only the values the markup actually offers. An unvalidated ?status=xyz
     sets select.value to '' and loadTasks then issues .eq('status','') —
     which Postgres rejects as an invalid enum, so a bad link produced
     "Could not load tasks: invalid input value for enum" rather than a
     board. */
  function validStatus(v) {
    var sel = document.getElementById('f-status');
    if (!v || !sel) return false;
    /* Compared against the option VALUES directly rather than built into a
       selector string — that is what the assignee lookup used to do, and a
       crafted `?assignee=a"]` threw a SyntaxError out of querySelector and
       left the board stuck on skeletons. No selector, nothing to escape,
       nothing to throw. */
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) return true;
    }
    return false;
  }

  function writeFilters() {
    var status = document.getElementById('f-status').value;
    var assignee = document.getElementById('f-assignee').value;
    var searchEl = document.getElementById('f-search');
    var search = searchEl ? (searchEl.value || '').trim() : '';
    var q = new URLSearchParams();
    /* Defaults are omitted so the everyday URL stays a clean /admin/tasks. */
    if (status && status !== 'open') q.set('status', status);
    if (assignee && assignee !== 'all') q.set('assignee', assignee);
    if (search) q.set('q', search);
    var qs = q.toString();
    /* location.pathname, not a literal — the page still works when reached
       as /admin/tasks.html. replaceState, not push: changing a filter is not
       a place you should have to press Back through. */
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  function readFilters() {
    var params = new URLSearchParams(window.location.search);
    var statusSel = document.getElementById('f-status');
    var wantStatus = params.get('status');
    if (validStatus(wantStatus)) statusSel.value = wantStatus;

    var filterSel = document.getElementById('f-assignee');
    var wanted = params.get('assignee');
    /* A direct lookup against the loaded employees, NOT a built selector
       string: `?assignee=a"]` used to throw a SyntaxError out of
       querySelector and strand the board on skeletons forever. */
    if (wanted && byId[wanted]) {
      filterSel.value = wanted;
    } else if (params.get('mine') === '1' && selfEmployee) {
      filterSel.value = selfEmployee.id;
      var mb = document.getElementById('f-mine');
      if (mb) mb.classList.add('btn-primary');
    }

    var searchEl = document.getElementById('f-search');
    var wantQ = params.get('q');
    if (wantQ && searchEl) searchEl.value = wantQ;
  }

  /* Bucket open tasks by urgency; done tasks get their own group. */
  function groupOf(t0, task) {
    if (task.status === 'done') return 'done';
    if (!task.due_date) return 'nodate';
    if (task.due_date < t0) return 'overdue';
    if (task.due_date === t0) return 'today';
    var weekOut = window.admin.localDate(7);
    if (task.due_date <= weekOut) return 'week';
    return 'later';
  }

  var GROUPS = [
    { key: 'overdue', label: 'Overdue',     danger: true },
    { key: 'today',   label: 'Due today' },
    { key: 'week',    label: 'This week' },
    { key: 'later',   label: 'Later' },
    { key: 'nodate',  label: 'No due date' },
    { key: 'done',    label: 'Done' }
  ];

  function render(rows, highlightId) {
    if (!listEl) return;
    var countEl = document.getElementById('task-count');
    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? ' task' : ' tasks');
    if (!rows.length) {
      var filtered = document.getElementById('f-status').value !== 'open' ||
                     document.getElementById('f-assignee').value !== 'all';
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          (filtered
            /* "create a task on the right" was wrong twice over: it pointed at
               a panel that has moved, and it was already wrong below 880px
               where the split collapses and nothing is on the right. */
            ? '<p>No tasks match these filters.</p>'
            : '<p>Nothing here — enjoy the quiet, or add one above.</p>') +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    var t0 = today();
    var buckets = {};
    rows.forEach(function (task) {
      var g = groupOf(t0, task);
      (buckets[g] = buckets[g] || []).push(task);
    });

    GROUPS.forEach(function (g) {
      var inGroup = buckets[g.key];
      if (!inGroup || !inGroup.length) return;
      /* Within a due-date bucket, urgent before low. The query orders by due
         date, which is the right primary key for a board about deadlines —
         this is only the tiebreak, so an urgent task no longer sits below a
         low one that happened to be created earlier. slice() first: never
         sort the caller's array in place. */
      inGroup = inGroup.slice().sort(function (a, b) {
        return TS.priorityRank(a.priority) - TS.priorityRank(b.priority);
      });
      var head = document.createElement('li');
      head.className = 'adm-subhead' + (g.danger ? ' danger' : '');
      head.innerHTML = g.label + ' <span class="n">' + inGroup.length + '</span>';
      listEl.appendChild(head);
      inGroup.forEach(function (task) { listEl.appendChild(renderRow(task, t0)); });
    });

    /* A quick-added task lands in "No due date", well down the page. Take the
       reader to it rather than leaving them to wonder whether it saved. */
    if (highlightId) {
      var row = listEl.querySelector('[data-task="' + highlightId + '"]');
      if (row) {
        row.classList.add('is-new');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function renderRow(t, t0) {
    var li = document.createElement('li');
    li.setAttribute('data-task', t.id);
    li.className = 'adm-item' +
      (t.status !== 'done' && t.priority === 'urgent' ? ' pri-urgent' : '') +
      (t.status !== 'done' && t.priority === 'high' ? ' pri-high' : '');

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = t.status === 'done'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="var(--fg-success)" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
    if (t.status === 'done') { title.style.textDecoration = 'line-through'; title.style.color = 'var(--muted)'; }
    /* The title opens the task's own page, where editing, history and delete
       live. The row keeps its quick-actions so the board stays fast for bulk
       work — you should never have to open a task just to tick it off. */
    var titleLink = document.createElement('a');
    titleLink.className = 'adm-item--link';
    titleLink.href = '/admin/task?id=' + encodeURIComponent(t.id);
    titleLink.appendChild(title);
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    var who = t.assignee_id && byId[t.assignee_id] ? byId[t.assignee_id].full_name : 'Unassigned';
    var overdue = t.status !== 'done' && t.due_date && t.due_date < t0;
    /* "Jul 30", not "2026-07-30". The sub-line is one nowrap ellipsis line
       shared by three facts, so the raw ISO date was spending ten characters
       — and the year, which is nearly always this year — on the least
       surprising part, and `details` was the segment that always got clipped
       as a result. */
    sub.innerHTML = esc(who) +
      (t.due_date ? ' · <span' + (overdue ? ' class="due-over"' : '') + '>due ' + esc(relativeDate(t.due_date, t0)) + '</span>' : '') +
      (t.details ? ' · ' + esc(t.details) : '');
    sub.title = [who, t.due_date ? 'due ' + t.due_date : null, t.details].filter(Boolean).join(' · ');
    main.appendChild(titleLink); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    /* Priority used to be conveyed ONLY by a 3px edge tint, and only for
       urgent and high — so low and normal were indistinguishable from each
       other and from a task with no priority at all. The badge names it. Only
       the two that mean "look at me" get one: a badge on every row would be
       four badges of noise and would say nothing. */
    if (t.status !== 'done' && TS.PRIORITY_BADGE[t.priority]) {
      var pb = document.createElement('span');
      pb.className = 'badge ' + TS.PRIORITY_BADGE[t.priority];
      pb.textContent = TS.PRIORITY_LABEL[t.priority] || t.priority;
      acts.appendChild(pb);
    }
    var sb2 = document.createElement('span');
    sb2.className = 'badge ' + STATUS_BADGE[t.status]; sb2.textContent = STATUS_LABEL[t.status];
    acts.appendChild(sb2);

    var canEdit = isManager || (selfEmployee && t.assignee_id === selfEmployee.id);
    if (canEdit && NEXT_STATUS[t.status]) {
      var adv = document.createElement('button');
      adv.className = 'btn btn-sm btn-primary'; adv.type = 'button';
      adv.textContent = NEXT_LABEL[t.status];
      adv.addEventListener('click', function () { setStatus(t, NEXT_STATUS[t.status]); });
      acts.appendChild(adv);
    }
    if (canEdit && t.status !== 'blocked' && t.status !== 'done') {
      var blk = document.createElement('button');
      blk.className = 'btn btn-sm'; blk.type = 'button'; blk.title = 'Mark blocked';
      blk.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="13" height="13"><circle cx="12" cy="12" r="9"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/></svg>';
      blk.addEventListener('click', function () { setStatus(t, 'blocked'); });
      acts.appendChild(blk);
    }
    if (isManager) {
      var del = document.createElement('button');
      del.className = 'btn btn-sm btn-danger'; del.type = 'button'; del.title = 'Delete task';
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      del.addEventListener('click', function () { remove(t); });
      acts.appendChild(del);
    }

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    return li;
  }

  async function setStatus(t, status) {
    var patch = { status: status, completed_at: status === 'done' ? new Date().toISOString() : null };
    /* Read the row back. Without .select(), RLS refusing the update is
       indistinguishable from success — PostgREST returns no error for an
       UPDATE that matched no rows, so the board silently reloaded unchanged
       and the button appeared to do nothing at all. */
    var res = await window.sb.from('tasks').update(patch).eq('id', t.id)
      .select('id,status').maybeSingle();
    if (res.error) { setMsg('Update failed: ' + res.error.message, 'err'); return; }
    if (!res.data) {
      setMsg('That task was not changed — you may not have permission to move it.', 'err');
      return;
    }
    setMsg('');
    window.admin.toast(TS.movedToast(status));
    /* Notify the task creator when something they care about changes.
       Best-effort — not awaited, and a mail problem must not shadow the update. */
    if (status === 'done' || status === 'blocked') {
      window.adminTaskNotify.notify(t.id, null, status);
    }
    loadStats();
    loadTasks();
  }

  async function remove(t) {
    if (!confirm('Delete task "' + t.title + '"? This cannot be undone.')) return;
    var res = await window.sb.from('tasks').delete().eq('id', t.id);
    if (res.error) { setMsg('Delete failed: ' + res.error.message, 'err'); return; }
    loadStats();
    loadTasks();
  }

  /* ── Quick add ──────────────────────────────────────────────────────
     One line at the top of the board: a title, and that is the whole
     interaction. It replaced a permanently-mounted 340px side panel that was
     empty almost all of the time, and a "+ New task" button that navigated
     nowhere — it smooth-scrolled the panel into view, which on a narrow
     screen meant scrolling past the entire board to reach the bottom of the
     page.

     THIS PATH CAN NEVER EMAIL ANYONE, and that is the point. The task is
     assigned to you (or to nobody, for a legacy admin with no employees row),
     and notify-task skips both cases on its own — 'self-assigned' and
     'unassigned'. So there is nothing to disclose and nothing to confirm,
     which is what makes it safe to fire fifteen times a day. Handing work to
     somebody else is a different act with a different cost, and it lives on
     /admin/task-new where the email is named before you commit to it. */

  var quickForm = document.getElementById('quick-add');
  if (quickForm) {
    quickForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var input = document.getElementById('q-title');
      var title = (input.value || '').trim();
      if (!title) { input.focus(); return; }

      var dueEl = document.getElementById('q-due');
      var dueDate = dueEl ? (dueEl.value || '') : '';
      var btn = document.getElementById('q-add-btn');
      btn.disabled = true;
      var session = await window.admin.session();
      /* Only include due_date when one was chosen — omitting the key lets the
         DB default apply and keeps the existing test for the no-date case
         stable. A non-empty value passes through unchanged. */
      var insertData = {
        title: title,
        assignee_id: selfEmployee ? selfEmployee.id : null,
        created_by: session ? session.user.id : null,
      };
      if (dueDate) insertData.due_date = dueDate;
      var res = await window.sb.from('tasks').insert(insertData).select('id').single();
      btn.disabled = false;

      if (res.error) { setMsg('Could not add that task: ' + res.error.message, 'err'); return; }

      input.value = '';
      if (dueEl) dueEl.value = '';
      input.focus();
      setMsg('');
      window.admin.toast('Task added');
      loadStats();
      /* A quick-added task has no due date, so it lands in 'No due date' —
         fifth of six groups, well down the page. Highlight it rather than
         inventing a due date it does not have. */
      loadTasks(res.data && res.data.id);
    });
  }

  function onFilterChange() { writeFilters(); loadTasks(); }
  document.getElementById('f-status').addEventListener('change', onFilterChange);
  document.getElementById('f-assignee').addEventListener('change', onFilterChange);

  /* Mine: toggles the assignee filter between self and everyone. Active state
     mirrors the dropdown — btn-primary when the filter is set to you. The
     button itself is hidden until load() resolves selfEmployee. */
  var mineBtn = document.getElementById('f-mine');
  if (mineBtn) {
    mineBtn.addEventListener('click', function () {
      if (!selfEmployee) return;
      var sel = document.getElementById('f-assignee');
      sel.value = sel.value === selfEmployee.id ? 'all' : selfEmployee.id;
      /* Visual feedback: primary when active, default when toggled off. */
      mineBtn.classList.toggle('btn-primary', sel.value === selfEmployee.id);
      onFilterChange();
    });
  }

  /* Search filters the already-loaded rows client-side — no new DB query. */
  var searchEl = document.getElementById('f-search');
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      writeFilters();
      render(filterRows(allRows));
    });
  }

  /* Coming back via the browser's Back button restores this page from the
     bfcache with its DOM intact — including a task list that may now be
     wrong, because it was edited on the page you just came back from.

     loadStats + loadTasks, deliberately NOT load(): load() re-runs
     fillSelects, which would rebuild the assignee filter and re-apply
     readFilters over whatever the user had just chosen. The data is what went
     stale, not the chrome. */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { loadStats(); loadTasks(); }
  });

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
