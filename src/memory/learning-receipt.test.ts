import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLearningCandidate,
  isValidLearningReceipt,
  type LearningCandidateInput,
} from './learning-receipt.js';

function candidate(patch: Partial<LearningCandidateInput> = {}): LearningCandidateInput {
  return {
    target: 'skill',
    authority: 'independent_completion_judge',
    sessionId: 'session-1',
    sourceId: 'goal-1',
    terminalSuccess: true,
    independentValidation: true,
    artifactVerificationPending: 0,
    ambiguousExternalWrites: 0,
    manifestRemaining: 0,
    manifestAnomalies: 0,
    manifestUntrackedCheckpoints: 0,
    ...patch,
  };
}

test('issues a receipt only for an independently verified clean terminal success', () => {
  const decision = evaluateLearningCandidate(candidate());
  assert.equal(decision.eligible, true);
  assert.ok(decision.receipt);
  assert.equal(
    isValidLearningReceipt(decision.receipt, { sessionId: 'session-1', sourceId: 'goal-1' }),
    true,
  );
});

test('rejects degraded judge, user pause, pending artifact, and manifest gaps', () => {
  const decision = evaluateLearningCandidate(candidate({
    failedOpen: true,
    selfJudge: true,
    awaitingUser: true,
    artifactVerificationPending: 1,
    manifestRemaining: 2,
    manifestAnomalies: 1,
    manifestUntrackedCheckpoints: 3,
  }));
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join(' | '), /failed open/);
  assert.match(decision.reasons.join(' | '), /self-judged/);
  assert.match(decision.reasons.join(' | '), /awaiting user input/);
  assert.match(decision.reasons.join(' | '), /artifact binding/);
  assert.match(decision.reasons.join(' | '), /manifest item/);
  assert.match(decision.reasons.join(' | '), /anomaly/);
  assert.match(decision.reasons.join(' | '), /outside the canonical manifest/);
});

test('external mutation candidates require an unambiguous committed receipt', () => {
  const missing = evaluateLearningCandidate(candidate({
    externalWriteRequired: true,
    externalWriteReceipts: 0,
  }));
  assert.equal(missing.eligible, false);
  assert.match(missing.reasons.join(' | '), /no committed receipt/);

  const ambiguous = evaluateLearningCandidate(candidate({
    externalWriteRequired: true,
    externalWriteReceipts: 1,
    ambiguousExternalWrites: 1,
  }));
  assert.equal(ambiguous.eligible, false);
  assert.match(ambiguous.reasons.join(' | '), /ambiguous outcomes/);

  const committed = evaluateLearningCandidate(candidate({
    externalWriteRequired: true,
    externalWriteReceipts: 1,
  }));
  assert.equal(committed.eligible, true);
  assert.ok(committed.receipt?.evidence.includes('external_write_receipt'));
});

test('controller authorities cannot mint receipts from a bare success flag', () => {
  const missingControllerProof = evaluateLearningCandidate(candidate({
    authority: 'background_delivery_verifier',
    independentValidation: undefined,
    controllerValidation: false,
  }));
  assert.equal(missingControllerProof.eligible, false);
  assert.match(missingControllerProof.reasons.join(' | '), /missing background_delivery_verifier validation authority/);

  const verified = evaluateLearningCandidate(candidate({
    authority: 'background_delivery_verifier',
    independentValidation: undefined,
    controllerValidation: true,
  }));
  assert.equal(verified.eligible, true);
  assert.ok(verified.receipt?.evidence.includes('controller_validation'));
});

test('persisted receipts reject mismatched source identity', () => {
  const receipt = evaluateLearningCandidate(candidate()).receipt!;
  assert.equal(isValidLearningReceipt(receipt, { sourceId: 'different-goal' }), false);
  assert.equal(isValidLearningReceipt(receipt, { target: 'strategy' }), false);
});
