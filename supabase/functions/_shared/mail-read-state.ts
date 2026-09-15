/* mail-read-state.ts — which messages a read or starred change touches.
 *
 * update-mail-state derives a thread's read and starred state from its
 * messages (refresh_mail_thread_state, 0038): unread while a message from
 * outside is unread, starred while any message is flagged. Marking a long
 * thread read used to cap at fifty Outlook PATCH calls (MAX_MESSAGES) and then
 * write every message read in the database regardless — a thread reported
 * "done" while most of it stayed unread in Outlook, with nothing to notice the
 * gap until a full resync. Targeting only messages not already at the wanted
 * state means the database is only ever told what Outlook was actually asked
 * to change, and a call cut short by a time budget leaves exactly the rest as
 * the next call's targets — no re-sending Outlook a change it already has.
 *
 * Kept free of imports so mail-read-state.test.js runs it in node.
 */

export interface StoredMessage {
  id: string;
  external_id: string;
  direction: string;
  is_read: boolean;
  is_flagged: boolean;
}

/* Only mail from outside has an "unread" Outlook cares about; an outbound
   copy's isRead is not what a person marking a thread read means. Already at
   the wanted state is left out, so a retry — or a second click — does not
   re-patch messages Outlook and the store already agree on. */
export function messagesToMarkRead(messages: StoredMessage[], read: boolean | undefined): StoredMessage[] {
  if (read === undefined) return [];
  return messages.filter((m) => m.direction === 'inbound' && m.is_read !== read);
}

/* The one message starring touches: the newest from outside, or — a thread
   that is entirely our own — the newest of ours. `messages` is given newest
   first (update-mail-state orders by sent_at descending), so this is simply
   the first match. */
export function messageToFlag(messages: StoredMessage[]): StoredMessage | null {
  return messages.find((m) => m.direction === 'inbound') ?? messages[0] ?? null;
}

/* Starring is a single flag, and only sent when it is not already set. */
export function messagesToFlag(messages: StoredMessage[], starred: boolean | undefined): StoredMessage[] {
  if (starred !== true) return [];
  const flagOn = messageToFlag(messages);
  return flagOn && !flagOn.is_flagged ? [flagOn] : [];
}

/* Un-starring clears every flag in the conversation — leaving an older one let
   the next sync find it and star the thread again — and reaches the same
   message starring would use even when it was never flagged, in case the
   store's own is_flagged has drifted from what Outlook actually holds. */
export function messagesToUnflag(messages: StoredMessage[], starred: boolean | undefined): StoredMessage[] {
  if (starred !== false) return [];
  const flagOn = messageToFlag(messages);
  return messages.filter((m) => m.is_flagged || m === flagOn);
}
