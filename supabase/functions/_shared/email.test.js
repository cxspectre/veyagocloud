/* Tests for the enquiry templates in _shared/email.ts.

   Two properties matter more than the wording. The notification to us must
   show everything the visitor gave, including the package. The acknowledgement
   to the visitor must show NOTHING the visitor gave except a laundered first
   name — it is a veyago.cloud-signed email delivered to whatever address was
   typed into a public form, so any echoed text would make the endpoint a relay
   for sending arbitrary content to arbitrary inboxes. The three languages are
   checked for structure (links, phones, hours line) rather than every word. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let enquiryEmail, enquiryAckEmail, ackLocale;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'email.ts'), 'utf8');
  /* email.ts reads Deno.env at call time only; the templates need nothing. */
  const js = stripTypeScriptTypes(src).replace(/Deno\.env\.get\([^)]*\)/g, 'undefined');
  ({ enquiryEmail, enquiryAckEmail, ackLocale } = await import('data:text/javascript,' + encodeURIComponent(js)));
});

const lead = (over = {}) => Object.assign({
  id: '5c1c8a9e-0000-4000-8000-000000000001', kind: 'website', name: 'Ann Lee', email: 'ann@example.com',
  business: 'Ann Bakes', website: 'https://annbakes.com/', message: 'Site is slow.', locale: 'nl', page: '/websites/',
}, over);

/* ── To us ───────────────────────────────────────────────────────────── */

test('the notification shows the package when one was picked', () => {
  const m = enquiryEmail(lead({ packageLabel: 'Business' }));
  assert.ok(m.text.includes('Package: Business'), m.text);
  assert.ok(m.html.includes('Package') && m.html.includes('Business'));
});

test('and no package line at all when none was', () => {
  const m = enquiryEmail(lead());
  assert.ok(!m.text.includes('Package:'), m.text);
  assert.ok(!/>Package</.test(m.html));
});

test('the notification still carries the reference and the reply-to name', () => {
  const m = enquiryEmail(lead());
  assert.ok(m.text.includes('ref 5c1c8a9e-0000-4000-8000-000000000001'));
  assert.ok(m.html.includes('straight to Ann Lee'));
});

/* ── To the visitor ──────────────────────────────────────────────────── */

const PHONE_US = '+1 (518) 913 2531';
const PHONE_INTL = '+1 (943) 273 6579';

function checkStructure(m, { kind, subjectRe, hoursRe, lang }) {
  assert.match(m.subject, subjectRe);
  for (const body of [m.html, m.text]) {
    assert.ok(body.includes('hello@veyago.cloud'), 'contact address');
    assert.ok(body.includes(PHONE_US), 'US number');
    assert.ok(body.includes(PHONE_INTL), 'international number');
    assert.match(body, hoursRe, 'the New York hours expectation');
    if (kind === 'website') {
      assert.ok(body.includes('https://www.veyago.cloud/websites/#faq'), 'FAQ link');
      assert.ok(body.includes('https://www.veyago.cloud/websites/#packages'), 'packages link');
      assert.ok(!body.includes('/services/'), 'no services link for a website enquiry');
    } else {
      assert.ok(body.includes('https://www.veyago.cloud/services/'), 'services link');
      assert.ok(!body.includes('/websites/#'), 'no website links for a project enquiry');
    }
  }
  assert.ok(m.html.includes('<html lang="' + lang + '">'), 'lang attribute for ' + lang);
}

test('English: subject, what happens next, hours, links and contact lines', () => {
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'en' }),
    { kind: 'website', subjectRe: /^We got your enquiry$/, hoursRe: /New York hours \(Mon–Fri, ET\)/, lang: 'en' });
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'product', locale: 'en' }),
    { kind: 'product', subjectRe: /^We got your enquiry$/, hoursRe: /New York hours/, lang: 'en' });
  const m = enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'en' });
  assert.ok(m.text.includes('Thanks, Ann.'));
  assert.ok(m.text.includes('What happens next'));
  assert.ok(m.text.includes('Within one working day'));
});

test('Dutch: the whole email, not just the greeting', () => {
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'nl' }),
    { kind: 'website', subjectRe: /^We hebben je aanvraag ontvangen$/, hoursRe: /New Yorkse kantoortijden \(ma–vr, ET\)/, lang: 'nl' });
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'product', locale: 'nl' }),
    { kind: 'product', subjectRe: /aanvraag/, hoursRe: /kantoortijden/, lang: 'nl' });
  const m = enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'nl' });
  assert.ok(m.text.includes('Bedankt, Ann.'));
  assert.ok(m.text.includes('Wat er nu gebeurt'));
  assert.ok(m.text.includes('Binnen één werkdag'));
  assert.ok(!/working day|What happens next/.test(m.text), 'no English left over');
});

test('German: the whole email, not just the greeting', () => {
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'de' }),
    { kind: 'website', subjectRe: /^Wir haben deine Anfrage erhalten$/, hoursRe: /New Yorker Bürozeiten \(Mo–Fr, ET\)/, lang: 'de' });
  checkStructure(enquiryAckEmail({ name: 'Ann Lee', kind: 'product', locale: 'de' }),
    { kind: 'product', subjectRe: /Anfrage/, hoursRe: /Bürozeiten/, lang: 'de' });
  const m = enquiryAckEmail({ name: 'Ann Lee', kind: 'website', locale: 'de' });
  assert.ok(m.text.includes('Danke, Ann.'));
  assert.ok(m.text.includes('Wie es weitergeht'));
  assert.ok(m.text.includes('Innerhalb eines Werktags'));
  assert.ok(!/working day|What happens next/.test(m.text), 'no English left over');
});

test('any other locale, or none, falls back to English', () => {
  for (const locale of ['fr', 'es', 'xx', '', null, undefined, 'NL-be']) {
    const m = enquiryAckEmail({ name: 'Ann', kind: 'website', locale });
    if (locale === 'NL-be') assert.equal(m.subject, 'We hebben je aanvraag ontvangen', 'a region suffix still finds the language');
    else assert.equal(m.subject, 'We got your enquiry', JSON.stringify(locale));
  }
  assert.equal(ackLocale('de-AT'), 'de');
  assert.equal(ackLocale('javascript:'), 'en');
});

/* The security property. Every field the form collects is passed in here as
   if a future caller forgot the rule; none of it may come out. */
test('the acknowledgement never echoes anything the visitor typed except a laundered first name', () => {
  const hostile = {
    name: 'Ann <script>alert(1)</script> https://veyago-billing.example/verify',
    kind: 'website',
    locale: 'en',
    email: 'SECRET-EMAIL@example.com',
    business: 'SECRET-BUSINESS',
    website: 'https://SECRET-SITE.example/',
    message: 'SECRET-MESSAGE pay $400 now',
    page: '/SECRET-PAGE/',
  };
  for (const locale of ['en', 'nl', 'de']) {
    const m = enquiryAckEmail(Object.assign({}, hostile, { locale }));
    for (const body of [m.subject, m.html, m.text]) {
      assert.ok(!/SECRET/.test(body), locale + ': visitor text leaked: ' + body.slice(0, 200));
      assert.ok(!/<script|alert\(|veyago-billing|\/verify|\$400/.test(body), locale + ': hostile name leaked');
    }
    assert.ok(m.text.includes('Ann'), 'the first name survives');
  }
});
