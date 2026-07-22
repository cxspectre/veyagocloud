/* Initialise the Supabase client and expose auth + MFA + storage helpers. */
(function () {
  'use strict';

  var cfg = window.VEYAGO_SUPABASE || {};
  var configured = cfg.url && cfg.url.indexOf('YOUR-PROJECT') === -1
                && cfg.anonKey && cfg.anonKey.indexOf('YOUR-ANON') === -1;

  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase client not loaded — check admin/vendor/supabase.js.');
    return;
  }
  if (!configured) {
    console.warn('Supabase not configured — edit admin/supabase-config.js.');
  }

  var sb = window.supabase.createClient(cfg.url || 'https://placeholder.supabase.co', cfg.anonKey || 'placeholder');
  window.sb = sb;

  window.admin = {
    configured: configured,

    async session() {
      var res = await sb.auth.getSession();
      return (res.data && res.data.session) || null;
    },

    async requireSession(loginUrl) {
      var s = await this.session();
      if (!s) { window.location.href = loginUrl || '/admin/'; return null; }
      return s;
    },

    signIn(email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password });
    },

    async signOut() {
      try { sessionStorage.removeItem('veyago.admin.role'); } catch (e) {}
      await sb.auth.signOut();
      window.location.href = '/admin/';
    },

    /* ── MFA (TOTP) helpers ──────────────────────────────────────────── */

    /* Returns { currentLevel, nextLevel } — if nextLevel === 'aal2' the user
       has enrolled TOTP and must complete a challenge before writing. */
    async mfaLevel() {
      var res = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      return (res.data) || { currentLevel: 'aal1', nextLevel: 'aal1' };
    },

    /* Returns the first enrolled TOTP factor, or null.
       Handles both { data: { totp: [] } } and { data: { all: [] } } response shapes
       across different Supabase JS v2 minor versions. */
    async mfaFactor() {
      var res = await sb.auth.mfa.listFactors();
      if (res.error) { console.warn('[admin] mfa.listFactors error:', res.error); return null; }
      var d = res.data || {};
      var list = Array.isArray(d.totp) ? d.totp
               : Array.isArray(d.all)  ? d.all.filter(function(f){ return f.factor_type === 'totp' || f.factorType === 'totp'; })
               : [];
      return list.length ? list[0] : null;
    },

    /* Start TOTP enrolment — returns { id, totp: { qr_code, secret } }. */
    async mfaEnroll() {
      return sb.auth.mfa.enroll({ factorType: 'totp' });
    },

    /* Issue a challenge against a factor — returns challenge id. */
    async mfaChallenge(factorId) {
      return sb.auth.mfa.challenge({ factorId: factorId });
    },

    /* Verify a challenge with a 6-digit code. */
    async mfaVerify(factorId, challengeId, code) {
      return sb.auth.mfa.verify({
        factorId: factorId,
        challengeId: challengeId,
        code: code.replace(/\s/g, '')
      });
    },

    /* Remove a TOTP factor (disables MFA). */
    async mfaUnenroll(factorId) {
      return sb.auth.mfa.unenroll({ factorId: factorId });
    },

    /* ── Toasts ──────────────────────────────────────────────────────── */
    /* Small bottom-right confirmation toasts for successful actions.
       Errors stay inline next to the form that caused them. */
    toast(text, kind) {
      var wrap = document.querySelector('.toast-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'toast-wrap';
        document.body.appendChild(wrap);
      }
      var el = document.createElement('div');
      el.className = 'toast' + (kind === 'err' ? ' err' : '');
      el.setAttribute('role', 'status');
      el.innerHTML = (kind === 'err'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="15" height="15"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2.2" stroke-linecap="round" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>');
      el.appendChild(document.createTextNode(text));
      wrap.appendChild(el);
      requestAnimationFrame(function () { el.classList.add('show'); });
      setTimeout(function () {
        el.classList.remove('show');
        setTimeout(function () { el.remove(); }, 300);
      }, 3200);
    },

    /* ── Storage ─────────────────────────────────────────────────────── */
    async upload(bucket, file, prefix) {
      var safe  = (file.name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-');
      var stamp = Date.now().toString(36);
      var path  = (prefix ? prefix.replace(/\/+$/, '') + '/' : '') + stamp + '-' + safe;
      var up    = await sb.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
      if (up.error) throw up.error;
      return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    }
  };
})();
