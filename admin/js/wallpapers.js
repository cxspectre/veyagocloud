/* Wallpaper manager: list, create/edit (with variant uploads to the `wallpapers`
   bucket), publish/unpublish, delete. */
(function () {
  'use strict';

  /* Deleting content is managers only since 0012, and the guard trigger
     enforces it — so the button has to reflect that, or staff get a control
     that fails. Cosmetic; the database is the boundary. */
  var isManager = false;

  var msg = document.getElementById('msg');
  var listEl = document.getElementById('wp-list');
  var formEl = document.getElementById('wp-form');
  var variantsEl = document.getElementById('variants');

  var titleEl = document.getElementById('w-title');
  var catEl = document.getElementById('w-category');
  var descEl = document.getElementById('w-desc');
  var previewEl = document.getElementById('w-preview');
  var badgeEl = document.getElementById('w-status-badge');

  var current = { id: null, status: 'draft', published_at: null };
  var variants = [];

  function setMsg(t, k) { msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }
  function slugify(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/['’"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function setBadge() { badgeEl.textContent = current.status; badgeEl.className = 'badge badge-' + current.status; }
  function extOf(url) { var m = String(url || '').match(/\.([a-z0-9]+)(?:\?|$)/i); return m ? m[1].toLowerCase() : ''; }

  // ---- list ----
  async function loadList() {
    isManager = await window.adminRoles.isManager();
    setMsg('');
    var res = await window.sb.from('wallpapers')
      .select('id,slug,title,status,preview_url,variants,published_at')
      /* Deleted rows are soft (0012) — the admin still CAN read them
         (staff SELECT is wide so a manager can restore), so the list filters. */
      .is('deleted_at', null)
      .order('published_at', { ascending: false, nullsFirst: false });
    if (res.error) { setMsg('Could not load wallpapers: ' + res.error.message, 'err'); return; }
    renderList(res.data || []);
  }

  /* Rebuilt onto the shared list vocabulary. It used to use list-item /
     li-main / li-title / li-sub / li-acts and a `.empty` state — six class
     names with no rules in admin.css or styles.css, so this list has rendered
     as unstyled stacked text since it was written. */
  function renderList(rows) {
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l5-4 4 4 3-2 5 3"/></svg>' +
          '<p>No wallpapers yet.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (w) {
      var li = el('li', 'adm-item');
      var img = el('img', 'wp-thumb'); img.src = w.preview_url || ''; img.alt = '';
      var main = el('div', 'adm-item-main');
      main.innerHTML = '<div class="adm-item-title"></div><div class="adm-item-sub"></div>';
      main.querySelector('.adm-item-title').textContent = w.title || '(untitled)';
      main.querySelector('.adm-item-sub').textContent = (w.variants || []).length + ' variant(s) · /wallpapers/';
      var acts = el('div', 'adm-item-acts');
      acts.innerHTML =
        '<span class="badge badge-' + w.status + '">' + w.status + '</span>' +
        '<button class="btn btn-sm" data-edit>Edit</button>' +
        '<button class="btn btn-sm" data-toggle>' + (w.status === 'published' ? 'Unpublish' : 'Publish') + '</button>' +
        (isManager ? '<button class="btn btn-sm btn-danger" data-del>Delete</button>' : '');
      acts.querySelector('[data-edit]').addEventListener('click', function () { edit(w); });
      acts.querySelector('[data-toggle]').addEventListener('click', function () { toggle(w); });
      var delBtn = acts.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', function () { del(w); });
      li.appendChild(img); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  // ---- variant rows ----
  function renderVariants() {
    variantsEl.innerHTML = '';
    variants.forEach(function (v, i) {
      var row = el('div', 'variant-row');

      var label = el('input', 'input'); label.type = 'text'; label.placeholder = 'Desktop'; label.value = v.label || '';
      label.addEventListener('input', function () { v.label = label.value; });

      var fileWrap = el('div');
      var file = el('input', 'file-input'); file.type = 'file'; file.accept = 'image/*';
      var fhint = el('span', 'hint', v.url ? 'uploaded' : '');
      file.addEventListener('change', async function () {
        if (!file.files || !file.files[0]) return;
        fhint.textContent = 'Uploading…';
        try {
          var slug = slugify(titleEl.value) || 'wallpaper';
          v.url = await window.admin.upload('wallpapers', file.files[0], slug);
          v.format = v.format || extOf(v.url);
          fmt.value = v.format || '';
          fhint.textContent = 'uploaded';
        } catch (err) { fhint.textContent = 'failed: ' + (err && err.message || err); }
      });
      fileWrap.appendChild(file); fileWrap.appendChild(fhint);

      var w = el('input', 'input'); w.type = 'number'; w.placeholder = 'W'; w.value = v.width || '';
      w.addEventListener('input', function () { v.width = w.value ? parseInt(w.value, 10) : null; });
      var h = el('input', 'input'); h.type = 'number'; h.placeholder = 'H'; h.value = v.height || '';
      h.addEventListener('input', function () { v.height = h.value ? parseInt(h.value, 10) : null; });
      var fmt = el('input', 'input'); fmt.type = 'text'; fmt.placeholder = 'png'; fmt.value = v.format || '';
      fmt.addEventListener('input', function () { v.format = fmt.value; });

      var rm = el('button', 'icon-btn', '✕'); rm.type = 'button'; rm.title = 'Remove variant';
      rm.addEventListener('click', function () { variants.splice(i, 1); renderVariants(); });

      [label, fileWrap, w, h, fmt, rm].forEach(function (n) { row.appendChild(n); });
      variantsEl.appendChild(row);
    });
  }

  // ---- form open/close ----
  function openForm(w) {
    if (w) {
      current = { id: w.id, status: w.status, published_at: w.published_at };
      titleEl.value = w.title || ''; catEl.value = w.category || ''; descEl.value = w.description || '';
      previewEl.value = w.preview_url || '';
      variants = JSON.parse(JSON.stringify(w.variants || []));
      document.getElementById('form-title').textContent = 'Edit wallpaper';
    } else {
      current = { id: null, status: 'draft', published_at: null };
      titleEl.value = ''; catEl.value = ''; descEl.value = ''; previewEl.value = '';
      variants = [];
      document.getElementById('form-title').textContent = 'New wallpaper';
    }
    setBadge(); renderVariants(); formEl.hidden = false;
    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeForm() { formEl.hidden = true; setMsg(''); }
  function edit(w) { openForm(w); }

  // ---- save / publish / toggle / delete ----
  function gather() {
    return {
      slug: slugify(titleEl.value),
      title: titleEl.value.trim(),
      description: descEl.value.trim() || null,
      category: catEl.value.trim() || null,
      preview_url: previewEl.value.trim(),
      variants: variants.filter(function (v) { return v.url; })
    };
  }

  async function save(publish) {
    var data = gather();
    if (!data.title) { setMsg('Add a title.', 'err'); return; }
    if (!data.preview_url) { setMsg('Add a preview image.', 'err'); return; }
    if (publish) { data.status = 'published'; data.published_at = current.published_at || new Date().toISOString(); }
    else if (current.id) { data.status = current.status; data.published_at = current.published_at; }
    else { data.status = 'draft'; }

    setMsg('Saving…');
    var q = current.id
      ? window.sb.from('wallpapers').update(data).eq('id', current.id).select().single()
      : window.sb.from('wallpapers').insert(data).select().single();
    var res = await q;
    if (res.error) { setMsg('Save failed: ' + res.error.message, 'err'); return; }
    current.id = res.data.id; current.status = res.data.status; current.published_at = res.data.published_at;
    setBadge();
    setMsg((publish ? 'Published' : 'Saved') + ' · not live yet. Publish the site from Settings.', 'ok');
    loadList();
  }

  async function toggle(w) {
    var publish = w.status !== 'published';
    var patch = { status: publish ? 'published' : 'draft', published_at: publish ? (w.published_at || new Date().toISOString()) : w.published_at };
    var res = await window.sb.from('wallpapers').update(patch).eq('id', w.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    setMsg('Saved · not live yet. Publish the site from Settings.', 'ok');
    loadList();
  }

  async function del(w) {
    if (!window.confirm('Delete "' + (w.title || 'untitled') + '"?\n\nIt comes off the live site at the next publish. The record is kept, so this can be undone.')) return;
/* Soft delete (migration 0012). The row is marked, not destroyed, so a
   mis-click is a mistake rather than an incident — and the anonymous SELECT
   policy excludes deleted rows, so the live site drops it on the next build
   without this code having to remember. Managers only; the guard trigger
   rejects anyone else. */
    var res = await window.sb.from('wallpapers')
      .update({ deleted_at: new Date().toISOString() }).eq('id', w.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    if (current.id === w.id) closeForm();
    loadList();
  }

  // preview upload
  document.getElementById('w-preview-file').addEventListener('change', async function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var st = document.getElementById('w-preview-status'); st.textContent = 'Uploading…';
    try { previewEl.value = await window.admin.upload('wallpapers', f, slugify(titleEl.value) || 'wallpaper'); st.textContent = 'Uploaded.'; }
    catch (err) { st.textContent = 'Upload failed: ' + (err && err.message || err); }
  });

  document.getElementById('add-variant').addEventListener('click', function () { variants.push({ label: '', url: '', width: null, height: null, format: '' }); renderVariants(); });
  document.getElementById('new-btn').addEventListener('click', function () { openForm(null); });
  document.getElementById('w-cancel').addEventListener('click', closeForm);
  document.getElementById('w-save').addEventListener('click', function () { save(false); });
  document.getElementById('w-publish').addEventListener('click', function () { save(true); });

  /* adminReady resolves only once Supabase holds a valid JWT, so the queries
     below run with a correct auth.uid(). This was the last controller still on
     the older requireSession() path — and because that path also unhid a
     `wp-page` element that does not exist, it threw before ever reaching
     loadList(), leaving the list permanently empty. auth.js reveals .adm-shell. */
  async function boot() {
    var s = await (window.adminReady || Promise.resolve(null));
    if (!s) return;
    loadList();
  }
  boot();
})();
