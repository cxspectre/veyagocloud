/* Add a team member — the guided flow. Replaces the five-field panel that used
   to sit on /admin/team. Spec: docs/add-a-user-flow.md

   Why this one is stepped when almost nothing else here should be: inviting
   somebody has a hidden external prerequisite (email delivery), an irreversible
   half-commit (the account is created before the send is attempted), a
   consequential access decision, and a handoff afterwards. A flat form cannot
   surface a prerequisite before the cost is paid, cannot show consequence
   before commit, and cannot carry a handoff after. Frequent, unbranching jobs —
   a task, a transaction, an invoice — stay single-panel on purpose. */
(function () {
  'use strict';

  var STEPS = [
    { key: 'person', label: 'Person',  el: 'step-person' },
    { key: 'access', label: 'Access',  el: 'step-access' },
    { key: 'review', label: 'Review',  el: 'step-review' }
  ];

  var DRAFT_KEY = 'veyago.admin.invite-draft';
  /* The invite email promises 24 hours (functions/_shared/email.ts). Nothing in
     the schema records when it was sent, so the handoff page is told directly. */
  var EXPIRY_HOURS = 24;

  /* Role copy. Kept honest about what the product actually exposes today:
     all four roles write content via is_staff(), and the only publish UI is
     manager-gated, so Assistant and Employee currently grant the same access.
     When the publish-approval workflow lands, this is where it gets said. */
  var ROLES = [
    { value: 'employee',  title: 'Employee',
      sub: 'Create and edit articles, wallpapers, apps and announcements. Sees tasks, onboarding and the team directory.' },
    { value: 'assistant', title: 'Assistant',
      sub: 'The same access as Employee today. Reserved for staff who will also publish once approvals ship.' },
    { value: 'admin',     title: 'Admin',
      sub: 'Everything above, plus finance, settings, and publishing the live site.', elevated: true },
    { value: 'owner',     title: 'Owner',
      sub: 'Everything. Use for people who run the company, not for people who help run it.', elevated: true }
  ];

  var draft = { name: '', email: '', title: '', start: '', role: '' };
  var directory = [];
  var preflight = null;      // { emailReady, reason, remedy, preview }
  var dashboardItemId = null;
  var sending = false;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function setErr(id, text) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* ── Draft ────────────────────────────────────────────────────────
     A half-filled invite is real work. It used to live in the DOM alone, so a
     stray sidebar click threw it away. */
  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) {}
  }
  function loadDraft() {
    try {
      var raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) draft = Object.assign(draft, JSON.parse(raw) || {});
    } catch (e) {}
  }
  function clearDraft() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  /* ── Step routing ─────────────────────────────────────────────────
     One URL per step, so browser Back moves back a step instead of abandoning
     the flow — the single most common way people lose a wizard's work. */
  function currentStep() {
    var want = new URLSearchParams(window.location.search).get('step');
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].key === want) return i;
    return 0;
  }

  function goStep(i, replace) {
    var url = '/admin/member-new?step=' + STEPS[i].key;
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    renderStep();
  }

  function renderRail(idx) {
    var rail = $('flow-rail');
    if (!rail) return;
    rail.innerHTML = '';
    STEPS.forEach(function (s, i) {
      var d = document.createElement('div');
      d.className = 'flow-step' + (i < idx ? ' done' : i === idx ? ' current' : '');
      d.setAttribute('role', 'listitem');
      if (i === idx) d.setAttribute('aria-current', 'step');
      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = i < idx ? '✓' : String(i + 1);
      var t = document.createElement('span');
      t.textContent = s.label;
      d.appendChild(n); d.appendChild(t);
      rail.appendChild(d);
      if (i < STEPS.length - 1) {
        var sep = document.createElement('span');
        sep.className = 'flow-sep';
        rail.appendChild(sep);
      }
    });
  }

  function renderStep() {
    var idx = currentStep();
    /* Never let a pasted ?step=review skip the decisions it depends on. */
    if (idx >= 1 && !stepOneValid()) idx = 0;
    if (idx >= 2 && !draft.role) idx = 1;

    STEPS.forEach(function (s, i) { show($(s.el), i === idx); });
    renderRail(idx);

    if (idx === 1) renderAccess();
    if (idx === 2) renderReview();

    var h = document.querySelector('#' + STEPS[idx].el + ' h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }

  /* ── Step 1: person ───────────────────────────────────────────── */
  function readPerson() {
    draft.name  = ($('p-name').value || '').trim();
    draft.email = ($('p-email').value || '').trim();
    draft.title = ($('p-title').value || '').trim();
    draft.start = $('p-start').value || '';
    saveDraft();
  }

  function emailLooksReal(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  function stepOneValid() {
    return !!draft.name && emailLooksReal(draft.email) && !findDuplicate(draft.email);
  }

  /* employees.email is UNIQUE but byte-exact — no citext, no lower() index — so
     compare case-insensitively here or a duplicate slips through to the server
     and gets silently upserted onConflict:'email'. */
  function findDuplicate(email) {
    var q = String(email || '').trim().toLowerCase();
    if (!q) return null;
    for (var i = 0; i < directory.length; i++) {
      if (String(directory[i].email || '').toLowerCase() === q) return directory[i];
    }
    return null;
  }

  /* The whole point of the check: branch explicitly instead of overwriting.
     Re-inviting an existing address used to reset that person to 'invited' and
     replace their role and title with whatever this form happened to hold. */
  function renderDuplicate() {
    var slot = $('dupe-slot');
    if (!slot) return;
    var hit = findDuplicate($('p-email').value);
    if (!hit) { slot.innerHTML = ''; return; }

    slot.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'adm-notice adm-notice--warn';

    var h = document.createElement('h3');
    h.textContent = hit.full_name + ' is already on the team';
    var p = document.createElement('p');
    p.textContent = hit.email + ' — ' + hit.role + ', ' + hit.status +
      (hit.title ? ' · ' + hit.title : '') + '.';

    var acts = document.createElement('div');
    acts.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
    var open = document.createElement('a');
    open.className = 'btn btn-sm';
    open.href = '/admin/member?id=' + encodeURIComponent(hit.id);
    open.textContent = 'Open their profile';
    acts.appendChild(open);

    box.appendChild(h); box.appendChild(p); box.appendChild(acts);
    slot.appendChild(box);
  }

  /* ── Step 2: access ───────────────────────────────────────────── */
  function renderAccess() {
    $('access-name').textContent = draft.name.split(/\s+/)[0] || 'they';

    var wrap = $('role-cards');
    if (wrap.childElementCount) { syncElevated(); return; }   // build once

    ROLES.forEach(function (r) {
      var label = document.createElement('label');
      label.className = 'radio-card';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'role';
      input.value = r.value;
      input.checked = draft.role === r.value;

      var body = document.createElement('div');
      var t = document.createElement('div');
      t.className = 'radio-card-title';
      t.textContent = r.title;
      var s = document.createElement('div');
      s.className = 'radio-card-sub';
      s.textContent = r.sub;
      body.appendChild(t); body.appendChild(s);

      input.addEventListener('change', function () {
        draft.role = input.value;
        saveDraft();
        setErr('access-err', '');
        syncElevated();
      });

      label.appendChild(input); label.appendChild(body);
      wrap.appendChild(label);
    });
    syncElevated();
  }

  function roleDef(v) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].value === v) return ROLES[i];
    return null;
  }

  /* Typed confirmation for the two roles that can see the bank ledger and ship
     the public site. Deliberately more friction than a checkbox: the previous
     form handed these out by accident. */
  function syncElevated() {
    var def = roleDef(draft.role);

    /* :has() is not in older Safari — mirror the checked state onto a class. */
    Array.prototype.forEach.call($('role-cards').children, function (card) {
      var input = card.querySelector('input');
      card.classList.toggle('is-picked', !!(input && input.checked));
    });

    var slot = $('elevated-slot');
    if (!def || !def.elevated) {
      show(slot, false);
      $('elevated-confirm').value = '';
      return;
    }
    $('elevated-what').textContent =
      def.title + ' can see and edit finance, change settings, publish the live site, ' +
      'and change other people’s roles.';
    $('elevated-word').textContent = def.value.toUpperCase();
    show(slot, true);
  }

  function elevatedOk() {
    var def = roleDef(draft.role);
    if (!def || !def.elevated) return true;
    return ($('elevated-confirm').value || '').trim().toUpperCase() === def.value.toUpperCase();
  }

  /* ── Step 3: review ───────────────────────────────────────────── */
  function fact(dl, term, value) {
    var dt = document.createElement('dt'); dt.textContent = term;
    var dd = document.createElement('dd'); dd.textContent = value || '—';
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function renderReview() {
    $('review-name').textContent = draft.name.split(/\s+/)[0] || 'them';

    var dl = $('review-facts');
    dl.innerHTML = '';
    fact(dl, 'Name', draft.name);
    fact(dl, 'Email', draft.email);
    fact(dl, 'Job title', draft.title);
    fact(dl, 'Start date', draft.start);
    fact(dl, 'Role', (roleDef(draft.role) || {}).title || draft.role);

    runPreflight();
  }

  /* Ask the server whether an invite can actually be delivered, BEFORE anything
     is created. Previously RESEND_API_KEY surfaced only after createUser and the
     employees upsert had committed, so the failure was half-succeeded by
     construction: an account existed that nobody could sign into. */
  async function runPreflight() {
    var slot = $('preflight-slot');
    var msg = $('preflight-msg');
    if (preflight) return paintPreflight();

    try {
      preflight = await window.adminRoles.invokeFn('invite-employee', {
        dryRun: true,
        email: draft.email,
        full_name: draft.name,
        role: draft.role,
        title: draft.title || null,
        start_date: draft.start || null
      });
    } catch (err) {
      /* A preflight that cannot run must not silently allow the send. */
      preflight = { emailReady: false, reason: 'Could not check email delivery: ' + err.message, remedy: null };
    }
    paintPreflight();
  }

  function paintPreflight() {
    var slot = $('preflight-slot');
    slot.innerHTML = '';

    var box = document.createElement('div');
    var send = $('send-btn');

    if (preflight.emailReady) {
      box.className = 'adm-notice adm-notice--ok';
      var p = document.createElement('p');
      p.textContent = 'The invite will be emailed to ' + draft.email + '.';
      box.appendChild(p);
      if (preflight.reason) {
        var warn = document.createElement('p');
        warn.textContent = preflight.reason;
        box.appendChild(warn);
      }
      send.textContent = 'Send the invite';
    } else {
      box.className = 'adm-notice adm-notice--danger';
      var h = document.createElement('h3');
      h.textContent = 'Email is not configured, so the invite cannot be delivered.';
      var why = document.createElement('p');
      why.textContent = preflight.reason || '';
      box.appendChild(h); box.appendChild(why);
      if (preflight.remedy) {
        var code = document.createElement('code');
        code.textContent = preflight.remedy;
        box.appendChild(code);
      }
      var alt = document.createElement('p');
      alt.style.marginTop = '8px';
      alt.textContent = 'You can still create the account and send them the sign-in link yourself.';
      box.appendChild(alt);
      send.textContent = 'Create the account anyway';
    }
    slot.appendChild(box);

    if (preflight.preview && preflight.preview.html) {
      show($('preview-wrap'), true);
      /* srcdoc + sandbox: the preview is server-rendered HTML and must not run
         script or reach the page around it. */
      $('preview-frame').srcdoc = preflight.preview.html;
    }
  }

  /* ── Send ─────────────────────────────────────────────────────── */
  async function send() {
    if (sending) return;
    setErr('review-err', '');

    var btn = $('send-btn');
    sending = true;
    btn.disabled = true;
    var was = btn.textContent;
    btn.textContent = 'Creating the account…';

    var outcome = { steps: [], sentAt: null, actionLink: null, employee: null };

    try {
      var out = await window.adminRoles.invokeFn('invite-employee', {
        email: draft.email,
        full_name: draft.name,
        role: draft.role,
        title: draft.title || null,
        start_date: draft.start || null
      });

      outcome.employee = out.employee;
      outcome.sentAt = out.sentAt || new Date().toISOString();
      outcome.actionLink = out.actionLink || null;
      outcome.expiryHours = EXPIRY_HOURS;

      outcome.steps.push({ ok: true, text: out.invited ? 'Account created' : 'Linked to their existing account' });
      outcome.steps.push({ ok: true, text: 'Added to the team as ' + ((roleDef(draft.role) || {}).title || draft.role) });
      outcome.steps.push(out.emailSent
        ? { ok: true, text: 'Invite emailed to ' + draft.email }
        : { ok: false, text: 'Invite email did not send — ' + (out.emailError || 'unknown error') });

      /* The two opt-ins run after the person exists, and each reports its own
         outcome. A failure here must not read as a failed invite. */
      if ($('opt-tick').checked) outcome.steps.push(await tickDashboardItem(out.employee));
      if ($('opt-task').checked) outcome.steps.push(await createFirstTask(out.employee));

      clearDraft();
      try { sessionStorage.setItem('veyago.admin.invite-outcome', JSON.stringify(outcome)); } catch (e) {}
      window.location.href = '/admin/member?id=' + encodeURIComponent(out.employee.id) + '#welcome';
      return;
    } catch (err) {
      setErr('review-err', 'Could not add them: ' + err.message);
    } finally {
      sending = false;
      btn.disabled = false;
      btn.textContent = was;
    }
  }

  /* The seeded checklist contains an item describing exactly what this flow just
     did. It has no stable id — a manager can rename or retire it — so it is
     resolved by title at run time and its absence is not an error. */
  async function tickDashboardItem(employee) {
    if (!dashboardItemId) return { ok: null, text: 'No “Dashboard access granted” item on the checklist — nothing to tick' };
    var res = await window.sb.from('onboarding_progress').upsert({
      employee_id: employee.id,
      item_id: dashboardItemId,
      done: true,
      done_at: new Date().toISOString(),
      note: null
    });
    return res.error
      ? { ok: false, text: 'Could not tick their first checklist item: ' + res.error.message }
      : { ok: true, text: 'Ticked “Dashboard access granted” on their checklist' };
  }

  /* created_by and status are deliberately omitted: created_by defaults to
     auth.uid() and the INSERT policy rejects any other value; status defaults
     to 'todo' under a CHECK constraint. */
  async function createFirstTask(employee) {
    var title = ($('opt-task-title').value || '').trim();
    if (!title) return { ok: null, text: 'No first task given — skipped' };

    var res = await window.sb.from('tasks').insert({
      title: title,
      assignee_id: employee.id,
      due_date: window.admin.localDate(7)
    }).select().single();

    if (res.error) return { ok: false, text: 'Could not create the first task: ' + res.error.message };

    /* Fire-and-forget, as everywhere else — the task exists either way. */
    window.adminRoles.invokeFn('notify-task', { task_id: res.data.id }).catch(function () {});
    return { ok: true, text: 'Created their first task — “' + title + '”' };
  }

  /* ── Wiring ───────────────────────────────────────────────────── */
  function wire() {
    ['p-name', 'p-email', 'p-title', 'p-start'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        readPerson();
        setErr('person-err', '');
        if (id === 'p-email') renderDuplicate();
      });
    });

    /* Enter submits, which the old panel could not do: it had no <form> and a
       type="button" control, so the key did nothing at all. */
    ['p-name', 'p-email', 'p-title'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('to-access').click(); }
      });
    });

    $('to-access').addEventListener('click', function () {
      readPerson();
      if (!draft.name) { setErr('person-err', 'Enter their full name.'); $('p-name').focus(); return; }
      if (!emailLooksReal(draft.email)) { setErr('person-err', 'Enter a valid email address.'); $('p-email').focus(); return; }
      var hit = findDuplicate(draft.email);
      if (hit) { setErr('person-err', hit.full_name + ' already uses that address. Open their profile instead of creating a second record.'); return; }
      goStep(1);
    });

    $('back-person').addEventListener('click', function () { goStep(0); });
    $('back-access').addEventListener('click', function () { goStep(1); });

    $('elevated-confirm').addEventListener('input', function () { setErr('access-err', ''); });

    $('to-review').addEventListener('click', function () {
      if (!draft.role) { setErr('access-err', 'Choose what they should be able to do.'); return; }
      if (!elevatedOk()) {
        setErr('access-err', 'Type ' + draft.role.toUpperCase() + ' to confirm this manager role.');
        $('elevated-confirm').focus();
        return;
      }
      preflight = null;            // re-check: the role is part of the preview
      goStep(2);
    });

    $('opt-task').addEventListener('change', function () {
      show($('task-slot'), $('opt-task').checked);
      if ($('opt-task').checked) $('opt-task-title').focus();
    });

    $('send-btn').addEventListener('click', send);

    window.addEventListener('popstate', renderStep);
  }

  function fillFromDraft() {
    $('p-name').value  = draft.name;
    $('p-email').value = draft.email;
    $('p-title').value = draft.title;
    $('p-start').value = draft.start;
    renderDuplicate();
  }

  async function load() {
    /* Cosmetic guard — RLS and the function's own 403 are the real boundary —
       but it means a wrong URL shows the dashboard, not a broken form. */
    if (!(await window.adminRoles.requireManager())) return;

    loadDraft();
    fillFromDraft();
    wire();
    renderStep();

    /* The directory powers the live duplicate check. team.js already fetches
       exactly this; a manager can read every row (RLS "staff read employees"). */
    var res = await window.sb.from('employees')
      .select('id,email,full_name,role,title,status').order('created_at');
    if (!res.error) { directory = res.data || []; renderDuplicate(); }

    var item = await window.sb.from('onboarding_items')
      .select('id').eq('active', true).eq('title', 'Dashboard access granted').maybeSingle();
    if (!item.error && item.data) dashboardItemId = item.data.id;
    else $('opt-tick-sub').textContent = 'No matching checklist item — this will be skipped.';
  }

  window.adminReady.then(function (s) { if (s) load(); });
})();
