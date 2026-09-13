/* The rules a sync follows when it sees a conversation again.
 *
 * mail_threads is one row per conversation, but Graph hands back a
 * conversation's messages from whichever folder each one sits in. Written
 * naively — "the thread's folder is the folder we are syncing" — a sync of
 * Sent Items pulls every conversation we have replied to out of the inbox,
 * and a thread reads as read because its newest message happens to be ours.
 *
 * Kept free of imports so it can be tested in node as-is.
 */

/* Which folder a conversation belongs in, given where it already is and
 * where this sync just found one of its messages. The inbox wins: a
 * conversation with mail from outside is something someone may need to act
 * on. A sent copy never moves a conversation that already has a place. */
export function mergedFolder(existing: string | null | undefined, incoming: string): string {
  if (incoming === 'inbox') return 'inbox';
  if (!existing) return incoming;
  if (incoming === 'sent') return existing;
  return incoming;
}

/* A conversation is unread while anything from outside in it is unread. Our
 * own messages are never waiting for us, whatever Outlook says about them. */
export function threadIsRead(messages: { direction: string; is_read: boolean }[]): boolean {
  return messages
    .filter((m) => m.direction === 'inbound')
    .every((m) => m.is_read);
}

/* Messages grouped by conversation, in the order Graph returned them. */
export function groupByThread<T extends { thread_external_id: string }>(rows: T[]): Map<string, T[]> {
  const keys = [...new Set(rows.map((r) => r.thread_external_id))];
  return new Map(keys.map((key) => [key, rows.filter((r) => r.thread_external_id === key)]));
}
