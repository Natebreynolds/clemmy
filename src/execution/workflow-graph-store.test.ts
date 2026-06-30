import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { compileWorkflowStepsToGraph } from './workflow-graph.js';
import {
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
