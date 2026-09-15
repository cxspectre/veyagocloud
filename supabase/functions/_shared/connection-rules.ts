/* connection-rules.ts — whose a mailbox or calendar connection is, what may be
 * read through it, and who may act on it.
 *
 * Asked by the functions that work with the service role, which RLS does not
 * stop: 0038 and 0044 draw the line for the browser — the studio's connections
 * and your own — and these draw the same line in the functions (security
 * review, 2026-09-14). Kept free of imports so connection-rules.test.js runs it
 * in node.
 */

export type Connection = {
  employee_id: string | null;
  account_label: string;
  external_id?: string | null;
  status?: string | null;
};

export type Refusal = { status: number; message: string };

/* Disconnecting keeps the row, and with it the owner, so handing a mailbox to
   someone else means removing the connection. The workspace has no way to do
   that yet, and a manager may only remove the studio's connections or their
   own (0038) — so the message says where it can be done, not what to click. */
export const OWNER_KEPT = 'This mailbox is already connected for someone else, and a connection keeps its owner. '
  + 'To hand it over, its connection has to be removed first — for now, in the database.';

/* What to do about a connection that exists and is refused for its address:
   "connect it as theirs" led straight into OWNER_KEPT. Nothing connected yet is
   simply started again the right way (microsoft-connect). */
export const REMOVE_FIRST = 'A connection keeps its address and owner, so to change either it has to be removed first '
  + '— for now, in the database.';

/* A connection's address against the team. A studio connection is read by
   every member of staff, so its address must not be a team member's own; a
   personal one must not be another team member's. `labelOwner` is the
   employee whose address the label is, if any (team-lookup.ts). It says what is
   wrong, not what to do: that depends on whether the connection exists yet. */
export function labelProblem(employeeId: string | null, labelOwner: string | null): string | null {
  if (!labelOwner) return null;
  if (employeeId === null) {
    return 'A studio connection cannot be a team member’s own mailbox or calendar.';
  }
  return labelOwner === employeeId ? null : 'This address belongs to another team member.';
}

/* Whether a connection may be read, or why not. Beyond its address, a studio
   connection must record who consented: without that it is read as /me — the
   consenting person's own mailbox or diary, shown to everyone (mailbox.ts). */
export function connectionProblem(conn: Connection, labelOwner: string | null): string | null {
  const byAddress = labelProblem(conn.employee_id, labelOwner);
  if (byAddress) return byAddress;
  if (conn.employee_id === null && !String(conn.external_id ?? '').trim()) {
    return 'Reconnect this studio connection: who consented to it is not recorded.';
  }
  return null;
}

/* Who may act on a connection through a function: the studio's, or your own. */
export function mayActOn(conn: { employee_id: string | null }, callerEmployeeId: string | null): boolean {
  return conn.employee_id === null || (callerEmployeeId !== null && conn.employee_id === callerEmployeeId);
}

/* What anyone but an owner or admin hears about something new — and about a
   colleague's connection too, so nobody learns which addresses a colleague has
   connected (0044 hides them). */
const NEW_ONLY_FOR_MANAGERS: Refusal = Object.freeze({
  status: 403,
  message: 'Only an owner or admin can connect a new mailbox or calendar.',
});

/* Why microsoft-connect must not start a consent, with the status to answer —
   or null. Owners and admins connect a new mailbox or calendar, saying whose
   it is, and reconnect the studio's; anyone on staff reconnects their own.
   Nobody reconnects a colleague's: consenting to it as someone else would put
   another mailbox behind it. An owner or admin who asks about an address a
   colleague has connected hears OWNER_KEPT, so they can tell that it is
   connected — they add and remove the team, and a personal connection's
   address is its owner's own. What 0044 keeps from them is the connection
   itself: its status, its errors and its mail. */
export function connectRefusal(request: {
  manager: boolean;
  callerEmployeeId: string | null;
  previous: { employee_id: string | null } | null;
  saysWho: boolean;
  employeeId: string | null;
}): Refusal | null {
  const { manager, callerEmployeeId, previous, saysWho, employeeId } = request;
  if (previous) {
    if (!mayActOn(previous, callerEmployeeId)) return manager ? { status: 409, message: OWNER_KEPT } : NEW_ONLY_FOR_MANAGERS;
    if (previous.employee_id === null && !manager) {
      return { status: 403, message: 'Only an owner or admin can reconnect a studio mailbox or calendar.' };
    }
    if (saysWho && (employeeId ?? null) !== (previous.employee_id ?? null)) return { status: 409, message: OWNER_KEPT };
    return null;
  }
  if (!manager) return NEW_ONLY_FOR_MANAGERS;
  if (!saysWho) {
    return { status: 400, message: 'Say whose this is: the studio’s (employeeId null), or a team member’s own.' };
  }
  return null;
}

/* Whether a stored grant carries a scope, however Microsoft wrote the scopes
   it granted — with the resource in front or without. No record is no scope. */
export function grantCovers(scope: string | null | undefined, needed: string): boolean {
  const wanted = String(needed).toLowerCase();
  return String(scope ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((granted) => granted === wanted || granted.endsWith('/' + wanted));
}

/* The scope microsoft-callback checks a connection's address against the
   directory with. */
export const DIRECTORY_SCOPE = 'User.ReadBasic.All';

/* A studio connection whose grant lacks DIRECTORY_SCOPE was made before its
   address was checked against the directory, and could be a team member's
   sign-in name the team does not store — shown to every member of staff. It is
   not read until it is reconnected. A personal one is read as its owner's own.
   `scope` is the stored grant's (storedGrant in graph-token.ts). */
export function grantProblem(conn: { employee_id: string | null }, scope: string | null | undefined): string | null {
  if (conn.employee_id !== null) return null;
  return grantCovers(scope, DIRECTORY_SCOPE)
    ? null
    : 'Reconnect this studio connection, so its address can be checked against the directory.';
}

/* ── The directory ──────────────────────────────────────────────────────── */

/* An account as the directory has it: its id, and every address it goes by —
   mail and sign-in name (UPN), lower-cased, once each. */
export type DirectoryEntry = { id: string; addresses: string[] };

export function directoryEntry(
  user: { id?: unknown; mail?: unknown; userPrincipalName?: unknown } | null | undefined,
): DirectoryEntry | null {
  if (!user || typeof user !== 'object') return null;
  const addresses = [user.mail, user.userPrincipalName]
    .map((address) => String(address ?? '').trim().toLowerCase())
    .filter((address, i, all) => address !== '' && all.indexOf(address) === i);
  const id = String(user.id ?? '');
  return id || addresses.length ? { id, addresses } : null;
}

/* The Graph query that finds an address in the directory, by mail or sign-in
   name. A quote in the address is doubled, as OData wants it. */
export function directoryQuery(address: string): string {
  const quoted = String(address ?? '').trim().toLowerCase().replace(/'/g, "''");
  const filter = `mail eq '${quoted}' or userPrincipalName eq '${quoted}'`;
  return `/users?$filter=${encodeURIComponent(filter)}&$select=id,mail,userPrincipalName`;
}

/* A connection's address as the directory knows it, against the team: every
   address the directory has for it counts — a sign-in name the team does not
   store is still that person's mailbox — and a studio connection is never the
   consenting account itself (security review, 2026-09-14). A mailbox read
   through someone else's grant (/users/{label}, mailbox.ts) must be exactly one
   account the directory knows by that address: the lookup matches main
   addresses and sign-in names only, so an alias it does not find could be
   anyone's mailbox, a team member's own included. `found` is what the directory
   returned for the label — the consenting account itself when the label is its
   own address, read as /me; `ownerOf` names the team member an address belongs
   to. */
export function directoryProblem(check: {
  employeeId: string | null;
  label: string;
  consenter: DirectoryEntry;
  found: DirectoryEntry[];
  ownerOf: (address: string) => string | null;
}): string | null {
  const { employeeId, label, consenter, found, ownerOf } = check;
  const own = 'A studio connection cannot be the consenting person’s own mailbox or calendar.';
  const consentersOwn = consenter.addresses.includes(String(label ?? '').trim().toLowerCase());
  if (employeeId === null && consentersOwn) return own;
  if (!consentersOwn && found.length !== 1) {
    return found.length
      ? 'More than one account in the directory goes by this address, so whose it is cannot be told.'
      : 'The directory has no account with this as its main address or sign-in name. Connect it by that address, not an alias.';
  }
  for (const entry of found) {
    if (employeeId === null && entry.id !== '' && entry.id === consenter.id) return own;
    for (const address of entry.addresses) {
      const problem = labelProblem(employeeId, ownerOf(address));
      if (problem) return problem;
    }
  }
  return null;
}
