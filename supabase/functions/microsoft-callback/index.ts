/* microsoft-callback — step 2: Microsoft redirects the manager back here with a code.
 *
 * Deploy WITHOUT JWT verification, because this is a browser redirect from
 * Microsoft and carries no Authorization header:
 *
 *   supabase functions deploy microsoft-callback --no-verify-jwt
 *
 * That is safe only because `state` is HMAC-signed by microsoft-connect and
 * verified here before anything is written. An unsigned state would let anyone
 * who can reach this URL bind their own Microsoft account to one of our
 * connection rows — which is exactly the attack the signature exists to stop.
 *
 * The refresh token arrives on this exchange. It is written to
 * integration_secrets, a table with RLS on, no policies and grants revoked
 * (migration 0024): only the service role can ever read it back. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { mergeTokens, verifyState, tokenUrl } from '../_shared/oauth.ts';

const ME_URL = 'https://graph.microsoft.com/v1.0/me';

/* A redirect back to a human-readable page beats a JSON blob in the address
   bar — this is the end of a flow a person is walking through. */
function done(message: string, ok: boolean): Response {
  const body = `<!doctype html><meta charset="utf-8">
<title>${ok ? 'Connected' : 'Not connected'} - Veyago</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#f5f5f7;color:#1d1d1f;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,Arial,sans-serif}
.card{max-width:420px;padding:30px 28px;background:#fff;border-radius:24px;text-align:center;
box-shadow:0 4px 18px #26334e0a,0 18px 46px #34435a0a}
h1{margin:0 0 8px;font-size:1.25rem;letter-spacing:-.5px}
p{margin:0;color:#6e6e73;font-size:.9375rem}</style>
<div class="card"><h1>${ok ? 'Connected.' : 'Something went wrong.'}</h1>
<p>${message}</p></div>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  try {
    const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
    const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET');
    const redirectUri = Deno.env.get('MICROSOFT_REDIRECT_URI');
    const stateSecret = Deno.env.get('OAUTH_STATE_SECRET');
    if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
      return done('The Microsoft secrets are not set on this project.', false);
    }

    const url = new URL(req.url);
    const error = url.searchParams.get('error');
    if (error) {
      /* error alone is a category ("invalid_request") and tells you nothing.
         error_description carries the AADSTS code and the actual sentence,
         which is the difference between fixing this in a minute and guessing
         for an hour. Logged as well, in case the redirect truncates it. */
      const description = url.searchParams.get('error_description') ?? '';
      console.error('[microsoft-callback]', error, description);
      return done(
        `Microsoft said: ${error}.` +
        (description ? `<br><br><code style="font-size:12px;word-break:break-word">${
          description.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
        }</code>` : '') +
        '<br><br>Nothing was changed.',
        false,
      );
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return done('That link is missing its code.', false);

    const claims = await verifyState(state, stateSecret);
    if (!claims?.connection) {
      return done('That link could not be verified. Start the connection again.', false);
    }
    /* Ten minutes is plenty for a consent screen and short enough that a
       leaked URL in a history or a log is not a standing key. */
    const issued = Number(claims.issued);
    if (!Number.isFinite(issued) || Date.now() - issued > 10 * 60 * 1000) {
      return done('That link has expired. Start the connection again.', false);
    }

    const tokenRes = await fetch(tokenUrl(Deno.env.get('MICROSOFT_TENANT') ?? undefined), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        /* Asked for again here so the token comes back with the scopes the
           consent screen actually granted, and stored below for the refresh. */
        scope: String(claims.scopes || 'offline_access https://graph.microsoft.com/.default'),
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return done(`Microsoft refused the exchange: ${tokens.error_description || tokens.error}.`, false);
    }

    /* Who consented? For a personal mailbox this is the same address the
       connection is labelled with. For a SHARED one it is not — and that
       difference is exactly what tells the sync to read /users/hello@… rather
       than /me. Stored in external_id; the label is left alone. */
    let address = '';
    if (tokens.access_token) {
      const who = await fetch(`${ME_URL}?$select=mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (who.ok) {
        const me = await who.json().catch(() => ({}));
        /* `mail` is the real address; userPrincipalName is the sign-in name and
           is only the same thing by coincidence. Prefer mail, fall back. */
        address = String(me.mail || me.userPrincipalName || '').toLowerCase();
      }
    }
    /* Not knowing who consented is not a detail. Without it a shared mailbox is
       read as /me — the consenting person's own inbox, copied into a mailbox
       all staff can see — while this page says "Connected". Nothing has been
       stored yet, so trying again starts clean. */
    if (!address) {
      return done('Microsoft did not say which account signed in, so nothing was connected. Try connecting again.', false);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: existing } = await admin
      .from('integration_secrets')
      .select('access_token, refresh_token, token_type')
      .eq('connection_id', claims.connection)
      .maybeSingle();

    const merged = mergeTokens(existing ?? {}, tokens);
    if (!merged.refresh_token) {
      /* Without one, this connection dies in an hour and cannot revive itself.
         Better to say so now than to look connected and fail overnight. */
      return done(
        'Microsoft did not return a refresh token — offline_access was not granted. ' +
        'Remove Veyago at myaccount.microsoft.com/permissions and connect again.',
        false,
      );
    }

    const { error: secretErr } = await admin
      .from('integration_secrets')
      .upsert({
        connection_id: claims.connection,
        ...merged,
        /* Kept so the refresh can ask for the same scopes it was granted. */
        extra: { scope: tokens.scope ?? null },
      }, { onConflict: 'connection_id' });
    if (secretErr) return done(`Could not store the credentials: ${secretErr.message}`, false);

    const { error: connErr } = await admin
      .from('integration_connections')
      .update({
        status: 'connected',
        last_error: null,
        ...(address ? { external_id: address } : {}),
        /* account_label is NOT overwritten. It is the mailbox being read, which
           for a shared one is not the account that authorised reading it. */
        /* A new grant starts the scheduled sync afresh. Links saved under the
           old one may read another mailbox path — /me, from before who
           consented was known — and must not outlive it (readCursors in
           mail-store.ts). A calendar re-reads its window, which is harmless. */
        sync_cursor: null,
      })
      .eq('id', claims.connection);
    if (connErr) return done(`Could not update the connection: ${connErr.message}`, false);

    return done(
      `Connected${address ? ' as ' + address : ''}. You can close this tab — mail syncs by itself within five minutes.`,
      true,
    );
  } catch (err) {
    return done(String((err as Error).message || err), false);
  }
});
