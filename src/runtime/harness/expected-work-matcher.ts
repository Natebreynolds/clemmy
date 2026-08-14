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
  /** Host-classified reversibility of the observed call. Only an IRREVERSIBLE
   * effect can make an off-plan observation a contract violation: redoing a
   * reversible write is correctable, so extra reversible work is extra work,
   * not a broken plan. Absent on legacy projections (treated as unknown). */
  reversibility?: 'read_only' | 'reversible' | 'irreversible' | 'not_applicable' | 'unknown';
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

/**
 * The deterministic retrieve route freezes exactly one once-cardinality read
 * with resolved-operation coverage and no universes. Only this shape may bind
 * its single observation implicitly, and only this shape may accept a local
 * compute execution as the read's carrier: the contract demands "one grounded
 * successful retrieval", not a particular transport.
 */
export function isDeterministicImplicitRetrieveContract(
  contract: AcceptedTaskWorkContractV1,
): boolean {
  if (contract.plannerSource !== 'deterministic' || contract.operations.length !== 1) return false;
  const operation = contract.operations[0]!;
  return operation.effect === 'read'
    && operation.coverage === 'resolved_operation'
    && operation.cardinality.kind === 'once'
    && contract.universes.length === 0;
}

/**
 * Whether a redeemed local/compute payload carries any answer-bearing content
 * beyond envelope bookkeeping. A bare success acknowledgement discharges
 * nothing: an empty result cannot ground a retrieval.
 */
export function computeResultHasSubstance(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return true;
  if (typeof value !== 'object') return false;
  const ignored = new Set([
    'success', 'successful', 'ok', 'status', 'statuscode', 'httpstatus',
    'message', 'meta', 'metadata', 'request', 'requestargs', 'requestbody',
    'requestparams', 'requestpayload',
  ]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ignored.has(normalized)) continue;
    if (computeResultHasSubstance(child, depth + 1)) return true;
  }
  return false;
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
    // Resolved-operation coverage promises one grounded retrieval, not an
    // exhaustive set. A point or collection read discharges it once durably
    // observed; only finite reads keep the complete bar, because their proof
    // IS the exact requested member set. complete_set/accepted_set above
    // never accept mere observation.
    return observed.evidenceMode === 'finite_read'
      ? observed.coverage === 'complete'
      : observed.coverage === 'observed' || observed.coverage === 'complete';
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
  const implicitRetrieve = isDeterministicImplicitRetrieveContract(contract);

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
    // The deterministic one-read route accepts a local compute execution as
    // the read's carrier: the safety taxonomy conservatively labels a
    // read-only CLI/shell invocation 'compute', and that label must not decide
    // semantic discharge (live 2026-08-11: a proven read-only CLI answer was
    // blocked as verification_required). Substance is still required below —
    // an envelope-only payload projects coverage 'not_applicable', never
    // 'observed'. Every other shape keeps exact effect equality.
    const computeCarriesImplicitRead = implicitRetrieve
      && expected.effect === 'read'
      && observation.effect === 'compute';
    if (observation.effect !== expected.effect && !computeCarriesImplicitRead) {
      addGap(gaps, {
        kind: 'effect_mismatch',
        requirementId: expected.id,
        observedOperationId: observation.id,
        ...(itemId ? { universeItemId: itemId } : {}),
        detail: `observed ${observation.effect} cannot satisfy expected ${expected.effect}`,
      });
      return false;
    }
    if (computeCarriesImplicitRead) {
      if (observation.coverage !== 'observed') {
        addGap(gaps, {
          kind: 'coverage_unproven',
          requirementId: expected.id,
          observedOperationId: observation.id,
          ...(itemId ? { universeItemId: itemId } : {}),
          detail: 'the local execution left no substantive redeemable result to ground the retrieval',
        });
        return false;
      }
      return true;
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
        const compatible = unbound.filter((observation) =>
          observation.effect === 'read' || observation.effect === 'compute');
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
        // TWO CLAIMS ON ONE `once` REQUIREMENT IS ONLY DANGEROUS WHEN REDOING IT
        // IS UNFIXABLE. For an irreversible effect it may be a double send, so
        // it stays a conflict. For a reversible one it usually means the model
        // took two calls to do a single planned thing (create the sheet, then
        // write its rows) — real, settled, evidenced work that the plan's
        // cardinality simply did not anticipate. Refusing it blocked a turn
        // whose sheet was already built and verified (live 2026-08-12). Take
        // the single successful observation; the rest stay visible as extras.
        const irreversibleClaim = candidates.some((candidate) =>
          candidate.reversibility === 'irreversible' || candidate.reversibility === 'unknown');
        const successful = candidates.filter((candidate) => candidate.outcome === 'succeeded');
        if (irreversibleClaim || successful.length !== 1) {
          addGap(gaps, {
            kind: 'requirement_ambiguous',
            requirementId: expected.id,
            detail: 'more than one observed operation claims a once-cardinality requirement',
          });
          instances.set(instanceKey(expected.id), { operation: expected, basicSatisfied: false });
          continue;
        }
        const settled = successful[0]!;
        instances.set(instanceKey(expected.id), {
          operation: expected,
          observation: settled,
          basicSatisfied: validateObservation(expected, settled),
        });
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
      (observation.effect === 'local_write'
        || observation.effect === 'external_write'
        || observation.effect === 'admin'
        || observation.effect === 'unknown')
      // Only work that actually SUCCEEDED conflicts with the closed contract.
      // A refused/failed attempt (a pre-dispatch carrier rejection, a write
      // whose crossing never happened) already changed nothing — the gates
      // that stopped it did their job, and blocking a correct answer over its
      // bookkeeping row punished the turn for being refused (routing-sweep
      // fixture, 2026-08-12: an arg-validation call_tool refusal projected as
      // a failed external_write and conflicted an otherwise complete
      // retrieve). Real dispatched writes keep their crossing, project
      // 'succeeded', and conflict exactly as before; write-truth audit
      // separately owns uncertain writes.
      && observation.outcome === 'succeeded'
      // ...and only when redoing it could not be corrected. A reversible
      // external write off the plan (a second sheet update, a re-created doc)
      // is EXTRA WORK, not a broken contract: it is durably settled, evidenced,
      // and fixable. Conflicting on it refused a turn that had scraped the
      // data, created the sheet, written the rows, and verified them (live
      // 2026-08-12). An irreversible off-plan effect stays a conflict — that
      // is the case the closed contract exists to catch.
      && observation.reversibility !== 'reversible'
      && observation.reversibility !== 'read_only'
      && observation.reversibility !== 'not_applicable'
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
