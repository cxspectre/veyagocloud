/* sync-outlook-mail — pulls one folder of one connected mailbox, by hand.
 *
 * The schedule (sync-mail-scheduled) does this every five minutes for every
 * mailbox over a short window. This is the manager's version — one mailbox, a
 * longer window, a chosen folder — for a first import or to fill a gap. Both
 * store through _shared/mail-sync.ts, so they cannot disagree about a row.
 *
 * Idempotent: re-running never duplicates. A customer replying to something we
 * sent carries [#VYG-142] in the subject; route_mail_to_ticket() (0035) puts
 * that reply back on its ticket.
 *
 * Deploy:  supabase functions deploy sync-outlook-mail
 * Body:    { "connectionId": "...", "days": 30, "max": 200, "folder": "inbox" | "sentitems" | "archive" }
 * Caller must be a manager.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markSynced } from '../_shared/graph-token.ts';
import { fetchFolder, recordSyncFailure, storeMessages } from '../_shared/mail-sync.ts';
import { isShared } from '../_shared/mailbox.ts';

/* Graph's well-known names for the folders the workspace shows. Anything else
   is refused rather than passed into a URL. */
const FOLDERS = ['inbox', 'sentitems', 'archive'];

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
    const folder = String(body?.folder || 'inbox').toLowerCase();
    if (!FOLDERS.includes(folder)) return json({ error: `folder must be one of ${FOLDERS.join(', ')}` }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, provider, account_label, external_id')
      .eq('id', connectionId)
      .maybeSingle();
    if (connErr || !conn) return json({ error: 'No such connection' }, 404);
    if (conn.provider !== 'microsoft_mail') return json({ error: 'That connection is not a mailbox' }, 400);

    const token = await accessTokenFor(admin, connectionId);
    const page = await fetchFolder(conn, token, folder, { days, max });
    const stored = await storeMessages(admin, conn, folder, page.items);

    await markSynced(admin, connectionId, null);
    return json({
      ok: true, mailbox: conn.account_label, shared: isShared(conn), folder,
      threads: stored.threads, messages: stored.messages, routedToTickets: stored.routedToTickets,
      pages: page.pages,
      /* true when OUR cap stopped us, not the mailbox running out. */
      moreAvailable: page.moreAvailable,
      windowDays: days,
    });
  } catch (err) {
    const message = String((err as Error).message || err);
    if (connectionId) {
      const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await recordSyncFailure(admin, connectionId, message);
    }
    return json({ error: message }, 500);
  }
});
