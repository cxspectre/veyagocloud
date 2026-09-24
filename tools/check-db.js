#!/usr/bin/env node
/* check-db.js — run the SQL suites in supabase/tests/ against the live project.
 *
 *   node tools/check-db.js          # report, exit 1 on any FAIL
 *
 * WHY AGAINST THE LIVE PROJECT. RLS bugs are configuration bugs. A suite run
 * against a local re-creation of the schema can be perfectly green while the
 * database people actually use is not — the policies that matter are the ones
 * deployed. Each suite therefore runs inside a transaction and ends in
 * ROLLBACK, so it reads the real policies and leaves nothing behind.
 *
 * Auth: a Supabase personal access token, from SUPABASE_ACCESS_TOKEN or (on
 * macOS) the one `supabase login` stored in the keychain. With neither, this
 * SKIPS rather than fails — CI has no token and should not go red for it.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var { execFileSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var TESTS = path.join(ROOT, 'supabase', 'tests');
var PROJECT_REF = readProjectRef();

function readProjectRef() {
  try {
    return fs.readFileSync(path.join(ROOT, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  if (process.platform !== 'darwin') return '';
  try {
    var raw = execFileSync('security',
      ['find-generic-password', '-s', 'Supabase CLI', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    var value = raw.replace(/^go-keyring-base64:/, '');
    return raw === value ? raw : Buffer.from(value, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

async function run(sql, accessToken) {
  var res = await fetch(
    'https://api.supabase.com/v1/projects/' + PROJECT_REF + '/database/query',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
  var body = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 400));
  try { return JSON.parse(body); } catch (e) { return []; }
}

(async function main() {
  var accessToken = token();
  if (!accessToken || !PROJECT_REF) {
    console.log('SKIP  database tests — no SUPABASE_ACCESS_TOKEN and no linked project');
    console.log('      (set one, or run `supabase login`, to check RLS against the real database)');
    process.exit(0);
  }

  var files = fs.readdirSync(TESTS).filter(function (f) { return /\.sql$/.test(f); }).sort();
  var failures = 0;
  var checks = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var rows;
    try {
      rows = await run(fs.readFileSync(path.join(TESTS, file), 'utf8'), accessToken);
    } catch (err) {
      console.log('FAIL  ' + file + ' — ' + err.message.split('\n')[0]);
      failures++;
      continue;
    }
    var bad = (rows || []).filter(function (r) { return r.result !== 'PASS'; });
    checks += (rows || []).length;
    if (bad.length) {
      failures += bad.length;
      console.log('FAIL  ' + file + ' — ' + bad.length + ' of ' + rows.length + ' checks');
      bad.forEach(function (r) {
        console.log('        ' + r.name + '\n          expected: ' + r.expected + '\n          actual:   ' + r.actual);
      });
    } else {
      console.log('PASS  ' + file + ' — ' + (rows || []).length + ' checks');
    }
  }

  console.log('\ndatabase: ' + (checks - failures) + ' of ' + checks + ' checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error('check-db failed:', err.message);
  process.exit(1);
});
