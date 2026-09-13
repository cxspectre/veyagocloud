/* What the workspace may ask send-mail to do.
 *
 * The browser is not trusted to have checked any of this. A request that
 * reaches Graph half-formed fails there with a message nobody can act on; an
 * attachment path that is not the sender's own would mail out someone else's
 * upload. So the Edge Function runs every request through parseSendRequest()
 * first, and only a parsed request is ever turned into Graph calls.
 *
 * Kept free of imports so it can be tested in node as-is.
 */

export const LIMITS = {
  recipients: 500,                           // Exchange Online's ceiling per message
  attachments: 20,
  attachmentBytes: 25 * 1024 * 1024,         // total, per message
  htmlBytes: 2 * 1024 * 1024,
  subjectLength: 998,                        // RFC 5322's line limit
  inlineAttachmentBytes: 3 * 1024 * 1024,    // from here up, Graph wants an upload session
};

export type SendMode = 'new' | 'reply' | 'replyAll' | 'forward';
export type Importance = 'low' | 'normal' | 'high';

const MODES: string[] = ['new', 'reply', 'replyAll', 'forward'];
const IMPORTANCE: string[] = ['low', 'normal', 'high'];
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_PART}$`, 'i');
/* Deliberately loose, like decideSend() in ticket-reply.ts: validation that
   tries to be clever rejects real addresses, and a bounce is a better failure
   than a refusal to try. */
const ADDRESS = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/* <auth user id>/<upload id>/<object name>, and nothing else. The object name
   is the browser's plain version of the file name — letters, digits, dot,
   dash, underscore — and the name a person sees travels separately. Nothing
   percent-encoded: fetch resolves %2e%2e to .. BEFORE the request is sent, so
   a path that begins with your own id could end in somebody else's folder. */
const ATTACHMENT_PATH = new RegExp(`^(${UUID_PART})/(${UUID_PART})/([A-Za-z0-9._-]{1,200})$`, 'i');

export interface AttachmentRef {
  path: string;          // see ATTACHMENT_PATH, in the mail-attachments bucket
  name: string;          // what the recipient sees
  size: number;
  contentType: string;
}

export interface SendRequest {
  connectionId: string;
  mode: SendMode;
  messageId: string | null;   // mail_messages.id being answered or forwarded
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  importance: Importance;
  attachments: AttachmentRef[];
}

export type Parsed = { ok: true; value: SendRequest } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

function pathShape(path: string): RegExpExecArray | null {
  const match = ATTACHMENT_PATH.exec(String(path || ''));
  /* "." and ".." are made only of allowed characters, and mean something else. */
  return match && !/^\.+$/.test(match[3]) ? match : null;
}

/* One address field. `taken` is what earlier fields already hold, so an
 * address in To is not repeated in Cc, nor one in Cc in Bcc. */
function addressField(value: unknown, label: string, taken: string[]): { list: string[] } | { error: string } {
  if (value === undefined || value === null) return { list: [] };
  if (!Array.isArray(value)) return { error: `${label} must be a list of addresses` };
  const addresses = value.map((raw) => String(raw ?? '').trim()).filter(Boolean);
  const bad = addresses.find((a) => !ADDRESS.test(a));
  if (bad) return { error: `"${bad}" in ${label} does not look like an email address` };
  const lower = addresses.map((a) => a.toLowerCase());
  return {
    list: addresses.filter((_, i) => !taken.includes(lower[i]) && lower.indexOf(lower[i]) === i),
  };
}

function attachmentList(value: unknown): { list: AttachmentRef[] } | { error: string } {
  if (value === undefined || value === null) return { list: [] };
  if (!Array.isArray(value)) return { error: 'Attachments must be a list' };
  if (value.length > LIMITS.attachments) {
    return { error: `At most ${LIMITS.attachments} attachments per message` };
  }
  // deno-lint-ignore no-explicit-any
  const list: AttachmentRef[] = value.map((a: any) => ({
    path: String(a?.path ?? ''),
    name: String(a?.name ?? '').trim(),
    size: Number(a?.size),
    contentType: String(a?.contentType || 'application/octet-stream'),
  }));
  const bad = list.find((a) => !pathShape(a.path) || !a.name || !Number.isInteger(a.size) || a.size <= 0);
  if (bad) return { error: `The attachment "${bad.name || 'unnamed'}" is not one that was uploaded` };
  const total = list.reduce((sum, a) => sum + a.size, 0);
  if (total > LIMITS.attachmentBytes) return { error: 'Attachments come to more than 25 MB' };
  return { list };
}

/* Nothing a person would read: tags, entities and whitespace only. An image
 * is something, even with no words around it. */
function isBlank(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .trim() === '';
}

export function parseSendRequest(input: unknown): Parsed {
  // deno-lint-ignore no-explicit-any
  const p: any = input && typeof input === 'object' ? input : {};

  const connectionId = String(p.connectionId ?? '').trim();
  if (!UUID.test(connectionId)) return fail('Choose the mailbox to send from');

  const mode = String(p.mode ?? 'new');
  if (!MODES.includes(mode)) return fail(`Unknown mode "${mode}" — new, reply, replyAll or forward`);
  const answering = mode !== 'new';
  const messageId = answering ? String(p.messageId ?? '').trim() : '';
  if (answering && !UUID.test(messageId)) return fail('Say which message this answers');

  const to = addressField(p.to, 'To', []);
  if ('error' in to) return fail(to.error);
  const cc = addressField(p.cc, 'Cc', to.list.map((a) => a.toLowerCase()));
  if ('error' in cc) return fail(cc.error);
  const bcc = addressField(p.bcc, 'Bcc', [...to.list, ...cc.list].map((a) => a.toLowerCase()));
  if ('error' in bcc) return fail(bcc.error);
  const recipients = to.list.length + cc.list.length + bcc.list.length;
  if (recipients > LIMITS.recipients) return fail(`At most ${LIMITS.recipients} recipients per message`);
  /* A reply can leave To to Outlook, which fills in whoever is being
     answered. A new message or a forward has nobody unless we say — and a
     reply whose recipients were all removed has nobody either: Outlook would
     be told to send to no one, refuse, and leave a draft behind. */
  if ((mode === 'new' || mode === 'forward') && !to.list.length) return fail('Add at least one recipient');
  if (answering && Array.isArray(p.to) && !recipients) return fail('Add at least one recipient');

  const subject = String(p.subject ?? '').trim();
  if (mode === 'new' && !subject) return fail('Add a subject');
  if (subject.length > LIMITS.subjectLength) return fail('That subject is too long');

  const importance = String(p.importance ?? 'normal');
  if (!IMPORTANCE.includes(importance)) return fail(`Unknown importance "${importance}" — low, normal or high`);

  const attachments = attachmentList(p.attachments);
  if ('error' in attachments) return fail(attachments.error);

  const html = String(p.html ?? '');
  if (new TextEncoder().encode(html).length > LIMITS.htmlBytes) return fail('The message is too long');
  if (isBlank(html) && !attachments.list.length) return fail('The message is empty');

  return {
    ok: true,
    value: {
      connectionId,
      mode: mode as SendMode,
      messageId: answering ? messageId : null,
      to: to.list, cc: cc.list, bcc: bcc.list,
      subject, html,
      importance: importance as Importance,
      attachments: attachments.list,
    },
  };
}

/* An upload belongs to the auth id its path starts with. Checked against the
 * CALLER, never taken from the request — and send-mail also downloads as the
 * caller, so the storage policy says no even if this ever said yes. */
export function ownsAttachment(path: string, userId: string): boolean {
  const match = pathShape(path);
  return Boolean(match && UUID.test(String(userId || '')) && match[1].toLowerCase() === String(userId).toLowerCase());
}

/* Defence in depth for what we send, not a full sanitiser: the compose editor
 * cleans with DOMPurify before this sees anything. This removes what should
 * never leave the studio under our name even if that step were bypassed —
 * scripts, embedded frames and forms, event handlers, script URLs. It is not
 * a boundary; do not rely on it as one. */
export function sanitizeOutgoingHtml(html: string): string {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|form|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|form|input|button|select|textarea|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\bhref\s*=\s*("\s*(javascript|vbscript|data):[^"]*"|'\s*(javascript|vbscript|data):[^']*'|(javascript|vbscript|data):[^\s>]*)/gi, 'href="#"')
    .replace(/\bsrc\s*=\s*("\s*(javascript|vbscript):[^"]*"|'\s*(javascript|vbscript):[^']*'|(javascript|vbscript):[^\s>]*)/gi, 'src="#"');
}

/* createReply and createForward return a draft whose body already holds
 * Outlook's quoted original ("From: … Sent: …"). What we wrote goes above it,
 * inside its <body>, so the result reads the way an Outlook reply does. */
export function prependToBody(draftHtml: string, ourHtml: string): string {
  const draft = String(draftHtml || '');
  const ours = String(ourHtml || '');
  const open = /<body\b[^>]*>/i.exec(draft);
  if (!open) return ours + draft;
  const at = open.index + open[0].length;
  return draft.slice(0, at) + ours + draft.slice(at);
}

/* How each file reaches Graph: one POST, or an upload session from 3 MB. */
export function attachmentPlan<T extends { size: number }>(list: T[]): (T & { method: 'inline' | 'session' })[] {
  return list.map((a) => ({
    ...a,
    method: a.size >= LIMITS.inlineAttachmentBytes ? 'session' : 'inline',
  }));
}
