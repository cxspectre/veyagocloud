/* sync-mercury — pulls accounts + transactions from the Mercury API into
   finance_accounts / finance_transactions. Idempotent: upserts on
   (account_id, external_id), so re-running never duplicates rows.

   Deploy:  supabase functions deploy sync-mercury
   Secrets: supabase secrets set MERCURY_API_KEY=secret-token:mercury_...
            (create a READ-ONLY token in Mercury → Settings → API Tokens)

   Caller must be a manager. Pulls the last 90 days by default; pass
   { "days": 365 } in the body for a deeper backfill. */

import { createClient } from 'npm:@supabase/supabase-js@2';

const MERCURY_API = 'https://api.mercury.com/api/v1';

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

async function mercury(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${MERCURY_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Mercury ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const apiKey = Deno.env.get('MERCURY_API_KEY');
    if (!apiKey) return json({ error: 'MERCURY_API_KEY secret not set' }, 500);

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
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { accounts } = await mercury('/accounts', apiKey);
    let txCount = 0;

    for (const acct of accounts ?? []) {
      const { data: acctRow, error: acctErr } = await admin
        .from('finance_accounts')
        .upsert(
          {
            name: `Mercury ${acct.nickname || acct.name || acct.kind || 'Account'}`,
            kind: 'bank',
            provider: 'mercury',
            external_id: acct.id,
            currency: 'USD',
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'external_id' },
        )
        .select()
        .single();
      if (acctErr) throw new Error('Account upsert failed: ' + acctErr.message);

      const { transactions } = await mercury(
        `/account/${acct.id}/transactions?limit=500&start=${since}`,
        apiKey,
      );

      const rows = (transactions ?? []).map((t: any) => ({
        account_id: acctRow.id,
        external_id: t.id,
        posted_at: (t.postedAt || t.createdAt || '').slice(0, 10),
        description: t.bankDescription || t.externalMemo || t.note || t.counterpartyName || 'Transaction',
        counterparty: t.counterpartyName || null,
        amount: t.amount,                        // Mercury amounts are already signed
        currency: 'USD',
        status: t.status === 'pending' ? 'pending' : 'posted',
        source: 'mercury',
      })).filter((r: any) => r.posted_at);

      if (rows.length) {
        const { error: txErr } = await admin
          .from('finance_transactions')
          .upsert(rows, { onConflict: 'account_id,external_id' });
        if (txErr) throw new Error('Transaction upsert failed: ' + txErr.message);
        txCount += rows.length;
      }
    }

    return json({ ok: true, accounts: (accounts ?? []).length, transactions: txCount, since });
  } catch (err) {
    console.error('sync-mercury error:', err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
