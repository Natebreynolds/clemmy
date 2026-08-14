/**
 * RED PIN — a generic structured failure proves failure, not capability loss.
 *
 * MCP `isError:true` and provider `{ successful:false }` both say that this
 * attempt failed. Without a nominal reason or a capability-specific status,
 * neither says that the tool cannot satisfy the requirement. Eliminating the
 * candidate and reopening discovery on those generic flags turns an ordinary
 * provider error into an unrelated-tool hunt.
 *
 * Run: npx tsx --test src/runtime/harness/generic-provider-failure-outcome.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAttemptOutcome } from './attempt-outcome.js';

function assertInertFailure(
  label: string,
  signals: Parameters<typeof classifyAttemptOutcome>[0],
): void {
  const outcome = classifyAttemptOutcome(signals);
  assert.equal(outcome.kind, 'unknown', `${label} names failure, not unsupported capability`);
  assert.equal(outcome.evidence, 'structured', `${label} remains structured evidence`);
  assert.deepEqual(
    {
      retry: outcome.directive.retrySameCandidate,
      eliminates: outcome.directive.eliminatesCandidate,
      opensDiscovery: outcome.directive.opensDiscoveryEpoch,
      reconciles: outcome.directive.requiresReconciliation,
    },
    {
      retry: false,
      eliminates: false,
      opensDiscovery: false,
      reconciles: false,
    },
    `${label} must authorize no retry, candidate elimination, or discovery epoch`,
  );
}

test('a bare MCP isError result is an inert unknown failure', () => {
  assertInertFailure('MCP isError', { providerReportedError: true });
});

test('a generic successful:false envelope is an inert unknown failure', () => {
  assertInertFailure('successful:false', { envelopeSuccessful: false });
});

test('explicit capability statuses remain unsupported and discovery-bearing', () => {
  for (const status of [404, 405, 501]) {
    const outcome = classifyAttemptOutcome({
      httpStatus: status,
      providerReportedError: true,
      envelopeSuccessful: false,
    });
    assert.equal(outcome.kind, 'unsupported_capability', `HTTP ${status}`);
    assert.equal(outcome.directive.eliminatesCandidate, true, `HTTP ${status}`);
    assert.equal(outcome.directive.opensDiscoveryEpoch, true, `HTTP ${status}`);
  }
});
