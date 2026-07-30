/**
 * Run: npx tsx --test src/execution/workflow-graph-reshape.test.ts
 *
 * The reshape verb end to end: durable, deterministic, evidence-preserving,
 * and recorded. Every refusal is paired with the legitimate reshape it must
 * still admit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reshape-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  reshapeWorkflowGraph,
  loadLiveWorkflowGraph,
  WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH,
  WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH,
  WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN,
  WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE,
  WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN,
} = await import('./workflow-graph-reshape.js');
const {
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
} = await import('./workflow-graph-store.js');
const {
  compileWorkflowStepsToGraph,
  WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
} = await import('./workflow-graph.js');
const { appendWorkflowEvent, readWorkflowEvents } = await import('./workflow-events.js');
const { resolveWorkflowReadiness } = await import('./workflow-readiness.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const WF = 'reshape-wf';
const steps = [
  { id: 'pull', prompt: 'pull', sideEffect: 'read' },
  { id: 'analyze', prompt: 'analyze', dependsOn: ['pull'], sideEffect: 'read' },
  { id: 'publish', prompt: 'publish', dependsOn: ['analyze'], sideEffect: 'send', requiresApproval: true },
] as never[];

function writeRunRecord(
  runId: string,
  status: 'running' | 'completed' = 'running',
  workflow = WF,
  targetStepId?: string,
): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow,
    status,
    createdAt: new Date().toISOString(),
    ...(status === 'running'
      ? { startedAt: new Date().toISOString() }
      : { finishedAt: new Date().toISOString() }),
    ...(targetStepId ? { targetStepId } : {}),
  }), 'utf-8');
}

function seed(runId: string, status: 'running' | 'completed' = 'running'): void {
  persistWorkflowGraphSnapshot({
    workflowName: WF,
    runId,
    graph: compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` }),
  });
  writeRunRecord(runId, status);
}

function seedWithDynamicPrompts(runId: string, prompts: string[]): void {
  const graph = compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` });
  graph.nodes.push(...prompts.map((prompt, index) => ({
    id: `existing_dynamic_${index}`,
    type: 'step' as const,
    stepId: `existing_dynamic_${index}`,
    prompt,
    sideEffect: 'read' as const,
    config: {
      runtimeMode: WORKFLOW_GRAPH_ADDITIVE_NODE_MODE,
      toolAuthority: 'result_only',
    },
  })));
  persistWorkflowGraphSnapshot({ workflowName: WF, runId, graph });
  writeRunRecord(runId);
}

test('a reshape is durable, changes what runs next, and is recorded as applied', () => {
  const runId = 'run-widen';
  seed(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    completedNodeIds: ['pull'],
    patch: {
      reason: 'two sources rate-limited — split the analysis',
      proposedByNodeId: 'analyze',
      operations: [
        { op: 'add_node', node: { id: 'analyze-b', type: 'step', prompt: 'analyze b', sideEffect: 'read' } },
        { op: 'add_edge', edge: { id: 'dependency:pull->analyze-b', source: 'pull', target: 'analyze-b', type: 'dependency' } },
      ],
    },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.appliedOperations, 2);

  // Durable: a fresh read sees the reshaped graph.
  const live = loadLiveWorkflowGraph(runId);
  assert.ok(live);
  assert.ok(live!.nodes.some((n) => n.id === 'analyze-b'), 'new branch persisted');

  // Consequential: readiness over the LIVE graph offers the new branch.
  const patchedSteps = [...steps, { id: 'analyze-b', prompt: 'analyze b', dependsOn: ['pull'] }] as never[];
  const readiness = resolveWorkflowReadiness(patchedSteps, ['pull'], { graph: live });
  assert.deepEqual(readiness.readyStepIds.sort(), ['analyze', 'analyze-b']);

  // Recorded: proposed → applied, with the human reason retained.
  const kinds = readWorkflowEvents(WF, runId).map((e) => e.kind);
  assert.ok(kinds.includes('workflow_graph_patch_proposed'));
  assert.ok(kinds.includes('workflow_graph_patch_applied'));
  const appliedEvent = readWorkflowEvents(WF, runId).find((e) => e.kind === 'workflow_graph_patch_applied');
  assert.match(String(appliedEvent?.meta?.reason ?? ''), /rate-limited/);
});

test('reshape admission bounds operations and new branches per patch', () => {
  assert.equal(typeof WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH, 'number');
  assert.equal(typeof WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH, 'number');
  assert.ok(
    WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH > WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH,
    'the operation budget must leave room for dependency edges',
  );

  const operationRunId = 'run-operation-admission-cap';
  seed(operationRunId);
  const tooManyOperations = reshapeWorkflowGraph({
    workflowName: WF,
    runId: operationRunId,
    patch: {
      reason: 'Exercise the deterministic patch operation ceiling.',
      operations: Array.from(
        { length: WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH + 1 },
        (_, index) => ({
          op: 'add_node' as const,
          node: {
            id: `operation_cap_${index}`,
            type: 'step' as const,
            prompt: 'read one bounded source',
            sideEffect: 'read' as const,
          },
        }),
      ),
    },
  });
  assert.equal(tooManyOperations.ok, false);
  assert.match(
    tooManyOperations.errors.join(' '),
    new RegExp(`at most ${WORKFLOW_RESHAPE_MAX_OPERATIONS_PER_PATCH} operations`, 'i'),
  );
  assert.equal(loadLiveWorkflowGraph(operationRunId)?.nodes.length, steps.length);

  const nodeRunId = 'run-node-per-patch-admission-cap';
  seed(nodeRunId);
  const tooManyNodes = reshapeWorkflowGraph({
    workflowName: WF,
    runId: nodeRunId,
    patch: {
      reason: 'Exercise the deterministic branch ceiling for one patch.',
      operations: Array.from(
        { length: WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH + 1 },
        (_, index) => ({
          op: 'add_node' as const,
          node: {
            id: `node_cap_${index}`,
            type: 'step' as const,
            prompt: 'read one bounded source',
            sideEffect: 'read' as const,
          },
        }),
      ),
    },
  });
  assert.equal(tooManyNodes.ok, false);
  assert.match(
    tooManyNodes.errors.join(' '),
    new RegExp(`at most ${WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_PATCH} new nodes`, 'i'),
  );
  assert.equal(loadLiveWorkflowGraph(nodeRunId)?.nodes.length, steps.length);
});

test('repeated reshapes cannot grow one run past its dynamic-node budget', () => {
  assert.equal(typeof WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN, 'number');
  const runId = 'run-total-dynamic-node-cap';
  seedWithDynamicPrompts(
    runId,
    Array.from({ length: WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN }, () => 'bounded read'),
  );

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Exercise the cumulative dynamic branch ceiling.',
      operations: [{
        op: 'add_node',
        node: {
          id: 'one_dynamic_node_too_many',
          type: 'step',
          prompt: 'read one more source',
          sideEffect: 'read',
        },
      }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join(' '),
    new RegExp(`at most ${WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN} graph-added nodes`, 'i'),
  );
  assert.equal(
    loadLiveWorkflowGraph(runId)?.nodes.some((node) => node.id === 'one_dynamic_node_too_many'),
    false,
  );
});

test('reshape prompt budgets use UTF-8 bytes per node and cumulatively per run', () => {
  assert.equal(typeof WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE, 'number');
  assert.equal(typeof WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN, 'number');

  const perNodeRunId = 'run-prompt-node-byte-cap';
  seed(perNodeRunId);
  const multibytePrompt = 'é'.repeat(
    Math.floor(WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE / 2) + 1,
  );
  assert.ok(
    Buffer.byteLength(multibytePrompt, 'utf-8') > WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE,
  );
  const oversizedNode = reshapeWorkflowGraph({
    workflowName: WF,
    runId: perNodeRunId,
    patch: {
      reason: 'Exercise the per-node UTF-8 prompt ceiling.',
      operations: [{
        op: 'add_node',
        node: {
          id: 'oversized_prompt',
          type: 'step',
          prompt: multibytePrompt,
          sideEffect: 'read',
        },
      }],
    },
  });
  assert.equal(oversizedNode.ok, false);
  assert.match(
    oversizedNode.errors.join(' '),
    new RegExp(`prompt.*at most ${WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE} UTF-8 bytes`, 'i'),
  );

  const totalRunId = 'run-total-prompt-byte-cap';
  const existingPromptBytes = WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN - 1;
  const existingPrompts: string[] = [];
  let remaining = existingPromptBytes;
  while (remaining > 0) {
    const bytes = Math.min(remaining, WORKFLOW_RESHAPE_MAX_PROMPT_BYTES_PER_NODE);
    existingPrompts.push('x'.repeat(bytes));
    remaining -= bytes;
  }
  assert.ok(existingPrompts.length < WORKFLOW_RESHAPE_MAX_ADDED_NODES_PER_RUN);
  seedWithDynamicPrompts(totalRunId, existingPrompts);

  const oversizedRun = reshapeWorkflowGraph({
    workflowName: WF,
    runId: totalRunId,
    patch: {
      reason: 'Exercise the cumulative prompt ceiling.',
      operations: [{
        op: 'add_node',
        node: {
          id: 'prompt_total_overflow',
          type: 'step',
          prompt: 'ok',
          sideEffect: 'read',
        },
      }],
    },
  });
  assert.equal(oversizedRun.ok, false);
  assert.match(
    oversizedRun.errors.join(' '),
    new RegExp(
      `graph-added prompts.*at most ${WORKFLOW_RESHAPE_MAX_TOTAL_ADDED_PROMPT_BYTES_PER_RUN} UTF-8 bytes per run`,
      'i',
    ),
  );
  assert.equal(
    loadLiveWorkflowGraph(totalRunId)?.nodes.some((node) => node.id === 'prompt_total_overflow'),
    false,
  );
});

test('display-name callers resolve to the canonical graph-owner slug', () => {
  const workflowSlug = 'ads-manager';
  const workflowName = 'Google Ads Manager';
  const runId = 'run-display-name-owner';
  const ownedSteps = [{ id: 'pull', prompt: 'pull metrics', sideEffect: 'read' }] as never[];
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: ownedSteps,
  });
  persistWorkflowGraphSnapshot({
    workflowName: workflowSlug,
    runId,
    graph: compileWorkflowStepsToGraph(ownedSteps, { id: `${workflowSlug}:${runId}` }),
  });
  writeRunRecord(runId, 'running', workflowName);

  const result = reshapeWorkflowGraph({
    workflowName,
    runId,
    patch: {
      reason: 'Add a second read-only analysis while the source is fresh.',
      operations: [{
        op: 'add_node',
        node: { id: 'analyze_delta', type: 'step', prompt: 'analyze the delta', sideEffect: 'read' },
      }],
    },
  });

  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(loadLiveWorkflowGraph(runId, workflowName)?.nodes.some((node) => node.id === 'analyze_delta'));
  assert.ok(loadLiveWorkflowGraph(runId, workflowSlug)?.nodes.some((node) => node.id === 'analyze_delta'));
});

test('a committed graph patch reconciles its applied event after a crash window', () => {
  const runId = 'run-reconcile-applied-event';
  const graph = compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` });
  graph.metadata = {
    lastAppliedPatch: {
      fingerprint: 'a'.repeat(64),
      reason: 'Recover the exact audit receipt after SQLite committed.',
      proposedByNodeId: 'analyze',
      operationCount: 2,
      operations: ['add_node', 'add_edge'],
      appliedAt: '2026-07-29T12:00:00.000Z',
    },
  };
  persistWorkflowGraphSnapshot({ workflowName: WF, runId, graph });
  writeRunRecord(runId);
  assert.equal(readWorkflowEvents(WF, runId).length, 0);

  assert.ok(loadLiveWorkflowGraph(runId, WF));
  const recovered = readWorkflowEvents(WF, runId)
    .find((event) => event.kind === 'workflow_graph_patch_applied');
  assert.equal(recovered?.meta?.patchFingerprint, 'a'.repeat(64));
  assert.equal(recovered?.meta?.recoveredFromGraphSnapshot, true);
  assert.match(String(recovered?.meta?.reason ?? ''), /audit receipt/);

  loadLiveWorkflowGraph(runId, WF);
  assert.equal(
    readWorkflowEvents(WF, runId)
      .filter((event) => event.kind === 'workflow_graph_patch_applied').length,
    1,
    'reconciliation is idempotent',
  );
});

test('a missing prior patch event is recovered before a later patch can replace its graph receipt', () => {
  const runId = 'run-reconcile-before-next-patch';
  const priorFingerprint = 'b'.repeat(64);
  const graph = compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` });
  graph.metadata = {
    lastAppliedPatch: {
      fingerprint: priorFingerprint,
      reason: 'Patch A committed before the daemon stopped.',
      proposedByNodeId: 'analyze',
      operationCount: 1,
      operations: ['add_node'],
      appliedAt: '2026-07-29T12:00:00.000Z',
    },
  };
  persistWorkflowGraphSnapshot({ workflowName: WF, runId, graph });
  writeRunRecord(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Patch B adds another independent read.',
      operations: [{
        op: 'add_node',
        node: { id: 'second_read', type: 'step', prompt: 'read another source', sideEffect: 'read' },
      }],
    },
  });

  assert.equal(result.ok, true, result.errors.join('; '));
  const events = readWorkflowEvents(WF, runId);
  const applied = events.filter((event) => event.kind === 'workflow_graph_patch_applied');
  assert.equal(applied.length, 2, 'both committed patches retain an applied audit event');
  assert.equal(applied[0]?.meta?.patchFingerprint, priorFingerprint);
  assert.equal(applied[0]?.meta?.recoveredFromGraphSnapshot, true);
  assert.match(String(applied[0]?.meta?.reason ?? ''), /Patch A/);
  assert.notEqual(applied[1]?.meta?.patchFingerprint, priorFingerprint);
  assert.match(String(applied[1]?.meta?.reason ?? ''), /Patch B/);
  assert.ok(
    events.indexOf(applied[0]!) < events.findIndex((event) => event.kind === 'workflow_graph_patch_proposed'),
    'the prior receipt is recovered before the next proposal is admitted',
  );
});

test('a failed prior-receipt recovery refuses the next patch and preserves the prior graph receipt', () => {
  const runId = 'run-reconcile-failure-preserves-receipt';
  const priorFingerprint = 'c'.repeat(64);
  const graph = compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` });
  graph.metadata = {
    lastAppliedPatch: {
      fingerprint: priorFingerprint,
      reason: 'This receipt must survive an unwritable event journal.',
      proposedByNodeId: null,
      operationCount: 1,
      operations: ['add_node'],
      appliedAt: '2026-07-29T12:01:00.000Z',
    },
  };
  persistWorkflowGraphSnapshot({ workflowName: WF, runId, graph });
  writeRunRecord(runId);

  // A directory at the event-file path makes the durable append fail
  // deterministically without mocking the persistence boundary.
  mkdirSync(
    path.join(WORKFLOWS_DIR, WF, 'runs', runId, 'events.jsonl'),
    { recursive: true },
  );

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'This patch must wait until receipt recovery succeeds.',
      operations: [{
        op: 'add_node',
        node: { id: 'must_not_persist', type: 'step', prompt: 'read later', sideEffect: 'read' },
      }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /previous graph patch receipt.*could not be reconciled/i);
  const retained = loadWorkflowGraphSnapshotByRunId(runId);
  assert.equal(
    (retained?.graph.metadata?.lastAppliedPatch as Record<string, unknown> | undefined)?.fingerprint,
    priorFingerprint,
  );
  assert.equal(
    retained?.graph.nodes.some((node) => node.id === 'must_not_persist'),
    false,
    'patch B never overwrites graph state while patch A lacks its audit mirror',
  );
});

test('completed work is immutable: it cannot be rewritten, and the graph is left untouched', () => {
  const runId = 'run-evidence';
  seed(runId);
  appendWorkflowEvent(WF, runId, {
    kind: 'step_completed',
    stepId: 'pull',
    output: 'durable pull result',
  });

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    // Caller hints are deliberately ignored; the durable event above is the
    // authority that protects this node.
    completedNodeIds: ['pull'],
    patch: {
      reason: 'try to redo the pull',
      // add_node with an existing id is refused as a duplicate; prove the
      // stronger guarantee by rewriting the node through a direct collision.
      operations: [{ op: 'add_node', node: { id: 'pull', type: 'step', prompt: 'different prompt' } }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /completed node "pull"/i);

  const live = loadLiveWorkflowGraph(runId);
  assert.equal(live?.nodes.find((n) => n.id === 'pull')?.prompt, 'pull', 'original node preserved');
  assert.equal(
    readWorkflowEvents(WF, runId).some((e) => e.kind.startsWith('workflow_graph_patch_')),
    false,
    'completed/in-flight evidence is checked before proposal telemetry',
  );
});

test('a reshape may not route around an approval-gated send', () => {
  const runId = 'run-bypass';
  // publish (gated) → confirm, plus a safe analyze → confirm route.
  persistWorkflowGraphSnapshot({
    workflowName: WF,
    runId,
    graph: compileWorkflowStepsToGraph([
      ...steps,
      { id: 'confirm', prompt: 'confirm', dependsOn: ['publish', 'analyze'] },
    ] as never[], { id: `${WF}:${runId}` }),
  });
  writeRunRecord(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'skip the wait',
      operations: [{ op: 'disable_edge', edgeId: 'dependency:publish->confirm' }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /disable operations are not supported|additive read-only/i);
  // Refusal is typed and actionable, and nothing was persisted.
  assert.equal(loadLiveWorkflowGraph(runId)?.edges.find((e) => e.id === 'dependency:publish->confirm')?.disabled, undefined);
});

test('an incoherent reshape is refused with reasons the model can act on', () => {
  const runId = 'run-incoherent';
  seed(runId);

  const cyclic = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Exercise deterministic cycle validation.',
      operations: [
        { op: 'add_node', node: { id: 'cycle-a', type: 'step', prompt: 'a' } },
        { op: 'add_node', node: { id: 'cycle-b', type: 'step', prompt: 'b' } },
        { op: 'add_edge', edge: { id: 'dependency:cycle-a->cycle-b', source: 'cycle-a', target: 'cycle-b', type: 'dependency' } },
        { op: 'add_edge', edge: { id: 'dependency:cycle-b->cycle-a', source: 'cycle-b', target: 'cycle-a', type: 'dependency' } },
      ],
    },
  });
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.errors.join(' '), /cycle/i);

  const orphan = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Exercise deterministic missing-source validation.',
      operations: [
        { op: 'add_node', node: { id: 'orphan-target', type: 'step', prompt: 'target' } },
        { op: 'add_edge', edge: { id: 'dependency:ghost->orphan-target', source: 'ghost', target: 'orphan-target', type: 'dependency' } },
      ],
    },
  });
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors.join(' '), /source "ghost".*canonical node/i);

  const empty = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: { reason: 'Exercise empty-operation validation.', operations: [] },
  });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(' '), /at least one operation/);
});

test('an apply without a human-readable reason is refused before patch telemetry', () => {
  const runId = 'run-missing-reshape-reason';
  seed(runId);
  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      operations: [{
        op: 'add_node',
        node: { id: 'unexplained_branch', type: 'step', prompt: 'analyze', sideEffect: 'read' },
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /reason is required/i);
  assert.equal(
    readWorkflowEvents(WF, runId).some((event) => event.kind.startsWith('workflow_graph_patch_')),
    false,
  );
});

test('a run with no persisted graph reshapes from its steps rather than failing', () => {
  const runId = 'run-legacy';
  writeRunRecord(runId);
  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    steps,
    patch: {
      reason: 'legacy run gains a branch',
      operations: [
        { op: 'add_node', node: { id: 'analyze-c', type: 'step', prompt: 'analyze c' } },
        { op: 'add_edge', edge: { id: 'dependency:pull->analyze-c', source: 'pull', target: 'analyze-c', type: 'dependency' } },
      ],
    },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(loadLiveWorkflowGraph(runId)?.nodes.some((n) => n.id === 'analyze-c'));
});

test('unsafe workflow path traversal is rejected before any graph event is emitted', () => {
  const workflowName = '../reshape-escape-workflow';
  const runId = 'path-workflow-run';
  const result = reshapeWorkflowGraph({
    workflowName,
    runId,
    steps,
    patch: {
      operations: [{ op: 'add_node', node: { id: 'safe-read', type: 'step', prompt: 'read', sideEffect: 'read' } }],
    },
  });

  assert.deepEqual(
    readWorkflowEvents(workflowName, runId),
    [],
    'invalid workflow identifiers must be refused before proposed/rejected telemetry can resolve outside the workflow run directory',
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /invalid|unsafe|workflow/i);
});

test('unsafe run path traversal is rejected before any graph event is emitted', () => {
  const runId = '../reshape-escape-run';
  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    steps,
    patch: {
      operations: [{ op: 'add_node', node: { id: 'safe-read', type: 'step', prompt: 'read', sideEffect: 'read' } }],
    },
  });

  assert.deepEqual(
    readWorkflowEvents(WF, runId),
    [],
    'invalid run identifiers must be refused before proposed/rejected telemetry can escape the owning run directory',
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /invalid|unsafe|run/i);
});

test('a workflow cannot mutate a graph owned by another workflow, and the refusal emits no event', () => {
  const runId = 'run-wrong-owner';
  seed(runId);
  const wrongWorkflow = 'not-the-owner';

  const result = reshapeWorkflowGraph({
    workflowName: wrongWorkflow,
    runId,
    patch: {
      operations: [{ op: 'add_node', node: { id: 'other-read', type: 'step', prompt: 'read', sideEffect: 'read' } }],
    },
  });

  assert.deepEqual(
    readWorkflowEvents(wrongWorkflow, runId),
    [],
    'ownership must be established before graph-patch telemetry is appended under the caller-supplied workflow',
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /does not own|owner|workflow/i);
});

test('a terminal run cannot be reshaped, and the refusal emits no event', () => {
  const runId = 'run-already-terminal';
  seed(runId, 'completed');

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      operations: [{ op: 'add_node', node: { id: 'too-late', type: 'step', prompt: 'read', sideEffect: 'read' } }],
    },
  });

  assert.deepEqual(
    readWorkflowEvents(WF, runId),
    [],
    'terminal status must be checked before proposed/rejected graph events are appended',
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /terminal|completed|no longer running/i);
});

test('a single-step TRY run refuses graph additions it cannot execute', () => {
  const runId = 'run-single-step-try';
  persistWorkflowGraphSnapshot({
    workflowName: WF,
    runId,
    graph: compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` }),
  });
  writeRunRecord(runId, 'running', WF, 'analyze');

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Prove that an approval does not widen dynamic send authority.',
      operations: [{
        op: 'add_node',
        node: { id: 'never-runs', type: 'step', prompt: 'return a result', sideEffect: 'read' },
      }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /single-step TRY|cannot execute added graph nodes/i);
  assert.equal(
    readWorkflowEvents(WF, runId).some((event) => event.kind.startsWith('workflow_graph_patch_')),
    false,
    'non-executable proposals are refused before misleading applied telemetry',
  );
});

test('dynamic write nodes are refused even when the graph remains structurally valid', () => {
  const runId = 'run-dynamic-write';
  seed(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Prove that a dynamic write cannot acquire authority.',
      operations: [{
        op: 'add_node',
        node: { id: 'late-write', type: 'step', prompt: 'write externally', sideEffect: 'write' },
      }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /dynamic|read-only|write/i);
});

test('dynamic send nodes are refused even when they declare an approval gate', () => {
  const runId = 'run-dynamic-send';
  seed(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'Prove that an approval does not widen dynamic send authority.',
      operations: [{
        op: 'add_node',
        node: {
          id: 'late-send',
          type: 'step',
          prompt: 'send externally',
          sideEffect: 'send',
          requiresApproval: true,
        },
      }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /dynamic|read-only|send/i);
});

test('dynamic node ids reject synthesis collisions, prototype keys, paths, and oversized identifiers', () => {
  const invalidIds = [
    '__synthesis__',
    '__proto__',
    'prototype',
    'constructor',
    'path/segment',
    'colon:segment',
    '-leading-dash',
    `A${'b'.repeat(64)}`,
  ];
  invalidIds.forEach((nodeId, index) => {
    const runId = `run-invalid-node-id-${index}`;
    seed(runId);
    const result = reshapeWorkflowGraph({
      workflowName: WF,
      runId,
      patch: {
        reason: 'Exercise dynamic node identifier validation.',
        operations: [{
          op: 'add_node',
          node: { id: nodeId, type: 'step', prompt: 'read safely', sideEffect: 'read' },
        }],
      },
    });
    assert.equal(result.ok, false, `unsafe node id should be refused: ${nodeId}`);
    assert.match(result.errors.join(' '), /node id|reserved|safe identifier/i);
    assert.equal(
      loadLiveWorkflowGraph(runId)?.nodes.some((node) => node.id === nodeId),
      false,
    );
  });

  const maxLengthId = `A${'b'.repeat(63)}`;
  const validRunId = 'run-valid-max-node-id';
  seed(validRunId);
  const valid = reshapeWorkflowGraph({
    workflowName: WF,
    runId: validRunId,
    patch: {
      reason: 'Prove that the maximum safe identifier remains admissible.',
      operations: [
        {
          op: 'add_node',
          node: { id: maxLengthId, type: 'step', prompt: 'read safely', sideEffect: 'read' },
        },
        {
          op: 'add_edge',
          edge: {
            id: `dependency:pull->${maxLengthId}`,
            source: 'pull',
            target: maxLengthId,
            type: 'dependency',
          },
        },
      ],
    },
  });
  assert.equal(valid.ok, true, valid.errors.join('; '));
});

test('dynamic edges require live node references and the canonical dependency id', () => {
  const unknownSourceRunId = 'run-unknown-edge-source';
  seed(unknownSourceRunId);
  const unknownSource = reshapeWorkflowGraph({
    workflowName: WF,
    runId: unknownSourceRunId,
    patch: {
      reason: 'Exercise unknown edge-source validation.',
      operations: [
        {
          op: 'add_node',
          node: { id: 'safe-target', type: 'step', prompt: 'read safely', sideEffect: 'read' },
        },
        {
          op: 'add_edge',
          edge: {
            id: 'dependency:ghost->safe-target',
            source: 'ghost',
            target: 'safe-target',
            type: 'dependency',
          },
        },
      ],
    },
  });
  assert.equal(unknownSource.ok, false);
  assert.match(unknownSource.errors.join(' '), /source "ghost".*canonical node/i);

  const noncanonicalIdRunId = 'run-noncanonical-edge-id';
  seed(noncanonicalIdRunId);
  const noncanonicalId = reshapeWorkflowGraph({
    workflowName: WF,
    runId: noncanonicalIdRunId,
    patch: {
      reason: 'Exercise canonical edge-identifier validation.',
      operations: [
        {
          op: 'add_node',
          node: { id: 'safe-target', type: 'step', prompt: 'read safely', sideEffect: 'read' },
        },
        {
          op: 'add_edge',
          edge: {
            id: 'custom-edge-id',
            source: 'pull',
            target: 'safe-target',
            type: 'dependency',
          },
        },
      ],
    },
  });
  assert.equal(noncanonicalId.ok, false);
  assert.match(
    noncanonicalId.errors.join(' '),
    /not canonical.*dependency:pull->safe-target/i,
  );
});

test('dynamic nodes cannot acquire wildcard or ordinary work-tool authority', () => {
  for (const [runId, allowedTools] of [
    ['run-dynamic-wildcard', ['*']],
    ['run-dynamic-work-tool', ['read_file']],
  ] as const) {
    seed(runId);
    const result = reshapeWorkflowGraph({
      workflowName: WF,
      runId,
      patch: {
        reason: 'Prove that graph nodes cannot acquire ordinary work tools.',
        operations: [{
          op: 'add_node',
          node: {
            id: 'late-tool-user',
            type: 'step',
            prompt: 'try to use a tool',
            sideEffect: 'read',
            allowedTools: [...allowedTools],
          },
        }],
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /tool|wildcard|workflow_step_result/i);
    assert.equal(
      loadLiveWorkflowGraph(runId)?.nodes.some((node) => node.id === 'late-tool-user'),
      false,
    );
  }
});

test('a later patch cannot attach a dependency to an already schedulable dynamic node', () => {
  const runId = 'run-no-late-incoming-edge';
  seed(runId);
  const added = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'create a standalone read node',
      operations: [{
        op: 'add_node',
        node: { id: 'dynamic-ready', type: 'step', prompt: 'return a result', sideEffect: 'read' },
      }],
    },
  });
  assert.equal(added.ok, true, added.errors.join('; '));

  const lateEdge = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'try to add a dependency after the node became schedulable',
      operations: [{
        op: 'add_edge',
        edge: {
          id: 'dependency:pull->dynamic-ready',
          source: 'pull',
          target: 'dynamic-ready',
          type: 'dependency',
        },
      }],
    },
  });

  assert.equal(lateEdge.ok, false);
  assert.match(lateEdge.errors.join(' '), /same patch|already schedulable/i);
  assert.equal(
    loadLiveWorkflowGraph(runId)?.edges.some((edge) => edge.id === 'dependency:pull->dynamic-ready'),
    false,
    'the late dependency is not persisted after the node could have started',
  );
});

test('edge mutations targeting a durably completed node are refused', () => {
  const runId = 'run-completed-edge';
  seed(runId);
  appendWorkflowEvent(WF, runId, {
    kind: 'step_completed',
    stepId: 'analyze',
    output: 'durable evidence',
  });

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      operations: [{ op: 'disable_edge', edgeId: 'dependency:pull->analyze' }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /completed node "analyze"|completed.*edge/i);
});

test('edge mutations targeting a durably in-flight node are refused', () => {
  const runId = 'run-inflight-edge';
  seed(runId);
  appendWorkflowEvent(WF, runId, {
    kind: 'step_started',
    stepId: 'analyze',
  });

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      operations: [{ op: 'disable_edge', edgeId: 'dependency:pull->analyze' }],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /in-flight node "analyze"|in.?flight.*edge/i);
});
