/* Onboarding — ONE PERSON at a time. Pick a team member, see how far they are,
   tick items off, and leave a note on any item ("waiting on their passport",
   "signed, filed in Drive").

   The company template lives on /admin/checklist. It used to sit in a sidebar
   here, which read as if it belonged to the person on screen — it does not:
   editing it changes the checklist for everyone. */
(function () {
  'use strict';

  var msg    = document.getElementById('msg');
  var listEl = document.getElementById('ob-list');
  var selEl  = document.getElementById('ob-employee');

  var isManager = false;
  var selfEmployee = null;
  var employees = [];   // for the hero avatar/name and the picker
  var items = [];       // active onboarding_items
  var progress = {};    // item_id → progress row for the selected employee

  var openNote  = null;  // item id whose note editor is open
  var focusNote = false; // focus that editor on the next render (click only)

  var CATEGORY_ORDER = ['general', 'accounts', 'legal', 'tools'];
  var CATEGORY_LABEL = { general: 'General', accounts: 'Accounts', legal: 'Legal', tools: 'Tools' };

  /* done_at is a timestamptz. Slicing the ISO string yields the UTC calendar
     day, which reads a day in the future for anyone west of UTC in the evening. */
  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  /* Escapes for both text and quoted-attribute contexts — see team.js:esc. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  function categoryLabel(c) { return CATEGORY_LABEL[c] || c; }

  function selectedEmployeeId() { return selEl && selEl.value ? selEl.value : null; }
  function selectedEmployee() {
    var id = selectedEmployeeId();
    return employees.find(function (e) { return e.id === id; }) || null;
  }

  /* Managers run anyone's onboarding; everyone else only their own row. */
  function canEdit() {
    if (isManager) return true;
    var id = selectedEmployeeId();
    return !!(selfEmployee && id && selfEmployee.id === id);
  }

  function emptyState(icon, text, extra) {
    return '<li class="dash-empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true">' + icon + '</svg>' +
      '<p>' + text + '</p>' + (extra || '') + '</li>';
  }

  var ICON_PEOPLE = '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>';
  var ICON_CHECK  = '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>';

  /* ── Load ──────────────────────────────────────────────────────────── */

  async function load() {
    isManager    = await window.adminRoles.isManager();
    selfEmployee = await window.adminRoles.employee();

    var manageLink = document.getElementById('ob-manage-link');
    if (manageLink) manageLink.hidden = !isManager;

    /* Employee picker: managers choose anyone; others are locked to themselves. */
    if (isManager) {
      var emps = await window.sb.from('employees')
        .select('id,full_name,status').neq('status', 'inactive').order('full_name');
      if (emps.error) { setMsg('Could not load team: ' + emps.error.message, 'err'); return; }
      employees = emps.data || [];
      selEl.innerHTML = '';
      employees.forEach(function (e) {
        var o = document.createElement('option'); o.value = e.id; o.textContent = e.full_name;
        selEl.appendChild(o);
      });
      if (!employees.length) {
        listEl.innerHTML = emptyState(ICON_PEOPLE,
          'No team members yet — invite someone on the Team page first.',
          '<a class="btn btn-sm" href="/admin/team">Go to Team</a>');
        return;
      }
      /* Deep link from the Team page: /admin/onboarding?emp=<id> */
      /* Match in JS, not through a CSS selector: a ?emp= containing a quote or
         backslash made querySelector throw, which killed load() before the
         checklist ever loaded and left the skeletons shimmering forever.
         And an id that no longer matches anyone must SAY so — silently falling
         back to the first option showed one person's checklist under another
         person's link, which is how you tick items against the wrong employee. */
      var wanted = new URLSearchParams(window.location.search).get('emp');
      if (wanted) {
        if (employees.some(function (e) { return e.id === wanted; })) {
          selEl.value = wanted;
        } else {
          setMsg('That team member could not be found — showing ' +
                 (employees[0] ? employees[0].full_name : 'someone else') + ' instead.', 'err');
        }
      }
    } else if (selfEmployee) {
      employees = [selfEmployee];
      var own = document.createElement('option');
      own.value = selfEmployee.id; own.textContent = selfEmployee.full_name;
      selEl.innerHTML = ''; selEl.appendChild(own);
      selEl.disabled = true;
    } else {
      listEl.innerHTML = emptyState(ICON_PEOPLE, 'No employee record found for your account.');
      return;
    }

    var res = await window.sb.from('onboarding_items')
      .select('id,title,description,category,sort_order')
      .eq('active', true)
      .order('sort_order').order('created_at');
    if (res.error) { setMsg('Could not load checklist: ' + res.error.message, 'err'); return; }
    items = res.data || [];

    await loadProgress();
  }

  async function loadProgress() {
    var empId = selectedEmployeeId();
    if (!empId) return;
    var res = await window.sb.from('onboarding_progress')
      .select('item_id,done,done_at,note').eq('employee_id', empId);
    if (res.error) { setMsg('Could not load progress: ' + res.error.message, 'err'); return; }
    progress = {};
    (res.data || []).forEach(function (p) { progress[p.item_id] = p; });
    render();
  }

  function isDone(item) { var p = progress[item.id]; return !!(p && p.done); }
  function noteOf(item) { var p = progress[item.id]; return (p && p.note) || ''; }

  /* ── Progress hero ─────────────────────────────────────────────────── */

  function renderHero() {
    var hero = document.getElementById('ob-hero');
    var emp = selectedEmployee();
    if (!hero || !emp || !items.length) { if (hero) hero.hidden = true; return; }
    hero.hidden = false;

    var done = items.filter(isDone).length;
    var pct = Math.round((done / items.length) * 100);

    var av = document.getElementById('ob-hero-avatar');
    av.textContent = initials(emp.full_name);
    av.style.background = pct === 100 ? '#1a7f37' : 'var(--blue-2)';
    document.getElementById('ob-hero-name').textContent = emp.full_name;
    document.getElementById('ob-hero-count').textContent = done + ' of ' + items.length + ' complete';

    var bar = document.getElementById('ob-hero-bar');
    bar.className = 'adm-progress' + (pct === 100 ? ' done' : '');
    bar.querySelector('i').style.width = pct + '%';

    var cats = CATEGORY_ORDER.map(function (c) {
      var inCat = items.filter(function (i) { return i.category === c; });
      if (!inCat.length) return null;
      return categoryLabel(c) + ' ' + inCat.filter(isDone).length + '/' + inCat.length;
    }).filter(Boolean);
    document.getElementById('ob-hero-cats').textContent = cats.join(' · ');
  }

  /* ── Checklist (grouped by category, open before done) ─────────────── */

  function render() {
    renderHero();
    if (!listEl) return;

    var countEl = document.getElementById('ob-count');
    if (countEl) countEl.textContent = items.length + (items.length === 1 ? ' item' : ' items');

    if (!items.length) {
      listEl.innerHTML = emptyState(ICON_CHECK, 'No checklist items yet.',
        isManager ? '<a class="btn btn-sm" href="/admin/checklist">Manage checklist</a>' : '');
      return;
    }
    listEl.innerHTML = '';

    CATEGORY_ORDER.concat(
      // any categories outside the known set, appended at the end
      items.map(function (i) { return i.category; })
        .filter(function (c, idx, arr) { return arr.indexOf(c) === idx && CATEGORY_ORDER.indexOf(c) === -1; })
    ).forEach(function (cat) {
      var inCat = items.filter(function (i) { return i.category === cat; });
      if (!inCat.length) return;

      var head = document.createElement('li');
      head.className = 'adm-subhead';
      head.innerHTML = esc(categoryLabel(cat)) +
        ' <span class="n">' + inCat.filter(isDone).length + '/' + inCat.length + '</span>';
      listEl.appendChild(head);

      inCat.filter(function (i) { return !isDone(i); })
        .concat(inCat.filter(isDone))
        .forEach(function (item) { listEl.appendChild(renderRow(item)); });
    });

    if (focusNote) {
      focusNote = false;
      var input = listEl.querySelector('[data-note-input]');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }

  function renderRow(item) {
    var done = isDone(item);
    var note = noteOf(item);
    var p = progress[item.id];
    var editable = canEdit();

    var li = document.createElement('li');
    li.className = 'adm-item' + (openNote === item.id ? ' adm-item--stack' : '');

    li.appendChild(renderToggle(item, done, editable));
    li.appendChild(renderMain(item, done, note, p));

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    if (editable) {
      var noteBtn = document.createElement('button');
      noteBtn.className = 'btn btn-sm'; noteBtn.type = 'button';
      noteBtn.textContent = note ? 'Edit note' : 'Add note';
      noteBtn.setAttribute('aria-expanded', openNote === item.id ? 'true' : 'false');
      noteBtn.addEventListener('click', function () {
        openNote = openNote === item.id ? null : item.id;
        focusNote = openNote === item.id;
        render();
      });
      acts.appendChild(noteBtn);
    }
    li.appendChild(acts);

    if (editable && openNote === item.id) li.appendChild(renderNoteEditor(item, note));
    return li;
  }

  /* The circle/check icon IS the toggle — big hit target. */
  function renderToggle(item, done, editable) {
    var mark = done
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2.2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>';

    if (!editable) {
      var div = document.createElement('div');
      div.className = 'adm-item-icon';
      div.innerHTML = mark;
      return div;
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adm-item-icon';
    btn.style.cssText = 'border:none;cursor:pointer;background:' + (done ? '#e7f6ec' : 'var(--bg-card)');
    btn.setAttribute('aria-label', (done ? 'Mark not done: ' : 'Mark done: ') + item.title);
    btn.innerHTML = mark;
    btn.addEventListener('click', function () { toggle(item, !done, btn); });
    return btn;
  }

  function renderMain(item, done, note, p) {
    var main = document.createElement('div'); main.className = 'adm-item-main';

    var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = item.title;
    if (done) { t.style.textDecoration = 'line-through'; t.style.color = 'var(--muted)'; }
    main.appendChild(t);

    var sub = (item.description || '') +
      (done && p && p.done_at ? (item.description ? ' · ' : '') + 'done ' + fmtDay(p.done_at) : '');
    if (sub) {
      var s = document.createElement('div'); s.className = 'adm-item-sub'; s.textContent = sub;
      main.appendChild(s);
    }

    if (note) {
      var n = document.createElement('div');
      n.className = 'adm-item-sub';
      n.title = note;   // rows are single-line; the full note shows on hover and in the editor
      n.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'width="12" height="12" aria-hidden="true" style="vertical-align:-1px"><path d="M12 20h9"/>' +
        '<path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg> ' + esc(note);
      main.appendChild(n);
    }
    return main;
  }

  /* ── Per-item note ─────────────────────────────────────────────────── */

  function renderNoteEditor(item, note) {
    var wrap = document.createElement('div'); wrap.className = 'adm-item-detail';

    var field = document.createElement('div'); field.className = 'field';
    var id = 'ob-note-' + item.id;
    var label = document.createElement('label');
    label.setAttribute('for', id); label.textContent = 'Note';
    var input = document.createElement('input');
    input.className = 'input'; input.type = 'text'; input.id = id; input.value = note;
    input.placeholder = 'Waiting on their passport scan';
    input.setAttribute('data-note-input', '');
    var emp = selectedEmployee();
    var first = emp && emp.full_name ? String(emp.full_name).trim().split(/\s+/)[0] : '';
    var hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = 'Where this item actually stands. Managers and ' +
      (first || 'the person') + ' can see it.';
    field.appendChild(label); field.appendChild(input); field.appendChild(hint);

    var acts = document.createElement('div'); acts.className = 'form-actions';
    var save = document.createElement('button');
    save.className = 'btn btn-primary btn-sm'; save.type = 'button'; save.textContent = 'Save note';
    var cancel = document.createElement('button');
    cancel.className = 'btn btn-sm'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    var err = document.createElement('p'); err.className = 'msg';

    acts.appendChild(save); acts.appendChild(cancel);
    if (note) {
      var clear = document.createElement('button');
      clear.className = 'btn btn-sm btn-danger'; clear.type = 'button'; clear.textContent = 'Clear';
      clear.addEventListener('click', function () { saveNote(item, '', clear, err); });
      acts.appendChild(clear);
    }
    acts.appendChild(err);

    function commit() { saveNote(item, input.value.trim(), save, err); }
    function close() { openNote = null; render(); }
    save.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    wrap.appendChild(field); wrap.appendChild(acts);
    return wrap;
  }

  /* Notes and ticks share one row, so always send the state of the other
     column too — the insert path would otherwise reset it to the default. */
  async function saveNote(item, value, btn, errEl) {
    var empId = selectedEmployeeId();
    if (!empId) return;
    var p = progress[item.id];
    btn.disabled = true;
    var res = await window.sb.from('onboarding_progress').upsert({
      employee_id: empId,
      item_id: item.id,
      note: value || null,
      done: !!(p && p.done),
      done_at: (p && p.done_at) || null
    });
    btn.disabled = false;
    if (res.error) {
      errEl.textContent = 'Could not save: ' + res.error.message;
      errEl.className = 'msg err';
      return;
    }
    openNote = null;
    window.admin.toast(value ? 'Note saved' : 'Note cleared');
    loadProgress();
  }

  async function toggle(item, done, btn) {
    var empId = selectedEmployeeId();
    if (!empId) return;
    var p = progress[item.id];
    btn.disabled = true;
    var res = await window.sb.from('onboarding_progress').upsert({
      employee_id: empId,
      item_id: item.id,
      done: done,
      done_at: done ? new Date().toISOString() : null,
      note: (p && p.note) || null
    });
    btn.disabled = false;
    if (res.error) { setMsg('Update failed: ' + res.error.message, 'err'); return; }
    setMsg('');
    loadProgress();
  }

  if (selEl) {
    selEl.addEventListener('change', function () {
      openNote = null;
      loadProgress();
    });
  }

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
