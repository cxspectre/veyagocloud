/* Shared transactional email for Veyago, sent through Resend.
 *
 * Why this exists: Supabase's built-in mailer sends unbranded, plain-looking
 * messages from a supabase.co address. An invite is the very first thing a new
 * hire sees from the company, and a password reset is what someone reads when
 * they are already locked out and anxious. Both deserve to look like Veyago.
 *
 * Secrets (set once):
 *   supabase secrets set RESEND_API_KEY=re_...
 *   supabase secrets set EMAIL_FROM="Veyago <hello@veyago.cloud>"
 *   supabase secrets set SITE_URL=https://www.veyago.cloud
 *
 * The sending domain must be verified in Resend first (Domains → Add domain →
 * add the DKIM/SPF records). Until it is, Resend accepts the call only for the
 * address you signed up with.
 *
 * Email HTML is not web HTML: no flexbox, no grid, no external stylesheet, no
 * custom fonts. Tables and inline styles are what actually render in Outlook
 * and Gmail, which is why the layout below looks like it was written in 2005.
 */

const RESEND_API = 'https://api.resend.com/emails';

/* Veyago's palette, inlined — email clients drop <style> blocks and CSS vars. */
const INK = '#1d1d1f';
const MUTED = '#6e6e73';
const HAIR = '#e8e8ed';
const BLUE = '#0071e3';
const CANVAS = '#f5f5f7';

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
  skipped?: boolean;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* The shared shell every Veyago email uses: white card on a grey canvas,
   wordmark at the top, legal footer at the bottom. `bodyHtml` is trusted
   markup assembled by the callers below — never raw user input. */
function layout(opts: { title: string; bodyHtml: string; preheader?: string }): string {
  const site = (Deno.env.get('SITE_URL') ?? 'https://www.veyago.cloud').replace(/\/+$/, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
  <!-- Preview text: what the inbox shows next to the subject line. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader ?? '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:520px;background:#ffffff;border:1px solid ${HAIR};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <div style="font:600 17px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.01em;">Veyago</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px 32px;font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
              ${opts.bodyHtml}
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:20px 32px;font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};text-align:center;">
              Veyago Inc · New York C-Corp<br />
              <a href="${site}" style="color:${MUTED};text-decoration:underline;">veyago.cloud</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* A real <a> styled as a button. Buttons in email must be links — <button>
   does nothing in a mail client. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;">
    <tr><td style="border-radius:11px;background:${BLUE};">
      <a href="${escapeHtml(href)}"
         style="display:inline-block;padding:13px 26px;font:600 15px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:11px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/* Long action links wrap badly and some clients strip the button entirely, so
   every action email also shows the raw URL. */
function fallbackLink(href: string): string {
  return `<p style="margin:22px 0 0;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
    If the button doesn't work, paste this into your browser:<br />
    <span style="word-break:break-all;color:${BLUE};">${escapeHtml(href)}</span>
  </p>`;
}

/* ── Templates ─────────────────────────────────────────────────────────── */

/* expiryHours is passed in rather than hardcoded: invite-employee mints an
   INVITE link for a brand-new user (24h) but a RECOVERY link for an address
   that already has an auth user (1h), and both are delivered with this same
   template. Promising 24 hours on the recovery path was simply untrue. */
export function inviteEmail(opts: { name: string; inviterName?: string; actionLink: string; role: string; expiryHours?: number }) {
  const first = String(opts.name || '').trim().split(/\s+/)[0] || 'there';
  const from = opts.inviterName ? `${escapeHtml(opts.inviterName)} has` : 'You have been';
  const hours = opts.expiryHours ?? 24;
  const window = hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  return {
    subject: 'Your Veyago account is ready',
    html: layout({
      title: 'Your Veyago account is ready',
      preheader: 'Set your password and sign in to the Veyago dashboard.',
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Welcome, ${escapeHtml(first)}</h1>
        <p style="margin:0 0 14px;">${from} added you to the Veyago dashboard as <strong>${escapeHtml(opts.role)}</strong>.</p>
        <p style="margin:0;">Click below to choose a password. You'll need it every time you sign in, so pick something you can remember or save it to your password manager.</p>
        ${button(opts.actionLink, 'Set your password')}
        <p style="margin:0;font-size:14px;color:${MUTED};">This link expires ${window}. If it has, ask for a new invite — nothing is lost.</p>
        ${fallbackLink(opts.actionLink)}`,
    }),
    text:
      `Welcome, ${first}\n\n` +
      `You've been added to the Veyago dashboard as ${opts.role}.\n\n` +
      `Set your password:\n${opts.actionLink}\n\n` +
      `This link expires ${window}.`,
  };
}

/* Sent to every active manager when someone asks to publish. Deliberately
   plain: the decision is made on the Publish screen, where the requester, the
   note and what has changed since the last build are all visible together. An
   Approve button in an email would be a decision taken without that context. */
export function publishRequestEmail(opts: { requesterName: string; note?: string | null; publishUrl: string }) {
  const who = escapeHtml(opts.requesterName || 'Someone');
  return {
    subject: `${opts.requesterName || 'Someone'} wants to publish veyago.cloud`,
    html: layout({
      title: 'A publish is waiting for you',
      preheader: `${opts.requesterName || 'Someone'} asked to publish the site.`,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">A publish is waiting for you</h1>
        <p style="margin:0 0 14px;"><strong>${who}</strong> asked to publish veyago.cloud.</p>
        ${opts.note ? `<p style="margin:0 0 14px;padding:12px 14px;background:#f5f5f7;border-radius:10px;">“${escapeHtml(opts.note)}”</p>` : ''}
        <p style="margin:0;">The whole site is rebuilt from everything currently marked published, so the approval covers all of it. Have a look at what has changed before you decide.</p>
        ${button(opts.publishUrl, 'Review the request')}
        <p style="margin:0;font-size:14px;color:${MUTED};">Once you approve, they can publish for the next 24 hours.</p>`,
    }),
    text:
      `${opts.requesterName || 'Someone'} asked to publish veyago.cloud.\n\n` +
      (opts.note ? `"${opts.note}"\n\n` : '') +
      `Review it: ${opts.publishUrl}\n\n` +
      `Once approved, they can publish for the next 24 hours.`,
  };
}

export function resetEmail(opts: { actionLink: string }) {
  return {
    subject: 'Reset your Veyago password',
    html: layout({
      title: 'Reset your Veyago password',
      preheader: 'A link to choose a new password for the Veyago dashboard.',
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Reset your password</h1>
        <p style="margin:0;">Click below to choose a new password for the Veyago dashboard.</p>
        ${button(opts.actionLink, 'Choose a new password')}
        <p style="margin:0;font-size:14px;color:${MUTED};">This link expires in 1 hour and can only be used once.</p>
        <p style="margin:14px 0 0;font-size:14px;color:${MUTED};">If you didn't ask for this, you can ignore it — your password stays as it is.</p>
        ${fallbackLink(opts.actionLink)}`,
    }),
    text:
      `Reset your Veyago password\n\n` +
      `Choose a new password:\n${opts.actionLink}\n\n` +
      `This link expires in 1 hour and can only be used once.\n` +
      `If you didn't ask for this, ignore this email.`,
  };
}

export function taskAssignedEmail(opts: {
  assigneeName: string; title: string; dueDate?: string | null;
  priority?: string | null; assignedBy?: string | null; taskUrl: string;
}) {
  const first = String(opts.assigneeName || '').trim().split(/\s+/)[0] || 'there';
  const meta: string[] = [];
  if (opts.dueDate) meta.push(`Due ${escapeHtml(opts.dueDate)}`);
  if (opts.priority && opts.priority !== 'normal') meta.push(escapeHtml(opts.priority));
  return {
    subject: `New task: ${opts.title}`,
    html: layout({
      title: 'A task was assigned to you',
      preheader: opts.title,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Hi ${escapeHtml(first)}, you have a new task</h1>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border:1px solid ${HAIR};border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 16px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">${escapeHtml(opts.title)}</div>
            ${meta.length ? `<div style="margin-top:6px;font-size:13px;color:${MUTED};">${meta.join(' · ')}</div>` : ''}
          </td></tr>
        </table>
        ${opts.assignedBy ? `<p style="margin:0;font-size:14px;color:${MUTED};">Assigned by ${escapeHtml(opts.assignedBy)}.</p>` : ''}
        ${button(opts.taskUrl, 'Open the task')}`,
    }),
    text:
      `Hi ${first}, you have a new task\n\n${opts.title}\n` +
      (meta.length ? meta.join(' · ') + '\n' : '') +
      `\nOpen it: ${opts.taskUrl}`,
  };
}

/* Sent to the task creator/manager when a task they own is marked done or
   blocked. The creator is the most relevant person to tell: they handed the
   work out, and they are the one who needs to follow up or unblock. */
export function taskStatusEmail(opts: {
  recipientName: string;
  title: string;
  event: 'done' | 'blocked';
  changedByName?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  taskUrl: string;
}) {
  const first = String(opts.recipientName || '').trim().split(/\s+/)[0] || 'there';
  const meta: string[] = [];
  if (opts.dueDate) meta.push(`Due ${escapeHtml(opts.dueDate)}`);
  if (opts.priority && opts.priority !== 'normal') meta.push(escapeHtml(opts.priority));
  const isDone = opts.event === 'done';
  const subject = isDone ? `Task done: ${opts.title}` : `Task blocked: ${opts.title}`;
  const headline = isDone ? 'A task was completed' : 'A task is blocked';
  const subline = isDone
    ? (opts.changedByName ? `Completed by ${escapeHtml(opts.changedByName)}.` : 'Task completed.')
    : (opts.changedByName
        ? `${escapeHtml(opts.changedByName)} marked it blocked — it may need your attention.`
        : 'Marked blocked — it may need your attention.');
  return {
    subject,
    html: layout({
      title: headline,
      preheader: opts.title,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Hi ${escapeHtml(first)}, ${headline.toLowerCase()}</h1>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border:1px solid ${HAIR};border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 16px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">${escapeHtml(opts.title)}</div>
            ${meta.length ? `<div style="margin-top:6px;font-size:13px;color:${MUTED};">${meta.join(' · ')}</div>` : ''}
          </td></tr>
        </table>
        <p style="margin:0 0 4px;font-size:14px;color:${MUTED};">${subline}</p>
        ${button(opts.taskUrl, 'Open the task')}`,
    }),
    text:
      `Hi ${first}, ${headline.toLowerCase()}\n\n${opts.title}\n` +
      (meta.length ? meta.join(' · ') + '\n' : '') +
      `\n${subline}\n\nOpen it: ${opts.taskUrl}`,
  };
}

/* Sent to the assignee when a manager changes the task's priority or due date.
   Does not try to say *what* changed — the edge function reads only the current
   state, not the before-state — so it simply points them at the task. */
export function taskUpdatedEmail(opts: {
  assigneeName: string;
  title: string;
  dueDate?: string | null;
  priority?: string | null;
  updatedBy?: string | null;
  taskUrl: string;
}) {
  const first = String(opts.assigneeName || '').trim().split(/\s+/)[0] || 'there';
  const meta: string[] = [];
  if (opts.dueDate) meta.push(`Due ${escapeHtml(opts.dueDate)}`);
  if (opts.priority && opts.priority !== 'normal') meta.push(escapeHtml(opts.priority));
  return {
    subject: `Task updated: ${opts.title}`,
    html: layout({
      title: 'A task you own was updated',
      preheader: opts.title,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Hi ${escapeHtml(first)}, your task was updated</h1>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border:1px solid ${HAIR};border-radius:12px;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 16px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">${escapeHtml(opts.title)}</div>
            ${meta.length ? `<div style="margin-top:6px;font-size:13px;color:${MUTED};">${meta.join(' · ')}</div>` : ''}
          </td></tr>
        </table>
        ${opts.updatedBy ? `<p style="margin:0;font-size:14px;color:${MUTED};">Updated by ${escapeHtml(opts.updatedBy)}.</p>` : ''}
        ${button(opts.taskUrl, 'Open the task')}`,
    }),
    text:
      `Hi ${first}, your task was updated\n\n${opts.title}\n` +
      (meta.length ? meta.join(' · ') + '\n' : '') +
      (opts.updatedBy ? `\nUpdated by ${opts.updatedBy}.\n` : '') +
      `\nOpen it: ${opts.taskUrl}`,
  };
}

export function taskCommentEmail(opts: {
  recipientName: string | null;
  commenterName: string | null;
  title: string;
  body: string;
  taskUrl: string;
}) {
  const who = opts.commenterName ? escapeHtml(opts.commenterName) : 'Someone';
  const greeting = opts.recipientName ? `Hi ${escapeHtml(opts.recipientName)},` : 'Hi,';
  const snippet = opts.body.length > 200 ? opts.body.slice(0, 200) + '…' : opts.body;
  return {
    subject: `New comment on "${opts.title}"`,
    html: layout({
      title: 'New comment on task',
      preheader: `${opts.commenterName ?? 'Someone'} commented on "${opts.title}"`,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 22px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">New comment</h1>
        <p style="margin:0 0 16px;">${greeting} ${who} left a comment on <strong>${escapeHtml(opts.title)}</strong>.</p>
        <div style="background:${CANVAS};border-left:3px solid ${BLUE};border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(snippet)}</p>
        </div>
        <p style="margin:0;"><a href="${escapeHtml(opts.taskUrl)}" style="display:inline-block;padding:10px 20px;background:${BLUE};color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open task →</a></p>`,
    }),
    text:
      `New comment on "${opts.title}"\n\n` +
      `${greeting} ${opts.commenterName ?? 'Someone'} commented:\n\n` +
      `${snippet}\n\n` +
      `Open it: ${opts.taskUrl}`,
  };
}

export function invoiceEmail(opts: {
  clientName: string; number: string; amountFormatted: string; dueOn?: string | null;
}) {
  const due = opts.dueOn
    ? `<p style="margin:0;font-size:14px;color:${MUTED};">Due ${escapeHtml(opts.dueOn)}.</p>`
    : '';
  return {
    subject: `Invoice ${opts.number} from Veyago — ${opts.amountFormatted}`,
    html: layout({
      title: `Invoice ${opts.number}`,
      preheader: `Invoice ${opts.number} for ${opts.amountFormatted}, attached as a PDF.`,
      bodyHtml: `
        <h1 style="margin:0 0 14px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-0.02em;">Invoice ${escapeHtml(opts.number)}</h1>
        <p style="margin:0 0 14px;">Hi ${escapeHtml(opts.clientName)}, please find invoice <strong>${escapeHtml(opts.number)}</strong> for <strong>${escapeHtml(opts.amountFormatted)}</strong> attached to this email as a PDF.</p>
        ${due}`,
    }),
    text:
      `Invoice ${opts.number}\n\n` +
      `Hi ${opts.clientName}, please find invoice ${opts.number} for ${opts.amountFormatted} attached to this email as a PDF.\n` +
      (opts.dueOn ? `Due ${opts.dueOn}.\n` : ''),
  };
}

/* ── Sending ───────────────────────────────────────────────────────────── */

/* Sends via Resend. Returns {skipped:true} rather than throwing when no API key
   is configured, so a missing key degrades a notification to silence instead of
   breaking the action that triggered it (creating a task must still succeed
   even if the email cannot go out). Callers that NEED delivery — the invite —
   should check .ok and surface it. */
export async function sendEmail(opts: {
  to: string; subject: string; html: string; text: string; replyTo?: string;
  /* content is base64 — Resend's own field, not a data: URI. Encoded with a
     plain byte-to-char loop rather than Node's Buffer, which this file (like
     the rest of the Deno-only shared code) never assumes is available. */
  attachments?: { filename: string; content: string }[];
}): Promise<SendResult> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) {
    console.warn('[email] RESEND_API_KEY not set — skipping send to', opts.to);
    return { ok: false, skipped: true, error: 'Email is not configured (RESEND_API_KEY missing).' };
  }
  const from = Deno.env.get('EMAIL_FROM') ?? 'Veyago <onboarding@resend.dev>';

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
        ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (body && (body.message || body.name)) || `HTTP ${res.status}`;
      console.error('[email] Resend rejected the send:', detail);
      return { ok: false, error: String(detail) };
    }
    return { ok: true, id: body?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[email] could not reach Resend:', message);
    return { ok: false, error: 'Could not reach the email service: ' + message };
  }
}
