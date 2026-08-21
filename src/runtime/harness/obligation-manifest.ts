/**
 * The obligation manifest: what an accepted turn owes, as authority.
 *
 * The compiled TurnGraph is `mode: 'shadow'` and it is compiled BEFORE any tool
 * is resolved, so a chat turn arrives as a single `execute` node with
 * `effect.kind: 'unknown'`. Promoting that to authority would mean deciding how
 * to verify an effect before knowing what the effect is — which is how a send
 * came to be told to re-read itself.
 *
 * So authority is a second, explicit artifact:
 *
 *   shadow graph ──(capability resolution)──▶ resolution ──▶ obligation manifest
 *                                                            mode: 'authoritative'
 *
 * Three properties make it authority rather than a restatement of a caller's
 * intentions:
 *
 *  1. **Effects are derived, never asserted.** A resolution names the operations
 *     that ran and the capability each used; the effect comes from the shared
 *     tool taxonomy. A caller cannot relabel a send as a read.
 *  2. **Resolution is closed by construction.** A parent's operations arrive as
 *     one set, so a caller cannot omit the write half and finalise the read.
 *  3. **Unresolved action work cannot finalise.** A node whose effect is still
 *     unknown leaves the manifest `unresolved`, and an unresolved manifest is
 *     not persistable. A conversational turn resolves no action node and is
 *     legitimately `ready` with zero obligations — which is a different thing
 *     from having no manifest at all.
 */
import { createHash } from 'node:crypto';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import {
  expectedTaskFor,
  frozenResolutionFor,
  type ObservedReversibility,
  type ResolvedOperationFact,
} from './resolution-ledger.js';
import {
  attachEvidenceObligations,
  type EvidenceObligation,
  type NodeObligation,
} from '../graph/turn-graph-obligations.js';
import {
  operationEvidenceContract,
  type OperationEvidenceMode,
} from '../graph/operation-evidence-contract.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { isDeterministicImplicitRetrieveContract } from './expected-work-matcher.js';
import {
  loadSealedNodeBinding,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';

export const OBLIGATION_MANIFEST_VERSION = 1 as const;

export type RefinedEffectKind = 'read' | 'compute' | 'external_write' | 'local_write' | 'none';
export type RefinedReversibility = ObservedReversibility;

export interface ObligationManifestNode {
  nodeId: string;
  effectKind: RefinedEffectKind;
  reversibility: RefinedReversibility;
  resolvedTool: string;
  operationId: string;
  operationMode: OperationEvidenceMode;
  obligations: EvidenceObligation[];
}

/** A dependency edge is qualified: an obligation on a node, not a bare name. */
export interface ObligationEdge {
  fromNodeId: string;
  fromObligation: EvidenceObligation;
  toNodeId: string;
  toObligation: EvidenceObligation;
}

export interface ObligationManifest {
  version: typeof OBLIGATION_MANIFEST_VERSION;
  mode: 'authoritative';
  /**
   * `unresolved` means an action node's effect is still unknown. Such a
   * manifest describes work whose proof obligations are not yet knowable, and
   * it may not be persisted as authority.
   */
  readiness: 'ready' | 'unresolved';
  manifestId: string;
  graphId: string;
  graphHash: string;
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  nodes: ObligationManifestNode[];
  edges: ObligationEdge[];
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

function refinedEffect(operation: ResolvedOperationFact): RefinedEffectKind {
  // Admin effects are externally consequential and owe the same proof shape as
  // an irreversible external write until a narrower admin receipt exists.
  if (operation.effectKind === 'admin') return 'external_write';
  if (operation.effectKind === 'unknown') return 'none';
  if (operation.effectKind === 'host_only') return 'compute';
  return operation.effectKind;
}

/**
 * Ordering WITHIN a node, plus the cross-node edge that matters: a write cannot
 * derive from a source whose collection is not yet complete.
 */
const WITHIN_NODE: Partial<Record<EvidenceObligation, EvidenceObligation[]>> = {
  commit_effect: ['derivation_from_current_source'],
  verify_committed_readback: ['commit_effect'],
  verify_committed_receipt: ['commit_effect'],
  stale_destination_reconciled: ['commit_effect'],
  execution_terminal: ['commit_effect'],
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The content address covers everything that changes what is owed: who accepted
 * the turn, which graph it refines, the manifest's own version and mode, its
 * readiness, and every resolved operation. Two manifests that differ in any of
 * those are different manifests, and neither can pass as the other.
 */
function addressOf(input: Omit<ObligationManifest, 'manifestId'>): string {
  return `manifest:v${OBLIGATION_MANIFEST_VERSION}:${sha256(canonical({
    version: input.version,
    mode: input.mode,
    readiness: input.readiness,
    identity: input.identity,
    graphId: input.graphId,
    graphHash: input.graphHash,
    nodes: input.nodes,
    edges: input.edges,
  }))}`;
}

/**
 * Compile the authoritative manifest from two durable artifacts only:
 *
 *   expected = exact persisted graph
 *   observed = atomically frozen resolution operations
 *
 * There is deliberately no caller-supplied resolution fallback. A test and a
 * provider lane exercise the same authority path.
 */
export function compileObligationManifest(input: {
  graph: TurnGraphIR;
}): { manifest: ObligationManifest; validation: ManifestValidation } {
  const errors: string[] = [];
  const expectedState = expectedTaskFor(
    input.graph.identity.sessionId,
    input.graph.identity.sourceUserSeq,
  );
  const durableGraph = expectedState.status === 'ok' ? expectedState.graph : input.graph;
  if (expectedState.status !== 'ok') {
    errors.push(`accepted task expectation is ${expectedState.status}: ${expectedState.reason}`);
  } else if (
    input.graph.graphId !== durableGraph.graphId
    || input.graph.compiler.graphHash !== durableGraph.compiler.graphHash
  ) {
    errors.push('caller graph does not match the exact persisted accepted-task graph');
  }
  const identity = durableGraph.identity;
  const frozen = frozenResolutionFor(identity.sessionId, identity.sourceUserSeq);
  const ledgerFacts = frozen.status === 'ok' ? frozen.operations : [];
  const expectedWork = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (frozen.status === 'ambiguous') {
    errors.push(`frozen accepted-task resolution is ambiguous: ${frozen.reason}`);
  }
  const graphNodes = new Map(durableGraph.nodes.map((node) => [node.id, node]));
  const hasSourceRead = ledgerFacts.some((operation) => refinedEffect(operation) === 'read');
  // The deterministic retrieve contract promised resolved-operation coverage:
  // one grounded retrieval, not an exhaustive set. Its read owes durable
  // observation, not source exhaustion — a proof many providers cannot even
  // express (no completeness signal, no cursor). Exhaustion remains owed by
  // every other read shape, including complete_set action contracts.
  let observationSufficientNodeId: string | null = null;
  try {
    if (expectedWork.status === 'ok' && isDeterministicImplicitRetrieveContract(expectedWork.contract)) {
      observationSufficientNodeId = expectedWork.contract.operations[0]!.id;
    }
  } catch { /* an unreadable contract keeps the strict historical obligation */ }

  const nodes: ObligationManifestNode[] = [];
  for (const operation of ledgerFacts) {
    const parent = graphNodes.get(operation.nodeId);
    if (!parent) {
      errors.push(`observed operation names node '${operation.nodeId}', which is not in graph ${durableGraph.graphId}`);
      continue;
    }
    if (!operation.resolvedTool.trim()) {
      errors.push(`operation '${operation.operationId}' names no capability`);
      continue;
    }
    const effectKind = refinedEffect(operation);
    if (effectKind === 'none') continue;
    // An effectful operation with NO physical dispatch never crossed any
    // boundary — a pre-dispatch refusal of a write-shaped carrier leaves this
    // exact row (outer settlement succeeded, dispatch not_started). Nothing
    // was committed, so nothing owes commit/readback proof; write-truth
    // separately records the refusal. Attaching write obligations here made a
    // correct retrieve answer unverifiable: "no production evidence issuer
    // exists for manifest effect external_write" (routing-sweep fixture,
    // 2026-08-12). A write that DID cross keeps every obligation.
    if (
      (effectKind === 'external_write' || effectKind === 'local_write')
      && !operation.physicalDispatchId
      // Only rows EXPLICITLY recorded as never-dispatched are skipped — the
      // refused-carrier shape stamps 'not_started'. Work recorded without
      // dispatch bookkeeping at all (legacy/manifest lanes leave it null)
      // keeps every obligation: an unproven write must still block.
      && operation.dispatchState === 'not_started'
    ) continue;
    const nodeId = `${operation.nodeId}/${operation.operationId}`;
    // Accepted-task resolution groups a collect/construct family under its
    // primary work node, while `operationId` retains the exact executable DAG
    // node. Capability semantics must come from that executable node rather
    // than from the shared write owner, otherwise every upstream read inherits
    // the destination manifest.
    const executableNode = graphNodes.get(operation.operationId) ?? parent;
    const sealed = loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, executableNode.id);
    const producedOutputKinds = (
      (sealed?.capabilityId
        ? peekHostCapabilityCatalogFactory()?.get(sealed.capabilityId)
        : undefined)
      ?? peekHostCapabilityCatalogFactory()?.snapshot().find((entry) => (
        entry.manifest?.operationId === operation.resolvedTool
        || entry.toolName === operation.resolvedTool
      ))
    )?.manifest?.producedOutputKinds
      ?? (executableNode.capabilityRole === 'source'
        ? ['locator']
        : executableNode.capabilityRole === 'collection'
          || executableNode.capabilityRole === 'collect'
          || executableNode.capabilityRole === 'readback'
          ? ['records']
          : undefined);
    const evidenceContract = operationEvidenceContract({
      resolvedTool: operation.resolvedTool,
      effectKind,
      reversibility: operation.reversibility,
      producedOutputKinds,
      finiteBound: durableGraph.classification.multiItem?.collectThenConstruct === true
        || Number(durableGraph.classification.goalConstraints?.collection?.count) > 0,
    });
    const obligations = attachEvidenceObligations({
      effect: effectKind,
      reversibility: operation.reversibility,
      receipt: parent.effect.receipt,
      nodeId,
      operationMode: evidenceContract.mode,
      hasSourceRead,
      requiresStaleReconciliation: evidenceContract.requiresStaleReconciliation,
      observationSufficient: observationSufficientNodeId !== null
        && operation.nodeId === observationSufficientNodeId,
    }).map((entry: NodeObligation) => entry.obligation);
    if (obligations.length === 0) continue;
    nodes.push({
      nodeId,
      effectKind,
      reversibility: operation.reversibility,
      resolvedTool: operation.resolvedTool,
      operationId: operation.operationId,
      operationMode: evidenceContract.mode,
      obligations,
    });
  }

  // Qualified edges. Within a node, proof has an order. Across nodes, a write
  // may not derive from a source whose collection is still incomplete.
  const edges: ObligationEdge[] = [];
  const readNodes = nodes.filter((node) => node.effectKind === 'read');
  const expectedOperations = expectedWork.status === 'ok'
    ? new Map(expectedWork.contract.operations.map((operation) => [operation.id, operation]))
    : null;
  const isUpstreamRead = (sourceOperationId: string, writeOperationId: string): boolean => {
    if (!expectedOperations) return true;
    const visited = new Set<string>();
    const pending = [writeOperationId];
    while (pending.length > 0) {
      const operationId = pending.pop()!;
      if (visited.has(operationId)) continue;
      visited.add(operationId);
      const operation = expectedOperations.get(operationId);
      if (!operation) continue;
      for (const dependencyId of new Set([...operation.dependsOn, ...operation.dataFrom])) {
        if (dependencyId === sourceOperationId) return true;
        pending.push(dependencyId);
      }
    }
    return false;
  };
  for (const node of nodes) {
    const declared = new Set(node.obligations);
    for (const obligation of node.obligations) {
      for (const dependency of WITHIN_NODE[obligation] ?? []) {
        if (!declared.has(dependency)) continue;
        edges.push({
          fromNodeId: node.nodeId, fromObligation: dependency,
          toNodeId: node.nodeId, toObligation: obligation,
        });
      }
      if (obligation === 'derivation_from_current_source') {
        for (const source of readNodes.filter((candidate) =>
          isUpstreamRead(candidate.operationId, node.operationId))) {
          const sourceObligation = source.obligations.includes('source_completeness')
            ? 'source_completeness' as const
            : source.obligations.includes('source_observed')
              ? 'source_observed' as const
              : null;
          if (!sourceObligation) continue;
          edges.push({
            fromNodeId: source.nodeId, fromObligation: sourceObligation,
            toNodeId: node.nodeId, toObligation: 'derivation_from_current_source',
          });
        }
      }
    }
  }

  // Closure alone is not enough: finalization records whether observed work
  // covered the graph's minimum route/effect contract. This catches ordinary
  // reads and explicit sends too; the old compiler checked only `unknown` nodes,
  // allowing exact-effect graphs to persist a ready, zero-node manifest.
  const unresolved = frozen.status !== 'ok' || !frozen.resolution.expectationsSatisfied;

  const body: Omit<ObligationManifest, 'manifestId'> = {
    version: OBLIGATION_MANIFEST_VERSION,
    mode: 'authoritative',
    readiness: unresolved ? 'unresolved' : 'ready',
    graphId: durableGraph.graphId,
    graphHash: durableGraph.compiler.graphHash,
    identity: {
      sessionId: durableGraph.identity.sessionId,
      sourceUserSeq: durableGraph.identity.sourceUserSeq,
      turn: durableGraph.identity.turn,
    },
    nodes,
    edges,
  };

  return {
    manifest: { ...body, manifestId: addressOf(body) },
    validation: { ok: errors.length === 0, errors },
  };
}

/** Recompute the content address, so a tampered manifest cannot pass as itself. */
export function manifestIdMatches(manifest: ObligationManifest): boolean {
  const { manifestId, ...body } = manifest;
  return addressOf(body) === manifestId;
}

export interface DeclaredObligation {
  nodeId: string;
  obligation: EvidenceObligation;
  effectKind: RefinedEffectKind;
  reversibility: RefinedReversibility;
  /** Qualified prerequisites: node + obligation, not a bare obligation name. */
  dependsOn: Array<{ nodeId: string; obligation: EvidenceObligation }>;
}

export function declaredObligation(
  manifest: ObligationManifest,
  nodeId: string,
  obligation: string,
): DeclaredObligation | undefined {
  const node = manifest.nodes.find((entry) => entry.nodeId === nodeId);
  if (!node) return undefined;
  if (!node.obligations.includes(obligation as EvidenceObligation)) return undefined;
  return {
    nodeId,
    obligation: obligation as EvidenceObligation,
    effectKind: node.effectKind,
    reversibility: node.reversibility,
    dependsOn: manifest.edges
      .filter((edge) => edge.toNodeId === nodeId && edge.toObligation === obligation)
      .map((edge) => ({ nodeId: edge.fromNodeId, obligation: edge.fromObligation })),
  };
}

export function allDeclaredObligations(manifest: ObligationManifest): DeclaredObligation[] {
  return manifest.nodes.flatMap((node) => node.obligations.map((obligation) =>
    declaredObligation(manifest, node.nodeId, obligation) as DeclaredObligation));
}
