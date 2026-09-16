/* sync-outlook-mail — pulls one folder of one connected mailbox, by hand.
 *
 * The schedule (sync-mail-scheduled) keeps every mailbox current in the
 * background. This is the manager's version — one mailbox, a longer window, a
 * chosen folder — for a first import or to fill a gap. Both store through
 * _shared/mail-sync.ts, so they cannot disagree about a row, and they take the
 * same per-mailbox lock, so they cannot run over each other. It does not touch
 * the schedule's delta cursor: a manual sync must not make the schedule skip
 * what it had not reached yet.
 *
 * Idempotent: re-running never duplicates. A customer replying to something we
 * sent carries [#VYG-142] in the subject; route_mail_to_ticket() (0035) puts
 * that reply back on its ticket.
 *
 * Only the studio's mailboxes and the caller's own (security review,
 * 2026-09-14): a colleague's personal mailbox is answered as no mailbox at all,
 * and a studio connection that is a team member's own address, records no
 * consenter, or was never checked against the directory is not read
 * (_shared/connection-check.ts).
 *
 * Deploy:  supabase functions deploy sync-outlook-mail
 * Body:    { "connectionId": "...", "days": 30, "max": 200, "folder": "inbox" | "sentitems" | "archive" }
 * Caller must be staff, and either a manager or the mailbox's own owner: a
 * deeper reach into the studio's shared mailbox is an owner or admin's call,
 * like connecting or reconnecting it (microsoft-connect); reaching further
 * back into your own personal mailbox — the usual reason to call this by
 * hand, "load older mail" having no other way in — needs nobody's say-so but
 * yours.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged } from '../_shared/graph-token.ts';
import { MAX_GAP_DAYS } from '../_shared/mail-store.ts';
import {
  claimSync, clearSyncGapNote, fetchFolder, markSyncedIfLive, recordSyncFailure, releaseSync, storeMessages,
} from '../_shared/mail-sync.ts';
import { isShared } from '../_shared/mailbox.ts';
import { mayActOn } from '../_shared/connection-rules.ts';
import { connectionCheck } from '../_shared/connection-check.ts';

/* Graph's well-known names for the folders the workspace shows. Anything else
   is refused rather than passed into a URL. */
const FOLDERS = ['inbox', 'sentitems', 'archive'];
const LIVE = ['connected', 'error'];

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
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
  const { data: isManager } = await asCaller.rpc('is_manager');
  const { data: me, error: meErr } = await asCaller.rpc('active_employee_id');
  if (meErr) return json({ error: 'Could not tell who you are: ' + meErr.message }, 500);

  const body = await req.json().catch(() => ({}));
  const connectionId = String(body?.connectionId || '');
  if (!connectionId) return json({ error: 'connectionId is required' }, 400);
  const days = Math.min(Math.max(Number(body?.days) || 30, 1), 365);
  const max = Math.min(Math.max(Number(body?.max) || 100, 1), 2000);
  const folder = String(body?.folder || 'inbox').toLowerCase();
  if (!FOLDERS.includes(folder)) return json({ error: `folder must be one of ${FOLDERS.join(', ')}` }, 400);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: conn, error: connErr } = await admin
    .from('integration_connections')
    .select('id, provider, account_label, external_id, employee_id, status, updated_at')
    .eq('id', connectionId)
    .maybeSingle();
  /* A colleague's personal mailbox is answered as no mailbox: nothing about it,
     not even that it exists. */
  if (connErr || !conn || !mayActOn(conn, typeof me === 'string' ? me : null)) {
    return json({ error: 'No such connection' }, 404);
  }
  /* mayActOn already let this through as the studio's or your own; a studio
     mailbox needs a manager on top of that (see the header). */
  if (conn.employee_id === null && isManager !== true) {
    return json({ error: 'Only an owner or admin can reach further back into a studio mailbox.' }, 403);
  }
  if (conn.provider !== 'microsoft_mail') return json({ error: 'That connection is not a mailbox' }, 400);
  if (!LIVE.includes(conn.status)) return json({ error: 'That mailbox is not connected. Reconnect it first.' }, 409);

  let problem: string | null;
  try {
    problem = await connectionCheck(admin, conn);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
  if (problem) {
    await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at);
    return json({ error: problem }, 409);
  }

  if (!(await claimSync(admin, conn.id))) {
    return json({ error: 'This mailbox is already syncing. Try again in a few minutes.' }, 409);
  }

  try {
    const token = await accessTokenFor(admin, connectionId);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const page = await fetchFolder(conn, token, folder, { since, max });
    const stored = await storeMessages(admin, conn, folder, page.items, token);

    await markSyncedIfLive(admin, connectionId);
    /* A reach further back than the schedule ever manages on its own is what
       actually fills in a recorded gap (missedRange/SYNC_GAP_NOTE) — a
       shallow "sync the last few days again" is not the same claim. */
    if (days > MAX_GAP_DAYS) await clearSyncGapNote(admin, connectionId);
    return json({
      ok: true, mailbox: conn.account_label, shared: isShared(conn), folder,
      threads: stored.threads, messages: stored.messages, routedToTickets: stored.routedToTickets,
      pages: page.pages,
      /* true when OUR cap stopped us, not the mailbox running out. */
      moreAvailable: page.moreAvailable,
      windowDays: days,
    });
  } catch (err) {
    await recordSyncFailure(admin, connectionId, err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  } finally {
    await releaseSync(admin, conn.id);
  }
});
