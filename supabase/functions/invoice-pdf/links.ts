/* What an invoice is for: the CRM company and the client project it bills.
 *
 * finance_invoices carried only the client's name (0005). 0051 gives it
 * company_id and project_id, and a request may name either. Both are checked
 * before anything is rendered or emailed, with the service role once the
 * caller is known to be a manager: each must be an id, exist and not be
 * deleted, and the project must not be another company's. The database
 * refuses that pair too, but only as the invoice is saved — after its email
 * has gone out.
 *
 * The pair checked is the one the invoice will hold: a link the request leaves
 * out keeps the one stored, since the record does not write it (record.ts).
 * And, as in the database, a pair that disagrees is refused only when this
 * write is what makes it disagree. An invoice keeps its company when its
 * project moves to another (0051), so one sent again may name the links it
 * already has, or another company, and still go out; a project named for it
 * is held to that project's company, as a company named for an invoice that
 * agrees with its project is.
 *
 * No imports, on purpose: links.test.js loads this file in Node on its own,
 * the same way record.ts is tested.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Links {
  companyId: string | null;
  projectId: string | null;
}

/* What an invoice being sent again is already linked to. */
export interface StoredLinks {
  company_id?: string | null;
  project_id?: string | null;
}

type Db = { from: (table: string) => any };

type Verdict = { status: number; error: string | null };

const FINE: Verdict = { status: 200, error: null };

/* company_id and project_id off a request. Left out, null or '' names nothing;
   anything else has to be an id, read in lower case as the database hands ids
   back, so two spellings of one id compare equal. */
export function linksFrom(body: unknown): Links & { error: string | null } {
  const fields: Record<string, unknown> = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const read = (key: string, what: string): { id: string | null; error: string | null } => {
    const value = fields[key];
    if (value === undefined || value === null || value === '') return { id: null, error: null };
    if (typeof value !== 'string' || !UUID.test(value)) return { id: null, error: `That is not a valid ${what} id.` };
    return { id: value.toLowerCase(), error: null };
  };
  const company = read('company_id', 'company');
  const project = read('project_id', 'project');
  return { companyId: company.id, projectId: project.id, error: company.error ?? project.error };
}

/* Whether what a request names may go on the invoice: a company in the CRM and
   a project in the workspace, neither deleted, and no project for another
   company than the invoice's. `existing` is the invoice being sent again, if
   any. With nothing named nothing changes, so nothing is looked up. */
export async function checkLinks(db: Db, links: Links, existing: StoredLinks | null): Promise<Verdict> {
  if (!links.companyId && !links.projectId) return FINE;

  if (links.companyId) {
    const { data, error } = await db
      .from('crm_companies')
      .select('id,deleted_at')
      .eq('id', links.companyId)
      .maybeSingle();
    if (error) return { status: 500, error: 'The company could not be checked: ' + error.message };
    if (!data || data.deleted_at) return { status: 400, error: 'That company is not in the CRM.' };
  }

  const companyId = links.companyId ?? existing?.company_id ?? null;
  const projectId = links.projectId ?? existing?.project_id ?? null;
  if (!projectId) return FINE;

  /* The project named, or the one the invoice is under when only a company is
     named: either way, its company has to be the invoice's. */
  const { data: project, error } = await db
    .from('client_projects')
    .select('id,company_id,deleted_at')
    .eq('id', projectId)
    .maybeSingle();
  if (error) return { status: 500, error: 'The project could not be checked: ' + error.message };
  if (links.projectId && (!project || project.deleted_at)) {
    return { status: 400, error: 'That project is not in the workspace.' };
  }
  if (!project?.company_id || !companyId || project.company_id === companyId) return FINE;

  /* They disagree. Refused, as link_invoice (0051) refuses it, unless this
     write is not what makes them disagree: it names nothing the invoice does
     not already hold, or only a company, for an invoice whose company was
     already another than its project's. */
  const projectChanged = !existing || (links.projectId !== null && links.projectId !== existing.project_id);
  const companyChanged = !existing || (links.companyId !== null && links.companyId !== existing.company_id);
  const apartBefore = !projectChanged && !!existing?.company_id && existing.company_id !== project.company_id;
  if ((projectChanged || companyChanged) && !apartBefore) {
    return { status: 400, error: 'That project belongs to a different company than the invoice.' };
  }
  return FINE;
}
