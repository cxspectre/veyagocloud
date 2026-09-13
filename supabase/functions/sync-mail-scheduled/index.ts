/* sync-mail-scheduled — what pg_cron calls every five minutes (0038 §5).
 *
 * Every connected mailbox, inbox and Sent Items, over a short window. The
 * window overlaps the previous run generously; the upserts make the overlap
 * free, and a missed run costs nothing but five minutes.
 *
 * A schedule has no user to sign in as, so this is deployed --no-verify-jwt
 * and checks a shared secret instead. It is not handed the service-role key:
 * a leaked cron header should be able to trigger a sync, not read everything.
 *
 * Deploy:  supabase functions deploy sync-mail-scheduled --no-verify-jwt
 * Secrets: supabase secrets set MAIL_SYNC_SECRET=$(openssl rand -hex 32)
 *          …and the same value in Vault as mail_sync_secret (see 0038 §5).
 * Header:  x-sync-secret: <MAIL_SYNC_SECRET>
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessTokenFor, markSynced } from '../_shared/graph-token.ts';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { fetchFolder, recordSyncFailure, storeMessages } from '../_shared/mail-sync.ts';

const FOLDERS = ['inbox', 'sentitems'];
const WINDOW_DAYS = 3;
const MAX_PER_FOLDER = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* An unset secret must never mean "anyone may call". */
  const expected = Deno.env.get('MAIL_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) return json({ error: 'Not allowed' }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  /* needs_reauth is skipped: a revoked grant does not come back by retrying,
     and asking Microsoft every five minutes only fills the logs. 'error' is
     retried — it is usually Graph having a moment. */
  const { data: connections, error } = await admin
    .from('integration_connections')
    .select('id, account_label, external_id')
    .eq('provider', 'microsoft_mail')
    .in('status', ['connected', 'error']);
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const conn of connections ?? []) {
    try {
      const token = await accessTokenFor(admin, conn.id);
      let threads = 0, messages = 0, routedToTickets = 0;
      for (const folder of FOLDERS) {
        const page = await fetchFolder(conn, token, folder, { days: WINDOW_DAYS, max: MAX_PER_FOLDER });
        const stored = await storeMessages(admin, conn, folder, page.items);
        threads += stored.threads;
        messages += stored.messages;
        routedToTickets += stored.routedToTickets;
      }
      await markSynced(admin, conn.id, null);
      results.push({ mailbox: conn.account_label, ok: true, threads, messages, routedToTickets });
    } catch (err) {
      /* One stuck mailbox must not stop the others. */
      const message = String((err as Error).message || err);
      await recordSyncFailure(admin, conn.id, message);
      results.push({ mailbox: conn.account_label, ok: false, error: message });
    }
  }

  return json({ ok: results.every((r) => r.ok), results });
});
