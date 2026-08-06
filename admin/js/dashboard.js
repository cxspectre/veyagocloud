/* Dashboard controller — stat cards, recent articles, status panel. */
(function () {
  'use strict';

  var listEl = document.getElementById('article-list');

  function fmt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function setStat(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* Show a prominent error banner inside the articles card. */
  function showListError(msg) {
    if (!listEl) return;
    listEl.innerHTML =
      '<li style="background:#fff4f4;border:1px solid #f5c2c2;border-radius:12px;padding:16px 18px;list-style:none">' +
        '<strong style="color:#b3261e;font-size:.9rem">Could not load articles</strong>' +
        '<p style="color:#b3261e;font-size:.84rem;margin:6px 0 0;line-height:1.5">' + escHtml(msg) + '</p>' +
        '<p style="font-size:.8rem;color:var(--muted);margin:8px 0 0">Open your browser console (F12 → Console) for more detail.</p>' +
      '</li>';
  }

  /* ── Manager command centre ──────────────────────────────────────── */

  async function loadManagerHome(employee) {
    var greetEl = document.getElementById('mgr-greeting');
    var dateEl  = document.getElementById('mgr-date');
    if (greetEl) {
      var first = String((employee && employee.full_name) || '').trim().split(/\s+/)[0] || '';
      greetEl.textContent = greeting() + (first ? ', ' + first : '');
    }
    if (dateEl) {
      dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }

    var t0 = window.admin.localDate();
    var monthStart = t0.slice(0, 8) + '01';

    await Promise.allSettled([
      loadManagerStats(employee, t0, monthStart),
      loadManagerTasks(employee, t0),
      loadTeamPulse(t0),
      loadStatusPanel(),
      loadArticles(),
    ]);
  }

  async function loadManagerStats(employee, t0, monthStart) {
    var statsEl = document.getElementById('mgr-stats');
    if (!statsEl) return;

    var rs = await Promise.allSettled([
      window.sb.from('tasks').select('id,status,due_date,assignee_id').neq('status', 'done').limit(2000),
      window.sb.from('finance_transactions').select('amount').gte('posted_at', monthStart).limit(5000),
      window.sb.from('publish_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    function ok(i) { return rs[i].status === 'fulfilled' && !rs[i].value.error ? (rs[i].value.data || []) : null; }

    var allTasks = ok(0);
    var myId     = employee ? employee.id : null;
    var mine     = myId && allTasks ? allTasks.filter(function (t) { return t.assignee_id === myId; }) : [];
    var myOverdue = mine.filter(function (t) { return t.due_date && t.due_date < t0; });
    var myToday   = mine.filter(function (t) { return t.due_date === t0; });

    var teamBlocked = allTasks ? allTasks.filter(function (t) { return t.status === 'blocked'; }).length : 0;
    var teamOverdue = allTasks ? allTasks.filter(function (t) { return t.due_date && t.due_date < t0; }).length : 0;

    var tx   = ok(1);
    var pend = rs[2].status === 'fulfilled' && !rs[2].value.error ? (rs[2].value.count || 0) : 0;

    var cards = [];

    /* Card 1: my tasks due today / overdue */
    var myDue = myOverdue.length + myToday.length;
    cards.push({
      href: '/admin/tasks?mine=1',
      color: myOverdue.length ? '#ff3b30' : (myDue ? '#0071e3' : '#86868b'),
      n: myDue,
      n2: myOverdue.length ? myOverdue.length + ' overdue' : (myDue ? 'due today' : 'nothing due today'),
      n2Color: myOverdue.length ? '#b3261e' : null,
      label: 'My tasks today',
      icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    });

    /* Card 2: team open tasks */
    if (allTasks) {
      cards.push({
        href: '/admin/tasks',
        color: teamBlocked ? '#ff9500' : (teamOverdue ? '#ff3b30' : '#34c759'),
        n: allTasks.length,
        n2: teamBlocked ? teamBlocked + ' blocked' : (teamOverdue ? teamOverdue + ' overdue' : 'no blockers'),
        n2Color: (teamBlocked || teamOverdue) ? '#b3261e' : null,
        label: 'Open tasks',
        icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
      });
    }

    /* Card 3: net this month */
    if (tx) {
      var net    = tx.reduce(function (s, r) { return s + Number(r.amount); }, 0);
      var fmtNet = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(net);
      cards.push({
        href: '/admin/finance',
        color: net >= 0 ? '#34c759' : '#ff3b30',
        n: fmtNet,
        n2: tx.length + ' transaction' + (tx.length === 1 ? '' : 's'),
        label: 'Net this month',
        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
      });
    }

    /* Card 4: pending publish requests (or a publish shortcut if none) */
    if (pend > 0) {
      cards.push({
        href: '/admin/publish',
        color: '#ff9500',
        n: pend,
        n2: 'waiting for approval',
        n2Color: '#b3261e',
        label: pend === 1 ? 'Publish request' : 'Publish requests',
        icon: '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>',
      });
    } else {
      cards.push({
        href: '/admin/publish',
        color: '#5856d6',
        n: '0',
        n2: 'nothing pending',
        label: 'Publish',
        icon: '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>',
      });
    }

    window.admin.statCards(statsEl, cards);
  }

  async function loadManagerTasks(employee, t0) {
    var listEl = document.getElementById('mgr-tasks');
    if (!listEl) return;

    if (!employee) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<p>No employee record is linked to your account — tasks cannot be filtered to you.</p>' +
          '<a class="btn btn-sm btn-primary" href="/admin/tasks">View all tasks</a>' +
        '</li>';
      return;
    }

    var weekOut = window.admin.localDate(7);
    var res = await window.sb.from('tasks')
      .select('id,title,status,priority,due_date')
      .eq('assignee_id', employee.id)
      .neq('status', 'done')
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(30);

    var rows = res.error ? [] : (res.data || []);
    var overdue = rows.filter(function (t) { return t.due_date && t.due_date < t0; });
    var today   = rows.filter(function (t) { return t.due_date === t0; });
    var soon    = rows.filter(function (t) { return t.due_date && t.due_date > t0 && t.due_date <= weekOut; });
    var other   = rows.filter(function (t) { return !t.due_date || t.due_date > weekOut; });
    var display = overdue.concat(today, soon, other).slice(0, 8);

    if (!display.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>Nothing on your plate. Enjoy the quiet.</p>' +
        '</li>';
      return;
    }

    listEl.innerHTML = '';
    display.forEach(function (t) {
      var late = t.due_date && t.due_date < t0;
      var li = document.createElement('li');
      li.className = 'adm-item' +
        (t.priority === 'urgent' ? ' pri-urgent' : t.priority === 'high' ? ' pri-high' : '');

      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      var statusColor = t.status === 'blocked' ? 'var(--ac-warn)' : late ? 'var(--ac-danger)' : 'var(--muted-2)';
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="' + statusColor + '" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
      var sub = document.createElement('div'); sub.className = 'adm-item-sub';
      sub.innerHTML = t.due_date
        ? '<span' + (late ? ' class="due-over"' : '') + '>' + (late ? 'overdue ' : 'due ') + escHtml(t.due_date) + '</span>'
          + (t.status === 'blocked' ? ' · <span style="color:var(--ac-warn)">blocked</span>' : '')
        : (t.status === 'blocked' ? '<span style="color:var(--ac-warn)">blocked</span>' : 'no due date');
      main.appendChild(title); main.appendChild(sub);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var open = document.createElement('a');
      open.className = 'btn btn-sm';
      open.href = '/admin/task?id=' + encodeURIComponent(t.id);
      open.textContent = 'Open';
      acts.appendChild(open);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  async function loadTeamPulse(t0) {
    var panel = document.getElementById('mgr-pulse');
    if (!panel) return;

    var rs = await Promise.allSettled([
      window.sb.from('employees').select('id,full_name,status').neq('status', 'inactive').order('full_name'),
      window.sb.from('tasks').select('assignee_id,status,due_date').neq('status', 'done').not('assignee_id', 'is', null).limit(2000),
    ]);

    var emps  = rs[0].status === 'fulfilled' && !rs[0].value.error ? (rs[0].value.data || []) : [];
    var tasks = rs[1].status === 'fulfilled' && !rs[1].value.error ? (rs[1].value.data || []) : [];

    /* Group tasks by assignee */
    var byId = {};
    tasks.forEach(function (t) {
      var g = byId[t.assignee_id] || (byId[t.assignee_id] = { open: 0, blocked: 0, overdue: 0 });
      g.open++;
      if (t.status === 'blocked') g.blocked++;
      if (t.due_date && t.due_date < t0) g.overdue++;
    });

    /* Only show people with open tasks, sorted urgent-first */
    var active = emps.filter(function (e) { return byId[e.id]; }).sort(function (a, b) {
      var ga = byId[a.id], gb = byId[b.id];
      if (gb.blocked !== ga.blocked) return gb.blocked - ga.blocked;
      if (gb.overdue !== ga.overdue) return gb.overdue - ga.overdue;
      return gb.open - ga.open;
    });

    var header = '<div style="padding:12px 14px 8px;font-size:var(--t-eyebrow);font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted-2)">Team pulse</div>';

    if (!active.length) {
      panel.innerHTML = header +
        '<div class="dash-status-row"><span class="dash-status-dot green"></span>' +
        '<div><div class="dash-status-label">All clear</div>' +
        '<div class="dash-status-sub">No open tasks on anyone\'s plate</div></div></div>';
      return;
    }

    var rows = active.slice(0, 7).map(function (e) {
      var g = byId[e.id];
      var dotClass = g.blocked ? 'amber' : (g.overdue ? 'red' : 'green');
      var sub = g.open + ' open';
      if (g.blocked) sub += ' · ' + g.blocked + ' blocked';
      else if (g.overdue) sub += ' · ' + g.overdue + ' overdue';
      var href = '/admin/tasks?assignee=' + encodeURIComponent(e.id);
      return '<div class="dash-status-row">' +
        '<span class="dash-status-dot ' + dotClass + '"></span>' +
        '<div style="min-width:0;flex:1">' +
          '<div class="dash-status-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
            '<a href="' + escHtml(href) + '" style="color:inherit;text-decoration:none">' + escHtml(e.full_name) + '</a>' +
          '</div>' +
          '<div class="dash-status-sub">' + escHtml(sub) + '</div>' +
        '</div></div>';
    }).join('');

    if (active.length > 7) {
      rows += '<div style="padding:6px 14px 10px;font-size:var(--t-eyebrow);color:var(--muted)">' +
        (active.length - 7) + ' more · <a href="/admin/tasks">View all tasks</a></div>';
    }

    panel.innerHTML = header + rows;
  }

  async function loadStatusPanel() {
    var panel = document.getElementById('status-panel');
    if (!panel) return;

    var rs = await Promise.allSettled([
      window.sb.from('site_announcements').select('id,message,active').is('deleted_at', null).eq('active', true).limit(1),
      window.sb.from('build_runs').select('status,finished_at').order('started_at', { ascending: false }).limit(5),
    ]);

    var ann     = rs[0].status === 'fulfilled' && !rs[0].value.error ? (rs[0].value.data || []) : [];
    var runs    = rs[1].status === 'fulfilled' && !rs[1].value.error ? (rs[1].value.data || []) : [];
    var activeAnn = ann[0] || null;

    var annRow = activeAnn
      ? '<div class="dash-status-row"><span class="dash-status-dot green"></span><div>' +
          '<div class="dash-status-label">Announcement active</div>' +
          '<div class="dash-status-sub">' + escHtml((activeAnn.message || '').slice(0, 55)) + (activeAnn.message && activeAnn.message.length > 55 ? '…' : '') +
          ' <a href="/admin/announcements">Edit →</a></div></div></div>'
      : '<div class="dash-status-row"><span class="dash-status-dot gray"></span><div>' +
          '<div class="dash-status-label">No active announcement</div>' +
          '<div class="dash-status-sub"><a href="/admin/announcements">Create one →</a></div></div></div>';

    var inFlight = runs.filter(function (r) { return r.status === 'queued' || r.status === 'running'; })[0];
    var lastGood = runs.filter(function (r) { return r.status === 'success'; })[0];
    var lastRun  = runs[0];
    var siteDot, siteLabel;
    if (inFlight) {
      siteDot = 'amber'; siteLabel = 'Publishing now…';
    } else if (lastRun && lastRun.status === 'failed') {
      siteDot = 'red'; siteLabel = 'Last publish failed';
    } else if (lastGood) {
      siteDot = 'green';
      var on = fmt(lastGood.finished_at);
      siteLabel = 'Published' + (on ? ' ' + on : '');
    } else {
      siteDot = 'gray'; siteLabel = 'Never published from here';
    }

    var siteRow = '<div class="dash-status-row"><span class="dash-status-dot ' + siteDot + '"></span><div>' +
      '<div class="dash-status-label">' + escHtml(siteLabel) + '</div>' +
      '<div class="dash-status-sub"><a href="https://www.veyago.cloud" target="_blank" rel="noopener">veyago.cloud ↗</a></div></div></div>';

    panel.innerHTML = annRow + siteRow;
  }

  /* loadSiteStatus kept for backwards compatibility — no longer called for the
     manager home but may be referenced externally. */
  async function loadSiteStatus() { await loadStatusPanel(); }

  /* ── Articles ── */
  async function loadArticles() {
    if (!listEl) return;

    /* Use select('*') so missing columns (e.g. updated_at if migration was partial)
       don't cause a query error. Order by created_at which always exists. */
    var res = await window.sb.from('articles')
      .select('*').is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(8);

    if (res.error) {
      showListError(res.error.message);
      return;
    }

    renderArticles(res.data || []);
  }

  function humanizeStatus(s) {
    return String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function renderArticles(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true">' +
            '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +
            '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
            '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' +
          '</svg>' +
          '<p>No articles yet.</p>' +
          '<a class="btn btn-primary btn-sm" href="/admin/article">Write first article</a>' +
        '</li>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'adm-item';

      var isPub   = a.status === 'published';
      var iconBg  = isPub ? '#e8f0fe' : 'var(--bg-card)';
      var iconCol = isPub ? '#1a56db' : 'var(--muted-2)';
      var icon = document.createElement('div');
      icon.className = 'adm-item-icon';
      icon.style.cssText = 'background:' + iconBg + ';color:' + iconCol;
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.title || '(untitled)';
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      var dateStr = fmt(a.published_at || a.updated_at || a.created_at);
      s.textContent = (isPub ? 'Published' : 'Updated') + (dateStr ? ' ' + dateStr : '');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge badge-' + a.status; badge.textContent = humanizeStatus(a.status);
      var edit = document.createElement('a');
      edit.className = 'btn btn-sm';
      edit.href = '/admin/article?id=' + encodeURIComponent(a.id);
      edit.textContent = 'Edit';

      acts.appendChild(badge); acts.appendChild(edit);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  /* loadCompany removed — superseded by loadManagerHome / loadManagerStats. */

  /* ── Staff home ───────────────────────────────────────────────────────
     An assistant landing on "Dashboard — everything published on veyago.cloud"
     over five publishing counts, under a New article button RLS may refuse, is
     being shown someone else's job. They get their own work instead. Reuses the
     Tasks page's buckets and row markup — no new components. */

  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  async function renderStaffHome(employee) {
    var root = document.getElementById('view-staff');
    if (!root) return;

    var first = String((employee && employee.full_name) || '').trim().split(/\s+/)[0] || 'there';
    var t0 = window.admin.localDate();
    var weekOut = window.admin.localDate(7);

    root.innerHTML =
      '<div class="adm-page-head">' +
        '<div><h1>' + escHtml(greeting()) + ', ' + escHtml(first) + '</h1>' +
        '<p>Here’s what’s on your plate today.</p></div>' +
        '<div class="adm-actions"><a class="btn btn-primary" href="/admin/tasks">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          'New task</a></div>' +
      '</div>' +
      '<div class="dash-stats dash-stats--4" id="staff-stats"></div>' +
      '<div class="card-pane">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">' +
          '<h2 style="margin:0">Your tasks</h2>' +
          '<a class="btn btn-sm" href="/admin/tasks">Open the board</a>' +
        '</div>' +
        '<ul class="adm-list" id="staff-tasks"><li class="skel"></li><li class="skel"></li></ul>' +
      '</div>';
    root.hidden = false;

    if (!employee) return;

    var res = await window.sb.from('tasks')
      .select('id,title,status,priority,due_date')
      .eq('assignee_id', employee.id).neq('status', 'done')
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(50);
    var mine = (res.error ? [] : (res.data || []));

    var overdue = mine.filter(function (t) { return t.due_date && t.due_date < t0; });
    var today   = mine.filter(function (t) { return t.due_date === t0; });
    var soon    = mine.filter(function (t) { return t.due_date && t.due_date > t0 && t.due_date <= weekOut; });
    var blocked = mine.filter(function (t) { return t.status === 'blocked'; });

    window.admin.statCards(document.getElementById('staff-stats'), [
      { n: today.length, label: 'Due today', color: '#0071e3', n2: today.length ? 'on your plate' : 'nothing due',
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
      { n: overdue.length, label: 'Overdue', color: overdue.length ? '#ff3b30' : '#86868b',
        n2: overdue.length ? 'needs catching up' : 'all on time', n2Color: overdue.length ? '#b3261e' : null,
        icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
      { n: blocked.length, label: 'Blocked', color: blocked.length ? '#ff9500' : '#86868b',
        n2: blocked.length ? 'waiting on someone' : 'nothing stuck',
        icon: '<circle cx="12" cy="12" r="9"/><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>' },
      { n: soon.length, label: 'This week', color: '#5856d6', n2: 'coming up',
        icon: '<polyline points="20 6 9 17 4 12"/>' }
    ]);

    renderStaffTasks(overdue.concat(today, soon).slice(0, 8), t0);
  }

  function renderStaffTasks(rows, t0) {
    var listEl = document.getElementById('staff-tasks');
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>Nothing due this week. Enjoy the quiet.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'adm-item' +
        (t.priority === 'urgent' ? ' pri-urgent' : t.priority === 'high' ? ' pri-high' : '');
      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
      var sub = document.createElement('div'); sub.className = 'adm-item-sub';
      var late = t.due_date && t.due_date < t0;
      sub.innerHTML = t.due_date
        ? '<span' + (late ? ' class="due-over"' : '') + '>due ' + escHtml(t.due_date) + '</span>'
        : 'no due date';
      main.appendChild(title); main.appendChild(sub);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      /* Deep-link to the task itself, not the board. The staff home is the only
         screen an employee lands on, and pointing it at /admin/tasks left the
         task detail page — where the description, history and status live —
         reachable from a single link in the whole product (tasks.js:192). */
      var open = document.createElement('a');
      open.className = 'btn btn-sm';
      open.href = '/admin/task?id=' + encodeURIComponent(t.id);
      open.textContent = 'Open';
      acts.appendChild(open);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  async function refresh() {
    var r = window.adminRoles ? await window.adminRoles.resolve() : { role: null };
    var manager = r.role === 'owner' || r.role === 'admin';

    if (!manager && r.role) {
      document.title = 'Home · Veyago Admin';
      renderStaffHome(r.employee);
      return;
    }

    var mgrView = document.getElementById('view-manager');
    if (mgrView) mgrView.hidden = false;
    loadManagerHome(r.employee);
  }

  /* Re-fetch when the user switches back to this tab after editing an article. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  var refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refresh);

  /* Re-fetch when navigating back (bfcache restore — browser restores the
     pre-refresh DOM, so we reload to show current data). */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) refresh();
  });

  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) refresh(); });
})();
