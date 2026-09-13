/* sync-mail-scheduled — what pg_cron calls every five minutes (0038 §6).
 *
 * One mailbox per request: the schedule sends one request per connected
 * mailbox, so a slow or stuck one cannot use up the time of the others, and
 * no single request carries every mailbox's mail.
 *
 * Incremental. It asks Graph for what changed since the last run — by
 * lastModifiedDateTime, which moves when a message is read or flagged in
 * Outlook as well as when one arrives — oldest first. If there was more than
 * one run takes, it records how far it got rather than "now", and the next run
 * carries on from there: nothing is skipped for having been busy.
 *
 * A schedule has no user to sign in as, so this is deployed --no-verify-jwt
 * and checks a shared secret instead. It is not handed the service-role key:
 * a leaked cron header should be able to trigger a sync, not read everything.
 *
 * Deploy:  supabase functions deploy sync-mail-scheduled --no-verify-jwt
 * Secrets: supabase secrets set MAIL_SYNC_SECRET=$(openssl rand -hex 32)
 *          …and the same value in Vault as mail_sync_secret (see 0038 §6).
 * Header:  x-sync-secret: <MAIL_SYNC_SECRET>
 * Body:    { "connectionId": "..." }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor } from '../_shared/graph-token.ts';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { syncWindowStart } from '../_shared/mail-store.ts';
import {
  claimSync, fetchFolder, recordSyncFailure, releaseSync, storeMessages,
} from '../_shared/mail-sync.ts';

const FOLDERS = ['inbox', 'sentitems'];
const MAX_PER_FOLDER = 200;
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
    .select('id, provider, account_label, external_id, status, last_synced_at')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!conn || conn.provider !== 'microsoft_mail') return json({ error: 'No such mailbox' }, 404);

  /* needs_reauth is skipped: a revoked grant does not come back by retrying.
     'error' is retried — it is usually Graph having a moment. */
  if (!['connected', 'error'].includes(conn.status)) return json({ ok: true, skipped: conn.status });
  if (!(await claimSync(admin, conn.id))) return json({ ok: true, skipped: 'already syncing' });

  const startedAt = new Date().toISOString();
  try {
    const token = await accessTokenFor(admin, conn.id);
    const since = syncWindowStart(conn.last_synced_at, Date.now());
    let threads = 0, messages = 0, routedToTickets = 0;
    /* How far this run got. "Now" when every folder was read to the end;
       otherwise the last change it did store, so the rest comes next run. */
    let syncedThrough = startedAt;

    for (const folder of FOLDERS) {
      const page = await fetchFolder(conn, token, folder, {
        since, field: 'lastModifiedDateTime', order: 'asc', max: MAX_PER_FOLDER,
      });
      const stored = await storeMessages(admin, conn, folder, page.items);
      threads += stored.threads;
      messages += stored.messages;
      routedToTickets += stored.routedToTickets;
      const last = page.items[page.items.length - 1]?.lastModifiedDateTime;
      if (page.moreAvailable && last && last < syncedThrough) syncedThrough = last;
    }

    await admin.from('integration_connections')
      .update({ status: 'connected', last_error: null, last_synced_at: syncedThrough })
      .eq('id', conn.id);
    return json({ ok: true, mailbox: conn.account_label, threads, messages, routedToTickets, syncedThrough });
  } catch (err) {
    const message = String((err as Error).message || err);
    await recordSyncFailure(admin, conn.id, message);
    return json({ ok: false, mailbox: conn.account_label, error: message }, 500);
  } finally {
    await releaseSync(admin, conn.id);
  }
});
