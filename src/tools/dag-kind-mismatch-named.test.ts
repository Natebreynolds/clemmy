import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PLAN_TOOLS = readFileSync(new URL('./plan-tools.ts', import.meta.url), 'utf8');
const PROPOSAL = readFileSync(
  new URL('../runtime/semantic-boundary/turn-semantic-proposal.ts', import.meta.url),
  'utf8',
);

// Live 2026-09-04 (Sonnet, blank state): three consecutive identical
// dag_kind_mismatch refusals, an identical re-proposal each time, zero business
// calls. Both kind arrays are in scope at the issue() site and neither was
// disclosed, so the model could not see which end of the edge to change.
test('the mismatch message names BOTH the produced and the accepted kinds', () => {
  assert.match(
    PROPOSAL,
    /predecessor produces \[\$\{nameKinds\(produced\)\}\] but successor accepts \[\$\{nameKinds\(accepted\)\}\]/,
    'both host-declared kind lists must reach the model',
  );
  assert.ok(
    !PROPOSAL.includes("'predecessor produced kinds do not satisfy successor accepted kinds'"),
    'the old kind-free message must be gone',
  );
});

test('the kind lists stay bounded — a refusal is not an unbounded dump', () => {
  const fn = PROPOSAL.split('const nameKinds =')[1]!.split('\n          );')[0]!;
  assert.match(fn, /slice\(0, 8\)/, 'cap the number of kinds');
  assert.match(fn, /slice\(0, 64\)/, 'cap each kind string');
  assert.match(fn, /'none'/, 'an empty list must read as "none", not ""');
});

test('dag_kind_mismatch gets its own repair, not the effect-substitution advice', () => {
  assert.match(PLAN_TOOLS, /function dagKindMismatchRepairInstruction\(/);
  assert.ok(
    PLAN_TOOLS.includes('?? dagKindMismatchRepairInstruction(planned.reason)'),
    'it must be wired ahead of the generic fallback',
  );
  const fn = PLAN_TOOLS.split('function dagKindMismatchRepairInstruction(')[1]!.split('\nfunction ')[0]!;
  // The generic advice ("pick a capabilityRef with the matching effect") cannot
  // fix a KIND mismatch — effect and kind are different axes.
  assert.match(fn, /KIND problem, not an effect/);
  // All three real exits must be offered, including dropping the edge.
  assert.match(fn, /acceptedInputKinds include/);
  assert.match(fn, /different predecessor/);
  assert.match(fn, /remove that dependsOn edge/);
});

test('the repair names the offending edges when the reason carries them', () => {
  const reason = 'dag_kind_mismatch:work.operations.op_dataforseo.dependsOn (predecessor produces [evidence] '
    + 'but successor accepts [records|created_resource]); dag_kind_mismatch:work.operations.op_draft_email.dependsOn '
    + '(predecessor produces [none] but successor accepts [evidence])';
  const edges = [...reason.matchAll(/dag_kind_mismatch:([^\s(]+)\s*\(([^)]*)\)/g)];
  assert.equal(edges.length, 2, 'both edges must parse out of the reason string');
  assert.equal(edges[0]![1], 'work.operations.op_dataforseo.dependsOn');
  assert.match(edges[0]![2]!, /produces \[evidence\] but successor accepts \[records\|created_resource\]/);
});
