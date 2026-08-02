/* notify-task — emails the right person when something meaningful happens to a task.
 *
 * Deploy:  supabase functions deploy notify-task
 * Secrets: RESEND_API_KEY, EMAIL_FROM, SITE_URL
 *
 * Events
 * ──────
 *   assigned  (default) → assignee: "New task: {title}"
 *   updated             → assignee: "Task updated: {title}"  (priority / due date changed)
 *   done                → creator:  "Task done: {title}"
 *   blocked             → creator:  "Task blocked: {title}"
 *
 * Why best-effort: the task already exists by the time this runs, so a mail
 * failure must never look like the task failed. Callers do not await this into
 * their success toast.
 *
 * Security: the caller sends only { task_id, event }. Everything else — title,
 * recipient, email address — is re-read server-side, so this cannot be used to
 * mail arbitrary text to an arbitrary address.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  sendEmail,
  taskAssignedEmail,
  taskCommentEmail,
  taskStatusEmail,
  taskUpdatedEmail,
} from '../_shared/email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_EVENTS = new Set(['assigned', 'updated', 'done', 'blocked', 'commented']);

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

    const body        = await req.json().catch(() => ({}));
    const taskId      = String(body.task_id ?? '');
    const event       = String(body.event ?? 'assigned');
    const commentBody = body.comment_body ? String(body.comment_body).trim() : null;

    if (!UUID_RE.test(taskId))     return json({ error: 'Invalid task id' }, 400);
    if (!VALID_EVENTS.has(event))  return json({ error: 'Invalid event' }, 400);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* Re-read the task server-side — the client supplies only an id. */
    const { data: task, error: taskErr } = await admin
      .from('tasks')
      .select('id,title,due_date,priority,status,assignee_id,created_by')
      .eq('id', taskId)
      .maybeSingle();
    if (taskErr) return json({ error: 'Could not read the task: ' + taskErr.message }, 400);
    if (!task)   return json({ error: 'No such task' }, 404);

    const site = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');
    const taskUrl = `${site}/admin/task?id=${task.id}`;

    /* ── done / blocked → notify the task creator ─────────────────────── */

    if (event === 'done' || event === 'blocked') {
      if (!task.created_by) return json({ ok: true, skipped: 'no creator' });

      /* Don't email the person who just made the change. */
      if (task.created_by === userData.user.id) {
        return json({ ok: true, skipped: event === 'done' ? 'self-completed' : 'self-blocked' });
      }

      const { data: creator } = await admin
        .from('employees')
        .select('full_name,email,status')
        .eq('user_id', task.created_by)
        .maybeSingle();
      if (!creator?.email)              return json({ ok: true, skipped: 'no email on file' });
      if (creator.status === 'inactive') return json({ ok: true, skipped: 'inactive' });

      /* Who made the change — shown in the email body. */
      const { data: changer } = await admin
        .from('employees')
        .select('full_name')
        .eq('user_id', userData.user.id)
        .maybeSingle();

      const tpl = taskStatusEmail({
        recipientName:  creator.full_name,
        title:          task.title,
        event:          event as 'done' | 'blocked',
        changedByName:  changer?.full_name ?? null,
        dueDate:        task.due_date,
        priority:       task.priority,
        taskUrl,
      });

      const sent = await sendEmail({ to: creator.email, ...tpl });
      await admin.from('email_log').insert({
        to_email:     creator.email,
        kind:         event === 'done' ? 'task_done' : 'task_blocked',
        subject:      tpl.subject,
        ok:           sent.ok,
        error:        sent.ok ? null : (sent.error ?? null),
        requested_by: userData.user.id,
      });

      return json({ ok: sent.ok, skipped: sent.skipped ? 'email not configured' : undefined });
    }

    /* ── commented → notify assignee and creator (not the commenter) ──── */

    if (event === 'commented') {
      if (!commentBody) return json({ ok: true, skipped: 'no body' });

      const { data: commenter } = await admin
        .from('employees').select('full_name').eq('user_id', userData.user.id).maybeSingle();

      /* Collect unique recipients: assignee + creator, minus the commenter. */
      const recipientUserIds = new Set<string>();
      if (task.assignee_id) {
        const { data: a } = await admin
          .from('employees').select('user_id').eq('id', task.assignee_id).maybeSingle();
        if (a?.user_id && a.user_id !== userData.user.id) recipientUserIds.add(a.user_id);
      }
      if (task.created_by && task.created_by !== userData.user.id) {
        recipientUserIds.add(task.created_by);
      }

      if (!recipientUserIds.size) return json({ ok: true, skipped: 'no recipients' });

      const { data: recipEmps } = await admin
        .from('employees')
        .select('full_name,email,status,user_id')
        .in('user_id', Array.from(recipientUserIds));

      const active = (recipEmps ?? []).filter((e) => e.email && e.status !== 'inactive');
      if (!active.length) return json({ ok: true, skipped: 'no email on file' });

      let anyOk = false;
      for (const recip of active) {
        const tpl = taskCommentEmail({
          recipientName: recip.full_name,
          commenterName: commenter?.full_name ?? null,
          title: task.title,
          body: commentBody,
          taskUrl,
        });
        const sent = await sendEmail({ to: recip.email, ...tpl });
        if (sent.ok) anyOk = true;
        await admin.from('email_log').insert({
          to_email: recip.email, kind: 'task_comment', subject: tpl.subject,
          ok: sent.ok, error: sent.ok ? null : (sent.error ?? null),
          requested_by: userData.user.id,
        });
      }
      return json({ ok: anyOk, skipped: anyOk ? undefined : 'email not configured' });
    }

    /* ── assigned / updated → notify the assignee ─────────────────────── */

    if (!task.assignee_id) return json({ ok: true, skipped: 'unassigned' });
    /* Skip "already done" only for new assignments — an update to a done task's
       priority or due date is unusual but not an error, and the assignee still
       deserves to know if a manager touched it. */
    if (event === 'assigned' && task.status === 'done') {
      return json({ ok: true, skipped: 'already done' });
    }

    const { data: assignee } = await admin
      .from('employees')
      .select('full_name,email,status,user_id')
      .eq('id', task.assignee_id)
      .maybeSingle();
    if (!assignee?.email)              return json({ ok: true, skipped: 'no email on file' });
    if (assignee.status === 'inactive') return json({ ok: true, skipped: 'inactive' });

    /* Don't email someone about their own task or their own edits. */
    if (assignee.user_id && assignee.user_id === userData.user.id) {
      return json({ ok: true, skipped: 'self-assigned' });
    }

    const { data: assigner } = await admin
      .from('employees')
      .select('full_name')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    const tpl = event === 'updated'
      ? taskUpdatedEmail({
          assigneeName: assignee.full_name,
          title:        task.title,
          dueDate:      task.due_date,
          priority:     task.priority,
          updatedBy:    assigner?.full_name ?? null,
          taskUrl,
        })
      : taskAssignedEmail({
          assigneeName: assignee.full_name,
          title:        task.title,
          dueDate:      task.due_date,
          priority:     task.priority,
          assignedBy:   assigner?.full_name ?? null,
          taskUrl,
        });

    const sent = await sendEmail({ to: assignee.email, ...tpl });
    await admin.from('email_log').insert({
      to_email:     assignee.email,
      kind:         event === 'updated' ? 'task_updated' : 'task_assigned',
      subject:      tpl.subject,
      ok:           sent.ok,
      error:        sent.ok ? null : (sent.error ?? null),
      requested_by: userData.user.id,
    });

    return json({ ok: sent.ok, skipped: sent.skipped ? 'email not configured' : undefined });

  } catch (err) {
    console.error('notify-task error:', err);
    return json({ error: 'Unexpected error — check function logs' }, 500);
  }
});
