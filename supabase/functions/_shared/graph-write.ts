/* Building what we send TO Microsoft Graph.
 *
 * Separate from graph-message.ts, which reads. Kept pure and tested because
 * the shapes are fiddly in ways that fail quietly: a recipient list Graph does
 * not recognise is silently dropped rather than refused, and a date without a
 * timeZone is interpreted in the mailbox's own zone.
 */

export interface Recipient { name?: string | null; email: string }

function recipient(r: Recipient | string) {
  const email = typeof r === 'string' ? r : r.email;
  const name = typeof r === 'string' ? undefined : (r.name ?? undefined);
  return { emailAddress: { address: String(email).trim(), ...(name ? { name } : {}) } };
}

export function recipients(list: (Recipient | string)[] | undefined) {
  return (list ?? [])
    .filter((r) => (typeof r === 'string' ? r : r?.email))
    .map(recipient);
}

/* The inverse of graph-message.ts's toInstant(). Graph accepts an ISO instant
 * only when the zone is stated alongside it; send "2026-09-11T14:00:00Z" with
 * no timeZone and it is read as 14:00 in the MAILBOX's timezone, which puts
 * the event an hour or two out for anyone not on UTC. */
export function graphDateTime(iso: string | Date): { dateTime: string; timeZone: string } {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Not a date: ${String(iso)}`);
  return {
    /* Graph rejects the trailing Z on this field: the zone belongs in timeZone,
       and sending both is a 400 with a singularly unhelpful message. */
    dateTime: d.toISOString().replace(/\.\d+Z$/, '').replace(/Z$/, ''),
    timeZone: 'UTC',
  };
}

export interface SendMailOptions {
  to: (Recipient | string)[];
  subject: string;
  html: string;
  cc?: (Recipient | string)[];
  replyTo?: (Recipient | string)[];
  /* Threading. Graph sets its own internet message id, but replying inside an
     existing conversation is what stops the customer's client from starting a
     new thread — see the note in send-ticket-reply. */
  saveToSentItems?: boolean;
}

export function sendMailPayload(o: SendMailOptions) {
  const to = recipients(o.to);
  if (!to.length) throw new Error('A message needs at least one recipient');
  if (!o.subject || !o.subject.trim()) throw new Error('A message needs a subject');

  return {
    message: {
      subject: o.subject,
      body: { contentType: 'HTML', content: o.html },
      toRecipients: to,
      ...(o.cc && o.cc.length ? { ccRecipients: recipients(o.cc) } : {}),
      ...(o.replyTo && o.replyTo.length ? { replyTo: recipients(o.replyTo) } : {}),
    },
    /* Default true: a reply the studio cannot find in Sent is a reply nobody
       can prove was made. */
    saveToSentItems: o.saveToSentItems !== false,
  };
}

export type Importance = 'low' | 'normal' | 'high';
const IMPORTANCE: string[] = ['low', 'normal', 'high'];

export interface DraftOptions {
  to?: (Recipient | string)[];
  cc?: (Recipient | string)[];
  bcc?: (Recipient | string)[];
  subject?: string;
  html?: string;
  importance?: string;
}

/* A draft, or the changes to one. Only what is given is sent: a reply draft
 * arrives from createReply with its recipients already filled in, and
 * PATCHing `toRecipients: []` because the caller said nothing would quietly
 * address the reply to nobody. An explicit empty list IS sent — that is how
 * someone removing everyone from Cc sticks. */
export function draftMessagePayload(o: DraftOptions) {
  if (o.importance !== undefined && !IMPORTANCE.includes(o.importance)) {
    throw new Error(`Unknown importance "${o.importance}" — low, normal or high`);
  }
  return {
    ...(o.subject !== undefined ? { subject: o.subject } : {}),
    ...(o.html !== undefined ? { body: { contentType: 'HTML', content: o.html } } : {}),
    ...(o.to !== undefined ? { toRecipients: recipients(o.to) } : {}),
    ...(o.cc !== undefined ? { ccRecipients: recipients(o.cc) } : {}),
    ...(o.bcc !== undefined ? { bccRecipients: recipients(o.bcc) } : {}),
    ...(o.importance !== undefined ? { importance: o.importance } : {}),
  };
}

/* A file small enough to POST in one request — under 3 MB. */
export function fileAttachmentPayload(o: { name: string; contentType?: string | null; contentBase64: string }) {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: o.name,
    contentType: o.contentType || 'application/octet-stream',
    contentBytes: o.contentBase64,
  };
}

/* Anything from 3 MB up goes through an upload session instead. */
export function uploadSessionPayload(o: { name: string; size: number }) {
  return { AttachmentItem: { attachmentType: 'file', name: o.name, size: o.size } };
}

/* Graph asks for upload pieces under 4 MB; 3 MiB leaves headroom. */
export const UPLOAD_CHUNK = 3 * 1024 * 1024;

/* The inclusive byte ranges of an upload, in order. Every byte once: a gap is
 * a corrupt attachment, and an overlap is a 416 halfway through. */
export function uploadRanges(size: number, chunk = UPLOAD_CHUNK): { start: number; end: number }[] {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  const step = Math.max(1, Math.floor(chunk));
  return Array.from({ length: Math.ceil(total / step) }, (_, i) => ({
    start: i * step,
    end: Math.min(total, (i + 1) * step) - 1,
  }));
}

export interface EventOptions {
  title: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  detail?: string | null;
  location?: string | null;
  allDay?: boolean;
  attendees?: (Recipient | string)[];
}

/* What update-calendar-event sends Graph for a change to an already-booked
 * event — a PATCH, so only what changed is sent, the same "only what is
 * given is sent" rule draftMessagePayload keeps for a mail draft. `changes`
 * carries our own field names (as actions.js's updateEvent already checks
 * them): title, detail, location, starts_at, ends_at. A bare `null` clears
 * detail or location; `starts_at`/`ends_at` go through graphDateTime()
 * together so a moved start never reaches Graph without its end, which
 * Graph reads as still the old length rather than the new one. */
export interface EventChanges {
  title?: string;
  detail?: string | null;
  location?: string | null;
  starts_at?: string;
  ends_at?: string | null;
}

/* Sending only a new start would leave Graph's end where it was — quietly
 * stretching or shrinking the meeting, since nothing here refuses that on its
 * own. `current` is the event's start and end as Graph has them right now
 * (read back just before the PATCH, in update-calendar-event): when a start
 * moves with no matching end in `changes`, the same length is kept, moved
 * along with it — as event-edit.js's own keepLength() already does in the
 * dialog, for a hand-made event. Anything else passes through untouched. */
export function keptDuration(
  changes: EventChanges,
  current: { starts_at: string; ends_at: string | null },
): EventChanges {
  if (changes.starts_at === undefined || changes.ends_at !== undefined) return changes;
  if (!current.ends_at) return changes;
  const length = new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime();
  if (!(length > 0)) return changes;
  return { ...changes, ends_at: new Date(new Date(changes.starts_at).getTime() + length).toISOString() };
}

export function eventUpdatePayload(changes: EventChanges) {
  const out: Record<string, unknown> = {};
  if (changes.title !== undefined) {
    if (!changes.title.trim()) throw new Error('An event needs a title');
    out.subject = changes.title.trim();
  }
  if (changes.detail !== undefined) {
    out.body = { contentType: 'Text', content: changes.detail ?? '' };
  }
  if (changes.location !== undefined) {
    out.location = { displayName: changes.location ?? '' };
  }
  if (changes.starts_at !== undefined) out.start = graphDateTime(changes.starts_at);
  if (changes.ends_at !== undefined && changes.ends_at !== null) out.end = graphDateTime(changes.ends_at);
  if (
    out.start && out.end &&
    new Date((out.end as { dateTime: string }).dateTime) < new Date((out.start as { dateTime: string }).dateTime)
  ) {
    throw new Error('An event cannot end before it starts');
  }
  return out;
}

export function eventPayload(o: EventOptions) {
  if (!o.title || !o.title.trim()) throw new Error('An event needs a title');

  const start = graphDateTime(o.startsAt);
  /* Graph requires an end. An event with only a start becomes a half hour,
     which is what a person means when they do not say. */
  const endSource = o.endsAt
    ?? new Date(new Date(start.dateTime + 'Z').getTime() + 30 * 60_000);
  const end = graphDateTime(endSource);

  if (new Date(end.dateTime) < new Date(start.dateTime)) {
    throw new Error('An event cannot end before it starts');
  }

  return {
    subject: o.title.trim(),
    ...(o.detail ? { body: { contentType: 'Text', content: o.detail } } : {}),
    ...(o.location ? { location: { displayName: o.location } } : {}),
    start,
    end,
    isAllDay: o.allDay === true,
    ...(o.attendees && o.attendees.length
      ? {
          attendees: recipients(o.attendees).map((a) => ({
            ...a,
            type: 'required',
          })),
        }
      : {}),
  };
}
