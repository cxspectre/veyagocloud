/* Task detail page — /admin/task?id=<tasks.id>
 *
 * Everything you can DO to one task lives here, so the board stays a board.
 * Opened cold from a deep link: the id comes from the query string and nothing
 * is assumed about where the visitor came from.
 *
 * Permissions mirror the database exactly, because the database silently wins:
 *   • managers (owner/admin)  — edit every field, move status, delete
 *   • the assignee            — status only; tasks_guard_assignee_columns()
 *                               restores title/details/assignee/priority/due
 *                               on write, so those inputs are DISABLED rather
 *                               than letting someone type into a field whose
 *                               changes evaporate on save
 *   • everyone else on staff  — read-only
 */
(function () {
  'use strict';

  var task = null;          // the tasks row (replaced, never mutated)
  var employees = [];       // everyone we may show in the assignee select
  var byId = {};            // employee id → row
  var isManager = false;
  var selfEmployee = null;

  /* One shared status machine — see task-status.js. These four maps used to be
     declared here AND in tasks.js, and had already drifted apart. */
  var TS = window.adminTaskStatus;
  var STATUS_LABEL = TS.LABEL;
  var STATUS_BADGE = TS.BADGE;
  var PRIORITY_BADGE = TS.PRIORITY_BADGE;
  var NEXT_STATUS = TS.NEXT;
  var NEXT_LABEL  = TS.NEXT_LABEL;

  var ICON = {
    done:    '<svg viewBox="0 0 24 24" fill="none" stroke="var(--fg-success)" stroke-width="2" stroke-linecap="round" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>',
    blocked: '<svg viewBox="0 0 24 24" fill="none" stroke="var(--ac-warn)" stroke-width="1.8" stroke-linecap="round" width="20" height="20"><circle cx="12" cy="12" r="9"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/></svg>',
    open:    '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" stroke-linecap="round" width="20" height="20"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>'
  };

  function el(id) { return document.getElementById(id); }

  /* Escapes for BOTH text and quoted-attribute contexts — quotes included, so a
     stored title cannot break out of an attribute and inject a handler. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setMsg(id, text, kind) {
    var node = el(id);
    if (!node) return;
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* 'YYYY-MM-DD' → 'Jul 30, 2026'. Built from the parts, never new Date(str):
     a bare date string parses as UTC midnight, which renders as the previous
     day for anyone west of UTC. */
  function fmtDay(d) {
    if (!d) return '';
    var p = String(d).split('-');
    if (p.length !== 3) return String(d);
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isNaN(dt.getTime())
      ? String(d)
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* Full timestamptz → 'Jul 30, 2026, 2:05 PM'. */
  function fmtStamp(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    return isNaN(dt.getTime())
      ? ''
      : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function isOverdue(t) {
    return t.status !== 'done' && !!t.due_date && t.due_date < window.admin.localDate();
  }

  function canAdvance() {
    return isManager || !!(selfEmployee && task && task.assignee_id === selfEmployee.id);
  }

  /* ── Load ──────────────────────────────────────────────────────────── */

  async function load() {
    var id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      showEmpty('No task was specified.', 'Open a task from the board and its own page will load here.');
      return;
    }

    var perms = await window.adminRoles.resolve();
    isManager = perms.role === 'owner' || perms.role === 'admin';
    selfEmployee = perms.employee;

    var res = await window.sb.from('tasks')
      .select('id,title,details,assignee_id,status,priority,due_date,completed_at,created_at,updated_at')
      .eq('id', id)
      .maybeSingle();

    /* A malformed id makes Postgres reject the uuid cast — same outcome for the
       visitor as a deleted task, so it gets the same honest empty state. */
    if (res.error) {
      console.warn('[task] load failed:', res.error.message);
      showEmpty('That task could not be loaded — the link may be wrong, or it may have been deleted.');
      return;
    }
    if (!res.data) {
      showEmpty('That task no longer exists.', 'It may have been deleted, or you may not have access to it.');
      return;
    }
    task = res.data;

    /* Everyone active, plus the current assignee even if they have since been
       deactivated — otherwise the select would quietly show someone else and
       the next save would reassign the task behind the manager's back. */
    /* email comes back too: whether a reassignment can actually be delivered
       depends on it, and a promise of "they were emailed" that the server
       silently skips is worse than no promise. RLS already permits it —
       team.js and member.js both read employees.email. */
    var emps = await window.sb.from('employees').select('id,full_name,status,email').order('full_name');
    employees = (emps.data || []).filter(function (e) {
      return e.status !== 'inactive' || e.id === task.assignee_id;
    });
    byId = {};
    (emps.data || []).forEach(function (e) { byId[e.id] = e; });

    el('t-skel').hidden = true;
    el('t-body').hidden = false;
    document.title = task.title + ' · Veyago Admin';

    fillForm();
    renderChrome();

    if (emps.error) setMsg('form-msg', 'Could not load the team list: ' + emps.error.message, 'err');
  }

  function showEmpty(headline, detail) {
    var skel = el('t-skel');
    var body = el('t-body');
    var wrap = el('t-empty');
    if (skel) skel.hidden = true;
    if (body) body.hidden = true;
    if (!wrap) return;
    wrap.hidden = false;
    wrap.innerHTML =
      '<div class="card-pane">' +
        '<div class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>' + esc(headline) + '</p>' +
          (detail ? '<p style="font-size:.85rem;color:var(--muted)">' + esc(detail) + '</p>' : '') +
          '<a class="btn btn-primary" href="/admin/tasks">Back to tasks</a>' +
        '</div>' +
      '</div>';
  }

  /* ── Form (filled once — a status change must not wipe unsaved edits) ── */

  function fillForm() {
    el('f-title').value = task.title || '';
    el('f-details').value = task.details || '';
    el('f-priority').value = task.priority || 'normal';
    el('f-due').value = task.due_date || '';

    var sel = el('f-assignee');
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = ''; none.textContent = 'Unassigned';
    sel.appendChild(none);
    employees.forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.full_name + (e.status === 'inactive' ? ' (inactive)' : '');
      sel.appendChild(o);
    });
    sel.value = task.assignee_id || '';
    /* Someone is assigned but their row did not come back (deleted, or the team
       query failed). Keep a stand-in option selected so the current assignment
       round-trips instead of a Save silently unassigning them. */
    if (task.assignee_id && sel.value !== task.assignee_id) {
      var unknown = document.createElement('option');
      unknown.value = task.assignee_id;
      unknown.textContent = 'Currently assigned (name unavailable)';
      sel.insertBefore(unknown, sel.firstChild.nextSibling);
      sel.value = task.assignee_id;
    }

    /* Non-managers cannot change any of this — the trigger reverts it — so the
       inputs are disabled and Save is not offered at all. */
    ['f-title', 'f-details', 'f-assignee', 'f-priority', 'f-due'].forEach(function (id) {
      el(id).disabled = !isManager;
    });
    el('save-btn').hidden = !isManager;

    var note = el('ro-note');
    if (isManager) {
      note.hidden = true;
    } else {
      note.hidden = false;
      note.textContent = canAdvance()
        ? 'Only a manager can change these details — you can still move the task along on the right.'
        : 'You are viewing this task. Only a manager, or the person it is assigned to, can change it.';
    }
  }

  /* ── Head, actions, timeline (re-rendered after every write) ────────── */

  function renderChrome() {
    renderHead();
    renderActions();
    renderTimeline();
  }

  function renderHead() {
    el('d-icon').innerHTML = task.status === 'done' ? ICON.done
                           : task.status === 'blocked' ? ICON.blocked
                           : ICON.open;
    el('d-title').textContent = task.title;

    var who = !task.assignee_id ? 'Unassigned'
            : byId[task.assignee_id] ? byId[task.assignee_id].full_name
            : 'Assigned';
    /* Only the plain-text bits take a separator — badges are distinct enough on
       their own, and a dot before one dangles at the start of a wrapped line. */
    var text = ['<span>' + esc(who) + '</span>'];
    if (task.due_date) {
      text.push('<span' + (isOverdue(task) ? ' class="due-over"' : '') + '>Due ' + esc(fmtDay(task.due_date)) + '</span>');
    }
    var html = text.join('<span aria-hidden="true">·</span>');
    if (PRIORITY_BADGE[task.priority]) {
      html += '<span class="badge ' + PRIORITY_BADGE[task.priority] + '">' + esc(task.priority) + '</span>';
    }
    html += '<span class="badge ' + STATUS_BADGE[task.status] + '">' + esc(STATUS_LABEL[task.status] || task.status) + '</span>';

    el('d-meta').innerHTML = html;
  }

  function renderActions() {
    var wrap = el('act-list');
    wrap.innerHTML = '';
    var note = el('act-note');

    if (!canAdvance()) {
      note.hidden = false;
      note.textContent = 'Only a manager, or the person this task is assigned to, can move it along.';
    } else {
      note.hidden = true;
      var next = NEXT_STATUS[task.status];
      if (next) {
        var adv = document.createElement('button');
        adv.type = 'button';
        adv.className = 'btn' + (task.status === 'done' ? '' : ' btn-primary');
        adv.textContent = NEXT_LABEL[task.status];
        adv.addEventListener('click', function () { setStatus(next); });
        wrap.appendChild(adv);
      }
      if (task.status !== 'blocked' && task.status !== 'done') {
        var blk = document.createElement('button');
        blk.type = 'button';
        blk.className = 'btn';
        blk.textContent = 'Block';
        blk.title = 'Mark blocked — waiting on something';
        blk.addEventListener('click', function () { setStatus('blocked'); });
        wrap.appendChild(blk);
      }
    }

    el('danger-zone').hidden = !isManager;
  }

  function renderTimeline() {
    var entries = [{ title: 'Created', meta: fmtStamp(task.created_at) }];
    if (task.status === 'done' && task.completed_at) {
      entries.push({ title: 'Completed', meta: fmtStamp(task.completed_at) });
    } else if (task.status !== 'todo') {
      entries.push({
        title: STATUS_LABEL[task.status] || task.status,
        meta: task.updated_at ? 'Last updated ' + fmtStamp(task.updated_at) : ''
      });
    }

    el('d-timeline').innerHTML = entries.map(function (e, i) {
      return '<li' + (i === entries.length - 1 ? ' class="is-current"' : '') + '>' +
        '<div class="adm-timeline-title">' + esc(e.title) + '</div>' +
        (e.meta ? '<div class="adm-timeline-meta">' + esc(e.meta) + '</div>' : '') +
      '</li>';
    }).join('');
  }

  /* ── Writes ────────────────────────────────────────────────────────── */

  /* Always read the row back: for an assignee the trigger may have rewritten
     the update, and the returned row is the only truthful version. */
  var SELECT_COLS = 'id,title,details,assignee_id,status,priority,due_date,completed_at,created_at,updated_at';

  async function setStatus(status) {
    if (!task) return;
    var btns = el('act-list').querySelectorAll('button');
    btns.forEach(function (b) { b.disabled = true; });
    setMsg('act-msg', '');

    var patch = { status: status, completed_at: status === 'done' ? new Date().toISOString() : null };
    var res = await window.sb.from('tasks').update(patch).eq('id', task.id).select(SELECT_COLS).maybeSingle();

    btns.forEach(function (b) { b.disabled = false; });
    if (res.error) { setMsg('act-msg', 'Could not update: ' + res.error.message, 'err'); return; }
    if (!res.data)  { setMsg('act-msg', 'Nothing was updated — you may not have permission to move this task.', 'err'); return; }

    task = res.data;
    renderChrome();
    window.admin.toast(TS.movedToast(status));
  }

  async function save() {
    if (!task || !isManager) return;
    var title = (el('f-title').value || '').trim();
    if (!title) { setMsg('form-msg', 'A task needs a title.', 'err'); el('f-title').focus(); return; }

    var patch = {
      title: title,
      details: (el('f-details').value || '').trim() || null,
      assignee_id: el('f-assignee').value || null,
      priority: el('f-priority').value,
      due_date: el('f-due').value || null
    };

    /* Captured BEFORE the write: the only way to tell a reassignment from any
       other edit is to compare against who held it a moment ago. */
    var wasAssignee = task.assignee_id;

    var btn = el('save-btn');
    btn.disabled = true;
    setMsg('form-msg', '');
    var res = await window.sb.from('tasks').update(patch).eq('id', task.id).select(SELECT_COLS).maybeSingle();
    btn.disabled = false;

    if (res.error) { setMsg('form-msg', 'Save failed: ' + res.error.message, 'err'); return; }
    if (!res.data)  { setMsg('form-msg', 'Save failed — you may not have permission to edit this task.', 'err'); return; }

    task = res.data;
    document.title = task.title + ' · Veyago Admin';
    renderChrome();
    window.admin.toast('Saved');

    /* notify-task's own header says it is called "after a task is created or
       reassigned". Only creation ever called it, so handing work to someone
       from this page — the one screen built for exactly that — told them
       nothing. Compared against the row the SERVER returned, not the patch we
       sent: for an assignee, tasks_guard_assignee_columns() rewrites the
       update, and the returned row is the only truthful version of what
       actually landed. */
    if (task.assignee_id && task.assignee_id !== wasAssignee) {
      var who = byId[task.assignee_id] ? byId[task.assignee_id].full_name : 'The new assignee';
      window.adminTaskNotify.notify(task.id, who);
    }
  }

  async function remove() {
    if (!task || !isManager) return;
    if (!confirm('Delete task "' + task.title + '"? This cannot be undone.')) return;
    var btn = el('del-btn');
    btn.disabled = true;
    setMsg('del-msg', '');
    var res = await window.sb.from('tasks').delete().eq('id', task.id);
    if (res.error) {
      btn.disabled = false;
      setMsg('del-msg', 'Delete failed: ' + res.error.message, 'err');
      return;
    }
    /* The record this page is about is gone — there is nothing left to show. */
    window.location.href = '/admin/tasks';
  }

  var saveBtn = el('save-btn');
  if (saveBtn) saveBtn.addEventListener('click', save);
  var delBtn = el('del-btn');
  if (delBtn) delBtn.addEventListener('click', remove);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
