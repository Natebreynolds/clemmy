/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-target-evidence.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-target-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { readWorkflowTargetEvidence } = await import('./workflow-target-evidence.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* ignore */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a human decision on a review gate is evidence the goal reviewer sees, with who and when', () => {
  // Live 2026-09-22, "Handoff review fixture": approved on the card, saved
  // four seconds later, judged 4/5 for "saved without your review".
  const runId = 'review-evidence-run';
  const gateSessionId = `workflow-gate:${runId}:save_summary`;
  HarnessSession.create({
    id: gateSessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Handoff review fixture::save_summary (approval gate)',
    metadata: { source: 'workflow', workflowName: 'Handoff review fixture', workflowRunId: runId, stepId: 'save_summary', gate: true },
  });
  const row = approvalRegistry.register({
    sessionId: gateSessionId,
    subject: 'Review the 3-line summary before saving it',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });

  const pending = readWorkflowTargetEvidence(runId).summary;
  assert.match(pending, /Human review gate on step "save_summary"/);
  assert.match(pending, /still pending/);

  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-command-center');
  assert.equal(resolved.ok, true);
  const approved = readWorkflowTargetEvidence(runId).summary;
  assert.match(approved, new RegExp(`approval ${row.approvalId} approved by desktop-command-center at \\d{4}-`));
  assert.match(approved, /reviewed and approved this step's material BEFORE the step ran/);

  // Another run's gate never leaks into this run's evidence.
  assert.doesNotMatch(readWorkflowTargetEvidence('some-other-run').summary, /Human review gate/);
});

for (const variant of ['verified', 'missing-artifact', 'tampered-artifact', 'invalidated', 'model-output', 'wrong-run'] as const) {
  test(`workflow target uses admitted transform artifacts, not unverified output (${variant})`, async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
    const { workflowDefinitionHash } = await import('./workflow-run-definition.js');
    const { recordStepOutput, runWorkspaceDir } = await import('./workflow-run-workspace.js');
    const { appendWorkflowEvent } = await import('./workflow-events.js');
    const { assessCompletionEvidenceCoverage } = await import('../runtime/harness/objective-judge.js');
    const { judgeWorkflowTarget } = await import('./workflow-objective-judge.js');
    const slug = `transform-evidence-${variant}`;
    const runId = `${slug}-run`;
    const value = { product: 323 };
    const definition = { name: slug, enabled: true, description: 'Return the computed product.',
      trigger: { manual: true }, steps: [{ id: 'compute', prompt: '', sideEffect: 'read',
        ...(variant === 'model-output' ? {} : { transform: { version: 1, expression: { op: 'literal', value } } }) }] };
    mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: variant === 'wrong-run' ? 'another-run' : runId,
      workflowDefinitionSnapshot: { version: 1, workflowSlug: slug, admittedAt: new Date().toISOString(),
        definition, definitionHash: workflowDefinitionHash(definition as never) },
      stepOutputs: { compute: JSON.stringify(value) },
    }));
    const artifact = recordStepOutput({ workflowName: slug, runId, stepId: 'compute', output: value, nowIso: new Date().toISOString() });
    appendWorkflowEvent(slug, runId, { kind: 'step_completed', stepId: 'compute', output: value,
      meta: { mode: variant === 'model-output' ? 'llm' : 'transform', stepOutputArtifact: artifact } });
    if (variant === 'missing-artifact') unlinkSync(path.join(runWorkspaceDir(slug, runId), artifact.path));
    if (variant === 'tampered-artifact') writeFileSync(path.join(runWorkspaceDir(slug, runId), artifact.path), '{"product":999}');
    if (variant === 'invalidated') appendWorkflowEvent(slug, runId, { kind: 'step_invalidated', stepId: 'compute' });
    const evidence = readWorkflowTargetEvidence(runId);
    const coverage = assessCompletionEvidenceCoverage({ objective: 'Return the computed product.', results: evidence.results });
    assert.equal(coverage.complete, variant === 'verified');
    if (variant === 'verified') {
      assert.match(evidence.summary, /Host-executed transform compute/);
      assert.match(evidence.summary, /323/);
      let sawReceipts = false;
      await judgeWorkflowTarget({ workflow: definition as never, inputs: {}, finalOutput: value,
        executionEvidence: () => readWorkflowTargetEvidence(runId),
        judgeFn: async (_objective, _reply, context) => {
          sawReceipts = assessCompletionEvidenceCoverage({ objective: '', results: context?.verifiedReadResults }).complete;
          return { done: true, reason: 'Verified product present.' };
        } });
      assert.equal(sawReceipts, true, 'the reviewer receives structured coverage as well as evidence text');
    } else {
      assert.equal(evidence.results?.filter(row => row.status === 'verified').length ?? 0, 0);
    }
  });
}
