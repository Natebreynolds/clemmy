import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import {
  createCompiledWorkflowRunDefinitionSnapshot,
  createWorkflowRunDefinitionSnapshot,
  isCatalogWorkflowRunDefinitionSnapshot,
  isCompiledWorkflowRunDefinitionSnapshot,
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

test('workflow definition admission pins read_parallel_v1 topology and specialist instructions', () => {
  const original = workflow();
  original.steps[0].subgraph = {
    mode: 'read_parallel_v1',
    specialists: [
      { id: 'facts', prompt: 'Inspect factual evidence.' },
      { id: 'risks', prompt: 'Inspect risk evidence.' },
    ],
  };
  const snapshot = createWorkflowRunDefinitionSnapshot(
    'pinned-workflow',
    original,
    '2026-08-01T12:00:00.000Z',
  );

  const edited = JSON.parse(JSON.stringify(original)) as WorkflowDefinition;
  edited.steps[0].subgraph!.specialists[1].prompt = 'Use a newer specialist instruction.';
  assert.notEqual(workflowDefinitionHash(edited), snapshot.definitionHash);
  assert.equal(workflowDefinitionMatchesSnapshotIgnoringEnabled(snapshot, edited), false);
  assert.equal(
    snapshot.definition.steps[0].subgraph?.specialists[1].prompt,
    'Inspect risk evidence.',
  );
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

test('compiled workflow snapshot authenticates its catalogless scope and exact source', () => {
  const definition = workflow();
  const snapshot = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug: `compiled-${'a'.repeat(32)}`,
    sourceTurnKeyHash: 'b'.repeat(64),
    definition,
    admittedAt: '2026-08-02T12:00:00.000Z',
  });
  definition.steps[0].prompt = 'Edited after compiled admission.';

  const resolved = resolveWorkflowRunDefinitionSnapshot(snapshot);
  assert.equal(resolved.status, 'valid');
  if (resolved.status !== 'valid') return;
  assert.equal(isCompiledWorkflowRunDefinitionSnapshot(resolved.snapshot), true);
  assert.equal(isCatalogWorkflowRunDefinitionSnapshot(resolved.snapshot), false);
  assert.equal(resolved.snapshot.definition.steps[0].prompt, 'Fetch the records.');
  assert.equal(resolved.snapshot.workflowSlug, `compiled-${'a'.repeat(32)}`);
  assert.equal(resolved.snapshot.codeRevision, 'no-code');
});

test('a self-consistent pre-cut V2/project_graph_v1 compiled snapshot is unsupported', () => {
  const current = createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug: `compiled-${'9'.repeat(32)}`,
    sourceTurnKeyHash: '8'.repeat(64),
    definition: workflow(),
    admittedAt: '2026-08-02T12:00:00.000Z',
  });
  const legacyAdmission = {
    version: 2,
    scope: 'compiled',
    compilerId: 'project_graph_v1',
    sourceTurnKeyHash: current.sourceTurnKeyHash,
    workflowSlug: current.workflowSlug,
    definitionHash: current.definitionHash,
    codeRevision: 'no-code',
    admittedAt: current.admittedAt,
  };
  const legacy = {
    ...current,
    ...legacyAdmission,
    admissionHash: createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(
        Object.entries(legacyAdmission).sort(([left], [right]) => left.localeCompare(right)),
      )))
      .digest('hex'),
  };

  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(legacy), {
    status: 'invalid',
    reason: 'unsupported snapshot version 2',
  });
});

test('compiled workflow snapshot fails closed on scope, source, or definition tampering', () => {
  const create = () => createCompiledWorkflowRunDefinitionSnapshot({
    workflowSlug: `compiled-${'c'.repeat(32)}`,
    sourceTurnKeyHash: 'd'.repeat(64),
    definition: workflow(),
    admittedAt: '2026-08-02T12:00:00.000Z',
  });

  const badScope = create() as typeof create extends () => infer T ? T : never;
  (badScope as { scope: string }).scope = 'catalog';
  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(badScope), {
    status: 'invalid',
    reason: 'compiled snapshot scope is invalid',
  });

  const badSource = create();
  badSource.sourceTurnKeyHash = 'e'.repeat(64);
  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(badSource), {
    status: 'invalid',
    reason: 'compiled admission metadata does not match its hash',
  });

  const badDefinition = create();
  badDefinition.definition.steps[0].prompt = 'Tampered compiled instructions.';
  assert.deepEqual(resolveWorkflowRunDefinitionSnapshot(badDefinition), {
    status: 'invalid',
    reason: 'definition content does not match its admission hash',
  });
});

test('compiled workflow snapshots reject unsafe slugs and unbundled executable code', () => {
  assert.throws(
    () => createCompiledWorkflowRunDefinitionSnapshot({
      workflowSlug: '../compiled-project',
      sourceTurnKeyHash: 'f'.repeat(64),
      definition: workflow(),
    }),
    /reserved compiled workflow slug/i,
  );

  const deterministic = workflow();
  deterministic.steps[0].deterministic = { runner: 'scripts/transform.mjs' };
  assert.throws(
    () => createCompiledWorkflowRunDefinitionSnapshot({
      workflowSlug: `compiled-${'1'.repeat(32)}`,
      sourceTurnKeyHash: '2'.repeat(64),
      definition: deterministic,
    }),
    /deterministic runner.*run-scoped code bundles/i,
  );

  const probe = workflow();
  probe.steps[0].loopUntil = {
    maxAttempts: 2,
    probe: { runner: 'check.mjs' },
    until: { type: 'object', required_keys: ['done'] },
  };
  assert.throws(
    () => createCompiledWorkflowRunDefinitionSnapshot({
      workflowSlug: `compiled-${'3'.repeat(32)}`,
      sourceTurnKeyHash: '4'.repeat(64),
      definition: probe,
    }),
    /deterministic loop probe.*run-scoped code bundles/i,
  );
});

test('compiled workflow snapshots require an enabled manual-only definition', () => {
  assert.throws(
    () => createCompiledWorkflowRunDefinitionSnapshot({
      workflowSlug: `compiled-${'5'.repeat(32)}`,
      sourceTurnKeyHash: '6'.repeat(64),
      definition: { ...workflow(), trigger: { schedule: '0 * * * *' } },
    }),
    /enabled and manual-only/i,
  );
});
