/* sync-mail-scheduled — what pg_cron calls every five minutes (0038 §9).
 *
 * One mailbox per request: the schedule sends one request per connected
 * mailbox, so a slow or stuck one cannot use up the time of the others.
 *
 * It follows Graph's delta for Inbox and Sent Items — new mail, and read and
 * flag changes made in Outlook. The link Graph hands back is saved after every
 * page, so a burst of changes bigger than one run ("mark all as read" on a busy
 * inbox) is carried on from exactly where it stopped. An earlier version paged
 * by lastModifiedDateTime and started each run a few minutes before the last
 * one's end — which, with more changes than a run takes all stamped in the
 * same few seconds, re-read the same page forever while new mail waited.
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
import { accessTokenFor } from '../_shared/graph-token.ts';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { readCursors, withCursor } from '../_shared/mail-store.ts';
import {
  GraphError, claimSync, fetchDeltaPage, markSyncedIfLive, recordSyncFailure, releaseSync, saveCursor,
  storeMessages,
} from '../_shared/mail-sync.ts';

const FOLDERS = ['inbox', 'sentitems'];
/* 10 pages of 50 per folder per run; anything past that carries on next run. */
const MAX_PAGES_PER_FOLDER = 10;
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
    .select('id, provider, account_label, external_id, status, sync_cursor')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!conn || conn.provider !== 'microsoft_mail') return json({ error: 'No such mailbox' }, 404);

  /* needs_reauth is skipped: a refused grant does not come back by retrying.
     'error' is retried — it is usually Graph having a moment. */
  if (!['connected', 'error'].includes(conn.status)) return json({ ok: true, skipped: conn.status });
  if (!(await claimSync(admin, conn.id))) return json({ ok: true, skipped: 'already syncing' });

  try {
    const token = await accessTokenFor(admin, conn.id);
    let cursor: string = conn.sync_cursor ?? '';
    let threads = 0, messages = 0, routedToTickets = 0, removed = 0;
    let caughtUp = true;

    for (const folder of FOLDERS) {
      let from: string | null = readCursors(cursor)[folder] ?? null;
      let restarted = false;

      for (let page = 0; page < MAX_PAGES_PER_FOLDER; page++) {
        let result;
        try {
          result = await fetchDeltaPage(conn, token, folder, from);
        } catch (err) {
          /* A link Graph no longer recognises — after long enough away — is
             not a broken mailbox. Start that folder's round again, once. */
          if (err instanceof GraphError && err.status === 410 && from && !restarted) {
            restarted = true;
            from = null;
            cursor = withCursor(cursor, folder, null);
            await saveCursor(admin, conn.id, cursor);
            continue;
          }
          throw err;
        }

        const stored = await storeMessages(admin, conn, folder, result.items);
        threads += stored.threads;
        messages += stored.messages;
        routedToTickets += stored.routedToTickets;
        removed += result.removed;

        /* Stored, so saved: a run that dies after this resumes on the next page. */
        cursor = withCursor(cursor, folder, result.nextLink ?? result.deltaLink);
        await saveCursor(admin, conn.id, cursor);

        if (!result.nextLink) break;           // round done; the delta link waits for next run
        from = result.nextLink;
        if (page === MAX_PAGES_PER_FOLDER - 1) caughtUp = false;
      }
    }

    await markSyncedIfLive(admin, conn.id);
    return json({ ok: true, mailbox: conn.account_label, threads, messages, routedToTickets, removed, caughtUp });
  } catch (err) {
    const message = String((err as Error).message || err);
    await recordSyncFailure(admin, conn.id, message);
    return json({ ok: false, mailbox: conn.account_label, error: message }, 500);
  } finally {
    await releaseSync(admin, conn.id);
  }
});
