/**
 * Intentionally selected same-provider review is a supported path.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/same-provider-review.test.ts
 *
 * Not every user has cross-provider access. Refusing the owner's configured
 * judge outright made one-provider terminal review impossible and killed its
 * learning candidates, while `selfJudge` could not distinguish a deliberate
 * selection from a no-other-family fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectIndependentTerminalDeliveryJudgeRoute } from './terminal-delivery-judge.js';
import { evaluateLearningCandidate } from '../../memory/learning-receipt.js';

const base = {
  model: {} as never,
  modelId: 'claude-opus-5',
  transport: 'claude_subscription' as const,
  brainFamily: 'claude' as const,
};

test('an EXPLICIT owner selection governs, even when a cross-family lane is available', () => {
  // My earlier ordering preferred cross-family first, which skipped an available
  // explicit same-provider pin for a substitute before any failure. Cross-family
  // preference is the rule for UNPINNED defaults, not a reason to override the
  // judge the owner actually chose.
  const chosen = selectIndependentTerminalDeliveryJudgeRoute([
    { ...base, judgeFamily: 'claude', selfJudge: true, ownerSelectedJudge: true },
    { ...base, judgeFamily: 'codex', selfJudge: false },
  ] as never);
  assert.equal(chosen?.ownerSelectedJudge, true, 'the owner\'s choice is honoured');
  assert.equal(chosen?.judgeFamily, 'claude');
});

test('with NO explicit selection, a cross-family lane is preferred', () => {
  const chosen = selectIndependentTerminalDeliveryJudgeRoute([
    { ...base, judgeFamily: 'claude', selfJudge: true },
    { ...base, judgeFamily: 'codex', selfJudge: false },
  ] as never);
  assert.equal(chosen?.judgeFamily, 'codex', 'unpinned defaults still prefer independence');
});

test('an owner-SELECTED same-provider route is usable when no cross-family lane exists', () => {
  const chosen = selectIndependentTerminalDeliveryJudgeRoute([
    { ...base, judgeFamily: 'claude', selfJudge: true, ownerSelectedJudge: true },
  ] as never);
  assert.ok(chosen, 'the configured judge must not be refused outright');
  assert.equal(chosen?.ownerSelectedJudge, true);
});

test('an UNSELECTED same-family fallback is still refused', () => {
  const chosen = selectIndependentTerminalDeliveryJudgeRoute([
    { ...base, judgeFamily: 'claude', selfJudge: true },
  ] as never);
  assert.equal(chosen, null, 'the coherence-trap fallback is not a terminal judge');
});

const learning = {
  sessionId: 's', sourceId: 'src', terminalSuccess: true,
  authority: 'independent_completion_judge' as const, independentValidation: true,
};

test('an owner-selected same-provider review no longer vetoes learning', () => {
  const decision = evaluateLearningCandidate({
    ...learning, selfJudge: true, ownerSelectedJudge: true,
  } as never);
  assert.ok(!decision.reasons.some((r) => /self-judged/.test(r)),
    `a configured same-provider review is a supported path: ${decision.reasons.join('; ')}`);
});

test('an UNSELECTED same-family fallback still vetoes independent-validation learning', () => {
  const decision = evaluateLearningCandidate({ ...learning, selfJudge: true } as never);
  assert.ok(decision.reasons.some((r) => /unselected same-family fallback/.test(r)),
    'the coherence trap must still block an independence claim');
});

test('a controller-validated candidate is NOT vetoed by a stray judge flag', () => {
  // Its authority never claimed independence, so judge provenance is irrelevant.
  const decision = evaluateLearningCandidate({
    sessionId: 's', sourceId: 'src', terminalSuccess: true,
    authority: 'execution_controller', controllerValidation: true, selfJudge: true,
  } as never);
  assert.ok(!decision.reasons.some((r) => /self-judged/.test(r)),
    `controller validation does not claim judge independence: ${decision.reasons.join('; ')}`);
});

test('FLOOR: a fail-open still vetoes, selected or not', () => {
  const decision = evaluateLearningCandidate({
    ...learning, failedOpen: true, selfJudge: true, ownerSelectedJudge: true,
  } as never);
  assert.ok(decision.reasons.some((r) => /failed open/.test(r)),
    'a fail-open is NO verdict and must never become a learned procedure');
});

test('a configured same-provider review carries its OWN authority, not controller proof', () => {
  // Falling through to execution_controller claimed a controller proof it did
  // not have, so the candidate was simply ineligible. It is now its own kind —
  // honestly weaker than independence, and never relabelled as independent.
  const decision = evaluateLearningCandidate({
    sessionId: 's', sourceId: 'src', terminalSuccess: true,
    authority: 'configured_completion_review', ownerSelectedJudge: true, selfJudge: true,
  } as never);
  assert.ok(!decision.reasons.some((r) => /validation authority/.test(r)),
    `a configured review must satisfy its own authority: ${decision.reasons.join('; ')}`);
});

test('configured-review authority WITHOUT an owner selection is not satisfied', () => {
  const decision = evaluateLearningCandidate({
    sessionId: 's', sourceId: 'src', terminalSuccess: true,
    authority: 'configured_completion_review', selfJudge: true,
  } as never);
  assert.ok(decision.reasons.some((r) => /validation authority/.test(r)),
    'the authority requires an actual owner selection');
});

test('a configured-review receipt VALIDATES on read-back', async () => {
  // The enum accepted the authority while the reader's AUTHORITIES set did not,
  // so a receipt was written and then rejected when read — the claim of
  // read-back validity in HANDOVER-21 was wrong.
  const { isValidLearningReceipt } = await import('../../memory/learning-receipt.js');
  const receipt = {
    version: 1, target: 'skill' as const, authority: 'configured_completion_review' as const,
    sessionId: 's', sourceId: 'src', verifiedAt: new Date().toISOString(),
    evidence: ['terminal_success', 'owner_selected_review'],
  };
  assert.equal(isValidLearningReceipt(receipt, { target: 'skill' }), true,
    'a receipt written under this authority must survive its own reader');
});

test('a configured-review receipt claiming INDEPENDENT evidence is rejected', async () => {
  const { isValidLearningReceipt } = await import('../../memory/learning-receipt.js');
  const forged = {
    version: 1, target: 'skill' as const, authority: 'configured_completion_review' as const,
    sessionId: 's', sourceId: 'src', verifiedAt: new Date().toISOString(),
    evidence: ['terminal_success', 'independent_validation'],
  };
  assert.equal(isValidLearningReceipt(forged, { target: 'skill' }), false,
    'a configured review can never be read back as independent validation');
});
