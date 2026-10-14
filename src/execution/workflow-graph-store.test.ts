import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  compileWorkflowStepsToGraph,
  validateWorkflowGraph,
  validateWorkflowGraphAgainstAuthoredSteps,
} from './workflow-graph.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';
import {
  deleteWorkflowGraphSnapshotByRunId,
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
  WORKFLOW_GRAPH_SCHEMA_SQL,
} from './workflow-graph-store.js';

test('persistWorkflowGraphSnapshot stores graph, node, and edge rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
    const graph = compileWorkflowStepsToGraph([
      { id: 'pull', prompt: 'Pull data', sideEffect: 'read' },
      { id: 'draft', prompt: 'Draft summary', dependsOn: ['pull'], model: 'gpt-5.4-mini' },
    ], {
      id: 'workflow:run-1',
      name: 'Daily Brief',
      version: 1,
      metadata: { workflowSlug: 'daily-brief' },
    });

    const snapshotId = persistWorkflowGraphSnapshot({
      db,
      workflowName: 'daily-brief',
      runId: 'run-1',
      graph,
      now: new Date('2026-06-30T00:00:00.000Z'),
    });

    assert.equal(snapshotId, 'run-1:graph');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_graph_nodes WHERE graph_snapshot_id = ?').get(snapshotId) as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_graph_edges WHERE graph_snapshot_id = ?').get(snapshotId) as { n: number }).n, 1);

    const loaded = loadWorkflowGraphSnapshotByRunId('run-1', db);
    assert.equal(loaded?.workflowName, 'daily-brief');
    assert.equal(loaded?.validationOk, true);
    assert.deepEqual(loaded?.graph.entryNodeIds, ['pull']);
    assert.deepEqual(loaded?.graph.nodes.map((node) => node.id), ['pull', 'draft']);
  } finally {
    db.close();
  }
});

test('deleting a retained run removes its graph snapshot and child rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
    const graph = compileWorkflowStepsToGraph([
      { id: 'pull', prompt: 'Pull data', sideEffect: 'read' },
      { id: 'analyze', prompt: 'Analyze', dependsOn: ['pull'] },
    ]);
    persistWorkflowGraphSnapshot({
      db,
      workflowName: 'retained-workflow',
      runId: 'retained-run',
      graph,
    });

    assert.equal(deleteWorkflowGraphSnapshotByRunId('retained-run', db), true);
    assert.equal(loadWorkflowGraphSnapshotByRunId('retained-run', db), null);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_graph_nodes').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_graph_edges').get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});

test('persistWorkflowGraphSnapshot keeps distinct long-prefix fan-out edges', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
    const source = 'fetch_google_ads_performance_metrics';
    const graph = compileWorkflowStepsToGraph([
      { id: source, prompt: 'Fetch metrics', sideEffect: 'read' },
      { id: 'analyze_conversions', prompt: 'Analyze conversions', dependsOn: [source] },
      { id: 'analyze_spend', prompt: 'Analyze spend', dependsOn: [source] },
    ]);

    const snapshotId = persistWorkflowGraphSnapshot({
      db,
      workflowName: 'ads-manager',
      runId: 'long-prefix-fanout',
      graph,
    });

    const rows = db.prepare(`
      SELECT id, edge_id
      FROM workflow_graph_edges
      WHERE graph_snapshot_id = ?
      ORDER BY edge_id
    `).all(snapshotId) as Array<{ id: string; edge_id: string }>;
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2, 'row ids must be collision-resistant');
    assert.deepEqual(
      rows.map((row) => row.edge_id),
      [
        `dependency:${source}->analyze_conversions`,
        `dependency:${source}->analyze_spend`,
      ],
    );
  } finally {
    db.close();
  }
});

function authoredGraphPersistenceFixture() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authoredSteps: WorkflowStepInput[] = [
    { id: 'seed', prompt: '', sideEffect: 'read',
      transform: { version: 1, expression: { op: 'literal', value: [{ id: 'A', amount: 4 }] } },
      output: { type: 'array' } },
    { id: 'count', prompt: '', sideEffect: 'read', dependsOn: ['seed'],
      transform: { version: 1, expression: { op: 'count', value: { op: 'get', from: 'steps.seed.output' } } },
      output: { type: 'number' } },
  ];
  const graph = compileWorkflowStepsToGraph(authoredSteps, {
    id: 'controlled-authored-graph', name: 'Controlled authored graph', version: 1,
    metadata: { workflowSlug: 'controlled-authored-graph' },
  });
  assert.equal(validateWorkflowGraphAgainstAuthoredSteps(graph, authoredSteps).ok, true,
    'the source compiler output is valid only with its exact authored definition');
  return { db, authoredSteps, graph };
}

test('authored graph persistence records valid context without making the loaded graph an authority grant', () => {
  const { db, authoredSteps, graph } = authoredGraphPersistenceFixture();
  try {
    persistWorkflowGraphSnapshot({ db, workflowName: 'controlled-authored-graph', runId: 'authored-roundtrip',
      graph, ...{ authoredSteps } });
    const loaded = loadWorkflowGraphSnapshotByRunId('authored-roundtrip', db);
    assert.ok(loaded);
    assert.equal(JSON.stringify(loaded.graph.nodes), JSON.stringify(graph.nodes), 'all node bytes and node order survive persistence');
    assert.equal(JSON.stringify(loaded.graph.edges), JSON.stringify(graph.edges), 'all edge bytes and edge order survive persistence');
    assert.deepEqual(loaded.graph.entryNodeIds, graph.entryNodeIds);
    assert.equal(validateWorkflowGraphAgainstAuthoredSteps(loaded.graph, authoredSteps).ok, true);
    assert.equal(validateWorkflowGraph(loaded.graph).ok, false,
      'serialized IDs and transform bytes never substitute for the independently supplied authored context');
    assert.equal(loaded.validationOk, true, 'stored diagnostics use the same authored context as execution');
    assert.deepEqual(loaded.validationErrors, []);
  } finally { db.close(); }
});

test('authored graph persistence keeps omitted context on the strict generic validator', () => {
  const { db, graph } = authoredGraphPersistenceFixture();
  try {
    persistWorkflowGraphSnapshot({ db, workflowName: 'controlled-authored-graph', runId: 'authored-no-context', graph });
    const loaded = loadWorkflowGraphSnapshotByRunId('authored-no-context', db);
    assert.ok(loaded);
    assert.equal(loaded.validationOk, false);
    assert.match(loaded.validationErrors.join(' '), /not byte-identical authored transform semantics/);
    assert.equal(JSON.stringify(loaded.graph.nodes), JSON.stringify(graph.nodes));
  } finally { db.close(); }
});

test('authored graph persistence rejects changed transform semantics behind the same node IDs', () => {
  const { db, authoredSteps, graph } = authoredGraphPersistenceFixture();
  try {
    const altered = structuredClone(graph);
    altered.nodes[0]!.transform = { version: 1, expression: { op: 'literal', value: [{ id: 'OTHER', amount: 99 }] } };
    persistWorkflowGraphSnapshot({ db, workflowName: 'controlled-authored-graph', runId: 'authored-tampered',
      graph: altered, ...{ authoredSteps } });
    const loaded = loadWorkflowGraphSnapshotByRunId('authored-tampered', db);
    assert.ok(loaded);
    assert.equal(loaded.validationOk, false);
    assert.match(loaded.validationErrors.join(' '), /not byte-identical authored transform semantics/);
    assert.equal(validateWorkflowGraphAgainstAuthoredSteps(loaded.graph, authoredSteps).ok, false);
    assert.equal(JSON.stringify(loaded.graph.nodes), JSON.stringify(altered.nodes), 'invalid diagnostic snapshots are retained, not silently repaired');
  } finally { db.close(); }
});

test('authored graph persistence does not replace exact node bytes with order-insensitive equality', () => {
  const { db, authoredSteps, graph } = authoredGraphPersistenceFixture();
  try {
    const reordered = structuredClone(graph);
    reordered.nodes[0] = Object.fromEntries(Object.entries(reordered.nodes[0]!).reverse()) as typeof graph.nodes[number];
    assert.deepEqual(reordered.nodes[0], graph.nodes[0], 'the values are structurally equal');
    assert.notEqual(JSON.stringify(reordered.nodes[0]), JSON.stringify(graph.nodes[0]), 'the authored node byte ordering changed');
    persistWorkflowGraphSnapshot({ db, workflowName: 'controlled-authored-graph', runId: 'authored-reordered',
      graph: reordered, ...{ authoredSteps } });
    const loaded = loadWorkflowGraphSnapshotByRunId('authored-reordered', db);
    assert.ok(loaded);
    assert.equal(loaded.validationOk, false);
    assert.match(loaded.validationErrors.join(' '), /not byte-identical authored transform semantics/);
    assert.equal(validateWorkflowGraphAgainstAuthoredSteps(loaded.graph, authoredSteps).ok, false);
  } finally { db.close(); }
});

test('authored graph persistence cannot authorize an extra transform node from existing context', () => {
  const { db, authoredSteps, graph } = authoredGraphPersistenceFixture();
  try {
    const added = structuredClone(graph);
    added.nodes.push({ ...added.nodes[0]!, id: 'unadmitted', stepId: 'unadmitted', label: 'unadmitted' });
    persistWorkflowGraphSnapshot({ db, workflowName: 'controlled-authored-graph', runId: 'authored-extra-node',
      graph: added, ...{ authoredSteps } });
    const loaded = loadWorkflowGraphSnapshotByRunId('authored-extra-node', db);
    assert.ok(loaded);
    assert.equal(loaded.validationOk, false);
    assert.match(loaded.validationErrors.join(' '), /unadmitted.*not byte-identical authored transform semantics/);
    assert.equal(validateWorkflowGraphAgainstAuthoredSteps(loaded.graph, authoredSteps).ok, false);
    assert.equal(loaded.graph.nodes.length, graph.nodes.length + 1);
  } finally { db.close(); }
});
