/* Fetching an attachment's actual bytes from Microsoft Graph.
 *
 * mail_attachments (0055) only ever stored metadata — name, content type,
 * size, and, for an inline image, its cid. Its own comment said why:
 * fetching every attachment's bytes on every five-minute sync would turn a
 * handful of PDFs into megabytes moved around for no reader. So the bytes
 * stay at Graph until something actually asks for them — a person opening a
 * message (mail-attachment-content, on demand) or a customer's email
 * becoming a ticket (carry-ticket-attachments, once, when it does) — and
 * this is the one place both ask from.
 *
 * Graph's list endpoint (graph-message.ts's ATTACHMENT_SELECT) never returns
 * content; the $value suffix on one attachment's own URL does, as the raw
 * bytes with no JSON envelope. That is also the one Graph shape
 * graphRequest() (mail-sync.ts) cannot serve — it always JSON.parses the
 * response body — so this keeps its own minimal fetch rather than stretching
 * that one to cover both, while still going through assertGraphCall() first:
 * every Graph call this project makes is checked there, whatever asks.
 *
 * Not unit-tested: it is a real network call, the same line this project
 * already draws for graphRequest() and fetchFolder() in mail-sync.ts, neither
 * of which has one either — verified instead by reading it against the same
 * Graph endpoint shape those two use. The pure logic beside it that CAN be
 * tested without a network — the storage name and path an attachment lands
 * under — lives in attachment-storage.ts instead, which is kept import-free
 * on purpose (see graph-guard.ts's own header) so it can be.
 */
import { assertGraphCall } from './graph-guard.ts';
import { GRAPH, GraphError } from './mail-sync.ts';
import { mailboxPath, type MailboxConnection } from './mailbox.ts';

export function attachmentContentUrl(
  conn: MailboxConnection,
  graphMessageId: string,
  graphAttachmentId: string,
): string {
  return `${GRAPH}${mailboxPath(conn)}/messages/${encodeURIComponent(graphMessageId)}`
    + `/attachments/${encodeURIComponent(graphAttachmentId)}/$value`;
}

export async function fetchAttachmentContent(
  conn: MailboxConnection,
  token: string,
  graphMessageId: string,
  graphAttachmentId: string,
): Promise<Uint8Array> {
  const href = attachmentContentUrl(conn, graphMessageId, graphAttachmentId);
  assertGraphCall('GET', href);
  const res = await fetch(href, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GraphError(res.status, (await res.text()).slice(0, 300));
  return new Uint8Array(await res.arrayBuffer());
}
