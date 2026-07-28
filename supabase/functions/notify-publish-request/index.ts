/* notify-publish-request — tells every active manager that someone has asked to
   publish the live site.

   Deploy:  supabase functions deploy notify-publish-request
   Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
            RESEND_API_KEY and SITE_URL are shared with the other senders.

   Modelled on notify-task, with two deliberate differences.

   1. It gates on employee_role() against the PUBLISHERS set, NOT on is_staff().
      notify-task can afford is_staff() because it mails one person about their
      own task. This mails every manager at once, so a staff-wide gate would let
      any employee fan a message out to the whole leadership by calling the
      function directly.

   2. It fans out. Every other sender in this project has exactly one recipient,
      so there is no existing pattern to copy — the sends run in parallel and
      each one gets its own email_log row, because "two of three managers were
      emailed" is a real outcome that a single ok/fail cannot express.

   Like the others, the client supplies no content: the requester, the note and
   the recipient list are all read server-side. */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { publishRequestEmail, sendEmail } from '../_shared/email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* Mirrors PUBLISHERS in functions/deploy — only someone who could publish can
   ask to, so only they can trigger this. */
const REQUESTERS = ['owner', 'admin', 'assistant'];

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
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);

    const { data: role, error: roleErr } = await asCaller.rpc('employee_role');
    if (roleErr || !REQUESTERS.includes(String(role))) {
      return json({ error: 'Only someone who can publish may ask to' }, 403);
    }

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* The request is read server-side, so the caller cannot put words in the
       email. Their own newest pending row is the one being announced. */
    const { data: request } = await admin
      .from('publish_requests')
      .select('id,note,requested_by,created_at')
      .eq('requested_by', userData.user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!request) return json({ ok: true, skipped: 'no pending request' });

    const { data: requester } = await admin
      .from('employees')
      .select('full_name')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    /* Everyone who could act on it. Inactive staff are excluded — they cannot
       sign in, so mailing them is noise with no recipient behind it. */
    const { data: managers, error: mgrErr } = await admin
      .from('employees')
      .select('email,full_name,user_id')
      .in('role', ['owner', 'admin'])
      .neq('status', 'inactive');

    if (mgrErr) return json({ error: 'Could not read the manager list: ' + mgrErr.message }, 500);

    const site = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');
    const tpl = publishRequestEmail({
      requesterName: requester?.full_name ?? 'Someone',
      note: request.note,
      publishUrl: `${site}/admin/publish`,
    });

    /* An owner asking to publish should not be emailed about their own request.
       They are in the recipient set by role, unlike notify-task's single
       assignee, so the skip is on identity rather than on the whole send. */
    const recipients = (managers ?? []).filter(
      (m) => m.email && m.user_id !== userData.user.id,
    );
    if (!recipients.length) return json({ ok: true, skipped: 'no one to notify' });

    const results = await Promise.all(
      recipients.map(async (m) => {
        const sent = await sendEmail({ to: m.email!, ...tpl });
        await admin.from('email_log').insert({
          to_email: m.email,
          kind: 'publish_requested',
          subject: tpl.subject,
          ok: sent.ok,
          error: sent.ok ? null : (sent.error ?? null),
          requested_by: userData.user.id,
        });
        return sent;
      }),
    );

    const delivered = results.filter((r) => r.ok).length;
    /* "Two of three" is the honest answer when a fan-out partly fails, and the
       caller fires this un-awaited anyway — the request exists either way. */
    return json({
      ok: delivered > 0,
      notified: delivered,
      of: recipients.length,
      skipped: results.every((r) => r.skipped) ? 'email not configured' : undefined,
    });
  } catch (err) {
    console.error('notify-publish-request error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
