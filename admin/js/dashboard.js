/* Dashboard controller — stat cards, recent articles, status panel. */
(function () {
  'use strict';

  var listEl      = document.getElementById('article-list');
  var statusPanel = document.getElementById('status-panel');

  function fmt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function setStat(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* Show a prominent error banner inside the articles card. */
  function showListError(msg) {
    if (!listEl) return;
    listEl.innerHTML =
      '<li style="background:#fff4f4;border:1px solid #f5c2c2;border-radius:12px;padding:16px 18px;list-style:none">' +
        '<strong style="color:#b3261e;font-size:.9rem">Could not load articles</strong>' +
        '<p style="color:#b3261e;font-size:.84rem;margin:6px 0 0;line-height:1.5">' + escHtml(msg) + '</p>' +
        '<p style="font-size:.8rem;color:var(--muted);margin:8px 0 0">Open your browser console (F12 → Console) for more detail.</p>' +
      '</li>';
  }

  /* ── Stats ── */
  async function loadStats() {
    var results = await Promise.allSettled([
      window.sb.from('articles').select('id,status'),
      window.sb.from('wallpapers').select('id,status'),
      window.sb.from('apps').select('id,published'),
      window.sb.from('projects').select('id,published'),
      window.sb.from('site_announcements').select('id,message,active').eq('active', true).limit(1)
    ]);

    if (results[0].status === 'fulfilled' && !results[0].value.error) {
      var arts = results[0].value.data || [];
      setStat('stat-articles', arts.length);
      setStat('stat-articles-pub', arts.length ? arts.filter(function(a){ return a.status==='published'; }).length + ' published' : 'none yet');
    }
    if (results[1].status === 'fulfilled' && !results[1].value.error) {
      var wps = results[1].value.data || [];
      setStat('stat-wallpapers', wps.length);
      setStat('stat-wallpapers-pub', wps.length ? wps.filter(function(w){ return w.status==='published'; }).length + ' published' : 'none yet');
    }
    if (results[2].status === 'fulfilled' && !results[2].value.error) {
      var apps = results[2].value.data || [];
      setStat('stat-apps', apps.length);
      setStat('stat-apps-pub', apps.length ? apps.filter(function(a){ return a.published; }).length + ' on catalogue' : 'none yet');
    }
    if (results[3].status === 'fulfilled' && !results[3].value.error) {
      var projs = results[3].value.data || [];
      setStat('stat-projects', projs.length);
      setStat('stat-projects-pub', projs.length ? projs.filter(function(p){ return p.published; }).length + ' published' : 'none yet');
    }

    var activeAnn = (results[4].status === 'fulfilled' && !results[4].value.error && results[4].value.data && results[4].value.data[0]) || null;
    buildStatusPanel(activeAnn);
    var annEl = document.getElementById('stat-ann-status');
    if (annEl) { annEl.textContent = activeAnn ? 'Active' : 'None'; annEl.style.color = activeAnn ? '#1a7f37' : 'var(--muted)'; }
  }

  function buildStatusPanel(activeAnn) {
    if (!statusPanel) return;
    var rows = activeAnn
      ? '<div class="dash-status-row"><span class="dash-status-dot green"></span><div>' +
          '<div class="dash-status-label">Announcement active</div>' +
          '<div class="dash-status-sub">' + escHtml((activeAnn.message||'').slice(0,60)) + (activeAnn.message&&activeAnn.message.length>60?'…':'') +
          ' <a href="/admin/announcements.html">Edit →</a></div></div></div>'
      : '<div class="dash-status-row"><span class="dash-status-dot gray"></span><div>' +
          '<div class="dash-status-label">No active announcement</div>' +
          '<div class="dash-status-sub"><a href="/admin/announcements.html">Create one →</a></div></div></div>';
    rows += '<div class="dash-status-row"><span class="dash-status-dot green"></span><div>' +
      '<div class="dash-status-label">Site live</div>' +
      '<div class="dash-status-sub"><a href="https://www.veyago.cloud" target="_blank" rel="noopener">veyago.cloud ↗</a></div></div></div>';
    statusPanel.innerHTML = rows;
  }

  /* ── Articles ── */
  async function loadArticles() {
    if (!listEl) return;

    /* Use select('*') so missing columns (e.g. updated_at if migration was partial)
       don't cause a query error. Order by created_at which always exists. */
    var res = await window.sb.from('articles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(8);

    if (res.error) {
      showListError(res.error.message);
      return;
    }

    renderArticles(res.data || []);
  }

  function renderArticles(rows) {
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true">' +
            '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +
            '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
            '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' +
          '</svg>' +
          '<p>No articles yet.</p>' +
          '<a class="btn btn-primary btn-sm" href="/admin/article.html">Write first article</a>' +
        '</li>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'adm-item';

      var isPub   = a.status === 'published';
      var iconBg  = isPub ? '#e8f0fe' : 'var(--bg-card)';
      var iconCol = isPub ? '#1a56db' : 'var(--muted-2)';
      var icon = document.createElement('div');
      icon.className = 'adm-item-icon';
      icon.style.cssText = 'background:' + iconBg + ';color:' + iconCol;
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.title || '(untitled)';
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      var dateStr = fmt(a.published_at || a.updated_at || a.created_at);
      s.textContent = (isPub ? 'Published' : 'Updated') + (dateStr ? ' ' + dateStr : '');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge badge-' + a.status; badge.textContent = a.status;
      var edit = document.createElement('a');
      edit.className = 'btn btn-sm';
      edit.href = '/admin/article.html?id=' + encodeURIComponent(a.id);
      edit.textContent = 'Edit';

      acts.appendChild(badge); acts.appendChild(edit);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  function refresh() { loadStats(); loadArticles(); }

  /* Re-fetch when the user switches back to this tab after editing an article. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  var refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refresh);

  /* Re-fetch when navigating back (bfcache restore — browser restores the
     pre-refresh DOM, so we reload to show current data). */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) refresh();
  });

  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) refresh(); });
})();
