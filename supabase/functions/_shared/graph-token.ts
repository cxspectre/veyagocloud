/* Handing a sync function an access token that is valid right now.
 *
 * Reads the stored grant, refreshes it if it is within a minute of expiry, and
 * writes the new one back. Only ever called with a SERVICE ROLE client —
 * integration_secrets refuses every other role by design (migration 0024).
 */
import { mergeTokens, needsRefresh, refreshFailureIsPermanent, tokenUrl } from './oauth.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

/* A refresh that failed, saying whether it needs a person. The message keeps
   Microsoft's error code for whoever reads last_error; `permanent` is what
   decides the connection's status (failureStatusOf in mail-store.ts), so an
   outage whose body mentions invalid_grant is still retried. */
export class TokenRefreshError extends Error {
  permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'TokenRefreshError';
    this.permanent = permanent;
  }
}

export async function accessTokenFor(admin: Admin, connectionId: string): Promise<string> {
  const { data: secret, error } = await admin
    .from('integration_secrets')
    .select('access_token, refresh_token, token_type, expires_at, extra')
    .eq('connection_id', connectionId)
    .maybeSingle();

  if (error) throw new Error(`Could not read the credentials: ${error.message}`);
  if (!secret) throw new Error('That connection has no credentials. Connect it again.');

  if (!needsRefresh(secret.expires_at)) return secret.access_token;

  if (!secret.refresh_token) {
    await markNeedsReauth(admin, connectionId, 'No refresh token stored');
    throw new TokenRefreshError('That connection cannot refresh itself. Connect it again.', true);
  }

  const res = await fetch(tokenUrl(Deno.env.get('MICROSOFT_TENANT') ?? undefined), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('MICROSOFT_CLIENT_ID')!,
      client_secret: Deno.env.get('MICROSOFT_CLIENT_SECRET')!,
      refresh_token: secret.refresh_token,
      grant_type: 'refresh_token',
      /* Microsoft wants the scopes again on refresh; omitting them narrows the
         new token to whatever it feels like, which fails later and elsewhere. */
      scope: secret.extra?.scope ?? 'offline_access https://graph.microsoft.com/.default',
    }),
  });
  /* A gateway error can answer with HTML; its status is what matters then. */
  const fresh = await res.json().catch(() => ({}));

  if (!res.ok) {
    const code = String(fresh?.error || `http_${res.status}`);
    const why = String(fresh?.error_description || fresh?.error || `HTTP ${res.status}`);

    /* A 429, a 5xx, temporarily_unavailable: Microsoft having a moment. The
       next run tries again. */
    if (!refreshFailureIsPermanent(res.status, fresh)) {
      throw new TokenRefreshError(`Microsoft could not refresh the token (${code}): ${why}`, false);
    }

    /* invalid_grant or interaction_required: this grant is gone — revoked, a
       password changed, conditional access now refuses it. Unless someone has
       reconnected while this ran: then it was the OLD grant that failed, and
       flagging the mailbox would undo the reconnect. */
    if (await grantReplaced(admin, connectionId, secret.refresh_token)) {
      throw new TokenRefreshError('The mailbox was reconnected while this ran. Try again.', false);
    }
    await markNeedsReauth(admin, connectionId, `${code}: ${why}`);
    throw new TokenRefreshError(`Microsoft refused the refresh (${code}): ${why}`, true);
  }

  /* merge, not replace: a refresh response carries no refresh_token. And only
     over the grant this refreshed — a reconnect that stored a new grant in the
     meantime, with the scopes it was reconnected for, must not be overwritten
     by the old grant's refreshed tokens. */
  const merged = mergeTokens(secret, fresh);
  const { error: saveErr } = await admin
    .from('integration_secrets')
    .update(merged)
    .eq('connection_id', connectionId)
    .eq('refresh_token', secret.refresh_token);
  if (saveErr) throw new Error(`Could not store the refreshed token: ${saveErr.message}`);

  return merged.access_token!;
}

async function grantReplaced(admin: Admin, connectionId: string, refreshToken: string): Promise<boolean> {
  const { data } = await admin
    .from('integration_secrets')
    .select('refresh_token')
    .eq('connection_id', connectionId)
    .maybeSingle();
  return Boolean(data?.refresh_token) && data.refresh_token !== refreshToken;
}

/* Never over a mailbox someone has switched off: a run already under way when
   it was disconnected must not invite a reconnect of it. */
export async function markNeedsReauth(admin: Admin, connectionId: string, why: string): Promise<void> {
  await admin
    .from('integration_connections')
    .update({ status: 'needs_reauth', last_error: why.slice(0, 500) })
    .eq('id', connectionId)
    .neq('status', 'disconnected');
}

export async function markSynced(admin: Admin, connectionId: string, cursor?: string | null): Promise<void> {
  await admin
    .from('integration_connections')
    .update({
      status: 'connected',
      last_error: null,
      last_synced_at: new Date().toISOString(),
      ...(cursor ? { sync_cursor: cursor } : {}),
    })
    .eq('id', connectionId);
}
