/* The runtime half of "the workspace never deletes, moves or copies mail".
 *
 * Mail.ReadWrite permits all three, and a grant cannot be narrowed. A scan of
 * the source (mail-safety.test.js) catches the obvious spellings, but a URL or
 * a method built from a variable walks straight past a scan. So the one
 * function that calls Graph for mail — graphRequest() in mail-sync.ts — asks
 * this first, and a call that is not a read, a draft, an attachment, a send or
 * a read/flag change is refused before it leaves.
 *
 * An allowlist, not a denylist: a new kind of call has to be added here on
 * purpose, with a test, rather than working because nobody thought to forbid it.
 *
 * Kept free of imports so it can be tested in node as-is.
 */

const GRAPH_HOST = 'graph.microsoft.com';
const UPLOAD_HOSTS = ['outlook.office.com', 'outlook.office365.com'];

/* What a POST may end in. Moving, copying or purging a message, making a
   folder — none of them is on the list, which is the point. (Named here in
   words: mail-safety.test.js scans this file too, and should.) */
const POSTABLE = [
  /\/messages$/i,
  /\/sendMail$/i,
  /\/messages\/[^/]+\/(createReply|createReplyAll|createForward|send|attachments)$/i,
  /\/messages\/[^/]+\/attachments\/createUploadSession$/i,
];

/* A PATCH goes to a message, and changes only what the workspace changes:
   read and flagged, and the parts of a draft. */
const PATCHABLE_PATH = /\/messages\/[^/]+$/i;
const PATCHABLE_FIELDS = ['isRead', 'flag', 'subject', 'body', 'toRecipients', 'ccRecipients', 'bccRecipients', 'importance'];

function refuse(what: string): never {
  throw new Error(`Graph call not allowed: ${what}`);
}

export function assertGraphCall(method: string, href: string, body?: unknown): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return refuse(`not a URL (${String(href).slice(0, 80)})`);
  }
  if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST) refuse(`${url.protocol}//${url.hostname}`);

  const path = url.pathname;
  /* An encoded slash inside an id would let one path segment pose as two. */
  if (/%2f/i.test(path)) refuse(`an encoded slash in ${path}`);

  const verb = String(method || '').toUpperCase();
  if (verb === 'GET') return;

  if (verb === 'POST') {
    if (!POSTABLE.some((allowed) => allowed.test(path))) refuse(`POST ${path}`);
    return;
  }

  if (verb === 'PATCH') {
    if (!PATCHABLE_PATH.test(path)) refuse(`PATCH ${path}`);
    const fields = body && typeof body === 'object' ? Object.keys(body) : [];
    const stray = fields.filter((field) => !PATCHABLE_FIELDS.includes(field));
    if (stray.length) refuse(`PATCH of ${stray.join(', ')}`);
    return;
  }

  refuse(`${verb} ${path}`);
}

/* An attachment upload PUTs to a pre-authenticated URL Graph hands back.
   It must be that URL — an Outlook attachment session — and nowhere else. */
export function assertUploadCall(href: string): void {
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || !UPLOAD_HOSTS.includes(url.hostname)
      || !/\/AttachmentSessions\(/i.test(url.pathname)) {
    throw new Error(`Attachment upload not allowed: ${url ? url.hostname + url.pathname.slice(0, 60) : 'not a URL'}`);
  }
}
