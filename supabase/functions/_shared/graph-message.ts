/* Turning Microsoft Graph payloads into our rows.
 *
 * Graph is kinder than Gmail here — no base64url, no nested parts tree, one
 * body with a contentType — so most of this file is about the two things it
 * does awkwardly: dates and HTML-only bodies.
 *
 * THE DATE TRAP. Graph returns `{ dateTime: "2026-09-11T09:00:00.0000000",
 * timeZone: "W. Europe Standard Time" }`. The dateTime carries NO offset, and
 * the zone is a Windows name that Intl cannot parse. Passing that string to
 * `new Date()` gets you the server's local interpretation of a wall clock in
 * someone else's timezone — an event silently an hour or two out, which is the
 * kind of bug people blame on themselves for weeks.
 *
 * The fix is at the request, not here: the sync sends
 * `Prefer: outlook.timezone="UTC"`, so Graph returns UTC and `toInstant()`
 * appends the Z. If the zone comes back as anything else, toInstant() refuses
 * rather than guessing — a missing event is easier to notice than a wrong one.
 */

export interface GraphAddress { name?: string; address?: string }
export interface GraphRecipient { emailAddress?: GraphAddress }

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  internetMessageId?: string;
  bccRecipients?: GraphRecipient[];
  importance?: string;
  hasAttachments?: boolean;
}

export function address(r: GraphRecipient | undefined): { name: string; email: string } {
  const a = r?.emailAddress;
  return {
    name: String(a?.name ?? '').trim(),
    email: String(a?.address ?? '').trim().toLowerCase(),
  };
}

export function addressList(rs: GraphRecipient[] | undefined): string[] {
  return (rs ?? []).map((r) => address(r).email).filter(Boolean);
}

/* Graph often returns HTML even for a message typed as plain text, so
 * body_text would be empty for most of the inbox without this. Deliberately
 * crude: it is a preview and a search target, not a rendering. Anything that
 * actually displays the message uses body_html — after sanitising it. */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* A Graph dateTime + timeZone pair as an ISO instant, or null when the zone is
 * not one we can trust. See the header: guessing is worse than skipping. */
export function toInstant(when: { dateTime?: string; timeZone?: string } | undefined): string | null {
  const raw = String(when?.dateTime ?? '').trim();
  if (!raw) return null;

  /* Already carries an offset — trust it. */
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const zone = String(when?.timeZone ?? '').trim().toLowerCase();
  if (zone !== 'utc' && zone !== 'gmt' && zone !== '') return null;

  /* Graph pads to seven fractional digits, which Date does not mind, but trim
     it anyway so the value is a clean ISO string. */
  const d = new Date(raw.replace(/(\.\d{3})\d+$/, '$1') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* Every field toMailRow reads. The sync and send-mail both $select this, so
 * a field added to the row cannot be forgotten in one of the requests. */
export const MESSAGE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'bodyPreview', 'body',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'bccRecipients',
  'receivedDateTime', 'sentDateTime', 'isRead', 'flag', 'importance', 'hasAttachments',
  /* Not stored, but what an incremental sync pages by: it changes when a
     message is read or flagged in Outlook, not only when one arrives. */
  'lastModifiedDateTime',
].join(',');

export type Importance = 'low' | 'normal' | 'high';

export interface MailRow {
  external_id: string;
  thread_external_id: string;
  /* RFC 2822 Message-ID. Unlike `external_id` it survives a move between
     folders — a draft's id changes when it is sent, this does not — so it is
     how a sent copy is recognised as the message we just sent. */
  internet_message_id: string | null;
  direction: 'inbound' | 'outbound';
  from_name: string;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  /* Only ever present on our own sent copies: a recipient cannot see Bcc. */
  bcc_emails: string[];
  subject: string;
  body_text: string;
  body_html: string;
  sent_at: string;
  snippet: string;
  is_read: boolean;
  is_flagged: boolean;
  importance: Importance;
  has_attachments: boolean;
}

function importanceOf(value: unknown): Importance {
  const v = String(value ?? '').toLowerCase();
  return v === 'low' || v === 'high' ? v : 'normal';
}

/* `ownAddresses` decides direction: a message we sent is one whose From is the
 * mailbox's own address. Comparing against the mailbox rather than trusting
 * the folder means a reply inside a thread we started still resolves right. */
export function toMailRow(msg: GraphMessage, ownAddresses: string[] = []): MailRow {
  const from = address(msg.from ?? msg.sender);
  const mine = new Set(ownAddresses.map((a) => String(a).toLowerCase()));
  const isHtml = String(msg.body?.contentType ?? '').toLowerCase() === 'html';
  const content = String(msg.body?.content ?? '');

  const sentAt =
    toInstant({ dateTime: msg.sentDateTime }) ??
    toInstant({ dateTime: msg.receivedDateTime }) ??
    new Date().toISOString();

  return {
    external_id: msg.id,
    /* conversationId is Graph's thread. A message without one is its own
       thread rather than being dropped into a shared null bucket. */
    thread_external_id: msg.conversationId || msg.id,
    internet_message_id: msg.internetMessageId ? String(msg.internetMessageId) : null,
    direction: mine.has(from.email) ? 'outbound' : 'inbound',
    from_name: from.name,
    from_email: from.email,
    to_emails: addressList(msg.toRecipients),
    cc_emails: addressList(msg.ccRecipients),
    bcc_emails: addressList(msg.bccRecipients),
    subject: String(msg.subject ?? ''),
    body_text: isHtml ? htmlToText(content) : content,
    body_html: isHtml ? content : '',
    sent_at: sentAt,
    snippet: String(msg.bodyPreview ?? '').slice(0, 300),
    is_read: msg.isRead !== false,
    is_flagged: String(msg.flag?.flagStatus ?? '') === 'flagged',
    importance: importanceOf(msg.importance),
    has_attachments: msg.hasAttachments === true,
  };
}

/* Graph's well-known folder names, mapped to ours. */
export function folderFromWellKnownName(name: string): string {
  switch (String(name || '').toLowerCase()) {
    case 'inbox': return 'inbox';
    case 'sentitems': return 'sent';
    case 'junkemail': return 'spam';
    case 'deleteditems': return 'trash';
    default: return 'archive';
  }
}

export interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  sensitivity?: string;
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string };
  /* Who booked it. Absent on an event from before Teams meetings existed, and
     on some personal-calendar events Graph does not attach one to. */
  organizer?: { emailAddress?: GraphAddress };
  /* The zone the organiser was in when they made it — never what start/end
     carry here, which the sync always reads back as UTC (see the file
     header's Prefer: outlook.timezone="UTC"). Context only. */
  originalStartTimeZone?: string;
  attendees?: { emailAddress?: GraphAddress; status?: { response?: string } }[];
}

export interface EventRow {
  external_id: string;
  title: string;
  detail: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  kind: string;
  status: string;
  attendees: { name: string | null; email: string | null; response: string | null }[];
  organizer_name: string | null;
  organizer_email: string | null;
  /* A video-call join link, https only (see joinUrl() below). */
  meeting_url: string | null;
  /* The organiser's own zone, IANA or a Windows name as Graph sent it — shown
     for context, computed from nowhere (0026's still-open "time zones" item). */
  time_zone: string | null;
}

/* A join link worth keeping: Graph has only ever sent us https:// links in
   practice, and a page renders this straight into an href — a scheme we do
   not expect (http://, or anything stranger) is worth dropping rather than
   trusting. Case-insensitive: a scheme is not case-sensitive in the standard,
   even though Graph has never sent us anything but lowercase. */
function joinUrl(value: unknown): string | null {
  const url = String(value ?? '').trim();
  return /^https:\/\//i.test(url) ? url : null;
}

/* An event with someone from outside the studio on it is client work; one that
 * is only us is internal; one with nobody is time you blocked out. A guess,
 * and a useful one — it is what colours the agenda, and a person can change
 * it. Returns null when the start cannot be trusted (see toInstant). */
/* hidePrivate: for a studio calendar, where every member of staff reads what is
   stored. An event its organiser marked personal, private or confidential keeps
   its time, so nobody double-books it, and nothing else (security review,
   2026-09-14). */
export function toEventRow(ev: GraphEvent, ownDomain: string, options: { hidePrivate?: boolean } = {}): EventRow | null {
  const startsAt = toInstant(ev.start);
  if (!startsAt) return null;

  const attendees = (ev.attendees ?? []).map((a) => ({
    name: a.emailAddress?.name ?? null,
    email: (a.emailAddress?.address ?? '').toLowerCase() || null,
    response: a.status?.response ?? null,
  }));

  const domain = String(ownDomain || '').toLowerCase();
  const outside = attendees.some((a) => a.email && !a.email.endsWith(`@${domain}`));
  const hidden = Boolean(options.hidePrivate)
    && ['personal', 'private', 'confidential'].includes(String(ev.sensitivity ?? '').toLowerCase());
  /* Nothing to show for a hidden event: an organiser, a join link and a zone
     are still "something else" about it, the same as its attendees. */
  const meetingUrl = hidden ? null : joinUrl(ev.onlineMeeting?.joinUrl);
  const organizerEmail = hidden ? '' : String(ev.organizer?.emailAddress?.address ?? '').trim().toLowerCase();
  const organizerName = hidden ? '' : String(ev.organizer?.emailAddress?.name ?? '').trim();

  return {
    external_id: ev.id,
    title: hidden ? 'Private' : (String(ev.subject ?? '').trim() || '(no title)'),
    detail: hidden ? null
      : meetingUrl
        ? (String(ev.bodyPreview ?? '').trim() || 'Online meeting')
        : (String(ev.bodyPreview ?? '').trim() || null),
    location: hidden ? null : (ev.location?.displayName?.trim() || null),
    starts_at: startsAt,
    ends_at: toInstant(ev.end),
    all_day: ev.isAllDay === true,
    kind: hidden ? 'personal' : !attendees.length ? 'focus' : outside ? 'client' : 'team',
    status: ev.isCancelled ? 'cancelled'
      : String(ev.showAs ?? '').toLowerCase() === 'tentative' ? 'tentative'
      : 'confirmed',
    attendees: hidden ? [] : attendees,
    organizer_name: organizerName || null,
    organizer_email: organizerEmail || null,
    meeting_url: meetingUrl,
    time_zone: hidden ? null : (String(ev.originalStartTimeZone ?? '').trim() || null),
  };
}
