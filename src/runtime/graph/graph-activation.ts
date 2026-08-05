/**
 * Activation lifecycle helpers (E1) — the pieces of an admitted activation
 * that are pure functions of admission, journal, and injected state, kept
 * OUT of the executor so the walker stays a scheduler:
 *
 *   - the durable activation header (journal v4's version-in-the-stream);
 *   - proven patch-generation retirement, when an emitter loses reuse;
 *   - the post-cancellation outcome conversion (first-class `cancelled`).
 */
import { validDurableId } from './graph-journal.js';
import type { GraphAdmission } from './graph-admission.js';
import type { GraphJournalAdapter, NodeSettledEntry } from './graph-journal.js';
import type { ExecutableEdge, ExecutableGraph, ExecutableNode, NodeOutcome, NodeRunner } from './graph-executor.js';

export type PatchGenerations = Map<string, Array<{
  digest: string;
  nodes: ExecutableNode[];
  edges: ExecutableEdge[];
}>>;

/**
 * Append the activation opener. The schema version becomes DURABLE before any
 * claim; a forged admission version was already refused at the precondition.
 * Returns the halt reason on failure, undefined on success.
 */
export async function appendActivationHeader(
  admission: GraphAdmission,
  adapter: GraphJournalAdapter,
  activationId: string,
): Promise<string | undefined> {
  if (!validDurableId(activationId)) {
    return `activation id ${JSON.stringify(activationId)} is not a bounded printable identifier`;
  }
  try {
    await adapter.append({
      type: 'run_header',
      admissionDigest: admission.admissionDigest,
      journalSchemaVersion: admission.journalSchemaVersion,
      activationId,
    });
    return undefined;
  } catch (error) {
    return `journal append failed for the run header: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Collect and REMOVE an emitter's proven patch generations, recursively — a
 * retired worker that itself emitted retires its children too. The caller
 * subtracts the returned nodes/edges from the runnable topology: an old
 * emitted topology may not run under an input that never emitted it.
 */
export function retirePatchGenerations(
  generations: PatchGenerations,
  emitterId: string,
): Array<{ digest: string; nodeIds: Set<string>; edgeIds: Set<string> }> {
  const out: Array<{ digest: string; nodeIds: Set<string>; edgeIds: Set<string> }> = [];
  const owned = generations.get(emitterId) ?? [];
  generations.delete(emitterId);
  for (const generation of owned) {
    const nodeIds = new Set(generation.nodes.map((node) => node.id));
    out.push({
      digest: generation.digest,
      nodeIds,
      edgeIds: new Set(generation.edges.map((edge) => edge.id)),
    });
    for (const child of nodeIds) out.push(...retirePatchGenerations(generations, child));
  }
  return out;
}

/**
 * One edge's firing verdict from a live outcome. `success` fires on
 * completion; `failure` only on the node's OWN failure; any other label is
 * opaque — the runner judges, and silence means no.
 */
export function edgeFires(edge: ExecutableEdge, outcome: NodeOutcome, runner: NodeRunner): boolean {
  const when = edge.when ?? 'success';
  if (when === 'success') return outcome.status === 'completed';
  if (when === 'failure') {
    return outcome.status === 'failed' && (outcome.settlementClass ?? 'node') === 'node';
  }
  return runner.edgeSatisfied?.(edge, outcome) === true;
}

/**
 * The full edge verdict for a settling node, computed ONCE from the live
 * outcome. Non-routing statuses (blocked/paused/cancelled/infrastructure)
 * fire nothing, matching reconstruction's route agreement exactly.
 */
export function computeEdgeVerdict(
  working: ExecutableGraph,
  nodeId: string,
  outcome: NodeOutcome,
  runner: NodeRunner,
): string[] {
  const status = (outcome as { status: string }).status;
  const clazz = (outcome as { settlementClass?: string }).settlementClass ?? 'node';
  const routes = status === 'completed' || (status === 'failed' && clazz === 'node');
  if (!routes) return [];
  return working.edges
    .filter((edge) => !edge.disabled && edge.source === nodeId && edgeFires(edge, outcome, runner))
    .map((edge) => edge.id);
}

/**
 * Apply a reuse-refusal retirement to the live scheduling state: subtract
 * every retired generation's topology, drop its trusted settlements, and
 * un-apply its digests. Mutates the passed state on purpose — this IS the
 * executor's state, acted on in one place.
 */
export function applyGenerationRetirement(
  state: {
    working: { nodes: ExecutableNode[]; edges: ExecutableEdge[] };
    trusted: Map<string, NodeSettledEntry>;
    appliedPatchDigests: string[];
    patchesByEmitter: PatchGenerations;
  },
  emitterId: string,
): boolean {
  const retired = retirePatchGenerations(state.patchesByEmitter, emitterId);
  for (const generation of retired) {
    state.working.nodes = state.working.nodes.filter((candidate) => !generation.nodeIds.has(candidate.id));
    state.working.edges = state.working.edges.filter((candidate) => !generation.edgeIds.has(candidate.id));
    for (const node of generation.nodeIds) state.trusted.delete(node);
    const at = state.appliedPatchDigests.indexOf(generation.digest);
    if (at >= 0) state.appliedPatchDigests.splice(at, 1);
  }
  return retired.length > 0;
}
