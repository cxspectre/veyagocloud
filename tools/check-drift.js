#!/usr/bin/env node
/* Does the repo match what is actually deployed?
 *
 * Answers two questions the code cannot answer about itself:
 *   - is every migration in supabase/migrations/ recorded as applied?
 *   - is every function in supabase/functions/ actually deployed?
 *
 * Both were wrong in production at the same time, and neither showed up as an
 * error anywhere. See .github/workflows/drift.yml for the full account.
 *
 * Run locally with a linked project:   node tools/check-drift.js
 * Run in CI with SUPABASE_ACCESS_TOKEN + REF set.
 *
 * Exits 1 on drift, 0 when clean. Deliberately says what to RUN, not just what
 * is wrong — the fix for each case is a single command and there is no reason
 * to make someone go and look it up.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REF = process.env.REF || process.env.SUPABASE_PROJECT_REF || '';

function supabase(args) {
  /* --output-format, NOT -o. The latter is the format for *status variables*
     and silently prints a markdown table instead. The CLI also emits JSON on
     its own when it detects an agent, which is exactly the kind of thing that
     works locally and fails in CI, so ask explicitly and pin --agent no. */
  const full = ['--output-format', 'json', '--agent', 'no']
    .concat(args, REF ? ['--project-ref', REF] : []);
  return execFileSync('supabase', full, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
}

/* The CLI prints progress lines before its JSON, so take the last line that
   parses rather than assuming the whole output is a document. */
function lastJson(out) {
  const lines = String(out).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  throw new Error('No JSON in CLI output:\n' + out);
}

function localMigrations() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.split('_')[0])
    .sort();
}

function localFunctions() {
  const dir = path.join(ROOT, 'supabase', 'functions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    /* _shared is a library, not a function — it has no index.ts entrypoint and
       is bundled into the others. */
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .filter((d) => fs.existsSync(path.join(dir, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

const problems = [];
const notes = [];

/* ── Migrations ─────────────────────────────────────────────────────────── */
try {
  const rows = lastJson(supabase(['migration', 'list'])).migrations || [];
  const remote = new Set(rows.filter((r) => r.remote).map((r) => r.remote));
  const missing = localMigrations().filter((v) => !remote.has(v));

  /* The reverse case matters too: a version applied to production that no file
     explains is how a schema drifts somewhere nobody can reproduce. */
  const localSet = new Set(localMigrations());
  const orphans = rows.filter((r) => r.remote && !localSet.has(r.remote)).map((r) => r.remote);

  if (missing.length) {
    problems.push(
      `${missing.length} migration(s) not applied to production: ${missing.join(', ')}\n` +
      `    → supabase db push\n` +
      `    → if they are already applied by hand: supabase migration repair --status applied <version>\n` +
      `      but check FIRST that each really ran — repairing one that did not skips it forever.`
    );
  } else {
    notes.push(`migrations: ${localMigrations().length} local, all applied`);
  }

  if (orphans.length) {
    problems.push(
      `${orphans.length} migration(s) applied to production with no file in the repo: ${orphans.join(', ')}\n` +
      `    → someone applied SQL outside the repo. Capture it: supabase db pull`
    );
  }
} catch (err) {
  problems.push('Could not read migration history: ' + err.message.split('\n')[0]);
}

/* ── Edge functions ─────────────────────────────────────────────────────── */
try {
  const fns = lastJson(supabase(['functions', 'list'])).functions || [];
  const deployed = new Set(fns.map((f) => f.slug));
  const local = localFunctions();
  const missing = local.filter((n) => !deployed.has(n));

  if (missing.length) {
    problems.push(
      `${missing.length} function(s) in the repo but never deployed: ${missing.join(', ')}\n` +
      `    → supabase functions deploy ${missing.join(' ')}\n` +
      `      Callers use .catch() fire-and-forget in places, so an undeployed\n` +
      `      function fails silently rather than visibly.`
    );
  } else {
    notes.push(`functions: ${local.length} local, all deployed`);
  }

  const inactive = fns.filter((f) => f.status && f.status !== 'ACTIVE');
  if (inactive.length) {
    problems.push('function(s) not ACTIVE: ' +
      inactive.map((f) => `${f.slug} (${f.status})`).join(', '));
  }
} catch (err) {
  problems.push('Could not read deployed functions: ' + err.message.split('\n')[0]);
}

/* ── Report ─────────────────────────────────────────────────────────────── */
const summary = process.env.GITHUB_STEP_SUMMARY;
const write = (s) => { if (summary) fs.appendFileSync(summary, s + '\n'); };

if (problems.length) {
  console.error('\nDrift between the repo and production:\n');
  problems.forEach((p) => console.error('  ✗ ' + p + '\n'));
  write('### Drift detected\n');
  problems.forEach((p) => write('- ' + p.split('\n')[0]));
  write('\nSee the job log for the exact commands.');
  process.exit(1);
}

console.log('\nNo drift. ' + notes.join(' · ') + '\n');
write('### No drift\n\n' + notes.map((n) => '- ' + n).join('\n'));
