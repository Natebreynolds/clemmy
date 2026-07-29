/**
 * The verb: a running graph the model can reshape.
 *
 * Everything underneath already existed — a validated node/edge model, patch
 * application, a durable per-run snapshot, and three lifecycle event kinds that
 * had never been emitted. What was missing was a caller. This module is that
 * caller, and it is deliberately the ONLY path that mutates a live graph, so
 * every reshape is validated, boundary-checked, persisted, and recorded the
 * same way.
 *
 * Validation is deterministic end to end. No judge decides whether a reshape is
 * reasonable: the graph validator rejects malformed structure, the boundary
 * rules refuse anything that routes around a one-way door, and completed work
 * is immutable. A refusal returns typed reasons to the model precisely so a
 * rejected patch becomes a correction it can act on rather than a dead end.
 */
import { appendWorkflowEvent } from './workflow-events.js';
import {
  applyWorkflowGraphPatch,
  compileWorkflowStepsToGraph,
  type WorkflowGraphDefinition,
  type WorkflowGraphPatch,
} from './workflow-graph.js';
import {
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
} from './workflow-graph-store.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

export interface ReshapeWorkflowGraphInput {
  workflowName: string;
  runId: string;
  patch: WorkflowGraphPatch;
  /** Nodes with recorded completions — their structure is immutable. */
  completedNodeIds?: Iterable<string>;
  /** Fallback definition when a run predates graph persistence. */
  steps?: WorkflowStepInput[];
}

export interface ReshapeWorkflowGraphResult {
  ok: boolean;
  graph: WorkflowGraphDefinition | null;
  errors: string[];
  warnings: string[];
  /** Ops actually applied, for the human-facing reshape feed. */
  appliedOperations: number;
}

/** Completed work is evidence. A reshape may redirect what happens NEXT; it may
 *  never edit or vanish a node whose result is already recorded. */
function completedWorkViolations(
  before: WorkflowGraphDefinition,
  after: WorkflowGraphDefinition,
  completedNodeIds: Set<string>,
): string[] {
  if (completedNodeIds.size === 0) return [];
  const violations: string[] = [];
  const beforeById = new Map((before.nodes ?? []).map((node) => [node.id, node]));
  const afterById = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  for (const nodeId of completedNodeIds) {
    if (!beforeById.has(nodeId)) continue;
    const next = afterById.get(nodeId);
    if (!next) {
      violations.push(`Completed node "${nodeId}" cannot be removed — its result is already recorded.`);
      continue;
    }
    if (JSON.stringify(next) !== JSON.stringify(beforeById.get(nodeId))) {
      violations.push(`Completed node "${nodeId}" cannot be rewritten — reshape what happens next instead.`);
    }
  }
  return violations;
}

export function reshapeWorkflowGraph(input: ReshapeWorkflowGraphInput): ReshapeWorkflowGraphResult {
  const { workflowName, runId, patch } = input;
  const operations = patch.operations ?? [];
  const completed = new Set(input.completedNodeIds ?? []);

  const record = (kind: 'workflow_graph_patch_proposed' | 'workflow_graph_patch_applied' | 'workflow_graph_patch_rejected', meta: Record<string, unknown>) => {
    try {
      appendWorkflowEvent(workflowName, runId, {
        kind,
        meta: {
          reason: patch.reason,
          proposedByNodeId: patch.proposedByNodeId,
          operationCount: operations.length,
          ...meta,
        },
      });
    } catch { /* telemetry is best-effort; never block a reshape decision */ }
  };

  const fail = (errors: string[], warnings: string[] = []): ReshapeWorkflowGraphResult => {
    record('workflow_graph_patch_rejected', { errors });
    return { ok: false, graph: null, errors, warnings, appliedOperations: 0 };
  };

  record('workflow_graph_patch_proposed', {
    operations: operations.map((op) => op.op),
  });

  if (operations.length === 0) {
    return fail(['A reshape needs at least one operation.']);
  }

  const snapshot = loadWorkflowGraphSnapshotByRunId(runId);
  const current = snapshot?.graph
    ?? (input.steps ? compileWorkflowStepsToGraph(input.steps, { id: `${workflowName}:${runId}` }) : null);
  if (!current) {
    return fail([`No graph is available for run "${runId}", so it cannot be reshaped.`]);
  }

  // Structure + one-way doors are enforced inside apply.
  const applied = applyWorkflowGraphPatch(current, patch);
  if (!applied.ok) return fail(applied.errors, applied.warnings);

  const evidenceViolations = completedWorkViolations(current, applied.graph, completed);
  if (evidenceViolations.length > 0) return fail(evidenceViolations, applied.warnings);

  try {
    persistWorkflowGraphSnapshot({ workflowName, runId, graph: applied.graph });
  } catch (error) {
    return fail([`The reshape validated but could not be saved: ${error instanceof Error ? error.message : String(error)}`]);
  }

  record('workflow_graph_patch_applied', {
    operations: operations.map((op) => op.op),
    nodeCount: applied.graph.nodes.length,
    edgeCount: applied.graph.edges.length,
    warnings: applied.warnings,
  });

  return {
    ok: true,
    graph: applied.graph,
    errors: [],
    warnings: applied.warnings,
    appliedOperations: operations.length,
  };
}

/** The live graph a run should execute from, or null when it predates
 *  persistence (callers then compile from steps as before). */
export function loadLiveWorkflowGraph(runId: string): WorkflowGraphDefinition | null {
  try {
    return loadWorkflowGraphSnapshotByRunId(runId)?.graph ?? null;
  } catch {
    return null;
  }
}
