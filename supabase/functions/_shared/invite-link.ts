/* Minting the link that lets a new hire in.
 *
 * THIS USED TO BE TWO CALLS THAT CANCELLED EACH OTHER OUT.
 *
 * The old sequence was createUser({ email_confirm: true }) and then
 * generateLink({ type: 'invite' }). Reading GoTrue's own source (internal/api/
 * mail.go, adminGenerateLink) shows why that can never work:
 *
 *     case mail.InviteVerification:
 *         if user != nil {
 *             if user.IsConfirmed() {
 *                 return apierrors.NewUnprocessableEntityError(
 *                     apierrors.ErrorCodeEmailExists, DuplicateEmailMsg)
 *
 * createUser had just made the account, and email_confirm: true had just made
 * it confirmed — so the invite was refused for the account it had itself
 * created, one line earlier, with "A user with this email address has already
 * been registered". Deterministic, for every first-time invite the product ever
 * sent. And because the account was written before the link was minted, the
 * failure left an auth user nobody could sign into and no employees row to show
 * they existed: invisible in the Team directory, yet "already registered" on
 * every retry.
 *
 * The correct shape is ONE call. generateLink({ type: 'invite' }) creates the
 * user itself — same file, a few lines down:
 *
 *     case params.Type == mail.InviteVerification && user == nil:
 *         signupParams := &SignupParams{ Email: params.Email, Data: params.Data, ... }
 *         ...
 *         user, terr = a.signupNewUser(tx, inviteUser)
 *
 * so account and link are created together or not at all, and there is no
 * window in which one exists without the other.
 *
 * WHY THE RECOVERY FALLBACK. Invite is refused only for an account that is
 * already CONFIRMED — someone who genuinely has a working login. That is not an
 * error, it is a different situation: send them a password-reset link, which
 * lands on the same "choose a password" screen. An account that exists but was
 * never accepted is NOT confirmed, so re-inviting it simply re-issues a fresh
 * 24h link — which is what makes retrying safe.
 *
 * The two links do not last the same time (24h vs 1h), so which one was minted
 * is returned rather than assumed. The countdown the invitee is shown was wrong
 * for a year because it assumed.
 *
 * The admin client is a parameter, not an import, so the decision logic above
 * can be tested without a network or a Deno runtime. See invite-link.test.js —
 * the bug this file exists to fix was a logic error, and logic is testable even
 * when the transport is not.
 */

/* Supabase invite links last 24h, recovery links 1h. Not ours to choose. */
export const INVITE_EXPIRY_HOURS = 24;
export const RECOVERY_EXPIRY_HOURS = 1;

export type LinkType = 'invite' | 'recovery';

export type MintResult = {
  ok: boolean;
  /* Which kind was actually minted — drives the expiry the invitee is told. */
  linkType: LinkType | null;
  actionLink: string | null;
  userId: string | null;
  expiryHours: number;
  /* True when this address had a working login already, so the email should say
     "here is a way back in" rather than "welcome". */
  existingAccount: boolean;
  error: string | null;
};

/* GoTrue answers 422 email_exists with a fixed string (errors.go:
   DuplicateEmailMsg). Match on the code first — the message is user-facing text
   and could be reworded — but keep the string as a fallback because older
   supabase-js releases do not surface .code. */
export function isEmailTaken(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (String(e.code ?? '') === 'email_exists') return true;
  return /already been registered/i.test(String(e.message ?? ''));
}

/* Narrow shape of what we need from supabase-js, so the tests can supply a
   fake without pulling the real client into Node. */
type AdminLike = {
  auth: {
    admin: {
      generateLink: (params: Record<string, unknown>) => Promise<{
        data?: {
          properties?: { action_link?: string } | null;
          user?: { id?: string } | null;
        } | null;
        error?: { code?: string; message?: string; status?: number } | null;
      }>;
    };
  };
};

export async function mintSignInLink(
  admin: AdminLike,
  opts: { email: string; fullName: string; redirectTo: string },
): Promise<MintResult> {
  const fail = (error: string): MintResult => ({
    ok: false, linkType: null, actionLink: null, userId: null,
    expiryHours: 0, existingAccount: false, error,
  });

  /* Invite first. This is the call that creates the account. `data` becomes
     user_metadata, but ONLY when the row is new — GoTrue's invite branch does
     not merge metadata into an existing unconfirmed user the way its signup
     branch does. Harmless here: employees.full_name is the name of record and
     is written on every pass. */
  let res = await admin.auth.admin.generateLink({
    type: 'invite',
    email: opts.email,
    options: { data: { full_name: opts.fullName }, redirectTo: opts.redirectTo },
  });

  let linkType: LinkType = 'invite';
  let existingAccount = false;

  if (isEmailTaken(res.error)) {
    linkType = 'recovery';
    existingAccount = true;
    res = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: opts.email,
      options: { redirectTo: opts.redirectTo },
    });
  }

  if (res.error) {
    /* Reachable only if the account vanished between the two calls, but saying
       "already registered / not found" in one breath would be unreadable. */
    if (existingAccount) {
      return fail(
        `${opts.email} already has an account, but a sign-in link could not be created: ` +
        `${res.error.message ?? 'unknown error'}`,
      );
    }
    return fail(`Could not create the account: ${res.error.message ?? 'unknown error'}`);
  }

  const actionLink = res.data?.properties?.action_link;
  if (!actionLink) {
    return fail('The sign-in link came back empty, so no invite was sent. Nothing was changed.');
  }

  return {
    ok: true,
    linkType,
    actionLink,
    /* generateLink returns the user alongside the link, so the employees row
       can be tied to it without a second lookup. */
    userId: res.data?.user?.id ?? null,
    expiryHours: linkType === 'invite' ? INVITE_EXPIRY_HOURS : RECOVERY_EXPIRY_HOURS,
    existingAccount,
    error: null,
  };
}
