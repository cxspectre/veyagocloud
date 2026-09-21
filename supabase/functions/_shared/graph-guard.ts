/* The runtime half of "the workspace never deletes or copies mail, and moves
 * it only to the three folders the owner named".
 *
 * Mail.ReadWrite permits deleting, moving and copying, and a grant cannot be
 * narrowed. A scan of the source (mail-safety.test.js) catches the obvious
 * spellings, but a URL or a method built from a variable walks straight past a
 * scan. So the one function that calls Graph for mail — graphRequest() in
 * mail-sync.ts — asks this first, and a call that is not a read, a draft, an
 * attachment, a send, a read/flag change or one of those three moves is
 * refused before it leaves.
 *
 * Until 2026-09-21 a move was refused outright along with the rest. The owner
 * then decided the workspace may archive, mark as junk and delete, where
 * delete means Outlook's Deleted Items and nothing else — so the line moved
 * rather than disappeared: MOVABLE_TO below is the whole of what "delete"
 * is now allowed to mean. Outlook's own purge folders are not on it and must
 * never be — mail put there is gone for good, which is the one thing this
 * file exists to prevent, and mail-safety.test.js fails the build on either
 * of their names appearing anywhere in the scanned source. Nor is a raw
 * folder id on the list, however well-known the caller believes it to be: an
 * id is opaque, so nothing reading this code could tell a safe one from a
 * purge.
 *
 * An allowlist, not a denylist: a new kind of call has to be added here on
 * purpose, with a test, rather than working because nobody thought to forbid it.
 *
 * Kept free of imports so it can be tested in node as-is.
 */

const GRAPH_HOST = 'graph.microsoft.com';
const UPLOAD_HOSTS = ['outlook.office.com', 'outlook.office365.com'];

/* Where a message may be moved, by Graph's own well-known folder names. The
   workspace's own three folder words (archive, spam, trash) map onto these in
   _shared/mail-move.ts, which is the only caller. */
export const MOVABLE_TO = ['archive', 'junkemail', 'deleteditems'];

/* What a POST may end in. Copying a message, purging one, making a folder —
   none of them is on the list, which is the point. A move is, since
   2026-09-21, but only as far as the body check below lets it go. (Named here
   in words: mail-safety.test.js scans this file too, and should.) */
const POSTABLE = [
  /\/messages$/i,
  /\/sendMail$/i,
  /\/messages\/[^/]+\/(createReply|createReplyAll|createForward|send|attachments)$/i,
  /\/messages\/[^/]+\/attachments\/createUploadSession$/i,
  /\/messages\/[^/]+\/move$/i,
];

/* A move POST, which is the only POST whose body this file reads. */
const MOVE_PATH = /\/messages\/[^/]+\/move$/i;

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
    /* A move is allowed to say one thing and nothing else: which of the three
       folders. A body carrying anything further, or a destination spelled as
       an id rather than as one of those names, is refused — a caller that has
       somehow been talked into purging mail cannot get there by adding a
       field or by naming the folder a different way. */
    if (MOVE_PATH.test(path)) {
      const fields = body && typeof body === 'object' ? Object.keys(body) : [];
      if (fields.length !== 1 || fields[0] !== 'destinationId') {
        refuse(`a move saying ${fields.length ? fields.join(', ') : 'nothing'}`);
      }
      const to = String((body as { destinationId?: unknown }).destinationId ?? '').toLowerCase();
      if (!MOVABLE_TO.includes(to)) refuse(`a move to ${to || 'nowhere'}`);
    }
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
