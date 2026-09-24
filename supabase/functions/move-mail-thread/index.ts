/* move-mail-thread — archive a conversation, mark it as junk, or delete it.
 *
 * Until 2026-09-21 nothing here could move mail at all: graph-guard.ts refused
 * it outright, and the only way a conversation ever left the workspace inbox
 * was somebody archiving it in Outlook and the sync noticing (0045). The owner
 * then decided the workspace may archive, mark as junk and delete, where
 * DELETE MEANS A MOVE TO DELETED ITEMS AND NOTHING ELSE. Nothing in this
 * function, in graph-guard.ts or in 0069 may ever purge a message: the guard's
 * own MOVABLE_TO list is the whole of what "delete" is allowed to mean, and
 * Outlook's purge folders are not on it.
 *
 * Outlook first, then the store — and not the other way round, unlike the read
 * and starred writer this file is otherwise shaped after (update-mail-state).
 * That function keeps a change here when Outlook cannot be reached, because a
 * read flag the next sync undoes is a small loss. A MOVE cannot work that way:
 * filing a message here that Graph never moved leaves it in Outlook's inbox,
 * where the very next delta stores it back under 'inbox' (store_mail_batch)
 * and the conversation reappears — the button would look like it worked and
 * then silently undo itself minutes later. So a mailbox that is disconnected,
 * waiting to be reconnected, or short of the scope is told plainly that the
 * move cannot happen, and nothing is written.
 *
 * A move changes the message's Graph id. POST /messages/{id}/move answers with
 * the moved message under a NEW id, and both mail-attachment-content (0063)
 * and update-mail-state address a message by the id we stored — so the new one
 * is carried into mail_moved() and written, rather than leaving a stale id for
 * whoever next opens an attachment on that conversation.
 *
 * Which messages move is _shared/mail-move.ts's decision, not this file's:
 * only ones still in a folder the workspace lists, and — for junk — only mail
 * from outside, since reporting our own reply as junk teaches Outlook that our
 * own address sends junk. A long conversation runs against OUTLOOK_BUDGET_MS
 * the same way marking one read does, and says so (`incomplete`): what was
 * moved is recorded, and asking again targets only what is left, because a
 * message already filed is no longer a target.
 *
 * Deploy:  supabase functions deploy move-mail-thread
 * Body:    { "threadId": "...", "to": "archive" | "spam" | "trash" }
 * Caller must be staff and able to see the thread.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged } from '../_shared/graph-token.ts';
import { connectionCheck } from '../_shared/connection-check.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import { GRAPH, GraphError, graphRequest } from '../_shared/mail-sync.ts';
import {
  MOVE_TO, graphDestination, messagesToMove, nothingToMoveNote, type StoredMailMessage,
} from '../_shared/mail-move.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* Comfortably inside the platform's own limit on how long a request may run,
   leaving room for the database write that comes after — the same margin
   update-mail-state keeps for exactly the same reason. */
const OUTLOOK_BUDGET_MS = 90_000;

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

/* What the person is told when the mailbox itself is why nothing happened.
   Each one ends at the same place: nothing was written, so the workspace and
   Outlook still agree about where this conversation is. */
const MAILBOX_REFUSALS: Record<string, string> = {
  disconnected: 'This mailbox is disconnected, so nothing can be moved in Outlook. Connect it again first.',
  waiting: 'This mailbox needs reconnecting before mail can be moved in Outlook.',
  unchecked: 'Outlook could not be reached just now, so nothing was moved. Try again in a moment.',
  scope: 'Reconnect this mailbox to let the workspace file mail in Outlook — until then nothing is moved.',
};

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
    const to = String(body?.to ?? '').toLowerCase();
    const destination = graphDestination(to);
    if (!destination) return json({ error: `to must be one of ${MOVE_TO.join(', ')}` }, 400);

    /* Read as the caller: a thread they cannot see is a thread they cannot
       move. A read that FAILED is not "no such thread" — treated so, someone
       would be told their own conversation does not exist. */
    const { data: thread, error: threadErr } = await asCaller
      .from('mail_threads')
      .select('id, connection_id')
      .eq('id', threadId)
      .maybeSingle();
    if (threadErr) return json({ error: threadErr.message }, 500);
    if (!thread) return json({ error: 'No such conversation' }, 404);

    /* Its messages, also as the caller — mail_thread_placement() is security
       invoker (0069), so mail_messages' own policy decides — and without a
       single message body: a conversation of twenty HTML emails is megabytes
       this operation has no use for. */
    const { data: stored, error: storedErr } = await asCaller
      .rpc('mail_thread_placement', { p_thread: threadId });
    if (storedErr) return json({ error: storedErr.message }, 500);
    const messages: StoredMailMessage[] = stored ?? [];
    const targets = messagesToMove(messages, to);
    if (!targets.length) return json({ ok: true, moved: 0, thread: null, reason: nothingToMoveNote(to) });

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .select('id, account_label, external_id, employee_id, status, updated_at')
      .eq('id', thread.connection_id)
      .maybeSingle();
    if (connErr) return json({ error: connErr.message }, 500);

    /* Every reason the mailbox itself makes this impossible, settled before a
       single message is touched — so a conversation is never left half moved
       because the mailbox turned out to be unusable on message three. */
    if (!conn || conn.status === 'disconnected') return json({ error: MAILBOX_REFUSALS.disconnected }, 409);
    if (!['connected', 'error'].includes(conn.status)) return json({ error: MAILBOX_REFUSALS.waiting }, 409);
    /* A studio mailbox that is really someone's own would move that person's
       Outlook mail (connection-check.ts), which is emphatically not what a
       button in the workspace means. */
    let problem: string | null;
    try {
      problem = await connectionCheck(admin, conn);
    } catch {
      return json({ error: MAILBOX_REFUSALS.unchecked }, 503);
    }
    if (problem) {
      await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at).catch(() => false);
      return json({ error: MAILBOX_REFUSALS.waiting }, 409);
    }

    const token = await accessTokenFor(admin, conn.id);
    const box = `${GRAPH}${mailboxPath(conn)}`;
    const deadline = Date.now() + OUTLOOK_BUDGET_MS;

    /* What Graph actually took, and the new id it answered with. Built up as
       it goes rather than assumed afterwards: a run cut short by the clock,
       or one that hit a message already gone, records exactly what happened
       and nothing more. */
    let moves: Array<{ id: string; external_id: string }> = [];
    let gone = 0;
    let timedOut = false;
    let failure: string | null = null;

    for (const m of targets) {
      if (Date.now() >= deadline) { timedOut = true; break; }
      try {
        const answer = await graphRequest(`${box}/messages/${encodeURIComponent(m.external_id)}/move`, token, {
          method: 'POST', body: { destinationId: destination },
        });
        /* Graph answers with the message under its new id. Falling back to
           the old one keeps the row pointing somewhere rather than at an
           empty string, and the daily inbox comparison (0045) settles it. */
        moves = [...moves, { id: m.id, external_id: String(answer?.id ?? m.external_id) }];
      } catch (err) {
        /* Already moved in Outlook since the last sync: there is nothing left
           at that id to move, and guessing where it went would be worse than
           leaving the row for the sync to correct. Skipped, not fatal. */
        if (err instanceof GraphError && err.status === 404) { gone += 1; continue; }
        if (err instanceof GraphError && (err.status === 401 || err.status === 403)) {
          failure = MAILBOX_REFUSALS.scope;
          break;
        }
        /* Anything else — Graph throttling, Graph down — stops the run. What
           already moved is still recorded below: those messages really are
           somewhere else now, and leaving the store saying otherwise is the
           one outcome worth avoiding. */
        failure = `Outlook did not take the move: ${String((err as Error).message || err)}`;
        break;
      }
    }

    /* Nothing moved and something went wrong: nothing to record, so say so
       plainly rather than reporting a success with a zero in it. */
    if (!moves.length && failure) return json({ error: failure }, 502);

    const { data: row, error: moveErr } = await admin.rpc('mail_moved', {
      p_thread: threadId, p_to: to, p_moves: moves,
    });
    if (moveErr) return json({ error: moveErr.message }, 500);

    const left = targets.length - moves.length - gone;
    const notes = [
      failure,
      gone ? `${gone} message${gone === 1 ? ' had' : 's had'} already moved in Outlook.` : null,
      timedOut
        ? `Outlook is answering slowly, so ${left} more message${left === 1 ? ' is' : 's are'} left — ask again to finish.`
        : null,
    ].filter(Boolean);

    return json({
      ok: true,
      moved: moves.length,
      thread: row ? { id: row.id, folder: row.folder, is_read: row.is_read, is_starred: row.is_starred } : null,
      reason: notes.length ? notes.join(' ') : null,
      incomplete: timedOut || Boolean(failure),
    });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
