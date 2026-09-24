/* sync-mail-scheduled — what pg_cron calls every five minutes (0038 §9).
 *
 * One mailbox per request: the schedule sends one request per connected
 * mailbox, so a slow or stuck one cannot use up the time of the others.
 *
 * It follows Graph's delta for Inbox and Sent Items — new mail, read and flag
 * changes made in Outlook, and mail deleted, archived or moved out of the inbox
 * there, which leaves the workspace inbox too (0045) — one folder at a time;
 * and once a day it compares the inbox with Outlook's, for what the delta
 * never reported (inbox-sweep.ts). The folders go through syncFolder()
 * (_shared/delta-loop.ts), which saves the link to carry on from after every
 * stored page. A burst of changes bigger than one run ("mark all as read" on a
 * busy inbox) is worked through over several runs instead of being re-read
 * from the top, and a folder that fails does not stop the other.
 *
 * The saved links are for one mailbox path (/me or /users/…). If the
 * connection now reads a different one — a reconnect recorded who consented —
 * they are not followed, and each folder starts a new round.
 *
 * A schedule has no user to sign in as, so this is deployed --no-verify-jwt
 * and checks a shared secret instead. It is not handed the service-role key:
 * a leaked cron header should be able to trigger a sync, not read everything.
 *
 * Deploy:  supabase functions deploy sync-mail-scheduled --no-verify-jwt
 * Secrets: supabase secrets set MAIL_SYNC_SECRET=$(openssl rand -hex 32)
 *          …and the same value in Vault as mail_sync_secret (see 0038 §9).
 * Header:  x-sync-secret: <MAIL_SYNC_SECRET>
 * Body:    { "connectionId": "..." }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markNeedsReauthIfUnchanged } from '../_shared/graph-token.ts';
import { connectionCheck } from '../_shared/connection-check.ts';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { mailboxPath } from '../_shared/mailbox.ts';
import { missedRange, readCursors, roundStart, withCursor } from '../_shared/mail-store.ts';
import { syncFolder, type FolderResult } from '../_shared/delta-loop.ts';
import {
  SYNC_GAP_NOTE, UNCONFIRMED_NOTE, claimSync, dailyInboxSweep, fetchDeltaPage, markLeftFolder, markSyncedIfLive,
  recordSyncFailure, releaseSync, saveCursor, storeMessages,
} from '../_shared/mail-sync.ts';

const FOLDERS = ['inbox', 'sentitems'];
/* 10 pages of 50 per folder per run; anything past that carries on next run. */
const MAX_PAGES_PER_FOLDER = 10;
/* The platform stops a request after about 150 s, and a stopped run releases
   nothing and records nothing. Work stops starting after 90 s, and the daily
   comparison only starts with a minute still in hand. */
const RUN_BUDGET_MS = 90_000;
const SWEEP_NEEDS_MS = 60_000;
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* An unset — or guessable — secret must never mean "anyone may call". */
  const expected = Deno.env.get('MAIL_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (expected.length < MIN_SECRET_LENGTH || !timingSafeEqual(given, expected)) {
    return json({ error: 'Not allowed' }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const connectionId = String(body?.connectionId ?? '');
  if (!UUID.test(connectionId)) return json({ error: 'connectionId is required' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: conn, error } = await admin
    .from('integration_connections')
    .select('id, provider, account_label, external_id, employee_id, status, updated_at, sync_cursor, delta_synced_at')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!conn || conn.provider !== 'microsoft_mail') return json({ error: 'No such mailbox' }, 404);

  /* needs_reauth is skipped: a refused grant does not come back by retrying.
     'error' is retried — it is usually Graph having a moment. */
  if (!['connected', 'error'].includes(conn.status)) return json({ ok: true, skipped: conn.status });

  /* A studio mailbox that is a team member's own address, records no
     consenter, or was never checked against the directory is not read: every
     member of staff would see that person's mail (_shared/connection-check.ts).
     It waits for a reconnect instead. */
  let problem: string | null;
  try {
    problem = await connectionCheck(admin, conn);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 500);
  }
  if (problem) {
    await markNeedsReauthIfUnchanged(admin, conn.id, problem, conn.updated_at);
    return json({ ok: false, skipped: 'needs_reauth', error: problem }, 409);
  }
  if (!(await claimSync(admin, conn.id))) return json({ ok: true, skipped: 'already syncing' });

  const deadline = Date.now() + RUN_BUDGET_MS;
  try {
    const token = await accessTokenFor(admin, conn.id);
    const mailbox = mailboxPath(conn);
    /* From when this schedule last finished a whole run — not last_synced_at,
       which a manual sync of one folder also moves. */
    const since = roundStart(Date.now(), conn.delta_synced_at);
    /* What roundStart's own fourteen-day cap is about to leave out — read
       before this run moves delta_synced_at forward, or the gap this run is
       about to close would already look closed. */
    const gap = missedRange(Date.now(), conn.delta_synced_at);
    let cursor: string = conn.sync_cursor ?? '';
    let folders: Record<string, FolderResult> = {};

    for (const folder of FOLDERS) {
      const result = await syncFolder(
        readCursors(cursor, mailbox)[folder] ?? { link: null, failures: 0 },
        {
          fetchPage: (from) => fetchDeltaPage(conn, token, folder, from, since),
          store: (items) => storeMessages(admin, conn, folder, items, token),
          leave: (ids) => markLeftFolder(admin, conn, folder, ids, token, deadline),
          save: async (next) => {
            const updated = withCursor(cursor, mailbox, folder, next);
            await saveCursor(admin, conn.id, updated);
            cursor = updated;
          },
        },
        MAX_PAGES_PER_FOLDER,
        deadline,
      );
      folders = { ...folders, [folder]: result };
    }

    const failed = FOLDERS.filter((folder) => folders[folder].error);
    if (failed.length) {
      const message = failed.map((folder) => `${folder}: ${folders[folder].error}`).join(' · ');
      await recordSyncFailure(admin, conn.id, new Error(message));
      return json({ ok: false, mailbox: conn.account_label, folders, error: message }, 500);
    }

    /* A folder still working through a burst, or reading a page again for
       Graph, has not stored everything up to now: delta_synced_at — where a
       round that starts again reaches back to — moves only once both have
       caught up. What a folder went on without is said in last_error. */
    const caughtUp = FOLDERS.every((folder) => folders[folder].caughtUp);
    const unconfirmed = FOLDERS
      .filter((folder) => folders[folder].unconfirmed)
      .map((folder) => `${folder}: ${folders[folder].unconfirmed}`)
      .join(' · ');
    if (unconfirmed) console.warn(`[sync-mail-scheduled] ${conn.id}: ${unconfirmed}`);
    if (gap) {
      console.warn(`[sync-mail-scheduled] ${conn.id}: a sync gap from ${gap.from} to ${gap.to} was not filled in`);
    }
    const notes = [
      unconfirmed ? `${UNCONFIRMED_NOTE}${unconfirmed}` : null,
      /* The day alone reads better than a full timestamp, and this is a note
         for a person, not a value anything parses back. */
      gap ? `${SYNC_GAP_NOTE}mail from before ${gap.from.slice(0, 10)} may be missing — this mailbox `
        + 'was away longer than the schedule reaches back on its own. A manual sync reaching further '
        + 'back fills it in.' : null,
    ].filter(Boolean).join(' · ');
    await markSyncedIfLive(admin, conn.id, { delta: caughtUp, note: notes || null });

    /* Once a day, the inbox against Outlook's, for what the delta never
       reported — only when both folders are caught up and there is time for
       it. Still inside the lease, so no other sync stores inbox mail meanwhile. */
    const sweep = caughtUp && deadline - Date.now() >= SWEEP_NEEDS_MS
      ? await dailyInboxSweep(admin, conn, token, { deadline })
      : null;
    return json({ ok: true, mailbox: conn.account_label, folders, ...(sweep ? { sweep } : {}) });
  } catch (err) {
    await recordSyncFailure(admin, conn.id, err);
    return json({ ok: false, mailbox: conn.account_label, error: String((err as Error)?.message ?? err) }, 500);
  } finally {
    await releaseSync(admin, conn.id);
  }
});
