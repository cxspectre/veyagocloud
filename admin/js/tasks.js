/* Tasks page: create, filter, and progress tasks. RLS: managers edit anything,
   assignees update their own, all staff can read the board and create tasks. */
(function () {
  'use strict';

  var msg    = document.getElementById('msg');
  var listEl = document.getElementById('task-list');

  var isManager = false;
  var selfEmployee = null;
  var employees = [];   // active employees for assignment + filter
  var byId = {};        // employee id → row

  var STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  var STATUS_BADGE = { todo: 'badge-draft', in_progress: 'badge-beta', blocked: 'badge-scheduled', done: 'badge-published' };
  var PRIORITY_BADGE = { urgent: 'badge-live', high: 'badge-beta' };  // low/normal show no badge
  var NEXT_STATUS = { todo: 'in_progress', in_progress: 'done', blocked: 'in_progress' };
  var NEXT_LABEL  = { todo: 'Start', in_progress: 'Complete', blocked: 'Unblock' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

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
    await loadTasks();
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
  }

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
    render(res.data || []);
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No tasks match — enjoy the quiet, or create one below.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (t) { listEl.appendChild(renderRow(t)); });
  }

  function dueLabel(t) {
    if (!t.due_date) return '';
    var today = new Date().toISOString().slice(0, 10);
    if (t.status !== 'done' && t.due_date < today) return ' · OVERDUE ' + t.due_date;
    return ' · due ' + t.due_date;
  }

  function renderRow(t) {
    var li = document.createElement('li'); li.className = 'adm-item';

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = t.status === 'done'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
    if (t.status === 'done') title.style.textDecoration = 'line-through';
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    var who = t.assignee_id && byId[t.assignee_id] ? byId[t.assignee_id].full_name : 'Unassigned';
    sub.textContent = who + dueLabel(t) + (t.details ? ' · ' + t.details : '');
    main.appendChild(title); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    if (PRIORITY_BADGE[t.priority]) {
      var pb = document.createElement('span');
      pb.className = 'badge ' + PRIORITY_BADGE[t.priority]; pb.textContent = t.priority;
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
      blk.className = 'btn btn-sm'; blk.type = 'button'; blk.textContent = 'Block';
      blk.addEventListener('click', function () { setStatus(t, 'blocked'); });
      acts.appendChild(blk);
    }
    if (isManager) {
      var del = document.createElement('button');
      del.className = 'btn btn-sm btn-danger'; del.type = 'button'; del.textContent = 'Delete';
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
    loadTasks();
  }

  async function remove(t) {
    if (!confirm('Delete task "' + t.title + '"? This cannot be undone.')) return;
    var res = await window.sb.from('tasks').delete().eq('id', t.id);
    if (res.error) { setMsg('Delete failed: ' + res.error.message, 'err'); return; }
    loadTasks();
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
      setMsg('Task created.', 'ok');
      loadTasks();
    });
  }

  document.getElementById('f-status').addEventListener('change', loadTasks);
  document.getElementById('f-assignee').addEventListener('change', loadTasks);
  document.addEventListener('admin:authed', load);
})();
