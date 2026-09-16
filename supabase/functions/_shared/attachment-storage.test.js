/* Tests for _shared/attachment-storage.ts.
   storageName is kept in lockstep with dist/mail-model.js's own tests — same
   cases, so a change to either without the other would show up here. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'attachment-storage.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* ── storageName ───────────────────────────────────────────────────────── */

test('an upload is stored under a plain name that keeps its extension', () => {
  assert.equal(m.storageName('Quarterly Report (Final).pdf'), 'Quarterly-Report-Final.pdf');
  assert.equal(m.storageName('résumé.docx'), 'resume.docx');
  assert.equal(m.storageName('../../etc/passwd'), 'etc-passwd');
  assert.equal(m.storageName('...'), 'attachment');
  assert.equal(m.storageName('日本語.pdf'), 'attachment.pdf');
  assert.equal(m.storageName('archive.tar.gz'), 'archive.tar.gz');
  assert.equal(m.storageName('PHOTO.JPG'), 'PHOTO.jpg');
  const long = m.storageName('a'.repeat(300) + '.pdf');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.pdf'));
  for (const name of ['Quarterly Report (Final).pdf', '../../etc/passwd', '...', '', null, '%2e%2e']) {
    assert.match(m.storageName(name), /^[A-Za-z0-9._-]{1,200}$/, String(name));
    assert.doesNotMatch(m.storageName(name), /^\.+$/, String(name));
    assert.doesNotMatch(m.storageName(name), /%/, String(name));
  }
});

/* ── ticketAttachmentPath ──────────────────────────────────────────────── */

test('a carried-over attachment lands under the ticket, keyed by the mail attachment it came from', () => {
  assert.equal(m.ticketAttachmentPath('t-1', 'ma-1', 'Invoice.pdf'), 't-1/ma-1/Invoice.pdf');
  /* Run twice for the same attachment (a retry after a database failure,
     say), the path is IDENTICAL — an upsert:false re-run overwrites the same
     object rather than leaving an earlier, orphaned copy behind. */
  assert.equal(m.ticketAttachmentPath('t-1', 'ma-1', 'Invoice.pdf'), m.ticketAttachmentPath('t-1', 'ma-1', 'Invoice.pdf'));
  assert.equal(m.ticketAttachmentPath('t-1', 'ma-1', '../../etc/passwd'), 't-1/ma-1/etc-passwd');
  assert.equal(m.ticketAttachmentPath('t-2', 'ma-1', 'Invoice.pdf'), 't-2/ma-1/Invoice.pdf', 'a different ticket, a different object');
});
