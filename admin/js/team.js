/* Team page: stat row and directory. Nothing is edited or created here —
   each row links through to /admin/member?id=… where the profile, onboarding
   and tasks for that person live, and adding someone is its own guided flow at
   /admin/member-new. The five-field invite panel that used to sit in the right
   column is gone: it had no <form>, so Enter did nothing; it defaulted the role
   silently; and its only failure message rendered off-screen. */
(function () {
  'use strict';

  var listEl = document.getElementById('team-list');
  var msg    = document.getElementById('msg');
  var isManager = false;
  var employees = [];

  var ROLE_BADGE = { owner: 'badge-role-owner', admin: 'badge-role-admin', assistant: 'badge-role-assistant', employee: 'badge-role-employee' };
  var ROLE_COLOR = { owner: '#0071e3', admin: '#5856d6', assistant: '#ff9500', employee: '#86868b' };
  var STATUS_DOT = { active: 'green', invited: 'amber', inactive: 'gray' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  async function load() {
    isManager = await window.adminRoles.isManager();
    /* Adding someone now has its own screen (/admin/member-new), so this page
       is a directory and nothing else. Managers get the way in. */
    var inviteJump = document.getElementById('invite-jump');
    if (inviteJump) inviteJump.hidden = !isManager;

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status')
      .order('created_at');
    if (res.error) { setMsg('Could not load team: ' + res.error.message, 'err'); return; }
    employees = res.data || [];
    render();
    loadStats();
    if (isManager) loadWorkload();
  }

  async function loadStats() {
    var wrap = document.getElementById('team-stats');
    if (!wrap) return;
    var active  = employees.filter(function (e) { return e.status === 'active'; }).length;
    var invited = employees.filter(function (e) { return e.status === 'invited'; }).length;

    var open = await window.sb.from('tasks')
      .select('id', { count: 'exact', head: true }).neq('status', 'done');

    window.admin.statCards(wrap, [
      { n: employees.length, label: 'Team members', color: '#0071e3',
        n2: employees.length === 1 ? 'just you' : 'on the books',
        icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
      { n: active, label: 'Active', color: '#34c759', n2: 'signed in and working',
        icon: '<polyline points="20 6 9 17 4 12"/>' },
      { n: invited, label: 'Invites pending', color: invited ? '#ff9500' : '#86868b',
        n2: invited ? 'awaiting acceptance' : 'none outstanding',
        icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/>' },
      { n: open.error ? '–' : (open.count || 0), label: 'Open tasks', color: '#5856d6',
        n2: 'across the team', href: '/admin/tasks',
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' }
    ]);
  }

  function render() {
    if (!listEl) return;
    var countEl = document.getElementById('team-count');
    if (countEl) countEl.textContent = employees.length + (employees.length === 1 ? ' person' : ' people');

    if (!employees.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>' +
          '<p>No team members yet.</p>' +
          (isManager ? '<a class="btn btn-primary btn-sm" href="/admin/member-new">Add your first team member</a>' : '') +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    employees.forEach(function (e) { listEl.appendChild(renderRow(e)); });
  }

  async function loadWorkload() {
    var pane   = document.getElementById('workload-pane');
    var listEl = document.getElementById('workload-list');
    if (!pane || !listEl) return;

    /* Show skeletons immediately so the page doesn't jump when data arrives. */
    pane.hidden = false;

    var t0  = window.admin.localDate();
    var res = await window.sb.from('tasks')
      .select('assignee_id,status,due_date')
      .neq('status', 'done')
      .not('assignee_id', 'is', null)
      .limit(2000);

    if (res.error) { pane.hidden = true; return; }

    var tasks = res.data || [];
    var byId  = {};
    tasks.forEach(function (t) {
      var g = byId[t.assignee_id] || (byId[t.assignee_id] = { open: 0, blocked: 0, overdue: 0 });
      g.open++;
      if (t.status === 'blocked') g.blocked++;
      if (t.due_date && t.due_date < t0) g.overdue++;
    });

    var withTasks = employees.filter(function (e) { return byId[e.id]; }).sort(function (a, b) {
      var ga = byId[a.id], gb = byId[b.id];
      if (gb.blocked !== ga.blocked) return gb.blocked - ga.blocked;
      if (gb.overdue !== ga.overdue) return gb.overdue - ga.overdue;
      return gb.open - ga.open;
    });

    if (!withTasks.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>No tasks assigned to anyone yet.</p>' +
        '</li>';
      pane.hidden = false;
      return;
    }

    listEl.innerHTML = '';
    withTasks.forEach(function (e) {
      var g  = byId[e.id];
      var li = document.createElement('li'); li.className = 'adm-item';

      var av = document.createElement('div'); av.className = 'avatar';
      av.style.cssText = 'background:' + (e.status === 'inactive' ? '#c7c7cc' : (ROLE_COLOR[e.role] || '#86868b')) + ';font-size:11px';
      av.textContent = initials(e.full_name);

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = e.full_name;
      var sub   = document.createElement('div'); sub.className = 'adm-item-sub';
      var parts = ['<span>' + g.open + ' open</span>'];
      if (g.blocked) parts.push('<span style="color:var(--fg-warn)">' + g.blocked + ' blocked</span>');
      if (g.overdue) parts.push('<span style="color:var(--fg-danger)">' + g.overdue + ' overdue</span>');
      sub.innerHTML = parts.join(' · ');
      main.appendChild(title); main.appendChild(sub);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      if (g.blocked) {
        var bw = document.createElement('span'); bw.className = 'badge badge-warn'; bw.textContent = 'blocked';
        acts.appendChild(bw);
      } else if (g.overdue) {
        var bd = document.createElement('span'); bd.className = 'badge badge-danger'; bd.textContent = 'overdue';
        acts.appendChild(bd);
      }
      var lnk = document.createElement('a');
      lnk.className = 'btn btn-sm';
      lnk.href = '/admin/tasks?assignee=' + encodeURIComponent(e.id);
      lnk.textContent = 'View tasks';
      acts.appendChild(lnk);

      li.appendChild(av); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
    pane.hidden = false;
  }

  /* A row is a link, not a disclosure control: a real <a> is focusable, works
     with Enter, middle-click and "open in new tab", and survives a cold reload
     of /admin/member?id=… — none of which an accordion managed. */
  function renderRow(e) {
    var li = document.createElement('li');

    var a = document.createElement('a');
    a.className = 'adm-item adm-item--link';
    a.href = '/admin/member?id=' + encodeURIComponent(e.id);
    /* aria-label replaces the whole inner content for screen readers, so it has
       to carry everything the row shows visually. */
    a.setAttribute('aria-label',
      e.full_name + (e.title ? ', ' + e.title : '') + ', ' + e.role + ', ' + e.status + ' — open profile');

    var av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = e.status === 'inactive' ? '#c7c7cc' : (ROLE_COLOR[e.role] || '#86868b');
    av.textContent = initials(e.full_name);

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var t = document.createElement('div'); t.className = 'adm-item-title';
    t.textContent = e.full_name + (e.title ? ' · ' + e.title : '');
    var s = document.createElement('div'); s.className = 'adm-item-sub';
    s.textContent = e.email;
    main.appendChild(t); main.appendChild(s);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var dot = document.createElement('span');
    dot.className = 'dot ' + (STATUS_DOT[e.status] || 'gray');
    dot.setAttribute('aria-hidden', 'true');
    acts.appendChild(dot);
    var badge = document.createElement('span');
    badge.className = 'badge ' + (e.status === 'inactive' ? 'badge-neutral' : (ROLE_BADGE[e.role] || 'badge-role-employee'));
    badge.textContent = e.status === 'inactive' ? 'inactive' : e.role;
    acts.appendChild(badge);
    var chev = document.createElement('span');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>';
    acts.appendChild(chev);

    a.appendChild(av); a.appendChild(main); a.appendChild(acts);
    li.appendChild(a);
    return li;
  }

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
