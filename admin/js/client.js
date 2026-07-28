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

    /* Validate a string before it is ever handed to location.href.

       Anything derived from the address bar, a query string or storage is
       attacker-influenced: "//evil.com" and "https://evil.com" are both valid
       values for location.href and both leave the site. Only a rooted,
       same-origin path inside /admin/ is allowed through, and the login page
       itself is rejected because "go back to where you were" must never mean
       "go back to the login screen". Returns the path, or null. */
    safeAdminPath(p) {
      if (!p || typeof p !== 'string') return null;
      /* Rooted, and not protocol-relative ("//host") or a backslash variant
         that some browsers normalise to one. */
      if (p.charAt(0) !== '/') return null;
      if (p.charAt(1) === '/' || p.charAt(1) === '\\') return null;
      if (p.indexOf('\\') !== -1) return null;
      if (p.indexOf('/admin/') !== 0) return null;
      /* A hash is part of the destination (…#welcome), never part of the origin,
         so it rides along untouched — only the path decides safety. */
      var file = p.split('?')[0].split('#')[0];
      if (file === '/admin/' || file === '/admin/index' || file === '/admin/index.html') return null;
      return p;
    },

    /* The one place a string becomes a navigation. Validating here rather than
       at each call site means a new caller cannot forget to. Returns whether it
       navigated; refuses rather than guessing when the path is not ours. */
    navigate(path) {
      var safe = this.safeAdminPath(path);
      if (!safe) return false;
      window.location.href = safe;
      return true;
    },

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

    /* signingOut tells auth.js this SIGNED_OUT was asked for, so it shows the
       login card rather than the "your session has ended" banner. */
    signingOut: false,

    async signOut() {
      this.signingOut = true;
      /* The invite outcome can hold a single-use sign-in link, and the invite
         draft holds a half-written record. Signing out is the one moment the
         app knows for certain that neither should survive. */
      try {
        sessionStorage.removeItem('veyago.admin.role');
        sessionStorage.removeItem('veyago.admin.invite-outcome');
        sessionStorage.removeItem('veyago.admin.invite-draft');
      } catch (e) {}
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

    /* ── Stat cards ──────────────────────────────────────────────────── */

    /* The one KPI-card component for every admin page, so the row never looks
       like a different widget depending on which page you're on.
       cards: [{ n, label, color, icon, n2, n2Color, nColor, href }] — icon is
       the inner markup of a 24x24 stroke SVG; href makes the card a link. */
    statCards(wrap, cards) {
      if (!wrap) return;
      wrap.innerHTML = cards.map(function (c) {
        var tag = c.href ? 'a' : 'div';
        /* Shrink only when the figure is actually long enough to risk crowding
           a stat card — NOT "contains a currency symbol or comma", which used
           to fire on every formatted dollar amount regardless of length and
           meant Finance's headline numbers never reached the card's real
           2rem hero size. Punctuation is stripped before counting so
           "$1,234,567.89" is judged on its 9 significant digits, not its
           13 characters. */
        var small = typeof c.n === 'string' && String(c.n).replace(/[,.$]/g, '').length > 7;
        return '<' + tag + ' class="dash-stat"' +
            (c.href ? ' href="' + c.href + '"' : '') +
            ' style="--stat-color:' + (c.color || '#0071e3') + (c.href ? '' : ';cursor:default') + '">' +
          (c.icon
            ? '<div class="dash-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="' +
              (c.color || '#0071e3') +
              '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + c.icon + '</svg></div>'
            : '') +
          '<div class="dash-stat-n"' + ((small || c.nColor) ? ' style="' + (small ? 'font-size:1.45rem;' : '') + (c.nColor ? 'color:' + c.nColor : '') + '"' : '') + '>' + c.n + '</div>' +
          (c.n2 ? '<div class="dash-stat-n2"' + (c.n2Color ? ' style="color:' + c.n2Color + '"' : '') + '>' + c.n2 + '</div>' : '') +
          '<div class="dash-stat-label">' + c.label + '</div>' +
        '</' + tag + '>';
      }).join('');
    },

    /* ── Dates ───────────────────────────────────────────────────────── */

    /* Local calendar date as YYYY-MM-DD, optionally offset by whole days.
       Never use toISOString() for this: it converts to UTC, so a user west of
       UTC in the evening gets tomorrow's date (their due-today tasks read as
       overdue) and a user east of UTC late at night gets yesterday's. All the
       date columns compared against this (due_date, posted_at, due_on) are
       plain calendar dates, so the comparison must be in local terms. */
    localDate(offsetDays) {
      var d = new Date();
      if (offsetDays) d.setDate(d.getDate() + offsetDays);
      return d.getFullYear() + '-' +
             String(d.getMonth() + 1).padStart(2, '0') + '-' +
             String(d.getDate()).padStart(2, '0');
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
