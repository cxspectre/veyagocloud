/* invite-employee — sends a Supabase Auth invite email and creates/links the
   employees row. The service-role key only ever lives here (server-side).

   Deploy:  supabase functions deploy invite-employee
   Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.

   Caller must be a manager (owner/admin role, or on the admins allowlist) —
   verified against their JWT before anything happens. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { inviteEmail, sendEmail } from '../_shared/email.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization') ?? '';

    /* Verify the caller: resolve their JWT, then check manager rights via the
       same SECURITY DEFINER helper the RLS policies use. */
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);

    const { data: isManager, error: roleErr } = await asCaller.rpc('is_manager');
    if (roleErr || !isManager) return json({ error: 'Managers only' }, 403);

    const body = await req.json();
    const email = String(body.email ?? '').trim().toLowerCase();
    const fullName = String(body.full_name ?? '').trim();
    const role = String(body.role ?? 'employee');
    const title = body.title ? String(body.title).trim() : null;
    const startDate = body.start_date ? String(body.start_date) : null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);
    if (!fullName) return json({ error: 'Full name is required' }, 400);
    if (!['owner', 'admin', 'assistant', 'employee'].includes(role)) {
      return json({ error: 'Invalid role' }, 400);
    }

    const admin = createClient(url, serviceKey);

    /* Who is inviting — makes the email read "Cassian has added you" rather
       than the passive "You have been added". Best-effort. */
    let inviterName: string | undefined;
    {
      const me = await asCaller.from('employees')
        .select('full_name').eq('user_id', userData.user.id).maybeSingle();
      inviterName = me.data?.full_name ?? undefined;
    }

    /* Send the invite email. If the auth user already exists, continue and
       just (re)create the employee record linked to them. */
    /* The app origin must come from config, NOT from req.url — that is the
       Supabase API domain (https://<ref>.supabase.co), which has no /admin/
       page, so invitees landed on a 404. Set it once with:
         supabase secrets set SITE_URL=https://www.veyago.cloud
       and add <SITE_URL>/admin/ to Auth → URL Configuration → Redirect URLs. */
    const siteUrl = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');

    /* ── Preflight ──────────────────────────────────────────────────────
       Everything above this line is reads and env lookups. Everything below
       writes: createUser, generateLink (which mints a token), the employees
       upsert, the send, the log. So a dry run must return HERE — the whole
       point is to tell the caller that delivery is impossible BEFORE an
       account exists that nobody can sign into.

       Reports `reason`, never `error`: the browser helper (roles.js invokeFn)
       throws on any 200 body carrying a truthy `error`, which would turn a
       successful preflight answer into an exception. */
    if (body.dryRun === true) {
      const hasKey = !!Deno.env.get('RESEND_API_KEY');
      /* EMAIL_FROM is a weaker, separate signal. Unset, email.ts falls back to
         Resend's shared onboarding@resend.dev, which on an unverified account
         silently delivers only to the account owner — so the send "succeeds"
         and the invitee still gets nothing. Worth warning about; not worth
         blocking on, because a verified account may legitimately leave it. */
      const hasFrom = !!Deno.env.get('EMAIL_FROM');

      /* Rendered with a placeholder link: the real one comes from
         generateLink, which is itself a write. */
      const preview = inviteEmail({
        name: fullName || 'Alex Doe',
        inviterName,
        role,
        actionLink: siteUrl + '/admin/',
      });

      return json({
        ok: true,
        dryRun: true,
        emailReady: hasKey,
        fromConfigured: hasFrom,
        reason: hasKey
          ? (hasFrom ? null
            : 'EMAIL_FROM is not set, so invites are sent from Resend’s shared address. Until your own domain is verified, only your own inbox will receive them.')
          : 'RESEND_API_KEY is not set, so no invite email can be delivered.',
        remedy: hasKey ? null : 'supabase secrets set RESEND_API_KEY=re_…',
        preview: { subject: preview.subject, html: preview.html },
      });
    }

    /* createUser + generateLink instead of inviteUserByEmail: inviteUserByEmail
       sends Supabase's own unbranded mail, and an invite is the first thing a
       new hire ever sees from the company. Creating the user separately lets us
       mint the link and deliver it ourselves through Resend. */
    let authUserId: string | null = null;

    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,                       // the invite link is the confirmation
      user_metadata: { full_name: fullName },
    });
    if (created.data?.user) {
      authUserId = created.data.user.id;
    } else if (created.error && !/already|registered|exists/i.test(created.error.message)) {
      return json({ error: 'Could not create the account: ' + created.error.message }, 400);
    }

    if (!authUserId) {
      const existing = await admin.auth.admin.listUsers({ perPage: 1000 });
      authUserId = existing.data?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
    }

    /* An invite link for a brand-new user, a recovery link for someone who
       already had an account — both land on the "choose a password" step. */
    const linkType = created.data?.user ? 'invite' : 'recovery';
    const link = await admin.auth.admin.generateLink({
      type: linkType as 'invite' | 'recovery',
      email,
      options: { redirectTo: `${siteUrl}/admin/` },
    });
    if (link.error || !link.data?.properties?.action_link) {
      return json({ error: 'Could not generate the invite link: ' + (link.error?.message ?? 'unknown') }, 400);
    }

    const { data: employee, error: empErr } = await admin
      .from('employees')
      .upsert(
        {
          email,
          full_name: fullName,
          role,
          title,
          start_date: startDate,
          user_id: authUserId,
          status: 'invited',
        },
        { onConflict: 'email' },
      )
      .select()
      .single();
    if (empErr) return json({ error: 'Employee record failed: ' + empErr.message }, 400);

    const tpl = inviteEmail({
      name: fullName,
      inviterName: inviterName,
      role: role,
      actionLink: link.data.properties.action_link,
    });
    const sent = await sendEmail({ to: email, ...tpl });

    await admin.from('email_log').insert({
      to_email: email,
      kind: 'invite',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
    });

    /* The record exists either way. The email is what may have failed, and the
       caller needs to know — without it they cannot get in at all.

       On failure we also hand back the sign-in link. It was already minted at
       generateLink above and was previously thrown away, which left the admin
       with an account nobody could reach and no way to fix it by hand. It is
       returned ONLY when the send failed: this is a single-use credential, so
       it should not be sitting in a response body that nothing needs it in.
       The caller is already a verified manager (checked at the top). */
    return json({
      ok: true,
      employee,
      invited: linkType === 'invite',
      emailSent: sent.ok,
      emailError: sent.ok ? null : (sent.skipped
        ? 'Email is not configured yet (RESEND_API_KEY is not set), so no invite was delivered.'
        : sent.error),
      actionLink: sent.ok ? null : link.data.properties.action_link,
      sentAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('invite-employee error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
