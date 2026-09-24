/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-live-call-compiler.warm.test.ts
 *
 * Live 2026-09-22: eight minutes after a launch, the creation test of an
 * authored workflow parked its exact calendar call as "not connected" while
 * two current manifests sat in the durable store. The candidate needs an
 * observation made in THIS process; chat gets one from discovery, a call
 * step never asked. The connection pinned here: before compiling, the call
 * step refreshes the provider schema, the connected toolkits and one
 * observation per account named by its durable manifests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-warm-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { warmDurableProviderOperation } = await import('./workflow-live-call-compiler.js');

function deps(manifests: Array<{ accountId: string }>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listDurableManifests: () => manifests.map((m) => ({ ...m, definitionFingerprint: 'f'.repeat(64), providerVersion: 'v1', operationVersion: '1' })),
      ensureSchema: async (op: string) => { calls.push(`schema:${op}`); return 'fp'; },
      listToolkits: async () => { calls.push('toolkits'); return []; },
      observe: async (input: { accountId: string }) => { calls.push(`observe:${input.accountId}`); return input.accountId === 'acct-b' ? null : { ok: true }; },
    },
  };
}

test('a saved provider operation with durable manifests is observed in this process before the compile', async () => {
  const d = deps([{ accountId: 'acct-a' }, { accountId: 'acct-b' }, { accountId: '' }]);
  const result = await warmDurableProviderOperation('OUTLOOK_GET_CALENDAR_VIEW', d.deps);
  assert.equal(result.status, 'warmed');
  assert.equal(result.manifests, 3);
  assert.equal(result.observed, 1, 'one account observed, one refused, one unnamed');
  assert.deepEqual(d.calls, ['schema:OUTLOOK_GET_CALENDAR_VIEW', 'toolkits', 'observe:acct-a', 'observe:acct-b']);
  assert.ok(result.notes.some((note) => note.includes('acct-b: not observed')));
});

test('an operation with no durable manifest performs no provider work here', async () => {
  const d = deps([]);
  const result = await warmDurableProviderOperation('SOMETHING_NEVER_SAVED', d.deps);
  assert.equal(result.status, 'no_durable_manifest');
  assert.deepEqual(d.calls, []);
});

test('a failing schema refresh is a note, never a throw', async () => {
  const d = deps([{ accountId: 'acct-a' }]);
  d.deps.ensureSchema = async () => { throw new Error('provider offline'); };
  const result = await warmDurableProviderOperation('OUTLOOK_GET_CALENDAR_VIEW', d.deps);
  assert.equal(result.status, 'warmed');
  assert.ok(result.notes.some((note) => note.includes('provider offline')));
  assert.equal(result.observed, 1);
});
