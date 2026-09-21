/* Tests for _shared/graph-guard.ts — the runtime half of "the workspace never
   deletes or copies mail, and moves it only to the three folders the owner
   named". Mail.ReadWrite permits deleting, moving and copying, and a source
   scan (mail-safety.test.js) can be dodged by building a URL or a method from
   a variable. This check sits inside the one function that calls Graph for
   mail, and refuses at the call.

   Since 2026-09-21 an archive, junk or Deleted Items move is allowed
   (0069/move-mail-thread), which is why the move cases below are split: the
   three named destinations go through, and everything else about a move —
   another folder, a raw folder id, an extra field, a copy, a purge — does
   not. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'graph-guard.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

const G = 'https://graph.microsoft.com/v1.0';

test('reading mail, drafting, attaching and sending are allowed', () => {
  for (const [method, url, body] of [
    ['GET', `${G}/me/mailFolders/inbox/messages?$top=10`],
    ['GET', `${G}/users/hello%40veyago.cloud/mailFolders/sentitems/messages?$filter=x`],
    ['GET', `${G}/me/mailFolders/inbox/messages/delta?$deltatoken=abc`],
    ['GET', `${G}/users/hello%40veyago.cloud/mailFolders/sentitems/messages/delta?$skiptoken=def`],
    ['POST', `${G}/me/messages`, { subject: 's' }],
    ['POST', `${G}/users/hello%40veyago.cloud/messages/AAMk%3D/createReply`, {}],
    ['POST', `${G}/me/messages/AAMk/createReplyAll`, {}],
    ['POST', `${G}/me/messages/AAMk/createForward`, {}],
    ['POST', `${G}/me/messages/AAMk/attachments`, { name: 'a.pdf' }],
    ['POST', `${G}/me/messages/AAMk/attachments/createUploadSession`, {}],
    ['POST', `${G}/me/messages/AAMk/send`, {}],
    ['PATCH', `${G}/me/messages/AAMk`, { isRead: true }],
    ['PATCH', `${G}/me/messages/AAMk`, { flag: { flagStatus: 'flagged' } }],
    ['PATCH', `${G}/me/messages/AAMk`, {
      subject: 's', body: { contentType: 'HTML', content: '<p>x</p>' },
      toRecipients: [], ccRecipients: [], bccRecipients: [], importance: 'high',
    }],
  ]) {
    assert.doesNotThrow(() => m.assertGraphCall(method, url, body), `${method} ${url}`);
  }
});

test('deleting and copying mail are refused at the call', () => {
  for (const [method, url] of [
    ['DELETE', `${G}/me/messages/AAMk`],
    ['delete', `${G}/me/messages/AAMk`],
    ['PUT', `${G}/me/messages/AAMk`],
    ['POST', `${G}/me/messages/AAMk/copy`],
    ['POST', `${G}/me/messages/AAMk/permanentDelete`],
    ['POST', `${G}/me/mailFolders/inbox/messages/delta`],
    ['POST', `${G}/me/mailFolders`],
    ['PATCH', `${G}/me/mailFolders/inbox`],
  ]) {
    assert.throws(() => m.assertGraphCall(method, url, {}), /not allowed/, `${method} ${url}`);
  }
});

test('a move reaches the three folders the owner named, in any mailbox', () => {
  for (const [url, to] of [
    [`${G}/me/messages/AAMk/move`, 'archive'],
    [`${G}/me/messages/AAMk/Move`, 'junkemail'],
    [`${G}/me/messages/AAMk/move`, 'deleteditems'],
    [`${G}/me/messages/AAMk/move`, 'DeletedItems'],
    [`${G}/users/hello%40veyago.cloud/messages/AAMk%3D/move`, 'archive'],
    [`${G}/me/mailFolders/inbox/messages/AAMk/move`, 'archive'],
  ]) {
    assert.doesNotThrow(() => m.assertGraphCall('POST', url, { destinationId: to }), `${url} → ${to}`);
  }
});

/* The whole reason this guard still exists after the owner allowed moving:
   a purge is permanent, and "delete" must never be able to mean one. */
test('a move anywhere but those three is refused, purge folders above all', () => {
  for (const to of [
    'recoverableitemsdeletions',          // Outlook's purge: mail here is gone for good
    'recoverableitemspurges',
    'inbox',                              // mail comes BACK only by being synced back
    'sentitems',
    'drafts',
    'AAMkAGI2THEREALFOLDERID=',           // an id says nothing about where it leads
    '',
  ]) {
    assert.throws(() => m.assertGraphCall('POST', `${G}/me/messages/AAMk/move`, { destinationId: to }),
      /not allowed/, `move to ${to || '(nothing)'}`);
  }
});

test('a move may say which folder and nothing else', () => {
  const at = `${G}/me/messages/AAMk/move`;
  assert.throws(() => m.assertGraphCall('POST', at, {}), /not allowed/);
  assert.throws(() => m.assertGraphCall('POST', at, undefined), /not allowed/);
  assert.throws(() => m.assertGraphCall('POST', at, { destinationId: 'archive', isRead: true }), /not allowed/);
  assert.throws(() => m.assertGraphCall('POST', at, { DestinationId: 'archive' }), /not allowed/);
});

test('a PATCH may only change what the workspace changes', () => {
  assert.throws(() => m.assertGraphCall('PATCH', `${G}/me/messages/AAMk`, { parentFolderId: 'deleteditems' }),
    /parentFolderId/);
  assert.throws(() => m.assertGraphCall('PATCH', `${G}/me/messages/AAMk`, { isRead: true, categories: ['x'] }),
    /categories/);
});

test('only Graph itself, over https', () => {
  assert.throws(() => m.assertGraphCall('GET', 'https://evil.example/v1.0/me/messages'), /not allowed/);
  assert.throws(() => m.assertGraphCall('GET', 'http://graph.microsoft.com/v1.0/me/messages'), /not allowed/);
  assert.throws(() => m.assertGraphCall('GET', 'not a url'), /not allowed/);
});

test('an attachment upload goes only to the session Graph created', () => {
  assert.doesNotThrow(() => m.assertUploadCall(
    "https://outlook.office.com/api/v2.0/Users('a@b')/Messages('AAMk')/AttachmentSessions('AAMk')?authtoken=x"));
  assert.throws(() => m.assertUploadCall(`${G}/me/messages/AAMk`), /upload/);
  assert.throws(() => m.assertUploadCall('https://evil.example/AttachmentSessions(1)'), /upload/);
  assert.throws(() => m.assertUploadCall("http://outlook.office.com/api/v2.0/AttachmentSessions('1')"), /upload/);
});
