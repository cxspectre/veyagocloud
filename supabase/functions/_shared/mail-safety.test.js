/* What Mail.ReadWrite allows, and the code must never do.
   Until 2026-09-13 the scope was held back because it carries permanent delete
   of client correspondence. The owner then chose it — for attachments over
   3 MB, drafts, and read/flag state that reaches Outlook. A delegated grant
   cannot be narrowed, so the line moves into the code, twice:

     at runtime   graph-guard.ts refuses any Graph call for mail that is not a
                  read, a draft, an attachment, a send, or a read/flag change —
                  whatever built the URL or the method (graph-guard.test.js).
     in source    this file reads every function and migration and fails on
                  the calls that would delete, purge, move or copy a message,
                  and checks the runtime guard is actually wired in. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTIONS = path.join(__dirname, '..');
const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');

/* This file is about Mail.ReadWrite — a scope that must never delete, move or
   copy a client's mail (see the header above). Calendars.ReadWrite and
   Calendars.ReadWrite.Shared are a different grant, on a different resource,
   where deleting or moving an EVENT (0057, "Edits and deletes need to reach
   Outlook") is exactly what update-calendar-event and delete-calendar-event
   are for — the workspace's Remove event has always meant Graph DELETE for a
   synced one, once there was a function to send it. Named narrowly, not by a
   loose "calendar" substring, so an addition here is a deliberate choice, not
   a pattern that happens to match: each of these five is read-checked by hand
   (2026-09-15) to touch nothing under /messages, /mailFolders or an
   attachment. A sixth calendar function added later starts back inside the
   scan until it earns the same reading. */
const CALENDAR_FUNCTIONS = new Set([
  'sync-outlook-calendar', 'create-calendar-event', 'update-calendar-event',
  'delete-calendar-event', 'sync-calendar-scheduled',
]);

function files(dir, extensions) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (CALENDAR_FUNCTIONS.has(entry.name)) return [];
      return files(full, extensions);
    }
    if (entry.name.endsWith('.test.js')) return [];
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

const FORBIDDEN = [
  { pattern: /permanentDelete/i, what: 'permanently deleting a message' },
  { pattern: /["'`]?method["'`]?\s*:\s*["'`]DELETE["'`]/i, what: 'an HTTP DELETE' },
  { pattern: /\/(move|copy)\b/i, what: 'moving or copying a message (a move to Deleted Items is a delete)' },
  { pattern: /["'`](move|copy)["'`]/i, what: 'a move or copy action named as a string' },
  { pattern: /destinationId/, what: 'a move or copy destination' },
  { pattern: /http_delete/i, what: 'a DELETE sent from the database with pg_net' },
];

function offences(paths, root) {
  return paths.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return FORBIDDEN
      .filter(({ pattern }) => pattern.test(source))
      .map(({ what }) => `${path.relative(root, file)}: ${what}`);
  });
}

test('no Edge Function can delete, purge, move or copy mail', () => {
  assert.deepEqual(offences(files(FUNCTIONS, ['.ts', '.js', '.mjs']), FUNCTIONS), [],
    'Mail.ReadWrite is granted for drafts, attachments and read state — not for this');
});

test('no migration sends a delete to Graph from the database', () => {
  assert.deepEqual(offences(files(MIGRATIONS, ['.sql']), MIGRATIONS), []);
});

test('the one function that calls Graph for mail is guarded, and so is the upload', () => {
  const sync = fs.readFileSync(path.join(__dirname, 'mail-sync.ts'), 'utf8');
  assert.match(sync, /assertGraphCall\(/, 'graphRequest must check every call');
  const send = fs.readFileSync(path.join(FUNCTIONS, 'send-mail', 'index.ts'), 'utf8');
  assert.match(send, /assertUploadCall\(/, 'the attachment upload must check where it is going');
});

test('the calendar functions this scan exempts do not go near a message, a mail folder or an attachment', () => {
  const offenders = [...CALENDAR_FUNCTIONS].flatMap((name) => {
    const indexPath = path.join(FUNCTIONS, name, 'index.ts');
    if (!fs.existsSync(indexPath)) return [`${name}: has no index.ts to read`];
    const source = fs.readFileSync(indexPath, 'utf8');
    return /\/messages\b|mailFolders|mail-attachments/i.test(source) ? [name] : [];
  });
  assert.deepEqual(offenders, [],
    'a calendar function exempted from the mail-delete scan must never have a reason to be');
});

test('the source scan would notice if it were broken', () => {
  const caught = (code) => FORBIDDEN.some(({ pattern }) => pattern.test(code));
  assert.ok(caught("await fetch(url, { method: 'DELETE' })"));
  assert.ok(caught('{ "method": "DELETE", "url": "/me/messages/AAMk" }'));
  assert.ok(caught('POST /me/messages/AAMk/permanentDelete'));
  assert.ok(caught('POST /users/hello@veyago.cloud/messages/AAMk/move'));
  assert.ok(caught("const ACTIONS = { archive: 'move' }"));
  assert.ok(caught('{ "destinationId": "deleteditems" }'));
  assert.ok(caught('select net.http_delete(url := …)'));
  assert.ok(!caught("await fetch(url, { method: 'PATCH' })"), 'marking read is allowed');
});
