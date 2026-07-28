/* Auth controller.
 *
 * The session recovery problem: on a new page load, getSession() may return a
 * session object before Supabase has fully restored it into the client's internal
 * state. Queries made immediately afterwards run with a stale/expired JWT, RLS
 * sees auth.uid() = null, and admin-only rows are invisible.
 *
 * Fix: use onAuthStateChange (SIGNED_IN / TOKEN_REFRESHED) as the trigger for
 * dispatching admin:authed. Supabase fires this event only after the token is
 * genuinely active — so any query made inside an admin:authed listener has a
 * valid JWT and correct RLS context.
 *
 * getSession() is kept only as a quick "is there anyone here at all?" check so
 * pages without a login form can redirect unauthenticated visitors immediately.
 */
(function () {
  'use strict';

  /* ── Rate limiting ────────────────────────────────────────────────── */
  var RL = { key: 'veyago.admin.rl', max: 5, windowMs: 15 * 60 * 1000, lockMs: 60 * 1000 };

  function rlData() { try { return JSON.parse(localStorage.getItem(RL.key) || '{"attempts":[],"lockedUntil":0}'); } catch(e) { return { attempts: [], lockedUntil: 0 }; } }
  function rlSave(d) { try { localStorage.setItem(RL.key, JSON.stringify(d)); } catch(e) {} }
  function rlCheck() {
    var d = rlData();
    if (d.lockedUntil > Date.now()) { startCountdown(d.lockedUntil); return false; }
    var now = Date.now();
    d.attempts = d.attempts.filter(function(t){ return now - t < RL.windowMs; });
    if (d.attempts.length >= RL.max) { d.lockedUntil = now + RL.lockMs; rlSave(d); startCountdown(d.lockedUntil); return false; }
    return true;
  }
  function rlFail() { var d = rlData(); d.attempts.push(Date.now()); rlSave(d); var r = RL.max - d.attempts.length; if (r > 0) setAttemptsMsg(r); }
  function rlClear() { try { localStorage.removeItem(RL.key); } catch(e) {} }

  var countdownTimer = null;
  function startCountdown(lockedUntil) {
    clearInterval(countdownTimer);
    var attMsg = document.getElementById('attempts-msg');
    var btn = document.getElementById('login-btn');
    if (btn) btn.disabled = true;
    function tick() {
      var secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (secs <= 0) { clearInterval(countdownTimer); if (btn) btn.disabled = false; if (attMsg) { attMsg.textContent = ''; attMsg.className = 'msg'; } return; }
      if (attMsg) { attMsg.innerHTML = '<span style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Too many attempts — try again in <strong>' + secs + 's</strong></span>'; attMsg.className = 'msg err'; }
      secs--;
    }
    tick(); countdownTimer = setInterval(tick, 1000);
  }
  function setAttemptsMsg(remaining) { var el = document.getElementById('attempts-msg'); if (!el) return; el.textContent = remaining + ' attempt' + (remaining === 1 ? '' : 's') + ' remaining'; el.className = 'msg' + (remaining <= 2 ? ' err' : ''); }

  /* ── DOM refs ──────────────────────────────────────────────────────── */
  var loginEl  = document.getElementById('adm-login');
  var shellEl  = document.getElementById('adm-shell');
  var step1    = document.getElementById('step-password');
  var step2    = document.getElementById('step-totp');
  var stepForgot = document.getElementById('step-forgot');
  var stepSetPw  = document.getElementById('step-set-password');
  var loginMsg = document.getElementById('login-msg');
  var totpMsg  = document.getElementById('totp-msg');
  var forgotMsg = document.getElementById('forgot-msg');
  var setPwMsg  = document.getElementById('set-pw-msg');

  /* Show exactly one panel inside the login card. */
  function showStep(el) {
    [step1, step2, stepForgot, stepSetPw].forEach(function (s) {
      if (s) s.hidden = s !== el;
    });
  }

  /* ── adminReady promise ───────────────────────────────────────────── */
  var resolveReady;
  window.adminReady = new Promise(function(res) { resolveReady = res; });

  /* ── Invite / recovery detection ──────────────────────────────────────
     Supabase invite and reset links land here with type=invite|recovery in
     the URL fragment, then sign the user in and STRIP the fragment. Capture
     it at load, before supabase-js consumes it, so we know to ask for a
     password instead of dropping them straight into the shell. Without this
     an invited user never sets a password and is locked out the moment their
     session expires. */
  var linkType = (function () {
    var hash = (window.location.hash || '').replace(/^#/, '');
    var qs   = (window.location.search || '').replace(/^\?/, '');
    var m = (hash + '&' + qs).match(/(?:^|&)type=([a-z_]+)/);
    return m ? m[1] : null;
  })();
  var needsPassword = linkType === 'invite' || linkType === 'recovery' || linkType === 'signup';
  var passwordJustSet = false;   // set once the user saves one, so we stop intercepting

  /* ── Where the user was actually going ────────────────────────────────
     Every unauthenticated page bounces to /admin/, and until now that threw
     the destination away — a bookmarked /admin/member?id=…, a link from an
     email, or a session that lapsed mid-task all landed on the Dashboard with
     no explanation and no way back. Remember it and return to it after sign-in.

     Only same-origin /admin/ paths are ever stored or honoured: a value taken
     from the address bar and later handed to location.href is an open-redirect
     if it can be absolute, protocol-relative, or point outside the admin. */
  var DEST_KEY = 'veyago.admin.after-login';

  /* Lives on window.admin so it can be unit-tested and reused by anything else
     that turns a string into a navigation (see client.js). */
  function safeAdminPath(p) { return window.admin.safeAdminPath(p); }

  function rememberDestination() {
    try {
      /* The hash is part of the destination: /admin/member?id=…#welcome and
         #onboarding are different screens, and dropping it silently lands the
         user on the default tab. Validation runs on the path only — a hash
         cannot change the origin. */
      var here = safeAdminPath(window.location.pathname + window.location.search);
      if (here) sessionStorage.setItem(DEST_KEY, here + (window.location.hash || ''));
    } catch (e) { /* private mode — the redirect still works, just without memory */ }
  }

  function takeDestination() {
    try {
      var dest = sessionStorage.getItem(DEST_KEY);
      sessionStorage.removeItem(DEST_KEY);
      return safeAdminPath(dest);
    } catch (e) { return null; }
  }

  /* ── Shell toggle ─────────────────────────────────────────────────── */
  var shellShown = false;

  function showShell(session) {
    if (shellShown) return;

    /* If the user was bounced here from somewhere else, finish the journey they
       started rather than revealing a dashboard they did not ask for. Checked
       before shellShown flips so a reload cannot loop: takeDestination() removes
       the value as it reads it. */
    var dest = takeDestination();
    if (dest && window.location.pathname.indexOf('/admin/') === 0 &&
        dest !== window.location.pathname + window.location.search) {
      window.location.replace(dest);
      return;
    }

    shellShown = true;
    if (loginEl) loginEl.hidden = true;
    if (shellEl) shellEl.hidden = false;
    document.dispatchEvent(new CustomEvent('admin:authed'));
    resolveReady(session || null);
  }

  function showLogin() {
    if (shellEl) shellEl.hidden = true;
    if (loginEl) loginEl.hidden = false;
  }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ── Session lapse ────────────────────────────────────────────────────
     Shown when the session ends without the user asking. Deliberately not a
     redirect and not a modal: 17 of the 18 admin pages have no login card, and
     two of them are editors whose unsaved work only exists in the DOM. The user
     signs in through a second tab — Supabase shares the session through storage,
     so this page recovers in place and the draft is never touched. */
  var lapsedBar = null;

  function showSessionLapsed() {
    if (lapsedBar) return;

    /* The login card is right here, so just show it — but reset the card first.
       showLogin() only toggles the two containers; it does not choose a step or
       clear shellShown. Without both, a lapse on /admin/ leaves two dead ends:
       an MFA user gets the bare TOTP panel with no password fields, and because
       shellShown is still true, showShell() short-circuits so signing back in
       never re-reveals the dashboard. */
    if (loginEl) {
      shellShown = false;
      pendingFactorId = null;
      showStep(step1);
      showLogin();
      return;
    }

    lapsedBar = document.createElement('div');
    lapsedBar.className = 'adm-session-lapsed';
    lapsedBar.setAttribute('role', 'alert');

    var msg = document.createElement('span');
    msg.textContent = 'Your session has ended, so nothing can be saved right now. ' +
                      'Anything unsaved on this page is kept on this device.';

    var link = document.createElement('a');
    link.className = 'btn btn-sm';
    link.href = '/admin/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Sign in again →';

    lapsedBar.appendChild(msg);
    lapsedBar.appendChild(link);
    document.body.appendChild(lapsedBar);
  }

  function clearSessionLapsed() {
    if (!lapsedBar) return;
    lapsedBar.remove();
    lapsedBar = null;
  }

  /* ── TOTP step ────────────────────────────────────────────────────── */
  var pendingFactorId = null;

  function showTotpStep() {
    showStep(step2);
    var inp = document.getElementById('totp-code');
    if (inp) { inp.value = ''; setTimeout(function(){ inp.focus(); }, 50); }
  }

  async function verifyTotp(code) {
    setMsg(totpMsg, 'Verifying…');
    var btn = document.getElementById('totp-btn'); if (btn) btn.disabled = true;
    try {
      var factor = pendingFactorId ? { id: pendingFactorId } : await window.admin.mfaFactor();
      if (!factor) { setMsg(totpMsg, 'No MFA factor found.', 'err'); return; }
      var chal = await window.admin.mfaChallenge(factor.id);
      if (chal.error) { setMsg(totpMsg, chal.error.message, 'err'); rlFail(); return; }
      var verify = await window.admin.mfaVerify(factor.id, chal.data.id, code);
      if (verify.error) { rlFail(); setMsg(totpMsg, 'Wrong code — ' + verify.error.message, 'err'); return; }
      rlClear();
      setMsg(totpMsg, '');
      showShell(verify.data && verify.data.session);
    } catch(err) {
      setMsg(totpMsg, 'Error: ' + (err && err.message || String(err)), 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── onAuthStateChange — THE data-load trigger ────────────────────────
     Fires with SIGNED_IN (session recovery or fresh login) or TOKEN_REFRESHED
     only after Supabase has a valid, active JWT. Any queries inside admin:authed
     handlers will therefore run with a correct auth.uid(). */
  window.sb.auth.onAuthStateChange(async function(event, session) {
    /* A reset link fires PASSWORD_RECOVERY; an invite link just signs in with
       type=invite in the fragment. Both must land on "choose a password". */
    if (event === 'PASSWORD_RECOVERY' || (session && needsPassword && !passwordJustSet)) {
      if (stepSetPw) {
        showLogin();
        showStep(stepSetPw);
        var lede = document.getElementById('set-pw-lede');
        if (lede && linkType === 'invite') {
          lede.textContent = 'Welcome to Veyago. Set a password so you can sign back in later.';
        }
        var pw1 = document.getElementById('new-password');
        if (pw1) setTimeout(function () { pw1.focus(); }, 50);
        /* adminReady stays PENDING — see the MFA note below. */
      } else {
        /* A non-index page caught the link; send them to the login card. */
        window.location.href = '/admin/';
      }
      return;
    }

    /* A session can end without the user asking — a revoked token, a failed
       refresh after a laptop sleeps, or a sign-out in another tab. Before this
       branch existed, SIGNED_OUT fell through the filter below and nothing
       happened at all: the shell stayed rendered and every control stayed live,
       so the next Save failed with a raw JWT error and the only route back to a
       login form (/admin/) discarded whatever was on screen. Never navigate
       here — the page may be an editor holding unsaved work. */
    if (event === 'SIGNED_OUT') {
      if (!(window.admin && window.admin.signingOut)) showSessionLapsed();
      return;
    }

    /* INITIAL_SESSION fires on every page load once the stored session has been
       fully restored — without it, navigating between admin pages with a live
       session never reveals the shell (blank page). */
    if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED' && event !== 'INITIAL_SESSION') return;
    if (!session) return;
    /* Signing in again in another tab shares the session through storage, so a
       lapsed page can recover in place rather than being reloaded. */
    clearSessionLapsed();
    if (shellShown) return; // already showing — no re-dispatch needed

    // MFA check
    try {
      var level = await window.admin.mfaLevel();
      if (level && level.nextLevel === 'aal2' && level.currentLevel !== 'aal2') {
        if (loginEl) {
          /* Awaiting the TOTP code. Leave adminReady PENDING — a promise only
             resolves once, so settling it to null here would permanently
             poison it and every page's data load (which gates on it) would
             silently no-op after the code is verified. verifyTotp → showShell
             resolves it with the real session instead. */
          showLogin();
          var factor = await window.admin.mfaFactor();
          pendingFactorId = factor ? factor.id : null;
          showTotpStep();
        } else {
          /* No login form on this page — navigating away, so settling null is
             safe (nothing here will render). MFA is still outstanding; keep the
             destination so verifying the code lands back here. */
          rememberDestination();
          window.location.href = '/admin/';
          resolveReady(null);
        }
        return;
      }
    } catch(e) {
      // MFA check failed — don't block the session
      console.warn('[auth] mfaLevel check failed:', e.message || e);
    }

    showShell(session);
  });

  /* ── Quick redirect for pages with no login form ─────────────────────
     If there's no session at all, we can't wait for onAuthStateChange (it
     won't fire). Redirect immediately. */
  window.admin.session().then(function(s) {
    if (!s && !shellShown) {
      if (loginEl) { showLogin(); resolveReady(null); }
      /* The common case: a bookmarked or emailed deep link opened without a
         session. Remember it so signing in finishes the trip. */
      else { rememberDestination(); window.location.href = '/admin/'; resolveReady(null); }
    }
  }).catch(function() {
    if (!shellShown && !loginEl) { rememberDestination(); window.location.href = '/admin/'; }
  });

  /* ── Login form (index.html only) ────────────────────────────────── */
  var form = document.getElementById('login-form');
  if (form) {
    var loginBtn = document.getElementById('login-btn');
    if (!window.admin.configured) {
      showLogin();
      setMsg(loginMsg, 'Supabase not configured — edit admin/supabase-config.js.', 'err');
    }

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      if (!rlCheck()) return;
      setMsg(loginMsg, '');
      if (loginBtn) loginBtn.disabled = true;

      var email = (document.getElementById('email').value || '').trim();
      var pw    = document.getElementById('password').value || '';
      if (!email || !pw) { setMsg(loginMsg, 'Enter your email and password.', 'err'); if (loginBtn) loginBtn.disabled = false; return; }

      try {
        var res = await window.admin.signIn(email, pw);
        if (res.error) { rlFail(); setMsg(loginMsg, res.error.message, 'err'); return; }
        // onAuthStateChange fires automatically after signIn — it will call showShell()
        // We just need to handle the MFA case here
        try {
          var level = await window.admin.mfaLevel();
          if (level && level.nextLevel === 'aal2' && level.currentLevel !== 'aal2') {
            var factor = await window.admin.mfaFactor();
            pendingFactorId = factor ? factor.id : null;
            showTotpStep();
            return;
          }
        } catch(e) { /* proceed */ }
        // Non-MFA: showShell will be called by onAuthStateChange
        rlClear();
      } catch(err) {
        setMsg(loginMsg, 'Unexpected error: ' + (err && err.message || err), 'err');
      } finally {
        if (loginBtn) loginBtn.disabled = false;
      }
    });
  }

  /* ── Set password (invite / recovery) ─────────────────────────────── */
  var setPwForm = document.getElementById('set-password-form');
  if (setPwForm) {
    setPwForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pw1 = document.getElementById('new-password').value || '';
      var pw2 = document.getElementById('new-password-2').value || '';
      var btn = document.getElementById('set-pw-btn');

      if (pw1.length < 8) { setMsg(setPwMsg, 'Use at least 8 characters.', 'err'); return; }
      if (pw1 !== pw2)    { setMsg(setPwMsg, 'Those two passwords don\'t match.', 'err'); return; }

      btn.disabled = true;
      setMsg(setPwMsg, 'Saving…');
      try {
        var res = await window.sb.auth.updateUser({ password: pw1 });
        if (res.error) { setMsg(setPwMsg, res.error.message, 'err'); return; }

        passwordJustSet = true;
        needsPassword = false;
        setMsg(setPwMsg, '');

        /* Mark an invited employee active now that they've completed setup —
           otherwise "Invites pending" never clears. Narrow SECURITY DEFINER
           RPC, because employees is manager-write-only by design.
           Best-effort: never block sign-in on it. */
        try { await window.sb.rpc('activate_self'); } catch (err) { /* non-fatal */ }

        var sess = await window.admin.session();
        showShell(sess);
      } catch (err) {
        setMsg(setPwMsg, 'Could not save: ' + (err && err.message || err), 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ── Forgot password ──────────────────────────────────────────────── */
  var forgotBtn = document.getElementById('forgot-btn');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', function () {
      var typed = (document.getElementById('email').value || '').trim();
      if (typed) document.getElementById('forgot-email').value = typed;
      showStep(stepForgot);
      setMsg(forgotMsg, '');
      setTimeout(function () { document.getElementById('forgot-email').focus(); }, 50);
    });
  }

  var forgotBack = document.getElementById('forgot-back');
  if (forgotBack) {
    forgotBack.addEventListener('click', function () {
      showStep(step1);
      setMsg(forgotMsg, '');
    });
  }

  var forgotForm = document.getElementById('forgot-form');
  if (forgotForm) {
    forgotForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (document.getElementById('forgot-email').value || '').trim();
      var btn = document.getElementById('forgot-send');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMsg(forgotMsg, 'Enter a valid email address.', 'err'); return;
      }
      btn.disabled = true;
      setMsg(forgotMsg, 'Sending…');
      try {
        /* Goes through our own Edge Function rather than
           sb.auth.resetPasswordForEmail, so the mail is branded, rate limited,
           and logged. The function always answers the same way, so nothing here
           can confirm who has an account. */
        var res = await window.sb.functions.invoke('request-password-reset', {
          body: { email: email }
        });
        if (res.error) console.warn('[auth] reset error:', res.error.message);
        setMsg(forgotMsg, 'If that address has an account, a reset link is on its way. Check your inbox.', 'ok');
      } catch (err) {
        setMsg(forgotMsg, 'Could not send: ' + (err && err.message || err), 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* TOTP form controls */
  var totpBtn = document.getElementById('totp-btn');
  if (totpBtn) totpBtn.addEventListener('click', function() {
    var code = (document.getElementById('totp-code').value || '').replace(/\D/g, '');
    if (code.length !== 6) { setMsg(totpMsg, 'Enter the full 6-digit code.', 'err'); return; }
    verifyTotp(code);
  });

  var totpInput = document.getElementById('totp-code');
  if (totpInput) {
    totpInput.addEventListener('input', function() {
      var val = totpInput.value.replace(/\D/g, '').slice(0, 6);
      totpInput.value = val;
      if (val.length === 6) verifyTotp(val);
    });
    totpInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { var c = totpInput.value.replace(/\D/g,''); if (c.length === 6) verifyTotp(c); }
    });
  }

  var totpBack = document.getElementById('totp-back');
  if (totpBack) totpBack.addEventListener('click', function() {
    pendingFactorId = null;
    showStep(step1);
    setMsg(totpMsg, '');
  });

  /* Sign out (sidebar button, wired by nav.js) is handled via window.admin.signOut() */

})();
