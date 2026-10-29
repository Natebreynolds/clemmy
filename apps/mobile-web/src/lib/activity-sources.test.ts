import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityEntry, RunSummary } from './api';
import { loadActivitySources } from './activity-sources';

const runs = [{ id: 'history', sessionId: 'history-session', status: 'completed' }] as RunSummary[];
const working = { entries: [{ runKey: 'working-exact' }] as ActivityEntry[], observedAt: '2026-10-29T00:00:00Z' };
const fail = async (): Promise<never> => { throw new Error('unavailable'); };
test('one unavailable Activity source stays unknown while the other source remains usable', async () => {
  const noWorking = await loadActivitySources({ history: async () => ({ runs }), working: fail }, null);
  assert.equal(noWorking.working, null);
  assert.deepEqual(noWorking.runs, runs);
  assert.equal(noWorking.workingUnavailable, true);
  assert.equal(noWorking.historyUnavailable, false);
  const noHistory = await loadActivitySources({ history: fail, working: async () => working }, null);
  assert.equal(noHistory.runs, null);
  assert.equal(noHistory.working, working);
  assert.equal(noHistory.historyUnavailable, true);
  assert.equal(noHistory.workingUnavailable, false);
});
test('partial and total failures retain separate last good snapshots without minting an observation time', async () => {
  const previous = await loadActivitySources({ history: async () => ({ runs }), working: async () => working }, null);
  const retained = await loadActivitySources({ history: fail, working: fail }, previous);
  assert.equal(retained.working, working);
  assert.equal(retained.working?.observedAt, '2026-10-29T00:00:00Z');
  assert.equal(retained.runs, runs);
  assert.equal(retained.workingUnavailable, true);
  assert.equal(retained.historyUnavailable, true);
  const recovered = await loadActivitySources({ history: async () => ({ runs: [] }), working: async () => ({ entries: [], observedAt: 'server-new' }) }, retained);
  assert.equal(recovered.workingUnavailable, false);
  assert.equal(recovered.historyUnavailable, false);
  assert.deepEqual(recovered.runs, []);
  assert.equal(recovered.working?.observedAt, 'server-new');
});
