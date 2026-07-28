/* Settings page: connected accounts (sync), the retired allowlist, and the
   publish panel. Managers only — guarded here and enforced by RLS. */
(function () {
  'use strict';

  var msg = document.getElementById('msg');
  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  function timeAgo(iso) {
    if (!iso) return 'never';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 2880) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  }
  function syncedAgo(iso) { return iso ? 'synced ' + timeAgo(iso) : 'never synced'; }

  async function load() {
    if (!(await window.adminRoles.requireManager())) return;
    loadAccounts();
    loadEmail();
    loadLegacy();
  }

  /* ── Connected accounts ───────────────────────────────────────────── */
  async function loadAccounts() {
    var listEl = document.getElementById('sync-list');
    var res = await window.sb.from('finance_accounts')
      .select('id,name,kind,provider,currency,last_synced_at')
      .eq('active', true).order('name');
    if (res.error) { setMsg('Could not load accounts: ' + res.error.message, 'err'); return; }

    var rows = (res.data || []).filter(function (a) { return a.provider; });
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>' +
          '<p>Nothing connected yet — run a sync to pull your accounts in.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (a) {
      var stale = !a.last_synced_at ||
        (Date.now() - new Date(a.last_synced_at).getTime()) > 36 * 3600e3;
      var li = document.createElement('li'); li.className = 'adm-item';
      var icon = document.createElement('div'); icon.className = 'adm-item-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.8" stroke-linecap="round"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11"/></svg>';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = a.name;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = a.provider + ' · ' + a.currency + ' · ' + syncedAgo(a.last_synced_at);
      main.appendChild(t); main.appendChild(s);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (stale ? 'badge-warn' : 'badge-success');
      badge.textContent = stale ? 'stale' : 'fresh';
      acts.appendChild(badge);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  function wireSync(btnId, fnName, label) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      setMsg('Syncing ' + label + '…');
      try {
        var out = await window.adminRoles.invokeFn(fnName, {});
        setMsg('');
        window.admin.toast(label + ' synced — ' + (out.transactions || 0) + ' transactions');
        loadAccounts();
      } catch (err) {
        setMsg(label + ' sync failed: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }
  wireSync('sync-mercury', 'sync-mercury', 'Mercury');
  wireSync('sync-stripe', 'sync-stripe', 'Stripe');

  /* ── Recent email ─────────────────────────────────────────────────── */
  var KIND_LABEL = {
    invite: 'Invite', password_reset: 'Password reset',
    task_assigned: 'Task assigned', digest: 'Digest'
  };

  async function loadEmail() {
    var listEl = document.getElementById('email-list');
    if (!listEl) return;
    var res = await window.sb.from('email_log')
      .select('id,to_email,kind,subject,ok,error,created_at')
      .order('created_at', { ascending: false }).limit(8);

    if (res.error) {
      /* Almost always "relation does not exist" — the email_log migration has
         not been applied. Say what it means for the reader, not which numbered
         file is missing; the migration number belongs in this comment. */
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>' +
          '<p>Send history is not being recorded yet, so a failed invite will not show up here.</p>' +
        '</li>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>' +
          '<p>Nothing sent yet.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach(function (m) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title';
      t.textContent = (KIND_LABEL[m.kind] || m.kind) + ' → ' + m.to_email;
      var sub = document.createElement('div'); sub.className = 'adm-item-sub';
      sub.textContent = timeAgo(m.created_at) + (m.error ? ' · ' + m.error : '');
      main.appendChild(t); main.appendChild(sub);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (m.ok ? 'badge-success' : 'badge-danger');
      badge.textContent = m.ok ? 'sent' : 'failed';
      acts.appendChild(badge);
      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  /* ── Retired allowlist (record only — grants nothing since 0007) ──── */
  async function loadLegacy() {
    var listEl = document.getElementById('legacy-list');
    var res = await window.sb.from('admins').select('user_id,email,created_at').order('created_at');
    if (res.error || !res.data || !res.data.length) {
      listEl.innerHTML =
        '<li class="dash-empty-state">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" stroke-width="1.5" width="34" height="34" aria-hidden="true"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
          '<p>Nothing on the retired allowlist.</p>' +
        '</li>';
      return;
    }
    listEl.innerHTML = '';
    res.data.forEach(function (u) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = u.email || u.user_id;
      var s = document.createElement('div'); s.className = 'adm-item-sub'; s.textContent = 'Grants no access — roles live on the Team page';
      main.appendChild(t); main.appendChild(s);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span'); badge.className = 'badge badge-neutral'; badge.textContent = 'retired';
      acts.appendChild(badge);
      li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  window.adminReady.then(function (s) { if (s) load(); });
})();
