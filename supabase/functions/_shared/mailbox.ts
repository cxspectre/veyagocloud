/* Which mailbox a connection actually reads.
 *
 * Microsoft OAuth consent is per-USER: the token belongs to whoever signed in,
 * and `/me/messages` is THEIR mailbox. A shared mailbox — hello@veyago.cloud —
 * is a different object that the consenting user merely has Full Access to, so
 * it has to be addressed explicitly as /users/{address}.
 *
 * Getting this wrong is quiet rather than loud: /me/messages against a
 * consent given by Cassian returns Cassian's mail, cheerfully, under a
 * connection labelled hello@veyago.cloud. Nothing errors. The studio inbox
 * simply fills with the wrong correspondence.
 *
 * So a connection records both:
 *   account_label  the mailbox being read      (hello@veyago.cloud)
 *   external_id    who consented to reading it (cdrefke@veyago.cloud)
 */

export interface MailboxConnection {
  account_label: string;
  external_id?: string | null;
}

export function isShared(conn: MailboxConnection): boolean {
  const mailbox = String(conn.account_label ?? '').trim().toLowerCase();
  const owner = String(conn.external_id ?? '').trim().toLowerCase();
  /* No recorded consenter means an older connection, or one where the two are
     the same person; either way /me is right. */
  if (!owner || !mailbox) return false;
  return owner !== mailbox;
}

/* The Graph path prefix for this connection's mailbox: '/me' or
 * '/users/hello@veyago.cloud'. */
export function mailboxPath(conn: MailboxConnection): string {
  return isShared(conn)
    ? `/users/${encodeURIComponent(String(conn.account_label).trim())}`
    : '/me';
}
