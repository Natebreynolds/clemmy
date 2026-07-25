import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactManifestChecks,
  isPassiveOutcomeEvent,
  manifestFor,
  type ProofBackgroundDetail,
} from './scenarios/background-proof-helpers.js';

function detail(manifest: Record<string, unknown>): ProofBackgroundDetail {
  return {
    task: {
      id: 'bg-proof',
      title: 'proof',
      status: 'running',
      runSessionId: 'background:bg-proof',
    },
    workManifests: [manifest as unknown as ProofBackgroundDetail['workManifests'][number]],
  };
}

test('compact cockpit proof accepts phase totals without the item graph', () => {
  const value = detail({
    manifestId: 'accounts',
    contractVersion: '2',
    phases: [{
      id: 'research', label: 'Research', total: 120, pending: 0, running: 0,
      succeeded: 120, failed: 0, needsValidation: 0, invalidated: 0,
    }],
    total: 120,
    completed: 120,
    remaining: 0,
    evidenceCount: 120,
    staleCheckpoints: 16,
    untrackedCheckpoints: 0,
    anomalies: [],
  });
  assert.equal(manifestFor(value, 'accounts')?.total, 120);
  assert.equal(compactManifestChecks(value, 4_000, 'accounts').every((check) => check.pass), true);
});

test('compact cockpit proof rejects a leaked item graph or oversized payload', () => {
  const value = detail({
    manifestId: 'accounts',
    contractVersion: '1',
    phases: [],
    total: 1,
    completed: 0,
    remaining: 1,
    evidenceCount: 0,
    staleCheckpoints: 0,
    untrackedCheckpoints: 0,
    anomalies: [],
    items: [{ id: 'account-a', evidence: ['huge'] }],
  });
  const checks = compactManifestChecks(value, 60_000, 'accounts');
  assert.equal(checks[0]?.pass, false);
  assert.equal(checks[1]?.pass, false);
});

test('outcome proof counts the passive delivery, not the internal proactive directive', () => {
  const base = {
    type: 'user_input_received',
    data: {
      synthetic: true,
      source: 'outcome',
      sourceId: 'bg-proof',
      status: 'done',
    },
  };
  assert.equal(isPassiveOutcomeEvent({
    ...base,
    data: { ...base.data, deliveryPhase: 'passive' },
  }, 'bg-proof'), true);
  assert.equal(isPassiveOutcomeEvent({
    ...base,
    data: { ...base.data, deliveryPhase: 'directive' },
  }, 'bg-proof'), false);
  assert.equal(isPassiveOutcomeEvent(base, 'bg-proof'), true, 'legacy unmarked deliveries remain readable');
});
