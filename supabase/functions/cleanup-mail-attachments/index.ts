/* cleanup-mail-attachments — removing mail attachments nobody ever sent.
 *
 * send-mail deletes a message's uploads the moment it sends (0038 §5); what
 * is left in the mail-attachments bucket afterwards is a draft that was
 * closed, refreshed away, or never finished — compose keeps no record of
 * "still open" anywhere the database can see, so age (_shared/
 * attachment-cleanup.ts) is the only honest signal for what counts as
 * abandoned rather than merely slow.
 *
 * The bucket is <auth id>/<upload id>/<name> (mail-send.ts's ATTACHMENT_PATH),
 * so listing it is a two-level walk: every person's folder, then every
 * upload's folder inside it, then the file itself. FOLDER_CAP and UPLOAD_CAP
 * bound how much of each level one run looks at — the same caution as the
 * mail sync's own page ceilings (MAX_PAGES_PER_FOLDER in sync-mail-scheduled)
 * — because a run that always looked at everything would eventually take
 * longer than the platform allows a request to run. Nothing is lost by
 * running out of time: whatever a run does not reach is exactly as it was,
 * for the next scheduled run to pick up.
 *
 * A schedule has no user to sign in as, so this checks a shared secret
 * instead of a JWT — the same one sync-mail-scheduled already uses
 * (MAIL_SYNC_SECRET). Both represent "the cron job calling itself"; minting a
 * second secret for a job no more sensitive than the mail sync would only be
 * one more value to rotate.
 *
 * Deploy:   supabase functions deploy cleanup-mail-attachments --no-verify-jwt
 * Schedule: pg_cron → net.http_post, once a day (see migration 0055 §6).
 * Header:   x-sync-secret: <MAIL_SYNC_SECRET>
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from '../_shared/oauth.ts';
import { chunkPaths, staleAttachmentPaths, type StorageObject } from '../_shared/attachment-cleanup.ts';

const BUCKET = 'mail-attachments';
const MIN_SECRET_LENGTH = 32;
const LIST_PAGE = 1000;
/* A studio with more people uploading, or more abandoned drafts in flight at
   once, than these allow is not the ordinary case this schedule is written
   for — and Storage lists alphabetically, so a run that stops here picks up
   a different slice than yesterday's, not the same one forever. */
const FOLDER_CAP = 500;
const UPLOAD_CAP = 2000;
/* Paths per Storage.remove() call. */
const REMOVE_CHUNK = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Entry { name: string; isFolder: boolean }

// deno-lint-ignore no-explicit-any
async function listAll(bucket: any, prefix: string): Promise<Entry[]> {
  const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(`Could not list ${prefix || 'the bucket'}: ${error.message}`);
  /* Storage tells a folder from a file by id: a folder placeholder has none. */
  return (data ?? []).map((entry: { name: string; id: string | null }) => ({
    name: entry.name,
    isFolder: entry.id === null,
  }));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* An unset — or guessable — secret must never mean "anyone may call". */
  const expected = Deno.env.get('MAIL_SYNC_SECRET') ?? '';
  const given = req.headers.get('x-sync-secret') ?? '';
  if (expected.length < MIN_SECRET_LENGTH || !timingSafeEqual(given, expected)) {
    return json({ error: 'Not allowed' }, 401);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const bucket = admin.storage.from(BUCKET);

  try {
    const people = (await listAll(bucket, '')).filter((e) => e.isFolder).slice(0, FOLDER_CAP);
    const objects: StorageObject[] = [];
    let uploadsSeen = 0;

    for (const person of people) {
      if (uploadsSeen >= UPLOAD_CAP) break;
      const uploads = (await listAll(bucket, person.name)).filter((e) => e.isFolder);
      for (const upload of uploads) {
        if (uploadsSeen >= UPLOAD_CAP) break;
        uploadsSeen += 1;
        const path = `${person.name}/${upload.name}`;
        const { data: files, error } = await bucket.list(path, { limit: LIST_PAGE });
        if (error) throw new Error(`Could not list ${path}: ${error.message}`);
        for (const file of files ?? []) {
          objects.push({ name: `${path}/${file.name}`, created_at: file.created_at, updated_at: file.updated_at });
        }
      }
    }

    const stale = staleAttachmentPaths(objects, Date.now());
    let removed = 0;
    for (const chunk of chunkPaths(stale, REMOVE_CHUNK)) {
      const { data, error } = await bucket.remove(chunk);
      if (error) throw new Error(`Could not remove ${chunk.length} file(s): ${error.message}`);
      removed += (data ?? []).length;
    }

    return json({ ok: true, foldersSeen: people.length, uploadsSeen, checked: objects.length, removed });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 500);
  }
});
