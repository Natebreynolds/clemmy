/**
 * Run: npx tsx --test src/execution/workflow-graph-boundaries.test.ts
 *
 * ALWAYS-ON INVARIANT with a positive control. A gate that refuses everything
 * is not a gate, it is an outage — so every refusal case here is paired with a
 * legitimate reshape that must still be admitted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { irreversibleBoundaries, irreversibleBoundaryViolations } from './workflow-graph-boundaries.js';
import { applyWorkflowGraphPatch, type WorkflowGraphDefinition } from './workflow-graph.js';

/** research → publish(send, gated) → confirm, with a second safe route into
 *  confirm so a bypass is structurally possible if nothing prevents it. */
function graph(): WorkflowGraphDefinition {
  return {
    id: 'wf:boundaries',
    nodes: [
      { id: 'research', type: 'step', sideEffect: 'read' },
      { id: 'draft', type: 'step', sideEffect: 'read' },
      { id: 'publish', type: 'step', sideEffect: 'send', requiresApproval: true },
      { id: 'confirm', type: 'step', sideEffect: 'read' },
    ],
    edges: [
      { id: 'dependency:research->draft', source: 'research', target: 'draft', type: 'dependency' },
      { id: 'dependency:draft->publish', source: 'draft', target: 'publish', type: 'dependency' },
      { id: 'dependency:publish->confirm', source: 'publish', target: 'confirm', type: 'dependency' },
      { id: 'dependency:draft->confirm', source: 'draft', target: 'confirm', type: 'dependency' },
    ],
    entryNodeIds: ['research'],
  };
}

test('irreversible boundaries are visible before anything is planned across them', () => {
  const boundaries = irreversibleBoundaries(graph());
  assert.deepEqual(boundaries, [{ nodeId: 'publish', sideEffect: 'send', gated: true }]);
  // Read-only work is never a one-way door.
  assert.equal(boundaries.some((b) => b.nodeId === 'research'), false);
});

test('POSITIVE CONTROL: legitimate reshapes around a gated send are still admitted', () => {
  const base = graph();

  // Adding a parallel research branch touches no boundary.
  const widened = applyWorkflowGraphPatch(base, {
    operations: [
      { op: 'add_node', node: { id: 'research-b', type: 'step', sideEffect: 'read' } },
      { op: 'add_edge', edge: { id: 'dependency:research->research-b', source: 'research', target: 'research-b', type: 'dependency' } },
    ],
    reason: 'split research',
  });
  assert.equal(widened.ok, true, widened.errors.join('; '));

  // A NEW send node is fine when it carries its own gate.
  const gatedSend = applyWorkflowGraphPatch(base, {
    operations: [
      { op: 'add_node', node: { id: 'publish-b', type: 'step', sideEffect: 'send', requiresApproval: true } },
      { op: 'add_edge', edge: { id: 'dependency:draft->publish-b', source: 'draft', target: 'publish-b', type: 'dependency' } },
    ],
    reason: 'second channel, still gated',
  });
  assert.equal(gatedSend.ok, true, gatedSend.errors.join('; '));

  // Disabling a gated node's ONLY route withholds its target (work stops) —
  // that is not a bypass and must remain allowed.
  const withheld = applyWorkflowGraphPatch(base, {
    operations: [
      { op: 'disable_edge', edgeId: 'dependency:draft->confirm' },
      { op: 'disable_edge', edgeId: 'dependency:publish->confirm', reason: 'hold the confirmation' },
    ],
  });
  assert.equal(withheld.ok, true, withheld.errors.join('; '));
});

test('REFUSED: a reshape may not route around an approval-gated send', () => {
  // 'confirm' also depends on 'draft'. Disabling publish→confirm would let
  // confirm run the moment draft finishes — skipping the approval entirely.
  const bypass = applyWorkflowGraphPatch(graph(), {
    operations: [{ op: 'disable_edge', edgeId: 'dependency:publish->confirm', reason: 'speed things up' }],
  });
  assert.equal(bypass.ok, false);
  assert.match(bypass.errors.join(' '), /without waiting for approval-gated "publish"/);
  // The refusal returns the ORIGINAL graph untouched.
  assert.deepEqual(bypass.graph.edges.find((e) => e.id === 'dependency:publish->confirm')?.disabled, undefined);
});

test('REFUSED: an ungated send cannot join a running graph, and a gate cannot be removed', () => {
  const ungated = applyWorkflowGraphPatch(graph(), {
    operations: [
      { op: 'add_node', node: { id: 'publish-c', type: 'step', sideEffect: 'send' } },
      { op: 'add_edge', edge: { id: 'dependency:draft->publish-c', source: 'draft', target: 'publish-c', type: 'dependency' } },
    ],
  });
  assert.equal(ungated.ok, false);
  assert.match(ungated.errors.join(' '), /must declare requiresApproval/);

  // Removing an existing gate by replacing the node in place.
  const before = graph();
  const after = graph();
  after.nodes = after.nodes.map((n) => (n.id === 'publish' ? { ...n, requiresApproval: false } : n));
  const violations = irreversibleBoundaryViolations(before, after);
  assert.match(violations.join(' '), /Approval gate on "publish" cannot be removed/);

  // Deleting the gated node outright is equally refused.
  const removed = graph();
  removed.nodes = removed.nodes.filter((n) => n.id !== 'publish');
  assert.match(irreversibleBoundaryViolations(before, removed).join(' '), /cannot be removed from a running graph/);
});

test('write-class effects are boundaries too, and ungated writes stay allowed for now', () => {
  const withWrite: WorkflowGraphDefinition = {
    nodes: [
      { id: 'pull', type: 'step', sideEffect: 'read' },
      { id: 'upsert', type: 'step', sideEffect: 'write' },
    ],
    edges: [{ id: 'dependency:pull->upsert', source: 'pull', target: 'upsert', type: 'dependency' }],
  };
  const boundaries = irreversibleBoundaries(withWrite);
  assert.deepEqual(boundaries, [{ nodeId: 'upsert', sideEffect: 'write', gated: false }]);
  // A write with no declared gate is visible as a boundary but not refused —
  // the runtime write ledger governs it. Only sends require a declarative gate.
  const added = applyWorkflowGraphPatch(withWrite, {
    operations: [{ op: 'add_node', node: { id: 'upsert-b', type: 'step', sideEffect: 'write' } }],
  });
  assert.equal(added.ok, true, added.errors.join('; '));
});
