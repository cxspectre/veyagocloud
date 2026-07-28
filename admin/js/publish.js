/* Publish panel — mounted by /admin/publish (and still reusable elsewhere).

   How far behind the live site is, the recent run history, and an action area
   that depends on who is looking:

     owner / admin   publish directly, and decide other people's requests
     assistant       ask for approval, then publish once an admin grants it
     employee        read-only — they can edit content but not ship it

   The two halves that everyone sees (status header, run history) are shared
   deliberately: a request and an approval are the same object seen from two
   sides, and the context needed to judge either — what changed, what shipped
   last, whether a build is in flight — is identical.

   Every element is looked up inside `root` rather than by global id, so the
   panel can be mounted more than once on a page. It could not be before.

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

  /* Which column tells us a row changed. NOT uniform: wallpapers has no
     updated_at at all (0001_init.sql), so the old single-column query errored on
     every call and the error was swallowed as a zero — the "N changes waiting"
     count silently ignored every wallpaper ever edited. */
  var SOURCES = [
    { table: 'articles',           stamp: 'updated_at',   match: ['status', 'published'], label: 'article' },
    { table: 'wallpapers',         stamp: 'published_at', match: ['status', 'published'], label: 'wallpaper' },
    { table: 'apps',               stamp: 'updated_at',   match: ['published', true],     label: 'app page' },
    { table: 'site_announcements', stamp: 'updated_at',   match: ['active', true],        label: 'announcement' }
  ];

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

  function hoursLeft(decidedAt, ttlHours) {
    if (!decidedAt) return 0;
    var ms = new Date(decidedAt).getTime() + ttlHours * 3600000 - Date.now();
    return Math.max(0, Math.round(ms / 3600000));
  }

  /* One panel instance. All state is closed over, so two instances cannot
     fight over a module-level timer the way the old single-instance version
     would have. */
  function create(root, opts) {
    opts = opts || {};
    var role = opts.role || null;
    var userId = opts.userId || null;
    var isManager  = role === 'owner' || role === 'admin';
    var isPublisher = isManager || role === 'assistant';
    var APPROVAL_TTL_HOURS = 24;   // must match APPROVAL_TTL_MS in functions/deploy

    var pollTimer = null;
    var destroyed = false;
    var myRequest = null;   // this user's open/decided request, if any
    var queue = [];         // pending requests, managers only

    root.innerHTML =
      '<div class="pub-state" style="margin-bottom:14px"></div>' +
      '<div class="pub-action"></div>' +
      '<div class="pub-queue"></div>' +
      '<p class="adm-subhead" style="margin-top:24px">Recent publishes</p>' +
      '<ul class="adm-list pub-runs"><li class="skel skel-sm"></li><li class="skel skel-sm"></li></ul>';

    function q(cls) { return root.querySelector('.' + cls); }

    function setMsg(text, kind) {
      var el = q('pub-msg');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'msg pub-msg' + (kind ? ' ' + kind : '');
    }

    /* ── How far behind the live site is ──────────────────────────── */
    async function pendingCount(lastSuccessAt) {
      if (!lastSuccessAt) return null;
      var counts = await Promise.all(SOURCES.map(function (s) {
        return window.sb.from(s.table)
          .select('id', { count: 'exact', head: true })
          .eq(s.match[0], s.match[1])
          .gt(s.stamp, lastSuccessAt);
      }));
      /* A table the caller cannot read, or one whose query failed, is reported
         rather than silently counted as zero — "0 changes waiting" and "I could
         not tell" are different answers. */
      var total = 0, failed = 0;
      counts.forEach(function (r) { if (r.error) failed++; else total += (r.count || 0); });
      return { total: total, failed: failed };
    }

    /* ── Data ─────────────────────────────────────────────────────── */
    async function load() {
      var runsRes = await window.sb.from('build_runs')
        .select('id,status,trigger,triggered_by_email,commit_sha,error,started_at,finished_at')
        .order('started_at', { ascending: false }).limit(5);

      if (runsRes.error) {
        q('pub-state').innerHTML = '<p class="msg err">Could not read publish history: ' + esc(runsRes.error.message) + '</p>';
        q('pub-runs').innerHTML = '';
        return null;
      }

      /* Requests are readable by all staff (migration 0011), so an employee
         sees the same queue state without being able to act on it. */
      var reqRes = await window.sb.from('publish_requests')
        .select('id,status,note,requested_by,requested_by_email,decided_at,decided_by_email,decision_note,created_at')
        .order('created_at', { ascending: false }).limit(20);

      var requests = reqRes.error ? [] : (reqRes.data || []);
      queue = requests.filter(function (r) { return r.status === 'pending'; });
      myRequest = requests.filter(function (r) {
        return r.requested_by === userId &&
               (r.status === 'pending' || r.status === 'approved' || r.status === 'rejected');
      })[0] || null;

      /* An approval that has aged out is spent as far as the UI is concerned —
         deploy will refuse it, so offering the button would be a lie. */
      if (myRequest && myRequest.status === 'approved' &&
          hoursLeft(myRequest.decided_at, APPROVAL_TTL_HOURS) <= 0) {
        myRequest = Object.assign({}, myRequest, { status: 'expired' });
      }

      return { runs: runsRes.data || [], requestsError: reqRes.error };
    }

    async function refresh() {
      if (destroyed) return;
      var data = await load();
      if (!data || destroyed) return;

      var runs = data.runs;
      var lastGood = runs.filter(function (r) { return r.status === 'success'; })[0];
      var inFlight = runs.filter(function (r) { return r.status === 'queued' || r.status === 'running'; })[0];
      var pending = await pendingCount(lastGood && lastGood.finished_at);
      if (destroyed) return;

      renderState(lastGood, inFlight, pending);
      renderAction(inFlight, data.requestsError);
      renderQueue();
      renderRuns(runs);

      /* Poll only while something is actually moving, and keep the handle so a
         second refresh cannot start a competing chain. */
      clearTimeout(pollTimer);
      if (inFlight) pollTimer = setTimeout(refresh, 6000);
    }

    /* ── Status header ────────────────────────────────────────────── */
    function renderState(lastGood, inFlight, pending) {
      var badge = '';
      if (pending && pending.failed) {
        badge = '<span class="badge badge-neutral">could not check for changes</span>';
      } else if (pending && pending.total > 0) {
        badge = '<span class="badge badge-warn">' + pending.total +
                ' change' + (pending.total === 1 ? '' : 's') + ' waiting</span>';
      } else if (pending) {
        /* Explicitly said, not left blank: "nothing waiting" and "we did not
           look" used to render identically. */
        badge = '<span class="badge badge-success">up to date</span>';
      }

      q('pub-state').innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<span class="dot ' + (inFlight ? 'amber' : lastGood ? 'green' : 'gray') + '"></span>' +
          '<span style="font-weight:600">' +
            (inFlight ? 'Publishing now…'
              : lastGood ? 'Live · published ' + esc(when(lastGood.finished_at))
              : 'Never published from here') +
          '</span>' + badge +
        '</div>';
    }

    /* ── The bit that depends on who you are ──────────────────────── */
    function renderAction(inFlight, requestsError) {
      var el = q('pub-action');
      el.innerHTML = '';

      if (!isPublisher) {
        el.innerHTML = '<p class="msg">You can create and edit content. Publishing it to the live site is done by an admin.</p>';
        return;
      }

      if (requestsError) {
        el.innerHTML = '<div class="adm-notice adm-notice--warn"><p>Could not read publish requests: ' +
          esc(requestsError.message) + '</p></div>';
      }

      if (isManager) return renderManagerAction(el, inFlight);
      return renderAssistantAction(el, inFlight);
    }

    function renderManagerAction(el, inFlight) {
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.disabled = !!inFlight;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="15" height="15"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>Publish to veyago.cloud';
      btn.addEventListener('click', function () { doPublish(null, btn); });

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
      row.appendChild(btn);
      var msg = document.createElement('span');
      msg.className = 'msg pub-msg';
      msg.style.minHeight = '0';
      row.appendChild(msg);
      el.appendChild(row);
    }

    function renderAssistantAction(el, inFlight) {
      var st = myRequest && myRequest.status;

      if (st === 'approved') {
        var left = hoursLeft(myRequest.decided_at, APPROVAL_TTL_HOURS);
        var ok = document.createElement('div');
        ok.className = 'adm-notice adm-notice--ok';
        ok.innerHTML = '<h3>Approved by ' + esc(myRequest.decided_by_email || 'an admin') + '</h3>' +
          '<p>You can publish whenever you are ready. This approval expires in about ' +
          left + ' hour' + (left === 1 ? '' : 's') + '.</p>';
        el.appendChild(ok);

        var pubBtn = document.createElement('button');
        pubBtn.className = 'btn btn-primary';
        pubBtn.type = 'button';
        pubBtn.disabled = !!inFlight;
        pubBtn.textContent = 'Publish to veyago.cloud';
        pubBtn.addEventListener('click', function () { doPublish(myRequest.id, pubBtn); });

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
        row.appendChild(pubBtn);
        var m = document.createElement('span'); m.className = 'msg pub-msg'; m.style.minHeight = '0';
        row.appendChild(m);
        el.appendChild(row);
        return;
      }

      if (st === 'pending') {
        var wait = document.createElement('div');
        wait.className = 'adm-notice adm-notice--info';
        wait.innerHTML = '<h3>Waiting for an admin</h3><p>Asked ' + esc(when(myRequest.created_at)) +
          (myRequest.note ? ' — “' + esc(myRequest.note) + '”' : '') + '</p>';
        el.appendChild(wait);

        var cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.type = 'button';
        cancel.textContent = 'Withdraw the request';
        cancel.addEventListener('click', function () { cancelRequest(cancel); });
        el.appendChild(cancel);
        var m2 = document.createElement('span'); m2.className = 'msg pub-msg';
        el.appendChild(m2);
        return;
      }

      if (st === 'rejected' || st === 'expired') {
        var no = document.createElement('div');
        no.className = 'adm-notice adm-notice--warn';
        no.innerHTML = st === 'expired'
          ? '<h3>That approval expired</h3><p>Approvals are good for ' + APPROVAL_TTL_HOURS +
            ' hours. Ask again when you are ready to publish.</p>'
          : '<h3>Not approved</h3><p>' +
            esc(myRequest.decision_note || 'No reason was given.') + '</p>';
        el.appendChild(no);
      }

      el.appendChild(requestForm());
    }

    function requestForm() {
      var wrap = document.createElement('div');
      var field = document.createElement('div');
      field.className = 'field';
      var label = document.createElement('label');
      label.setAttribute('for', 'pub-note');
      label.textContent = 'What are you publishing?';
      var input = document.createElement('input');
      input.className = 'input';
      input.id = 'pub-note';
      input.type = 'text';
      input.placeholder = 'This week’s field note and two wallpapers';
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'The whole site is rebuilt from everything currently marked published — an approval covers all of it, not one item.';
      field.appendChild(label); field.appendChild(input); field.appendChild(hint);

      var btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.textContent = 'Ask an admin to approve';
      btn.addEventListener('click', function () { requestApproval(input.value, btn); });

      var msg = document.createElement('span');
      msg.className = 'msg pub-msg';

      wrap.appendChild(field); wrap.appendChild(btn); wrap.appendChild(msg);
      return wrap;
    }

    /* ── The approval queue (managers) ────────────────────────────── */
    function renderQueue() {
      var el = q('pub-queue');
      el.innerHTML = '';
      if (!isManager || !queue.length) return;

      var head = document.createElement('p');
      head.className = 'adm-subhead';
      head.style.marginTop = '24px';
      head.innerHTML = 'Waiting for you <span class="n">' + queue.length + '</span>';
      el.appendChild(head);

      var list = document.createElement('ul');
      list.className = 'adm-list';
      queue.forEach(function (r) { list.appendChild(queueRow(r)); });
      el.appendChild(list);
    }

    function queueRow(r) {
      var li = document.createElement('li');
      li.className = 'adm-item adm-item--stack';

      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title';
      t.textContent = r.requested_by_email || 'Someone';
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = when(r.created_at) + (r.note ? ' · ' + r.note : ' · no note');
      main.appendChild(t); main.appendChild(s);

      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var yes = document.createElement('button');
      yes.className = 'btn btn-sm btn-primary';
      yes.type = 'button';
      yes.textContent = 'Approve';
      yes.addEventListener('click', function () { decide(r, 'approved', null, yes); });

      var no = document.createElement('button');
      no.className = 'btn btn-sm';
      no.type = 'button';
      no.textContent = 'Decline';
      no.addEventListener('click', function () {
        /* A decline without a reason is just silence, and the requester cannot
           ask the row why. */
        var why = window.prompt('Why not? This is shown to ' + (r.requested_by_email || 'them') + '.');
        if (why === null) return;
        decide(r, 'rejected', why, no);
      });

      acts.appendChild(yes); acts.appendChild(no);
      li.appendChild(main); li.appendChild(acts);
      return li;
    }

    /* ── Actions ──────────────────────────────────────────────────── */
    async function requestApproval(note, btn) {
      btn.disabled = true;
      setMsg('Sending…');
      var res = await window.sb.from('publish_requests').insert({
        requested_by_email: opts.email || null,
        note: (note || '').trim() || null
      });
      btn.disabled = false;
      if (res.error) { setMsg('Could not send the request: ' + res.error.message, 'err'); return; }
      setMsg('');
      window.admin.toast('Asked an admin to approve');
      window.adminRoles.invokeFn('notify-publish-request', {}).catch(function () {});
      refresh();
    }

    async function cancelRequest(btn) {
      if (!myRequest) return;
      btn.disabled = true;
      var res = await window.sb.from('publish_requests')
        .update({ status: 'cancelled' }).eq('id', myRequest.id);
      btn.disabled = false;
      if (res.error) { setMsg('Could not withdraw it: ' + res.error.message, 'err'); return; }
      window.admin.toast('Request withdrawn');
      refresh();
    }

    async function decide(request, status, note, btn) {
      btn.disabled = true;
      /* decided_by / decided_at are stamped by the guard trigger, not here — a
         client must not be able to claim who approved something, or when. */
      var res = await window.sb.from('publish_requests')
        .update({ status: status, decision_note: note || null })
        .eq('id', request.id).eq('status', 'pending');
      btn.disabled = false;
      if (res.error) { window.admin.toast('Could not save that: ' + res.error.message); return; }
      window.admin.toast(status === 'approved' ? 'Approved' : 'Declined');
      refresh();
    }

    async function doPublish(approvalId, btn) {
      if (!confirm('Publish everything currently marked published to veyago.cloud?\n\nThe site is rebuilt and checked before it goes out. If the check fails, nothing is published.')) return;

      btn.disabled = true;
      setMsg('Starting…');
      try {
        var body = { trigger: 'manual' };
        if (approvalId) body.approval_id = approvalId;
        await window.adminRoles.invokeFn('deploy', body);
        setMsg('');
        window.admin.toast('Publishing started');
        refresh();
      } catch (err) {
        setMsg('Could not start: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }

    /* ── Run history ──────────────────────────────────────────────── */
    function renderRuns(runs) {
      var listEl = q('pub-runs');
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

    refresh();

    return {
      refresh: refresh,
      destroy: function () { destroyed = true; clearTimeout(pollTimer); }
    };
  }

  /* Back-compat: settings.js mounted this with a bare element and no options.
     Resolves the role itself so an old call site still renders correctly. */
  async function mount(root, opts) {
    if (!root) return null;
    if (opts) return create(root, opts);
    var r = await window.adminRoles.resolve();
    var session = await window.admin.session();
    return create(root, {
      role: r.role,
      userId: session && session.user ? session.user.id : null,
      email: session && session.user ? session.user.email : null
    });
  }

  window.adminPublish = { mount: mount, create: create };
})();
