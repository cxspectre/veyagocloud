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

export interface EventOptions {
  title: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  detail?: string | null;
  location?: string | null;
  allDay?: boolean;
  attendees?: (Recipient | string)[];
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
