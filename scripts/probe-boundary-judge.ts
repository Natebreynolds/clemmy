/**
 * probe:judge — show which cross-family BOUNDARY judge THIS machine resolves to,
 * given the active brain + which providers are logged in. READ-ONLY: it resolves
 * the routing decision and prints it; it does NOT dispatch a model or take any
 * external action. A fast "test along the way" for Lane A Phase 1.
 *
 * Run: npx tsx scripts/probe-boundary-judge.ts
 */
import { resolveRoleModel } from '../src/runtime/harness/model-roles.js';
import { resolveBoundaryJudge, judgeCrossFamilyEnabled, chooseBoundaryJudgeFamily } from '../src/runtime/harness/debate-model.js';

const brain = resolveRoleModel('brain');
const routing = resolveBoundaryJudge();

console.log('\n  Cross-family boundary judge — live routing on this machine\n');
console.log(`  CLEMMY_JUDGE_CROSS_FAMILY : ${judgeCrossFamilyEnabled() ? 'on' : 'OFF (byte-identical to prior MODELS.fast)'}`);
console.log(`  active brain              : ${brain.modelId}  (family: ${routing.brainFamily})`);
console.log(`  resolved boundary judge   : ${routing.modelId}  (family: ${routing.judgeFamily})`);
console.log(`  cross-family Model built  : ${routing.model ? 'yes — dispatches on a DIFFERENT family' : 'no — fail-open to MODELS.fast string'}`);
console.log(`  selfJudge (same family)   : ${routing.selfJudge ? 'YES — no other family logged in (correlated-error risk, now observable)' : 'no — judged by a different family ✓'}`);
console.log('');

if (routing.selfJudge) {
  const pick = chooseBoundaryJudgeFamily(routing.brainFamily, false, false);
  console.log(`  → To get a cross-family judge, log in to a second provider family`);
  console.log(`    (a Codex brain wants Claude available; a Claude brain wants Codex). pick=${JSON.stringify(pick)}\n`);
} else {
  console.log(`  → A ${routing.brainFamily} brain is now graded by a ${routing.judgeFamily} judge — no self-grading.\n`);
}
