/* Pulling a mailbox folder from Graph, and storing it.
 *
 * Shared by the manual sync (sync-outlook-mail), the scheduled one
 * (sync-mail-scheduled) and send-mail, which stores its own sent copy exactly
 * the way the next sync would — otherwise that sync "corrects" a row that was
 * already right, and the difference is invisible until someone diffs it.
 *
 * Idempotent: threads upsert on (connection_id, external_id), messages on
 * (thread_id, external_id). The message trigger (0025, 0037) maintains the
 * count, last activity, the sender and the CRM match. The two decisions made
 * here — which folder a conversation belongs in, and whether it is read — are
 * in mail-store.ts, where they are tested.
 */
import { MESSAGE_SELECT, folderFromWellKnownName, toMailRow, type MailRow } from './graph-message.ts';
import { groupByThread, mergedFolder, threadIsRead } from './mail-store.ts';
import { mailboxPath } from './mailbox.ts';
import { markNeedsReauth } from './graph-token.ts';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 50;

// deno-lint-ignore no-explicit-any
type Admin = any;
// deno-lint-ignore no-explicit-any
type GraphItem = any;

export interface MailConnection {
  id: string;
  account_label: string;
  external_id?: string | null;
}

/* A Graph refusal with its status kept. 401/403 is a grant without the scope
 * (a mailbox connected before Mail.ReadWrite); 404 is a message that has moved
 * since the last sync. Neither is Graph being down, and callers say so. */
export class GraphError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`Graph → ${status}: ${detail}`);
    this.status = status;
  }
}

export async function graphRequest(
  href: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<GraphItem> {
  const res = await fetch(href, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      /* UTC dates (see the header of graph-message.ts) and HTML bodies,
         whatever the mailbox's own preferences are. */
      Prefer: 'outlook.timezone="UTC", outlook.body-content-type="html"',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new GraphError(res.status, (await res.text()).slice(0, 300));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface FolderPage {
  items: GraphItem[];
  moreAvailable: boolean;
  pages: number;
}

/* Newest first, inside a window, up to `max` in total across pages. The
 * window is a $filter, so a sync never pages through years of archive. A page
 * ceiling as well as a message ceiling: a nextLink that kept returning the
 * same page would otherwise run until the function times out, with nothing in
 * the logs to say why. */
export async function fetchFolder(
  conn: MailConnection,
  token: string,
  folder: string,
  opts: { days: number; max: number },
): Promise<FolderPage> {
  const since = new Date(Date.now() - opts.days * 86400_000).toISOString();
  const query = new URLSearchParams({
    $top: String(Math.min(100, opts.max)),
    $orderby: 'receivedDateTime desc',
    $filter: `receivedDateTime ge ${since}`,
    $select: MESSAGE_SELECT,
  });
  /* '/me' or '/users/hello@veyago.cloud' — getting this wrong does not error,
     it quietly reads the consenting person's own mail (see mailbox.ts). The
     nextLink is passed to fetch unchanged: it already carries the query and
     the skip token, and rebuilding it is how a sync loops on page one. */
  let next: string | null =
    `${GRAPH}${mailboxPath(conn)}/mailFolders/${encodeURIComponent(folder)}/messages?${query}`;
  let items: GraphItem[] = [];
  let pages = 0;
  while (next && items.length < opts.max && pages < MAX_PAGES) {
    pages += 1;
    const batch = await graphRequest(next, token);
    items = [...items, ...(batch?.value ?? [])].slice(0, opts.max);
    next = batch?.['@odata.nextLink'] ?? null;
  }
  return { items, moreAvailable: next !== null, pages };
}

export interface StoreResult {
  threads: number;
  messages: number;
  routedToTickets: number;
  /* Graph conversation id → our thread id. */
  threadIds: Map<string, string>;
}

export async function storeMessages(
  admin: Admin,
  conn: MailConnection,
  graphFolder: string,
  items: GraphItem[],
): Promise<StoreResult> {
  const folder = folderFromWellKnownName(graphFolder);
  const rows: MailRow[] = items.map((raw) => toMailRow(raw, [conn.account_label]));
  const threadIds = new Map<string, string>();
  let messages = 0;
  let routed = 0;

  for (const [externalId, group] of groupByThread(rows)) {
    const threadId = await storeThread(admin, conn, externalId, folder, group);
    threadIds.set(externalId, threadId);

    for (const row of group) {
      const storedId = await storeMessage(admin, threadId, row);
      messages += 1;
      /* A reply to something we sent belongs on its ticket, not only in the
         inbox. A routing failure must not abandon the sync — the mail is
         saved, and the worst case is one reply someone files by hand. */
      if (row.direction === 'inbound' && storedId) {
        const { data: ticketId, error } = await admin
          .rpc('route_mail_to_ticket', { p_mail_message_id: storedId });
        if (error) console.warn('[mail-sync] routing failed:', error.message);
        else if (ticketId) routed += 1;
      }
    }
  }

  return { threads: threadIds.size, messages, routedToTickets: routed, threadIds };
}

async function storeThread(
  admin: Admin,
  conn: MailConnection,
  externalId: string,
  folder: string,
  group: MailRow[],
): Promise<string> {
  const { data: existing, error: readErr } = await admin
    .from('mail_threads')
    .select('folder, is_read, is_starred, last_message_at')
    .eq('connection_id', conn.id)
    .eq('external_id', externalId)
    .maybeSingle();
  if (readErr) throw new Error(`thread read: ${readErr.message}`);

  const newest = group[0];                                  // Graph returns newest first
  const fromInbox = folder === 'inbox';
  /* Subject and preview follow the newest message we know of: a Sent Items
     sync must not replace them with an older reply of ours. */
  const isNewest = !existing?.last_message_at
    || newest.sent_at >= new Date(existing.last_message_at).toISOString();

  const { data: thread, error } = await admin
    .from('mail_threads')
    .upsert({
      connection_id: conn.id,
      external_id: externalId,
      folder: mergedFolder(existing?.folder, folder),
      ...(isNewest ? { subject: newest.subject, snippet: newest.snippet } : {}),
      /* Read and flagged are the inbox's to say — Outlook's state there is the
         reader's. A Sent Items sync leaves them as they are. */
      is_read: fromInbox ? threadIsRead(group) : (existing?.is_read ?? true),
      is_starred: fromInbox ? group.some((r) => r.is_flagged) : (existing?.is_starred ?? false),
    }, { onConflict: 'connection_id,external_id' })
    .select('id')
    .single();
  if (error) throw new Error(`thread upsert: ${error.message}`);
  return thread.id;
}

async function storeMessage(admin: Admin, threadId: string, row: MailRow): Promise<string | null> {
  /* The same message under a new Graph id — moved between folders in Outlook,
     or a draft that has since been sent — is the row we already have. Point
     it at the new id instead of storing the message twice. */
  if (row.internet_message_id) {
    const { error: moveErr } = await admin
      .from('mail_messages')
      .update({ external_id: row.external_id })
      .eq('thread_id', threadId)
      .eq('internet_message_id', row.internet_message_id)
      .neq('external_id', row.external_id);
    if (moveErr) console.warn('[mail-sync] could not re-point a moved message:', moveErr.message);
  }

  const { data, error } = await admin
    .from('mail_messages')
    .upsert({
      thread_id: threadId,
      external_id: row.external_id,
      internet_message_id: row.internet_message_id,
      direction: row.direction,
      from_name: row.from_name,
      from_email: row.from_email,
      to_emails: row.to_emails,
      cc_emails: row.cc_emails,
      bcc_emails: row.bcc_emails,
      subject: row.subject,
      body_text: row.body_text,
      body_html: row.body_html,
      sent_at: row.sent_at,
      importance: row.importance,
      has_attachments: row.has_attachments,
    }, { onConflict: 'thread_id,external_id' })
    .select('id')
    .single();
  if (error) throw new Error(`message upsert: ${error.message}`);
  return data?.id ?? null;
}

/* A failed sync flags its connection, so the workspace can say which mailbox
 * is stuck and why. invalid_grant — revoked, password changed, conditional
 * access — goes to needs_reauth, because no retry will fix it; anything else
 * is 'error', which the schedule tries again. Reporting the failure must not
 * replace it. */
export async function recordSyncFailure(admin: Admin, connectionId: string, message: string): Promise<void> {
  try {
    if (/refresh|invalid_grant|credentials/i.test(message)) {
      await markNeedsReauth(admin, connectionId, message);
    } else {
      await admin.from('integration_connections')
        .update({ status: 'error', last_error: message.slice(0, 500) })
        .eq('id', connectionId);
    }
  } catch { /* the original failure is what the caller reports */ }
}
