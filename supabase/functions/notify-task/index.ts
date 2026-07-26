/* notify-task — emails someone when a task lands on their plate.
 *
 * Deploy:  supabase functions deploy notify-task
 * Secrets: RESEND_API_KEY, EMAIL_FROM, SITE_URL
 *
 * Why this exists: without a push, an internal tool is a filing cabinet nobody
 * visits, and the work quietly migrates back to WhatsApp. Assigning a task
 * should reach the person the same day, not whenever they next happen to open
 * the dashboard.
 *
 * Called by the browser after a task is created or reassigned. Deliberately
 * best-effort: the task already exists by the time this runs, so a mail failure
 * must never look like the task failed. Callers should not await it blocking a
 * success toast.
 *
 * The caller is verified as staff, and the task is re-read SERVER-SIDE from its
 * id — the client sends only the id, never the title or the recipient, so this
 * cannot be used to mail arbitrary text to an arbitrary address.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail, taskAssignedEmail } from '../_shared/email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const { data: isStaff, error: roleErr } = await asCaller.rpc('is_staff');
    if (roleErr || !isStaff) return json({ error: 'Staff only' }, 403);

    const body = await req.json().catch(() => ({}));
    const taskId = String(body.task_id ?? '');
    if (!UUID_RE.test(taskId)) return json({ error: 'Invalid task id' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* Read the task and the recipient server-side. The client supplies only an
       id, so it cannot choose who gets mailed or what the mail says. */
    const { data: task, error: taskErr } = await admin
      .from('tasks')
      .select('id,title,due_date,priority,status,assignee_id')
      .eq('id', taskId)
      .maybeSingle();
    if (taskErr) return json({ error: 'Could not read the task: ' + taskErr.message }, 400);
    if (!task) return json({ error: 'No such task' }, 404);
    if (!task.assignee_id) return json({ ok: true, skipped: 'unassigned' });
    if (task.status === 'done') return json({ ok: true, skipped: 'already done' });

    const { data: assignee } = await admin
      .from('employees')
      .select('full_name,email,status,user_id')
      .eq('id', task.assignee_id)
      .maybeSingle();
    if (!assignee?.email) return json({ ok: true, skipped: 'no email on file' });
    if (assignee.status === 'inactive') return json({ ok: true, skipped: 'inactive' });

    /* Don't email someone about a task they just gave themselves. */
    if (assignee.user_id && assignee.user_id === userData.user.id) {
      return json({ ok: true, skipped: 'self-assigned' });
    }

    const { data: assigner } = await admin
      .from('employees')
      .select('full_name')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    const site = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');
    const tpl = taskAssignedEmail({
      assigneeName: assignee.full_name,
      title: task.title,
      dueDate: task.due_date,
      priority: task.priority,
      assignedBy: assigner?.full_name ?? null,
      taskUrl: `${site}/admin/task?id=${task.id}`,
    });

    const sent = await sendEmail({ to: assignee.email, ...tpl });

    await admin.from('email_log').insert({
      to_email: assignee.email,
      kind: 'task_assigned',
      subject: tpl.subject,
      ok: sent.ok,
      error: sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
    });

    return json({ ok: sent.ok, skipped: sent.skipped ? 'email not configured' : undefined });
  } catch (err) {
    console.error('notify-task error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
