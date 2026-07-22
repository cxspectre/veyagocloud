/* invite-employee — sends a Supabase Auth invite email and creates/links the
   employees row. The service-role key only ever lives here (server-side).

   Deploy:  supabase functions deploy invite-employee
   Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.

   Caller must be a manager (owner/admin role, or on the admins allowlist) —
   verified against their JWT before anything happens. */

import { createClient } from 'npm:@supabase/supabase-js@2';

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

    /* Send the invite email. If the auth user already exists, continue and
       just (re)create the employee record linked to them. */
    const invite = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: `${new URL(req.url).origin.replace('.functions.', '.')}/admin/`,
    });
    let authUserId: string | null = invite.data?.user?.id ?? null;
    if (invite.error && !/already/i.test(invite.error.message)) {
      return json({ error: 'Invite failed: ' + invite.error.message }, 400);
    }
    if (!authUserId) {
      const existing = await admin.auth.admin.listUsers({ perPage: 1000 });
      authUserId = existing.data?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
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

    return json({ ok: true, employee, invited: !invite.error });
  } catch (err) {
    console.error('invite-employee error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
