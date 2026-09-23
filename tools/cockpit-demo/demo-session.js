/* demo-session.js - stands in for data/session.js and data/gate.js.
 *
 * The demo is signed in from the first frame, as the fixture's owner: an
 * owner is a manager, so Finance and the revenue figures are on screen. The
 * surface is the one the views read (workspaceSession.employee, isManager(),
 * access, role) and the one gate.js offers (workspaceGate.close, .leaving).
 *
 * Opening the app is what gate.js does once a session checks out: the shell
 * loses its lock, the header shows who is signed in, and 'workspace:authed'
 * tells store.js to load. That event waits for DOMContentLoaded, because
 * store.js - which listens for it - is the last script on the page.
 */
(function () {
  'use strict';

  var demo = window.COCKPIT_DEMO;
  var me = demo.me;
  var sb = window.supabase.createClient();
  var state = {
    session: { access_token: '', user: { id: me.user_id, email: me.email } },
    employee: me, role: me.role, access: 'staff', factorId: null, userId: me.user_id, resolved: true
  };

  window.workspaceSession = {
    client: sb,
    ready: function () { return Promise.resolve(state); },
    get session() { return state.session; },
    get employee() { return state.employee; },
    get role() { return state.role; },
    get access() { return state.access; },
    get factorId() { return null; },
    get userId() { return state.userId; },
    isSignedIn: function () { return true; },
    isStaff: function () { return true; },
    needsCode: function () { return false; },
    isManager: function () { return state.role === 'owner' || state.role === 'admin'; },
    signIn: function () { return Promise.resolve({ data: null, error: null }); },
    refresh: function () { return Promise.resolve(state); },
    signOut: function () { return Promise.resolve({ error: null }); }
  };

  window.workspaceGate = { close: function () {}, leaving: false };

  function unlock() {
    var app = document.querySelector('.app');
    if (app) {
      app.classList.remove('locked');
      app.inert = false;
      app.removeAttribute('inert');
    }
    var dialog = document.getElementById('modal');
    if (dialog) dialog.inert = false;
  }

  /* What gate.js's paintHeader() draws: the person's name and initials in
     place of the static avatar. Re-applied after every load, as there. */
  function paintHeader() {
    var initials = window.workspaceData ? window.workspaceData.initials(me.full_name) : me.full_name.charAt(0);
    var label = document.querySelector('.demo-label');
    if (label) label.textContent = me.title;
    var badge = document.querySelector('.sidebar .profile .avatar');
    if (badge) badge.textContent = initials;
    var avatar = document.querySelector('.header-avatar');
    if (!avatar || avatar.dataset.sessionChip) return;
    var chip = document.createElement('div');
    chip.className = 'session-chip';
    chip.dataset.sessionChip = '1';
    chip.innerHTML = '<span class="session-name"></span><span class="avatar owner"></span>';
    chip.querySelector('.session-name').textContent = me.full_name;
    chip.querySelector('.avatar').textContent = initials;
    avatar.replaceWith(chip);
  }

  document.addEventListener('DOMContentLoaded', function () {
    unlock();
    paintHeader();
    document.body.addEventListener('workspace:loaded', paintHeader);
    document.body.dispatchEvent(new CustomEvent('workspace:session', { detail: state }));
    document.body.dispatchEvent(new CustomEvent('workspace:authed'));
  });
})();
