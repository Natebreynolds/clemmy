/**
 * The typed journal: what a durable graph run persists, and what a resume may
 * trust.
 *
 * The first executor slice journaled node IDs. A node-ID-only journal cannot
 * be production reuse identity — it says a name completed, not that THIS
 * admitted graph, THIS node definition, and THESE inputs completed, and it
 * cannot prove its own causal integrity after a crash. This module holds the
 * entry shape, the awaited adapter contract (the durable boundary), and the
 * resume validator that refuses a journal it cannot prove belongs to the run.
 *
 * Pure: types and validation only. Storage lives behind the adapter, injected
 * by the caller.
 */
import type { ExecutableEdge, ExecutableGraph, ExecutableNode, NodeStatus } from './graph-executor.js';
import type { GraphAdmission } from './graph-admission.js';

/** Why a non-completed settlement happened, for retry policy OUTSIDE the walker. */
export type SettlementClass =
  /** The node ran and its own logic failed — routes failure edges. */
  | 'node'
  /** The runner threw / infrastructure broke — never routes failure edges. */
  | 'infrastructure'
  /** Authority or policy refused the node before it could act. */
  | 'policy'
  /** The run's cancellation signal stopped it. */
  | 'cancelled';

export interface NodeStartedEntry {
  type: 'node_started';
  admissionDigest: string;
  nodeId: string;
  nodeDigest: string;
  inputDigest: string;
  /** Unique per dispatch — a retry is a NEW attempt, never a reused row. */
  attemptId: string;
  wave: number;
}

export interface NodeSettledEntry {
  type: 'node_settled';
  admissionDigest: string;
  nodeId: string;
  nodeDigest: string;
  inputDigest: string;
  attemptId: string;
  wave: number;
  status: NodeStatus;
  outputRef?: string;
  evidenceRefs?: string[];
  reason?: string;
  settlementClass?: SettlementClass;
}

export interface PatchAdmittedEntry {
  type: 'patch_admitted';
  admissionDigest: string;
  emittedBy: string;
  patchDigest: string;
  /** The FULL patch content — resume must be able to reconstruct the grown
   *  topology from the journal alone, and ids without definitions cannot. The
   *  digest lets replay refuse tampered content. */
  nodes: ExecutableNode[];
  edges: ExecutableEdge[];
}

export type GraphJournalEntry = NodeStartedEntry | NodeSettledEntry | PatchAdmittedEntry;

/**
 * The durable boundary. `append` RESOLVES only when the entry is durable —
 * the executor awaits it before dispatching a runner (`node_started`) and
 * before letting dependents advance (`node_settled`). An adapter that lies
 * about durability re-opens the crash window this contract exists to close.
 * A rejected append is an infrastructure halt, not a node failure.
 */
export interface GraphJournalAdapter {
  append(entry: GraphJournalEntry): Promise<void>;
}

export interface JournalResumeOk {
  ok: true;
  /** Node id → its settled completion entry, identity-verified. */
  completed: Map<string, NodeSettledEntry>;
  /** Patches previously admitted, in order, identity-verified. */
  patches: PatchAdmittedEntry[];
}

export interface JournalResumeRefusal {
  ok: false;
  errors: string[];
}

export type JournalResumeResult = JournalResumeOk | JournalResumeRefusal;

/**
 * Validate a journal for resume. Refuses rather than repairs:
 *
 *  - an entry stamped with a different admission digest is a different run;
 *  - a completed node the graph does not contain is a corrupt or stale journal
 *    (unless a validated patch in the same journal added it);
 *  - a completed set that is not causally closed — a node completed while a
 *    predecessor did not — cannot have happened under this executor, so the
 *    journal is not this run's history;
 *  - a `node_started` with no settlement is an interrupted attempt: legal,
 *    surfaced as neither completed nor trusted.
 *
 * Only `completed` settlements grant reuse. A failed/blocked/paused settlement
 * is history, not a result.
 */
export function validateJournalForResume(
  graph: ExecutableGraph,
  admission: GraphAdmission,
  entries: readonly GraphJournalEntry[],
): JournalResumeResult {
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const patches: PatchAdmittedEntry[] = [];
  const completed = new Map<string, NodeSettledEntry>();

  for (const entry of entries) {
    if (entry.admissionDigest !== admission.admissionDigest) {
      errors.push(`entry for "${'nodeId' in entry ? entry.nodeId : entry.emittedBy}" carries admission ${entry.admissionDigest.slice(0, 12)}…, expected ${admission.admissionDigest.slice(0, 12)}…`);
      continue;
    }
    if (entry.type === 'patch_admitted') {
      for (const added of entry.nodes) nodeIds.add(added.id);
      patches.push(entry);
      continue;
    }
    if (entry.type === 'node_settled' && entry.status === 'completed') {
      if (!nodeIds.has(entry.nodeId)) {
        errors.push(`journal completes "${entry.nodeId}", which the admitted graph does not contain`);
        continue;
      }
      completed.set(entry.nodeId, entry);
    }
  }

  // Causal closure over the admitted edges: a completed node's every enabled
  // incoming edge source must itself be settled in this journal. (Patch-added
  // edges are re-validated when the patch replays; structural closure over the
  // base graph is the invariant a crash cannot be allowed to fake.)
  for (const [nodeId] of completed) {
    const incoming = graph.edges.filter((edge) => !edge.disabled && edge.target === nodeId);
    for (const edge of incoming) {
      if (!completed.has(edge.source)) {
        // A failure-routed completion is legal: the source settled without
        // completing. The journal must still contain SOME settlement for it.
        const sourceSettled = entries.some((entry) =>
          entry.type === 'node_settled'
          && entry.admissionDigest === admission.admissionDigest
          && entry.nodeId === edge.source);
        if (!sourceSettled) {
          errors.push(`"${nodeId}" completed but its predecessor "${edge.source}" has no settlement — the journal is not causally closed`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, completed, patches };
}
