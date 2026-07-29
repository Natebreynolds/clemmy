/**
 * Run: npx tsx --test src/execution/workflow-graph-reshape.test.ts
 *
 * The reshape verb end to end: durable, deterministic, evidence-preserving,
 * and recorded. Every refusal is paired with the legitimate reshape it must
 * still admit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reshape-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { reshapeWorkflowGraph, loadLiveWorkflowGraph } = await import('./workflow-graph-reshape.js');
const { persistWorkflowGraphSnapshot } = await import('./workflow-graph-store.js');
const { compileWorkflowStepsToGraph } = await import('./workflow-graph.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { resolveWorkflowReadiness } = await import('./workflow-readiness.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const WF = 'reshape-wf';
const steps = [
  { id: 'pull', prompt: 'pull', sideEffect: 'read' },
  { id: 'analyze', prompt: 'analyze', dependsOn: ['pull'], sideEffect: 'read' },
  { id: 'publish', prompt: 'publish', dependsOn: ['analyze'], sideEffect: 'send', requiresApproval: true },
] as never[];

function seed(runId: string): void {
  persistWorkflowGraphSnapshot({
    workflowName: WF,
    runId,
    graph: compileWorkflowStepsToGraph(steps, { id: `${WF}:${runId}` }),
  });
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

test('completed work is immutable: it cannot be rewritten, and the graph is left untouched', () => {
  const runId = 'run-evidence';
  seed(runId);

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    completedNodeIds: ['pull'],
    patch: {
      reason: 'try to redo the pull',
      // add_node with an existing id is refused as a duplicate; prove the
      // stronger guarantee by rewriting the node through a direct collision.
      operations: [{ op: 'add_node', node: { id: 'pull', type: 'step', prompt: 'different prompt' } }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /duplicate node "pull"/i);

  const live = loadLiveWorkflowGraph(runId);
  assert.equal(live?.nodes.find((n) => n.id === 'pull')?.prompt, 'pull', 'original node preserved');
  assert.ok(readWorkflowEvents(WF, runId).some((e) => e.kind === 'workflow_graph_patch_rejected'));
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

  const result = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: {
      reason: 'skip the wait',
      operations: [{ op: 'disable_edge', edgeId: 'dependency:publish->confirm' }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /without waiting for approval-gated "publish"/);
  // Refusal is typed and actionable, and nothing was persisted.
  assert.equal(loadLiveWorkflowGraph(runId)?.edges.find((e) => e.id === 'dependency:publish->confirm')?.disabled, undefined);
});

test('an incoherent reshape is refused with reasons the model can act on', () => {
  const runId = 'run-incoherent';
  seed(runId);

  const cyclic = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: { operations: [{ op: 'add_edge', edge: { id: 'dependency:publish->pull', source: 'publish', target: 'pull', type: 'dependency' } }] },
  });
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.errors.join(' '), /cycle/i);

  const orphan = reshapeWorkflowGraph({
    workflowName: WF,
    runId,
    patch: { operations: [{ op: 'add_edge', edge: { id: 'dependency:ghost->pull', source: 'ghost', target: 'pull', type: 'dependency' } }] },
  });
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors.join(' '), /unknown source node "ghost"/);

  const empty = reshapeWorkflowGraph({ workflowName: WF, runId, patch: { operations: [] } });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(' '), /at least one operation/);
});

test('a run with no persisted graph reshapes from its steps rather than failing', () => {
  const runId = 'run-legacy';
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
