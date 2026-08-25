/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/capability-resolution-deadline.test.ts
 *
 * LIVE (2026-08-24, weekly-review): a workflow step sat in capability
 * resolution for 20+ minutes — the phase's registry awaits have no timeout of
 * their own — and the watchdog could only notify at 10 minutes. The phase now
 * races one shared deadline across its three legs; a miss degrades to the
 * local capability index, the turn proceeds, and the typed reason rides the
 * planning_catalog_disclosed event instead of silence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cap-deadline-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-cap-deadline\n', 'utf8');

const { appendEvent, createSession, listEvents } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { __test__ } = await import('../../integrations/composio/client.js');

test('a wedged registry cannot hold the turn: the phase misses its deadline, records the reason, and proceeds', async () => {
  process.env.CAPABILITY_RESOLUTION_DEADLINE_MS = '250';
  __test__.setConnectedAccountsLoader(() => new Promise(() => { /* never resolves */ }));
  try {
    const session = createSession({ id: 'cap-deadline-wedged', kind: 'chat', userId: 'user-1' });
    const source = appendEvent({
      sessionId: session.id, turn: 1, role: 'user',
      type: 'user_input_received', data: { text: 'collect five widgets into a workbook' },
    });
    const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
    const startedAt = Date.now();
    const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 10_000, `phase must be bounded by the deadline, took ${elapsedMs}ms`);
    assert.equal(admitted.ok, true, 'a resolution miss degrades, it never blocks the turn');
    const disclosed = listEvents(session.id, { types: ['planning_catalog_disclosed'] })
      .filter((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === source.seq);
    assert.equal(disclosed.length, 1, 'exactly one disclosure record for the source');
    assert.equal(
      (disclosed[0]!.data as { resolution?: string }).resolution,
      'capability_resolution_deadline_exceeded',
      'the miss is a typed, durable reason — never silence',
    );
  } finally {
    __test__.setConnectedAccountsLoader(null);
    delete process.env.CAPABILITY_RESOLUTION_DEADLINE_MS;
  }
});

test('the disclosed catalog is durably recorded once per source with per-descriptor provenance', async () => {
  __test__.setConnectedAccountsLoader(async () => []);
  try {
    const session = createSession({ id: 'cap-disclosure-record', kind: 'chat', userId: 'user-1' });
    const source = appendEvent({
      sessionId: session.id, turn: 1, role: 'user',
      type: 'user_input_received', data: { text: 'collect five widgets into a workbook' },
    });
    const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
    const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
    assert.equal(admitted.ok, true);
    const disclosed = listEvents(session.id, { types: ['planning_catalog_disclosed'] })
      .filter((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === source.seq);
    assert.equal(disclosed.length, 1, 'exactly one disclosure record per admitted source');
    const data = disclosed[0]!.data as {
      resolution?: string;
      count?: number;
      capabilities?: Array<{ id?: string; effect?: string; source?: string }>;
    };
    assert.equal(data.resolution, 'completed');
    assert.equal(data.count, data.capabilities?.length ?? -1, 'count states the recorded set');
    const ids = new Set((data.capabilities ?? []).map((entry) => entry.id));
    assert.equal(ids.size, data.capabilities?.length ?? -1, 'descriptor ids are unique');
    for (const entry of data.capabilities ?? []) {
      assert.ok(entry.id && entry.effect, 'every entry names id and effect');
      assert.ok(
        ['frozen_snapshot', 'proof', 'index', 'primary_planning'].includes(entry.source ?? ''),
        `provenance names the contributing leg, got: ${entry.source}`,
      );
    }
  } finally {
    __test__.setConnectedAccountsLoader(null);
  }
});
