/* update-mail-state — read and starred, in Outlook as well as here.
 *
 * Before Mail.ReadWrite, the workspace kept read and starred on its own
 * mirror, and every sync put Outlook's version back — so a conversation read
 * in the workspace was unread again five minutes later. Now the change goes
 * to Outlook first, then to the stored messages, then to the thread.
 *
 * The thread's state is derived from its messages (store_mail_batch, 0038):
 * unread while any message from outside is unread, starred while any message
 * is flagged. So marking read touches every message from outside; starring
 * flags the newest one; un-starring clears every flag in the conversation —
 * clearing only the newest let the next sync find an older flag and star the
 * thread again. mail-read-state.ts decides exactly which stored messages
 * that is, from their own current is_read/is_flagged, so a message already at
 * the wanted state is never re-sent to Outlook.
 *
 * A long thread used to cap at fifty Outlook PATCH calls and then mark every
 * message read in the database regardless of how many of those fifty actually
 * went through — reporting success while most of a busy thread stayed unread
 * in Outlook, with nothing to notice the mismatch short of a full resync.
 * Instead this runs for OUTLOOK_BUDGET_MS and writes the database only for
 * what Outlook was actually told: a call cut short by the clock is truthful
 * about it (`incomplete`), and asking again targets only what is left,
 * because the messages already brought in line are no longer targets.
 *
 * A mailbox connected before Mail.ReadWrite answers 403. The change still
 * lands here and the caller is told Outlook did not get it, rather than the
 * star refusing to work until someone reconnects. A message that has moved in
 * Outlook since the last sync is skipped, not a reason to stop.
 *
 * Deploy:  supabase functions deploy update-mail-state
 * Body:    { "threadId": "...", "read"?: boolean, "starred"?: boolean }
 * Caller must be staff and able to see the thread.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged } from '../_shared/graph-token.ts';
import { connectionCheck } from '../_shared/connection-check.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import { GRAPH, GraphError, graphRequest } from '../_shared/mail-sync.ts';
import { messagesToFlag, messagesToMarkRead, messagesToUnflag, type StoredMessage } from '../_shared/mail-read-state.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* Comfortably inside the platform's own limit on how long a request may run,
   leaving room for the database writes that come after (SYNC_LEASE_SECONDS in
   mail-sync.ts is the same margin for the scheduled sync). */
const OUTLOOK_BUDGET_MS = 90_000;
/* Ids per database update, so a long conversation never makes a URL too long. */
const ID_CHUNK = 100;

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

// deno-lint-ignore no-explicit-any
async function updateMessages(admin: any, ids: string[], change: Record<string, boolean>): Promise<string | null> {
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const { error } = await admin.from('mail_messages').update(change).in('id', ids.slice(start, start + ID_CHUNK));
    if (error) return error.message;
  }
  return null;
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
    /* A read that failed is not "no such thread", nor "no messages": treated
       so, the thread would change while its messages and Outlook did not. */
    const { data: thread, error: threadErr } = await asCaller
      .from('mail_threads')
      .select('id, connection_id')
      .eq('id', threadId)
      .maybeSingle();
    if (threadErr) return json({ error: threadErr.message }, 500);
    if (!thread) return json({ error: 'No such conversation' }, 404);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, account_label, external_id, employee_id, status, updated_at')
      .eq('id', thread.connection_id)
      .maybeSingle();
    if (connErr) return json({ error: connErr.message }, 500);
    const { data: stored, error: storedErr } = await admin
      .from('mail_messages')
      .select('id, external_id, direction, is_read, is_flagged')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: false });
    if (storedErr) return json({ error: storedErr.message }, 500);
    const messages: StoredMessage[] = stored ?? [];

    /* Which messages change, and how — only the ones not already at the
       wanted state (mail-read-state.ts), so a retry after a timed-out call
       below asks Outlook for nothing it already has. */
    const readTargets = messagesToMarkRead(messages, read);
    const flagTargets = [...messagesToFlag(messages, starred), ...messagesToUnflag(messages, starred)];

    /* What actually got patched in Outlook — or, for a message gone 404,
       nothing left there to disagree with us — so the database is only ever
       told what Outlook was actually asked to change. In the branches below
       that give up on Outlook entirely for the whole thread (disconnected,
       waiting, unchecked, no scope) this is set to the full target lists
       instead: the change still lands here on purpose, and setting a value a
       message already has is harmless either way. */
    let readDone: StoredMessage[] = [];
    let flagDone: StoredMessage[] = [];
    let timedOut = false;

    let outlook = true;
    let reason: string | null = null;
    let moved = 0;
    /* Switched off on purpose: no sync runs on it, so the change here stays —
       and saying "reconnect" would invite undoing a deliberate disconnect. */
    const switchedOff = new Error('mailbox disconnected');
    /* Waiting for a reconnect: no sync runs on it either, so the change here
       stays as it is until then. */
    const waiting = new Error('mailbox waiting for a reconnect');
    /* Whose mailbox this is could not be checked just now. Outlook is left
       alone, and the change is still kept here rather than lost. */
    const unchecked = new Error('mailbox not checked');
    try {
      if (!conn || conn.status === 'disconnected') throw switchedOff;
      if (!['connected', 'error'].includes(conn.status)) throw waiting;
      /* A studio mailbox that is really someone's own would change that
         person's Outlook (connection-check.ts): the change stays here, and the
         mailbox waits for a reconnect. */
      let problem: string | null;
      try {
        problem = await connectionCheck(admin, conn);
      } catch {
        throw unchecked;
      }
      if (problem) {
        await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at).catch(() => false);
        throw waiting;
      }
      const token = await accessTokenFor(admin, conn.id);
      const box = `${GRAPH}${mailboxPath(conn)}`;
      const patch = async (m: StoredMessage, change: unknown) => {
        try {
          await graphRequest(`${box}/messages/${encodeURIComponent(m.external_id)}`, token, { method: 'PATCH', body: change });
        } catch (err) {
          /* Moved in Outlook since the last sync: skip it, keep going. */
          if (err instanceof GraphError && err.status === 404) { moved += 1; return; }
          throw err;
        }
      };

      const deadline = Date.now() + OUTLOOK_BUDGET_MS;
      for (const m of readTargets) {
        if (Date.now() >= deadline) { timedOut = true; break; }
        await patch(m, { isRead: read });
        readDone = [...readDone, m];
      }
      if (!timedOut) {
        for (const m of flagTargets) {
          if (Date.now() >= deadline) { timedOut = true; break; }
          await patch(m, { flag: { flagStatus: starred ? 'flagged' : 'notFlagged' } });
          flagDone = [...flagDone, m];
        }
      }

      if (moved) reason = `${moved} message${moved === 1 ? ' has' : 's have'} moved in Outlook since the last sync.`;
      if (timedOut) {
        const left = (readTargets.length - readDone.length) + (flagTargets.length - flagDone.length);
        const timeoutNote = `Outlook is answering slowly, so ${left} more message${left === 1 ? '' : 's'} `
          + 'are left — ask again to finish, and only what is left will be sent.';
        reason = reason ? `${reason} ${timeoutNote}` : timeoutNote;
      }
    } catch (err) {
      if (err === switchedOff) {
        outlook = false;
        reason = 'This mailbox is disconnected, so the change stays in the workspace and does not reach Outlook.';
        readDone = readTargets; flagDone = flagTargets;
      } else if (err === waiting) {
        outlook = false;
        reason = 'This mailbox needs reconnecting, so the change stays in the workspace only — and a sync after reconnecting may undo it.';
        readDone = readTargets; flagDone = flagTargets;
      } else if (err === unchecked) {
        outlook = false;
        reason = 'Outlook could not be updated just now, so the next sync may undo this.';
        readDone = readTargets; flagDone = flagTargets;
      } else if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
        outlook = false;
        reason = 'Reconnect this mailbox for read and starred to reach Outlook — until then the next sync may undo it.';
        readDone = readTargets; flagDone = flagTargets;
      } else {
        return json({ error: `Outlook did not take the change: ${String((err as Error).message || err)}` }, 502);
      }
    }

    /* The stored messages, which the thread's state is derived from. The
       browser has no write on mail_messages; this is the service role. Only
       the messages Outlook was actually told about (readDone/flagDone) — a
       message this call ran out of time for, or one a sync stored since
       Outlook was last asked, is left exactly as it was, so the store and
       Outlook are never made to disagree by a change that only landed on one
       side of it. */
    const updates: Array<[string[], Record<string, boolean>]> = [
      ...(read !== undefined && readDone.length ? [[readDone.map((m) => m.id), { is_read: read }]] : []),
      ...(starred !== undefined && flagDone.length ? [[flagDone.map((m) => m.id), { is_flagged: starred }]] : []),
    ] as Array<[string[], Record<string, boolean>]>;
    for (const [ids, change] of updates) {
      const failed = await updateMessages(admin, ids, change);
      if (failed) return json({ error: failed }, 500);
    }

    /* The thread, worked out again from its messages the way every sync does
       it (refresh_mail_thread_state, 0038) — not written from this request.
       A message a sync stored after the read above still counts, so the
       thread stays unread for it instead of hiding it. The caller's right to
       this thread was settled when it was read, as the caller. */
    const { data: refreshed, error: refreshErr } = await admin
      .rpc('refresh_mail_thread_state', { p_threads: [threadId] });
    if (refreshErr) return json({ error: refreshErr.message }, 500);
    const row = (refreshed ?? [])[0];
    const state = row ? { id: row.id, is_read: row.is_read, is_starred: row.is_starred } : null;

    return json({ ok: true, thread: state, outlook, reason, incomplete: timedOut });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
