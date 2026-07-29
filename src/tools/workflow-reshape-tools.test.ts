/** Run: npx tsx --test src/tools/workflow-reshape-tools.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGraphOperations } from './workflow-reshape-tools.js';

test('flat model-facing operations map to real graph operations', () => {
  const { operations, errors } = toGraphOperations([
    { op: 'add_node', node_id: 'analyze-b', label: 'second branch', prompt: 'analyze the rest', side_effect: 'read' },
    { op: 'add_edge', source: 'pull', target: 'analyze-b' },
    { op: 'disable_edge', edge_id: 'dependency:pull->analyze', reason: 'source rate-limited' },
    { op: 'enable_edge', edge_id: 'dependency:pull->analyze' },
  ] as never);
  assert.deepEqual(errors, []);
  assert.equal(operations.length, 4);

  const added = operations[0] as { op: 'add_node'; node: Record<string, unknown> };
  assert.equal(added.node.id, 'analyze-b');
  assert.equal(added.node.stepId, 'analyze-b', 'a node executes as its own step');
  assert.equal(added.node.type, 'step');
  assert.equal(added.node.sideEffect, 'read');

  const edge = operations[1] as { op: 'add_edge'; edge: { id: string; source: string; target: string } };
  assert.equal(edge.edge.id, 'dependency:pull->analyze-b', 'edge id matches the compiler convention');

  const disabled = operations[2] as { op: 'disable_edge'; edgeId: string; reason?: string };
  assert.equal(disabled.edgeId, 'dependency:pull->analyze');
  assert.equal(disabled.reason, 'source rate-limited');
});

test('incomplete operations are refused with the exact position and missing field', () => {
  const { operations, errors } = toGraphOperations([
    { op: 'add_node' },
    { op: 'add_edge', source: 'pull' },
    { op: 'disable_edge' },
  ] as never);
  assert.equal(operations.length, 0);
  assert.match(errors[0], /operation 1 \(add_node\): node_id is required/);
  assert.match(errors[1], /operation 2 \(add_edge\): source and target are required/);
  assert.match(errors[2], /operation 3 \(disable_edge\): edge_id is required/);
});

test('an ungated send node is carried through so the graph layer can refuse it', () => {
  // The tool never silently "fixes" a missing gate — the boundary rules own
  // that decision, and their refusal is what teaches the model.
  const { operations } = toGraphOperations([
    { op: 'add_node', node_id: 'publish-b', side_effect: 'send' },
  ] as never);
  const node = (operations[0] as { node: Record<string, unknown> }).node;
  assert.equal(node.sideEffect, 'send');
  assert.equal(node.requiresApproval, undefined);
});
