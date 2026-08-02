/* Task calendar view — month grid showing tasks as chips on their due dates.
   Toggle between List and Calendar via the #view-list / #view-cal buttons.
   Completely standalone: reads from the same DB as tasks.js, respects the
   same status/assignee filter selects, but owns its own data and rendering. */
(function () {
  'use strict';

  var calYear, calMonth;  // 0-based month
  var employees = {};     // employee id → full_name
  var isCalView = false;

  function initMonth() {
    var now = new Date();
    calYear  = now.getFullYear();
    calMonth = now.getMonth();
  }

  /* Date → 'YYYY-MM-DD' using local time (NOT toISOString which is UTC). */
  function localStr(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* Returns the start and end dates for the calendar grid (always complete
     weeks, padded with adjacent-month days).  */
  function gridEdges() {
    var first = new Date(calYear, calMonth, 1);
    var last  = new Date(calYear, calMonth + 1, 0);
    var start = new Date(first);
    start.setDate(start.getDate() - start.getDay());   /* back to Sunday */
    var end = new Date(last);
    end.setDate(end.getDate() + (6 - end.getDay()));   /* forward to Saturday */
    return { start: start, end: end };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function loadAndRender() {
    var calEl = document.getElementById('task-cal');
    if (!calEl || calEl.hidden) return;

    var edges = gridEdges();
    var statusSel   = document.getElementById('f-status');
    var assigneeSel = document.getElementById('f-assignee');
    var status   = statusSel   ? statusSel.value   : 'open';
    var assignee = assigneeSel ? assigneeSel.value : 'all';

    var q = window.sb.from('tasks')
      .select('id,title,status,priority,due_date,assignee_id')
      .not('due_date', 'is', null)
      .gte('due_date', localStr(edges.start))
      .lte('due_date', localStr(edges.end))
      .order('due_date')
      .order('created_at');

    if (status === 'open') q = q.neq('status', 'done');
    else if (status !== 'all') q = q.eq('status', status);
    if (assignee && assignee !== 'all') q = q.eq('assignee_id', assignee);

    var res = await q;
    if (res.error) return;

    /* Group by date string for O(1) cell lookup */
    var byDate = {};
    (res.data || []).forEach(function (t) {
      if (!t.due_date) return;
      (byDate[t.due_date] = byDate[t.due_date] || []).push(t);
    });

    renderGrid(edges, byDate);
  }

  var STATUS_CLASS = {
    done:        'done',
    blocked:     'blocked',
    in_progress: 'in_progress',
    todo:        'todo',
  };

  function renderGrid(edges, byDate) {
    var calEl = document.getElementById('task-cal');
    if (!calEl) return;

    var todayStr  = window.admin.localDate();
    var monthName = new Date(calYear, calMonth, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    /* ── Nav bar ── */
    var nav = document.createElement('div');
    nav.className = 'task-cal-nav';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-sm';
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', 'Previous month');
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>';
    prevBtn.addEventListener('click', function () {
      calMonth--;
      if (calMonth < 0) { calMonth = 11; calYear--; }
      loadAndRender();
    });

    var titleEl = document.createElement('span');
    titleEl.className = 'task-cal-title';
    titleEl.textContent = monthName;

    var nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-sm';
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', 'Next month');
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>';
    nextBtn.addEventListener('click', function () {
      calMonth++;
      if (calMonth > 11) { calMonth = 0; calYear++; }
      loadAndRender();
    });

    nav.appendChild(prevBtn);
    nav.appendChild(titleEl);
    nav.appendChild(nextBtn);

    /* ── Grid ── */
    var grid = document.createElement('div');
    grid.className = 'task-cal-grid';

    /* Day-of-week headers */
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (d) {
      var h = document.createElement('div');
      h.className = 'task-cal-head';
      h.textContent = d;
      grid.appendChild(h);
    });

    /* Day cells — iterate from grid start to grid end */
    var cursor = new Date(edges.start);
    var MAX_CHIPS = 4;

    while (cursor <= edges.end) {
      var ds       = localStr(cursor);
      var isToday  = ds === todayStr;
      var isOther  = cursor.getMonth() !== calMonth;
      var dayTasks = byDate[ds] || [];

      var cell = document.createElement('div');
      cell.className = 'task-cal-day' +
        (isToday ? ' today' : '') +
        (isOther ? ' other-month' : '');

      /* Date number */
      var numEl = document.createElement('div');
      numEl.className = 'task-cal-day-num';
      numEl.textContent = cursor.getDate();
      cell.appendChild(numEl);

      /* Task chips — up to MAX_CHIPS then a "+N more" row */
      var shown = dayTasks.slice(0, MAX_CHIPS);
      var extra = dayTasks.length - shown.length;

      shown.forEach(function (t) {
        var chip = document.createElement('a');
        var cls  = 'task-chip';
        if (STATUS_CLASS[t.status]) cls += ' ' + STATUS_CLASS[t.status];
        if (t.priority === 'urgent')     cls += ' pri-urgent';
        else if (t.priority === 'high')  cls += ' pri-high';
        chip.className = cls;
        chip.href = '/admin/task?id=' + encodeURIComponent(t.id);
        chip.textContent = t.title;
        var who = employees[t.assignee_id] || '';
        chip.title = t.title + (who ? ' · ' + who : '');
        cell.appendChild(chip);
      });

      if (extra > 0) {
        var moreEl = document.createElement('div');
        moreEl.className = 'task-chip-more';
        moreEl.textContent = '+' + extra + ' more';
        cell.appendChild(moreEl);
      }

      grid.appendChild(cell);
      cursor.setDate(cursor.getDate() + 1);
    }

    calEl.innerHTML = '';
    calEl.appendChild(nav);
    calEl.appendChild(grid);
  }

  function showCalView() {
    isCalView = true;
    var calEl   = document.getElementById('task-cal');
    var listEl  = document.getElementById('task-list');
    var quickEl = document.getElementById('quick-add');
    var countEl = document.getElementById('task-count');
    if (calEl)   calEl.hidden   = false;
    if (listEl)  listEl.hidden  = true;
    if (quickEl) quickEl.hidden = true;
    if (countEl) countEl.style.display = 'none';
    var bc = document.getElementById('view-cal');
    var bl = document.getElementById('view-list');
    if (bc) bc.classList.add('btn-primary');
    if (bl) bl.classList.remove('btn-primary');
    loadAndRender();
  }

  function showListView() {
    isCalView = false;
    var calEl   = document.getElementById('task-cal');
    var listEl  = document.getElementById('task-list');
    var quickEl = document.getElementById('quick-add');
    var countEl = document.getElementById('task-count');
    if (calEl)   calEl.hidden   = true;
    if (listEl)  listEl.hidden  = false;
    if (quickEl) quickEl.hidden = false;
    if (countEl) countEl.style.display = '';
    var bc = document.getElementById('view-cal');
    var bl = document.getElementById('view-list');
    if (bl) bl.classList.add('btn-primary');
    if (bc) bc.classList.remove('btn-primary');
  }

  window.adminReady.then(async function (s) {
    if (!s) return;

    initMonth();

    /* Pre-load employee names for chip tooltips. */
    var emps = await window.sb.from('employees')
      .select('id,full_name').neq('status', 'inactive');
    if (!emps.error) {
      (emps.data || []).forEach(function (e) { employees[e.id] = e.full_name; });
    }

    /* Wire view-toggle buttons */
    var btnCal  = document.getElementById('view-cal');
    var btnList = document.getElementById('view-list');
    if (btnCal)  btnCal.addEventListener('click',  showCalView);
    if (btnList) btnList.addEventListener('click', showListView);

    /* Re-render when the toolbar filters change while in calendar mode. */
    ['f-status', 'f-assignee'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function () {
        if (isCalView) loadAndRender();
      });
    });
  });
})();
