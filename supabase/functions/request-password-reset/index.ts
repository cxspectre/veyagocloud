/* request-password-reset — sends a BRANDED reset email through Resend instead
   of Supabase's default unstyled one.

   Deploy:  supabase functions deploy request-password-reset --no-verify-jwt
   Secrets: RESEND_API_KEY, EMAIL_FROM, SITE_URL

   --no-verify-jwt is REQUIRED and is the interesting part: someone who has
   forgotten their password has no session, so this endpoint must be reachable
   unauthenticated. That makes it the only public write-ish surface in the
   system, so it is deliberately paranoid:

     • It never reveals whether an address has an account (same response, same
       timing budget, either way). Otherwise it becomes an account-enumeration
       oracle for the whole company.
     • It rate-limits per address AND per IP, so it cannot be used to mail-bomb
       someone or burn the Resend quota.
     • It generates the recovery link with the service role but never returns
       it — the link only ever travels by email. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { resetEmail, sendEmail } from '../_shared/email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* Deliberately identical for "sent", "no such account", and "rate limited". */
const NEUTRAL = {
  ok: true,
  message: 'If that address has an account, a reset link is on its way.',
};

const MAX_PER_ADDRESS = 3;      // per window
const MAX_PER_IP = 10;          // per window
const WINDOW_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      /* A malformed address is a client bug, not an enumeration attempt. */
      return json({ error: 'Enter a valid email address.' }, 400);
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('cf-connecting-ip') ??
      'unknown';

    /* Rate limit before doing any work. Failing OPEN here would hand out a
       mail-bomb primitive, so a broken limiter must block, not allow. */
    const { data: allowed, error: rlErr } = await admin.rpc('consume_reset_quota', {
      p_email: email,
      p_ip: ip,
      p_max_email: MAX_PER_ADDRESS,
      p_max_ip: MAX_PER_IP,
      p_window_minutes: WINDOW_MINUTES,
    });
    if (rlErr) {
      console.error('request-password-reset: rate limiter failed:', rlErr.message);
      return json(NEUTRAL);   // fail closed, but stay neutral to the caller
    }
    if (allowed === false) return json(NEUTRAL);

    const siteUrl = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');

    /* generateLink creates the recovery link WITHOUT sending Supabase's own
       email — that is what lets us send our own. It errors for an unknown
       address; that must look identical to success from outside. */
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${siteUrl}/admin/` },
    });

    if (linkErr || !link?.properties?.action_link) {
      console.warn('request-password-reset: no link for', email, linkErr?.message ?? '(unknown address)');
      return json(NEUTRAL);
    }

    const tpl = resetEmail({ actionLink: link.properties.action_link });
    const sent = await sendEmail({ to: email, ...tpl });
    if (!sent.ok && !sent.skipped) {
      console.error('request-password-reset: send failed:', sent.error);
    }
    return json(NEUTRAL);
  } catch (err) {
    console.error('request-password-reset error:', err);
    /* Even a crash stays neutral — an error that only appears for real
       addresses is itself an enumeration signal. */
    return json(NEUTRAL);
  }
});
