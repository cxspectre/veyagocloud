/* Onboarding page: global checklist + per-employee progress. Managers pick any
   team member and curate items; everyone else sees their own checklist. */
(function () {
  'use strict';

  var msg      = document.getElementById('msg');
  var listEl   = document.getElementById('ob-list');
  var selEl    = document.getElementById('ob-employee');
  var badgeEl  = document.getElementById('ob-progress-badge');

  var isManager = false;
  var selfEmployee = null;
  var items = [];       // active onboarding_items
  var progress = {};    // item_id → progress row for the selected employee

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function selectedEmployeeId() { return selEl && selEl.value ? selEl.value : null; }

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
      selEl.innerHTML = '';
      (emps.data || []).forEach(function (e) {
        var o = document.createElement('option'); o.value = e.id; o.textContent = e.full_name;
        selEl.appendChild(o);
      });
      if (!selEl.options.length) {
        listEl.innerHTML = '<li class="adm-empty"><p>No team members yet — invite someone on the Team page first.</p></li>';
        return;
      }
      /* Deep link from the Team page: /admin/onboarding?emp=<id> */
      var wanted = new URLSearchParams(window.location.search).get('emp');
      if (wanted && selEl.querySelector('option[value="' + wanted + '"]')) selEl.value = wanted;
    } else if (selfEmployee) {
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

  function render() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<li class="adm-empty"><p>No checklist items yet.</p></li>';
      return;
    }
    listEl.innerHTML = '';
    var doneCount = 0;

    items.forEach(function (item) {
      var p = progress[item.id];
      var done = !!(p && p.done);
      if (done) doneCount++;

      var li = document.createElement('li'); li.className = 'adm-item';

      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.innerHTML = done
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/></svg>';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = item.title;
      if (done) t.style.textDecoration = 'line-through';
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = item.category + (item.description ? ' · ' + item.description : '') +
        (done && p.done_at ? ' · done ' + p.done_at.slice(0, 10) : '');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm' + (done ? '' : ' btn-primary');
      btn.type = 'button';
      btn.textContent = done ? 'Undo' : 'Mark done';
      btn.addEventListener('click', function () { toggle(item, !done, btn); });
      acts.appendChild(btn);

      if (isManager) {
        var rm = document.createElement('button');
        rm.className = 'btn btn-sm btn-danger'; rm.type = 'button'; rm.textContent = 'Remove';
        rm.addEventListener('click', function () { removeItem(item); });
        acts.appendChild(rm);
      }

      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });

    if (badgeEl) {
      badgeEl.textContent = doneCount + ' / ' + items.length + ' done';
      badgeEl.className = 'badge ' + (doneCount === items.length ? 'badge-published' : 'badge-draft');
    }
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
    if (!confirm('Remove "' + item.title + '" from the checklist?\n\nIt is deactivated (history kept), not deleted.')) return;
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
      setMsg('Item added.', 'ok');
      load();
    });
  }

  if (selEl) selEl.addEventListener('change', loadProgress);
  document.addEventListener('admin:authed', load);
})();
