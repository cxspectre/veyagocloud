/* Full article list for /admin/journal.html */
(function () {
  'use strict';

  var listEl = document.getElementById('article-list');
  var msg    = document.getElementById('msg');

  function setMsg(t, k) {
    if (!msg) return;
    msg.textContent = t || '';
    msg.className = 'msg' + (k ? ' ' + k : '');
  }

  function fmt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function load() {
    if (!listEl) return;
    /* Use select('*') so missing columns never cause a query error.
       Order by created_at which always exists. */
    var res = await window.sb.from('articles')
      .select('*')
      .order('created_at', { ascending: false });

    if (res.error) {
      listEl.innerHTML =
        '<li style="background:#fff4f4;border:1px solid #f5c2c2;border-radius:12px;padding:16px 18px;list-style:none">' +
          '<strong style="color:#b3261e;font-size:.9rem">Could not load articles</strong>' +
          '<p style="color:#b3261e;font-size:.84rem;margin:6px 0 0">' + (res.error.message || String(res.error)) + '</p>' +
        '</li>';
      return;
    }

    render(res.data || []);
  }

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<li style="color:var(--muted);padding:22px 0;list-style:none">No articles yet. <a href="/admin/article.html" style="color:var(--blue)">Write the first one →</a></li>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var li = document.createElement('li'); li.className = 'adm-item';

      var isPub   = a.status === 'published';
      var iconBg  = isPub ? '#e8f0fe' : 'var(--bg-card)';
      var iconCol = isPub ? '#1a56db' : 'var(--muted-2)';
      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.style.cssText = 'background:' + iconBg + ';color:' + iconCol;
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.title || '(untitled)';
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = (isPub ? 'Published ' : 'Updated ') + fmt(a.published_at || a.updated_at || a.created_at);
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span'); badge.className = 'badge badge-' + a.status; badge.textContent = a.status;
      var edit  = document.createElement('a');   edit.className  = 'btn btn-sm';
      edit.href = '/admin/article.html?id=' + encodeURIComponent(a.id); edit.textContent = 'Edit';

      var tog = document.createElement('button'); tog.className = 'btn btn-sm'; tog.type = 'button';
      tog.textContent = isPub ? 'Unpublish' : 'Publish';
      tog.addEventListener('click', function () { toggle(a); });

      var del = document.createElement('button'); del.className = 'btn btn-sm btn-danger'; del.type = 'button'; del.textContent = 'Delete';
      del.addEventListener('click', function () { remove(a); });

      acts.appendChild(badge); acts.appendChild(edit); acts.appendChild(tog); acts.appendChild(del);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  async function toggle(a) {
    var publish = a.status !== 'published';
    var res = await window.sb.from('articles')
      .update({ status: publish ? 'published' : 'draft', published_at: publish ? (a.published_at || new Date().toISOString()) : a.published_at })
      .eq('id', a.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    setMsg('Saved. Run npm run build to update the live site.', 'ok');
    load();
  }

  async function remove(a) {
    if (!confirm('Delete "' + (a.title || 'untitled') + '"? This cannot be undone.')) return;
    var res = await window.sb.from('articles').delete().eq('id', a.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    load();
  }

  /* Re-fetch when navigating back (bfcache restore) */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) load();
  });

  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
