import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// Import the composed strings via orchestrator.js (the re-export path every other
// importer uses — so this also guards that the Phase-3 re-export stays intact).
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE } from './orchestrator.js';
// The shared rubric module (Phase 3): the single source both flagship lanes consume.
import { CLAUDE_BRAIN_RUBRIC, ORCHESTRATOR_INSTRUCTIONS_LEAN, renderClemRubric } from './clem-rubric.js';
import { RUBRIC_INSTRUCTIONS_BY_VARIANT } from './orchestrator.js';

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
  // 2026-06-28 (Inc A): OFFER BACKGROUND line now routes via the structured
  // `offer_background` tool → background / hold_task_for_later / now (both lanes:
  // HEAD → instructions+native; CLAUDE_BRAIN_RUBRIC_LINES → claudeBrain+lean).
  instructions: { len: 36370, sha16: '9c57dae779c73f50' },
  native: { len: 35135, sha16: 'f0ba7753baa96a15' },
  claudeBrain: { len: 4676, sha16: '5ea8acff93c8e07f' },
  // Phase-5 lean Codex variant (CLEMMY_RUBRIC_VARIANT=lean). Composed of proven text; default stays legacy.
  lean: { len: 8489, sha16: 'ec235a5240caaf97' },
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

test('characterization: CLAUDE_BRAIN_RUBRIC (lean) is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('claudeBrain', CLAUDE_BRAIN_RUBRIC, GOLDEN.claudeBrain);
});

test('characterization: ORCHESTRATOR_INSTRUCTIONS_LEAN is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('lean', ORCHESTRATOR_INSTRUCTIONS_LEAN, GOLDEN.lean);
});

test('lean variant: registered behind the variant switch, materially leaner, keeps load-bearing rules', () => {
  // Wired into the A/B substrate (opt in via CLEMMY_RUBRIC_VARIANT=lean)…
  assert.equal(RUBRIC_INSTRUCTIONS_BY_VARIANT.lean, ORCHESTRATOR_INSTRUCTIONS_LEAN, 'lean must be registered in the variant map');
  // …default is unchanged (legacy), so there is zero behavior change until an A/B flips it.
  assert.equal(RUBRIC_INSTRUCTIONS_BY_VARIANT.legacy, renderClemRubric('codex'), 'legacy stays the codex default');
  // Genuinely a prune: well under half the legacy size.
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.length * 2 < renderClemRubric('codex').length, 'lean must be far smaller than legacy');
  // Load-bearing rules survive the prune (composition invariants):
  //  - the OrchestratorDecision JSON contract (the @openai/agents loop parses it),
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('Return an OrchestratorDecision'), 'lean must keep the decision contract');
  //  - the anti-narration opener (the narrate-instead-of-call guard),
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('CALL TOOLS'), 'lean must keep the anti-narration rule');
  //  - the execution-lane + fan-out Codex essentials the gates rely on,
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('EXECUTION LANE'), 'lean must keep the execution-wrap rule');
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('FAN OUT'), 'lean must keep the fan-out rule');
  //  - converse-first (the most important interaction rule).
  assert.ok(/CONVERSE FIRST/i.test(ORCHESTRATOR_INSTRUCTIONS_LEAN), 'lean must keep converse-first');
});

// --- Phase 3: ONE shared rubric source feeds every lane ---------------------
test('shared source: renderClemRubric feeds all three lanes from clem-rubric', () => {
  // The Phase-3 invariant: both flagship lanes (and the lean chat brain) draw from
  // the SAME module. If a lane ever forks its own copy, this breaks.
  assert.equal(renderClemRubric('codex'), ORCHESTRATOR_INSTRUCTIONS, 'codex lane = the re-exported instructions');
  assert.equal(renderClemRubric('native'), ORCHESTRATOR_BEHAVIOR_NATIVE, 'native lane = the re-exported native rubric');
  assert.equal(renderClemRubric('claude_brain'), CLAUDE_BRAIN_RUBRIC, 'claude chat brain = the lean rubric');
  // and the lean brain rubric is genuinely lean vs the 34KB Codex one.
  assert.ok(CLAUDE_BRAIN_RUBRIC.length * 4 < ORCHESTRATOR_INSTRUCTIONS.length, 'claude brain rubric must stay far leaner than the Codex rubric');
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
