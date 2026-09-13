/* microsoft-connect — step 1 of connecting an Outlook mailbox or calendar.
 *
 * Creates (or reuses) the integration_connections row and returns the Microsoft
 * consent URL to send the manager to. Nothing is authorised yet; the tokens
 * arrive in microsoft-callback.
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
 * Managers only: connecting a mailbox to the studio is not an everyday edit. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { SCOPES, buildConsentUrl, signState } from '../_shared/oauth.ts';

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
    const { data: isManager } = await asCaller.rpc('is_manager');
    if (!isManager) return json({ error: 'Managers only' }, 403);

    const body = await req.json().catch(() => ({}));
    const provider = body?.provider === 'microsoft_calendar' ? 'microsoft_calendar' : 'microsoft_mail';
    const accountLabel = String(body?.accountLabel || '').trim().toLowerCase();
    if (!accountLabel) return json({ error: 'accountLabel (the address to connect) is required' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* Reconnecting an existing mailbox — to grant a scope added since, say —
       starts from what is already known about it. */
    const { data: previous } = await admin
      .from('integration_connections')
      .select('employee_id, external_id')
      .eq('provider', provider)
      .eq('account_label', accountLabel)
      .maybeSingle();

    /* employeeId null means a studio-wide mailbox that every staff member can
       read. Anything else is personal and stays private to that person — see
       the 0025 migration header. A new connection has to say which,
       deliberately. A reconnect that does not mention it keeps what the
       mailbox already is: defaulting to null there would quietly turn
       someone's personal mailbox into one every member of staff can read. */
    const saysWho = body && Object.prototype.hasOwnProperty.call(body, 'employeeId');
    const employeeId = saysWho ? (body.employeeId ?? null) : (previous?.employee_id ?? null);

    /* A connected mailbox keeps its owner. Reassigning one here — with the
       grant still stored and the status still connected — would hand a
       colleague's personal mailbox, its reading and its sending, to whoever
       asked. Changing hands means disconnecting and connecting fresh. The
       database refuses the same change from the browser (0038). */
    if (previous && (previous.employee_id ?? null) !== employeeId) {
      return json({ error: 'A connected mailbox keeps its owner. Disconnect it before connecting it for someone else.' }, 409);
    }

    /* Who will sit at the consent screen. For a personal mailbox that is the
       mailbox itself. For a SHARED one it is not — hello@veyago.cloud has no
       sign-in, so hinting it sends the person to a prompt that cannot succeed.
       The consenting account is whoever has Full Access to it in Exchange,
       which the callback recorded last time. */
    const consentAs = String(body?.consentAs || '').trim().toLowerCase()
      || String(previous?.external_id || '').trim().toLowerCase()
      || accountLabel;

    const { data: conn, error: connErr } = await admin
      .from('integration_connections')
      .upsert(
        {
          provider,
          account_label: accountLabel,
          employee_id: employeeId,
          /* A mailbox that is working keeps working while someone is at the
             consent screen; only a new one starts disconnected. */
          ...(previous ? {} : { status: 'disconnected' }),
          scopes: provider === 'microsoft_mail' ? SCOPES.mail : SCOPES.calendar,
          last_error: null,
        },
        { onConflict: 'provider,account_label' },
      )
      .select('id')
      .single();
    if (connErr) return json({ error: connErr.message }, 500);

    const scopes = [
      ...(provider === 'microsoft_mail' ? SCOPES.mail : SCOPES.calendar),
      ...SCOPES.identity,
    ];

    /* The scopes travel in the signed state so the callback can ask for the
       same set when it exchanges the code — Microsoft narrows the token
       otherwise, and the failure surfaces later, somewhere else. */
    const state = await signState(
      { connection: conn.id, provider, issued: Date.now(), scopes: scopes.join(' ') },
      stateSecret,
    );

    return json({
      connectionId: conn.id,
      consentUrl: buildConsentUrl({
        clientId,
        redirectUri,
        scopes,
        state,
        loginHint: consentAs,
        tenant: Deno.env.get('MICROSOFT_TENANT') ?? undefined,
      }),
    });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
