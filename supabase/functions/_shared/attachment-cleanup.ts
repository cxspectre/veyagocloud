/* attachment-cleanup.ts — which files in the mail-attachments bucket a
 * cleanup run should remove.
 *
 * send-mail already removes a message's attachments the moment it sends
 * (0038 §5, ATTACHMENT_PATH: <auth id>/<upload id>/<name>): a file still there
 * afterwards was never sent — a draft closed without sending, a page
 * refreshed away mid-compose, a browser tab that never came back. Compose
 * keeps no record of "in progress" in the database (that state lives in the
 * browser, not here), so there is no list of what is still wanted to check
 * against. Age is what is left: nobody composes a message for two days
 * straight, so a file untouched that long was abandoned, not merely slow.
 *
 * Kept free of imports so attachment-cleanup.test.js runs it in node. The
 * actual Storage list() and remove() calls are cleanup-mail-attachments'
 * job — they need live storage, which cannot be exercised here, so this file
 * is the decision only: what counts as stale, and how to batch the removals.
 */

export interface StorageObject {
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/* Comfortably longer than any real compose session — this is "abandoned",
   not "slow to finish". */
export const STALE_AFTER_HOURS = 48;

const HOUR_MS = 3600_000;

/* When Storage last touched this object — updated_at moves on an upload's
   own last change; created_at stands in for an object Storage has not
   recorded an update for. Anything that will not parse is not a time at all:
   NaN loses every comparison, which is exactly "not stale" without a special
   case for it. */
function lastTouchedMs(obj: StorageObject): number {
  return Date.parse(String(obj.updated_at ?? obj.created_at ?? ''));
}

/* Untouched for the whole window, or longer. No timestamp at all — Storage
   should always give one, but a test double or a future API might not — is
   left alone rather than guessed stale: deleting someone's file on a missing
   date would be a far worse mistake than leaving one around a little longer. */
export function isStaleAttachment(obj: StorageObject, nowMs: number, staleAfterHours: number = STALE_AFTER_HOURS): boolean {
  const at = lastTouchedMs(obj);
  return Number.isFinite(at) && nowMs - at >= staleAfterHours * HOUR_MS;
}

export function staleAttachmentPaths(
  objects: StorageObject[],
  nowMs: number,
  staleAfterHours: number = STALE_AFTER_HOURS,
): string[] {
  return objects.filter((o) => isStaleAttachment(o, nowMs, staleAfterHours)).map((o) => o.name);
}

/* Storage.remove() takes one list of paths per call. Grouped rather than
   removed one at a time, so a bucket with hundreds of stale uploads does not
   turn into hundreds of round trips; a size that is not a genuine positive
   whole number falls back to one per chunk instead of looping forever (or,
   for zero or a negative size, not looping at all). */
export function chunkPaths(paths: string[], size: number): string[][] {
  const step = Number.isInteger(size) && size > 0 ? size : 1;
  const chunks: string[][] = [];
  for (let start = 0; start < paths.length; start += step) {
    chunks.push(paths.slice(start, start + step));
  }
  return chunks;
}
