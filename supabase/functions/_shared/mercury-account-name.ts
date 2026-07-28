/* Naming an account synced from Mercury.
 *
 * Was `Mercury ${acct.nickname || acct.name || acct.kind || 'Account'}`,
 * unconditionally — so a Mercury account nicknamed "Mercury Checking" (the
 * obvious, natural thing to call it in Mercury's own dashboard) came out as
 * "Mercury Mercury Checking" in the admin. And because this runs through an
 * upsert on every sync, it wasn't a one-time typo to clean up by hand — every
 * click of "Sync accounts" re-derived the name from Mercury's API and wrote
 * the doubled version straight back over anything a manager might have fixed.
 *
 * The fix only needs to not prefix a label that already reads as Mercury's own
 * — deploying it and running one more sync repairs the existing rows for free,
 * since the upsert recomputes the name from the API response every time.
 */
export function accountLabel(acct: { nickname?: string | null; name?: string | null; kind?: string | null }): string {
  const base = acct.nickname || acct.name || acct.kind || 'Account';
  return /^mercury\b/i.test(base) ? base : `Mercury ${base}`;
}
