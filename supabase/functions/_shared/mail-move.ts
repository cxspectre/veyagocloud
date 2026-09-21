/* mail-move.ts — where a conversation goes, and which of its messages go there.
 *
 * Until 2026-09-21 the workspace was read-only about where a message lives:
 * only Inbox and Sent were loaded, and graph-guard.ts refused a move outright.
 * The owner then decided the workspace may archive, mark as junk and delete —
 * where delete means Outlook's Deleted Items, never a purge. That decision is
 * spelled out in exactly two places: MOVABLE_TO in graph-guard.ts, which is
 * what the runtime will actually let through, and DESTINATIONS here, which
 * turns the workspace's own folder words into Graph's well-known names. This
 * file never invents a third spelling.
 *
 * Which messages move is the other half, and it is not "all of them" for every
 * destination:
 *
 *   - Only messages still in a folder the workspace lists (inbox, sent) are
 *     moved at all. One already filed away — archived by the sync (0045), or
 *     by an earlier press of this same button — has nothing left to move, and
 *     asking Graph again would only spend a call to be told 404.
 *
 *   - Junk moves only mail from OUTSIDE. Reporting our own reply as junk
 *     teaches Outlook that our own address sends junk, which then filters our
 *     mail for the recipient as well as for us. Archiving or deleting a
 *     conversation takes our side of it along, the way Outlook's own
 *     conversation actions do; marking one as junk deliberately does not.
 *
 * Kept free of imports so mail-move.test.js runs it in node.
 */

/* The workspace's folder word → Graph's well-known folder name. The keys are
   mail_messages.folder's own values (0025's check constraint), so the answer
   this module gives can be handed to the database unchanged as well. */
export const DESTINATIONS: Record<string, string> = {
  archive: 'archive',
  spam: 'junkemail',
  trash: 'deleteditems',
};

/* Where a conversation may be sent from the workspace, in the workspace's own
   words: what a request body is checked against before anything else happens. */
export const MOVE_TO = Object.keys(DESTINATIONS);

/* The folders the workspace lists, and so the only ones a message can be
   moved OUT of. 'starred' is not one: it is a flag that spans folders
   (mail-model.js visibleThreads), not somewhere mail lives. */
const LIVE_FOLDERS = ['inbox', 'sent'];

export interface StoredMailMessage {
  id: string;
  external_id: string;
  direction: string;
  folder: string;
}

/* Graph's well-known name for a destination, or null when it is not one of
   the three. Callers check this before anything else, so a bad `to` never
   reaches Graph or the database. */
export function graphDestination(to: string): string | null {
  return DESTINATIONS[String(to || '').toLowerCase()] ?? null;
}

/* Which of a conversation's stored messages this move actually touches — see
   the header for why junk is narrower than the other two. Order is the
   caller's; update-mail-state's sibling function makes no promise either, and
   a move that runs out of time simply leaves the rest as the next call's
   targets, exactly as marking a long thread read already does. */
export function messagesToMove(messages: StoredMailMessage[], to: string): StoredMailMessage[] {
  if (!graphDestination(to)) return [];
  return (messages ?? []).filter((m) =>
    LIVE_FOLDERS.includes(m.folder)
    && (to !== 'spam' || m.direction === 'inbound'));
}

/* What the person is told when nothing moved and nothing went wrong: the
   conversation was already where they asked for it to be. Said rather than
   reported as a silent success, since the button will have looked like it did
   nothing. */
export function nothingToMoveNote(to: string): string {
  const where = to === 'spam' ? 'marked as junk' : to === 'trash' ? 'in Deleted Items' : 'archived';
  return `This conversation is already ${where}.`;
}
