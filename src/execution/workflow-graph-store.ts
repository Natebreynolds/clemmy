import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import {
  validateWorkflowGraph,
  type WorkflowGraphDefinition,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from './workflow-graph.js';

export const WORKFLOW_GRAPH_STATE_DIR = path.join(BASE_DIR, 'state');
export const WORKFLOW_GRAPH_DB_PATH = path.join(WORKFLOW_GRAPH_STATE_DIR, 'workflow-graphs.db');

export const WORKFLOW_GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_graphs (
  id                       TEXT PRIMARY KEY,
  workflow_name            TEXT NOT NULL,
  run_id                   TEXT NOT NULL UNIQUE,
  graph_id                 TEXT,
  graph_version            INTEGER,
  created_at               TEXT NOT NULL,
  validation_ok            INTEGER NOT NULL CHECK (validation_ok IN (0,1)),
  validation_errors_json   TEXT NOT NULL DEFAULT '[]',
  validation_warnings_json TEXT NOT NULL DEFAULT '[]',
  entry_node_ids_json      TEXT NOT NULL DEFAULT '[]',
  metadata_json            TEXT NOT NULL DEFAULT '{}',
  graph_json               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_graphs_workflow_created
  ON workflow_graphs(workflow_name, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_graph_nodes (
  id                  TEXT PRIMARY KEY,
  graph_snapshot_id   TEXT NOT NULL REFERENCES workflow_graphs(id) ON DELETE CASCADE,
  node_id             TEXT NOT NULL,
  node_type           TEXT NOT NULL,
  step_id             TEXT,
  label               TEXT,
  model               TEXT,
  intent              TEXT,
  side_effect         TEXT,
  requires_approval   INTEGER CHECK (requires_approval IN (0,1)),
  retry_budget        INTEGER,
  config_json         TEXT NOT NULL DEFAULT '{}',
  UNIQUE(graph_snapshot_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_graph_nodes_snapshot_type
  ON workflow_graph_nodes(graph_snapshot_id, node_type);

CREATE TABLE IF NOT EXISTS workflow_graph_edges (
  id                  TEXT PRIMARY KEY,
  graph_snapshot_id   TEXT NOT NULL REFERENCES workflow_graphs(id) ON DELETE CASCADE,
  edge_id             TEXT NOT NULL,
  source_node_id      TEXT NOT NULL,
  target_node_id      TEXT NOT NULL,
  edge_type           TEXT NOT NULL,
  condition_json      TEXT,
  priority            INTEGER,
  disabled            INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  UNIQUE(graph_snapshot_id, edge_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_graph_edges_snapshot_source
  ON workflow_graph_edges(graph_snapshot_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_workflow_graph_edges_snapshot_target
  ON workflow_graph_edges(graph_snapshot_id, target_node_id);

CREATE TABLE IF NOT EXISTS workflow_graph_patches (
  id                  TEXT PRIMARY KEY,
  graph_snapshot_id   TEXT NOT NULL REFERENCES workflow_graphs(id) ON DELETE CASCADE,
  proposed_by_node_id TEXT,
  status              TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected')),
  reason              TEXT,
  operations_json     TEXT NOT NULL DEFAULT '[]',
  errors_json         TEXT NOT NULL DEFAULT '[]',
  warnings_json       TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_graph_patches_snapshot_created
  ON workflow_graph_patches(graph_snapshot_id, created_at DESC);
`;

export interface PersistWorkflowGraphSnapshotInput {
  workflowName: string;
  runId: string;
  graph: WorkflowGraphDefinition;
  snapshotId?: string;
  now?: Date;
  db?: Database.Database;
}

export interface WorkflowGraphSnapshot {
  id: string;
  workflowName: string;
  runId: string;
  createdAt: string;
  validationOk: boolean;
  validationErrors: string[];
  validationWarnings: string[];
  graph: WorkflowGraphDefinition;
}

let cachedDb: Database.Database | null = null;

export function openWorkflowGraphDb(): Database.Database {
  if (cachedDb) return cachedDb;
  ensureStateDir();
  const db = new Database(WORKFLOW_GRAPH_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
  cachedDb = db;
  return db;
}

export function closeWorkflowGraphDb(): void {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
}

/** Test-only reset. Graph snapshots are rebuildable from workflow run events. */
export function resetWorkflowGraphDbForTest(): void {
  closeWorkflowGraphDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = WORKFLOW_GRAPH_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

export function persistWorkflowGraphSnapshot(input: PersistWorkflowGraphSnapshotInput): string {
  const db = input.db ?? openWorkflowGraphDb();
  db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
  const validation = validateWorkflowGraph(input.graph);
  const snapshotId = input.snapshotId ?? `${input.runId}:graph`;
  const createdAt = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO workflow_graphs (
        id, workflow_name, run_id, graph_id, graph_version, created_at,
        validation_ok, validation_errors_json, validation_warnings_json,
        entry_node_ids_json, metadata_json, graph_json
      ) VALUES (
        @id, @workflowName, @runId, @graphId, @graphVersion, @createdAt,
        @validationOk, @validationErrorsJson, @validationWarningsJson,
        @entryNodeIdsJson, @metadataJson, @graphJson
      )
    `).run({
      id: snapshotId,
      workflowName: input.workflowName,
      runId: input.runId,
      graphId: input.graph.id ?? null,
      graphVersion: input.graph.version ?? null,
      createdAt,
      validationOk: validation.ok ? 1 : 0,
      validationErrorsJson: JSON.stringify(validation.errors),
      validationWarningsJson: JSON.stringify(validation.warnings),
      entryNodeIdsJson: JSON.stringify(validation.entryNodeIds),
      metadataJson: JSON.stringify(input.graph.metadata ?? {}),
      graphJson: JSON.stringify(input.graph),
    });
    insertGraphNodes(db, snapshotId, input.graph.nodes);
    insertGraphEdges(db, snapshotId, input.graph.edges);
  });
  tx();
  return snapshotId;
}

export function loadWorkflowGraphSnapshotByRunId(
  runId: string,
  db: Database.Database = openWorkflowGraphDb(),
): WorkflowGraphSnapshot | null {
  db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
  const row = db.prepare(`
    SELECT *
    FROM workflow_graphs
    WHERE run_id = ?
  `).get(runId) as WorkflowGraphRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

function insertGraphNodes(db: Database.Database, snapshotId: string, nodes: WorkflowGraphNode[]): void {
  const insert = db.prepare(`
    INSERT INTO workflow_graph_nodes (
      id, graph_snapshot_id, node_id, node_type, step_id, label, model, intent,
      side_effect, requires_approval, retry_budget, config_json
    ) VALUES (
      @id, @graphSnapshotId, @nodeId, @nodeType, @stepId, @label, @model, @intent,
      @sideEffect, @requiresApproval, @retryBudget, @configJson
    )
  `);
  for (const node of nodes) {
    insert.run({
      id: `${snapshotId}:node:${node.id}`,
      graphSnapshotId: snapshotId,
      nodeId: node.id,
      nodeType: node.type,
      stepId: node.stepId ?? null,
      label: node.label ?? null,
      model: node.model ?? null,
      intent: node.intent ?? null,
      sideEffect: node.sideEffect ?? null,
      requiresApproval: node.requiresApproval === undefined ? null : node.requiresApproval ? 1 : 0,
      retryBudget: node.retryBudget ?? null,
      configJson: JSON.stringify(node.config ?? {}),
    });
  }
}

function insertGraphEdges(db: Database.Database, snapshotId: string, edges: WorkflowGraphEdge[]): void {
  const insert = db.prepare(`
    INSERT INTO workflow_graph_edges (
      id, graph_snapshot_id, edge_id, source_node_id, target_node_id, edge_type,
      condition_json, priority, disabled
    ) VALUES (
      @id, @graphSnapshotId, @edgeId, @sourceNodeId, @targetNodeId, @edgeType,
      @conditionJson, @priority, @disabled
    )
  `);
  for (const edge of edges) {
    insert.run({
      id: `${snapshotId}:edge:${hashEdgeId(edge.id)}`,
      graphSnapshotId: snapshotId,
      edgeId: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      edgeType: edge.type,
      conditionJson: edge.condition ? JSON.stringify(edge.condition) : null,
      priority: edge.priority ?? null,
      disabled: edge.disabled ? 1 : 0,
    });
  }
}

interface WorkflowGraphRow {
  id: string;
  workflow_name: string;
  run_id: string;
  created_at: string;
  validation_ok: number;
  validation_errors_json: string;
  validation_warnings_json: string;
  graph_json: string;
}

function rowToSnapshot(row: WorkflowGraphRow): WorkflowGraphSnapshot {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    runId: row.run_id,
    createdAt: row.created_at,
    validationOk: row.validation_ok === 1,
    validationErrors: parseJsonArray(row.validation_errors_json),
    validationWarnings: parseJsonArray(row.validation_warnings_json),
    graph: parseGraph(row.graph_json),
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseGraph(value: string): WorkflowGraphDefinition {
  try {
    const parsed = JSON.parse(value) as WorkflowGraphDefinition;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      id: parsed.id,
      name: parsed.name,
      version: parsed.version,
      entryNodeIds: parsed.entryNodeIds,
      metadata: parsed.metadata,
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function ensureStateDir(): void {
  if (!existsSync(WORKFLOW_GRAPH_STATE_DIR)) mkdirSync(WORKFLOW_GRAPH_STATE_DIR, { recursive: true });
}

function hashEdgeId(edgeId: string): string {
  return Buffer.from(edgeId).toString('base64url').slice(0, 48) || randomUUID();
}
