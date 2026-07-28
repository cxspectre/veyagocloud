/* Team member detail page — /admin/member?id=<employees.id>
   Everything you can DO to one person lives here: edit their profile, work
   their onboarding checklist, see what they still owe. The Team list stays a
   list. Opened cold from a deep link or a bookmark, so nothing is assumed
   about the previous page — the id comes from the query string and a missing
   or invisible record renders a real empty state. */
(function () {
  'use strict';

  var params   = new URLSearchParams(window.location.search);
  var memberId = params.get('id');

  var msg = document.getElementById('msg');

  var isManager    = false;
  var selfEmployee = null;
  var member       = null;   // the employees row
  var items        = [];     // active onboarding_items
  var progress     = {};     // item_id → onboarding_progress row
  var openTasks    = [];
  var isSelf       = false;  // viewing your own record

  var FIELDS = ['full_name', 'title', 'phone', 'start_date', 'role', 'status', 'notes'];
  var TABS   = ['profile', 'onboarding', 'tasks'];

  var ROLE_BADGE  = { owner: 'badge-role-owner', admin: 'badge-role-admin', assistant: 'badge-role-assistant', employee: 'badge-role-employee' };
  var ROLE_COLOR  = { owner: '#0071e3', admin: '#5856d6', assistant: '#ff9500', employee: '#86868b' };
  /* Must match the role descriptions on team.html.

     Assistant and Employee read identically because they ARE identical in the
     product today: all four roles write content via is_staff() (migration 0007),
     and the only publish UI is mounted behind requireManager() (settings.js), so
     neither can reach it. functions/deploy authorises assistants to publish and
     nothing exposes that — until the UI or the function changes, saying otherwise
     here would promise access the person will not have. */
  var ROLE_ACCESS = {
    owner:     'Everything, incl. finance and publishing',
    admin:     'Everything, incl. finance and publishing',
    assistant: 'Create and edit site content, tasks, onboarding',
    employee:  'Create and edit site content, tasks, onboarding'
  };
  var STATUS_DOT  = { active: 'green', invited: 'amber', inactive: 'gray' };
  var STATUS_BADGE = { todo: 'badge-neutral', in_progress: 'badge-info', blocked: 'badge-warn', done: 'badge-success' };
  var STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

  /* employees.id is a uuid. Handing Postgres anything else raises a 400 that
     reads like a server fault, when the honest answer is "no such person". */
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* Escapes for BOTH text and quoted-attribute contexts — see team.js:esc.
     Quotes must be escaped explicitly or a stored name can break out of an
     attribute and inject a live event handler. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function slotMsg(id, t, k) {
    var el = document.getElementById(id);
    if (el) { el.textContent = t || ''; el.className = 'msg' + (k ? ' ' + k : ''); }
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  function emptyState(icon, text) {
    return '<li class="dash-empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true">' + icon + '</svg>' +
      '<p>' + esc(text) + '</p></li>';
  }

  var ICON_CHECK = '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>';

  /* ── Tabs (state lives in the URL hash, so reloads and shared links keep it) ── */

  function currentTab() {
    var h = (window.location.hash || '').replace(/^#/, '');
    return TABS.indexOf(h) === -1 ? 'profile' : h;
  }

  function showTab(name) {
    TABS.forEach(function (t) {
      var on    = t === name;
      var btn   = document.getElementById('tab-' + t);
      var panel = document.getElementById('panel-' + t);
      if (btn) {
        btn.className = 'adm-tab' + (on ? ' active' : '');
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      }
      if (panel) panel.hidden = !on;
    });
  }

  function wireTabs() {
    TABS.forEach(function (t, idx) {
      var btn = document.getElementById('tab-' + t);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (currentTab() === t) { showTab(t); return; }   // hash already right
        window.location.hash = t;                          // → hashchange → showTab
      });
      btn.addEventListener('keydown', function (ev) {
        var next = -1;
        if (ev.key === 'ArrowRight') next = (idx + 1) % TABS.length;
        else if (ev.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = TABS.length - 1;
        if (next === -1) return;
        ev.preventDefault();
        window.location.hash = TABS[next];
        var target = document.getElementById('tab-' + TABS[next]);
        if (target) target.focus();
      });
    });
    window.addEventListener('hashchange', function () { showTab(currentTab()); });
    showTab(currentTab());
  }

  /* ── Load ──────────────────────────────────────────────────────────── */

  function stopLoading() {
    var el = document.getElementById('m-loading');
    if (el) el.hidden = true;
  }

  function showMissing(text) {
    stopLoading();
    document.getElementById('m-body').hidden = true;
    document.getElementById('m-missing-text').textContent = text;
    document.getElementById('m-missing').hidden = false;
  }

  async function load() {
    isManager    = await window.adminRoles.isManager();
    selfEmployee = await window.adminRoles.employee();

    if (!memberId || !UUID_RE.test(memberId)) {
      showMissing('No team member was specified. Pick someone from the Team directory.');
      return;
    }

    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status,start_date,phone,notes,user_id,created_at')
      .eq('id', memberId).maybeSingle();
    if (res.error) { stopLoading(); setMsg('Could not load this member: ' + res.error.message, 'err'); return; }
    if (!res.data) {
      showMissing('That team member no longer exists, or you do not have access to them.');
      return;
    }

    member = res.data;
    isSelf = !!(selfEmployee && selfEmployee.id === member.id);
    document.title = member.full_name + ' · Veyago Admin';
    stopLoading();
    document.getElementById('m-body').hidden = false;

    renderHead();
    renderForm();
    renderFacts();
    renderDanger();
    await Promise.all([loadOnboarding(), loadTasks()]);
  }

  /* ── Identity block ────────────────────────────────────────────────── */

  function renderHead() {
    var av = document.getElementById('m-avatar');
    av.textContent = initials(member.full_name);
    av.style.background = member.status === 'inactive' ? '#c7c7cc' : (ROLE_COLOR[member.role] || '#86868b');

    document.getElementById('m-name').textContent = member.full_name;

    document.getElementById('m-meta').innerHTML =
      (member.title ? '<span>' + esc(member.title) + '</span>' : '') +
      '<a href="mailto:' + esc(member.email) + '">' + esc(member.email) + '</a>' +
      '<span class="dot ' + (STATUS_DOT[member.status] || 'gray') + '" aria-hidden="true"></span>' +
      '<span>' + esc(member.status) + '</span>' +
      '<span class="badge ' + (ROLE_BADGE[member.role] || 'badge-role-employee') + '">' + esc(member.role) + '</span>';

    /* Set as properties, never through innerHTML — no parsing, no injection. */
    document.getElementById('m-email-btn').href = 'mailto:' + member.email;
    document.getElementById('m-task-btn').href  = '/admin/tasks?assignee=' + encodeURIComponent(member.id);
    document.getElementById('ob-link').href     = '/admin/onboarding?emp=' + encodeURIComponent(member.id);
    document.getElementById('task-link').href   = '/admin/tasks?assignee=' + encodeURIComponent(member.id);
  }

  function renderFacts() {
    document.getElementById('fact-signin').textContent = member.user_id ? 'Linked' : 'Not linked yet';
    document.getElementById('fact-access').textContent = ROLE_ACCESS[member.role] || ROLE_ACCESS.employee;
    document.getElementById('fact-added').textContent  = member.created_at ? member.created_at.slice(0, 10) : '—';
  }

  /* ── Profile form ──────────────────────────────────────────────────── */

  /* Nobody may change their OWN role or status, manager or not.
     employee_role() ignores inactive rows and is_manager() has no legacy
     fallback since 0007, so the instant a sole owner sets themselves to
     inactive — or demotes themselves to employee — is_manager() goes false and
     employees is manager-write-only. They cannot undo it from the app at all;
     it takes the SQL console. Cheap to prevent, expensive to recover from. */
  function lockedForSelf(field) {
    return isSelf && (field === 'role' || field === 'status');
  }

  function renderForm() {
    FIELDS.forEach(function (f) {
      var el = document.getElementById('f-' + f);
      if (!el) return;
      el.value = member[f] == null ? '' : member[f];
      el.disabled = !isManager || lockedForSelf(f);
    });
    var save = document.getElementById('m-save');
    save.hidden = !isManager;
    if (!isManager) {
      slotMsg('m-form-msg', 'Only owners and admins can change these details.');
    } else if (isSelf) {
      slotMsg('m-form-msg', 'You cannot change your own role or status — ask another owner or admin, otherwise you could lock yourself out.');
    }
  }

  async function save() {
    var btn = document.getElementById('m-save');
    var patch = {};
    FIELDS.forEach(function (f) {
      /* Skip, don't just disable — a disabled input is a UI hint, and the
         patch must not carry role/status for your own record even if someone
         re-enables the field in devtools. */
      if (lockedForSelf(f)) return;
      var el = document.getElementById('f-' + f);
      var v = (el.value || '').trim();
      patch[f] = v || null;
    });

    if (!patch.full_name) {
      slotMsg('m-form-msg', 'Full name is required.', 'err');
      document.getElementById('f-full_name').focus();
      return;
    }

    btn.disabled = true;
    slotMsg('m-form-msg', 'Saving…');
    var res = await window.sb.from('employees').update(patch).eq('id', member.id);
    btn.disabled = false;
    if (res.error) { slotMsg('m-form-msg', 'Save failed: ' + res.error.message, 'err'); return; }

    member = Object.assign({}, member, patch);   // new object, never mutated
    document.title = member.full_name + ' · Veyago Admin';
    slotMsg('m-form-msg', '');
    renderHead();
    renderFacts();
    renderDanger();
    window.admin.toast('Saved ' + member.full_name);
  }

  /* ── Danger zone (managers only) ───────────────────────────────────── */

  function renderDanger() {
    var zone = document.getElementById('m-danger');
    zone.hidden = !isManager;
    if (!isManager) return;

    var inactive = member.status === 'inactive';

    document.getElementById('m-deactivate').hidden = isSelf || inactive;
    document.getElementById('m-resend').hidden     = member.status !== 'invited';

    document.getElementById('m-danger-note').textContent = isSelf
      ? 'This is your own account. Deactivating yourself would lock you out, so it has to be done from another owner or admin login.'
      : inactive
        ? 'This member is deactivated and cannot sign in. Set Status back to Active above to restore access.'
        : 'Deactivating blocks their sign-in immediately and hides them from pickers. Their tasks, notes and onboarding history are kept.';
  }

  async function deactivate() {
    if (!confirm('Deactivate ' + member.full_name + '?\n\nThey lose access immediately. The record and all history are kept.')) return;
    var btn = document.getElementById('m-deactivate');
    btn.disabled = true;
    var res = await window.sb.from('employees').update({ status: 'inactive' }).eq('id', member.id);
    btn.disabled = false;
    if (res.error) { slotMsg('m-danger-msg', 'Could not deactivate: ' + res.error.message, 'err'); return; }

    member = Object.assign({}, member, { status: 'inactive' });
    document.getElementById('f-status').value = 'inactive';
    slotMsg('m-danger-msg', '');
    renderHead();
    renderDanger();
    window.admin.toast(member.full_name + ' deactivated');
  }

  async function resendInvite() {
    var btn = document.getElementById('m-resend');
    btn.disabled = true;
    slotMsg('m-danger-msg', 'Sending invite…');
    try {
      var out = await window.adminRoles.invokeFn('invite-employee', {
        email: member.email,
        full_name: member.full_name,
        role: member.role,
        title: member.title,
        start_date: member.start_date
      });
      if (out.emailSent === false) {
        /* The employees row exists either way — the link is what failed to
           arrive, and without it they still cannot get in. Say so plainly. */
        slotMsg('m-danger-msg', 'The record is fine, but the invite email did NOT send: ' +
          (out.emailError || 'unknown error') + ' — fix email in Settings, then try again.', 'err');
      } else {
        slotMsg('m-danger-msg', '');
        window.admin.toast('Invite resent to ' + member.email);
      }
    } catch (err) {
      slotMsg('m-danger-msg', 'Resend failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* ── Onboarding ────────────────────────────────────────────────────── */

  function canTickOnboarding() {
    return isManager || !!(selfEmployee && selfEmployee.id === member.id);
  }

  async function loadOnboarding() {
    var its = await window.sb.from('onboarding_items')
      .select('id,title,description,category,sort_order')
      .eq('active', true).order('sort_order');
    if (its.error) { slotMsg('ob-msg', 'Could not load the checklist: ' + its.error.message, 'err'); return; }
    items = its.data || [];

    var pr = await window.sb.from('onboarding_progress')
      .select('item_id,done,done_at').eq('employee_id', member.id);
    if (pr.error) { slotMsg('ob-msg', 'Could not load their progress: ' + pr.error.message, 'err'); return; }

    var next = {};
    (pr.data || []).forEach(function (p) { next[p.item_id] = p; });
    progress = next;
    slotMsg('ob-msg', '');
    renderOnboarding();
  }

  function isDone(item) { var p = progress[item.id]; return !!(p && p.done); }

  function renderOnboarding() {
    var done  = items.filter(isDone).length;
    var total = items.length;
    var pct   = total ? Math.round((done / total) * 100) : 0;

    var bar = document.getElementById('ob-bar');
    bar.className = 'adm-progress' + (total && done === total ? ' done' : '');
    bar.querySelector('i').style.width = pct + '%';
    /* An empty rail over "0/0 complete" reads like a stalled checklist rather
       than no checklist at all. */
    document.getElementById('ob-progress-wrap').hidden = !total;
    document.getElementById('ob-count').textContent = done + '/' + total + ' complete';
    document.getElementById('tab-onboarding-n').textContent = total ? ' · ' + done + '/' + total : '';
    document.getElementById('fact-onboarding').textContent = total ? done + ' of ' + total + ' done' : 'No checklist yet';

    var listEl = document.getElementById('ob-list');
    if (!total) {
      listEl.innerHTML = emptyState(ICON_CHECK, 'No checklist items yet — add them on the Onboarding page.');
      return;
    }
    listEl.innerHTML = '';
    /* Still-open items first: this page is for finishing the list, not admiring it. */
    items.filter(function (i) { return !isDone(i); })
      .concat(items.filter(isDone))
      .forEach(function (item) { listEl.appendChild(renderObRow(item)); });
  }

  function renderObRow(item) {
    var done = isDone(item);
    var p    = progress[item.id];
    var li   = document.createElement('li');
    li.className = 'adm-item';

    var mark = done
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2.2" stroke-linecap="round" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" width="18" height="18"><circle cx="12" cy="12" r="9"/></svg>';

    /* The circle/check IS the toggle — a big hit target. Read-only viewers get
       the same glyph as a plain div, so the row never looks clickable in vain. */
    var icon;
    if (canTickOnboarding()) {
      icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'adm-item-icon';
      icon.style.cssText = 'border:none;cursor:pointer;background:' + (done ? '#e7f6ec' : 'var(--bg-card)');
      icon.setAttribute('aria-label', (done ? 'Mark not done: ' : 'Mark done: ') + item.title);
      icon.addEventListener('click', function () { toggleItem(item, !done, icon); });
    } else {
      icon = document.createElement('div');
      icon.className = 'adm-item-icon';
      icon.setAttribute('aria-hidden', 'true');
      if (done) icon.style.background = '#e7f6ec';
    }
    icon.innerHTML = mark;

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = item.title;
    if (done) { t.style.textDecoration = 'line-through'; t.style.color = 'var(--muted)'; }
    var s = document.createElement('div'); s.className = 'adm-item-sub';
    s.textContent = (item.description || '') +
      (done && p && p.done_at ? (item.description ? ' · ' : '') + 'done ' + fmtDay(p.done_at) : '');
    main.appendChild(t);
    if (s.textContent) main.appendChild(s);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (done ? 'badge-success' : 'badge-neutral');
    badge.textContent = done ? 'done' : (item.category || 'general');
    acts.appendChild(badge);

    li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
    return li;
  }

  async function toggleItem(item, done, btn) {
    btn.disabled = true;
    var stamp = done ? new Date().toISOString() : null;
    var res = await window.sb.from('onboarding_progress').upsert({
      employee_id: member.id, item_id: item.id, done: done, done_at: stamp
    });
    btn.disabled = false;
    if (res.error) { slotMsg('ob-msg', 'Could not update "' + item.title + '": ' + res.error.message, 'err'); return; }

    var next = {};
    Object.keys(progress).forEach(function (k) { next[k] = progress[k]; });
    next[item.id] = { item_id: item.id, done: done, done_at: stamp };
    progress = next;                                   // new object, never mutated
    slotMsg('ob-msg', '');
    renderOnboarding();
  }

  /* ── Tasks ─────────────────────────────────────────────────────────── */

  async function loadTasks() {
    var res = await window.sb.from('tasks')
      .select('id,title,details,status,priority,due_date')
      .eq('assignee_id', member.id).neq('status', 'done')
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (res.error) { slotMsg('task-msg', 'Could not load their tasks: ' + res.error.message, 'err'); return; }
    openTasks = res.data || [];
    slotMsg('task-msg', '');
    renderTasks();
  }

  function renderTasks() {
    var n = openTasks.length;
    document.getElementById('tab-tasks-n').textContent = n ? ' · ' + n : '';
    document.getElementById('fact-tasks').textContent  = n ? n + ' open' : 'Nothing open';

    var listEl = document.getElementById('task-list');
    if (!n) {
      listEl.innerHTML = emptyState(ICON_CHECK, 'Nothing open — everything assigned to them is done.');
      return;
    }
    var t0 = window.admin.localDate();
    listEl.innerHTML = '';
    openTasks.forEach(function (t) { listEl.appendChild(renderTaskRow(t, t0)); });
  }

  /* The row is an anchor for the reasons team.js:82-90 sets out: focusable,
     works with Enter and middle-click, and survives a cold reload of
     /admin/task?id=…. It was an inert <li>, which made this the second of three
     task lists that could not reach the task. */
  function renderTaskRow(t, t0) {
    var li = document.createElement('li');

    var row = document.createElement('a');
    row.className = 'adm-item adm-item--link' +
      (t.priority === 'urgent' ? ' pri-urgent' : '') +
      (t.priority === 'high' ? ' pri-high' : '');
    row.href = '/admin/task?id=' + encodeURIComponent(t.id);
    row.setAttribute('aria-label',
      t.title + ', ' + (STATUS_LABEL[t.status] || t.status) +
      (t.due_date ? ', due ' + t.due_date : '') + ' — open task');

    var icon = document.createElement('div'); icon.className = 'adm-item-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" width="18" height="18"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = t.title;
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    /* Overdue is decided against the LOCAL calendar day — due_date is a plain
       date, so a UTC comparison marks today's work late east of UTC. */
    var overdue = t.due_date && t.due_date < t0;
    sub.innerHTML = (t.due_date
        ? '<span' + (overdue ? ' class="due-over"' : '') + '>due ' + esc(t.due_date) + '</span>'
        : 'no due date') +
      (t.details ? ' · ' + esc(t.details) : '');
    main.appendChild(title); main.appendChild(sub);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (STATUS_BADGE[t.status] || 'badge-neutral');
    badge.textContent = STATUS_LABEL[t.status] || t.status;
    acts.appendChild(badge);

    var chev = document.createElement('span');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>';
    acts.appendChild(chev);

    row.appendChild(icon); row.appendChild(main); row.appendChild(acts);
    li.appendChild(row);
    return li;
  }

  /* ── Wiring ────────────────────────────────────────────────────────── */

  wireTabs();

  var saveBtn = document.getElementById('m-save');
  if (saveBtn) saveBtn.addEventListener('click', save);

  var deactivateBtn = document.getElementById('m-deactivate');
  if (deactivateBtn) deactivateBtn.addEventListener('click', deactivate);

  var resendBtn = document.getElementById('m-resend');
  if (resendBtn) resendBtn.addEventListener('click', resendInvite);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
