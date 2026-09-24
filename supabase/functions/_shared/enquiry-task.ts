/* The follow-up task behind a Get-a-quote enquiry (website-enquiry Edge Function).

   Pure on purpose — no Deno, no Supabase, no imports — so node --test can pin
   the two things that must not drift: the due date lands on a working day in
   New York, and the task text carries everything needed to reply without
   opening anything else. */

const NEW_YORK = 'America/New_York';
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface LocalDate { y: number; m: number; d: number; dow: number }

/* The calendar date and weekday of an instant, as seen in a time zone. Intl
   does the DST arithmetic; nothing here reinvents it. */
function localDate(iso: string, timeZone: string): LocalDate {
  const t = new Date(iso);
  if (isNaN(t.getTime())) throw new Error('nextWorkingDay: not a date: ' + String(iso));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dow = DAY_INDEX[get('weekday')];
  if (dow === undefined) throw new Error('nextWorkingDay: unreadable weekday for ' + String(iso));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), dow };
}

/* YYYY-MM-DD from parts. Date.UTC normalises overflow, so day 32 of October
   is November 1 without a calendar table. */
function isoDate(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/* The next working day after `nowIso`, as a YYYY-MM-DD date in New York.
   Friday, Saturday and Sunday all land on Monday; every other day is tomorrow.
   We promise a reply "within one working day" and we work ET, so a task due
   on a Saturday would be a promise the board keeps to nobody. */
export function nextWorkingDay(nowIso: string, timeZone: string = NEW_YORK): string {
  const { y, m, d, dow } = localDate(nowIso, timeZone);
  const ahead = dow === 5 ? 3 : dow === 6 ? 2 : 1;
  return isoDate(y, m, d + ahead);
}

export interface EnquiryTaskInput {
  id: string;
  kind: 'website' | 'product';
  name: string;
  email: string;
  business?: string;
  website?: string;
  message?: string;
  packageLabel?: string;   // already a label ("Back office"), never the raw value
  leadUrl?: string;        // deep link into /admin/leads, when the caller knows the site URL
}

export interface EnquiryTask {
  title: string;
  details: string;
  priority: 'high';
  due_date: string;
}

/* What lands on the board. The title says who and what; the details are the
   enquiry itself, so the reply can be written from the task alone. `id` is
   the enquiry id — it is the reference the visitor's acknowledgement carries
   and the one thing that ties task, lead and email_log rows together. */
export function buildEnquiryTask(e: EnquiryTaskInput, nowIso: string): EnquiryTask {
  const what = e.kind === 'product' ? 'project' : 'website';
  const lines = [
    `Email: ${e.email}`,
    e.business ? `Business: ${e.business}` : '',
    e.website ? `Website: ${e.website}` : '',
    e.packageLabel ? `Package: ${e.packageLabel}` : '',
  ].filter(Boolean);
  const details =
    lines.join('\n') +
    (e.message ? `\n\nMessage:\n${e.message}` : '') +
    `\n\nRef: ${e.id}` +
    (e.leadUrl ? `\nOpen it: ${e.leadUrl}` : '');
  return {
    title: `Reply to ${e.name} - ${what} enquiry`,
    details,
    priority: 'high',
    due_date: nextWorkingDay(nowIso),
  };
}
