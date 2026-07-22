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

  var STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  var STATUS_BADGE = { todo: 'badge-inactive', in_progress: 'badge-scheduled', blocked: 'badge-draft', done: 'badge-published' };
  var NEXT_STATUS = { todo: 'in_progress', in_progress: 'done', blocked: 'in_progress' };
  var NEXT_LABEL  = { todo: 'Start', in_progress: 'Complete', blocked: 'Unblock' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  async function load() {
    isManager    = await window.adminRoles.isManager();
    selfEmployee = await window.adminRoles.employee();

    var emps = await window.sb.from('employees')
      .select('id,full_name,status').neq('status', 'inactive').order('full_name');
    if (emps.error) { setMsg('Could not load team: ' + emps.error.message, 'err'); return; }
    employees = emps.data || [];
    byId = {};
    employees.forEach(function (e) { byId[e.id] = e; });
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
      /* Deep link from the Team page: /admin/tasks?assignee=<id> */
      var wanted = new URLSearchParams(window.location.search).get('assignee');
      if (wanted && filterSel.querySelector('option[value="' + wanted + '"]')) filterSel.value = wanted;
    }
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

    var cards = [
      { n: open,    l: 'Open' },
      { n: overdue, l: 'Overdue', color: overdue > 0 ? '#b3261e' : null },
      { n: blocked, l: 'Blocked', color: blocked > 0 ? '#8a5a00' : null },
      { n: doneWk,  l: 'Done this week', color: doneWk > 0 ? '#1a7f37' : null }
    ];
    wrap.innerHTML = cards.map(function (c) {
      return '<div class="adm-stat"><div class="adm-stat-n"' +
        (c.color ? ' style="color:' + c.color + '"' : '') + '>' + c.n +
        '</div><div class="adm-stat-l">' + c.l + '</div></div>';
    }).join('');
  }

  /* ── Board ─────────────────────────────────────────────────────────── */

  async function loadTasks() {
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
    var rows = res.data || [];

    var countEl = document.getElementById('task-count');
    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? ' task' : ' tasks');
    render(rows);
  }

  /* Bucket open tasks by urgency; done tasks get their own group. */
  function groupOf(t0, task) {
    if (task.status === 'done') return 'done';
    if (!task.due_date) return 'nodate';
    if (task.due_date < t0) return 'overdue';
    if (task.due_date === t0) return 'today';
    var weekOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
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

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>Nothing here — enjoy the quiet, or create a task on the right.</p>' +
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
      var head = document.createElement('li');
      head.className = 'adm-subhead' + (g.danger ? ' danger' : '');
      head.innerHTML = g.label + ' <span class="n">' + inGroup.length + '</span>';
      listEl.appendChild(head);
      inGroup.forEach(function (task) { listEl.appendChild(renderRow(task, t0)); });
    });
  }

  function renderRow(t, t0) {
    var li = document.createElement('li');
    li.className = 'adm-item' +
      (t.status !== 'done' && t.priority === 'urgent' ? ' pri-urgent' : '') +
      (t.status !== 'done' && t.priority === 'high' ? ' pri-high' : '');

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = t.status === 'done'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
    if (t.status === 'done') { title.style.textDecoration = 'line-through'; title.style.color = 'var(--muted)'; }
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    var who = t.assignee_id && byId[t.assignee_id] ? byId[t.assignee_id].full_name : 'Unassigned';
    var overdue = t.status !== 'done' && t.due_date && t.due_date < t0;
    sub.innerHTML = esc(who) +
      (t.due_date ? ' · <span' + (overdue ? ' class="due-over"' : '') + '>due ' + t.due_date + '</span>' : '') +
      (t.details ? ' · ' + esc(t.details) : '');
    main.appendChild(title); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
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
    var res = await window.sb.from('tasks').update(patch).eq('id', t.id);
    if (res.error) { setMsg('Update failed: ' + res.error.message, 'err'); return; }
    setMsg('');
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

  /* ── New task ──────────────────────────────────────────────────────── */

  var taskJump = document.getElementById('task-jump');
  if (taskJump) {
    taskJump.addEventListener('click', function () {
      var el = document.getElementById('t-title');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { el.focus(); }, 300); }
    });
  }

  var addBtn = document.getElementById('t-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var title = (document.getElementById('t-title').value || '').trim();
      if (!title) { setMsg('Enter a task title.', 'err'); return; }
      var session = await window.admin.session();
      var row = {
        title: title,
        details: (document.getElementById('t-details').value || '').trim() || null,
        assignee_id: document.getElementById('t-assignee').value || null,
        priority: document.getElementById('t-priority').value,
        due_date: document.getElementById('t-due').value || null,
        created_by: session ? session.user.id : null
      };
      addBtn.disabled = true;
      var res = await window.sb.from('tasks').insert(row);
      addBtn.disabled = false;
      if (res.error) { setMsg('Create failed: ' + res.error.message, 'err'); return; }
      document.getElementById('t-title').value = '';
      document.getElementById('t-details').value = '';
      document.getElementById('t-due').value = '';
      setMsg(''); window.admin.toast('Task created');
      loadStats();
      loadTasks();
    });
  }

  document.getElementById('f-status').addEventListener('change', loadTasks);
  document.getElementById('f-assignee').addEventListener('change', loadTasks);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
