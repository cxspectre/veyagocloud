/* Tests for _shared/enquiry.ts - the rules behind the public Get-a-quote form.

   This is the first unauthenticated write surface on the public site, so the
   interesting cases are the hostile ones: a bot that fills the honeypot, a
   submission faster than a human could type, control characters aimed at
   email headers, a "website" that is really a javascript: URL. The happy path
   is here too, because normalisation (lower-cased email, https:// added to a
   bare domain) is what the email templates and the CRM rely on. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

/* Same trick as the other _shared tests: the module is ESM TypeScript written
   for Deno, so strip the types and import it as a data: URL. */
let parseEnquiry, normaliseWebsite, clean, cleanMultiline, LIMITS, MIN_FILL_SECONDS;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'enquiry.ts'), 'utf8');
  const m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
  ({ parseEnquiry, normaliseWebsite, clean, cleanMultiline, LIMITS, MIN_FILL_SECONDS } = m);
});

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const NOW = 1800000000000;
const human = (over = {}) => Object.assign({
  kind: 'website', name: 'Ann Lee', email: 'Ann@Example.com', business: 'Ann Bakes',
  website: 'annbakes.com/menu', message: 'Site is slow.\r\n\r\n\r\nHelp?', t: NOW - 10000, locale: 'nl', page: '/websites/',
}, over);

test('a normal submission parses and is normalised', () => {
  const r = parseEnquiry(human(), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.email, 'ann@example.com');
  assert.equal(r.value.website, 'https://annbakes.com/menu');
  assert.equal(r.value.message, 'Site is slow.\n\nHelp?', 'CRLF normalised, blank runs collapsed');
  assert.equal(r.value.locale, 'nl');
  assert.equal(r.value.page, '/websites/');
});

test('the honeypot rejects as a bot without a field hint', () => {
  const r = parseEnquiry(human({ hp_ref: 'Acme' }), NOW);
  assert.ok(!r.ok && r.bot === true);
  assert.equal(r.field, undefined);
});

test('submitting faster than a person can type is a bot; a missing stamp is tolerated', () => {
  assert.equal(parseEnquiry(human({ t: NOW - (MIN_FILL_SECONDS * 1000 - 1) }), NOW).ok, false);
  assert.ok(parseEnquiry(human({ t: undefined }), NOW).ok);
  assert.ok(parseEnquiry(human({ t: 'garbage' }), NOW).ok);
});

test('each required field fails with the field named, so the form can highlight it', () => {
  assert.equal(parseEnquiry(human({ kind: 'spam' }), NOW).field, 'kind');
  assert.equal(parseEnquiry(human({ name: 'A' }), NOW).field, 'name');
  assert.equal(parseEnquiry(human({ email: 'not-an-email' }), NOW).field, 'email');
  assert.equal(parseEnquiry(human({ website: 'javascript:alert(1)' }), NOW).field, 'website');
});

test('control characters never survive into a field', () => {
  const r = parseEnquiry(human({ name: 'Ann ' + NUL + 'Lee', business: 'Bcc:\r x' + ESC }), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.name, 'Ann Lee');
  assert.equal(r.value.business, 'Bcc: x');
  assert.equal(clean('a' + NUL + 'b' + ESC + 'c', 10), 'abc');
  assert.equal(cleanMultiline('a' + ESC + ' \nb', 10), 'a\nb', 'newlines are kept, other control characters go');
});

test('everything is clipped to its limit', () => {
  const r = parseEnquiry(human({ name: 'N'.repeat(500), message: 'm'.repeat(5000), business: 'b'.repeat(500) }), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.name.length, LIMITS.name);
  assert.equal(r.value.message.length, LIMITS.message);
  assert.equal(r.value.business.length, LIMITS.business);
});

test('website normalisation: bare domains gain https, junk is refused, empty is fine', () => {
  assert.deepEqual(normaliseWebsite('www.example.co.uk'), { ok: true, url: 'https://www.example.co.uk/' });
  assert.deepEqual(normaliseWebsite('http://example.com/a?b=1'), { ok: true, url: 'http://example.com/a?b=1' });
  assert.deepEqual(normaliseWebsite(''), { ok: true, url: '' });
  for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'http://user:pw@example.com', 'localhost', '10.0.0.1', 'not a url', 'http://x']) {
    assert.deepEqual(normaliseWebsite(bad), { ok: false }, bad);
  }
  assert.deepEqual(normaliseWebsite('https://example.com/' + 'p'.repeat(300)), { ok: false }, 'over the length limit');
});

test('unknown locale and an odd page path fall back rather than fail', () => {
  const r = parseEnquiry(human({ locale: 'xx-YY-zz', page: 'https://evil.example/x' }), NOW);
  assert.ok(r.ok);
  assert.equal(r.value.locale, 'en');
  assert.equal(r.value.page, '');
});

test('a body that is not an object is treated as empty and fails on kind', () => {
  assert.equal(parseEnquiry(null, NOW).field, 'kind');
  assert.equal(parseEnquiry('str', NOW).field, 'kind');
});

test('the acknowledgement greeting can never carry a URL, a demand, or anything but letters', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'email.ts'), 'utf8');
  /* email.ts reads Deno.env at call time only; the pure helper needs nothing. */
  const m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src).replace(/Deno\.env\.get\([^)]*\)/g, 'undefined')));
  assert.equal(m.greetingName('Ann Lee'), 'Ann');
  const laundered = m.greetingName('https://veyago-billing.example/verify');
  assert.match(laundered, /^[\p{L}\p{M}'-]{1,24}$/u, 'letters, marks, apostrophes and hyphens only');
  assert.ok(!/[:./@]/.test(laundered), 'nothing a mail client would auto-link: no colon, dot, slash or at sign');
  assert.equal(m.greetingName('PAY $400 NOW'), 'PAY');
  assert.equal(m.greetingName('   '), 'there');
  assert.equal(m.greetingName('Zoë-Marie O\'Neil'), 'Zoë-Marie');
  assert.ok(m.greetingName('x'.repeat(200)).length <= 24);
});
