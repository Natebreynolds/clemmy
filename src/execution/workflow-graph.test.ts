import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWorkflowGraphBranchDecision,
  applyWorkflowGraphPatch,
  compileWorkflowStepsToGraph,
  getReadyWorkflowGraphNodes,
  validateWorkflowGraph,
  workflowGraphEdgeId,
  type WorkflowGraphDefinition,
} from './workflow-graph.js';

test('compileWorkflowStepsToGraph preserves step metadata and dependency edges', () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'pull', prompt: 'Pull records.', sideEffect: 'read', output: { type: 'array', non_empty: [''] } },
    {
      id: 'send',
      prompt: 'Send approved drafts.',
      dependsOn: ['pull'],
      sideEffect: 'send',
      requiresApproval: true,
      intent: 'outreach',
      retryBudget: 1,
    },
  ], { name: 'outreach', version: 3 });

  assert.equal(graph.name, 'outreach');
  assert.equal(graph.version, 3);
  assert.deepEqual(graph.entryNodeIds, ['pull']);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes.find((node) => node.id === 'send')?.sideEffect, 'send');
  assert.equal(graph.nodes.find((node) => node.id === 'send')?.requiresApproval, true);
  assert.deepEqual(graph.edges, [
    { id: 'dependency:pull->send', source: 'pull', target: 'send', type: 'dependency' },
  ]);
});

test('validateWorkflowGraph catches dangling edges and cycles', () => {
  const dangling = validateWorkflowGraph({
    nodes: [{ id: 'a', type: 'step' }],
    edges: [{ id: 'dependency:ghost->a', source: 'ghost', target: 'a', type: 'dependency' }],
  });
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((error) => error.includes('unknown source')));

  const cyclic = validateWorkflowGraph({
    nodes: [{ id: 'a', type: 'step' }, { id: 'b', type: 'step' }],
    edges: [
      { id: workflowGraphEdgeId('a', 'b'), source: 'a', target: 'b', type: 'dependency' },
      { id: workflowGraphEdgeId('b', 'a'), source: 'b', target: 'a', type: 'dependency' },
    ],
  });
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.hasCycles);
});

test('condition edges must carry explicit conditions', () => {
  const graph: WorkflowGraphDefinition = {
    nodes: [
      { id: 'decide', type: 'condition' },
      { id: 'yes', type: 'step' },
      { id: 'no', type: 'step' },
    ],
    edges: [
      { id: 'condition:decide->yes', source: 'decide', target: 'yes', type: 'condition', condition: { equals: 'yes' } },
      { id: 'condition:decide->no', source: 'decide', target: 'no', type: 'condition' },
    ],
  };

  const result = validateWorkflowGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('must declare a condition')));
});

test('getReadyWorkflowGraphNodes returns nodes whose enabled incoming edges are complete', () => {
  const graph = compileWorkflowStepsToGraph([
    { id: 'a', prompt: 'A' },
    { id: 'b', prompt: 'B', dependsOn: ['a'] },
    { id: 'c', prompt: 'C', dependsOn: ['b'] },
  ]);

  assert.deepEqual(getReadyWorkflowGraphNodes(graph, []).map((node) => node.id), ['a']);
  assert.deepEqual(getReadyWorkflowGraphNodes(graph, ['a']).map((node) => node.id), ['b']);
  assert.deepEqual(getReadyWorkflowGraphNodes(graph, ['a', 'b']).map((node) => node.id), ['c']);
  assert.deepEqual(getReadyWorkflowGraphNodes(graph, ['a', 'b'], ['c']).map((node) => node.id), []);
});

test('applyWorkflowGraphPatch adds validated nodes and edges atomically', () => {
  const graph = compileWorkflowStepsToGraph([{ id: 'a', prompt: 'A' }]);
  const patched = applyWorkflowGraphPatch(graph, {
    reason: 'planner added follow-up',
    operations: [
      { op: 'add_node', node: { id: 'b', type: 'step', prompt: 'B' } },
      { op: 'add_edge', edge: { id: workflowGraphEdgeId('a', 'b'), source: 'a', target: 'b', type: 'dependency' } },
    ],
  });

  assert.equal(patched.ok, true);
  assert.deepEqual(patched.graph.nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(patched.graph.entryNodeIds, ['a']);

  const invalid = applyWorkflowGraphPatch(graph, {
    operations: [
      { op: 'add_node', node: { id: 'b', type: 'step', prompt: 'B' } },
      { op: 'add_edge', edge: { id: 'bad', source: 'b', target: 'ghost', type: 'dependency' } },
    ],
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.graph, graph, 'invalid patch leaves original graph unchanged');
});

test('applyWorkflowGraphBranchDecision disables unselected condition edges', () => {
  const graph: WorkflowGraphDefinition = {
    nodes: [
      { id: 'decide', type: 'condition' },
      { id: 'send', type: 'step' },
      { id: 'skip', type: 'step' },
    ],
    edges: [
      { id: 'condition:decide->send', source: 'decide', target: 'send', type: 'condition', condition: { route: 'send' } },
      { id: 'condition:decide->skip', source: 'decide', target: 'skip', type: 'condition', condition: { route: 'skip' } },
    ],
  };

  const result = applyWorkflowGraphBranchDecision(graph, 'decide', ['condition:decide->send']);
  assert.equal(result.ok, true);
  assert.equal(result.graph.edges.find((edge) => edge.target === 'send')?.disabled, undefined);
  assert.equal(result.graph.edges.find((edge) => edge.target === 'skip')?.disabled, true);
  assert.deepEqual(getReadyWorkflowGraphNodes(result.graph, ['decide']).map((node) => node.id), ['send']);
});
