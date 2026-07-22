/* Team page: stat row, directory with expandable inline profiles, sticky
   invite panel (managers). Each profile pulls together editable details,
   onboarding progress, and open tasks — Team is the hub. */
(function () {
  'use strict';

  var listEl = document.getElementById('team-list');
  var msg    = document.getElementById('msg');
  var isManager = false;
  var expandedId = null;       // employee id whose profile is open
  var employees = [];

  var ROLES = ['owner', 'admin', 'assistant', 'employee'];
  var ROLE_BADGE = { owner: 'badge-live', admin: 'badge-published', assistant: 'badge-beta', employee: 'badge-inactive' };
  var ROLE_COLOR = { owner: '#0071e3', admin: '#5856d6', assistant: '#ff9500', employee: '#86868b' };
  var STATUS_DOT = { active: 'green', invited: 'amber', inactive: 'gray' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  async function load() {
    isManager = await window.adminRoles.isManager();
    var invitePane = document.getElementById('invite-pane');
    var inviteJump = document.getElementById('invite-jump');
    if (invitePane) invitePane.hidden = !isManager;
    if (inviteJump) inviteJump.hidden = !isManager;

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status,start_date,phone,notes,user_id')
      .order('created_at');
    if (res.error) { setMsg('Could not load team: ' + res.error.message, 'err'); return; }
    employees = res.data || [];
    render();
    loadStats();
  }

  async function loadStats() {
    var wrap = document.getElementById('team-stats');
    if (!wrap) return;
    var active  = employees.filter(function (e) { return e.status === 'active'; }).length;
    var invited = employees.filter(function (e) { return e.status === 'invited'; }).length;

    var open = await window.sb.from('tasks')
      .select('id', { count: 'exact', head: true }).neq('status', 'done');

    var cards = [
      { n: employees.length,           l: 'Team members' },
      { n: active,                     l: 'Active' },
      { n: invited,                    l: 'Invites pending' },
      { n: open.error ? '–' : (open.count || 0), l: 'Open tasks' }
    ];
    wrap.innerHTML = cards.map(function (c) {
      return '<div class="adm-stat"><div class="adm-stat-n">' + c.n +
             '</div><div class="adm-stat-l">' + c.l + '</div></div>';
    }).join('');
  }

  function render() {
    if (!listEl) return;
    var countEl = document.getElementById('team-count');
    if (countEl) countEl.textContent = employees.length + (employees.length === 1 ? ' person' : ' people');

    if (!employees.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>' +
          '<p>No team members yet.</p>' +
          (isManager ? '<p style="font-size:.85rem;color:var(--muted)">Send your first invite from the panel on the right.</p>' : '') +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    employees.forEach(function (e) { listEl.appendChild(renderRow(e)); });
  }

  function renderRow(e) {
    var li = document.createElement('li');
    li.className = 'adm-item adm-item--stack';
    li.style.cursor = 'pointer';

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
    dot.title = e.status;
    acts.appendChild(dot);
    var badge = document.createElement('span');
    badge.className = 'badge ' + (e.status === 'inactive' ? 'badge-inactive' : (ROLE_BADGE[e.role] || 'badge-inactive'));
    badge.textContent = e.status === 'inactive' ? 'inactive' : e.role;
    acts.appendChild(badge);
    var chev = document.createElement('span');
    chev.className = 'chev' + (e.id === expandedId ? ' open' : '');
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>';
    acts.appendChild(chev);

    li.appendChild(av); li.appendChild(main); li.appendChild(acts);

    if (e.id === expandedId) li.appendChild(renderDetail(e));

    li.addEventListener('click', function () {
      expandedId = expandedId === e.id ? null : e.id;
      render();
    });
    return li;
  }

  /* ── Inline profile detail ─────────────────────────────────────────── */

  function renderDetail(e) {
    var wrap = document.createElement('div');
    wrap.className = 'adm-item-detail';

    var roAttr = isManager ? '' : ' disabled';

    wrap.innerHTML =
      '<div class="row-2">' +
        '<div class="field"><label>Full name</label><input class="input" data-f="full_name" value="' + esc(e.full_name) + '"' + roAttr + ' /></div>' +
        '<div class="field"><label>Job title</label><input class="input" data-f="title" value="' + esc(e.title) + '" placeholder="Personal Assistant"' + roAttr + ' /></div>' +
      '</div>' +
      '<div class="row-2">' +
        '<div class="field"><label>Phone</label><input class="input" data-f="phone" value="' + esc(e.phone) + '" placeholder="+49 …"' + roAttr + ' /></div>' +
        '<div class="field"><label>Start date</label><input class="input" data-f="start_date" type="date" value="' + esc(e.start_date) + '"' + roAttr + ' /></div>' +
      '</div>' +
      (isManager ?
      '<div class="row-2">' +
        '<div class="field"><label>Role</label><select class="input" data-f="role">' +
          ROLES.map(function (r) { return '<option value="' + r + '"' + (r === e.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>Status</label><select class="input" data-f="status">' +
          ['invited', 'active', 'inactive'].map(function (s) { return '<option value="' + s + '"' + (s === e.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select></div>' +
      '</div>' : '') +
      '<div class="field"><label>Notes</label><textarea class="input" data-f="notes" rows="2" placeholder="Emergency contact, working hours…"' + roAttr + '>' + esc(e.notes) + '</textarea></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px">' +
        (isManager ? '<button class="btn btn-primary btn-sm" data-act="save" type="button">Save changes</button>' : '') +
        '<a class="btn btn-sm" href="/admin/onboarding?emp=' + e.id + '">Onboarding <span data-slot="ob" style="color:var(--muted)">…</span></a>' +
        '<a class="btn btn-sm" href="/admin/tasks?assignee=' + e.id + '">Tasks <span data-slot="tasks" style="color:var(--muted)">…</span></a>' +
        '<span class="msg" data-slot="cardmsg" style="min-height:0"></span>' +
      '</div>';

    wrap.addEventListener('click', function (ev) { ev.stopPropagation(); });

    var saveBtn = wrap.querySelector('[data-act="save"]');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveProfile(e, wrap); });

    loadProfileStats(e, wrap);
    return wrap;
  }

  async function loadProfileStats(e, wrap) {
    var obSlot = wrap.querySelector('[data-slot="ob"]');
    var taskSlot = wrap.querySelector('[data-slot="tasks"]');

    var items = await window.sb.from('onboarding_items').select('id').eq('active', true);
    var prog  = await window.sb.from('onboarding_progress').select('item_id').eq('employee_id', e.id).eq('done', true);
    if (obSlot && !items.error && !prog.error) {
      var total = (items.data || []).length;
      var done  = (prog.data || []).length;
      obSlot.textContent = done + '/' + total;
      if (total && done === total) obSlot.style.color = '#1a7f37';
    }

    var open = await window.sb.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assignee_id', e.id).neq('status', 'done');
    if (taskSlot && !open.error) taskSlot.textContent = (open.count || 0) + ' open';
  }

  async function saveProfile(e, wrap) {
    var patch = {};
    wrap.querySelectorAll('[data-f]').forEach(function (el) {
      var v = (el.value || '').trim();
      patch[el.getAttribute('data-f')] = v || null;
    });
    if (!patch.full_name) { cardMsg(wrap, 'Full name is required.', 'err'); return; }

    var res = await window.sb.from('employees').update(patch).eq('id', e.id);
    if (res.error) { cardMsg(wrap, 'Save failed: ' + res.error.message, 'err'); return; }
    var idx = employees.findIndex(function (x) { return x.id === e.id; });
    if (idx !== -1) employees = employees.slice(0, idx).concat([Object.assign({}, employees[idx], patch)], employees.slice(idx + 1));
    render();
    loadStats();
    window.admin.toast('Saved ' + patch.full_name);
  }

  function cardMsg(wrap, t, k) {
    var el = wrap.querySelector('[data-slot="cardmsg"]');
    if (el) { el.textContent = t; el.className = 'msg' + (k ? ' ' + k : ''); }
  }

  /* ── Invite flow ───────────────────────────────────────────────────── */

  var inviteJump = document.getElementById('invite-jump');
  if (inviteJump) {
    inviteJump.addEventListener('click', function () {
      var el = document.getElementById('e-name');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { el.focus(); }, 300); }
    });
  }

  var inviteBtn = document.getElementById('invite-btn');
  if (inviteBtn) {
    inviteBtn.addEventListener('click', async function () {
      var name  = (document.getElementById('e-name').value || '').trim();
      var email = (document.getElementById('e-email').value || '').trim();
      var title = (document.getElementById('e-title').value || '').trim();
      var role  = document.getElementById('e-role').value;
      var start = document.getElementById('e-start').value || null;

      if (!name)  { setMsg('Enter their full name.', 'err'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('Enter a valid email address.', 'err'); return; }

      inviteBtn.disabled = true;
      setMsg('Sending invite…');
      try {
        var out = await window.adminRoles.invokeFn('invite-employee', {
          email: email, full_name: name, role: role, title: title || null, start_date: start
        });
        setMsg('');
        window.admin.toast(out.invited
          ? 'Invite sent to ' + email
          : email + ' linked to existing account');
        document.getElementById('e-name').value = '';
        document.getElementById('e-email').value = '';
        document.getElementById('e-title').value = '';
        load();
      } catch (err) {
        setMsg('Invite failed: ' + err.message, 'err');
      } finally {
        inviteBtn.disabled = false;
      }
    });
  }

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
