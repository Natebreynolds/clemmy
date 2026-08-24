/**
 * Pure structural projection for one already-accepted work topology.
 *
 * This boundary does not plan, resolve providers, write a manifest, or start
 * work. It expands only identities already admitted by the graph and promotes
 * to durable execution when the unresolved activation ledger exceeds the
 * bounded foreground budget. Returned row count is evidence for a universe;
 * it is never permission to manufacture per-item work.
 */
import {
  WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS,
  canonicalWorkTopologyJson,
  validateWorkTopology,
  workTopologyDigest,
  workTopologySha256,
  type WorkTopologyEffectV1,
  type WorkTopologyOperationV1,
  type WorkTopologyV1,
} from '../runtime/graph/work-topology.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MEMBER_PATTERN = /^\S(?:[\s\S]{0,254}\S)?$/;
const WRITE_EFFECTS = new Set<WorkTopologyEffectV1>([
  'local_write', 'external_write', 'admin',
]);

export interface StructuralAcceptedWorkContractV1 {
  version: number;
  contractId: string;
  identity: { sessionId: string; sourceUserSeq: number; turn: number };
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  topologyHash: string;
  topology: WorkTopologyV1;
}

export interface StructuralSettledRootV1 {
  operationId: string;
  logicalToolCallId: string;
  resultHandleId: string;
  outcome: 'succeeded';
  exhausted: boolean;
  recordCount: number;
}

export interface StructuralUniverseSealV1 {
  universeId: string;
  producerOperationId: string;
  producerLogicalToolCallId: string;
  state: 'sealed' | 'unsealed';
  digest: string;
  memberCount: number;
  memberStoreRef: string;
  /** The pure seam receives resolved members. Durable execution pages the
   * exact same ledger through memberStoreRef instead of placing it in prompts. */
  members: unknown[];
}

export interface StructuralWorkActivationV1 {
  activationId: string;
  operationId: string;
  universeId: string | null;
  memberId: string | null;
  dependsOn: string[];
  effect: WorkTopologyEffectV1;
}

export interface StructuralWorkManifestReferenceV1 {
  manifestId: string;
  contractRef: {
    contractId: string;
    graphId: string;
    graphHash: string;
    topologyHash: string;
  };
  universeRefs: Array<{
    universeId: string;
    sealDigest: string;
    memberCount: number;
    memberStoreRef: string;
  }>;
}

export interface DeriveStructuralWorkDispositionInput {
  contract: StructuralAcceptedWorkContractV1;
  settledRoots: StructuralSettledRootV1[];
  universeSeals: StructuralUniverseSealV1[];
  /** foreground is a presentation/watch hint only; it cannot take structurally
   * large work out of crash-safe durable ownership. */
  controls: { explicit: 'foreground' | 'background' | null };
  /** maxConcurrency is downstream execution policy. It never changes the
   * structural foreground/durable verdict. */
  budget: { maxForegroundActivations: number; maxConcurrency: number };
}

export type StructuralWorkDisposition =
  | {
      status: 'admitted';
      kind: 'bounded_foreground' | 'durable_manifest';
      activationCount: number;
      itemActivationCount: number;
      writeActivationCount: number;
      activations: StructuralWorkActivationV1[];
      manifest: StructuralWorkManifestReferenceV1 | null;
    }
  | {
      status: 'not_ready' | 'refused';
      activationCount: 0;
      itemActivationCount: 0;
      writeActivationCount: 0;
      activations: [];
      manifest: null;
      reasons: string[];
    };

interface ResolvedUniverse {
  universeId: string;
  members: string[];
  sealDigest: string;
  memberStoreRef: string;
}

function failure(
  status: 'not_ready' | 'refused',
  ...reasons: string[]
): StructuralWorkDisposition {
  return {
    status,
    activationCount: 0,
    itemActivationCount: 0,
    writeActivationCount: 0,
    activations: [],
    manifest: null,
    reasons,
  };
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
}

function stableAddress(domain: string, value: unknown): string {
  return `${domain}:${workTopologySha256(canonicalWorkTopologyJson(value))}`;
}

function topologicalOperations(topology: WorkTopologyV1): WorkTopologyOperationV1[] {
  const byId = new Map(topology.operations.map((operation) => [operation.id, operation]));
  const indegree = new Map(topology.operations.map((operation) => [operation.id, operation.dependsOn.length]));
  const outgoing = new Map(topology.operations.map((operation) => [operation.id, [] as string[]]));
  for (const operation of topology.operations) {
    for (const dependency of operation.dependsOn) outgoing.get(dependency)?.push(operation.id);
  }
  for (const targets of outgoing.values()) targets.sort();
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: WorkTopologyOperationV1[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return ordered;
}

function activationIdentity(input: {
  contract: StructuralAcceptedWorkContractV1;
  operation: WorkTopologyOperationV1;
  universeId: string | null;
  memberId: string | null;
  universeDigest: string | null;
}): string {
  return stableAddress('work-activation:v1', {
    contractId: input.contract.contractId,
    graphHash: input.contract.graphHash,
    topologyHash: input.contract.topologyHash,
    operationId: input.operation.id,
    universeId: input.universeId,
    memberId: input.memberId,
    universeDigest: input.universeDigest,
  });
}

function validateContract(
  contract: StructuralAcceptedWorkContractV1,
): { ok: true; topology: WorkTopologyV1 } | { ok: false; reason: string } {
  if (
    !boundedId(contract.contractId)
    || !boundedId(contract.acceptedTaskId)
    || !boundedId(contract.graphEventId)
    || !boundedId(contract.graphId)
    || !boundedId(contract.identity?.sessionId)
    || !Number.isSafeInteger(contract.identity?.sourceUserSeq)
    || contract.identity.sourceUserSeq <= 0
    || !Number.isSafeInteger(contract.identity?.turn)
    || contract.identity.turn < 0
    || !DIGEST_PATTERN.test(contract.graphHash)
    || !DIGEST_PATTERN.test(contract.topologyHash)
  ) {
    return { ok: false, reason: 'accepted work identity is malformed' };
  }
  const validated = validateWorkTopology(contract.topology);
  if (!validated.ok) {
    return { ok: false, reason: `accepted topology is invalid: ${validated.errors.join('; ')}` };
  }
  if (workTopologyDigest(validated.topology) !== contract.topologyHash) {
    return { ok: false, reason: 'accepted topology does not match its digest' };
  }
  return { ok: true, topology: validated.topology };
}

function validateSettledRoots(input: {
  topology: WorkTopologyV1;
  settledRoots: readonly StructuralSettledRootV1[];
}): { ok: true; roots: Map<string, StructuralSettledRootV1> } | { ok: false; reason: string } {
  const known = new Map(input.topology.operations.map((operation) => [operation.id, operation]));
  const roots = new Map<string, StructuralSettledRootV1>();
  const logicalIds = new Set<string>();
  for (const root of input.settledRoots) {
    if (
      !boundedId(root.operationId)
      || !known.has(root.operationId)
      || roots.has(root.operationId)
      || !boundedId(root.logicalToolCallId)
      || logicalIds.has(root.logicalToolCallId)
      || !boundedId(root.resultHandleId)
      || root.outcome !== 'succeeded'
      || !Number.isSafeInteger(root.recordCount)
      || root.recordCount < 0
    ) {
      return { ok: false, reason: 'settled root identity is malformed or duplicated' };
    }
    const operation = known.get(root.operationId)!;
    if (operation.effect === 'read' && operation.coverage === 'complete_set' && !root.exhausted) {
      return { ok: false, reason: `settled complete-set root ${root.operationId} is not exhausted` };
    }
    roots.set(root.operationId, root);
    logicalIds.add(root.logicalToolCallId);
  }
  return { ok: true, roots };
}

function resolveUniverses(input: {
  topology: WorkTopologyV1;
  roots: ReadonlyMap<string, StructuralSettledRootV1>;
  seals: readonly StructuralUniverseSealV1[];
}): { ok: true; universes: Map<string, ResolvedUniverse> }
  | { ok: false; status: 'not_ready' | 'refused'; reason: string } {
  const consumed = new Set(input.topology.operations.flatMap((operation) => (
    operation.cardinality.kind === 'once' ? [] : [operation.cardinality.universeId]
  )));
  const supplied = new Map<string, StructuralUniverseSealV1[]>();
  for (const seal of input.seals) {
    const entries = supplied.get(seal.universeId) ?? [];
    entries.push(seal);
    supplied.set(seal.universeId, entries);
  }
  const resolved = new Map<string, ResolvedUniverse>();
  for (const universe of input.topology.universes) {
    if (!consumed.has(universe.id)) continue;
    if (universe.seal === 'accepted_input') {
      const members = [...universe.members];
      const sealDigest = workTopologySha256(canonicalWorkTopologyJson(members));
      resolved.set(universe.id, {
        universeId: universe.id,
        members,
        sealDigest,
        memberStoreRef: `accepted-input-members:v1:${sealDigest}`,
      });
      continue;
    }
    const candidates = supplied.get(universe.id) ?? [];
    if (candidates.length === 0) {
      return { ok: false, status: 'not_ready', reason: `universe ${universe.id} is not sealed` };
    }
    if (candidates.length !== 1) {
      return { ok: false, status: 'refused', reason: `universe ${universe.id} has duplicate seals` };
    }
    const seal = candidates[0]!;
    const producer = input.roots.get(universe.producedBy);
    if (!producer) {
      return { ok: false, status: 'not_ready', reason: `universe producer ${universe.producedBy} is unsettled` };
    }
    if (
      seal.state !== 'sealed'
      || seal.producerOperationId !== universe.producedBy
      || seal.producerLogicalToolCallId !== producer.logicalToolCallId
      || !DIGEST_PATTERN.test(seal.digest)
      || !boundedId(seal.memberStoreRef)
      || !Number.isSafeInteger(seal.memberCount)
      || seal.memberCount < 0
      || seal.memberCount > WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS
      || !Array.isArray(seal.members)
      || seal.memberCount !== seal.members.length
      || producer.recordCount !== seal.memberCount
    ) {
      return { ok: false, status: 'refused', reason: `universe ${universe.id} seal identity is malformed` };
    }
    const members: string[] = [];
    const seen = new Set<string>();
    for (const member of seal.members) {
      if (typeof member !== 'string' || !MEMBER_PATTERN.test(member) || seen.has(member)) {
        return { ok: false, status: 'refused', reason: `universe ${universe.id} has malformed member identities` };
      }
      seen.add(member);
      members.push(member);
    }
    if (workTopologySha256(canonicalWorkTopologyJson(members)) !== seal.digest) {
      return { ok: false, status: 'refused', reason: `universe ${universe.id} does not match its digest` };
    }
    resolved.set(universe.id, {
      universeId: universe.id,
      members,
      sealDigest: seal.digest,
      memberStoreRef: seal.memberStoreRef,
    });
  }
  return { ok: true, universes: resolved };
}

/** Derive a bounded foreground ledger or a durable manifest reference from the
 * exact accepted topology. The result is deterministic across restarts. */
export function deriveStructuralWorkDisposition(
  input: DeriveStructuralWorkDispositionInput,
): StructuralWorkDisposition {
  if (
    !Number.isSafeInteger(input.budget?.maxForegroundActivations)
    || input.budget.maxForegroundActivations <= 0
    || !Number.isSafeInteger(input.budget?.maxConcurrency)
    || input.budget.maxConcurrency <= 0
    || (input.controls?.explicit !== null
      && input.controls?.explicit !== 'foreground'
      && input.controls?.explicit !== 'background')
  ) {
    return failure('refused', 'structural work controls or budget are invalid');
  }
  const accepted = validateContract(input.contract);
  if (!accepted.ok) return failure('refused', accepted.reason);
  const settled = validateSettledRoots({
    topology: accepted.topology,
    settledRoots: input.settledRoots,
  });
  if (!settled.ok) return failure('refused', settled.reason);
  const resolved = resolveUniverses({
    topology: accepted.topology,
    roots: settled.roots,
    seals: input.universeSeals,
  });
  if (!resolved.ok) return failure(resolved.status, resolved.reason);

  const activationsByOperation = new Map<string, StructuralWorkActivationV1[]>();
  const operations = topologicalOperations(accepted.topology);
  for (const operation of operations) {
    if (settled.roots.has(operation.id)) {
      activationsByOperation.set(operation.id, []);
      continue;
    }
    const universe = operation.cardinality.kind === 'once'
      ? null
      : resolved.universes.get(operation.cardinality.universeId) ?? null;
    if (operation.cardinality.kind !== 'once' && !universe) {
      return failure('not_ready', `operation ${operation.id} has no resolved universe`);
    }
    const instances = operation.cardinality.kind === 'each'
      ? universe!.members.map((memberId) => ({ memberId }))
      : [{ memberId: null }];
    const created = instances.map(({ memberId }) => ({
      activationId: activationIdentity({
        contract: input.contract,
        operation,
        universeId: universe?.universeId ?? null,
        memberId,
        universeDigest: universe?.sealDigest ?? null,
      }),
      operationId: operation.id,
      universeId: universe?.universeId ?? null,
      memberId,
      dependsOn: [] as string[],
      effect: operation.effect,
    }));
    activationsByOperation.set(operation.id, created);
  }

  for (const operation of operations) {
    const downstream = activationsByOperation.get(operation.id) ?? [];
    for (const activation of downstream) {
      const dependencies: string[] = [];
      for (const dependencyId of operation.dependsOn) {
        if (settled.roots.has(dependencyId)) continue;
        const upstreamOperation = accepted.topology.operations.find((candidate) => candidate.id === dependencyId)!;
        const upstream = activationsByOperation.get(dependencyId) ?? [];
        if (
          operation.cardinality.kind === 'each'
          && upstreamOperation.cardinality.kind === 'each'
        ) {
          if (operation.cardinality.universeId !== upstreamOperation.cardinality.universeId) {
            return failure('refused', `operation ${operation.id} requires an implicit cross-universe join`);
          }
          const paired = upstream.find((candidate) => candidate.memberId === activation.memberId);
          if (!paired) return failure('refused', `operation ${operation.id} has an incomplete member dependency`);
          dependencies.push(paired.activationId);
        } else {
          dependencies.push(...upstream.map((candidate) => candidate.activationId));
        }
      }
      activation.dependsOn = [...new Set(dependencies)];
    }
  }

  const activations = operations.flatMap((operation) => activationsByOperation.get(operation.id) ?? []);
  const activationCount = activations.length;
  const itemActivationCount = activations.filter((activation) => activation.memberId !== null).length;
  const writeActivationCount = activations.filter((activation) => WRITE_EFFECTS.has(activation.effect)).length;
  const durable = input.controls.explicit === 'background'
    || activationCount > input.budget.maxForegroundActivations;
  const universeRefs = [...resolved.universes.values()]
    .sort((left, right) => left.universeId.localeCompare(right.universeId))
    .map((universe) => ({
      universeId: universe.universeId,
      sealDigest: universe.sealDigest,
      memberCount: universe.members.length,
      memberStoreRef: universe.memberStoreRef,
    }));
  const contractRef = {
    contractId: input.contract.contractId,
    graphId: input.contract.graphId,
    graphHash: input.contract.graphHash,
    topologyHash: input.contract.topologyHash,
  };
  const manifest = durable
    ? {
        manifestId: stableAddress('structural-work-manifest:v1', {
          contractRef,
          universeRefs,
          activationIds: activations.map((activation) => activation.activationId),
        }),
        contractRef,
        universeRefs,
      }
    : null;
  return {
    status: 'admitted',
    kind: durable ? 'durable_manifest' : 'bounded_foreground',
    activationCount,
    itemActivationCount,
    writeActivationCount,
    activations,
    manifest,
  };
}
