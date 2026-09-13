/* sync-outlook-mail — pulls a connected mailbox into mail_threads / mail_messages.
 *
 * Idempotent: upserts on (connection_id, external_id) for threads and
 * (thread_id, external_id) for messages, so re-running never duplicates. The
 * message trigger (0025) maintains message_count, last_message_at and the CRM
 * contact match, so this function does not compute them.
 *
 * A customer replying to something we sent carries [#VYG-142] in the subject;
 * route_mail_to_ticket() (0035) puts that reply back on its ticket.
 *
 * Deploy:  supabase functions deploy sync-outlook-mail
 * Body:    { "connectionId": "...", "days": 30, "max": 200, "folder": "inbox" }
 * Caller must be a manager.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauth, markSynced } from '../_shared/graph-token.ts';
import { folderFromWellKnownName, toMailRow } from '../_shared/graph-message.ts';
import { isShared, mailboxPath } from '../_shared/mailbox.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* Graph pages with @odata.nextLink — an absolute URL that already carries the
   query and the skip token. It is passed to fetch unchanged; rebuilding it
   from parts is how people drop the token and loop on page one forever. */
async function graphUrl(href: string, token: string): Promise<any> {
  const res = await fetch(href, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) throw new Error(`Graph -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function graph(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      /* Ask Graph for UTC. Without it every dateTime comes back as a wall
         clock in a Windows timezone name that cannot be parsed reliably —
         see the header of _shared/graph-message.ts. */
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) throw new Error(`Graph ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  let connectionId = '';

  try {
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isManager } = await asCaller.rpc('is_manager');
    if (!isManager) return json({ error: 'Managers only' }, 403);

    const body = await req.json().catch(() => ({}));
    connectionId = String(body?.connectionId || '');
    if (!connectionId) return json({ error: 'connectionId is required' }, 400);
    const days = Math.min(Math.max(Number(body?.days) || 30, 1), 365);
    const max = Math.min(Math.max(Number(body?.max) || 100, 1), 2000);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, provider, account_label, external_id')
      .eq('id', connectionId)
      .maybeSingle();
    if (connErr || !conn) return json({ error: 'No such connection' }, 404);
    if (conn.provider !== 'microsoft_mail') return json({ error: 'That connection is not a mailbox' }, 400);

    const token = await accessTokenFor(admin, connectionId);

    const folder = String(body?.folder || 'inbox');
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    /* $filter does the date window server-side, so we never page through years
       of archive to find last month.

       `max` is the TOTAL across pages, not the size of one. That distinction
       is the point: the old single-request version returned the most recent
       page and looked exactly like a complete sync. */
    const PAGE = Math.min(100, max);
    const query = new URLSearchParams({
      $top: String(PAGE),
      $orderby: 'receivedDateTime desc',
      $filter: `receivedDateTime ge ${since}`,
      $select: 'id,conversationId,subject,bodyPreview,body,from,sender,toRecipients,' +
               'ccRecipients,receivedDateTime,sentDateTime,isRead,flag',
    });
    /* '/me' for a personal mailbox, '/users/hello@veyago.cloud' for a shared
       one. Getting this wrong does not error — it quietly returns the
       consenting user's own mail. See _shared/mailbox.ts. */
    const box = mailboxPath(conn);

    const items: any[] = [];
    let next: string | null =
      `${GRAPH}${box}/mailFolders/${encodeURIComponent(folder)}/messages?${query}`;
    let pages = 0;
    while (next && items.length < max) {
      /* A page ceiling as well as a message ceiling: a nextLink that kept
         returning the same page would otherwise run until the function times
         out, with nothing in the logs to say why. */
      if (++pages > 50) break;
      const batch = await graphUrl(next, token);
      for (const item of batch.value ?? []) {
        if (items.length >= max) break;
        items.push(item);
      }
      next = batch['@odata.nextLink'] ?? null;
    }

    const threadCache = new Map<string, string>();
    let threads = 0, messages = 0, routed = 0;

    for (const raw of items) {
      const row = toMailRow(raw, [conn.account_label]);

      let threadId = threadCache.get(row.thread_external_id);
      if (!threadId) {
        const { data: thread, error: threadErr } = await admin
          .from('mail_threads')
          .upsert(
            {
              connection_id: connectionId,
              external_id: row.thread_external_id,
              subject: row.subject,
              snippet: row.snippet,
              folder: folderFromWellKnownName(folder),
              is_read: row.is_read,
              is_starred: row.is_flagged,
            },
            { onConflict: 'connection_id,external_id' },
          )
          .select('id')
          .single();
        if (threadErr) throw new Error(`thread upsert: ${threadErr.message}`);
        threadId = thread.id;
        threadCache.set(row.thread_external_id, threadId!);
        threads++;
      }

      const { data: stored, error: msgErr } = await admin.from('mail_messages').upsert(
        {
          thread_id: threadId,
          external_id: row.external_id,
          direction: row.direction,
          from_name: row.from_name,
          from_email: row.from_email,
          to_emails: row.to_emails,
          cc_emails: row.cc_emails,
          subject: row.subject,
          body_text: row.body_text,
          body_html: row.body_html,
          sent_at: row.sent_at,
        },
        { onConflict: 'thread_id,external_id' },
      ).select('id').single();
      if (msgErr) throw new Error(`message upsert: ${msgErr.message}`);
      messages++;

      /* A reply to something we sent belongs on its ticket, not only in the
         inbox. Returns null for mail with no reference, which stays mail.
         A routing failure must not abandon the sync — the mail is saved, and
         the worst case is one reply someone files by hand. */
      if (row.direction === 'inbound' && stored?.id) {
        const { data: ticketId, error: routeErr } = await admin
          .rpc('route_mail_to_ticket', { p_mail_message_id: stored.id });
        if (routeErr) console.warn('[sync-outlook-mail] routing failed:', routeErr.message);
        else if (ticketId) routed++;
      }
    }

    await markSynced(admin, connectionId, null);
    return json({
      ok: true, mailbox: conn.account_label, shared: isShared(conn), folder,
      threads, messages, routedToTickets: routed, pages,
      /* true when OUR cap stopped us, not the mailbox running out. */
      moreAvailable: next !== null,
      windowDays: days,
    });
  } catch (err) {
    const message = String((err as Error).message || err);
    if (connectionId && !/Managers only|Not signed in/.test(message)) {
      try {
        const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        if (/refresh|invalid_grant|credentials/i.test(message)) {
          await markNeedsReauth(admin, connectionId, message);
        } else {
          await admin.from('integration_connections')
            .update({ status: 'error', last_error: message.slice(0, 500) })
            .eq('id', connectionId);
        }
      } catch { /* reporting the failure must not replace it */ }
    }
    return json({ error: message }, 500);
  }
});
