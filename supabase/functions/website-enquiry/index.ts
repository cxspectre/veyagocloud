/* website-enquiry — receives the "Get a quote" form from /websites/ and /services/.
 *
 * Deploy:  supabase functions deploy website-enquiry --no-verify-jwt
 * Secrets: RESEND_API_KEY, EMAIL_FROM, SITE_URL          (shared with the others)
 *          ENQUIRY_TO           where leads go        (default hello@veyago.cloud)
 *          ENQUIRY_IP_SALT      salt for the IP hash  (REQUIRED; any long random string)
 *          ENQUIRY_ORIGINS      comma-separated allowed origins
 *                               (default https://www.veyago.cloud,https://veyago.cloud)
 * Migration: 0019_website_enquiries.sql
 *
 * Why this exists: the public site makes no third-party calls, so a form
 * provider was never an option. This is the first-party alternative: the page
 * POSTs here, we store the lead, mail ourselves through Resend, and send the
 * visitor a fixed acknowledgement. If any of that fails the page falls back to
 * a pre-filled mailto:, so an enquiry is never silently lost.
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
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseEnquiry } from '../_shared/enquiry.ts';
import { enquiryAckEmail, enquiryEmail, sendEmail } from '../_shared/email.ts';

const DEFAULT_ORIGINS = ['https://www.veyago.cloud', 'https://veyago.cloud'];
const MAX_BODY_BYTES = 16 * 1024;

function allowedOrigins(): string[] {
  const raw = Deno.env.get('ENQUIRY_ORIGINS');
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return list;
}

/* Local previews (python3 tools/serve.py) run on http://localhost:<port>. */
function originAllowed(origin: string | null): string | null {
  if (!origin) return null;
  if (allowedOrigins().includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
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

    /* The client IP, from the edge's own headers only. cf-connecting-ip is set
       by the edge and cannot be spoofed; in x-forwarded-for the edge APPENDS
       the real address, so the LAST hop is trustworthy and the first is
       whatever the caller typed. Reading the first hop would let anyone mint
       a fresh "IP" per request and walk straight past the quota. */
    const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = req.headers.get('cf-connecting-ip') ?? xff[xff.length - 1] ?? 'unknown';

    /* No salt, no service: a hash with a salt that lives in this repository
       is a reversible IP, which the migration promises we never store. */
    const salt = Deno.env.get('ENQUIRY_IP_SALT');
    if (!salt) {
      console.error('website-enquiry: ENQUIRY_IP_SALT is not set; refusing to run');
      return json({ ok: false, error: 'server' }, 500, cors);
    }
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
    });
    if (rpcErr) {
      /* Fail closed: a broken limiter must not turn into an open relay. The
         page shows its mailto fallback, so the visitor still has a path. */
      console.error('website-enquiry: submit_website_enquiry failed:', rpcErr.message);
      return json({ ok: false, error: 'server' }, 500, cors);
    }
    if (!id) return json({ ok: false, error: 'rate_limited' }, 429, cors);

    /* Both mails are best-effort: the lead is already stored, so a mail hiccup
       must never look to the visitor like the enquiry failed. */
    const to = Deno.env.get('ENQUIRY_TO') ?? 'hello@veyago.cloud';
    const notify = await sendEmail({ to, replyTo: e.email, ...enquiryEmail({ id: String(id), ...e }) });
    if (!notify.ok && !notify.skipped) console.error('website-enquiry: notify failed:', notify.error);

    const ack = await sendEmail({ to: e.email, ...enquiryAckEmail({ name: e.name, kind: e.kind }) });
    if (!ack.ok && !ack.skipped) console.error('website-enquiry: ack failed:', ack.error);

    const stamps: Record<string, string> = {};
    if (notify.ok) stamps.notified_at = new Date().toISOString();
    if (ack.ok) stamps.ack_sent_at = new Date().toISOString();
    if (Object.keys(stamps).length) {
      const { error: upErr } = await admin.from('website_enquiries').update(stamps).eq('id', id);
      if (upErr) console.warn('website-enquiry: could not stamp delivery:', upErr.message);
    }

    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('website-enquiry error:', err);
    return json({ ok: false, error: 'server' }, 500, cors);
  }
});
