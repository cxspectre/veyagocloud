/* Account page: your own profile (read-only), password change, and TOTP setup.
   Everyone with a role can reach this — it is the one page with no role gate. */
(function () {
  'use strict';

  var msg = document.getElementById('msg');
  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  var ROLE_COLOR = { owner: '#0071e3', admin: '#5856d6', assistant: '#ff9500', employee: '#86868b' };
  var ROLE_BADGE = { owner: 'badge-role-owner', admin: 'badge-role-admin', assistant: 'badge-role-assistant', employee: 'badge-role-employee' };

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  async function load() {
    var session = await window.admin.session();
    var r = await window.adminRoles.resolve();
    var emp = r.employee;

    var name = (emp && emp.full_name) || (session && session.user.email) || 'Signed in';
    document.getElementById('acct-name').textContent = name;
    document.getElementById('acct-email').textContent = (emp && emp.email) || (session && session.user.email) || '';

    var av = document.getElementById('acct-avatar');
    av.textContent = initials(name);
    av.style.background = ROLE_COLOR[r.role] || '#86868b';

    var badge = document.getElementById('acct-role');
    badge.textContent = r.role || 'no role';
    badge.className = 'badge ' + (ROLE_BADGE[r.role] || 'badge-neutral');

    document.getElementById('acct-title').value = (emp && emp.title) || '';
    document.getElementById('acct-phone').value = (emp && emp.phone) || '';

    loadMfaStatus();
  }

  /* ── Change password ──────────────────────────────────────────────── */
  var pwMsg = document.getElementById('pw-msg');
  document.getElementById('pw-save').addEventListener('click', async function () {
    var a = document.getElementById('pw-new').value || '';
    var b = document.getElementById('pw-new-2').value || '';
    if (a.length < 8) { pwMsg.textContent = 'Use at least 8 characters.'; pwMsg.className = 'msg err'; return; }
    if (a !== b) { pwMsg.textContent = 'Those two passwords don\'t match.'; pwMsg.className = 'msg err'; return; }
    var btn = this; btn.disabled = true;
    pwMsg.textContent = 'Saving…'; pwMsg.className = 'msg';
    try {
      var res = await window.sb.auth.updateUser({ password: a });
      if (res.error) { pwMsg.textContent = res.error.message; pwMsg.className = 'msg err'; return; }
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-new-2').value = '';
      pwMsg.textContent = ''; pwMsg.className = 'msg';
      window.admin.toast('Password changed');
    } finally { btn.disabled = false; }
  });

  /* ── MFA enrollment ───────────────────────────────────────────────── */
  var mfaMsg      = document.getElementById('mfa-msg');
  var mfaBadge    = document.getElementById('mfa-badge');
  var mfaStart    = document.getElementById('mfa-start');
  var mfaSetup    = document.getElementById('mfa-setup');
  var mfaEnrolled = document.getElementById('mfa-enrolled');
  var enrolledFactorId = null;
  var pendingFactorId  = null;

  function setMfaMsg(t, k) {
    if (!mfaMsg) return;
    mfaMsg.textContent = t || '';
    mfaMsg.className = 'msg' + (k ? ' ' + k : '');
  }

  /* Render a QR code into the wrap div. Handles raw SVG, data URIs, and
     PNG base64 blobs — Supabase returns different formats across versions. */
  function renderQr(wrap, qrCode) {
    if (!wrap || !qrCode) {
      if (wrap) wrap.innerHTML = '<p style="color:var(--muted);font-size:.85rem">No QR code returned — use the manual code below.</p>';
      return;
    }
    var s = String(qrCode);
    if (s.startsWith('<svg') || s.startsWith('<SVG')) {
      wrap.innerHTML = s;
      var svg = wrap.querySelector('svg');
      if (svg) { svg.setAttribute('width', '180'); svg.setAttribute('height', '180'); }
    } else if (s.startsWith('data:') || s.startsWith('iVBOR') || s.startsWith('/9j/')) {
      // data URI or raw base64 PNG/JPEG
      var src = s.startsWith('data:') ? s : 'data:image/png;base64,' + s;
      wrap.innerHTML = '<img src="' + src + '" alt="Scan this QR code" width="180" height="180" style="border-radius:8px" />';
    } else {
      // Unknown — try as a URL
      wrap.innerHTML = '<img src="' + s + '" alt="Scan this QR code" width="180" height="180" style="border-radius:8px" />';
    }
  }

  async function loadMfaStatus() {
    if (!window.admin || !window.admin.mfaFactor) return;
    try {
      var factor = await window.admin.mfaFactor();
      if (factor) {
        enrolledFactorId = factor.id;
        if (mfaBadge) { mfaBadge.textContent = 'Enabled'; mfaBadge.className = 'badge badge-published'; }
        if (mfaStart)    mfaStart.hidden = true;
        if (mfaSetup)    mfaSetup.hidden = true;
        if (mfaEnrolled) mfaEnrolled.hidden = false;
      } else {
        enrolledFactorId = null;
        if (mfaBadge) { mfaBadge.textContent = 'Not set up'; mfaBadge.className = 'badge badge-draft'; }
        if (mfaStart)    mfaStart.hidden = false;
        if (mfaSetup)    mfaSetup.hidden = true;
        if (mfaEnrolled) mfaEnrolled.hidden = true;
      }
    } catch (err) {
      console.error('[admin] loadMfaStatus error:', err);
      if (mfaBadge) { mfaBadge.textContent = 'Error'; mfaBadge.className = 'badge badge-draft'; }
      setMfaMsg('Could not check MFA status: ' + (err && err.message || String(err)), 'err');
    }
  }

  /* Start enrollment — fetch QR code and secret from Supabase */
  var enrollBtn = document.getElementById('mfa-enroll-btn');
  if (enrollBtn) {
    enrollBtn.addEventListener('click', async function() {
      setMfaMsg('Generating QR code…');
      enrollBtn.disabled = true;
      try {
        var res = await window.admin.mfaEnroll();
        if (res.error) {
          console.error('[admin] mfa.enroll error:', res.error);
          setMfaMsg(res.error.message, 'err');
          return;
        }
        if (!res.data) {
          setMfaMsg('No data returned from Supabase — open the browser console (F12) for details.', 'err');
          console.error('[admin] mfa.enroll: res.data is null. Full response:', res);
          return;
        }

        pendingFactorId = res.data.id;
        console.log('[admin] mfa.enroll success, factorId:', pendingFactorId, 'data keys:', Object.keys(res.data));

        /* Extract QR code + secret — handle both { totp: { qr_code, secret } }
           and flat { qr_code, secret } response shapes. */
        var totp   = res.data.totp || res.data;
        var qrCode = totp.qr_code || totp.qrCode || null;
        var secret = totp.secret || null;

        var qrWrap  = document.getElementById('mfa-qr-wrap');
        var secretEl = document.getElementById('mfa-secret');
        renderQr(qrWrap, qrCode);
        if (secretEl) { secretEl.textContent = secret || 'Not available'; }

        if (mfaStart) mfaStart.hidden = true;
        if (mfaSetup) mfaSetup.hidden = false;
        setMfaMsg('');
        var codeInput = document.getElementById('mfa-code');
        if (codeInput) { codeInput.value = ''; setTimeout(function(){ codeInput.focus(); }, 50); }

      } catch (err) {
        console.error('[admin] mfaEnroll exception:', err);
        setMfaMsg('Error: ' + (err && err.message || String(err)), 'err');
      } finally {
        enrollBtn.disabled = false;
      }
    });
  }

  /* Show / hide manual secret */
  var showSecretBtn = document.getElementById('mfa-show-secret');
  if (showSecretBtn) {
    showSecretBtn.addEventListener('click', function() {
      var el = document.getElementById('mfa-secret');
      if (el) el.hidden = !el.hidden;
      showSecretBtn.textContent = (el && !el.hidden) ? 'Hide code' : 'Show manual code';
    });
  }

  /* Confirm enrollment with 6-digit code */
  var confirmBtn = document.getElementById('mfa-confirm-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async function() {
      var code = (document.getElementById('mfa-code').value || '').replace(/\D/g, '');
      if (code.length !== 6) { setMfaMsg('Enter the full 6-digit code from your authenticator app.', 'err'); return; }
      if (!pendingFactorId) { setMfaMsg('Setup lost — click "Set up authenticator app" to start again.', 'err'); return; }
      confirmBtn.disabled = true;
      setMfaMsg('Verifying…');
      try {
        var chal = await window.admin.mfaChallenge(pendingFactorId);
        if (chal.error) { setMfaMsg(chal.error.message, 'err'); return; }

        var verify = await window.admin.mfaVerify(pendingFactorId, chal.data.id, code);
        if (verify.error) {
          setMfaMsg('Wrong code — double-check your authenticator app and try again.', 'err');
          return;
        }

        setMfaMsg('Two-factor authentication is now active. Every login will require your code.', 'ok');
        pendingFactorId = null;
        await loadMfaStatus();
      } catch (err) {
        console.error('[admin] mfaVerify exception:', err);
        setMfaMsg('Error: ' + (err && err.message || String(err)), 'err');
      } finally {
        confirmBtn.disabled = false;
      }
    });
  }

  /* Auto-submit when all 6 digits typed */
  var mfaCodeInput = document.getElementById('mfa-code');
  if (mfaCodeInput) {
    mfaCodeInput.addEventListener('input', function() {
      var val = mfaCodeInput.value.replace(/\D/g, '').slice(0, 6);
      mfaCodeInput.value = val;
      if (val.length === 6 && confirmBtn && !confirmBtn.disabled) confirmBtn.click();
    });
  }

  /* Cancel — clean up the unverified pending factor */
  var cancelBtn = document.getElementById('mfa-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async function() {
      if (pendingFactorId) {
        try { await window.admin.mfaUnenroll(pendingFactorId); } catch (e) {}
        pendingFactorId = null;
      }
      if (mfaSetup) mfaSetup.hidden = true;
      if (mfaStart) mfaStart.hidden = false;
      setMfaMsg('');
    });
  }

  /* Disable MFA */
  var disableBtn = document.getElementById('mfa-disable-btn');
  if (disableBtn) {
    disableBtn.addEventListener('click', async function() {
      if (!enrolledFactorId) return;
      if (!confirm('Disable two-factor authentication?\n\nYour account will only be protected by your password until you re-enable it.')) return;
      disableBtn.disabled = true;
      try {
        var res = await window.admin.mfaUnenroll(enrolledFactorId);
        if (res.error) { setMfaMsg(res.error.message, 'err'); return; }
        setMfaMsg('Two-factor authentication disabled.', 'ok');
        enrolledFactorId = null;
        await loadMfaStatus();
      } catch (err) {
        setMfaMsg('Error: ' + (err && err.message || String(err)), 'err');
      } finally {
        disableBtn.disabled = false;
      }
    });
  }

  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */

  window.adminReady.then(function (s) { if (s) load(); });
})();
