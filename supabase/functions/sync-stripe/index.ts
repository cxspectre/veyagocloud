/* sync-stripe — pulls balance transactions from the Stripe API into
   finance_accounts / finance_transactions. Idempotent: upserts on
   (account_id, external_id), so re-running never duplicates rows.

   Deploy:  supabase functions deploy sync-stripe
   Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_...
            (a RESTRICTED key with read-only Balance access is enough)

   Caller must be a manager. Pulls the last 90 days by default; pass
   { "days": 365 } in the body for a deeper backfill.

   Every row says what it is (kind), and each charge's fee is a row of its own
   (_shared/stripe-kind.ts): a payout is not spending, and its deposit in the
   bank is not income counted twice. Deploy after 0041, which adds the column. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripeRows } from '../_shared/stripe-kind.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function stripe(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Stripe ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const apiKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!apiKey) return json({ error: 'STRIPE_SECRET_KEY secret not set' }, 500);

    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isManager } = await asCaller.rpc('is_manager');
    if (!isManager) return json({ error: 'Managers only' }, 403);

    let days = 90;
    try {
      const body = await req.json();
      if (body?.days) days = Math.min(Number(body.days) || 90, 730);
    } catch (_) { /* empty body is fine */ }
    const sinceEpoch = Math.floor(Date.now() / 1000) - days * 86400;

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* One synthetic "Stripe" account holds all balance transactions. */
    const account = await stripe('/account', apiKey);
    const currency = String(account.default_currency || 'usd').toUpperCase();

    const { data: acctRow, error: acctErr } = await admin
      .from('finance_accounts')
      .upsert(
        {
          name: 'Stripe',
          kind: 'stripe',
          provider: 'stripe',
          external_id: `stripe:${account.id}`,
          currency,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'external_id' },
      )
      .select()
      .single();
    if (acctErr) throw new Error('Account upsert failed: ' + acctErr.message);

    let txCount = 0;
    let startingAfter: string | null = null;
    /* One run reads at most 40 pages. A window with more than that is not
       stored whole, and whoever started the sync is told rather than left with a gap. */
    let truncated = false;

    /* Balance transactions cover charges, refunds, fees, and payouts with
       amounts already signed from Stripe's perspective. Paginate to the cutoff. */
    for (let page = 0; page < 40; page++) {
      const qs = `limit=100&created[gte]=${sinceEpoch}` +
        (startingAfter ? `&starting_after=${startingAfter}` : '');
      const batch = await stripe(`/balance_transactions?${qs}`, apiKey);
      const items = batch.data ?? [];
      if (!items.length) break;

      // deno-lint-ignore no-explicit-any
      const rows = items.flatMap((t: any) => stripeRows(t, acctRow.id, currency));

      const { error: txErr } = await admin
        .from('finance_transactions')
        .upsert(rows, { onConflict: 'account_id,external_id' });
      if (txErr) throw new Error('Transaction upsert failed: ' + txErr.message);
      txCount += items.length;

      if (!batch.has_more) break;
      startingAfter = items[items.length - 1].id;
      if (page === 39) truncated = true;
    }

    if (truncated) {
      console.warn(`sync-stripe: stopped after ${txCount} transactions; the last ${days} days hold more.`);
      return json({
        ok: true, transactions: txCount, days, truncated: true,
        warning: `Stripe holds more than ${txCount} transactions in the last ${days} days, and only the newest ${txCount} were stored. Sync again with fewer days, a stretch at a time.`,
      });
    }

    return json({ ok: true, transactions: txCount, days });
  } catch (err) {
    console.error('sync-stripe error:', err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
