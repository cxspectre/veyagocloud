/* Dashboard controller — stat cards, recent articles, status panel. */
(function () {
  'use strict';

  var listEl      = document.getElementById('article-list');
  var statusPanel = document.getElementById('status-panel');

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

  /* ── Stats ── */
  async function loadStats() {
    var results = await Promise.allSettled([
      window.sb.from('articles').select('id,status').is('deleted_at', null),
      window.sb.from('wallpapers').select('id,status').is('deleted_at', null),
      window.sb.from('apps').select('id,published').is('deleted_at', null),
      window.sb.from('projects').select('id,published').is('deleted_at', null),
      window.sb.from('site_announcements').select('id,message,active').is('deleted_at', null).eq('active', true).limit(1)
    ]);

    if (results[0].status === 'fulfilled' && !results[0].value.error) {
      var arts = results[0].value.data || [];
      setStat('stat-articles', arts.length);
      setStat('stat-articles-pub', arts.length ? arts.filter(function(a){ return a.status==='published'; }).length + ' published' : 'none yet');
    }
    if (results[1].status === 'fulfilled' && !results[1].value.error) {
      var wps = results[1].value.data || [];
      setStat('stat-wallpapers', wps.length);
      setStat('stat-wallpapers-pub', wps.length ? wps.filter(function(w){ return w.status==='published'; }).length + ' published' : 'none yet');
    }
    if (results[2].status === 'fulfilled' && !results[2].value.error) {
      var apps = results[2].value.data || [];
      setStat('stat-apps', apps.length);
      setStat('stat-apps-pub', apps.length ? apps.filter(function(a){ return a.published; }).length + ' on catalogue' : 'none yet');
    }
    if (results[3].status === 'fulfilled' && !results[3].value.error) {
      var projs = results[3].value.data || [];
      setStat('stat-projects', projs.length);
      setStat('stat-projects-pub', projs.length ? projs.filter(function(p){ return p.published; }).length + ' published' : 'none yet');
    }

    var activeAnn = (results[4].status === 'fulfilled' && !results[4].value.error && results[4].value.data && results[4].value.data[0]) || null;
    buildStatusPanel(activeAnn);
    var annEl = document.getElementById('stat-ann-status');
    if (annEl) { annEl.textContent = activeAnn ? 'Active' : 'None'; annEl.style.color = activeAnn ? '#1a7f37' : 'var(--muted)'; }
  }

  function buildStatusPanel(activeAnn) {
    if (!statusPanel) return;
    var rows = activeAnn
      ? '<div class="dash-status-row"><span class="dash-status-dot green"></span><div>' +
          '<div class="dash-status-label">Announcement active</div>' +
          '<div class="dash-status-sub">' + escHtml((activeAnn.message||'').slice(0,60)) + (activeAnn.message&&activeAnn.message.length>60?'…':'') +
          ' <a href="/admin/announcements">Edit →</a></div></div></div>'
      : '<div class="dash-status-row"><span class="dash-status-dot gray"></span><div>' +
          '<div class="dash-status-label">No active announcement</div>' +
          '<div class="dash-status-sub"><a href="/admin/announcements">Create one →</a></div></div></div>';
    /* The publish row starts neutral and is filled by loadSiteStatus(). It used
       to be a hardcoded green "Site live" dot behind no query at all, so the
       home screen read healthy even when published rows had never been shipped. */
    rows += '<div class="dash-status-row" id="site-status-row">' +
      '<span class="dash-status-dot gray" id="site-status-dot"></span><div>' +
      '<div class="dash-status-label" id="site-status-label">Checking publish status…</div>' +
      '<div class="dash-status-sub"><a href="https://www.veyago.cloud" target="_blank" rel="noopener">veyago.cloud ↗</a></div></div></div>';
    statusPanel.innerHTML = rows;
    loadSiteStatus();
  }

  /* Reads the same build_runs history the Publish screen renders, and
     says only what that history supports. Deliberately does NOT recompute the
     "N changes waiting" count — publish.js pendingCount() owns that query, and
     a second copy here would be one more thing to keep in step. */
  async function loadSiteStatus() {
    var dot   = document.getElementById('site-status-dot');
    var label = document.getElementById('site-status-label');
    if (!dot || !label) return;

    var res = await window.sb.from('build_runs')
      .select('status,finished_at')
      .order('started_at', { ascending: false }).limit(5);

    if (res.error) {
      label.textContent = 'Publish status unavailable';
      return;
    }

    var runs     = res.data || [];
    var inFlight = runs.filter(function (r) { return r.status === 'queued' || r.status === 'running'; })[0];
    var lastGood = runs.filter(function (r) { return r.status === 'success'; })[0];
    var lastRun  = runs[0];

    if (inFlight) {
      dot.className = 'dash-status-dot amber';
      label.textContent = 'Publishing now…';
    } else if (lastRun && lastRun.status === 'failed') {
      dot.className = 'dash-status-dot red';
      label.textContent = 'Last publish failed';
    } else if (lastGood) {
      dot.className = 'dash-status-dot green';
      var on = fmt(lastGood.finished_at);
      label.textContent = 'Published' + (on ? ' ' + on : '');
    } else {
      dot.className = 'dash-status-dot gray';
      label.textContent = 'Never published from here';
    }
  }

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
      badge.className = 'badge badge-' + a.status; badge.textContent = a.status;
      var edit = document.createElement('a');
      edit.className = 'btn btn-sm';
      edit.href = '/admin/article?id=' + encodeURIComponent(a.id);
      edit.textContent = 'Edit';

      acts.appendChild(badge); acts.appendChild(edit);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  /* ── Company row — team, tasks, onboarding, finance-at-a-glance ────── */
  async function loadCompany() {
    var wrap = document.getElementById('dash-company');
    if (!wrap || !window.adminRoles) return;

    var role = await window.adminRoles.role();
    if (!role) return;   // no employee/admin record — keep the row hidden
    var manager = role === 'owner' || role === 'admin';

    var t0 = window.admin.localDate();
    var monthStart = t0.slice(0, 8) + '01';

    var queries = [
      window.sb.from('tasks').select('status,due_date').neq('status', 'done').limit(1000),
      window.sb.from('employees').select('id,status'),
      window.sb.from('onboarding_items').select('id').eq('active', true),
      window.sb.from('onboarding_progress').select('employee_id,item_id,done').eq('done', true)
    ];
    if (manager) {
      queries.push(window.sb.from('finance_transactions').select('amount').gte('posted_at', monthStart).limit(5000));
    }
    var rs = await Promise.allSettled(queries);
    function ok(i) { return rs[i] && rs[i].status === 'fulfilled' && !rs[i].value.error ? (rs[i].value.data || []) : null; }

    var cards = [];

    var tasks = ok(0);
    if (tasks) {
      var overdue = tasks.filter(function (r) { return r.due_date && r.due_date < t0; }).length;
      cards.push({ href: '/admin/tasks', color: '#0071e3', n: tasks.length, label: 'Open tasks',
        n2: overdue ? overdue + ' overdue' : 'none overdue', n2Color: overdue ? '#b3261e' : null,
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' });
    }

    var emps = ok(1);
    if (emps) {
      var invited = emps.filter(function (e) { return e.status === 'invited'; }).length;
      cards.push({ href: '/admin/team', color: '#34c759', n: emps.length, label: 'Team',
        n2: invited ? invited + ' invite' + (invited === 1 ? '' : 's') + ' pending' : 'all aboard',
        icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' });
    }

    var items = ok(2), prog = ok(3);
    if (emps && items && prog && items.length) {
      var activeIds = emps.filter(function (e) { return e.status !== 'inactive'; }).map(function (e) { return e.id; });
      var doneBy = {};
      prog.forEach(function (p) { doneBy[p.employee_id] = (doneBy[p.employee_id] || 0) + 1; });
      var inProgress = activeIds.filter(function (id) { return (doneBy[id] || 0) < items.length; }).length;
      cards.push({ href: '/admin/onboarding', color: '#5856d6', n: inProgress, label: 'Onboarding',
        n2: inProgress ? 'still working through' : 'everyone complete',
        icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>' });
    }

    if (manager) {
      var tx = ok(4);
      if (tx) {
        var net = tx.reduce(function (s, r) { return s + Number(r.amount); }, 0);
        var fmtNet = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(net);
        cards.push({ href: '/admin/finance', color: net >= 0 ? '#34c759' : '#ff3b30', n: fmtNet, label: 'Net this month',
          n2: tx.length + ' transactions',
          icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>' });
      }
    }

    /* Only when there is something to act on. A permanent "0 waiting" card
       would be one more number to skip past on a screen already full of them. */
    if (manager) {
      var pend = await window.sb.from('publish_requests')
        .select('id', { count: 'exact', head: true }).eq('status', 'pending');
      if (!pend.error && pend.count) {
        cards.push({ href: '/admin/publish', color: '#ff9500', n: pend.count,
          label: pend.count === 1 ? 'Publish request' : 'Publish requests',
          n2: 'waiting for you', n2Color: '#b3261e',
          icon: '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>' });
      }
    }

    if (!cards.length) return;
    window.admin.statCards(wrap, cards);
    wrap.hidden = false;
  }

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
    loadStats(); loadArticles(); loadCompany();
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
