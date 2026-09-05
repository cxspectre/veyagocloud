/* Validation for the public "Get a quote" form (website-enquiry Edge Function).

   Kept free of Deno and Supabase imports on purpose: it is unit-tested with
   node --test like the rest of _shared, and it is the ONLY place the rules
   live - the form's client-side checks in assets/js/enquiry.js mirror these
   for instant feedback, but this is what is enforced. */

export type EnquiryKind = 'website' | 'product';

/* The three packages on /websites/, plus "not sure yet". The labels are the
   ONE place a package value becomes words: the notification email, the
   follow-up task and the admin all print from here (the admin mirrors it —
   it cannot import a Deno module). */
export type EnquiryPackage = 'launch' | 'business' | 'backoffice' | 'unsure';

export const PACKAGE_LABEL: Record<EnquiryPackage, string> = {
  launch: 'Launch',
  business: 'Business',
  backoffice: 'Back office',
  unsure: 'Not sure yet',
};

/* '' for null, unknown, or anything inherited from Object.prototype. */
export function packageLabel(p: string | null | undefined): string {
  return p && Object.prototype.hasOwnProperty.call(PACKAGE_LABEL, p)
    ? PACKAGE_LABEL[p as EnquiryPackage]
    : '';
}

export interface Enquiry {
  kind: EnquiryKind;
  name: string;
  email: string;
  business: string;
  website: string;        // normalised absolute URL, or '' when not given
  message: string;
  locale: string;         // two-letter, defaults to 'en'
  page: string;           // path the form was on, for context only
  package: EnquiryPackage | null;  // what they picked on /websites/; null when not asked or not chosen
}

export type ParseResult =
  | { ok: true; value: Enquiry }
  | { ok: false; error: string; field?: string; bot?: true };

export const LIMITS = {
  name: 80,
  email: 254,
  business: 120,
  website: 200,
  message: 2000,
  page: 120,
} as const;

/* A real person needs at least this long between the form being drawn and
   pressing Send. Bots submit in milliseconds. */
export const MIN_FILL_SECONDS = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/* C0 and C1 control characters, built from code points so this source file
   itself never contains one. */
const CONTROL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) +
  String.fromCharCode(127) + '-' + String.fromCharCode(159) + ']', 'g');
const KINDS = new Set<EnquiryKind>(['website', 'product']);
const PACKAGES = new Set<string>(Object.keys(PACKAGE_LABEL));

/* Strip control characters (a pasted NUL or a stray CR can break email
   headers and makes log lines lie), collapse whitespace, clip to a length. */
export function clean(input: unknown, max: number): string {
  return String(input ?? '')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* Multi-line text keeps its line breaks but nothing else exotic. */
export function cleanMultiline(input: unknown, max: number): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, function (ch: string) { return ch === '\n' ? ch : ''; })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/* "mysite.com", "www.mysite.com/about", "https://mysite.com" all become an
   absolute http(s) URL. Anything that is not a plausible public hostname is
   rejected rather than guessed at. */
export function normaliseWebsite(input: unknown): { ok: true; url: string } | { ok: false } {
  const raw = clean(input, LIMITS.website + 20);
  if (!raw) return { ok: true, url: '' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u: URL;
  try { u = new URL(withScheme); } catch { return { ok: false }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
  if (u.username || u.password) return { ok: false };
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return { ok: false };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false };
  const url = u.toString();
  if (url.length > LIMITS.website) return { ok: false };
  return { ok: true, url };
}

export function parseEnquiry(body: unknown, now: number = Date.now()): ParseResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  /* Honeypot: hidden field, humans never see it. A filled value is a bot. */
  if (clean(b.hp_ref, 10)) return { ok: false, error: 'Rejected.', bot: true };

  /* Timing: the form stamps when it was drawn. Missing is tolerated (a
     stripped-down client), but "submitted faster than a person can type" is not. */
  const t = Number(b.t);
  if (Number.isFinite(t) && t > 0 && (now - t) / 1000 < MIN_FILL_SECONDS) {
    return { ok: false, error: 'Rejected.', bot: true };
  }

  const kind = clean(b.kind, 16) as EnquiryKind;
  if (!KINDS.has(kind)) return { ok: false, error: 'Unknown enquiry type.', field: 'kind' };

  const name = clean(b.name, LIMITS.name);
  if (name.length < 2) return { ok: false, error: 'Please tell us your name.', field: 'name' };

  const email = clean(b.email, LIMITS.email).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.', field: 'email' };

  const site = normaliseWebsite(b.website);
  if (!site.ok) return { ok: false, error: 'That website address does not look right.', field: 'website' };

  /* Optional: the /services/ form has no package field at all. A value that
     is not one of ours is refused rather than guessed at, the same rule as
     the website — the CHECK constraint would refuse it anyway, and a silent
     null would hide a form/function mismatch. */
  const packageRaw = clean(b.package, 16).toLowerCase();
  if (packageRaw && !PACKAGES.has(packageRaw)) {
    return { ok: false, error: 'Pick one of the packages.', field: 'package' };
  }
  const pkg = packageRaw ? (packageRaw as EnquiryPackage) : null;

  const localeRaw = clean(b.locale, 8).toLowerCase();
  const locale = /^[a-z]{2}$/.test(localeRaw) ? localeRaw : 'en';

  const pageRaw = clean(b.page, LIMITS.page);
  const page = /^\/[a-z0-9\-\/]*$/i.test(pageRaw) ? pageRaw : '';

  return {
    ok: true,
    value: {
      kind,
      name,
      email,
      business: clean(b.business, LIMITS.business),
      website: site.url,
      message: cleanMultiline(b.message, LIMITS.message),
      locale,
      page,
      package: pkg,
    },
  };
}
