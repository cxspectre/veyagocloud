/* website-enquiry — receives the "Get a quote" form from /websites/ and /services/.
 *
 * Deploy:  supabase functions deploy website-enquiry --no-verify-jwt
 * Secrets: RESEND_API_KEY, SITE_URL                   (shared with the others)
 *          EMAIL_FROM           REQUIRED here: the acknowledgement lands in a
 *                               stranger's inbox signed as Veyago, so the
 *                               Resend test sender is never an acceptable
 *                               fallback the way it is for internal mail
 *          ENQUIRY_TO           where leads go        (default hello@veyago.cloud)
 *          ENQUIRY_IP_SALT      salt for the IP hash  (REQUIRED; any long random string)
 *          ENQUIRY_ORIGINS      comma-separated allowed origins
 *                               (default https://www.veyago.cloud,https://veyago.cloud;
 *                                Vercel previews and localhost are always allowed)
 * Migrations: 0019_website_enquiries.sql, 0020_enquiry_ops.sql
 *
 * Why this exists: the public site makes no third-party calls, so a form
 * provider was never an option. This is the first-party alternative: the page
 * POSTs here, we store the lead, mail ourselves through Resend, and send the
 * visitor a fixed acknowledgement in their language. If any of that fails the
 * page falls back to a pre-filled mailto:, so an enquiry is never silently lost.
 *
 * --no-verify-jwt is required: a prospective client has no account. That makes
 * this a public write surface, so, like request-password-reset, it is paranoid:
 *
 *   • Every field is validated and clipped server-side (_shared/enquiry.ts).
 *   • A honeypot field and a fill-time check catch the dumb bots; they get a
 *     cheerful 200 and nothing is stored or sent.
 *   • Per-address and per-IP quotas live in Postgres (submit_website_enquiry),
 *     logged for every attempt so a burst cannot reset its own window. The
 *     limiter failing means "no", never "yes".
 *   • The acknowledgement never echoes visitor text, so the endpoint cannot be
 *     turned into a relay for sending arbitrary content to arbitrary addresses.
 *   • CORS is pinned to our own origins, not '*'.
 *
 * After the lead is stored, three things happen, all best-effort — none may
 * fail the request, because the lead already exists and the visitor has been
 * promised a reply: we are emailed, the visitor is acknowledged, and a
 * follow-up task lands on the board due the next New York working day. Both
 * sends are written to email_log, so /admin/leads can flag a lead nobody was
 * told about instead of it quietly ageing.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { packageLabel, parseEnquiry, type Enquiry } from '../_shared/enquiry.ts';
import { buildEnquiryTask } from '../_shared/enquiry-task.ts';
import { enquiryAckEmail, enquiryEmail, sendEmail, type SendResult } from '../_shared/email.ts';

const DEFAULT_ORIGINS = ['https://www.veyago.cloud', 'https://veyago.cloud'];
const MAX_BODY_BYTES = 16 * 1024;

/* Vercel preview deployments of this repository: veyagocloud-<branch>-ieglobal-pe
   and the bare veyagocloud-ieglobal-pe. Allowed so a preview can be tested end
   to end without editing ENQUIRY_ORIGINS for every branch. Anchored on both
   ends and pinned to the team slug, so veyagocloud-x-ieglobal-pe.vercel.app.evil
   does not match. */
const PREVIEW_ORIGIN_RE = /^https:\/\/veyagocloud(-[a-z0-9-]+)?-ieglobal-pe\.vercel\.app$/;
/* Local previews (python3 tools/serve.py) run on http://localhost:<port>. */
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function allowedOrigins(): string[] {
  const raw = Deno.env.get('ENQUIRY_ORIGINS');
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return list;
}

function originAllowed(origin: string | null): string | null {
  if (!origin) return null;
  if (allowedOrigins().includes(origin)) return origin;
  if (PREVIEW_ORIGIN_RE.test(origin)) return origin;
  if (LOCAL_ORIGIN_RE.test(origin)) return origin;
  return null;
}

function corsFor(origin: string | null): Record<string, string> {
  const allowed = originAllowed(origin);
  return {
    'Access-Control-Allow-Origin': allowed ?? DEFAULT_ORIGINS[0],
    'Access-Control-Allow-Headers': 'content-type, accept, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ── After the insert: all best-effort ─────────────────────────────────── */

/* Mirrors how notify-task records a send: who, what kind, whether it worked.
   `reference` is the enquiry id, so the admin can tell "this lead was never
   relayed" from "the log is empty". A logging failure is itself only logged. */
async function logEmail(
  admin: SupabaseClient,
  row: { to_email: string; kind: 'enquiry_notify' | 'enquiry_ack'; subject: string; reference: string },
  sent: SendResult,
): Promise<void> {
  const { error } = await admin.from('email_log').insert({
    ...row,
    ok: sent.ok,
    error: sent.ok ? null : (sent.error ?? null),
  });
  if (error) console.warn(`website-enquiry: could not log the ${row.kind} email:`, error.message);
}

/* Who the follow-up task is for. tasks.assignee_id is nullable, but an
   unassigned task sits under "Unassigned" on the board and in nobody's Mine
   filter, so it goes to the first active owner, then the first active admin.
   Nothing here emails anyone: notify-task is only ever invoked from the admin
   UI, and the owner has just received the enquiry itself. */
async function firstManager(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from('employees')
    .select('id,role')
    .eq('status', 'active')
    .in('role', ['owner', 'admin'])
    .order('created_at', { ascending: true })
    .limit(20);
  if (error || !data?.length) return null;
  const owner = data.find((r: { role: string }) => r.role === 'owner');
  return (owner ?? data[0]).id;
}

async function createFollowUpTask(
  admin: SupabaseClient,
  e: Enquiry,
  id: string,
  label: string,
  site: string,
): Promise<void> {
  try {
    const task = buildEnquiryTask({
      id,
      kind: e.kind,
      name: e.name,
      email: e.email,
      business: e.business,
      website: e.website,
      message: e.message,
      packageLabel: label,
      leadUrl: `${site}/admin/leads?id=${id}`,
    }, new Date().toISOString());
    const assignee = await firstManager(admin);
    /* created_by stays NULL: there is no signed-in user, and 0006 defaults it
       to auth.uid() server-side, which is null for the service role. */
    const { error } = await admin.from('tasks').insert({ ...task, assignee_id: assignee });
    if (error) console.warn('website-enquiry: could not create the follow-up task:', error.message);
  } catch (err) {
    console.warn('website-enquiry: follow-up task skipped:', err instanceof Error ? err.message : String(err));
  }
}

/* ── Request handling ──────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsFor(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, cors);
  if (origin && !originAllowed(origin)) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);

  try {
    /* Refuse oversized bodies before buffering them; the length check after
       reading catches clients that lie about Content-Length. */
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return json({ ok: false, error: 'Message too long.' }, 413, cors);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Message too long.' }, 413, cors);
    let body: unknown = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }

    const parsed = parseEnquiry(body);
    if (!parsed.ok) {
      /* Bots get a success they cannot distinguish from the real thing. */
      if (parsed.bot) return json({ ok: true }, 200, cors);
      return json({ ok: false, error: parsed.error, field: parsed.field ?? null }, 400, cors);
    }
    const e = parsed.value;

    /* Two secrets without which this must not run at all. No salt means a
       reversible IP, which the migration promises we never store. No sender
       means the acknowledgement would go out from Resend's test address —
       to a stranger, signed as us. Both are configuration, so both are 500s
       with a log line, and the page shows its mailto fallback. */
    const salt = Deno.env.get('ENQUIRY_IP_SALT');
    if (!salt) {
      console.error('website-enquiry: ENQUIRY_IP_SALT is not set; refusing to run');
      return json({ ok: false, error: 'server' }, 500, cors);
    }
    if (!Deno.env.get('EMAIL_FROM')) {
      console.error('website-enquiry: EMAIL_FROM is not set; refusing to run');
      return json({ ok: false, error: 'server' }, 500, cors);
    }

    /* The client IP, from the edge's own headers only. cf-connecting-ip is set
       by the edge and cannot be spoofed; in x-forwarded-for the edge APPENDS
       the real address, so the LAST hop is trustworthy and the first is
       whatever the caller typed. Reading the first hop would let anyone mint
       a fresh "IP" per request and walk straight past the quota. */
    const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = req.headers.get('cf-connecting-ip') ?? xff[xff.length - 1] ?? 'unknown';
    const ipHash = await sha256Hex(ip + '|' + salt);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: id, error: rpcErr } = await admin.rpc('submit_website_enquiry', {
      p_kind: e.kind,
      p_name: e.name,
      p_email: e.email,
      p_business: e.business,
      p_website: e.website,
      p_message: e.message,
      p_locale: e.locale,
      p_page: e.page,
      p_ip_hash: ipHash,
      p_package: e.package,
    });
    if (rpcErr) {
      /* Fail closed: a broken limiter must not turn into an open relay. The
         page shows its mailto fallback, so the visitor still has a path. */
      console.error('website-enquiry: submit_website_enquiry failed:', rpcErr.message);
      return json({ ok: false, error: 'server' }, 500, cors);
    }
    if (!id) return json({ ok: false, error: 'rate_limited' }, 429, cors);

    const ref = String(id);
    const label = packageLabel(e.package);
    const site = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');

    /* Both mails are best-effort: the lead is already stored, so a mail hiccup
       must never look to the visitor like the enquiry failed. Each send is
       logged whether or not it worked — a skipped send (no Resend key) is
       logged as a failure too, which is what it is from the lead's point of view. */
    const to = Deno.env.get('ENQUIRY_TO') ?? 'hello@veyago.cloud';
    const notifyTpl = enquiryEmail({
      id: ref, kind: e.kind, name: e.name, email: e.email, business: e.business,
      website: e.website, message: e.message, locale: e.locale, page: e.page, packageLabel: label,
    });
    const notify = await sendEmail({ to, replyTo: e.email, ...notifyTpl });
    if (!notify.ok && !notify.skipped) console.error('website-enquiry: notify failed:', notify.error);
    await logEmail(admin, { to_email: to, kind: 'enquiry_notify', subject: notifyTpl.subject, reference: ref }, notify);

    const ackTpl = enquiryAckEmail({ name: e.name, kind: e.kind, locale: e.locale });
    const ack = await sendEmail({ to: e.email, ...ackTpl });
    if (!ack.ok && !ack.skipped) console.error('website-enquiry: ack failed:', ack.error);
    await logEmail(admin, { to_email: e.email, kind: 'enquiry_ack', subject: ackTpl.subject, reference: ref }, ack);

    const stamps: Record<string, string> = {};
    if (notify.ok) stamps.notified_at = new Date().toISOString();
    if (ack.ok) stamps.ack_sent_at = new Date().toISOString();
    if (Object.keys(stamps).length) {
      const { error: upErr } = await admin.from('website_enquiries').update(stamps).eq('id', id);
      if (upErr) console.warn('website-enquiry: could not stamp delivery:', upErr.message);
    }

    await createFollowUpTask(admin, e, ref, label, site);

    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('website-enquiry error:', err);
    return json({ ok: false, error: 'server' }, 500, cors);
  }
});
