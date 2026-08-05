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
import { computeGraphDigest, validateGraphPatch } from './graph-admission.js';
import { nodeDigestFor } from './graph-node-identity.js';
import type { GraphAdmission } from './graph-admission.js';
import type { NodeOutcome } from './graph-executor.js';
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
  /** Expansion units the journal has durably consumed: one per unique patch
   *  admission, applied or orphaned. An orphan's debit survives the crash. */
  expansionsDebited: number;
  /** Every attempt id the journal has claimed — a resumed activation must
   *  never mint one of these again. */
  usedAttemptIds: Set<string>;
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
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
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
  /** Patch digests a completed settlement has durably proven (emitted or
   *  exactly reconciled) — the ONLY promotion authority replay accepts. */
  const provenPatchDigests = new Set<string>();
  /** Trusted completions in order, for detecting an ignored orphan patch. */
  const trustedCompletions: Array<{ nodeId: string; index: number; emittedPatchDigest?: string }> = [];

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
      const def = nodeById.get(entry.nodeId);
      if (!def) {
        errors.push(`start of "${entry.nodeId}" names a node the topology did not contain at that position — an order the executor cannot produce`);
        return;
      }
      if (starts.has(entry.attemptId)) {
        errors.push(`attempt "${entry.attemptId}" was started twice — duplicate durable claims are refused, not collapsed`);
        return;
      }
      // A7: identity is the admitted definition, not internal agreement. A
      // forged pair whose digest never described this topology authorizes
      // nothing — not routing, not reuse, not patch causality. Under a
      // semantic admission the definition includes semantics and runner.
      if (entry.nodeDigest !== nodeDigestFor(admission, def)) {
        errors.push(`start of "${entry.nodeId}" carries node digest ${entry.nodeDigest.slice(0, 12)}…, which does not match the definition at that journal position`);
        return;
      }
      // A3: journal order IS causality. The node must have been ready given
      // only the durable route evidence in the journal prefix — a future
      // route cannot authorize a past start.
      const structuralIn = edges.filter((edge) => edge.target === entry.nodeId);
      if (structuralIn.length > 0) {
        const enabledIn = structuralIn.filter((edge) => !edge.disabled);
        const ready = enabledIn.length > 0 && (def.joinMode === 'any'
          ? enabledIn.some((edge) => allFired.has(edge.id))
          : enabledIn.every((edge) => allFired.has(edge.id)));
        if (!ready) {
          errors.push(`start of "${entry.nodeId}" (attempt ${entry.attemptId}) was not ready at its journal position (its ${def.joinMode === 'any' ? 'any-join has no' : 'all-join is missing a'} durably fired incoming edge) — a future route cannot authorize a past start`);
          return;
        }
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
      // A2: built-in route completeness. A completion must fire every enabled
      // success route that existed at this position, a node-class failure
      // every failure route — an omitted route is silently deleted work.
      if (routes) {
        const requiredWhen = entry.status === 'completed' ? 'success' : 'failure';
        for (const edge of edges) {
          if (edge.disabled || edge.source !== entry.nodeId) continue;
          if ((edge.when ?? 'success') !== requiredWhen) continue;
          if (!seen.has(edge.id)) {
            errors.push(`${entry.status} settlement of "${entry.nodeId}" omits enabled ${requiredWhen} route "${edge.id}" — a settlement cannot silently delete work`);
            return;
          }
        }
      }
      // A4: a settlement may claim patch emission only for a patch this
      // journal durably admitted, by this node, at an earlier position.
      if (entry.emittedPatchDigest !== undefined) {
        if (entry.status !== 'completed') {
          errors.push(`settlement of "${entry.nodeId}" is ${entry.status} yet claims an emitted patch — only a completion emits topology`);
          return;
        }
        const claimed = patches.find((patch) => patch.entry.patchDigest === entry.emittedPatchDigest);
        if (!claimed || claimed.entry.emittedBy !== entry.nodeId) {
          errors.push(`settlement of "${entry.nodeId}" claims patch ${entry.emittedPatchDigest.slice(0, 12)}…, which this journal never admitted for it`);
          return;
        }
        provenPatchDigests.add(entry.emittedPatchDigest);
      }
      settledAttempts.add(entry.attemptId);
      settledNodes.add(entry.nodeId);
      for (const edgeId of entry.firedEdgeIds) allFired.add(edgeId);
      if (routes) latestTrusted.set(entry.nodeId, { entry, index });
      if (entry.status === 'completed') {
        trustedCompletions.push({ nodeId: entry.nodeId, index, emittedPatchDigest: entry.emittedPatchDigest });
      }
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
      for (const node of entry.nodes) { nodeIds.add(node.id); nodeById.set(node.id, node); }
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

  // ── expansion debit ────────────────────────────────────────────────────────
  // A5: every unique durable patch admission consumed one expansion unit when
  // it was journaled, whether it was later applied or orphaned. A history with
  // more admissions than the sealed budget is not this admission's history.
  if (patchDigests.size > admission.budget.maxExpansions) {
    errors.push(`journal admits ${patchDigests.size} patches but the admission allows ${admission.budget.maxExpansions} expansions — not this admission's history`);
    return { ok: false, errors };
  }

  // ── orphan patches and promotion proof ─────────────────────────────────────
  // A4: a patch is REAL only when a completed settlement of its emitter, at a
  // later position, carries its exact digest — the original emitting attempt
  // or an exact reconciliation. An ordinary later completion proves nothing,
  // and a completion that IGNORED its durable orphan patch is a history the
  // fixed executor refuses to write.
  const orphanPatchByEmitter = new Map<string, string>();
  const applied: PatchRecord[] = [];
  for (const patch of patches) {
    if (provenPatchDigests.has(patch.entry.patchDigest)) {
      applied.push(patch);
      continue;
    }
    const ignoringCompletion = trustedCompletions.find(
      (completion) => completion.nodeId === patch.entry.emittedBy && completion.index > patch.index,
    );
    if (ignoringCompletion) {
      errors.push(`completion of "${patch.entry.emittedBy}" ignored its durable orphan patch ${patch.entry.patchDigest.slice(0, 12)}… — a completion must reproduce the exact digest or refuse`);
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
    expansionsDebited: patchDigests.size,
    usedAttemptIds: new Set(starts.keys()),
  };
}

/**
 * The reuse decision for one trusted settlement, made at READINESS when the
 * resumed run's current input digest is known. Reuse demands exact identity —
 * the admitted definition and the current inputs — and rebuilds the outcome
 * from durable history alone. Anything less exact is a refusal whose reason
 * travels the trace in digest prefixes, never payload bytes.
 */
export function decideTrustedReuse(
  journaled: NodeSettledEntry,
  node: { id: string; kind: string; joinMode?: 'all' | 'any' },
  currentInputDigest: string,
  admission?: GraphAdmission,
): { reuse: NodeOutcome } | { refusal: string } {
  if (journaled.nodeDigest !== nodeDigestFor(admission, node)) {
    return { refusal: 'node definition digest changed — same id, different work' };
  }
  if (currentInputDigest !== journaled.inputDigest) {
    return { refusal: `current input digest ${currentInputDigest.slice(0, 12)}… does not match journaled ${journaled.inputDigest.slice(0, 12)}…` };
  }
  return {
    reuse: journaled.status === 'completed'
      ? { status: 'completed', outputRef: journaled.outputRef, evidenceRefs: journaled.evidenceRefs }
      : { status: 'failed', reason: journaled.reason ?? 'failed', settlementClass: 'node' },
  };
}

/**
 * The admitted-mode precondition: what must be true and injected BEFORE an
 * admitted run reads history, appends a claim, or dispatches a runner. The
 * runtime graph must BE the admitted graph; durability, time, attempt
 * identity, and (when growth is allowed) patch authority must be injected.
 * Returns the typed refusal, or undefined when the run may proceed.
 */
export function admittedRunPrecondition(
  graph: ExecutableGraph,
  admission: GraphAdmission,
  ports: {
    journalAdapter: boolean;
    clock: boolean;
    nodeIdJournal: boolean;
    attemptIds: boolean;
    patchAdmitter: boolean;
  },
): string | undefined {
  if (computeGraphDigest(graph) !== admission.graphDigest) {
    return 'admitted run refuses this graph: its digest does not match the admitted graph';
  }
  if (!ports.journalAdapter) return 'admitted run requires a journal adapter';
  if (!ports.clock) return 'admitted run requires a clock (a ceiling needs one)';
  if (ports.nodeIdJournal) return 'admitted run refuses a node-id journal; supply resumeEntries';
  // The default counter restarts every activation and rewrites journaled
  // attempt identity on resume — admitted attempt ids are injected.
  if (!ports.attemptIds) return 'admitted run requires an injected attempt-id source';
  if (admission.budget.maxExpansions > 0 && !ports.patchAdmitter) {
    // Fail closed: a run allowed to grow must have an authority judge.
    return 'admitted run allows expansions but has no patch admitter';
  }
  return undefined;
}
