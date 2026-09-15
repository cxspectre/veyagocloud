/* team-lookup.ts — whose address a mailbox or calendar is, read with the
 * service role for the functions that connect and read them
 * (connection-rules.ts decides what that means). A team is small enough to read
 * whole, and addresses are compared without case. Kept free of imports so
 * team-lookup.test.js runs it in node.
 */

// deno-lint-ignore no-explicit-any
type Admin = any;

/* Every team member's address, lower-cased, to their employee id — the first
   member to hold an address, should two ever share one. A team that cannot be
   read is an error, never "nobody": nobody would pass every check. */
export async function teamAddresses(admin: Admin): Promise<Map<string, string>> {
  const { data, error } = await admin.from('employees').select('id, email, created_at').order('created_at');
  if (error) throw new Error(`Could not read the team: ${error.message}`);
  const byAddress = new Map<string, string>();
  for (const member of data ?? []) {
    const address = String(member.email ?? '').trim().toLowerCase();
    if (address && !byAddress.has(address)) byAddress.set(address, String(member.id));
  }
  return byAddress;
}

/* The employee whose address this is, or null. */
export async function employeeByAddress(admin: Admin, address: string | null | undefined): Promise<string | null> {
  const wanted = String(address ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return (await teamAddresses(admin)).get(wanted) ?? null;
}
