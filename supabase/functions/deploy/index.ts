/* deploy — publishes the public site. Fires a GitHub repository_dispatch
   (event_type 'publish-site') so the Action can run tools/build.js, verify the
   output, and commit it. This function never builds anything itself; it only
   records the request and hands it to CI.

   Deploy:  supabase functions deploy deploy
   Secrets: supabase secrets set GITHUB_TOKEN=github_pat_... GITHUB_REPO=owner/repo
            GITHUB_TOKEN needs repository "Contents: read and write" (fine-grained
            PAT) or the classic `repo` scope — that is what repository_dispatch
            requires. GITHUB_REPO is "owner/repo", nothing else.
            SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
            injected automatically.

   The repo needs a workflow listening for it:
     on: { repository_dispatch: { types: [publish-site] } }

   Caller must be STAFF, not a manager — letting the assistant publish is the
   whole point. Managers are staff too, so they are included. Every attempt
   lands in public.build_runs as 'queued' BEFORE the dispatch, and its id rides
   along in client_payload.run_id so the Action can flip it to
   running/success/failed and attach the commit it pushed. */

import { createClient } from 'npm:@supabase/supabase-js@2';

const GITHUB_API = 'https://api.github.com';
const EVENT_TYPE = 'publish-site';

/* Who may publish. Deliberately narrower than is_staff(): an assistant is hired
   to ship content, a general 'employee' is not automatically given the keys to
   the public site. Widen here if that changes. */
const PUBLISHERS = ['owner', 'admin', 'assistant'];
const TRIGGERS = ['manual', 'cron', 'api'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
    const token = Deno.env.get('GITHUB_TOKEN');
    if (!token) return json({ error: 'GITHUB_TOKEN secret not set' }, 500);
    const repo = (Deno.env.get('GITHUB_REPO') ?? '').trim().replace(/\/+$/, '');
    if (!repo) return json({ error: 'GITHUB_REPO secret not set' }, 500);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return json({ error: 'GITHUB_REPO must look like "owner/repo"' }, 500);
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const { data: role, error: roleErr } = await asCaller.rpc('employee_role');
    if (roleErr || !PUBLISHERS.includes(String(role))) {
      return json({ error: 'You do not have permission to publish' }, 403);
    }

    const user = userData.user;

    let trigger = 'manual';
    try {
      const body = await req.json();
      if (body?.trigger) trigger = String(body.trigger);
    } catch (_) { /* empty body is fine */ }
    if (!TRIGGERS.includes(trigger)) return json({ error: 'Invalid trigger' }, 400);

    /* Service role: browser clients have no write policy on build_runs at all
       (see migration 0008), so this insert is the only way a row is created. */
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: run, error: runErr } = await admin
      .from('build_runs')
      .insert({
        triggered_by: user.id,
        triggered_by_email: user.email ?? null,
        trigger,
        status: 'queued',
      })
      .select()
      .single();
    if (runErr) return json({ error: 'Could not record the build: ' + runErr.message }, 500);

    /* A THROWN fetch (DNS failure, TLS reset, egress timeout) would otherwise
       skip the failure handling below and leave the row queued forever — no
       Action exists to ever update it, and the assistant sees a permanent
       "queued" and clicks Publish again. Mark it failed before giving up. */
    let dispatch: Response;
    try {
      dispatch = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'veyago-deploy-function',   // GitHub rejects requests without one
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: EVENT_TYPE,
          client_payload: {
            run_id: run.id,
            trigger,
            triggered_by: user.id,
            triggered_by_email: user.email ?? null,
            triggered_at: new Date().toISOString(),
          },
        }),
      });
    } catch (err) {
      const message = 'Could not reach GitHub: ' + (err instanceof Error ? err.message : String(err));
      await admin
        .from('build_runs')
        .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
        .eq('id', run.id);
      return json({ error: message }, 502);
    }

    /* A successful dispatch is 204 No Content. Anything else means the build
       will never start, so fail the row now instead of leaving it queued
       forever, and hand the caller GitHub's own status + body. */
    if (!dispatch.ok) {
      const detail = (await dispatch.text()).slice(0, 500);
      const message = `GitHub dispatch → ${dispatch.status}: ${detail || '(empty response)'}`;
      await admin
        .from('build_runs')
        .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
        .eq('id', run.id);
      return json({ error: message }, 502);
    }

    return json({ ok: true, run });
  } catch (err) {
    console.error('deploy error:', err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});
