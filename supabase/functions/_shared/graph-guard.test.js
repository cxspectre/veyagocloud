/* Tests for _shared/graph-guard.ts — the runtime half of "the workspace never
   deletes, moves or copies mail". Mail.ReadWrite permits all three, and a
   source scan (mail-safety.test.js) can be dodged by building a URL or a
   method from a variable. This check sits inside the one function that calls
   Graph for mail, and refuses at the call. */
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

test('deleting, moving and copying mail are refused at the call', () => {
  for (const [method, url] of [
    ['DELETE', `${G}/me/messages/AAMk`],
    ['delete', `${G}/me/messages/AAMk`],
    ['PUT', `${G}/me/messages/AAMk`],
    ['POST', `${G}/me/messages/AAMk/move`],
    ['POST', `${G}/me/messages/AAMk/Move`],
    ['POST', `${G}/me/messages/AAMk/copy`],
    ['POST', `${G}/me/messages/AAMk/permanentDelete`],
    ['POST', `${G}/me/mailFolders/inbox/messages/AAMk/move`],
    ['POST', `${G}/me/mailFolders/inbox/messages/delta`],
    ['POST', `${G}/me/mailFolders`],
    ['PATCH', `${G}/me/mailFolders/inbox`],
  ]) {
    assert.throws(() => m.assertGraphCall(method, url, {}), /not allowed/, `${method} ${url}`);
  }
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
