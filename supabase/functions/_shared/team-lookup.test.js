/* Tests for _shared/team-lookup.ts — whose address a mailbox or calendar is. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let m;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'team-lookup.ts'), 'utf8');
  m = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(src)));
});

/* A service-role client that answers the one read, and counts it. */
function admin(answer) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      select: (columns) => ({
        order: async (column) => { calls.push({ table, columns, column }); return answer; }
      })
    })
  };
}

test('an address is found whatever its case or the space around it', async () => {
  const client = admin({ data: [
    { id: 'e1', email: 'Sam@Veyago.cloud', created_at: '2026-01-01' },
    { id: 'e2', email: 'ana@veyago.cloud', created_at: '2026-02-01' }
  ], error: null });
  assert.equal(await m.employeeByAddress(client, ' sam@veyago.CLOUD '), 'e1');
  assert.equal(await m.employeeByAddress(client, 'hello@veyago.cloud'), null, 'the studio inbox is nobody\'s');
});

test('the first member to hold an address wins, should two ever share one', async () => {
  const client = admin({ data: [
    { id: 'e-first', email: 'jo@veyago.cloud', created_at: '2026-01-01' },
    { id: 'e-second', email: 'JO@veyago.cloud', created_at: '2026-03-01' }
  ], error: null });
  assert.equal((await m.teamAddresses(client)).get('jo@veyago.cloud'), 'e-first');
});

test('no address asks nothing', async () => {
  const client = admin({ data: [], error: null });
  assert.equal(await m.employeeByAddress(client, ''), null);
  assert.equal(await m.employeeByAddress(client, null), null);
  assert.equal(client.calls.length, 0);
});

test('a team that cannot be read is an error, never "nobody"', async () => {
  const client = admin({ data: null, error: { message: 'canceling statement due to statement timeout' } });
  await assert.rejects(m.employeeByAddress(client, 'sam@veyago.cloud'), /Could not read the team: canceling statement/);
});
