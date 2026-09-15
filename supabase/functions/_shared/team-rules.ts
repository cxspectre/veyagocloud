/* team-rules.ts — who may give whom which role, asked outside the database.

   The database guards every write to employees made through the API
   (migration 0042). invite-employee writes with the service role, which that
   guard lets through, so it asks the same questions here before it writes
   anything. Kept free of Deno and Supabase so team-rules.test.js can run it. */

/* A row already in employees. */
export type ExistingMember = {
  email: string;
  role: string;
  status: string;
  user_id: string | null;
};

export type InviteRequest = {
  /* employee_role() for the person sending the invitation. */
  callerRole: string | null;
  callerUserId: string;
  /* The address invited, trimmed and lower-cased. */
  email: string;
  /* The role the invitation gives. */
  role: string;
  /* Every row with this address in any case. GoTrue treats addresses without
     case; employees.email used to be unique byte for byte, so an exact match
     alone missed an owner stored as Ana@… */
  existing: ExistingMember[];
};

/* The same mailbox, whatever its case or the space around it. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? '').trim().toLowerCase();
  return left !== '' && left === String(b ?? '').trim().toLowerCase();
}

/* Why an invitation must not go ahead, in words for the person sending it —
   or null when it may. An invitation to an address already on the team
   rewrites that person's role and status, so re-inviting is changing. */
export function inviteRefusal(request: InviteRequest): string | null {
  const byOwner = request.callerRole === 'owner';
  const matches = Array.isArray(request.existing) ? request.existing : [];
  if (matches.some((m) => m.user_id !== null && m.user_id === request.callerUserId)) {
    return 'You can’t re-invite yourself: it would change your own role. Ask another owner or admin.';
  }
  if (request.role === 'owner' && !byOwner) {
    return 'Only an owner can make someone an owner.';
  }
  if (matches.some((m) => m.role === 'owner') && !byOwner) {
    return 'Only an owner can re-invite an owner.';
  }
  /* The same person in another case would become a second row. */
  if (matches.length > 0 && !matches.some((m) => m.email === request.email)) {
    return `${matches[0].email} is already on the team. Re-invite them from their profile.`;
  }
  return null;
}

/* Why an invitation must not go to a member who can already sign in: when the
   address invited is not their account's. A new account for it would take
   over their row — their role, and their personal mailbox (0042 refuses the
   write as well). null when it may go ahead. */
export function signInRefusal(
  existing: ExistingMember | null,
  linkedEmail: string | null | undefined,
  email: string,
): string | null {
  if (!existing || existing.user_id === null) return null;
  return sameAddress(linkedEmail, email)
    ? null
    : `${existing.email} signs in with a different address. Deactivate them and invite the new address instead.`;
}

/* The status an invitation leaves. Someone already active stays active — a new
   sign-in link is not a demotion — and anyone else, new or deactivated, is
   invited. */
export function statusAfterInvite(existing: ExistingMember | null): 'active' | 'invited' {
  return existing !== null && existing.status === 'active' ? 'active' : 'invited';
}

/* The sign-in link handed back when the invitation email did not send: only
   ever for an account this invitation created. For an address that already
   had a login it is a password reset for someone else's account, and no
   manager should hold one — that person can use "Forgot password?" instead. */
export function linkToHandBack(outcome: {
  emailSent: boolean;
  existingAccount: boolean;
  actionLink: string | null;
}): string | null {
  return outcome.emailSent || outcome.existingAccount ? null : outcome.actionLink;
}
