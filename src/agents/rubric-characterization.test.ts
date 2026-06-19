import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE } from './orchestrator.js';

/**
 * PHASE 0b — prompt-assembly characterization (the engine-over-prompt regression net).
 *
 * Purpose: make ANY edit to the Codex/native orchestrator rubric a REVIEWABLE DIFF.
 * The 34KB rubric is treated as an accreted regression suite to prune surgically and
 * LAST (Phase 5). These tests pin its current bytes so a prune is a deliberate golden
 * update, never an accidental drift — and so the two flagship lanes (Codex decision-JSON
 * vs Claude native) stay in the documented relationship (they differ ONLY by the
 * decision contract; see the narrate-instead-of-call fix, commit 437e161).
 *
 * When one of these fails after an INTENTIONAL rubric change: update the GOLDEN_*
 * constants below to the printed len/sha16. That diff IS the review artifact.
 */

const sha16 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const TOK = (chars: number): number => Math.round(chars / 4);

// --- GOLDEN SNAPSHOT (captured 2026-06-19 @ main 0758e46) ------------------
// Update these — and only these — when a rubric edit is intentional.
const GOLDEN = {
  instructions: { len: 34919, sha16: '8f32f27992f9ad5a' },
  native: { len: 33684, sha16: '62561fc10e75f519' },
} as const;

function snapshotGuard(name: string, value: string, golden: { len: number; sha16: string }): void {
  const len = value.length;
  const hash = sha16(value);
  const msg =
    `\n  ${name} CHANGED — this is a reviewable diff.\n` +
    `    was: len=${golden.len} sha16=${golden.sha16}\n` +
    `    now: len=${len} sha16=${hash}  (≈ ${TOK(len)} tok)\n` +
    `  If this edit is intentional (e.g. a Phase-5 prune), update GOLDEN.${name} above.\n`;
  assert.equal(len, golden.len, msg);
  assert.equal(hash, golden.sha16, msg);
}

test('characterization: ORCHESTRATOR_INSTRUCTIONS is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('instructions', ORCHESTRATOR_INSTRUCTIONS, GOLDEN.instructions);
});

test('characterization: ORCHESTRATOR_BEHAVIOR_NATIVE is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('native', ORCHESTRATOR_BEHAVIOR_NATIVE, GOLDEN.native);
});

// --- The two-lane invariant (Codex vs Claude native) -----------------------
// INSTRUCTIONS = HEAD + DECISION_CONTRACT + TAIL ; NATIVE = HEAD + TAIL.
// They must differ ONLY by the decision-JSON contract block — the documented
// fix for the narrate-instead-of-call failure. If this breaks, the Claude SDK
// lane has drifted from the Codex lane (or vice-versa) in behavior, not just
// the contract — exactly the regression Phase 3 (one shared rubric source) and
// the narrate-fix guard against.

// The rubric is `array.join('\n\n')`, so splitting on the separator yields the
// original blocks exactly — robust to any char-level boundary arithmetic.
function blockPrefixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function blockSuffixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

test('two-lane invariant: native = instructions MINUS the decision-JSON contract', () => {
  const instr = ORCHESTRATOR_INSTRUCTIONS.split('\n\n');
  const native = ORCHESTRATOR_BEHAVIOR_NATIVE.split('\n\n');
  const bp = blockPrefixLen(instr, native);
  const bs = blockSuffixLen(instr, native);
  // The blocks present in INSTRUCTIONS but absent from NATIVE = the decision contract.
  const contractBlocks = instr.slice(bp, instr.length - bs);
  const nativeMiddle = native.slice(bp, native.length - bs);
  assert.equal(nativeMiddle.length, 0, 'native must have NOTHING between the shared HEAD and TAIL');
  assert.ok(contractBlocks.length > 0, 'native must be strictly smaller (it omits the contract)');
  // Order-independent: assert the delta CONTAINS the decision-contract markers,
  // not that they sit at a specific index (a reordered contract array must still pass).
  assert.ok(
    contractBlocks.some((b) => b.startsWith('Return an OrchestratorDecision')),
    `the delta must contain the decision-contract opener; got: ${JSON.stringify(contractBlocks.map((b) => b.slice(0, 32)))}`,
  );
  assert.ok(
    contractBlocks.some((b) => b.startsWith('Set `reply: null`')),
    'the delta must contain the reply:null decision-contract line',
  );
  // Reconstruct: HEAD blocks + TAIL blocks (contract removed) === native, block-for-block.
  assert.deepEqual(
    [...instr.slice(0, bp), ...instr.slice(instr.length - bs)],
    native,
    'instructions minus the decision-contract blocks must equal the native rubric',
  );
});

test('two-lane invariant: the decision-JSON contract NEVER leaks into the native lane', () => {
  // The narrate-instead-of-call root cause: the native (Claude SDK) lane was fed
  // the decision-JSON contract and copied it as text. It must stay absent.
  for (const marker of ['Return an OrchestratorDecision', 'nextAction', 'awaiting_approval']) {
    assert.ok(
      !ORCHESTRATOR_BEHAVIOR_NATIVE.includes(marker),
      `native rubric must not contain decision-contract marker ${JSON.stringify(marker)}`,
    );
  }
  // ...but the Codex lane MUST carry it (the @openai/agents loop parses it).
  assert.ok(ORCHESTRATOR_INSTRUCTIONS.includes('Return an OrchestratorDecision'));
});

// --- Token-budget guard ----------------------------------------------------
// Catches accidental bloat. Phase-0 baseline: instructions ≈ 8,730 tok. A drift
// of >5% in either direction is a prompt-size regression worth a look.
test('budget guard: rubric token estimate stays within 5% of the Phase-0 baseline', () => {
  const BASELINE_TOK = 8730;
  const actual = TOK(ORCHESTRATOR_INSTRUCTIONS.length);
  const drift = Math.abs(actual - BASELINE_TOK) / BASELINE_TOK;
  assert.ok(
    drift <= 0.05,
    `rubric is ${actual} tok vs baseline ${BASELINE_TOK} (${(drift * 100).toFixed(1)}% drift). ` +
      'If intentional, update BASELINE_TOK; otherwise the prompt grew unexpectedly.',
  );
});
