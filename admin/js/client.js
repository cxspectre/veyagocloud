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
