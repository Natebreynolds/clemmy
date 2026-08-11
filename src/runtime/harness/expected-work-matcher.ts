/**
 * Pure expected-vs-observed coverage matcher.
 *
 * The contract is immutable intent topology. The history is a projection of
 * host-observed, settled operations; this module never derives truth from
 * provider prose, tool names, or the old finalized expectation boolean.
 * Finalization closes the observed set, but does not make it complete.
 *
 * Deterministic conversation/retrieve turns consume this through the durable
 * projector before resolution close. Action/fanout remains staged until the
 * scheduler can supply host-owned universe-item and seal projections.
 */
import type { OperationEvidenceMode } from '../graph/operation-evidence-contract.js';
import type {
  AcceptedTaskWorkContractV1,
  ExpectedWorkEffectV1,
  ExpectedWorkOperationV1,
  ExpectedWorkUniverseV1,
} from './expected-work-contract.js';

export type ObservedReadCoverageV1 =
  | 'observed'
  | 'partial'
  | 'complete'
  | 'not_applicable';

/**
 * Minimal metadata the host must freeze beside an observed successful call.
 * `requirementId` and `universeItemId` are routing identity, not model prose.
 * `evidenceMode` comes from the host operation classifier; `coverage` comes
 * from result-handle/receipt state, never from a provider or planner verdict.
 */
export interface ObservedExpectedWorkOperationV1 {
  id: string;
  requirementId?: string;
  universeItemId?: string;
  effect: ExpectedWorkEffectV1 | 'unknown';
  outcome: 'succeeded' | 'failed';
  evidenceMode: OperationEvidenceMode;
  coverage: ObservedReadCoverageV1;
}

/** A redeemed host seal projected for matching. The production projector must
 * resolve and verify its receipt before constructing this value. */
export interface ObservedExpectedWorkUniverseV1 {
  universeId: string;
  seal: 'complete_source_receipt';
  producerRequirementId: string;
  complete: true;
  members: string[];
}

export interface ObservedExpectedWorkHistoryV1 {
  finalized: boolean;
  operations: ObservedExpectedWorkOperationV1[];
  universes: ObservedExpectedWorkUniverseV1[];
}

export type ExpectedWorkGapKind =
  | 'history_not_finalized'
  | 'requirement_unobserved'
  | 'requirement_unknown'
  | 'requirement_ambiguous'
  | 'effect_mismatch'
  | 'outcome_failed'
  | 'coverage_unproven'
  | 'dependency_unsatisfied'
  | 'universe_unsealed'
  | 'universe_unknown'
  | 'universe_conflict'
  | 'universe_item_missing'
  | 'universe_item_unknown'
  | 'cardinality_item_missing'
  | 'cardinality_item_ambiguous'
  | 'unexpected_effectful_observation'
  | 'observation_identity_conflict';

export interface ExpectedWorkGap {
  kind: ExpectedWorkGapKind;
  requirementId?: string;
  observedOperationId?: string;
  universeId?: string;
  universeItemId?: string;
  detail: string;
}

export interface ExpectedWorkBinding {
  requirementId: string;
  observedOperationId: string;
  universeItemId?: string;
}

export interface ExpectedWorkMatchResult {
  status: 'complete' | 'incomplete' | 'conflict';
  bindings: ExpectedWorkBinding[];
  gaps: ExpectedWorkGap[];
  /** Host-observed operations that discharge no expected requirement. */
  extras: string[];
}

interface RequirementInstance {
  operation: ExpectedWorkOperationV1;
  itemId?: string;
  observation?: ObservedExpectedWorkOperationV1;
  basicSatisfied: boolean;
}

const CONFLICT_GAPS = new Set<ExpectedWorkGapKind>([
  'requirement_unknown',
  'requirement_ambiguous',
  'effect_mismatch',
  'universe_unknown',
  'universe_conflict',
  'universe_item_missing',
  'universe_item_unknown',
  'cardinality_item_ambiguous',
  'unexpected_effectful_observation',
  'observation_identity_conflict',
]);

function instanceKey(requirementId: string, itemId?: string): string {
  return `${requirementId}\0${itemId ?? ''}`;
}

function deterministicImplicitRetrieve(contract: AcceptedTaskWorkContractV1): boolean {
  if (contract.plannerSource !== 'deterministic' || contract.operations.length !== 1) return false;
  const operation = contract.operations[0]!;
  return operation.effect === 'read'
    && operation.coverage === 'resolved_operation'
    && operation.cardinality.kind === 'once'
    && contract.universes.length === 0;
}

function coverageSatisfied(
  expected: ExpectedWorkOperationV1,
  observed: ObservedExpectedWorkOperationV1,
): boolean {
  if (expected.effect !== 'read') return true;
  if (
    observed.evidenceMode !== 'point_read'
    && observed.evidenceMode !== 'collection_read'
    && observed.evidenceMode !== 'finite_read'
  ) {
    return false;
  }
  if (expected.coverage === 'complete_set') {
    return observed.evidenceMode === 'collection_read' && observed.coverage === 'complete';
  }
  if (expected.coverage === 'single') {
    return observed.coverage === 'observed' || observed.coverage === 'complete';
  }
  if (expected.coverage === 'accepted_set') {
    return observed.evidenceMode === 'finite_read' && observed.coverage === 'complete';
  }
  if (expected.coverage === 'resolved_operation') {
    return observed.evidenceMode === 'point_read'
      ? observed.coverage === 'observed' || observed.coverage === 'complete'
      : observed.coverage === 'complete';
  }
  return false;
}

function canonicalMembers(members: readonly string[]): string[] | null {
  if (members.some((member) => typeof member !== 'string' || !member.trim())) return null;
  const sorted = [...members].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function addGap(gaps: ExpectedWorkGap[], gap: ExpectedWorkGap): void {
  const key = [
    gap.kind,
    gap.requirementId ?? '',
    gap.observedOperationId ?? '',
    gap.universeId ?? '',
    gap.universeItemId ?? '',
  ].join('\0');
  if (!gaps.some((candidate) => [
    candidate.kind,
    candidate.requirementId ?? '',
    candidate.observedOperationId ?? '',
    candidate.universeId ?? '',
    candidate.universeItemId ?? '',
  ].join('\0') === key)) gaps.push(gap);
}

function resolveUniverses(
  contract: AcceptedTaskWorkContractV1,
  history: ObservedExpectedWorkHistoryV1,
  gaps: ExpectedWorkGap[],
): Map<string, string[]> {
  const expectedById = new Map(contract.universes.map((universe) => [universe.id, universe]));
  const observedById = new Map<string, ObservedExpectedWorkUniverseV1[]>();
  for (const observed of history.universes) {
    if (!expectedById.has(observed.universeId)) {
      addGap(gaps, {
        kind: 'universe_unknown',
        universeId: observed.universeId,
        detail: 'an observed universe is not declared by the expected contract',
      });
      continue;
    }
    const entries = observedById.get(observed.universeId) ?? [];
    entries.push(observed);
    observedById.set(observed.universeId, entries);
  }

  const resolved = new Map<string, string[]>();
  for (const universe of contract.universes) {
    if (universe.seal === 'accepted_input') {
      const members = canonicalMembers(universe.members);
      if (!members) {
        addGap(gaps, {
          kind: 'universe_conflict',
          universeId: universe.id,
          detail: 'accepted-input universe members are invalid or duplicated',
        });
      } else {
        resolved.set(universe.id, members);
      }
      continue;
    }
    const seals = observedById.get(universe.id) ?? [];
    if (seals.length === 0) {
      addGap(gaps, {
        kind: 'universe_unsealed',
        universeId: universe.id,
        requirementId: universe.producedBy,
        detail: 'source-derived universe has no redeemed complete-source seal',
      });
      continue;
    }
    if (seals.length !== 1) {
      addGap(gaps, {
        kind: 'universe_conflict',
        universeId: universe.id,
        detail: 'more than one source-derived universe seal was observed',
      });
      continue;
    }
    const seal = seals[0]!;
    const members = canonicalMembers(seal.members);
    if (
      seal.seal !== 'complete_source_receipt'
      || seal.complete !== true
      || seal.producerRequirementId !== universe.producedBy
      || !members
    ) {
      addGap(gaps, {
        kind: 'universe_conflict',
        universeId: universe.id,
        requirementId: universe.producedBy,
        detail: 'source-derived universe seal does not match its declared producer',
      });
      continue;
    }
    resolved.set(universe.id, members);
  }
  return resolved;
}

/** Match a closed observed history against immutable expected work. */
export function matchExpectedWork(
  contract: AcceptedTaskWorkContractV1,
  history: ObservedExpectedWorkHistoryV1,
): ExpectedWorkMatchResult {
  const gaps: ExpectedWorkGap[] = [];
  const bindings: ExpectedWorkBinding[] = [];
  const usedObservationIds = new Set<string>();
  const observedIds = new Set<string>();
  for (const observation of history.operations) {
    if (!observation.id.trim() || observedIds.has(observation.id)) {
      addGap(gaps, {
        kind: 'observation_identity_conflict',
        observedOperationId: observation.id,
        detail: 'observed operation identity is blank or duplicated',
      });
    }
    observedIds.add(observation.id);
  }
  if (!history.finalized) {
    return {
      status: 'incomplete',
      bindings: [],
      gaps: [{ kind: 'history_not_finalized', detail: 'observed operation history is still open' }],
      extras: history.operations.map((operation) => operation.id).sort(),
    };
  }

  const expectedById = new Map(contract.operations.map((operation) => [operation.id, operation]));
  const explicitByRequirement = new Map<string, ObservedExpectedWorkOperationV1[]>();
  const unbound: ObservedExpectedWorkOperationV1[] = [];
  for (const observation of history.operations) {
    if (!observation.requirementId) {
      unbound.push(observation);
      continue;
    }
    if (!expectedById.has(observation.requirementId)) {
      addGap(gaps, {
        kind: 'requirement_unknown',
        requirementId: observation.requirementId,
        observedOperationId: observation.id,
        detail: 'observed operation names no requirement in the expected contract',
      });
      continue;
    }
    const entries = explicitByRequirement.get(observation.requirementId) ?? [];
    entries.push(observation);
    explicitByRequirement.set(observation.requirementId, entries);
  }

  const universes = resolveUniverses(contract, history, gaps);
  const instances = new Map<string, RequirementInstance>();
  const implicitRetrieve = deterministicImplicitRetrieve(contract);

  const validateObservation = (
    expected: ExpectedWorkOperationV1,
    observation: ObservedExpectedWorkOperationV1,
    itemId?: string,
  ): boolean => {
    usedObservationIds.add(observation.id);
    bindings.push({
      requirementId: expected.id,
      observedOperationId: observation.id,
      ...(itemId ? { universeItemId: itemId } : {}),
    });
    if (observation.outcome !== 'succeeded') {
      addGap(gaps, {
        kind: 'outcome_failed',
        requirementId: expected.id,
        observedOperationId: observation.id,
        ...(itemId ? { universeItemId: itemId } : {}),
        detail: 'failed observed work cannot discharge an expected requirement',
      });
      return false;
    }
    if (observation.effect !== expected.effect) {
      addGap(gaps, {
        kind: 'effect_mismatch',
        requirementId: expected.id,
        observedOperationId: observation.id,
        ...(itemId ? { universeItemId: itemId } : {}),
        detail: `observed ${observation.effect} cannot satisfy expected ${expected.effect}`,
      });
      return false;
    }
    if (!coverageSatisfied(expected, observation)) {
      addGap(gaps, {
        kind: 'coverage_unproven',
        requirementId: expected.id,
        observedOperationId: observation.id,
        ...(itemId ? { universeItemId: itemId } : {}),
        detail: 'host-derived evidence mode and coverage do not prove the expected read',
      });
      return false;
    }
    return true;
  };

  for (const expected of contract.operations) {
    const explicit = explicitByRequirement.get(expected.id) ?? [];
    if (expected.cardinality.kind === 'once') {
      let candidates = explicit;
      if (candidates.length === 0 && implicitRetrieve && expected.effect === 'read') {
        const compatible = unbound.filter((observation) => observation.effect === 'read');
        // Implicit binding exists only for the deterministic one-read route,
        // and even there it must be unique. Choosing the first successful or
        // evidenced call would let two distinct reads arbitrarily discharge
        // one requirement while hiding the other as an informational extra.
        // Exact retry/progress dedupe belongs in the durable projector before
        // it constructs this closed observed history.
        candidates = compatible;
      }
      if (candidates.length === 0) {
        addGap(gaps, {
          kind: 'requirement_unobserved',
          requirementId: expected.id,
          detail: 'no observed operation is bound to this expected requirement',
        });
        instances.set(instanceKey(expected.id), { operation: expected, basicSatisfied: false });
        continue;
      }
      if (candidates.length !== 1) {
        for (const candidate of candidates) usedObservationIds.add(candidate.id);
        addGap(gaps, {
          kind: 'requirement_ambiguous',
          requirementId: expected.id,
          detail: 'more than one observed operation claims a once-cardinality requirement',
        });
        instances.set(instanceKey(expected.id), { operation: expected, basicSatisfied: false });
        continue;
      }
      const observation = candidates[0]!;
      instances.set(instanceKey(expected.id), {
        operation: expected,
        observation,
        basicSatisfied: validateObservation(expected, observation),
      });
      continue;
    }

    if (expected.cardinality.kind === 'set') {
      const universeId = expected.cardinality.universeId;
      if (!universes.has(universeId)) continue;
      for (const candidate of explicit) usedObservationIds.add(candidate.id);
      if (explicit.length === 0) {
        addGap(gaps, {
          kind: 'requirement_unobserved',
          requirementId: expected.id,
          universeId,
          detail: 'no finite-set observation is bound to this expected requirement',
        });
        instances.set(instanceKey(expected.id), { operation: expected, basicSatisfied: false });
        continue;
      }
      if (explicit.length !== 1 || explicit[0]?.universeItemId) {
        addGap(gaps, {
          kind: 'requirement_ambiguous',
          requirementId: expected.id,
          universeId,
          detail: 'set cardinality requires exactly one full-set observation with no item identity',
        });
        instances.set(instanceKey(expected.id), { operation: expected, basicSatisfied: false });
        continue;
      }
      const observation = explicit[0]!;
      instances.set(instanceKey(expected.id), {
        operation: expected,
        observation,
        basicSatisfied: validateObservation(expected, observation),
      });
      continue;
    }

    const universeId = expected.cardinality.universeId;
    const members = universes.get(universeId);
    if (!members) continue;
    const byItem = new Map<string, ObservedExpectedWorkOperationV1[]>();
    for (const observation of explicit) {
      usedObservationIds.add(observation.id);
      if (!observation.universeItemId) {
        addGap(gaps, {
          kind: 'universe_item_missing',
          requirementId: expected.id,
          observedOperationId: observation.id,
          universeId,
          detail: 'each-cardinality observation has no universe item identity',
        });
        continue;
      }
      if (!members.includes(observation.universeItemId)) {
        addGap(gaps, {
          kind: 'universe_item_unknown',
          requirementId: expected.id,
          observedOperationId: observation.id,
          universeId,
          universeItemId: observation.universeItemId,
          detail: 'observation names an item outside the sealed universe',
        });
        continue;
      }
      const entries = byItem.get(observation.universeItemId) ?? [];
      entries.push(observation);
      byItem.set(observation.universeItemId, entries);
    }
    for (const itemId of members) {
      const candidates = byItem.get(itemId) ?? [];
      if (candidates.length === 0) {
        addGap(gaps, {
          kind: 'cardinality_item_missing',
          requirementId: expected.id,
          universeId,
          universeItemId: itemId,
          detail: 'sealed universe item has no bound observed operation',
        });
        instances.set(instanceKey(expected.id, itemId), {
          operation: expected,
          itemId,
          basicSatisfied: false,
        });
        continue;
      }
      if (candidates.length !== 1) {
        addGap(gaps, {
          kind: 'cardinality_item_ambiguous',
          requirementId: expected.id,
          universeId,
          universeItemId: itemId,
          detail: 'more than one observation claims the same requirement and universe item',
        });
        instances.set(instanceKey(expected.id, itemId), {
          operation: expected,
          itemId,
          basicSatisfied: false,
        });
        continue;
      }
      const observation = candidates[0]!;
      instances.set(instanceKey(expected.id, itemId), {
        operation: expected,
        itemId,
        observation,
        basicSatisfied: validateObservation(expected, observation, itemId),
      });
    }
  }

  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const fullySatisfied = (instance: RequirementInstance): boolean => {
    const key = instanceKey(instance.operation.id, instance.itemId);
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(key) || !instance.basicSatisfied) return false;
    visiting.add(key);
    let dependenciesOk = true;
    for (const dependencyId of instance.operation.dependsOn) {
      const dependency = expectedById.get(dependencyId);
      if (!dependency) {
        dependenciesOk = false;
        continue;
      }
      if (dependency.cardinality.kind === 'once') {
        const dependencyInstance = instances.get(instanceKey(dependency.id));
        if (!dependencyInstance || !fullySatisfied(dependencyInstance)) dependenciesOk = false;
      } else if (
        instance.itemId
        && instance.operation.cardinality.kind === 'each'
        && instance.operation.cardinality.universeId === dependency.cardinality.universeId
      ) {
        const dependencyInstance = instances.get(instanceKey(dependency.id, instance.itemId));
        if (!dependencyInstance || !fullySatisfied(dependencyInstance)) dependenciesOk = false;
      } else {
        const dependencyInstances = [...instances.values()]
          .filter((candidate) => candidate.operation.id === dependency.id);
        if (
          dependencyInstances.length === 0
          || dependencyInstances.some((candidate) => !fullySatisfied(candidate))
        ) dependenciesOk = false;
      }
    }
    visiting.delete(key);
    memo.set(key, dependenciesOk);
    return dependenciesOk;
  };

  for (const instance of instances.values()) {
    if (!instance.observation || !instance.basicSatisfied) continue;
    if (!fullySatisfied(instance)) {
      addGap(gaps, {
        kind: 'dependency_unsatisfied',
        requirementId: instance.operation.id,
        observedOperationId: instance.observation.id,
        ...(instance.operation.cardinality.kind === 'each'
          ? { universeId: instance.operation.cardinality.universeId }
          : {}),
        ...(instance.itemId ? { universeItemId: instance.itemId } : {}),
        detail: 'one or more expected dependencies are absent or unproved',
      });
    }
  }

  // A source-derived universe cannot become authority merely because a seal
  // row exists; its declared producer requirement must itself be fully proved.
  for (const universe of contract.universes) {
    if (universe.seal !== 'complete_source_receipt' || !universes.has(universe.id)) continue;
    const producer = instances.get(instanceKey(universe.producedBy));
    if (!producer || !fullySatisfied(producer)) {
      addGap(gaps, {
        kind: 'universe_unsealed',
        universeId: universe.id,
        requirementId: universe.producedBy,
        detail: 'the source-derived universe producer is not fully proved',
      });
    }
  }

  const extras = history.operations
    .filter((observation) => !usedObservationIds.has(observation.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const observation of extras) {
    if (
      observation.effect === 'local_write'
      || observation.effect === 'external_write'
      || observation.effect === 'admin'
      || observation.effect === 'unknown'
    ) {
      addGap(gaps, {
        kind: 'unexpected_effectful_observation',
        observedOperationId: observation.id,
        detail: 'an unbound effectful business operation is outside the closed expected work',
      });
    }
  }
  if (contract.operations.length === 0 && history.operations.length > 0) {
    addGap(gaps, {
      kind: 'observation_identity_conflict',
      detail: 'a zero-operation conversation observed unexpected business work',
    });
  }
  const conflict = gaps.some((gap) => CONFLICT_GAPS.has(gap.kind));
  return {
    status: conflict ? 'conflict' : gaps.length > 0 ? 'incomplete' : 'complete',
    bindings: bindings.sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId)
      || (left.universeItemId ?? '').localeCompare(right.universeItemId ?? '')
      || left.observedOperationId.localeCompare(right.observedOperationId)),
    gaps: gaps.sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || (left.requirementId ?? '').localeCompare(right.requirementId ?? '')
      || (left.universeItemId ?? '').localeCompare(right.universeItemId ?? '')),
    extras: extras.map((observation) => observation.id),
  };
}
