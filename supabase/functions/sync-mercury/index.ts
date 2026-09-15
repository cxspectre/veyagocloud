/* sync-mercury — pulls accounts + transactions from the Mercury API into
   finance_accounts / finance_transactions. Idempotent: upserts on
   (account_id, external_id), so re-running never duplicates rows. Complete:
   each account's transactions are paged by offset until Mercury has none left,
   not cut off at the first 500 (see transactions.ts). An account's
   last_synced_at is stamped only once all of them are stored, so a sync that
   fails part-way leaves it reading as stale rather than fresh. Payments that
   leave no money moved (cancelled, failed, reversed, blocked) are not stored,
   and a copy an earlier sync stored before then is deleted, so it stops
   counting as money spent.

   Every row says what it is (kind, from Mercury's transaction kind: kind.ts):
   a Stripe payout landing here is not income again beside Stripe's own
   charges, and a move to savings is neither income nor spending. Deploy after
   0041, which adds the column: before it, every transaction upsert fails.

   Deploy:  supabase functions deploy sync-mercury
   Secrets: supabase secrets set MERCURY_API_KEY=secret-token:mercury_...
            (create a READ-ONLY token in Mercury → Settings → API Tokens)

   Caller must be a manager. Pulls the last 90 days by default; pass
   { "days": 365 } in the body for a deeper backfill. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accountLabel } from '../_shared/mercury-account-name.ts';
import { syncAccountTransactions, transactionsPath } from './transactions.ts';

const MERCURY_API = 'https://api.mercury.com/api/v1';

/* Ids per delete. They travel in the request URL (external_id=in.(…)), and
   one page can hand back hundreds; 100 Mercury ids keep it to a few KB. */
const REMOVE_BATCH = 100;

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
      /* No last_synced_at here — the upsert leaves an existing row's alone. It
         is stamped below, after the transactions: stamped up front, an account
         whose sync failed part-way read as freshly synced (settings.js) with
         pages of it missing. */
      const { data: acctRow, error: acctErr } = await admin
        .from('finance_accounts')
        .upsert(
          {
            name: accountLabel(acct),
            kind: 'bank',
            provider: 'mercury',
            external_id: acct.id,
            currency: 'USD',
          },
          { onConflict: 'external_id' },
        )
        .select()
        .single();
      if (acctErr) throw new Error('Account upsert failed: ' + acctErr.message);

      const { stored } = await syncAccountTransactions({
        accountId: acctRow.id,
        /* The response as Mercury sent it, list and total both: a missing list
           or a short count is for transactions.ts to catch, not to paper over
           here with an empty page. */
        fetchPage: async (offset, limit) => {
          const body = await mercury(transactionsPath(acct.id, { since, offset, limit }), apiKey);
          return { transactions: body?.transactions, total: body?.total };
        },
        store: async (rows) => {
          const { error: txErr } = await admin
            .from('finance_transactions')
            .upsert(rows, { onConflict: 'account_id,external_id' });
          if (txErr) throw new Error('Transaction upsert failed: ' + txErr.message);
        },
        /* Cancelled, failed, reversed and blocked payments, which an earlier
           sync may have stored before they ended that way. Held to this
           account's rows, by Mercury id. */
        remove: async (externalIds) => {
          for (let i = 0; i < externalIds.length; i += REMOVE_BATCH) {
            const { error: delErr } = await admin
              .from('finance_transactions')
              .delete()
              .eq('account_id', acctRow.id)
              .in('external_id', externalIds.slice(i, i + REMOVE_BATCH));
            if (delErr) throw new Error('Transaction delete failed: ' + delErr.message);
          }
        },
      });
      txCount += stored;

      const { error: stampErr } = await admin
        .from('finance_accounts')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('id', acctRow.id);
      if (stampErr) throw new Error('Account update failed: ' + stampErr.message);
    }

    return json({ ok: true, accounts: (accounts ?? []).length, transactions: txCount, since });
  } catch (err) {
    console.error('sync-mercury error:', err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
