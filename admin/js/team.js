/* Team page: employee directory, invite flow (via Edge Function), role and
   status changes. Managers get controls; everyone else gets a read-only list. */
(function () {
  'use strict';

  var listEl = document.getElementById('team-list');
  var msg    = document.getElementById('msg');
  var isManager = false;

  var ROLES = ['owner', 'admin', 'assistant', 'employee'];
  var ROLE_BADGE = { owner: 'badge-live', admin: 'badge-published', assistant: 'badge-beta', employee: 'badge-draft' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  async function load() {
    isManager = await window.adminRoles.isManager();
    var invitePane = document.getElementById('invite-pane');
    if (invitePane) invitePane.hidden = !isManager;

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status,start_date,user_id')
      .order('created_at');
    if (res.error) { setMsg('Could not load team: ' + res.error.message, 'err'); return; }
    render(res.data || []);
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No team members yet. Invite your first one below.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (e) { listEl.appendChild(renderRow(e)); });
  }

  function renderRow(e) {
    var li = document.createElement('li'); li.className = 'adm-item';

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var t = document.createElement('div'); t.className = 'adm-item-title';
    t.textContent = e.full_name + (e.title ? ' · ' + e.title : '');
    var s = document.createElement('div'); s.className = 'adm-item-sub';
    s.textContent = e.email + (e.start_date ? ' · started ' + e.start_date : '') +
      (e.status === 'invited' ? ' · invite pending' : '');
    main.appendChild(t); main.appendChild(s);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (e.status === 'inactive' ? 'badge-draft' : (ROLE_BADGE[e.role] || 'badge-draft'));
    badge.textContent = e.status === 'inactive' ? 'Inactive' : e.role;
    acts.appendChild(badge);

    if (isManager) {
      var roleSel = document.createElement('select'); roleSel.className = 'input input-sm';
      ROLES.forEach(function (r) {
        var o = document.createElement('option'); o.value = r; o.textContent = r;
        if (r === e.role) o.selected = true;
        roleSel.appendChild(o);
      });
      roleSel.addEventListener('change', function () { changeRole(e, roleSel.value, roleSel); });
      acts.appendChild(roleSel);

      var toggle = document.createElement('button');
      toggle.className = 'btn btn-sm ' + (e.status === 'inactive' ? '' : 'btn-danger');
      toggle.type = 'button';
      toggle.textContent = e.status === 'inactive' ? 'Reactivate' : 'Deactivate';
      toggle.addEventListener('click', function () { toggleStatus(e); });
      acts.appendChild(toggle);
    }

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    return li;
  }

  async function changeRole(e, role, sel) {
    var res = await window.sb.from('employees').update({ role: role }).eq('id', e.id);
    if (res.error) { setMsg('Role change failed: ' + res.error.message, 'err'); sel.value = e.role; return; }
    setMsg(e.full_name + ' is now ' + role + '.', 'ok');
    load();
  }

  async function toggleStatus(e) {
    var next = e.status === 'inactive' ? 'active' : 'inactive';
    if (next === 'inactive' &&
        !confirm('Deactivate ' + e.full_name + '?\n\nThey immediately lose all dashboard access (RLS enforced). Their record and history are kept.')) return;
    var res = await window.sb.from('employees').update({ status: next }).eq('id', e.id);
    if (res.error) { setMsg('Failed: ' + res.error.message, 'err'); return; }
    setMsg(e.full_name + (next === 'inactive' ? ' deactivated.' : ' reactivated.'), 'ok');
    load();
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
