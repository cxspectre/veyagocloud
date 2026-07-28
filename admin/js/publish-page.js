/* /admin/publish — the screen that hosts the publish panel.

   Staff-visible rather than manager-only. That is the point of the change: an
   assistant is hired to ship content, and until now the only publish UI lived
   behind requireManager() in Settings, so the one role functions/deploy was
   widened for had no button anywhere. An employee still reaches this screen and
   still cannot publish — the panel says so, and RLS plus the deploy gate are
   what actually enforce it. */
(function () {
  'use strict';

  var panel = null;

  function setMsg(t, k) {
    var el = document.getElementById('msg');
    if (!el) return;
    el.textContent = t || '';
    el.className = 'msg' + (k ? ' ' + k : '');
  }

  async function load() {
    var r = await window.adminRoles.resolve();
    if (!r.role) {
      setMsg('You need a team account to see the publish history.', 'err');
      document.getElementById('publish-mount').innerHTML = '';
      return;
    }

    var session = await window.admin.session();
    panel = window.adminPublish.create(document.getElementById('publish-mount'), {
      role: r.role,
      userId: session && session.user ? session.user.id : null,
      email: session && session.user ? session.user.email : null
    });
  }

  /* The panel polls only while a build is in flight; coming back to the tab is
     the other moment the queue may have moved under you. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && panel) panel.refresh();
  });

  window.adminReady.then(function (s) { if (s) load(); });
})();
