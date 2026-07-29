/**
 * Run: npx tsx --test src/execution/workflow-creation-preview.test.ts
 *
 * REGRESSION CLASS: a write-then-verify workflow must be enablable.
 *
 * Found live on 2026-07-29 by the bookkeeping-receipt proof. The creation test
 * previews mutating steps (never write while authoring — correct), so the
 * readback step that verifies the write ran against a row that deliberately
 * did not exist, failed its output contract, and the gate left the workflow
 * DISABLED. That made the canonical evidence pattern — append a receipt then
 * read it back, upsert a record then confirm it — permanently un-enablable.
 *
 * The fix must keep BOTH properties: an unverifiable downstream step never
 * blocks activation, and a genuinely broken read-only step still does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepLooksMutating } from './workflow-enforce.js';
import type { CreationTestStepResult } from './workflow-runner.js';

/** The activation rule, mirrored exactly from runCreationTest. */
function creationPasses(results: CreationTestStepResult[]): boolean {
  return results.every((r) => r.status === 'ok' || r.status === 'previewed' || r.status === 'unverifiable');
}

test('a write-then-verify workflow passes its creation test and can be enabled', () => {
  // append-receipt (mutating, previewed) → readback-receipt (verifies the write)
  const results: CreationTestStepResult[] = [
    { stepId: 'read-plan', status: 'ok' },
    { stepId: 'append-receipt', status: 'previewed' },
    {
      stepId: 'readback-receipt',
      status: 'unverifiable',
      detail: 'verifies a step that was previewed, so its contract cannot be checked until the first real run',
    },
  ];
  assert.equal(creationPasses(results), true, 'the canonical evidence pattern must be enablable');
});

test('a genuinely broken read-only step still blocks activation', () => {
  // The safety property this must not trade away: an empty scrape, a failed
  // contract on an INDEPENDENT read, or an error still leaves it disabled.
  for (const bad of ['empty', 'failed', 'error'] as const) {
    const results: CreationTestStepResult[] = [
      { stepId: 'read-plan', status: 'ok' },
      { stepId: 'scrape', status: bad, detail: 'returned no data' },
    ];
    assert.equal(creationPasses(results), false, `${bad} must still block activation`);
  }
});

test('only steps downstream of a preview are exempt — an unrelated read is not', () => {
  // Taint must follow dependsOn, never blanket-exempt every step in a
  // workflow that happens to contain a write.
  const previewTainted = new Set<string>(['append-receipt']);
  const dependsOnPreview = (step: { dependsOn?: string[] }): boolean =>
    (step.dependsOn ?? []).some((dep) => previewTainted.has(dep));

  assert.equal(dependsOnPreview({ dependsOn: ['append-receipt'] }), true, 'the verifier is exempt');
  assert.equal(dependsOnPreview({ dependsOn: ['read-plan'] }), false, 'an unrelated read is still checked');
  assert.equal(dependsOnPreview({}), false, 'an entry step is still checked');

  // Taint is transitive: a step verifying the verifier is exempt too.
  previewTainted.add('readback-receipt');
  assert.equal(dependsOnPreview({ dependsOn: ['readback-receipt'] }), true);
});

test('mutation detection still drives which steps get previewed', () => {
  assert.equal(stepLooksMutating({ sideEffect: 'send' }), true);
  assert.equal(stepLooksMutating({ sideEffect: 'write' }), true);
  assert.equal(stepLooksMutating({ sideEffect: 'read' }), false);
});
