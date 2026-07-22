/* Onboarding page: progress hero + checklist grouped by category, per-employee
   progress. Managers pick any team member and curate items via the sticky
   manage panel; everyone else sees their own checklist. */
(function () {
  'use strict';

  var msg    = document.getElementById('msg');
  var listEl = document.getElementById('ob-list');
  var selEl  = document.getElementById('ob-employee');

  var isManager = false;
  var selfEmployee = null;
  var employees = [];   // for the hero avatar/name
  var items = [];       // active onboarding_items
  var progress = {};    // item_id → progress row for the selected employee

  var CATEGORY_ORDER = ['general', 'accounts', 'legal', 'tools'];
  var CATEGORY_LABEL = { general: 'General', accounts: 'Accounts', legal: 'Legal', tools: 'Tools' };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  function selectedEmployeeId() { return selEl && selEl.value ? selEl.value : null; }
  function selectedEmployee() {
    var id = selectedEmployeeId();
    return employees.find(function (e) { return e.id === id; }) || null;
  }

  async function load() {
    isManager    = await window.adminRoles.isManager();
    selfEmployee = await window.adminRoles.employee();

    var managePane = document.getElementById('ob-manage-pane');
    if (managePane) managePane.hidden = !isManager;

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
        listEl.innerHTML = '<li class="adm-empty"><p>No team members yet — invite someone on the Team page first.</p></li>';
        return;
      }
      /* Deep link from the Team page: /admin/onboarding?emp=<id> */
      var wanted = new URLSearchParams(window.location.search).get('emp');
      if (wanted && selEl.querySelector('option[value="' + wanted + '"]')) selEl.value = wanted;
    } else if (selfEmployee) {
      employees = [selfEmployee];
      selEl.innerHTML = '<option value="' + selfEmployee.id + '">' + selfEmployee.full_name + '</option>';
      selEl.disabled = true;
    } else {
      listEl.innerHTML = '<li class="adm-empty"><p>No employee record found for your account.</p></li>';
      return;
    }

    var res = await window.sb.from('onboarding_items')
      .select('id,title,description,category,sort_order')
      .eq('active', true).order('sort_order');
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
      return CATEGORY_LABEL[c] + ' ' + inCat.filter(isDone).length + '/' + inCat.length;
    }).filter(Boolean);
    document.getElementById('ob-hero-cats').textContent = cats.join(' · ');
  }

  /* ── Checklist (grouped by category, open before done) ─────────────── */

  function render() {
    renderHero();
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No checklist items yet.</p></li>';
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
      head.innerHTML = (CATEGORY_LABEL[cat] || cat) +
        ' <span class="n">' + inCat.filter(isDone).length + '/' + inCat.length + '</span>';
      listEl.appendChild(head);

      inCat.filter(function (i) { return !isDone(i); })
        .concat(inCat.filter(isDone))
        .forEach(function (item) { listEl.appendChild(renderRow(item)); });
    });
  }

  function renderRow(item) {
    var done = isDone(item);
    var p = progress[item.id];

    var li = document.createElement('li'); li.className = 'adm-item';

    /* The circle/check icon IS the toggle — big hit target. */
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'adm-item-icon';
    toggleBtn.style.cssText = 'border:none;cursor:pointer;background:' + (done ? '#e7f6ec' : 'var(--bg-card)');
    toggleBtn.setAttribute('aria-label', done ? 'Mark "' + item.title + '" not done' : 'Mark "' + item.title + '" done');
    toggleBtn.innerHTML = done
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2.2" stroke-linecap="round" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" width="18" height="18"><circle cx="12" cy="12" r="9"/></svg>';
    toggleBtn.addEventListener('click', function () { toggle(item, !done, toggleBtn); });

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = item.title;
    if (done) { t.style.textDecoration = 'line-through'; t.style.color = 'var(--muted)'; }
    var s = document.createElement('div'); s.className = 'adm-item-sub';
    s.textContent = (item.description || '') +
      (done && p && p.done_at ? (item.description ? ' · ' : '') + 'done ' + p.done_at.slice(0, 10) : '');
    main.appendChild(t);
    if (s.textContent) main.appendChild(s);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';
    if (isManager) {
      var rm = document.createElement('button');
      rm.className = 'btn btn-sm'; rm.type = 'button'; rm.title = 'Remove from checklist';
      rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      rm.addEventListener('click', function () { removeItem(item); });
      acts.appendChild(rm);
    }

    li.appendChild(toggleBtn); li.appendChild(main); li.appendChild(acts);
    return li;
  }

  async function toggle(item, done, btn) {
    var empId = selectedEmployeeId();
    if (!empId) return;
    btn.disabled = true;
    var res = await window.sb.from('onboarding_progress').upsert({
      employee_id: empId,
      item_id: item.id,
      done: done,
      done_at: done ? new Date().toISOString() : null
    });
    btn.disabled = false;
    if (res.error) { setMsg('Update failed: ' + res.error.message, 'err'); return; }
    setMsg('');
    loadProgress();
  }

  async function removeItem(item) {
    if (!confirm('Remove "' + item.title + '" from everyone’s checklist?\n\nIt is deactivated (history kept), not deleted.')) return;
    var res = await window.sb.from('onboarding_items').update({ active: false }).eq('id', item.id);
    if (res.error) { setMsg('Failed: ' + res.error.message, 'err'); return; }
    load();
  }

  var addBtn = document.getElementById('ob-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var title = (document.getElementById('ob-new-title').value || '').trim();
      var desc  = (document.getElementById('ob-new-desc').value || '').trim() || null;
      var cat   = document.getElementById('ob-new-category').value;
      if (!title) { setMsg('Enter a title for the item.', 'err'); return; }
      var maxSort = items.reduce(function (m, i) { return Math.max(m, i.sort_order); }, 0);
      var res = await window.sb.from('onboarding_items')
        .insert({ title: title, description: desc, category: cat, sort_order: maxSort + 10 });
      if (res.error) { setMsg('Failed: ' + res.error.message, 'err'); return; }
      document.getElementById('ob-new-title').value = '';
      document.getElementById('ob-new-desc').value = '';
      setMsg(''); window.admin.toast('Checklist item added');
      load();
    });
  }

  if (selEl) selEl.addEventListener('change', loadProgress);

  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
