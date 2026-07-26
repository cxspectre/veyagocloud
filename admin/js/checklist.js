/* Checklist template — the COMPANY onboarding list. Managers only.

   Every change lands on every team member at once, which is exactly why it is
   not on /admin/onboarding: that page runs the checklist for one person.
   Items are never hard-deleted — retiring sets active=false, so the progress
   people already recorded against them survives. */
(function () {
  'use strict';

  var msg     = document.getElementById('msg');
  var listEl  = document.getElementById('ck-list');
  var retEl   = document.getElementById('ck-retired-list');

  var items   = [];   // active, ordered by sort_order within category
  var retired = [];   // active = false
  var doneCount = {}; // item_id → active people who ticked it
  var teamSize  = 0;  // active people (invited or active — the ones onboarding)
  var fullyDone = 0;  // people who have ticked every active item
  var editing = null; // item id whose inline editor is open

  var CATEGORY_ORDER = ['general', 'accounts', 'legal', 'tools'];
  var CATEGORY_LABEL = { general: 'General', accounts: 'Accounts', legal: 'Legal', tools: 'Tools' };

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

  function categoryLabel(c) { return CATEGORY_LABEL[c] || c; }

  /* Known categories first, then anything else already in the data. */
  function allCategories() {
    var extra = items.concat(retired)
      .map(function (i) { return i.category; })
      .filter(function (c, idx, arr) { return arr.indexOf(c) === idx && CATEGORY_ORDER.indexOf(c) === -1; });
    return CATEGORY_ORDER.concat(extra);
  }

  function itemsIn(cat) { return items.filter(function (i) { return i.category === cat; }); }

  function nextSort(cat) {
    return itemsIn(cat).reduce(function (m, i) { return Math.max(m, i.sort_order); }, 0) + 10;
  }

  function svg(paths, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" width="' + (size || 14) + '" height="' +
      (size || 14) + '" aria-hidden="true">' + paths + '</svg>';
  }

  /* ── Load ──────────────────────────────────────────────────────────── */

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;
    wireActions();
    await reloadAll();
    fillCategorySelect(document.getElementById('ck-new-category'), 'general');
  }

  /* Items and counts are separate fetches so reordering or renaming — which
     cannot change anyone's progress — only pays for the cheap one. */
  async function fetchItems() {
    var res = await window.sb.from('onboarding_items')
      .select('id,title,description,category,sort_order,active')
      .order('sort_order').order('created_at');
    if (res.error) { setMsg('Could not load the checklist: ' + res.error.message, 'err'); return false; }
    var rows = res.data || [];
    items   = rows.filter(function (r) { return r.active; });
    retired = rows.filter(function (r) { return !r.active; });
    setMsg('');
    return true;
  }

  /* One progress query for the whole page — counted client-side per item and
     per person. Querying per item would be one round trip per row. */
  async function fetchCounts() {
    var emps = await window.sb.from('employees').select('id').neq('status', 'inactive');
    if (emps.error) { setMsg('Could not load the team: ' + emps.error.message, 'err'); return; }
    var active = {};
    (emps.data || []).forEach(function (e) { active[e.id] = true; });
    teamSize = (emps.data || []).length;

    var prog = await window.sb.from('onboarding_progress')
      .select('item_id,employee_id,done').eq('done', true).limit(5000);
    if (prog.error) { setMsg('Could not load progress: ' + prog.error.message, 'err'); return; }

    var live = {};
    items.forEach(function (i) { live[i.id] = true; });

    var perItem = {};
    var perPerson = {};
    (prog.data || []).forEach(function (p) {
      if (!active[p.employee_id] || !live[p.item_id]) return;
      perItem[p.item_id]     = (perItem[p.item_id] || 0) + 1;
      perPerson[p.employee_id] = (perPerson[p.employee_id] || 0) + 1;
    });
    doneCount = perItem;
    fullyDone = !items.length ? 0 : Object.keys(active).filter(function (id) {
      return (perPerson[id] || 0) >= items.length;
    }).length;
  }

  async function reloadAll() {
    if (!(await fetchItems())) return;
    await fetchCounts();
    render();
  }

  async function reloadItems() {
    if (!(await fetchItems())) return;
    render();
  }

  /* ── Stats ─────────────────────────────────────────────────────────── */

  function renderStats() {
    var wrap = document.getElementById('ck-stats');
    if (!wrap) return;
    window.admin.statCards(wrap, [
      { n: items.length, label: 'Active items', color: '#0071e3', n2: 'on everyone’s list',
        icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>' },
      { n: teamSize, label: 'People', color: '#5856d6', n2: 'working through it',
        icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/>' },
      { n: fullyDone, label: 'Fully onboarded', color: fullyDone ? '#34c759' : '#86868b',
        n2: 'finished every item', icon: '<polyline points="20 6 9 17 4 12"/>' },
      { n: retired.length, label: 'Retired', color: '#86868b', n2: 'kept for history',
        icon: '<path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/>' }
    ]);
  }

  /* ── Active list ───────────────────────────────────────────────────── */

  function render() {
    renderStats();
    renderRetired();
    if (!listEl) return;

    var countEl = document.getElementById('ck-count');
    if (countEl) countEl.textContent = items.length + (items.length === 1 ? ' item' : ' items');

    if (!items.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
          '<p>The checklist is empty — nobody has anything to work through yet.</p>' +
          '<button class="btn btn-sm btn-primary" type="button" data-jump>Add the first item</button>' +
        '</li>';
      var jump = listEl.querySelector('[data-jump]');
      if (jump) jump.addEventListener('click', focusAddForm);
      return;
    }

    listEl.innerHTML = '';
    allCategories().forEach(function (cat) {
      var inCat = itemsIn(cat);
      if (!inCat.length) return;
      var head = document.createElement('li');
      head.className = 'adm-subhead';
      head.innerHTML = esc(categoryLabel(cat)) + ' <span class="n">' + inCat.length + '</span>';
      listEl.appendChild(head);
      inCat.forEach(function (item, idx) {
        listEl.appendChild(renderRow(item, idx, inCat.length));
      });
    });
  }

  function renderRow(item, idx, total) {
    var li = document.createElement('li');
    li.className = 'adm-item' + (editing === item.id ? ' adm-item--stack' : '');

    /* Position within its category, so ▲/▼ have something to move against. */
    var icon = document.createElement('div');
    icon.className = 'adm-item-icon';
    icon.textContent = String(idx + 1);
    li.appendChild(icon);

    var main = document.createElement('div'); main.className = 'adm-item-main';
    var title = document.createElement('div'); title.className = 'adm-item-title'; title.textContent = item.title;
    var done = doneCount[item.id] || 0;
    var sub = document.createElement('div'); sub.className = 'adm-item-sub';
    sub.textContent = (item.description ? item.description + ' · ' : '') +
      done + ' of ' + teamSize + ' completed';
    main.appendChild(title); main.appendChild(sub);
    li.appendChild(main);

    var acts = document.createElement('div'); acts.className = 'adm-item-acts';

    var up = document.createElement('button');
    up.className = 'btn btn-sm'; up.type = 'button';
    up.innerHTML = svg('<polyline points="18 15 12 9 6 15"/>', 13);
    up.setAttribute('aria-label', 'Move "' + item.title + '" up');
    up.title = 'Move up';
    up.disabled = idx === 0;
    up.addEventListener('click', function () { move(item, -1, up, li); });

    var down = document.createElement('button');
    down.className = 'btn btn-sm'; down.type = 'button';
    down.innerHTML = svg('<polyline points="6 9 12 15 18 9"/>', 13);
    down.setAttribute('aria-label', 'Move "' + item.title + '" down');
    down.title = 'Move down';
    down.disabled = idx === total - 1;
    down.addEventListener('click', function () { move(item, 1, down, li); });

    var edit = document.createElement('button');
    edit.className = 'btn btn-sm'; edit.type = 'button'; edit.textContent = 'Edit';
    edit.setAttribute('aria-expanded', editing === item.id ? 'true' : 'false');
    edit.addEventListener('click', function () {
      editing = editing === item.id ? null : item.id;
      render();
      var input = listEl.querySelector('[data-edit-title]');
      if (input) input.focus();
    });

    var retire = document.createElement('button');
    retire.className = 'btn btn-sm btn-danger'; retire.type = 'button'; retire.textContent = 'Retire';
    retire.addEventListener('click', function () { setActive(item, false, retire, li); });

    acts.appendChild(up); acts.appendChild(down); acts.appendChild(edit); acts.appendChild(retire);
    li.appendChild(acts);

    if (editing === item.id) li.appendChild(renderEditor(item));
    return li;
  }

  /* ── Inline editor ─────────────────────────────────────────────────── */

  function renderEditor(item) {
    var wrap = document.createElement('div'); wrap.className = 'adm-item-detail';

    var row = document.createElement('div'); row.className = 'row-2';
    var titleField = document.createElement('div'); titleField.className = 'field';
    var titleLabel = document.createElement('label');
    titleLabel.setAttribute('for', 'ck-t-' + item.id); titleLabel.textContent = 'Title';
    var titleInput = document.createElement('input');
    titleInput.className = 'input'; titleInput.type = 'text'; titleInput.id = 'ck-t-' + item.id;
    titleInput.value = item.title; titleInput.setAttribute('data-edit-title', '');
    titleField.appendChild(titleLabel); titleField.appendChild(titleInput);

    var catField = document.createElement('div'); catField.className = 'field';
    var catLabel = document.createElement('label');
    catLabel.setAttribute('for', 'ck-c-' + item.id); catLabel.textContent = 'Category';
    var catSelect = document.createElement('select');
    catSelect.className = 'input'; catSelect.id = 'ck-c-' + item.id;
    fillCategorySelect(catSelect, item.category);
    catField.appendChild(catLabel); catField.appendChild(catSelect);

    row.appendChild(titleField); row.appendChild(catField);

    var descField = document.createElement('div'); descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.setAttribute('for', 'ck-d-' + item.id); descLabel.textContent = 'Description';
    var descInput = document.createElement('input');
    descInput.className = 'input'; descInput.type = 'text'; descInput.id = 'ck-d-' + item.id;
    descInput.value = item.description || ''; descInput.placeholder = 'What done looks like';
    descField.appendChild(descLabel); descField.appendChild(descInput);

    var acts = document.createElement('div'); acts.className = 'form-actions';
    var save = document.createElement('button');
    save.className = 'btn btn-primary btn-sm'; save.type = 'button'; save.textContent = 'Save changes';
    var cancel = document.createElement('button');
    cancel.className = 'btn btn-sm'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    var err = document.createElement('p'); err.className = 'msg';
    acts.appendChild(save); acts.appendChild(cancel); acts.appendChild(err);

    function commit() {
      saveEdit(item, {
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        category: catSelect.value
      }, save, err);
    }
    save.addEventListener('click', commit);
    cancel.addEventListener('click', function () { editing = null; render(); });
    [titleInput, descInput].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); }
      });
    });

    wrap.appendChild(row); wrap.appendChild(descField); wrap.appendChild(acts);
    return wrap;
  }

  function fillCategorySelect(sel, value) {
    if (!sel) return;
    sel.innerHTML = '';
    allCategories().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = categoryLabel(c);
      sel.appendChild(o);
    });
    if (value) sel.value = value;
  }

  async function saveEdit(item, patch, btn, errEl) {
    if (!patch.title) { errEl.textContent = 'Enter a title.'; errEl.className = 'msg err'; return; }
    var row = {
      title: patch.title,
      description: patch.description || null,
      category: patch.category
    };
    /* Moving categories: land at the bottom of the new one rather than at
       whatever position the old sort_order happens to fall into. */
    if (patch.category !== item.category) row.sort_order = nextSort(patch.category);

    btn.disabled = true;
    var res = await window.sb.from('onboarding_items').update(row).eq('id', item.id);
    btn.disabled = false;
    if (res.error) { errEl.textContent = 'Could not save: ' + res.error.message; errEl.className = 'msg err'; return; }
    editing = null;
    window.admin.toast('Item updated');
    reloadItems();
  }

  /* ── Reorder ───────────────────────────────────────────────────────── */

  async function move(item, dir, btn, li) {
    var inCat = itemsIn(item.category);
    var idx = inCat.findIndex(function (i) { return i.id === item.id; });
    var swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= inCat.length) return;

    var ordered = inCat.map(function (row, k) {
      if (k === idx)  return inCat[swap];
      if (k === swap) return inCat[idx];
      return row;
    });

    /* Renumber the category in tens instead of swapping two values: seeded and
       imported rows share sort_order numbers (and default to 0), where a swap
       would silently do nothing. Only rows that actually change are written. */
    var writes = ordered
      .map(function (row, k) { return { id: row.id, sort_order: (k + 1) * 10, was: row.sort_order }; })
      .filter(function (w) { return w.sort_order !== w.was; });
    if (!writes.length) return;

    btn.disabled = true;
    var results = await Promise.all(writes.map(function (w) {
      return window.sb.from('onboarding_items').update({ sort_order: w.sort_order }).eq('id', w.id);
    }));
    btn.disabled = false;
    var failed = results.filter(function (r) { return r.error; })[0];
    if (failed) { rowError(li, 'Could not reorder: ' + failed.error.message); return; }
    reloadItems();
  }

  /* ── Retire / restore ──────────────────────────────────────────────── */

  async function setActive(item, active, btn, li) {
    if (!active && !confirm('Retire "' + item.title + '"?\n\n' +
        'It comes off everyone’s checklist. What people already ticked is kept, ' +
        'and you can restore it from the Retired section.')) return;
    btn.disabled = true;
    var res = await window.sb.from('onboarding_items').update({ active: active }).eq('id', item.id);
    btn.disabled = false;
    if (res.error) {
      rowError(li, (active ? 'Could not restore: ' : 'Could not retire: ') + res.error.message);
      return;
    }
    editing = null;
    window.admin.toast(active ? 'Item restored' : 'Item retired');
    reloadAll();
  }

  /* Failures for row buttons show in the row itself, not as a toast. */
  function rowError(li, text) {
    var old = li.querySelector('[data-row-err]');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.className = 'adm-item-detail';
    wrap.setAttribute('data-row-err', '');
    var p = document.createElement('p'); p.className = 'msg err'; p.textContent = text;
    wrap.appendChild(p);
    li.classList.add('adm-item--stack');
    li.appendChild(wrap);
  }

  /* ── Retired section ───────────────────────────────────────────────── */

  function renderRetired() {
    var pane = document.getElementById('ck-retired-pane');
    if (!pane || !retEl) return;
    pane.hidden = !retired.length;
    if (!retired.length) return;

    var sub = document.getElementById('ck-retired-sub');
    if (sub) {
      sub.textContent = retired.length + (retired.length === 1 ? ' item is' : ' items are') +
        ' off the checklist. Their history is kept — restore one and it comes back for everyone.';
    }

    retEl.innerHTML = '';
    retired.forEach(function (item) {
      var li = document.createElement('li'); li.className = 'adm-item';

      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.innerHTML = svg('<path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/>', 16);
      li.appendChild(icon);

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = item.title;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = categoryLabel(item.category) + (item.description ? ' · ' + item.description : '');
      main.appendChild(t); main.appendChild(s);
      li.appendChild(main);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var restore = document.createElement('button');
      restore.className = 'btn btn-sm'; restore.type = 'button'; restore.textContent = 'Restore';
      restore.addEventListener('click', function () { setActive(item, true, restore, li); });
      acts.appendChild(restore);
      li.appendChild(acts);

      retEl.appendChild(li);
    });
  }

  var retToggle = document.getElementById('ck-retired-toggle');
  if (retToggle) {
    retToggle.addEventListener('click', function () {
      var open = retEl.hidden;
      retEl.hidden = !open;
      retToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      /* classList, not className — on an SVG element className is read-only. */
      var chev = retToggle.querySelector('.chev');
      if (chev) chev.classList.toggle('open', open);
      var label = document.getElementById('ck-retired-label');
      if (label) label.textContent = open ? 'Hide' : 'Show';
    });
  }

  /* ── Add ───────────────────────────────────────────────────────────── */

  function focusAddForm() {
    var el = document.getElementById('ck-new-title');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () { el.focus(); }, 300);
  }

  /* Wired only after the manager guard passes. Registered at IIFE top level,
     a non-manager could click Add during the redirect and fire an INSERT that
     RLS then rejected with a raw error in their face. */
  function wireActions() {
    var jumpBtn = document.getElementById('ck-jump');
    if (jumpBtn) jumpBtn.addEventListener('click', focusAddForm);

    var addBtn = document.getElementById('ck-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async function () {
        var titleEl = document.getElementById('ck-new-title');
        var descEl  = document.getElementById('ck-new-desc');
        var catEl   = document.getElementById('ck-new-category');
        var addMsg  = document.getElementById('ck-add-msg');
        var title = (titleEl.value || '').trim();
        if (!title) {
          addMsg.textContent = 'Enter a title for the item.'; addMsg.className = 'msg err';
          titleEl.focus();
          return;
        }
        addBtn.disabled = true;
        var res = await window.sb.from('onboarding_items').insert({
          title: title,
          description: (descEl.value || '').trim() || null,
          category: catEl.value,
          sort_order: nextSort(catEl.value)
        });
        addBtn.disabled = false;
        if (res.error) {
          addMsg.textContent = 'Could not add: ' + res.error.message; addMsg.className = 'msg err';
          return;
        }
        titleEl.value = ''; descEl.value = '';
        addMsg.textContent = ''; addMsg.className = 'msg';
        window.admin.toast('Added to everyone’s checklist');
        reloadAll();
      });
    }
  }


  /* adminReady is a promise — immune to the event-vs-registration race. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
