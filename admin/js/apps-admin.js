/* App catalogue list for /admin/apps.html.
   Listing + publish toggle + delete only — the product page itself is composed
   in /admin/apps-editor (Edit / New both route there). */
(function () {
  'use strict';

  /* Deleting content is managers only since 0012, and the guard trigger
     enforces it — so the button has to reflect that, or staff get a control
     that fails. Cosmetic; the database is the boundary. */
  var isManager = false;

  var listEl = document.getElementById('apps-list');
  var msg    = document.getElementById('msg');

  function setMsg(t, k) {
    if (!msg) return;
    msg.textContent = t || '';
    msg.className = 'msg' + (k ? ' ' + k : '');
  }

  async function load() {
    isManager = await window.adminRoles.isManager();
    if (!listEl) return;
    /* select('*') so a missing column never errors the query; order by the two
       columns that always exist. */
    var res = await window.sb.from('apps')
      .select('*')
      /* Deleted rows are soft (0012) — the admin still CAN read them
         (staff SELECT is wide so a manager can restore), so the list filters. */
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (res.error) {
      listEl.innerHTML =
        '<li style="background:#fff4f4;border:1px solid #f5c2c2;border-radius:12px;padding:16px 18px;list-style:none">' +
          '<strong style="color:#b3261e;font-size:.9rem">Could not load apps</strong>' +
          '<p style="color:#b3261e;font-size:.84rem;margin:6px 0 0">' + (res.error.message || String(res.error)) + '</p>' +
        '</li>';
      return;
    }
    render(res.data || []);
  }

  function sectionCount(a) {
    return Array.isArray(a.layout) ? a.layout.length : 0;
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<li style="color:var(--muted);padding:22px 0;list-style:none">No apps yet. <a href="/admin/apps-editor" style="color:var(--blue)">Add the first one →</a></li>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var li = document.createElement('li'); li.className = 'adm-item';

      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      if (a.icon_url) {
        icon.style.cssText = 'background:#fff;padding:0;overflow:hidden';
        icon.innerHTML = '<img src="' + a.icon_url + '" alt="" style="width:100%;height:100%;object-fit:cover" />';
      } else {
        icon.style.cssText = 'background:var(--bg-card);color:var(--muted-2)';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3"/></svg>';
      }

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.name || '(unnamed)';
      var sub = document.createElement('div'); sub.className = 'adm-item-sub';
      var n = sectionCount(a);
      sub.textContent = (a.tagline || a.category || '') + (n ? ' · ' + n + ' section' + (n === 1 ? '' : 's') : ' · no page yet');
      main.appendChild(t); main.appendChild(sub);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var statusBadge = document.createElement('span'); statusBadge.className = 'badge badge-' + (a.status || 'in-development'); statusBadge.textContent = a.status || 'in-development';
      var pubBadge = document.createElement('span');
      pubBadge.className = 'badge badge-' + (a.published ? 'live' : 'in-development');
      pubBadge.textContent = a.published ? 'on catalogue' : 'hidden';

      var edit = document.createElement('a'); edit.className = 'btn btn-sm';
      edit.href = '/admin/apps-editor?id=' + encodeURIComponent(a.id); edit.textContent = 'Edit';

      var tog = document.createElement('button'); tog.className = 'btn btn-sm'; tog.type = 'button';
      tog.textContent = a.published ? 'Hide' : 'Show';
      tog.addEventListener('click', function () { toggle(a); });

      var del = document.createElement('button'); del.className = 'btn btn-sm btn-danger'; del.type = 'button'; del.textContent = 'Delete';
      del.hidden = !isManager;
      del.addEventListener('click', function () { remove(a); });

      acts.appendChild(statusBadge); acts.appendChild(pubBadge); acts.appendChild(edit); acts.appendChild(tog); acts.appendChild(del);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  async function toggle(a) {
    var res = await window.sb.from('apps').update({ published: !a.published }).eq('id', a.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    setMsg('Saved · not live yet. Publish the site from Settings.', 'ok');
    load();
  }

  async function remove(a) {
    if (!confirm('Delete "' + (a.name || 'this app') + '"?\n\nIt comes off the catalogue at the next publish. The record is kept, so this can be undone.')) return;
/* Soft delete (migration 0012). The row is marked, not destroyed, so a
   mis-click is a mistake rather than an incident — and the anonymous SELECT
   policy excludes deleted rows, so the live site drops it on the next build
   without this code having to remember. Managers only; the guard trigger
   rejects anyone else. */
    var res = await window.sb.from('apps')
      .update({ deleted_at: new Date().toISOString() }).eq('id', a.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    load();
  }

  /* Re-fetch when navigating back from the editor (bfcache restore) */
  window.addEventListener('pageshow', function (e) { if (e.persisted) load(); });

  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
