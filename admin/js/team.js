/* Team page: stat row, directory, sticky invite panel (managers).
   The directory is a directory — each row links through to /admin/member?id=…
   where the profile, onboarding and tasks for that person actually live.
   Nothing is edited from this screen except sending a new invite. */
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
    var invitePane = document.getElementById('invite-pane');
    var inviteJump = document.getElementById('invite-jump');
    if (invitePane) invitePane.hidden = !isManager;
    if (inviteJump) inviteJump.hidden = !isManager;

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status')
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
          (isManager ? '<p style="font-size:.85rem;color:var(--muted)">Send your first invite from the panel on the right.</p>' : '') +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    employees.forEach(function (e) { listEl.appendChild(renderRow(e)); });
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
      /* The select opens on a blank option, so an untouched form has no role.
         Refusing here is what makes the choice deliberate rather than default. */
      if (!role) { document.getElementById('e-role').focus(); setMsg('Choose a role for this person.', 'err'); return; }

      inviteBtn.disabled = true;
      setMsg('Sending invite…');
      try {
        var out = await window.adminRoles.invokeFn('invite-employee', {
          email: email, full_name: name, role: role, title: title || null, start_date: start
        });
        if (out.emailSent === false) {
          /* The record exists but they never got the link — say so loudly,
             otherwise this looks like success and the person never appears.

             This used to say "fix email in Settings". Settings cannot fix it:
             its Email pane is a read-only send log. Delivery depends on
             RESEND_API_KEY, a Supabase secret set from a terminal, so name that
             instead of routing the manager to a screen that cannot help. */
          setMsg('Added ' + name + ' — but the invite email did not send: ' +
                 (out.emailError || 'unknown error') +
                 ' Delivery needs RESEND_API_KEY set as a Supabase secret from a terminal ' +
                 '(supabase secrets set RESEND_API_KEY=…). Once it is set, use ' +
                 '"Resend invite" on their profile.', 'err');
          /* #msg sits above the stat row while the invite panel is sticky at the
             top of the viewport, so at the moment of clicking this message is
             off-screen — the one message that must not be missed. */
          if (msg && msg.scrollIntoView) msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          setMsg('');
          window.admin.toast(out.invited
            ? 'Invite sent to ' + email
            : email + ' linked to existing account');
        }
        /* Reset the whole form, not just the text fields. Leaving role and
           start date populated meant the next invite silently inherited the
           previous person's privilege level. */
        document.getElementById('e-name').value = '';
        document.getElementById('e-email').value = '';
        document.getElementById('e-title').value = '';
        document.getElementById('e-role').value = '';
        document.getElementById('e-start').value = '';
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
