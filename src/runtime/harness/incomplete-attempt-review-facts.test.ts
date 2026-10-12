import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incompleteFrameRefusalReviewFacts, incompleteReviewScope, incompleteSettlementReviewFacts,
  type IncompleteReviewCall } from './incomplete-attempt-review-facts.js';
import type { DurableLogicalCallSettlement } from './logical-call-settlement-store.js';

const source = { sessionId: 'fixture-incomplete-source', sourceUserSeq: 17 };
const call: IncompleteReviewCall = { ...source, acceptedTaskId: 'task:fixture-incomplete-source#17',
  logicalToolCallId: 'call:write', toolName: 'fixture_write', outcome: 'policy_denial' };
const settlement = (): DurableLogicalCallSettlement => ({ protocolVersion: 1, crossingAuthorityVersion: 2,
  identity: { ...source, acceptedTaskId: call.acceptedTaskId, logicalToolCallId: call.logicalToolCallId },
  toolName: call.toolName, argumentDigest: 'a'.repeat(64), semanticDigest: 'b'.repeat(64),
  executionKind: 'refused_pre_dispatch', outcome: { kind: 'policy_denial', evidence: 'nominal',
    directive: { action: 'stop_and_explain', retrySameCandidate: false, eliminatesCandidate: false,
      opensDiscoveryEpoch: false, requiresReconciliation: false } },
  recovery: { businessCall: true, mutating: true, progressClaimed: false, openedDiscoveryEpoch: false, creditedProgress: false },
  observer: { lane: 'byo' }, physicalCrossingCount: 0, hostCrossingCount: 0,
  physicalCrossingsDigest: 'c'.repeat(64), crossings: [], settlementEventId: 'event:settlement', settledAt: '2026-10-12T00:00:00.000Z',
});

test('presentation states source scope and unknown effect/target/authority fields without inventing successors', () => {
  assert.deepEqual(incompleteReviewScope(source), { ...source, scope: 'this_accepted_source_only',
    crossSourceLogicalEffect: null, provider: null, account: null, providerOperation: null, target: null,
    currentExecutionAuthority: null });
});

test('only a verified exact refused settlement with known zero crossings presents call-scoped no-dispatch evidence', () => {
  const facts = incompleteSettlementReviewFacts(call, { status: 'ok', settlement: settlement() });
  assert.equal(facts.noDispatchEvidence, 'this_exact_call_zero_crossings');
  assert.equal(facts.proof, 'exact_settlement_verified');
  assert.equal(facts.physicalAttemptId, null);
  assert.equal('logicalToolCallId' in facts && facts.logicalToolCallId, call.logicalToolCallId);
  assert.equal('settlementEventId' in facts && facts.settlementEventId, 'event:settlement');
});

for (const status of ['missing', 'corrupt', 'storage_error'] as const) {
  test(`${status} redemption cannot become positive no-dispatch evidence`, () => {
    const facts = incompleteSettlementReviewFacts(call, { status, reason: 'controlled unavailable evidence' });
    assert.equal(facts.proof, 'unavailable'); assert.equal(facts.noDispatchEvidence, 'not_established');
    assert.doesNotMatch(JSON.stringify(facts), /controlled unavailable/);
  });
}

for (const field of ['sessionId', 'sourceUserSeq', 'acceptedTaskId', 'logicalToolCallId', 'toolName', 'outcome'] as const) {
  test(`a mismatched ${field} cannot lend another settlement's proof to this call`, () => {
    const expected = { ...call, [field]: field === 'sourceUserSeq' ? 18 : 'different' } as IncompleteReviewCall;
    const facts = incompleteSettlementReviewFacts(expected, { status: 'ok', settlement: settlement() });
    assert.equal(facts.proof, 'unavailable'); assert.equal(facts.noDispatchEvidence, 'not_established');
  });
}

for (const field of ['physicalCrossingCount', 'hostCrossingCount'] as const) {
  test(`nonzero or unknown ${field} cannot be relabeled no-dispatch`, () => {
    for (const count of [1, null, -1, 0.5, undefined]) {
      const settled = { ...settlement(), [field]: count } as unknown as DurableLogicalCallSettlement;
      assert.equal(incompleteSettlementReviewFacts(call, { status: 'ok', settlement: settled }).noDispatchEvidence, 'not_established');
    }
  });
}

test('uncertain and reconciliation-required settlements do not acquire no-dispatch or replay authority', () => {
  for (const mode of ['uncertain', 'reconcile', 'entered'] as const) {
    const settled = settlement();
    if (mode === 'uncertain') settled.outcome.kind = 'uncertain_write';
    if (mode === 'reconcile') settled.outcome.directive.requiresReconciliation = true;
    if (mode === 'entered') settled.executionKind = 'local_execution';
    const facts = incompleteSettlementReviewFacts({ ...call, outcome: settled.outcome.kind }, { status: 'ok', settlement: settled });
    assert.equal(facts.noDispatchEvidence, 'not_established');
    assert.equal(facts.proof, 'exact_settlement_verified');
    assert.equal('retrySameCandidate' in facts, false, 'past recovery hints must not become current replay consent');
  }
});

test('recorded frame refusal and free-text stage never prove an operation did not dispatch', () => {
  const first = incompleteFrameRefusalReviewFacts(source, { ...source, id: 'event:refusal1', seq: 25, role: 'system',
    data: { kind: 'refused_pre_dispatch', sourceUserSeq: 17, stage: 'everything never ran',
      recoveryToolNames: ['fixture_write'], runAttemptId: 'attempt:first', runId: 'run:first' } });
  const second = incompleteFrameRefusalReviewFacts(source, { ...source, id: 'event:refusal2', seq: 26, role: 'system',
    data: { kind: 'refused_pre_dispatch', sourceUserSeq: 17, stage: 'everything never ran', runAttemptId: 'attempt:second' } });
  assert.equal(first.sourceBinding, 'recorded_exact_source'); assert.equal(first.noDispatchEvidence, 'not_established');
  assert.equal(first.recordedAttemptId, 'attempt:first'); assert.equal(first.recordedRunId, 'run:first');
  assert.notEqual(first.eventId, second.eventId); assert.notEqual(first.recordedAttemptId, second.recordedAttemptId);
  assert.doesNotMatch(JSON.stringify(first), /everything never ran|fixture_write|successor/);
});

test('cross-source, wrong role or missing owner fields cannot qualify frame refusal source binding', () => {
  const row = { ...source, id: 'event:refusal', seq: 25, role: 'system',
    data: { kind: 'refused_pre_dispatch', sourceUserSeq: 17, runAttemptId: 'attempt:first' } };
  for (const changed of [{ ...row, sessionId: 'other' }, { ...row, data: { ...row.data, sourceUserSeq: 18 } },
    { ...row, role: 'tool' }, { ...row, data: { ...row.data, kind: 'other' } }]) {
    const facts = incompleteFrameRefusalReviewFacts(source, changed);
    assert.equal(facts.sourceBinding, 'unavailable'); assert.equal(facts.recordedAttemptId, null);
    assert.equal(facts.noDispatchEvidence, 'not_established');
  }
  const missing = incompleteFrameRefusalReviewFacts(source, { ...row, data: { kind: 'refused_pre_dispatch', sourceUserSeq: 17 } });
  assert.equal(missing.recordedAttemptId, null); assert.equal(missing.recordedRunId, null);
});
