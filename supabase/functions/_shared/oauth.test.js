/* Tests for _shared/oauth.ts (Microsoft identity platform).
   The refresh-token rules are the reason this module exists: both of the
   mistakes guarded against here — omitting offline_access, and overwriting the
   stored refresh token on a refresh that did not send one — break a connection
   an hour after it looks like it worked. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'oauth.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const base = {
  clientId: '11111111-2222-3333-4444-555555555555',
  redirectUri: 'https://x.supabase.co/functions/v1/microsoft-callback',
  scopes: ['offline_access', 'https://graph.microsoft.com/Mail.Read'],
  state: 'signed-state'
};

test('the consent URL forces the prompt and targets the common tenant', () => {
  const url = new URL(m.buildConsentUrl(base));
  assert.equal(url.origin + url.pathname,
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('prompt'), 'consent',
    'without this a re-connect after a revoke returns no refresh token');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('state'), 'signed-state');
  assert.equal(url.searchParams.get('scope'), base.scopes.join(' '));
});

test('a tenant can be pinned when the studio wants one directory only', () => {
  const url = new URL(m.buildConsentUrl({ ...base, tenant: 'contoso.onmicrosoft.com' }));
  assert.match(url.pathname, /^\/contoso\.onmicrosoft\.com\//);
});

test('a consent URL without offline_access is refused, not quietly built', () => {
  assert.throws(
    () => m.buildConsentUrl({ ...base, scopes: ['https://graph.microsoft.com/Mail.Read'] }),
    /offline_access/,
    'the grant would work for an hour and then be unrefreshable');
});

test('consent URL refuses to be built half-configured', () => {
  assert.throws(() => m.buildConsentUrl({ ...base, clientId: '' }), /MICROSOFT_CLIENT_ID/);
  assert.throws(() => m.buildConsentUrl({ ...base, redirectUri: '' }), /redirect URI/);
  assert.throws(() => m.buildConsentUrl({ ...base, scopes: [] }), /scope/);
});

test('the token endpoint follows the tenant', () => {
  assert.equal(m.tokenUrl(), 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(m.tokenUrl('contoso'), 'https://login.microsoftonline.com/contoso/oauth2/v2.0/token');
});

test('login_hint is included only when given', () => {
  assert.equal(new URL(m.buildConsentUrl(base)).searchParams.get('login_hint'), null);
  assert.equal(
    new URL(m.buildConsentUrl({ ...base, loginHint: 'hello@veyago.cloud' })).searchParams.get('login_hint'),
    'hello@veyago.cloud');
});

test('scopes cover sending and writing the diary, but never deleting mail', () => {
  assert.deepEqual(m.SCOPES.mail, [
    'offline_access',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
    /* A shared mailbox is not the mailbox of whoever consents. */
    'https://graph.microsoft.com/Mail.Read.Shared',
    'https://graph.microsoft.com/Mail.Send.Shared',
  ]);
  assert.deepEqual(m.SCOPES.calendar, [
    'offline_access',
    'https://graph.microsoft.com/Calendars.ReadWrite',
  ]);

  /* Mail.ReadWrite is the only Graph scope that would sync read/flag state
     back to Outlook, and it carries permanent delete of client mail. The
     workspace keeps that state on its own mirror instead. If this assertion is
     ever removed, it should be because someone decided that trade, not because
     a scope got pasted in. */
  const all = [...m.SCOPES.mail, ...m.SCOPES.calendar, ...m.SCOPES.identity];
  assert.ok(!all.some((s) => /Mail\.ReadWrite/.test(s)),
    'Mail.ReadWrite would allow deleting a customer\'s correspondence');
  assert.ok(!all.some((s) => /ReadWrite\.Shared/.test(s)),
    'and the .Shared variant would allow it on the studio mailbox');
  assert.ok(all.some((s) => /Mail\.Send/.test(s)), 'the desk has to be able to reply');
  assert.ok(all.some((s) => /Calendars\.ReadWrite/.test(s)), 'the diary has to be writable');
});

test('expires_in becomes an absolute timestamp', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  assert.equal(m.expiryFrom(3600, now), '2026-09-11T13:00:00.000Z');
  assert.equal(m.expiryFrom(undefined, now), null);
  assert.equal(m.expiryFrom(0, now), null);
  assert.equal(m.expiryFrom(-5, now), null);
});

test('needsRefresh is true early, and true for anything unusable', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  assert.equal(m.needsRefresh('2026-09-11T13:00:00.000Z', now), false);
  assert.equal(m.needsRefresh('2026-09-11T12:00:30.000Z', now), true, 'inside the 60s skew');
  assert.equal(m.needsRefresh('2026-09-11T11:59:00.000Z', now), true, 'already expired');
  assert.equal(m.needsRefresh(null, now), true);
  assert.equal(m.needsRefresh('not a date', now), true);
});

test('a refresh never wipes the stored refresh token', () => {
  const stored = { access_token: 'old', refresh_token: 'THE-STORED-ONE', token_type: 'Bearer' };
  const merged = m.mergeTokens(stored, { access_token: 'new', expires_in: 3600 },
                               Date.parse('2026-09-11T12:00:00.000Z'));
  assert.equal(merged.access_token, 'new');
  assert.equal(merged.refresh_token, 'THE-STORED-ONE',
    'a refresh response may omit it; losing it means sending the user back to consent');
  assert.equal(merged.expires_at, '2026-09-11T13:00:00.000Z');
});

test('a first consent stores the refresh token it is given', () => {
  const merged = m.mergeTokens({}, { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  assert.equal(merged.refresh_token, 'r');
  assert.equal(merged.token_type, 'Bearer');
});

test('state survives a round trip and rejects tampering', async () => {
  const secret = 'a-long-random-signing-secret';
  const signed = await m.signState({ connection: 'abc', provider: 'microsoft_mail' }, secret);
  assert.deepEqual(await m.verifyState(signed, secret), { connection: 'abc', provider: 'microsoft_mail' });

  assert.equal(await m.verifyState(signed, 'a-different-secret'), null);
  assert.equal(await m.verifyState('garbage', secret), null);
  assert.equal(await m.verifyState('', secret), null);

  // Flip the payload, keep the signature: the classic forgery.
  const [body, mac] = signed.split('.');
  const forged = Buffer.from(JSON.stringify({ connection: 'someone-elses' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(await m.verifyState(`${forged}.${mac}`, secret), null,
    'an unsigned state would let a caller bind a mailbox to another connection');
});

test('timingSafeEqual compares without leaking length-independent shortcuts', () => {
  assert.equal(m.timingSafeEqual('abc', 'abc'), true);
  assert.equal(m.timingSafeEqual('abc', 'abd'), false);
  assert.equal(m.timingSafeEqual('abc', 'ab'), false);
});
