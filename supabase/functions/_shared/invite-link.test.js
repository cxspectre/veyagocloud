/* Tests for _shared/invite-link.ts.

   The defect these exist for shipped to production and broke every first-time
   invite the product ever sent, and no test could have caught it, because the
   logic lived inline in a Deno edge function with a live Supabase client wired
   through it. Nothing was wrong with the transport. What was wrong was the
   ORDER of two calls. So the order now lives in a module that takes its client
   as an argument, and these tests assert the sequence itself.

   The fake below returns exactly what GoTrue returns, including the literal
   422/email_exists body quoted from internal/api/errors.go. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/* The module under test is Deno source. package.json declares "type":
   "commonjs", which switches OFF Node's ESM syntax detection, so importing the
   .ts directly fails on its first `export`. Strip the annotations and evaluate
   the result as a module instead — that keeps the shipped file byte-identical
   to what the edge runtime loads, rather than renaming it to suit the test
   runner and gambling on the deploy bundler. It imports nothing, so there are
   no specifiers to resolve. */
let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'invite-link.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* GoTrue's DuplicateEmailMsg, verbatim (internal/api/errors.go:19). */
const TAKEN = {
  code: 'email_exists',
  status: 422,
  message: 'A user with this email address has already been registered',
};

const NOT_FOUND = { code: 'user_not_found', status: 404, message: 'User with this email not found' };

/* A fake with STATE, so it fails the way the real server fails.
   Account state is 'none' | 'unconfirmed' | 'confirmed', and every branch below
   is transcribed from internal/api/mail.go rather than from what this fix
   happens to do. createUser is modelled faithfully and on purpose: the original
   defect was calling it first, and because email_confirm makes the account
   confirmed, the invite that followed was refused. A mock that merely replayed
   canned responses could not have shown that. */
function fakeAdmin(initial) {
  let state = initial;
  const calls = [];
  const link = (kind, id) => ({
    data: { properties: { action_link: `https://veyago.cloud/${kind}#token` }, user: { id } },
    error: null,
  });
  return {
    calls,
    names: () => calls.map((c) => c.call + (c.type ? ':' + c.type : '')),
    auth: {
      admin: {
        createUser: async (p) => {
          calls.push({ call: 'createUser', ...p });
          if (state !== 'none') return { data: { user: null }, error: TAKEN };
          state = p.email_confirm ? 'confirmed' : 'unconfirmed';
          return { data: { user: { id: 'u-new' } }, error: null };
        },
        generateLink: async (p) => {
          calls.push({ call: 'generateLink', ...p });
          if (p.type === 'invite') {
            /* mail.go: refused only when the account is already CONFIRMED. */
            if (state === 'confirmed') return { data: null, error: TAKEN };
            /* Otherwise it creates the account, or re-issues for a pending one. */
            state = 'unconfirmed';
            return link('invite', 'u-new');
          }
          if (p.type === 'recovery') {
            if (state === 'none') return { data: null, error: NOT_FOUND };
            return link('recover', 'u-old');
          }
          throw new Error('unexpected link type ' + p.type);
        },
      },
    },
  };
}

const OPTS = { email: 'new@veyago.cloud', fullName: 'Alex Doe', redirectTo: 'https://veyago.cloud/admin/' };

/* ── The regression ───────────────────────────────────────────────────── */

/* If anything ever creates the account before minting the link again, invite
   will be refused for the account it just made and this fails. */
test('a brand-new hire gets an invite link on the first attempt', async () => {
  const admin = fakeAdmin('none');
  const r = await m.mintSignInLink(admin, OPTS);

  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.linkType, 'invite');
  assert.equal(r.expiryHours, 24);
  assert.equal(r.userId, 'u-new');
  assert.equal(r.existingAccount, false);
  assert.deepEqual(admin.names(), ['generateLink:invite'],
    'one call — the account and the link are created together or not at all');
});

/* The exact shape that shipped, kept as an executable description of it. This
   is what the product did for its whole life: the account was minted confirmed
   a moment before the invite asked for it, so the invite was refused for the
   account it had just created. */
test('creating the account first is what poisoned the invite', async () => {
  const admin = fakeAdmin('none');
  await admin.auth.admin.createUser({ email: OPTS.email, email_confirm: true });

  const r = await m.mintSignInLink(admin, OPTS);
  assert.equal(r.linkType, 'recovery', 'invite is refused once the address is confirmed');
  assert.equal(r.expiryHours, 1, 'and the new hire silently gets one hour instead of 24');
  assert.deepEqual(admin.names().slice(1), ['generateLink:invite', 'generateLink:recovery']);
});

test('the new hire’s name is attached to the account it creates', async () => {
  const admin = fakeAdmin('none');
  await m.mintSignInLink(admin, OPTS);
  assert.deepEqual(admin.calls[0].options.data, { full_name: 'Alex Doe' });
  assert.equal(admin.calls[0].options.redirectTo, 'https://veyago.cloud/admin/');
  assert.equal(admin.calls[0].call, 'generateLink');
});

/* ── Retrying, which the UI promises is safe ──────────────────────────── */

/* An invited-but-never-accepted account is unconfirmed, so GoTrue re-issues.
   This is what makes "sending the same address again is safe" a true statement
   rather than the hopeful one it used to be. */
test('re-inviting someone who never accepted re-issues a full 24h link', async () => {
  const admin = fakeAdmin('unconfirmed');
  const r = await m.mintSignInLink(admin, OPTS);

  assert.equal(r.ok, true);
  assert.equal(r.linkType, 'invite');
  assert.equal(r.expiryHours, 24);
  assert.deepEqual(admin.names(), ['generateLink:invite'], 'no fallback — they were never confirmed');
});

/* ── Someone who already works here ───────────────────────────────────── */

test('an address with a real login falls back to a recovery link', async () => {
  const admin = fakeAdmin('confirmed');
  const r = await m.mintSignInLink(admin, OPTS);

  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.linkType, 'recovery');
  assert.equal(r.existingAccount, true);
  assert.equal(r.userId, 'u-old');
  assert.deepEqual(admin.names(), ['generateLink:invite', 'generateLink:recovery']);
});

/* The countdown shown to the invitee is derived from this. Reporting 24 for a
   link that dies in 1 hour is how the handoff page used to lie. */
test('a recovery link reports one hour, not twenty-four', async () => {
  const r = await m.mintSignInLink(fakeAdmin('confirmed'), OPTS);
  assert.equal(r.expiryHours, 1);
  assert.notEqual(r.expiryHours, m.INVITE_EXPIRY_HOURS);
});

/* ── Classifying the refusal ──────────────────────────────────────────── */

test('recognises the taken-address refusal by code and by message', () => {
  assert.equal(m.isEmailTaken(TAKEN), true);
  /* Older supabase-js releases carry no .code. */
  assert.equal(m.isEmailTaken({ message: TAKEN.message }), true);
  assert.equal(m.isEmailTaken({ code: 'email_exists' }), true);

  assert.equal(m.isEmailTaken(null), false);
  assert.equal(m.isEmailTaken({ code: 'user_not_found', message: 'User with this email not found' }), false);
  assert.equal(m.isEmailTaken({ message: 'Database error finding user' }), false);
});

/* A rate-limit or outage must NOT be read as "they already exist" and quietly
   downgraded to a 1-hour link. */
test('an unrelated failure is reported, not mistaken for an existing account', async () => {
  const admin = {
    calls: [],
    auth: { admin: { generateLink: async (p) => {
      admin.calls.push(p);
      return { data: null, error: { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' } };
    } } },
  };
  const r = await m.mintSignInLink(admin, OPTS);

  assert.equal(r.ok, false);
  assert.match(r.error, /Email rate limit exceeded/);
  assert.equal(admin.calls.length, 1, 'no pointless recovery attempt');
});

/* ── Nothing half-done ────────────────────────────────────────────────── */

/* The contradictory case: invite says the address is taken, recovery says no
   such user. Whatever happened, the caller must not be handed a half-result to
   write into employees. */
test('a failure yields no link and no user id to write anywhere', async () => {
  const admin = {
    auth: { admin: { generateLink: async (p) =>
      p.type === 'invite'
        ? { data: null, error: TAKEN }
        : { data: null, error: { code: 'user_not_found', message: 'User with this email not found' } },
    } },
  };
  const out = await m.mintSignInLink(admin, OPTS);

  assert.equal(out.ok, false);
  assert.equal(out.actionLink, null);
  assert.equal(out.userId, null);
  assert.match(out.error, /already has an account/);
});

test('an empty link is a failure, not a success with nothing in it', async () => {
  const admin = {
    auth: { admin: { generateLink: async () => ({ data: { properties: {}, user: { id: 'x' } }, error: null }) } },
  };
  const r = await m.mintSignInLink(admin, OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.actionLink, null);
  assert.match(r.error, /Nothing was changed/);
});
