/* Handing a sync function an access token that is valid right now.
 *
 * Reads the stored grant, refreshes it if it is within a minute of expiry, and
 * writes the new one back. Only ever called with a SERVICE ROLE client —
 * integration_secrets refuses every other role by design (migration 0024).
 */
import { mergeTokens, needsRefresh, tokenUrl } from './oauth.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

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
    throw new Error('That connection cannot refresh itself. Connect it again.');
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
  const fresh = await res.json();

  if (!res.ok) {
    /* invalid_grant means the grant was revoked, the password changed, or a
       conditional-access policy now refuses it. No amount of retrying fixes
       any of those, so the connection is flagged for a human rather than left
       to fail silently on a schedule. */
    const why = fresh.error_description || fresh.error || `HTTP ${res.status}`;
    await markNeedsReauth(admin, connectionId, String(why));
    throw new Error(`Microsoft refused the refresh: ${why}`);
  }

  /* merge, not replace: a refresh response carries no refresh_token. */
  const merged = mergeTokens(secret, fresh);
  const { error: saveErr } = await admin
    .from('integration_secrets')
    .update(merged)
    .eq('connection_id', connectionId);
  if (saveErr) throw new Error(`Could not store the refreshed token: ${saveErr.message}`);

  return merged.access_token!;
}

export async function markNeedsReauth(admin: Admin, connectionId: string, why: string): Promise<void> {
  await admin
    .from('integration_connections')
    .update({ status: 'needs_reauth', last_error: why.slice(0, 500) })
    .eq('id', connectionId);
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
