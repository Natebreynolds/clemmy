/**
 * Ordered journal reconstruction: what a resumed admitted run may trust.
 *
 * A restart must never reuse stale evidence, re-evaluate an old conditional
 * with today's closure, crash while reconstructing topology, or trust a
 * settlement that has no exact durable start. This module replays the journal
 * IN ORDER against the topology that existed at each entry's position and
 * refuses — with a precise, typed reason — any history the executor could not
 * have produced. It repairs nothing: malformed history is not this run's
 * history.
 *
 * Deliberately pure. It imports types and the pure patch validator only — no
 * provider, tool, memory, filesystem, environment, UI, wall clock, or mutable
 * global. In particular it never consults the executor's LIVE temporal state
 * (the predecessor crashed exactly there) and never runs a present-day
 * edge-satisfaction closure to decide what fired previously: durable
 * `firedEdgeIds` are the routing history.
 *
 * What reconstruction hands back is evidence, not scheduling: the reconstructed
 * topology, the latest trusted settlement per node, and the patch ledger.
 * Whether a trusted settlement is actually REUSED is decided by the executor at
 * readiness, when the node's current input digest is known — input-bound reuse
 * cannot be decided from the journal alone, because it depends on what this
 * run's predecessors actually produce.
 */
import { validateGraphPatch } from './graph-admission.js';
import type { GraphAdmission } from './graph-admission.js';
import type {
  GraphJournalEntry,
  NodeSettledEntry,
  NodeStartedEntry,
  PatchAdmittedEntry,
} from './graph-journal.js';
import type { ExecutableEdge, ExecutableGraph, ExecutableNode } from './graph-executor.js';

export interface ResumeReconstruction {
  ok: true;
  /** The admitted topology grown by every REAL (non-orphan) journaled patch. */
  nodes: ExecutableNode[];
  edges: ExecutableEdge[];
  /**
   * Latest trusted settlement per node: `completed`, or `failed` with
   * settlement class `node`. Trusted means the history is exact — start and
   * settlement pair, routing verdicts validated. It does NOT mean reusable:
   * the executor compares node and input digests at readiness.
   */
  trusted: Map<string, NodeSettledEntry>;
  /** Digests of patches applied to the reconstructed topology, in order. */
  appliedPatchDigests: string[];
  /** Every patch digest the journal contains, applied or orphaned — the
   *  executor must not journal these again on re-emission. */
  journaledPatchDigests: Set<string>;
  /**
   * Emitter node → digest for a patch whose emitter attempt never reached a
   * durable completed settlement. Its topology is NOT part of the resumed
   * graph; the re-run emitter must reproduce this digest or refuse. It may
   * not create two child graphs.
   */
  orphanPatchByEmitter: Map<string, string>;
}

export interface ResumeRefusal {
  ok: false;
  errors: string[];
}

export type ResumeReconstructionResult = ResumeReconstruction | ResumeRefusal;

interface PatchRecord {
  entry: PatchAdmittedEntry;
  index: number;
  addedNodeIds: Set<string>;
  addedEdgeIds: Set<string>;
}

function describeEntry(entry: GraphJournalEntry): string {
  if (entry.type === 'patch_admitted') return `patch from "${entry.emittedBy}"`;
  return `${entry.type === 'node_started' ? 'start' : 'settlement'} of "${entry.nodeId}" (attempt ${entry.attemptId})`;
}

export function reconstructAdmittedResume(
  graph: ExecutableGraph,
  admission: GraphAdmission,
  entries: readonly GraphJournalEntry[],
): ResumeReconstructionResult {
  const errors: string[] = [];

  // Topology AS OF the current journal position. Patches grow it; fired-edge
  // and node-existence validation always run against what existed THEN.
  const nodes: ExecutableNode[] = [...graph.nodes];
  const edges: ExecutableEdge[] = [...graph.edges];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  const starts = new Map<string, { entry: NodeStartedEntry; index: number }>();
  const settledAttempts = new Set<string>();
  const settledNodes = new Set<string>();
  const latestTrusted = new Map<string, { entry: NodeSettledEntry; index: number }>();
  /** Every edge any settlement ever fired — the durable routing history. */
  const allFired = new Set<string>();
  const patches: PatchRecord[] = [];
  const patchDigests = new Set<string>();
  const patchByEmitterAttempt = new Map<string, string>();

  entries.forEach((entry, index) => {
    if (entry.admissionDigest !== admission.admissionDigest) {
      errors.push(`${describeEntry(entry)} carries admission ${entry.admissionDigest.slice(0, 12)}…, expected ${admission.admissionDigest.slice(0, 12)}… — a different run`);
      return;
    }

    if (entry.type === 'node_started') {
      if (!entry.attemptId) {
        errors.push(`start of "${entry.nodeId}" has no attempt id`);
        return;
      }
      if (!nodeIds.has(entry.nodeId)) {
        errors.push(`start of "${entry.nodeId}" names a node the topology did not contain at that position — an order the executor cannot produce`);
        return;
      }
      if (starts.has(entry.attemptId)) {
        errors.push(`attempt "${entry.attemptId}" was started twice — duplicate durable claims are refused, not collapsed`);
        return;
      }
      starts.set(entry.attemptId, { entry, index });
      return;
    }

    if (entry.type === 'node_settled') {
      if (!Array.isArray(entry.firedEdgeIds)) {
        errors.push(`settlement of "${entry.nodeId}" carries no durable edge verdicts — a pre-R1A journal cannot be silently treated as all-success`);
        return;
      }
      const start = starts.get(entry.attemptId);
      if (!start) {
        errors.push(`settlement of "${entry.nodeId}" (attempt ${entry.attemptId}) has no preceding durable start — a settlement without its exact claim is not this run's history`);
        return;
      }
      if (
        start.entry.nodeId !== entry.nodeId
        || start.entry.nodeDigest !== entry.nodeDigest
        || start.entry.inputDigest !== entry.inputDigest
        || start.entry.wave !== entry.wave
      ) {
        errors.push(`settlement of "${entry.nodeId}" (attempt ${entry.attemptId}) disagrees with its start on node/definition/input/wave identity`);
        return;
      }
      if (settledAttempts.has(entry.attemptId)) {
        errors.push(`attempt "${entry.attemptId}" settled twice — duplicate settlements are refused, not collapsed`);
        return;
      }
      const clazz = entry.status === 'failed' ? (entry.settlementClass ?? 'node') : undefined;
      const routes = entry.status === 'completed' || (entry.status === 'failed' && clazz === 'node');
      if (!routes && entry.firedEdgeIds.length > 0) {
        errors.push(`settlement of "${entry.nodeId}" is ${entry.status}${clazz ? ` (${clazz})` : ''} yet records fired edges — only a completion or the node's own failure routes topology`);
        return;
      }
      if (!['completed', 'failed', 'blocked', 'paused'].includes(entry.status)) {
        errors.push(`settlement of "${entry.nodeId}" has status "${entry.status}", which the executor never journals`);
        return;
      }
      const seen = new Set<string>();
      for (const edgeId of entry.firedEdgeIds) {
        const edge = edgeById.get(edgeId);
        if (!edge) {
          errors.push(`settlement of "${entry.nodeId}" fired edge "${edgeId}", which the topology did not contain at that position`);
          return;
        }
        if (edge.disabled) {
          errors.push(`settlement of "${entry.nodeId}" fired disabled edge "${edgeId}"`);
          return;
        }
        if (edge.source !== entry.nodeId) {
          errors.push(`settlement of "${entry.nodeId}" fired edge "${edgeId}", which is sourced by "${edge.source}"`);
          return;
        }
        if (seen.has(edgeId)) {
          errors.push(`settlement of "${entry.nodeId}" fired edge "${edgeId}" twice`);
          return;
        }
        seen.add(edgeId);
        const when = edge.when ?? 'success';
        if (entry.status === 'completed' && when === 'failure') {
          errors.push(`completed settlement of "${entry.nodeId}" recorded failure edge "${edgeId}" as fired — a success cannot route recovery topology`);
          return;
        }
        if (entry.status === 'failed' && when === 'success') {
          errors.push(`failed settlement of "${entry.nodeId}" recorded success edge "${edgeId}" as fired`);
          return;
        }
      }
      settledAttempts.add(entry.attemptId);
      settledNodes.add(entry.nodeId);
      for (const edgeId of entry.firedEdgeIds) allFired.add(edgeId);
      if (routes) latestTrusted.set(entry.nodeId, { entry, index });
      return;
    }

    if (entry.type === 'patch_admitted') {
      if (typeof entry.emitterAttemptId !== 'string' || !entry.emitterAttemptId) {
        errors.push(`patch from "${entry.emittedBy}" carries no emitter attempt binding — a pre-R1A journal cannot prove which attempt put children there`);
        return;
      }
      const emitterStart = starts.get(entry.emitterAttemptId);
      if (!emitterStart || emitterStart.entry.nodeId !== entry.emittedBy) {
        errors.push(`patch from "${entry.emittedBy}" (attempt ${entry.emitterAttemptId}) precedes its emitter's durable start — an order the executor cannot produce`);
        return;
      }
      if (settledAttempts.has(entry.emitterAttemptId)) {
        errors.push(`patch from "${entry.emittedBy}" was admitted after attempt ${entry.emitterAttemptId} settled — an order the executor cannot produce`);
        return;
      }
      if (patchDigests.has(entry.patchDigest)) {
        errors.push(`patch ${entry.patchDigest.slice(0, 12)}… appears twice — re-emission replays history, it does not journal again`);
        return;
      }
      const prior = patchByEmitterAttempt.get(entry.emitterAttemptId);
      if (prior) {
        errors.push(`attempt ${entry.emitterAttemptId} admitted two different patches — one attempt may not create two child graphs`);
        return;
      }
      const validated = validateGraphPatch(
        { graphId: graph.graphId, nodes, edges },
        { emittedBy: entry.emittedBy, nodes: entry.nodes, edges: entry.edges },
      );
      if (!validated.ok) {
        errors.push(`journaled patch from "${entry.emittedBy}" no longer validates structurally: ${validated.errors.join('; ')}`);
        return;
      }
      if (validated.patchDigest !== entry.patchDigest) {
        errors.push('journaled patch content does not match its digest');
        return;
      }
      // The temporal join rule, decided from HISTORY: an edge may join an
      // existing node only if, at this journal position, that node had not
      // settled and no route into it had fired. The live executor enforced
      // exactly this when the patch was admitted, so a journal that violates
      // it is not this executor's history.
      const patchNodeIds = new Set(entry.nodes.map((node) => node.id));
      for (const edge of entry.edges) {
        if (patchNodeIds.has(edge.target) || !nodeIds.has(edge.target)) continue;
        if (settledNodes.has(edge.target)) {
          errors.push(`journaled patch edge "${edge.id}" joins "${edge.target}", which had already settled at that position`);
          return;
        }
        const firedIncoming = edges.some(
          (incoming) => !incoming.disabled && incoming.target === edge.target && allFired.has(incoming.id),
        );
        if (firedIncoming) {
          errors.push(`journaled patch edge "${edge.id}" joins "${edge.target}", whose readiness had already fired at that position`);
          return;
        }
      }
      nodes.push(...entry.nodes);
      edges.push(...entry.edges);
      for (const node of entry.nodes) nodeIds.add(node.id);
      for (const edge of entry.edges) edgeById.set(edge.id, edge);
      patches.push({
        entry,
        index,
        addedNodeIds: patchNodeIds,
        addedEdgeIds: new Set(entry.edges.map((edge) => edge.id)),
      });
      patchDigests.add(entry.patchDigest);
      patchByEmitterAttempt.set(entry.emitterAttemptId, entry.patchDigest);
      return;
    }

    errors.push(`journal entry of unknown type "${(entry as { type: string }).type}"`);
  });

  if (errors.length > 0) return { ok: false, errors };

  // ── orphan patches ─────────────────────────────────────────────────────────
  // A patch is REAL only when its emitter reached a durable completed
  // settlement after the patch was admitted (the emitting attempt itself, or a
  // later attempt that re-emitted the identical digest without re-journaling).
  // An orphan's topology is withheld: no child may run merely because the
  // patch entry survived the crash.
  const orphanPatchByEmitter = new Map<string, string>();
  const applied: PatchRecord[] = [];
  for (const patch of patches) {
    const emitter = latestTrusted.get(patch.entry.emittedBy);
    const isReal = emitter !== undefined
      && emitter.entry.status === 'completed'
      && emitter.index > patch.index;
    if (isReal) {
      applied.push(patch);
      continue;
    }
    for (const { entry: start } of starts.values()) {
      if (patch.addedNodeIds.has(start.nodeId)) {
        errors.push(`"${start.nodeId}" has journal history but belongs to a patch whose emitter "${patch.entry.emittedBy}" never durably completed — children cannot run from orphan topology`);
      }
    }
    for (const edgeId of patch.addedEdgeIds) {
      if (allFired.has(edgeId)) {
        errors.push(`edge "${edgeId}" fired but belongs to an orphan patch from "${patch.entry.emittedBy}"`);
      }
    }
    if (orphanPatchByEmitter.has(patch.entry.emittedBy)) {
      errors.push(`"${patch.entry.emittedBy}" has two orphan patches — a re-run emitter cannot reproduce both`);
    }
    orphanPatchByEmitter.set(patch.entry.emittedBy, patch.entry.patchDigest);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (applied.length > admission.budget.maxExpansions) {
    errors.push(`journal applies ${applied.length} patches but the admission allows ${admission.budget.maxExpansions} — not this admission's history`);
    return { ok: false, errors };
  }

  const orphanNodeIds = new Set<string>();
  const orphanEdgeIds = new Set<string>();
  for (const patch of patches) {
    if (applied.includes(patch)) continue;
    for (const id of patch.addedNodeIds) orphanNodeIds.add(id);
    for (const id of patch.addedEdgeIds) orphanEdgeIds.add(id);
  }
  const finalNodes = nodes.filter((node) => !orphanNodeIds.has(node.id));
  const finalEdges = edges.filter((edge) => !orphanEdgeIds.has(edge.id));

  // ── join-aware causal closure ──────────────────────────────────────────────
  // Every trusted settlement must be reachable through the durably fired
  // routes and its node's join mode in the fully reconstructed topology. An
  // unfired conditional alternative does not need to start or settle — closure
  // follows what FIRED, never every structural edge.
  const finalNodeById = new Map(finalNodes.map((node) => [node.id, node]));
  for (const [nodeId] of latestTrusted) {
    const node = finalNodeById.get(nodeId);
    if (!node) {
      errors.push(`trusted settlement of "${nodeId}" survives no reconstructed topology`);
      continue;
    }
    const structural = finalEdges.filter((edge) => edge.target === nodeId);
    const incoming = structural.filter((edge) => !edge.disabled);
    if (structural.length === 0) continue; // a root needs no incoming route
    if (incoming.length === 0) {
      errors.push(`"${nodeId}" settled but every route into it is disabled — it could never have been ready`);
      continue;
    }
    const satisfied = node.joinMode === 'any'
      ? incoming.some((edge) => allFired.has(edge.id))
      : incoming.every((edge) => allFired.has(edge.id));
    if (!satisfied) {
      errors.push(`"${nodeId}" settled but its ${node.joinMode === 'any' ? 'any-join has no' : 'all-join is missing a'} durably fired incoming edge — the journal is not causally closed`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    nodes: finalNodes,
    edges: finalEdges,
    trusted: new Map([...latestTrusted].map(([nodeId, { entry }]) => [nodeId, entry])),
    appliedPatchDigests: applied.map((patch) => patch.entry.patchDigest),
    journaledPatchDigests: patchDigests,
    orphanPatchByEmitter,
  };
}
