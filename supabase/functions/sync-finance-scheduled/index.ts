/* sync-finance-scheduled — what pg_cron calls once a day (0060 §5) to keep
   Mercury and Stripe syncing without a person pressing the Settings page's
   "Sync" button.

   sync-mercury and sync-stripe both read the CALLER's own session
   (rpc('is_manager')) rather than the service role, on purpose: a leaked sync
   secret must be able to trigger a sync, not read every finance row in the
   studio straight out of the database. That is exactly right, and neither
   function is touched here (both are off limits to this change).

   A schedule has no manager to sign in as, so it signs in as one: a
   dedicated employee account — an owner or admin — made ONLY for this and
   never used by a person. It must have NO second factor ever enrolled: 0040
   lets a session through at aal1 only while its account has no verified
   factor ("enter the code if you have one" — the same rule an ordinary
   sign-in without 2FA already relies on). Enrolling a factor on this account
   later would silently stop every scheduled sync from authenticating at all,
   with nothing louder than an "error" row in integration_connections to
   notice it by.

   Records whether each provider's sync worked into integration_connections
   (0024, seeded with one studio-wide row per provider by 0060) — status,
   last_synced_at, last_error — the same place a mailbox's own sync health
   already lives, so the Settings screen that already reads that table needs
   no change to show these two as well. Mercury and Stripe are tried at the
   same time and independently: one failing does not stop, or hide the result
   of, the other.

   Deploy:  supabase functions deploy sync-finance-scheduled --no-verify-jwt
            (a schedule has no user JWT to verify — same reason
            sync-mail-scheduled is deployed this way, 0038 §9)
   Secrets: supabase secrets set FINANCE_SYNC_SECRET=$(openssl rand -hex 32)
            supabase secrets set FINANCE_SYNC_EMAIL=<the dedicated account's email>
            supabase secrets set FINANCE_SYNC_PASSWORD=<its password>
            …and FINANCE_SYNC_SECRET the same value in Vault as
            finance_sync_secret (0060 §5's cron job reads it from there).
   Header:  x-sync-secret: <FINANCE_SYNC_SECRET>
   Body:    { "days": 14 } — optional; forwarded to each provider's own sync
            as-is (both already cap it at 730 themselves). */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from '../_shared/oauth.ts';

const MIN_SECRET_LENGTH = 32;
const DEFAULT_DAYS = 14;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Client = ReturnType<typeof createClient>;

/* integration_connections again (0024): the one studio-wide row 0060 seeded
   for this provider, matched by having no employee_id — never a person's own
   mailbox row, which the same table also holds. Best-effort: a failure to
   record the result must not turn a working sync into one this function
   reports as broken. */
async function recordResult(admin: Client, provider: string, ok: boolean, detail: string): Promise<void> {
  const update: Record<string, unknown> = { status: ok ? 'connected' : 'error', last_error: ok ? null : detail };
  if (ok) update.last_synced_at = new Date().toISOString();
  const { error } = await admin.from('integration_connections').update(update).eq('provider', provider).is('employee_id', null);
  if (error) console.error(`sync-finance-scheduled: could not record ${provider}'s result:`, error.message);
}

/* One provider's sync: call its function with the sync account's own token —
   exactly as a manager's browser would — and record what happened. Never
   throws: a provider that fails is a result to record, not a reason to stop
   the other one running. */
async function syncProvider(opts: {
  url: string; anonKey: string; accessToken: string; fnName: string; provider: string; days: number; admin: Client;
}): Promise<{ provider: string; ok: boolean; detail: string }> {
  const { url, anonKey, accessToken, fnName, provider, days, admin } = opts;
  try {
    const res = await fetch(`${url}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, apikey: anonKey },
      body: JSON.stringify({ days }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) {
      const detail = String(body?.error || `${fnName} answered ${res.status}`);
      await recordResult(admin, provider, false, detail);
      return { provider, ok: false, detail };
    }
    const counted = [
      typeof body.accounts === 'number' ? `${body.accounts} account(s)` : null,
      `${body.transactions ?? 0} transaction(s)`,
    ].filter(Boolean);
    const detail = counted.join(', ');
    await recordResult(admin, provider, true, detail);
    return { provider, ok: true, detail };
  } catch (err) {
    const detail = String((err as Error).message || err);
    await recordResult(admin, provider, false, detail);
    return { provider, ok: false, detail };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* An unset — or guessable — secret must never mean "anyone may call". */
  const expected = Deno.env.get('FINANCE_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (expected.length < MIN_SECRET_LENGTH || !timingSafeEqual(given, expected)) {
    return json({ error: 'Not allowed' }, 401);
  }

  const email = Deno.env.get('FINANCE_SYNC_EMAIL');
  const password = Deno.env.get('FINANCE_SYNC_PASSWORD');
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (!email || !password) {
    const detail = 'FINANCE_SYNC_EMAIL / FINANCE_SYNC_PASSWORD not set';
    await Promise.all(['mercury', 'stripe'].map((p) => recordResult(admin, p, false, detail)));
    return json({ error: detail }, 500);
  }

  let days = DEFAULT_DAYS;
  try {
    const body = await req.json();
    if (body?.days) days = Math.min(Math.max(Number(body.days) || DEFAULT_DAYS, 1), 730);
  } catch (_) { /* empty body is fine */ }

  const asSync = createClient(url, anonKey);
  const { data: signedIn, error: signInErr } = await asSync.auth.signInWithPassword({ email, password });
  if (signInErr || !signedIn?.session) {
    const detail = 'Could not sign in as the sync account: ' + (signInErr?.message || 'no session came back');
    await Promise.all(['mercury', 'stripe'].map((p) => recordResult(admin, p, false, detail)));
    return json({ error: detail }, 500);
  }

  try {
    const accessToken = signedIn.session.access_token;
    const results = await Promise.all([
      syncProvider({ url, anonKey, accessToken, fnName: 'sync-mercury', provider: 'mercury', days, admin }),
      syncProvider({ url, anonKey, accessToken, fnName: 'sync-stripe', provider: 'stripe', days, admin }),
    ]);
    return json({ ok: results.every((r) => r.ok), results });
  } finally {
    /* Revoking the token this run minted is tidiness, not correctness — it
       must never fail, or delay, the response the cron job reads. */
    await asSync.auth.signOut().catch(() => {});
  }
});
