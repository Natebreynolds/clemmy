import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import {
  createWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
  workflowDefinitionMatchesSnapshotIgnoringEnabled,
  workflowDefinitionMatchesScheduledCatchupSnapshot,
  workflowDefinitionHash,
} from './workflow-run-definition.js';

function workflow(): WorkflowDefinition {
  return {
    name: 'Pinned workflow',
    description: 'Run the admitted definition.',
    enabled: true,
    trigger: { manual: true },
    inputs: { query: { type: 'string', required: true } },
    steps: [
      {
        id: 'fetch',
        prompt: 'Fetch the records.',
        sideEffect: 'read',
        output: { type: 'array', non_empty: [''] },
      },
    ],
  };
}

test('workflow definition hash is stable across object key order but preserves step order', () => {
  const first = workflow();
  const reordered = {
    steps: first.steps,
    trigger: first.trigger,
    enabled: first.enabled,
    description: first.description,
    name: first.name,
    inputs: first.inputs,
  } as WorkflowDefinition;
  assert.equal(workflowDefinitionHash(first), workflowDefinitionHash(reordered));

  const reversed = { ...first, steps: [...first.steps, { id: 'finish', prompt: 'Finish.' }].reverse() };
  assert.notEqual(workflowDefinitionHash(first), workflowDefinitionHash(reversed));
});

test('workflow definition snapshot is a defensive immutable copy', () => {
  const def = workflow();
  const snapshot = createWorkflowRunDefinitionSnapshot('pinned-workflow', def, '2026-07-26T12:00:00.000Z');
  def.steps[0].prompt = 'Edited after admission.';

  assert.equal(snapshot.codeRevision, 'no-code');
  assert.match(snapshot.admissionHash ?? '', /^[a-f0-9]{64}$/);
  const resolved = resolveWorkflowRunDefinitionSnapshot(snapshot);
  assert.equal(resolved.status, 'valid');
  if (resolved.status !== 'valid') return;
  assert.equal(resolved.snapshot.definition.steps[0].prompt, 'Fetch the records.');
  assert.equal(resolved.snapshot.workflowSlug, 'pinned-workflow');
});

test('a present corrupt snapshot fails closed instead of looking legacy', () => {
  const snapshot = createWorkflowRunDefinitionSnapshot('pinned-workflow', workflow(), '2026-07-26T12:00:00.000Z');
  snapshot.definition.steps[0].prompt = 'Tampered after admission.';
  const resolved = resolveWorkflowRunDefinitionSnapshot(snapshot);
  assert.deepEqual(resolved, {
    status: 'invalid',
    reason: 'definition content does not match its admission hash',
  });
  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(undefined), { status: 'absent' });
});

test('code revision is authenticated as part of admission metadata', () => {
  const snapshot = createWorkflowRunDefinitionSnapshot('pinned-workflow', workflow(), '2026-07-26T12:00:00.000Z');
  snapshot.codeRevision = 'a'.repeat(64);
  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(snapshot), {
    status: 'invalid',
    reason: 'admission metadata does not match its hash',
  });
});

test('creation-test compatibility ignores only the enable bit', () => {
  const original = { ...workflow(), enabled: false };
  const snapshot = createWorkflowRunDefinitionSnapshot('pinned-workflow', original, '2026-07-26T12:00:00.000Z');
  assert.equal(workflowDefinitionMatchesSnapshotIgnoringEnabled(snapshot, { ...original, enabled: true }), true);
  assert.equal(workflowDefinitionMatchesSnapshotIgnoringEnabled(snapshot, {
    ...original,
    enabled: true,
    steps: [{ ...original.steps[0], prompt: 'A newer edit.' }],
  }), false);
});

test('scheduled catch-up compatibility ignores admission controls but pins execution semantics', () => {
  const original = workflow();
  original.trigger = { schedule: '0 9 * * *', timezone: 'America/Los_Angeles' };
  const snapshot = createWorkflowRunDefinitionSnapshot(
    'pinned-workflow',
    original,
    '2026-07-26T12:00:00.000Z',
  );

  assert.equal(workflowDefinitionMatchesScheduledCatchupSnapshot(snapshot, {
    ...original,
    enabled: false,
    trigger: { schedule: '30 10 * * 1-5', timezone: 'America/New_York' },
  }), true, 'enabled/trigger edits govern future admissions, not this held occurrence');

  assert.equal(workflowDefinitionMatchesScheduledCatchupSnapshot(snapshot, {
    ...original,
    steps: [{ ...original.steps[0], prompt: 'Use a newer prompt.' }],
  }), false);
  assert.equal(workflowDefinitionMatchesScheduledCatchupSnapshot(snapshot, {
    ...original,
    inputs: { account: { type: 'string', required: true } },
  }), false);
  assert.equal(workflowDefinitionMatchesScheduledCatchupSnapshot(snapshot, {
    ...original,
    steps: [{
      ...original.steps[0],
      call: { tool: 'composio_gmail_search', args: { query: 'newer than:1d' } },
    }],
  }), false);
});
