/* Microsoft OAuth: the parts worth testing, kept away from the network.
 *
 * The sync functions need an access token that is valid RIGHT NOW. Microsoft's
 * access tokens last about an hour, and a refresh token only comes back if
 * `offline_access` was among the scopes — miss it and the connection works
 * beautifully until the hour is up and then dies permanently, which is a bad
 * thing to discover from a user. buildConsentUrl() is therefore not optional
 * decoration.
 *
 * The `common` tenant is used deliberately: it accepts both a Microsoft 365
 * work account and a personal one, so this does not have to know which the
 * studio is on. Set MICROSOFT_TENANT to lock it to one directory.
 */

export const AUTHORITY = 'https://login.microsoftonline.com';

export const SCOPES = {
  /* WHAT IS ASKED FOR, AND WHAT IS DELIBERATELY NOT.
   *
   * The workspace is meant to replace opening Outlook, not to be a read-only
   * window onto it — so it sends mail and writes the diary.
   *
   *   Mail.Read           read the inbox
   *   Mail.Send           send a reply from the studio mailbox, so it lands in
   *                       Sent and threads properly in the customer's client
   *   Calendars.ReadWrite read the diary and put things in it
   *
   * NOT Mail.ReadWrite. Graph has no "read and mark-as-read but not delete"
   * delegated scope — ReadWrite is the granularity on offer, and it carries
   * permanent delete of client correspondence. The only thing it would buy is
   * syncing read/flag state back to Outlook, which the workspace can live
   * without: it keeps that state on its own mirror. A bug in a young codebase
   * that can only fail to mark something read is a very different class of
   * problem from one that can empty a mailbox.
   *
   * offline_access is what makes a refresh token come back at all. */
  mail: [
    'offline_access',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
    /* A SHARED mailbox (hello@veyago.cloud) is not the mailbox of whoever
       consents. Delegated access to one needs the .Shared pair, and the person
       consenting must already have Full Access to it in Exchange — Graph will
       not grant what Exchange has not. Requested always: asking for them on a
       personal mailbox costs nothing, and discovering they are missing means
       going back through consent. */
    'https://graph.microsoft.com/Mail.Read.Shared',
    'https://graph.microsoft.com/Mail.Send.Shared',
  ],
  calendar: [
    'offline_access',
    'https://graph.microsoft.com/Calendars.ReadWrite',
  ],
  identity: ['openid', 'email', 'profile', 'https://graph.microsoft.com/User.Read']
};

export function tokenUrl(tenant?: string): string {
  return `${AUTHORITY}/${tenant || 'common'}/oauth2/v2.0/token`;
}

export interface ConsentOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  loginHint?: string;
  tenant?: string;
}

export function buildConsentUrl(o: ConsentOptions): string {
  if (!o.clientId) throw new Error('MICROSOFT_CLIENT_ID is not set');
  if (!o.redirectUri) throw new Error('A redirect URI is required');
  if (!o.scopes || !o.scopes.length) throw new Error('At least one scope is required');
  if (o.scopes.indexOf('offline_access') === -1) {
    /* Without it Microsoft returns an access token and no refresh token: the
       connection works for an hour, then dies and cannot revive itself. Worth
       refusing to build the URL over. */
    throw new Error('offline_access must be requested, or the grant cannot be refreshed');
  }

  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: o.scopes.join(' '),
    /* Force the prompt so a re-connect after a revoke issues a NEW refresh
       token rather than silently returning none. */
    prompt: 'consent',
    state: o.state
  });
  if (o.loginHint) params.set('login_hint', o.loginHint);
  return `${AUTHORITY}/${o.tenant || 'common'}/oauth2/v2.0/authorize?` + params.toString();
}

/* Microsoft returns expires_in (seconds from now). Storing that verbatim would be
   meaningless five minutes later, so it becomes an absolute timestamp here. */
export function expiryFrom(expiresIn: number | undefined, nowMs = Date.now()): string | null {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/* Refresh a minute early. A token that expires while the request is in flight
   fails just as hard as one that expired an hour ago, and clock skew between
   Microsoft and us is real. */
export function needsRefresh(expiresAt: string | null | undefined, nowMs = Date.now(), skewSeconds = 60): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return true;
  return at - skewSeconds * 1000 <= nowMs;
}

/* A refresh response may omit refresh_token. Merging rather than replacing is
   what stops a refresh from wiping the one credential that cannot be
   re-obtained without sending the user back through consent. Microsoft usually
   rotates it and sends a new one; assuming either way is how this breaks. */
export function mergeTokens(
  stored: { access_token?: string | null; refresh_token?: string | null; token_type?: string | null },
  fresh: { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number },
  nowMs = Date.now()
): { access_token: string | null; refresh_token: string | null; token_type: string | null; expires_at: string | null } {
  return {
    access_token: fresh.access_token ?? stored.access_token ?? null,
    refresh_token: fresh.refresh_token ?? stored.refresh_token ?? null,
    token_type: fresh.token_type ?? stored.token_type ?? 'Bearer',
    expires_at: expiryFrom(fresh.expires_in, nowMs)
  };
}

/* state carries the connection's identity through Microsoft and back. It is
   returned to us over a redirect the user controls, so it is signed: an
   unsigned state is an open invitation to bind someone else's mailbox to your
   connection row. HMAC-SHA256 over the payload, base64url, constant-time
   compare on the way back. */
export async function signState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await hmac(body, secret);
  return `${body}.${mac}`;
}

export async function verifyState(state: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
