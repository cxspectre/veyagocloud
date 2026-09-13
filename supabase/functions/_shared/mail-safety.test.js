/* What Mail.ReadWrite allows, and the code must never do.
   Until 2026-09-13 the scope was held back because it carries permanent delete
   of client correspondence. The owner then chose it — for attachments over
   3 MB, drafts, and read/flag state that reaches Outlook. A delegated grant
   cannot be narrowed, so the line moves into the code: no Edge Function may
   delete, purge, move or copy a message. This reads every function's source
   and fails on the calls that would. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTIONS = path.join(__dirname, '..');

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const FORBIDDEN = [
  { pattern: /permanentDelete/i, what: 'permanently deleting a message' },
  { pattern: /method:\s*['"`]DELETE['"`]/i, what: 'an HTTP DELETE' },
  { pattern: /\/(move|copy)\b/, what: 'moving or copying a message (a move to Deleted Items is a delete)' },
  { pattern: /destinationId/, what: 'a move or copy destination' },
];

test('no Edge Function can delete, purge, move or copy mail', () => {
  const offences = [];
  for (const file of tsFiles(FUNCTIONS)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(source)) offences.push(`${path.relative(FUNCTIONS, file)}: ${what}`);
    }
  }
  assert.deepEqual(offences, [],
    'Mail.ReadWrite is granted for drafts, attachments and read state — not for this');
});

test('the guard would notice if it were broken', () => {
  const caught = (code) => FORBIDDEN.some(({ pattern }) => pattern.test(code));
  assert.ok(caught("await fetch(url, { method: 'DELETE' })"));
  assert.ok(caught('POST /me/messages/AAMk/permanentDelete'));
  assert.ok(caught('POST /users/hello@veyago.cloud/messages/AAMk/move'));
  assert.ok(caught('{ "destinationId": "deleteditems" }'));
  assert.ok(!caught("await fetch(url, { method: 'PATCH' })"), 'marking read is allowed');
});
