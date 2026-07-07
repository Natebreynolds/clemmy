/**
 * Run: npx tsx --test src/dashboard/workflow-proof.test.ts
 *
 * buildWorkflowProof is a pure function, but analyzeWorkflowGaps (and the
 * classifier it shares with the runner) load config/db-adjacent modules at
 * import time — so isolate CLEMENTINE_HOME to a temp dir BEFORE importing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-proof-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { buildWorkflowProof } = await import('./workflow-proof.js');
type WorkflowProofRun = Parameters<typeof buildWorkflowProof>[1] extends (infer R)[] ? R : never;

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function run(partial: Partial<WorkflowProofRun> & { workflow: string }): WorkflowProofRun {
  return {
    id: partial.id ?? 'r1',
    status: partial.status ?? 'completed',
    createdAt: partial.createdAt ?? '2026-07-01T00:00:00.000Z',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    source: partial.source ?? null,
    error: partial.error ?? null,
    targetStepId: partial.targetStepId ?? null,
    needsAttention: partial.needsAttention ?? false,
    workflow: partial.workflow,
  };
}

test('lifecycle: a disabled, gap-free workflow with no runs is a DRAFT', () => {
  const proof = buildWorkflowProof({
    name: 'draft-wf',
    description: 'Draft a short internal note.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'note', prompt: 'Draft a short internal note.' }],
  });
  assert.equal(proof.lifecycle, 'draft');
  assert.equal(proof.label, 'DRAFT');
  assert.equal(proof.canRun, false);
  assert.equal(proof.canEnable, true);
});

test('lifecycle: an enabled, gap-free workflow is LIVE and runnable', () => {
  const proof = buildWorkflowProof({
    name: 'live-wf',
    description: 'Draft a short internal note.',
    enabled: true,
    trigger: { manual: true, schedule: '0 9 * * 1' },
    steps: [{ id: 'note', prompt: 'Draft a short internal note.' }],
  });
  assert.equal(proof.lifecycle, 'live');
  assert.equal(proof.label, 'LIVE');
  assert.equal(proof.canRun, true);
  assert.equal(proof.canEnable, true);
  assert.ok(proof.triggerSummary.includes('schedule: 0 9 * * 1'));
});

test('lifecycle: an unresolved readiness gap holds the workflow at NEEDS INFO and blocks enable', () => {
  const proof = buildWorkflowProof({
    name: 'gap-wf',
    description: 'Send outreach.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  });
  assert.equal(proof.lifecycle, 'needs_info');
  assert.equal(proof.label, 'NEEDS INFO');
  assert.equal(proof.canEnable, false);
  assert.equal(proof.canRun, false);
  assert.ok(proof.readinessGaps.some((gap) => gap.stepId === 'send'));
});

test('lifecycle: an in-flight creation test wins over everything else (TESTING)', () => {
  const proof = buildWorkflowProof(
    {
      name: 'testing-wf',
      description: 'Send outreach.',
      enabled: true,
      trigger: { manual: true },
      // Would otherwise be NEEDS INFO — the active creation test takes priority.
      steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
    },
    [run({ workflow: 'testing-wf', status: 'creation_test', finishedAt: null })],
  );
  assert.equal(proof.lifecycle, 'testing');
  assert.equal(proof.canRun, false);
  assert.equal(proof.canEnable, false);
  assert.ok(proof.evidence.latestCreationTest);
});

test('a FINISHED creation test does not pin the workflow in TESTING', () => {
  const proof = buildWorkflowProof(
    {
      name: 'done-testing-wf',
      description: 'Draft a short internal note.',
      enabled: true,
      trigger: { manual: true },
      steps: [{ id: 'note', prompt: 'Draft a short internal note.' }],
    },
    [run({ workflow: 'done-testing-wf', status: 'creation_test', finishedAt: '2026-07-02T00:00:00.000Z' })],
  );
  assert.equal(proof.lifecycle, 'live');
});

test('regression: a structured *_send call is classified SEND, not WRITE, on the proof card', () => {
  // The dashboard used to copy a classifier that only reached `send` via prompt
  // prose — a bare `call: { tool: <send> }` collapsed to `write`, under-labelling
  // an irreversible send. The proof card now shares the runner's canonical
  // classifier, so the call slug alone is enough.
  const proof = buildWorkflowProof({
    name: 'send-call-wf',
    description: 'Log and notify.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Search the CRM for prospects.', allowedTools: ['composio'] },
      // Deliberately bland prose so ONLY the call slug can drive the class.
      { id: 'email', prompt: 'Record the outcome.', call: { tool: 'composio_gmail_send_email' } },
    ],
  });
  assert.equal(proof.sideEffects.send, 1);
  assert.equal(proof.sideEffects.write, 0);
  assert.ok(proof.sideEffects.read >= 1);
  assert.ok(proof.toolNames.includes('composio_gmail_send_email'));
});

test('evidence.latestSuccessfulRun ignores completed runs that still need attention', () => {
  const proof = buildWorkflowProof(
    {
      name: 'evidence-wf',
      description: 'Draft a short internal note.',
      enabled: true,
      trigger: { manual: true },
      steps: [{ id: 'note', prompt: 'Draft a short internal note.' }],
    },
    [
      // Most recent completion, but flagged → must be skipped.
      run({ workflow: 'evidence-wf', id: 'recent', status: 'completed', finishedAt: '2026-07-03T00:00:00.000Z', needsAttention: true }),
      // Older, clean completion → the one that counts as proof.
      run({ workflow: 'evidence-wf', id: 'older', status: 'completed', finishedAt: '2026-07-01T00:00:00.000Z', needsAttention: false }),
    ],
  );
  assert.equal(proof.evidence.latestRun?.id, 'recent');
  assert.equal(proof.evidence.latestSuccessfulRun?.id, 'older');
});

test('aggregates tools, skills, and required input keys across steps', () => {
  const proof = buildWorkflowProof({
    name: 'aggregate-wf',
    description: 'Draft a short internal note.',
    enabled: true,
    trigger: { manual: true },
    inputs: {
      website: { type: 'string' },
      tone: { type: 'string', default: 'formal' },
    },
    allowedTools: ['recall_tool_result'],
    steps: [
      { id: 'a', prompt: 'Gather notes.', allowedTools: ['composio'], usesSkill: 'deep-research' },
      { id: 'b', prompt: 'Summarize.', call: { tool: 'composio_docs_read' } },
    ],
  });
  assert.deepEqual(proof.toolNames, ['composio', 'composio_docs_read', 'recall_tool_result']);
  assert.deepEqual(proof.skillNames, ['deep-research']);
  assert.deepEqual(proof.inputKeys.sort(), ['tone', 'website']);
  // `tone` has a default, so only `website` is required.
  assert.deepEqual(proof.requiredInputKeys, ['website']);
});
