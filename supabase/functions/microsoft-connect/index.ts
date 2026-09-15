/* microsoft-connect — step 1 of connecting an Outlook mailbox or calendar.
 *
 * Creates the integration_connections row (or finds the existing one) and
 * returns the Microsoft consent URL to send the person to. Nothing is
 * authorised yet; the tokens arrive in microsoft-callback.
 *
 * Deploy:  supabase functions deploy microsoft-connect
 * Secrets: supabase secrets set \
 *            MICROSOFT_CLIENT_ID=<application (client) id> \
 *            MICROSOFT_CLIENT_SECRET=<client secret VALUE, not its id> \
 *            MICROSOFT_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/microsoft-callback \
 *            OAUTH_STATE_SECRET=$(openssl rand -hex 32)
 *          MICROSOFT_TENANT is optional — leave it unset to accept both work
 *          and personal accounts.
 *
 * In Entra ID → App registrations → your app → Authentication, add that same
 * MICROSOFT_REDIRECT_URI as a Web redirect URI, or consent fails with
 * AADSTS50011 redirect_uri_mismatch. The secret is created under Certificates
 * & secrets, and Azure shows its VALUE exactly once.
 *
 * Who may do what (_shared/connection-rules.ts, security review 2026-09-14):
 * owners and admins connect a new mailbox or calendar — saying whose it is —
 * and reconnect the studio's; anyone on staff reconnects their own. Nobody
 * reconnects a colleague's: consenting to it as someone else would put another
 * mailbox behind it. A studio connection cannot be a team member's own
 * address, and a personal one cannot be a colleague's. A row that never got as
 * far as a grant — consent abandoned, or refused by the callback — holds
 * nothing, and an owner or admin starts it again with the owner they name. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { SCOPES, buildConsentUrl, signState } from '../_shared/oauth.ts';
import { OWNER_KEPT, REMOVE_FIRST, connectRefusal, labelProblem } from '../_shared/connection-rules.ts';
import { employeeByAddress } from '../_shared/team-lookup.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
    const redirectUri = Deno.env.get('MICROSOFT_REDIRECT_URI');
    const stateSecret = Deno.env.get('OAUTH_STATE_SECRET');
    if (!clientId || !redirectUri || !stateSecret) {
      return json({ error: 'MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT_URI and OAUTH_STATE_SECRET must be set' }, 500);
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: isStaff } = await asCaller.rpc('is_staff');
    if (!isStaff) return json({ error: 'Staff only' }, 403);
    const { data: isManager } = await asCaller.rpc('is_manager');
    const { data: me, error: meErr } = await asCaller.rpc('active_employee_id');
    if (meErr) return json({ error: 'Could not tell who you are: ' + meErr.message }, 500);

    const body = await req.json().catch(() => ({}));
    const provider = body?.provider === 'microsoft_calendar' ? 'microsoft_calendar' : 'microsoft_mail';
    const accountLabel = String(body?.accountLabel || '').trim().toLowerCase();
    if (!accountLabel) return json({ error: 'accountLabel (the address to connect) is required' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* Reconnecting an existing mailbox — to grant a scope added since, say —
       starts from what is already known about it. A lookup that failed is not
       "there is none": treating it so would create or reassign the wrong row. */
    const { data: previous, error: previousErr } = await admin
      .from('integration_connections')
      .select('id, employee_id, external_id, status, last_synced_at')
      .eq('provider', provider)
      .eq('account_label', accountLabel)
      .maybeSingle();
    if (previousErr) return json({ error: previousErr.message }, 500);

    /* employeeId null means a studio-wide mailbox that every staff member can
       read. Anything else is personal and stays private to that person — see
       the 0025 migration header. A new connection has to say which,
       deliberately: leaving it out used to make it a studio one. A reconnect
       that does not mention it keeps what the mailbox already is: defaulting
       to null there would quietly turn someone's personal mailbox into one
       every member of staff can read. */
    const saysWho = body && Object.prototype.hasOwnProperty.call(body, 'employeeId');
    const employeeId = saysWho ? (body.employeeId ?? null) : (previous?.employee_id ?? null);

    /* A connected mailbox keeps its owner. Reassigning one — with the grant
       still stored — would hand a colleague's personal mailbox, its reading
       and its sending, to whoever asked; changing hands means disconnecting
       and connecting fresh, and the database refuses the same change from the
       browser (0038). Only its owner — or, for the studio's, an owner or
       admin — reconnects it. */
    /* A row that never got as far as a grant — no consenter recorded, never
       synced, still disconnected — holds no grant and no mail. Told it keeps
       an owner it never used, nobody could connect that address the right way
       after the callback refused it, or after a consent was abandoned. An owner
       or admin starts it again as a new connection: with the owner they name,
       or the one it already has when they name none. */
    const neverConnected = Boolean(previous) && previous!.status === 'disconnected'
      && !previous!.external_id && !previous!.last_synced_at;
    const restarting = neverConnected && isManager === true;

    const refusal = connectRefusal({
      manager: isManager === true,
      callerEmployeeId: typeof me === 'string' ? me : null,
      previous: restarting ? null : previous ?? null,
      saysWho: saysWho || restarting,
      employeeId,
    });
    if (refusal) return json({ error: refusal.message }, refusal.status);

    /* Whose address this is: never a team member's own in the studio's name,
       or a colleague's in someone else's. Nothing connected yet is simply
       connected as theirs; a connection that exists has to be removed first. */
    const wrongAddress = labelProblem(employeeId, await employeeByAddress(admin, accountLabel));
    if (wrongAddress) {
      const advice = previous && !neverConnected ? REMOVE_FIRST : 'Connect it as theirs instead.';
      return json({ error: `${wrongAddress} ${advice}` }, 409);
    }

    /* Who will sit at the consent screen. For a personal mailbox that is the
       mailbox itself. For a SHARED one it is not — hello@veyago.cloud has no
       sign-in, so hinting it sends the person to a prompt that cannot succeed.
       The consenting account is whoever has Full Access to it in Exchange,
       which the callback recorded last time. */
    const consentAs = String(body?.consentAs || '').trim().toLowerCase()
      || String(previous?.external_id || '').trim().toLowerCase()
      || accountLabel;

    const scopes = provider === 'microsoft_mail' ? SCOPES.mail : SCOPES.calendar;
    let connectionId: string;

    if (previous) {
      /* A reconnect changes what is asked for — never whose mailbox it is,
         and never its status: a working mailbox keeps working while someone
         is at the consent screen. A row never connected takes its new owner
         only while it still has never connected: a grant stored meanwhile
         keeps the owner it was stored for. */
      let update = admin
        .from('integration_connections')
        .update({ scopes, last_error: null, ...(restarting ? { employee_id: employeeId } : {}) })
        .eq('id', previous.id);
      if (restarting) update = update.eq('status', 'disconnected').is('external_id', null).is('last_synced_at', null);
      const { data: updated, error } = await update.select('id');
      if (error) return json({ error: error.message }, 500);
      if (restarting && !updated?.length) return json({ error: OWNER_KEPT }, 409);
      connectionId = previous.id;
    } else {
      /* A new connection. If another request made the same row a moment ago,
         this one must not rewrite its owner: insert-or-nothing, then read the
         row back and check whose it is. */
      const { error: insertErr } = await admin
        .from('integration_connections')
        .upsert(
          {
            provider,
            account_label: accountLabel,
            employee_id: employeeId,
            status: 'disconnected',
            scopes,
            last_error: null,
          },
          { onConflict: 'provider,account_label', ignoreDuplicates: true },
        );
      if (insertErr) return json({ error: insertErr.message }, 500);

      const { data: row, error: rowErr } = await admin
        .from('integration_connections')
        .select('id, employee_id')
        .eq('provider', provider)
        .eq('account_label', accountLabel)
        .single();
      if (rowErr || !row) return json({ error: rowErr?.message ?? 'The connection was not created' }, 500);
      if ((row.employee_id ?? null) !== employeeId) return json({ error: OWNER_KEPT }, 409);
      connectionId = row.id;
    }

    const requested = [...scopes, ...SCOPES.identity];

    /* The scopes travel in the signed state so the callback can ask for the
       same set when it exchanges the code — Microsoft narrows the token
       otherwise, and the failure surfaces later, somewhere else. */
    const state = await signState(
      { connection: connectionId, provider, issued: Date.now(), scopes: requested.join(' ') },
      stateSecret,
    );

    return json({
      connectionId,
      consentUrl: buildConsentUrl({
        clientId,
        redirectUri,
        scopes: requested,
        state,
        loginHint: consentAs,
        tenant: Deno.env.get('MICROSOFT_TENANT') ?? undefined,
      }),
    });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
