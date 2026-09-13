/* update-mail-state — read and starred, in Outlook as well as here.
 *
 * Before Mail.ReadWrite, the workspace kept read and starred on its own
 * mirror, and every sync put Outlook's version back — so a conversation read
 * in the workspace was unread again five minutes later. Now the change goes
 * to Outlook first, and the sync agrees with it.
 *
 * Outlook tracks read per message and a thread is unread while any message
 * from outside is (mail-store.ts), so marking read touches each of those.
 * Starred is Outlook's flag, on the newest message from outside — the one the
 * inbox sync reads it from.
 *
 * A mailbox connected before Mail.ReadWrite answers 403. The change still
 * lands here and the caller is told Outlook did not get it, rather than the
 * star refusing to work until someone reconnects.
 *
 * Deploy:  supabase functions deploy update-mail-state
 * Body:    { "threadId": "...", "read"?: boolean, "starred"?: boolean }
 * Caller must be staff and able to see the thread.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import { GRAPH, GraphError, graphRequest } from '../_shared/mail-sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* A thread with more unread messages than this is marked in Outlook as far
   as this goes; the database change is whole either way. */
const MAX_MESSAGES = 50;

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

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);

    const body = await req.json().catch(() => ({}));
    const threadId = String(body?.threadId ?? '');
    if (!UUID.test(threadId)) return json({ error: 'threadId is required' }, 400);
    const read = typeof body?.read === 'boolean' ? body.read : undefined;
    const starred = typeof body?.starred === 'boolean' ? body.starred : undefined;
    if (read === undefined && starred === undefined) return json({ error: 'Nothing to change' }, 400);

    /* Read as the caller: a thread they cannot see is a thread they cannot change. */
    const { data: thread } = await asCaller
      .from('mail_threads')
      .select('id, connection_id')
      .eq('id', threadId)
      .maybeSingle();
    if (!thread) return json({ error: 'No such conversation' }, 404);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn } = await admin
      .from('integration_connections')
      .select('id, account_label, external_id, status')
      .eq('id', thread.connection_id)
      .maybeSingle();
    const { data: messages } = await admin
      .from('mail_messages')
      .select('external_id, direction')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: false });
    const inbound = (messages ?? []).filter((m) => m.direction === 'inbound');

    let outlook = true;
    let reason: string | null = null;
    try {
      if (!conn || conn.status === 'needs_reauth') throw new GraphError(401, 'mailbox needs reconnecting');
      const token = await accessTokenFor(admin, conn.id);
      const box = `${GRAPH}${mailboxPath(conn)}`;
      const patch = (externalId: string, change: unknown) =>
        graphRequest(`${box}/messages/${encodeURIComponent(externalId)}`, token, { method: 'PATCH', body: change });

      if (read !== undefined) {
        for (const m of inbound.slice(0, MAX_MESSAGES)) await patch(m.external_id, { isRead: read });
      }
      const flagOn = inbound[0] ?? (messages ?? [])[0];
      if (starred !== undefined && flagOn) {
        await patch(flagOn.external_id, { flag: { flagStatus: starred ? 'flagged' : 'notFlagged' } });
      }
    } catch (err) {
      if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
        outlook = false;
        reason = 'Reconnect this mailbox for read and starred to reach Outlook — until then the next sync may undo it.';
      } else if (err instanceof GraphError && err.status === 404) {
        outlook = false;
        reason = 'The message has moved in Outlook since the last sync.';
      } else {
        return json({ error: `Outlook did not take the change: ${String((err as Error).message || err)}` }, 502);
      }
    }

    /* As the caller: the column grant (0038) allows exactly these two. */
    const changes = {
      ...(read !== undefined ? { is_read: read } : {}),
      ...(starred !== undefined ? { is_starred: starred } : {}),
    };
    const { data: updated, error: updateErr } = await asCaller
      .from('mail_threads')
      .update(changes)
      .eq('id', threadId)
      .select('id, is_read, is_starred')
      .single();
    if (updateErr) return json({ error: updateErr.message }, 403);

    return json({ ok: true, thread: updated, outlook, reason });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
