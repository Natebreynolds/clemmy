/** Run: node scripts/run-tests-isolated.mjs src/tools/plan-evidence-vocabulary-disclosed.test.ts
 *
 * The evidence fields take a CLOSED host vocabulary — payload | tool_result |
 * receipt | readback | local_commit_receipt — copied from a capability's
 * evidenceKinds. That set appeared in NO schema description, tool description,
 * or error message, so a model with no prior turn to copy from could only guess,
 * and every guess is prose that fails the PlanId pattern.
 *
 * It was the single most repeated plan_task rejection on 2026-09-03/04 —
 * including on a clean blank-state home (sess-desktop-5b39abc1), where it was
 * one of only two things left between discovery and a business call. The run
 * that DID succeed (run 13) had the tools named in the request, so it had
 * descriptors to copy evidenceKinds from.
 *
 * Disclosure, not constraint: the schema and pattern are unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./plan-tools.ts', import.meta.url), 'utf8');
const KINDS = ['payload', 'tool_result', 'receipt', 'readback', 'local_commit_receipt'];

test('a binding’s evidence field discloses the closed vocabulary', () => {
  const i = SRC.indexOf('evidence: z.array(PlanId)');
  assert.ok(i > 0, 'the binding evidence field must exist');
  const block = SRC.slice(i, i + 400);
  assert.match(block, /\.describe\(/, 'it must carry a description the model can read');
  for (const k of KINDS) assert.ok(block.includes(k), `must name '${k}'`);
});

test('evidenceRequirements discloses the same vocabulary', () => {
  const i = SRC.indexOf('evidenceRequirements: z.array(PlanId)');
  assert.ok(i > 0);
  const block = SRC.slice(i, i + 400);
  assert.match(block, /\.describe\(/);
  for (const k of KINDS) assert.ok(block.includes(k), `must name '${k}'`);
});

test('the PlanId pattern is unchanged — this is disclosure, not relaxation', () => {
  assert.match(SRC, /evidence: z\.array\(PlanId\)/, 'still PlanId-typed');
  assert.match(SRC, /evidenceRequirements: z\.array\(PlanId\)/, 'still PlanId-typed');
});
