/* connection-check.ts — whether a function may read or act through a
 * connection, with what the rules need fetched: its address against the team
 * and, for a studio connection, whether its grant was checked against the
 * directory. The rules themselves are connection-rules.ts, tested in node; this
 * only asks the database for what they decide from.
 */
import { connectionProblem, grantProblem, type Connection } from './connection-rules.ts';
import { storedGrant } from './graph-token.ts';
import { employeeByAddress } from './team-lookup.ts';

// deno-lint-ignore no-explicit-any
type Admin = any;

/* Why a connection may not be used, or null. Throws when the team or the grant
   cannot be read: a failed check is not a problem with the connection, and
   callers say so rather than flag the connection for it. A personal
   connection's grant is not read: it is read as its owner's own. */
export async function connectionCheck(admin: Admin, conn: Connection & { id: string }): Promise<string | null> {
  const problem = connectionProblem(conn, await employeeByAddress(admin, conn.account_label));
  if (problem || conn.employee_id !== null) return problem;
  return grantProblem(conn, (await storedGrant(admin, conn.id))?.scope);
}
