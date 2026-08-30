/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/semantic-boundary/verification-obligation-carried.red.test.ts
 *
 * OPEN-THE-GATES Slice 2. G15 refused a write whose readback verifier was not
 * staged this turn. Staging requires discovery, so the model was refused
 * through no fault of its own — live seq 95048,
 * `verification_successor_required:no_compatible_verifier:GOOGLESHEETS_CREATE_GOOGLE_SHEET1`.
 * All write_evidence tables stayed empty. Clem invented a connector outage.
 *
 * A missing staged verifier is a host-internal gap. Annotate and admit.
 * Ambiguity is still a model-resolvable fact.
 *
 * Re-break two ways:
 *   (i)  treat 0 candidates as a refusal (old G15)
 *   (ii) fail the binding seal when no recipe froze (old plan-tools)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verificationSuccessorDisposition } from './admit-and-compile-accepted-source.js';

const PLAN = new URL('../../tools/plan-tools.ts', import.meta.url);

test('NEGATIVE: a missing staged verifier is carried, not refused', () => {
  assert.equal(verificationSuccessorDisposition(0), 'carry_obligation');
  assert.equal(verificationSuccessorDisposition(1), 'unique');
  assert.equal(verificationSuccessorDisposition(2), 'ambiguous');
});

test('re-break (i): the old G15 zero-candidate branch was a plan refusal', () => {
  const oldG15 = (candidateCount: number): 'refuse' | 'carry' => (
    candidateCount !== 1 ? 'refuse' : 'carry'
  );
  assert.equal(oldG15(0), 'refuse', 'pre-Slice-2 treated "not staged" as a hard block');
  assert.notEqual(
    verificationSuccessorDisposition(0),
    'ambiguous',
    'zero candidates must not share the ambiguous refusal',
  );
});

test('re-break (ii): a missing frozen recipe no longer fails the binding seal', () => {
  const src = readFileSync(PLAN, 'utf8');
  assert.doesNotMatch(
    src,
    /verificationFailure \?\?= `verification_successor_required:\$\{node\.id\}:recipe was not frozen`/,
    'the seal must not refuse the plan when the host-derived recipe is absent',
  );
  assert.match(
    src,
    /wrote, could not verify/,
    'the admitted plan must tell the model to report an unverified write honestly',
  );
});
