/* Team page: employee directory with expandable profile cards, invite flow
   (via Edge Function), role and status changes. Each profile pulls together
   editable details, onboarding progress, and open tasks — Team is the hub. */
(function () {
  'use strict';

  var listEl = document.getElementById('team-list');
  var msg    = document.getElementById('msg');
  var isManager = false;
  var expandedId = null;       // employee id whose profile card is open
  var employees = [];

  var ROLES = ['owner', 'admin', 'assistant', 'employee'];
  var ROLE_BADGE = { owner: 'badge-live', admin: 'badge-published', assistant: 'badge-beta', employee: 'badge-draft' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function esc(s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function load() {
    isManager = await window.adminRoles.isManager();
    var invitePane = document.getElementById('invite-pane');
    if (invitePane) invitePane.hidden = !isManager;

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status,start_date,phone,notes,user_id')
      .order('created_at');
    if (res.error) { setMsg('Could not load team: ' + res.error.message, 'err'); return; }
    employees = res.data || [];
    render();
  }

  function render() {
    if (!listEl) return;
    if (!employees.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No team members yet. Invite your first one below.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    employees.forEach(function (e) {
      listEl.appendChild(renderRow(e));
      if (e.id === expandedId) listEl.appendChild(renderProfile(e));
    });
  }

  function renderRow(e) {
    var li = document.createElement('li'); li.className = 'adm-item';
    li.style.cursor = 'pointer';

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var t = document.createElement('div'); t.className = 'adm-item-title';
    t.textContent = e.full_name + (e.title ? ' · ' + e.title : '');
    var s = document.createElement('div'); s.className = 'adm-item-sub';
    s.textContent = e.email + (e.status === 'invited' ? ' · invite pending' : '');
    main.appendChild(t); main.appendChild(s);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (e.status === 'inactive' ? 'badge-draft' : (ROLE_BADGE[e.role] || 'badge-draft'));
    badge.textContent = e.status === 'inactive' ? 'Inactive' : e.role;
    acts.appendChild(badge);

    var chevron = document.createElement('span');
    chevron.style.cssText = 'color:var(--muted-2);font-size:.8rem';
    chevron.textContent = e.id === expandedId ? '▲' : '▼';
    acts.appendChild(chevron);

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    li.addEventListener('click', function () {
      expandedId = expandedId === e.id ? null : e.id;
      render();
    });
    return li;
  }

  /* ── Profile card ──────────────────────────────────────────────────── */

  function renderProfile(e) {
    var li = document.createElement('li');
    li.className = 'card-pane';
    li.style.cssText = 'list-style:none;margin:4px 0 12px;padding:20px';

    var ro = !isManager;
    var roAttr = ro ? ' disabled' : '';

    li.innerHTML =
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
      '<div class="field"><label>Notes</label><textarea class="input" data-f="notes" rows="2" placeholder="Emergency contact, allergies, working hours…"' + roAttr + '>' + esc(e.notes) + '</textarea></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px">' +
        (isManager ? '<button class="btn btn-primary" data-act="save" type="button">Save changes</button>' : '') +
        '<a class="btn" href="/admin/onboarding?emp=' + e.id + '">Onboarding <span data-slot="ob" style="color:var(--muted)">…</span></a>' +
        '<a class="btn" href="/admin/tasks?assignee=' + e.id + '">Tasks <span data-slot="tasks" style="color:var(--muted)">…</span></a>' +
      '</div>' +
      '<p class="msg" data-slot="cardmsg" style="margin-top:10px"></p>';

    li.addEventListener('click', function (ev) { ev.stopPropagation(); });

    var saveBtn = li.querySelector('[data-act="save"]');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveProfile(e, li); });

    loadProfileStats(e, li);
    return li;
  }

  async function loadProfileStats(e, li) {
    var obSlot = li.querySelector('[data-slot="ob"]');
    var taskSlot = li.querySelector('[data-slot="tasks"]');

    var items = await window.sb.from('onboarding_items').select('id').eq('active', true);
    var prog  = await window.sb.from('onboarding_progress').select('item_id,done').eq('employee_id', e.id).eq('done', true);
    if (obSlot && !items.error && !prog.error) {
      var total = (items.data || []).length;
      var done  = (prog.data || []).length;
      obSlot.textContent = done + '/' + total;
      if (total && done === total) { obSlot.style.color = '#1a7f37'; }
    }

    var open = await window.sb.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assignee_id', e.id).neq('status', 'done');
    if (taskSlot && !open.error) {
      taskSlot.textContent = (open.count || 0) + ' open';
    }
  }

  async function saveProfile(e, li) {
    var patch = {};
    li.querySelectorAll('[data-f]').forEach(function (el) {
      var v = (el.value || '').trim();
      patch[el.getAttribute('data-f')] = v || null;
    });
    if (!patch.full_name) { cardMsg(li, 'Full name is required.', 'err'); return; }
    // status/role selects always have a value; text fields null out when blank

    var res = await window.sb.from('employees').update(patch).eq('id', e.id);
    if (res.error) { cardMsg(li, 'Save failed: ' + res.error.message, 'err'); return; }
    cardMsg(li, 'Saved.', 'ok');
    var idx = employees.findIndex(function (x) { return x.id === e.id; });
    if (idx !== -1) employees = employees.slice(0, idx).concat([Object.assign({}, employees[idx], patch)], employees.slice(idx + 1));
    // re-render row title/badge without collapsing the card
    render();
  }

  function cardMsg(li, t, k) {
    var el = li.querySelector('[data-slot="cardmsg"]');
    if (el) { el.textContent = t; el.className = 'msg' + (k ? ' ' + k : ''); }
  }

  /* ── Invite flow ───────────────────────────────────────────────────── */

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
        setMsg(out.invited
          ? 'Invite sent to ' + email + '. They appear below as "invite pending" until they accept.'
          : email + ' already had an account — employee record created and linked.', 'ok');
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

  document.addEventListener('admin:authed', load);
})();
