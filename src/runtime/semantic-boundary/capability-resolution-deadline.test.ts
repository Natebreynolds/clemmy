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
const {
  recordCapabilityOperations,
  deactivateCapabilityCarrier,
} = await import('../../memory/capability-index.js');

test('the independent index leg completes while connected-account resolution is wedged and survives the deadline', async () => {
  process.env.CAPABILITY_RESOLUTION_DEADLINE_MS = '300';
  recordCapabilityOperations([{
    identifier: 'LOCALINDEX_WIDGET_SEARCH',
    carrierKind: 'composio',
    carrier: 'localindex-latency-fixture',
    displayName: 'Search latency widgets',
    description: 'Find latency widgets from the local indexed catalog.',
    effectClass: 'read',
    effectProvenance: 'declared',
  }]);
  let connectedLoaderStarted!: () => void;
  const loaderStarted = new Promise<void>((resolve) => { connectedLoaderStarted = resolve; });
  __test__.setConnectedAccountsLoader(() => {
    connectedLoaderStarted();
    return new Promise(() => { /* the production account leg can wedge */ });
  });
  try {
    const session = createSession({ id: 'cap-deadline-index-concurrent', kind: 'chat', userId: 'user-index' });
    const source = appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'find latency widgets' },
    });
    const admittedPromise = admitAndCompileAcceptedSource({
      identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq },
      surface: 'direct',
    });
    let loaderStartTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loaderStarted,
        new Promise<never>((_resolve, reject) => {
          loaderStartTimer = setTimeout(
            () => reject(new Error('connected-account leg did not start')),
            2_000,
          );
        }),
      ]);
    } finally {
      if (loaderStartTimer) clearTimeout(loaderStartTimer);
    }
    // If index retrieval was started independently, its immutable result is
    // already captured. Remove the live row so a post-deadline fallback query
    // cannot make a serial implementation accidentally pass this assertion.
    deactivateCapabilityCarrier('composio', 'localindex-latency-fixture');

    const startedAt = Date.now();
    const admitted = await admittedPromise;
    const elapsedAfterWedgeObservedMs = Date.now() - startedAt;
    assert.equal(admitted.ok, true, 'the connected-account miss degrades instead of blocking the turn');
    assert.ok(
      elapsedAfterWedgeObservedMs < 2_500,
      `the one phase deadline must yield promptly, took ${elapsedAfterWedgeObservedMs}ms after the wedge was observed`,
    );
    const disclosure = listEvents(session.id, { types: ['planning_catalog_disclosed'] })
      .find((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === source.seq);
    assert.equal((disclosure?.data as { resolution?: string } | undefined)?.resolution,
      'capability_resolution_deadline_exceeded');
    assert.ok(
      ((disclosure?.data as {
        capabilities?: Array<{ id?: string; source?: string }>;
      } | undefined)?.capabilities ?? []).some((entry) =>
        entry.id === 'cap:resolved:localindex_widget_search' && entry.source === 'index'),
      'the completed concurrent index result must be disclosed even though the connected leg missed the phase deadline',
    );
  } finally {
    __test__.setConnectedAccountsLoader(null);
    delete process.env.CAPABILITY_RESOLUTION_DEADLINE_MS;
  }
});

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
    recordCapabilityOperations([
      {
        identifier: 'STABLE_WIDGETS_ALPHA',
        carrierKind: 'composio',
        carrier: 'stable-index-fixture',
        displayName: 'Collect stable widgets alpha',
        description: 'Collect five stable widgets into a workbook.',
        effectClass: 'read',
        effectProvenance: 'declared',
      },
      {
        identifier: 'STABLE_WIDGETS_BETA',
        carrierKind: 'composio',
        carrier: 'stable-index-fixture',
        displayName: 'Collect stable widgets beta',
        description: 'Collect five stable widgets into a workbook.',
        effectClass: 'read',
        effectProvenance: 'declared',
      },
    ]);
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
    assert.deepEqual(
      (data.capabilities ?? [])
        .map((entry) => entry.id)
        .filter((id) => id?.startsWith('cap:resolved:stable_widgets_')),
      ['cap:resolved:stable_widgets_alpha', 'cap:resolved:stable_widgets_beta'],
      'the completed path keeps the stable deterministic index ordering',
    );
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
