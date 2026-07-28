/* Announcement manager. Manages site_announcements table.
   One active row at a time; build exports the active one to site-config.js. */
(function () {
  'use strict';

  /* Deleting content is managers only since 0012, and the guard trigger
     enforces it — so the button has to reflect that, or staff get a control
     that fails. Cosmetic; the database is the boundary. */
  var isManager = false;

  var listEl = document.getElementById('ann-list');
  var formEl = document.getElementById('ann-form');
  var msg = document.getElementById('msg');
  var previewWrap = document.getElementById('ann-preview-wrap');
  var previewText = document.getElementById('ann-preview-text');
  var current = { id: null };

  var keyEl = document.getElementById('a-key');
  var msgEl = document.getElementById('a-msg');
  var ltEl  = document.getElementById('a-link-text');
  var lhEl  = document.getElementById('a-link-href');
  var activeEl = document.getElementById('a-active');

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function updatePreview() {
    var m = (msgEl.value || '').trim();
    if (!m) { previewWrap.hidden = true; return; }
    var html = m;
    if (ltEl.value && lhEl.value) html += ' <a class="ann-link" href="' + lhEl.value + '">' + ltEl.value + '</a>';
    previewText.innerHTML = html;
    previewWrap.hidden = false;
  }

  [msgEl, ltEl, lhEl].forEach(function (el) { if (el) el.addEventListener('input', updatePreview); });

  async function load() {
    isManager = await window.adminRoles.isManager();
    var res = await window.sb.from('site_announcements').select('*')
      /* Deleted rows are soft (0012) — the admin still CAN read them
         (staff SELECT is wide so a manager can restore), so the list filters. */
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (res.error) { setMsg('Could not load: ' + res.error.message, 'err'); return; }
    render(res.data || []);
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) { listEl.innerHTML = '<li class="adm-empty"><p>No announcements yet. Create one to show a bar on every page.</p></li>'; return; }
    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var dot = document.createElement('div'); dot.className = 'adm-item-icon';
      dot.innerHTML = a.active
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="#1a7f37" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.message ? (a.message.slice(0, 70) + (a.message.length > 70 ? '…' : '')) : '(no message)';
      var s = document.createElement('div'); s.className = 'adm-item-sub'; s.textContent = 'key: ' + a.key + (a.link_text ? ' · link: ' + a.link_text : '');
      main.appendChild(t); main.appendChild(s);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span'); badge.className = 'badge ' + (a.active ? 'badge-active' : 'badge-inactive'); badge.textContent = a.active ? 'Active' : 'Inactive';
      var editBtn = document.createElement('button'); editBtn.className = 'btn btn-sm'; editBtn.type = 'button'; editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openForm(a); });
      var togBtn = document.createElement('button'); togBtn.className = 'btn btn-sm'; togBtn.type = 'button';
      togBtn.textContent = a.active ? 'Deactivate' : 'Activate';
      togBtn.addEventListener('click', function () { toggleActive(a); });
      acts.appendChild(badge); acts.appendChild(editBtn); acts.appendChild(togBtn);
      li.appendChild(dot); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  function openForm(a) {
    current.id = a ? a.id : null;
    keyEl.value = a ? (a.key || '') : '';
    msgEl.value = a ? (a.message || '') : '';
    ltEl.value  = a ? (a.link_text || '') : '';
    lhEl.value  = a ? (a.link_href || '') : '';
    activeEl.checked = a ? !!a.active : false;
    document.getElementById('form-title').textContent = a ? 'Edit announcement' : 'New announcement';
    /* Shown only when there is something to delete AND you are allowed to;
       deleting content is managers only since 0012. */
    document.getElementById('a-delete').hidden = !a || !isManager;
    updatePreview();
    formEl.hidden = false;
    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeForm() { formEl.hidden = true; previewWrap.hidden = true; current.id = null; }

  async function toggleActive(a) {
    if (a.active) {
      var res = await window.sb.from('site_announcements').update({ active: false }).eq('id', a.id);
      if (res.error) { setMsg(res.error.message, 'err'); return; }
    } else {
      // Deactivate all others first
      await window.sb.from('site_announcements').update({ active: false }).neq('id', a.id);
      var res2 = await window.sb.from('site_announcements').update({ active: true }).eq('id', a.id);
      if (res2.error) { setMsg(res2.error.message, 'err'); return; }
    }
    setMsg('Saved · not live yet. Publish the site from Settings.', 'ok');
    load();
  }

  async function save() {
    var key  = (keyEl.value || '').trim();
    var text = (msgEl.value || '').trim();
    if (!key)  { keyEl.classList.add('err'); keyEl.focus(); return; } else keyEl.classList.remove('err');
    if (!text) { msgEl.classList.add('err'); msgEl.focus(); return; } else msgEl.classList.remove('err');

    var data = { key: key, message: text, link_text: ltEl.value.trim() || null, link_href: lhEl.value.trim() || null, active: activeEl.checked };

    if (data.active) await window.sb.from('site_announcements').update({ active: false }).neq('id', current.id || '00000000-0000-0000-0000-000000000000');

    var q = current.id
      ? window.sb.from('site_announcements').update(data).eq('id', current.id)
      : window.sb.from('site_announcements').insert(data);
    var res = await q;
    if (res.error) { setMsg('Save failed: ' + res.error.message, 'err'); return; }
    setMsg('Saved · not live yet. Publish the site from Settings.', 'ok');
    closeForm(); load();
  }

  async function remove() {
    if (!current.id || !confirm('Delete this announcement?\n\nThe record is kept, so this can be undone.')) return;
/* Soft delete (migration 0012). The row is marked, not destroyed, so a
   mis-click is a mistake rather than an incident — and the anonymous SELECT
   policy excludes deleted rows, so the live site drops it on the next build
   without this code having to remember. Managers only; the guard trigger
   rejects anyone else. */
    var res = await window.sb.from('site_announcements')
      .update({ deleted_at: new Date().toISOString() }).eq('id', current.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    closeForm(); load();
  }

  document.getElementById('new-btn').addEventListener('click', function () { openForm(null); });
  document.getElementById('a-save').addEventListener('click', save);
  document.getElementById('a-cancel').addEventListener('click', closeForm);
  document.getElementById('a-delete').addEventListener('click', remove);
  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
