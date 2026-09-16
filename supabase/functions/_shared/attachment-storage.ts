/* Naming and placing a carried-over attachment in Storage.
 *
 * Kept free of imports, the same choice graph-guard.ts explains: it can then
 * be tested in node as-is, with no relative import for a data: URL module to
 * fail to resolve.
 */

/* A storage object name safe on every backend this app uses, and readable
 * next to a paperclip icon — the server-side twin of dist/mail-model.js's
 * storageName(). The two cannot share code (one runs in the browser, one in
 * Deno) so this is kept deliberately in step with it: same accents-stripped
 * folding, same allowed characters, same 200-character cap, same fallback
 * name for one that is empty, all dots, or has nothing keepable in it. */
const MAX_NAME = 200;

export function storageName(fileName: string | null | undefined): string {
  const plain = String(fileName ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const dot = plain.lastIndexOf('.');
  const rawExtension = dot > 0 ? plain.slice(dot + 1) : '';
  const extension = /^[A-Za-z0-9]{1,10}$/.test(rawExtension) ? `.${rawExtension.toLowerCase()}` : '';
  const stem = (extension ? plain.slice(0, dot) : plain)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_NAME - extension.length)
    .replace(/[-.]+$/g, '');
  return (stem || 'attachment') + extension;
}

/* Where a mail attachment carried onto a ticket is stored — the same bucket
 * and shape dist/data/actions.js's uploadTicketAttachment already uses for a
 * file someone on staff picks by hand (0056), so the two kinds sit in it
 * indistinguishably once they land. The middle segment is the mail
 * attachment's own id rather than a fresh random one (uploadTicketAttachment
 * mints one of those instead, since it has no other id to reach for): stable
 * across a retry, so carrying the same attachment twice overwrites the same
 * object instead of leaving an orphaned copy behind if the earlier attempt's
 * database insert is what failed. */
export function ticketAttachmentPath(ticketId: string, mailAttachmentId: string, name: string): string {
  return `${ticketId}/${mailAttachmentId}/${storageName(name)}`;
}
