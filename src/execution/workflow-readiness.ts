/**
 * One readiness answer for the whole workflow engine.
 *
 * Before this module the engine answered "what can run next?" twice: the
 * runner's `planWorkflowExecutionBatches` (topological batching over
 * `dependsOn`) decided execution, while the compiled graph — persisted per run
 * and rendered in the cockpit — only observed. Two implementations of one
 * question is how a graph becomes a photograph: patching it could never change
 * what actually ran.
 *
 * Readiness now comes from the graph, so the graph is the thing that decides.
 * `planWorkflowExecutionBatches` is retained as the pure reference
 * implementation and is exercised as the differential oracle in
 * workflow-readiness.test.ts — a stronger guarantee than deleting it, since any
 * future divergence fails a test instead of silently changing execution order.
 *
 * Structural validity is NOT this module's job. `validateWorkflowGraph` already
 * rejects unknown edge endpoints, self-edges, duplicates, and cycles at
 * admission, and it is strictly stricter than the planner's throw. A definition
 * that cannot progress therefore surfaces here as an explicit stall (with the
 * waiting set named) rather than as a thrown error from deep inside the loop.
 */
import {
  compileWorkflowStepsToGraph,
  getReadyWorkflowGraphNodes,
  type WorkflowGraphDefinition,
} from './workflow-graph.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

export interface WorkflowReadiness {
  /** Step ids whose dependencies are all satisfied and that are not blocked. */
  readyStepIds: string[];
  /**
   * True when work remains, nothing is ready, and nothing remaining is blocked
   * — i.e. the definition itself cannot progress (cycle or unreachable
   * dependency). Callers surface this instead of looping forever.
   */
  structurallyStalled: boolean;
  /** Human detail for a stall: which steps are waiting on what. */
  stalledDetail?: string;
}

/**
 * Resolve the next ready wave.
 *
 * `graph` is optional so callers that have no persisted snapshot (creation
 * tests, legacy runs) get identical semantics from an in-memory compile. Once
 * model-authored patches exist, passing the live patched graph is the only
 * change required for reshaping to take effect on execution.
 */
export function resolveWorkflowReadiness(
  steps: WorkflowStepInput[],
  completedStepIds: Iterable<string>,
  opts: {
    graph?: WorkflowGraphDefinition | null;
    blockedStepIds?: Iterable<string>;
  } = {},
): WorkflowReadiness {
  const completed = new Set(completedStepIds);
  const blocked = new Set(opts.blockedStepIds ?? []);
  const graph = opts.graph ?? compileWorkflowStepsToGraph(steps);

  const stepById = new Map(steps.map((step) => [step.id, step]));
  const ready = getReadyWorkflowGraphNodes(graph, completed, blocked)
    // A graph may carry nodes with no step counterpart once patches introduce
    // structural nodes; execution only dispatches real steps.
    .filter((node) => stepById.has(node.id))
    .map((node) => node.id);

  const remaining = steps.filter((step) => !completed.has(step.id) && !blocked.has(step.id));
  const structurallyStalled = ready.length === 0 && remaining.length > 0;

  return {
    readyStepIds: ready,
    structurallyStalled,
    stalledDetail: structurallyStalled ? describeStall(remaining, completed) : undefined,
  };
}

function describeStall(remaining: WorkflowStepInput[], completed: Set<string>): string {
  return remaining
    .map((step) => {
      const waiting = (step.dependsOn ?? []).filter((dep) => !completed.has(dep));
      return `${step.id} waits for ${waiting.join(', ') || '(unknown)'}`;
    })
    .join('; ');
}
