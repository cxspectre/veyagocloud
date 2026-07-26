/* Publish panel. Mounted by settings.js (and reusable elsewhere).

   Replaces the old "run npm run build" instructions and the permanently-green
   "Site live" dot with something honest: how far behind the live site is, a
   button that actually publishes, and the recent run history.

   The build itself is verified in CI before anything is committed — see
   .github/workflows/publish.yml — so the worst case here is a failed run, not
   a broken site. */
(function () {
  'use strict';

  var STATUS_BADGE = {
    queued:  'badge-neutral',
    running: 'badge-info',
    success: 'badge-success',
    failed:  'badge-danger'
  };
  var STATUS_LABEL = {
    queued: 'queued', running: 'building', success: 'published', failed: 'failed'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function when(iso) {
    if (!iso) return '';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 2880) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  }

  function mount(root) {
    if (!root) return;
    root.innerHTML =
      '<div id="pub-state" style="margin-bottom:14px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-primary" id="pub-btn" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="15" height="15"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>' +
          'Publish to veyago.cloud</button>' +
        '<span class="msg" id="pub-msg" style="min-height:0"></span>' +
      '</div>' +
      '<p class="adm-subhead" style="margin-top:24px">Recent publishes</p>' +
      '<ul class="adm-list" id="pub-runs"><li class="skel skel-sm"></li><li class="skel skel-sm"></li></ul>';

    document.getElementById('pub-btn').addEventListener('click', publish);
    refresh();
  }

  /* How many published rows changed since the last successful build. */
  async function pendingCount(lastSuccessAt) {
    if (!lastSuccessAt) return null;
    var tables = [
      ['articles', 'status', 'published'],
      ['wallpapers', 'status', 'published']
    ];
    var counts = await Promise.all(tables.map(function (t) {
      return window.sb.from(t[0])
        .select('id', { count: 'exact', head: true })
        .eq(t[1], t[2]).gt('updated_at', lastSuccessAt);
    }));
    return counts.reduce(function (n, r) { return n + (r.error ? 0 : (r.count || 0)); }, 0);
  }

  async function refresh() {
    var stateEl = document.getElementById('pub-state');
    var listEl  = document.getElementById('pub-runs');
    if (!stateEl) return;

    var res = await window.sb.from('build_runs')
      .select('id,status,trigger,triggered_by_email,commit_sha,error,started_at,finished_at')
      .order('started_at', { ascending: false }).limit(5);

    if (res.error) {
      stateEl.innerHTML = '<p class="msg err">Could not read publish history: ' + esc(res.error.message) + '</p>';
      listEl.innerHTML = '';
      return;
    }

    var runs = res.data || [];
    var lastGood = runs.filter(function (r) { return r.status === 'success'; })[0];
    var inFlight = runs.filter(function (r) { return r.status === 'queued' || r.status === 'running'; })[0];

    var pending = await pendingCount(lastGood && lastGood.finished_at);

    stateEl.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<span class="dot ' + (inFlight ? 'amber' : lastGood ? 'green' : 'gray') + '"></span>' +
        '<span style="font-weight:600">' +
          (inFlight ? 'Publishing now…'
            : lastGood ? 'Live · published ' + esc(when(lastGood.finished_at))
            : 'Never published from here') +
        '</span>' +
        (pending
          ? '<span class="badge ' + (pending > 0 ? 'badge-warn' : 'badge-neutral') + '">' +
            pending + ' change' + (pending === 1 ? '' : 's') + ' waiting</span>'
          : '') +
      '</div>';

    renderRuns(runs);

    /* Poll while a run is in flight so the panel settles on its own. */
    if (inFlight) setTimeout(refresh, 6000);
  }

  function renderRuns(runs) {
    var listEl = document.getElementById('pub-runs');
    if (!listEl) return;
    if (!runs.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>' +
          '<p>No publishes yet.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    runs.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title';
      t.textContent = (r.triggered_by_email || 'someone') + ' · ' + (r.trigger || 'manual');
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = when(r.started_at) +
        (r.commit_sha ? ' · ' + String(r.commit_sha).slice(0, 7) : '') +
        (r.error ? ' · ' + r.error : '');
      main.appendChild(t); main.appendChild(s);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (STATUS_BADGE[r.status] || 'badge-neutral');
      badge.textContent = STATUS_LABEL[r.status] || r.status;
      acts.appendChild(badge);
      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  async function publish() {
    var btn = document.getElementById('pub-btn');
    var msg = document.getElementById('pub-msg');
    if (!confirm('Publish everything currently marked published to veyago.cloud?\n\nThe site is rebuilt and checked before it goes out. If the check fails, nothing is published.')) return;

    btn.disabled = true;
    msg.textContent = 'Starting…'; msg.className = 'msg';
    try {
      await window.adminRoles.invokeFn('deploy', { trigger: 'manual' });
      msg.textContent = ''; msg.className = 'msg';
      window.admin.toast('Publishing started');
      refresh();
    } catch (err) {
      msg.textContent = 'Could not start: ' + err.message; msg.className = 'msg err';
    } finally {
      btn.disabled = false;
    }
  }

  window.adminPublish = { mount: mount, refresh: refresh };
})();
