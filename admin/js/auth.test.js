/* Tests for admin/js/auth.js — the sign-in gate.

   auth.js had no coverage at all, which is how a two-place MFA gate survived:
   the decision "does this person still owe a second factor" was made ONCE in
   the login form's submit handler and AGAIN in onAuthStateChange, and the two
   race. Whichever loses, loses silently.

   The fake below models supabase-js's real shape, including the part that
   makes the race possible: getAuthenticatorAssuranceLevel() derives nextLevel
   from `session.user.factors`, and that array is not reliably populated on the
   session object the moment signInWithPassword resolves — it is there after a
   reload, when the session has been recovered and the user re-fetched. So the
   two call sites can legitimately get DIFFERENT answers milliseconds apart,
   which is exactly the reported bug: sign in, no 2FA prompt; reload, 2FA
   prompt. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function bodyOf(html) {
  return html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
}

/* opts:
     mfaEnrolled        the account really has a verified TOTP factor
     aalVisibleAt       when getAuthenticatorAssuranceLevel() can SEE it:
                          'always'  — both call sites agree (the easy case)
                          'reload'  — only once the session is recovered, which
                                      is the reported production behaviour
     aalThrows          the AAL check errors (network blip, 500) */
function harness(opts = {}) {
  const dom = new JSDOM('<!doctype html><body>' + bodyOf(HTML) + '</body>', {
    url: 'https://veyago.cloud/admin/',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  const session = { user: { id: 'u1', email: 'a@veyago.cloud' }, access_token: 'jwt' };
  let listener = null;
  let recovered = opts.aalVisibleAt === 'always';   // 'reload' starts hidden

  function aalSees() {
    return opts.mfaEnrolled && recovered;
  }

  window.admin = {
    configured: true,
    signingOut: false,
    safeAdminPath: (p) => {
      if (!p || typeof p !== 'string') return null;
      if (p.charAt(0) !== '/' || p.charAt(1) === '/' || p.indexOf('/admin/') !== 0) return null;
      const file = p.split('?')[0].split('#')[0];
      if (file === '/admin/' || file === '/admin/index' || file === '/admin/index.html') return null;
      return p;
    },
    session: async () => (opts.startSignedIn ? session : null),
    signIn: async () => {
      /* supabase-js notifies subscribers as part of signing in. Deliberately
         fired BEFORE this promise resolves — that is the ordering that makes
         the two gates race. */
      if (listener) await listener('SIGNED_IN', session);
      return { data: { session }, error: null };
    },
    mfaLevel: async () => {
      if (opts.aalThrows) throw new Error('AAL check failed');
      /* nextLevel is the unreliable half — it tracks whether the session's
         user object happens to carry its factors yet. currentLevel comes from
         the JWT's own aal claim and is always honest. */
      return aalSees()
        ? { currentLevel: 'aal1', nextLevel: 'aal2' }
        : { currentLevel: 'aal1', nextLevel: 'aal1' };
    },
    mfaFactor: async () => (opts.mfaEnrolled ? { id: 'f1', status: 'verified' } : null),
    /* Asks the server, so it answers the same before and after a reload —
       which is the point of routing the gate through it. */
    mfaVerifiedFactor: async () => {
      if (opts.factorsThrow) throw new Error('Could not check two-factor status: network');
      return opts.mfaEnrolled ? { id: 'f1', status: 'verified' } : null;
    },
    mfaChallenge: async () => ({ data: { id: 'c1' }, error: null }),
    mfaVerify: async () => ({ data: { session }, error: null }),
  };
  window.sb = {
    auth: { onAuthStateChange: (cb) => { listener = cb; return { data: { subscription: {} } }; } },
    functions: { invoke: async () => ({ error: null }) },
    rpc: async () => ({}),
  };

  vm.runInContext(SRC, dom.getInternalVMContext());

  const $ = (id) => window.document.getElementById(id);
  return {
    window, $,
    settle: async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); },
    /* What the user is actually looking at. */
    view: () => {
      if (!$('adm-shell').hidden) return 'shell';
      if ($('adm-login').hidden) return 'nothing';
      if (!$('step-totp').hidden) return 'totp';
      if (!$('step-password').hidden) return 'password';
      if (!$('step-set-password').hidden) return 'set-password';
      if (!$('step-forgot').hidden) return 'forgot';
      return 'login-card-empty';
    },
    signIn: async () => {
      $('email').value = 'a@veyago.cloud';
      $('password').value = 'pw';
      $('login-form').dispatchEvent(new window.MouseEvent('submit', { bubbles: true, cancelable: true }));
    },
    /* Simulate the page reload the user currently has to do: the session is
       recovered, the user object now carries its factors, INITIAL_SESSION
       fires. */
    reload: async () => { recovered = true; if (listener) await listener('INITIAL_SESSION', session); },
    tokenRefresh: async () => { if (listener) await listener('TOKEN_REFRESHED', session); },
  };
}

/* ── The reported bug ─────────────────────────────────────────────────── */

test('an MFA account is asked for its code on sign-in, not only after a reload', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'reload' });
  await h.settle();
  assert.equal(h.view(), 'password', 'starts on the password step');

  await h.signIn();
  await h.settle();

  assert.equal(h.view(), 'totp',
    'the 2FA step must appear on sign-in — this is the reported bug: it only showed after a reload');
});

/* The same bug seen from the security side. If the gate can be missed, what it
   lets through is the dashboard. */
test('the shell is never revealed while a second factor is still owed', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'reload' });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.notEqual(h.view(), 'shell',
    'signing in with a password alone must not reveal the admin');
});

test('when both checks agree, sign-in still lands on the code step', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'always' });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.equal(h.view(), 'totp');
});

/* ── Failing closed ───────────────────────────────────────────────────── */

/* The old code caught an AAL error and fell through to showShell() with the
   comment "don't block the session". For a security gate that is backwards:
   an unanswered "do they owe a second factor?" is not a no. */
test('an MFA check that errors does not fall through into the admin', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'always', aalThrows: true });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.notEqual(h.view(), 'shell', 'a failed check must not open the door');
});

test('a factor lookup that errors also fails closed, and says why', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'always', factorsThrow: true });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.notEqual(h.view(), 'shell');
  assert.match(h.$('login-msg').textContent, /two-factor/i,
    'silence would look like a broken button; say what happened');
});

/* Backing out of the code step returns to the password form, but it does NOT
   settle the second factor — anything that would otherwise reveal the shell
   must still be refused. */
test('backing out of the code step does not leave a hole behind it', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'reload' });
  await h.settle();
  await h.signIn();
  await h.settle();

  h.$('totp-back').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  await h.settle();
  assert.equal(h.view(), 'password');

  /* A token refresh arriving on its own must not walk into the admin. */
  await h.tokenRefresh();
  await h.settle();
  assert.notEqual(h.view(), 'shell', 'the factor is still owed');
});

/* ── The ordinary path still works ────────────────────────────────────── */

test('an account without MFA goes straight into the admin', async () => {
  const h = harness({ mfaEnrolled: false, aalVisibleAt: 'always' });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.equal(h.view(), 'shell');
});

test('a returning session with no MFA reveals the shell on load', async () => {
  const h = harness({ mfaEnrolled: false, aalVisibleAt: 'always', startSignedIn: true });
  await h.settle();
  await h.reload();
  await h.settle();
  assert.equal(h.view(), 'shell');
});

test('a returning MFA session is asked for its code, not shown the admin', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'always', startSignedIn: true });
  await h.settle();
  await h.reload();
  await h.settle();
  assert.equal(h.view(), 'totp');
});

/* ── Completing the challenge ─────────────────────────────────────────── */

test('a correct code opens the admin', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'reload' });
  await h.settle();
  await h.signIn();
  await h.settle();
  assert.equal(h.view(), 'totp');

  h.$('totp-code').value = '123456';
  h.$('totp-code').dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await h.settle();

  assert.equal(h.view(), 'shell', 'verifying the code is what lets you in');
});

test('backing out of the code step returns to the password form', async () => {
  const h = harness({ mfaEnrolled: true, aalVisibleAt: 'reload' });
  await h.settle();
  await h.signIn();
  await h.settle();

  h.$('totp-back').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  await h.settle();
  assert.equal(h.view(), 'password');
});
