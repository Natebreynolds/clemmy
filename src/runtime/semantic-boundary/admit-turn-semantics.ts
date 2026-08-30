/**
 * Atomic host boundary: validate → clamp → admit → compile.
 *
 * The sealer is not exported. Requested effects are never authority.
 * Standing policy is a maximum ceiling, not a write mandate.
 */
import { validateWorkTopology, workTopologyDigest } from '../graph/work-topology.js';
import {
  type AdmittedClampedSemanticsV1,
  type AdmittedTurnSemantics,
} from '../graph/admitted-turn-semantics.js';
import type { TurnGraphAwaitInput, TurnGraphRoute } from '../graph/turn-graph-ir.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import {
  projectCheckedSemantics,
  type SemanticProjectionV1,
} from './project-checked-semantics.js';
import {
  isContextCheckedTurnSemanticProposalV1,
  validateTurnSemanticProposalV1,
  type TurnSemanticHostViewV1,
  type TurnSemanticValidationIssue,
} from './turn-semantic-proposal.js';
import {
  peekCapabilityManifestStore,
  resolveCurrentSuccessorManifest,
} from '../harness/capability-manifest-store.js';

function bindCapabilityRefToSuccessor(capabilityRef: string): string {
  const store = peekCapabilityManifestStore();
  if (!store) return capabilityRef;
  return resolveCurrentSuccessorManifest(store, capabilityRef)?.manifest.manifestId ?? capabilityRef;
}

export type { AdmittedTurnSemantics, AdmittedClampedSemanticsV1 } from '../graph/admitted-turn-semantics.js';

const EFFECT_RANK: Record<string, number> = {
  none: 0,
  host_only: 1,
  read: 1,
  compute: 1,
  unknown: 2,
  local_write: 3,
  external_write: 4,
  admin: 5,
};

const WRITE_EFFECTS = new Set<RuntimeToolEffect>(['local_write', 'external_write', 'admin']);

export interface HostSemanticAuthorityV1 {
  policyRevision: string;
  /** Independently loaded audience digest. Must match the host view. */
  audienceHash: string;
  /** Standing policy maximum. Never evidence that this source requested a write. */
  policyMaxCeiling: RuntimeToolEffect | 'none';
  allowedEffects: ReadonlyArray<RuntimeToolEffect | 'none'>;
  /**
   * Exact Clementine-local capability refs that survived current registry,
   * schema, carrier, and envelope revalidation for this accepted source.
   *
   * A local definition edit has no provider destination manifest by design:
   * its target is carried by the validated tool arguments and reopened again
   * at dispatch.  This set is therefore the only destinationless-write
   * exception.  A `cap:local:`-looking model string is never sufficient.
   */
  revalidatedLocalCapabilityRefs?: ReadonlySet<string>;
  /** Existing exact mandate on a resumable goal, if any. */
  sourceMandate?: {
    goalId: string;
    revision: number;
    effectCeiling: RuntimeToolEffect | 'none';
  };
}

export type AdmitTurnSemanticsResult =
  | {
      ok: true;
      source: AdmittedTurnSemantics['source'];
      policyRevision: string;
      clamped: AdmittedClampedSemanticsV1;
      payloadHash: string;
      contextHash: string;
    }
  | { ok: false; issues: TurnSemanticValidationIssue[] };

function issue(
  issues: TurnSemanticValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function rank(effect: string): number {
  return EFFECT_RANK[effect] ?? EFFECT_RANK.unknown;
}

/**
 * Shape-only alignment plus one host-owned local-envelope exception. The
 * proposal's requestedEffect and capability spelling are never proof.
 */
function writeAligned(
  projection: SemanticProjectionV1,
  authority: HostSemanticAuthorityV1,
): boolean {
  const work = projection.goal;
  if (!work || work.construct === 'none') return false;
  if (work.destination) return true;
  if (work.requestedEffect !== 'local_write') return false;
  const revalidated = authority.revalidatedLocalCapabilityRefs;
  if (!revalidated || revalidated.size === 0) return false;
  const writeRefs = work.operations
    .filter((operation) => WRITE_EFFECTS.has(operation.requestedEffect as RuntimeToolEffect))
    .map((operation) => operation.capabilityRef);
  return writeRefs.length > 0 && writeRefs.every((ref) => (
    typeof ref === 'string' && revalidated.has(ref)
  ));
}

function mandateAllowsWrite(authority: HostSemanticAuthorityV1, projection: SemanticProjectionV1): boolean {
  const mandate = authority.sourceMandate;
  if (!mandate || !WRITE_EFFECTS.has(mandate.effectCeiling as RuntimeToolEffect)) return false;
  const target = projection.targetGoal;
  return target !== null
    && target.goalId === mandate.goalId
    && target.baseRevision === mandate.revision;
}

/**
 * Clamp a requested effect against independently loaded host authority.
 * Unknown never becomes read by omission. An ordinary read is not refused
 * merely because the prior host ceiling was unknown.
 */
export function clampRequestedEffect(
  requested: RuntimeToolEffect | 'none',
  authority: HostSemanticAuthorityV1,
  projection: SemanticProjectionV1,
): { effect: RuntimeToolEffect | 'none'; refuse?: string } {
  if (requested === 'read') {
    if (authority.allowedEffects.includes('read') || authority.allowedEffects.includes('unknown')) {
      return { effect: 'read' };
    }
    return { effect: 'read' };
  }
  if (requested === 'none') return { effect: 'none' };
  if (requested === 'compute') return { effect: 'compute' };
  if (requested === 'host_only') return { effect: 'host_only' };
  if (requested === 'unknown') return { effect: 'unknown' };
  if (WRITE_EFFECTS.has(requested as RuntimeToolEffect)) {
    const aligned = writeAligned(projection, authority) || mandateAllowsWrite(authority, projection);
    if (!aligned) return { effect: 'none', refuse: 'write_not_aligned' };
    if (!authority.allowedEffects.includes(requested)) {
      return { effect: requested, refuse: 'write_not_in_policy' };
    }
    if (rank(requested) > rank(authority.policyMaxCeiling)) {
      return { effect: requested, refuse: 'effect_exceeds_policy' };
    }
    return { effect: requested };
  }
  return { effect: 'unknown' };
}

function routeFromClamped(clamped: Omit<AdmittedClampedSemanticsV1, 'route'>): TurnGraphRoute {
  if (clamped.kind === 'conversation' || clamped.kind === 'keep_slot_open') return 'direct_reply';
  if (clamped.construct !== 'none') return 'act';
  if (
    clamped.effectCeiling === 'external_write'
    || clamped.effectCeiling === 'local_write'
    || clamped.effectCeiling === 'admin'
  ) return 'act';
  if (clamped.effectCeiling === 'read') return 'retrieve';
  return 'direct_reply';
}

function openSlotFromHost(
  host: TurnSemanticHostViewV1,
  projection: SemanticProjectionV1,
): TurnGraphAwaitInput | undefined {
  if (projection.kind !== 'keep_slot_open') return undefined;
  const target = projection.targetGoal;
  const question = host.openQuestions.find((candidate) => (
    target !== null
    && candidate.goalId === target.goalId
    && candidate.goalRevision === target.baseRevision
  ));
  if (!question) return undefined;
  return {
    goalId: question.goalId,
    revision: question.goalRevision,
    questionId: question.questionId,
    slotId: question.slotKey,
    deliveredQuestion: question.question,
    visibleOptions: question.options.map((option) => ({ ...option })),
    predecessorRefs: target ? host.resumableGoals.find((goal) => (
      goal.goalId === target.goalId && goal.baseRevision === target.baseRevision
    ))?.settledEvidenceRefs : undefined,
  };
}

function bindIdentity(
  host: TurnSemanticHostViewV1,
  authority: HostSemanticAuthorityV1,
): TurnSemanticValidationIssue[] {
  const issues: TurnSemanticValidationIssue[] = [];
  if (host.policyRevision !== authority.policyRevision) {
    issue(issues, 'policy_revision_mismatch', 'host.policyRevision', 'host view policy revision does not match independently loaded authority');
  }
  if (host.source.audienceHash !== authority.audienceHash) {
    issue(issues, 'audience_mismatch', 'host.source.audienceHash', 'host audience does not match independently loaded audience identity');
  }
  return issues;
}

function clampProjection(
  projection: SemanticProjectionV1,
  host: TurnSemanticHostViewV1,
  authority: HostSemanticAuthorityV1,
): { clamped: AdmittedClampedSemanticsV1 } | { issues: TurnSemanticValidationIssue[] } {
  const requested = projection.goal?.requestedEffect ?? 'none';
  const clampedEffect = clampRequestedEffect(requested, authority, projection);
  if (clampedEffect.refuse) {
    return {
      issues: [{
        code: clampedEffect.refuse,
        path: 'work.requestedEffect',
        message: 'consequential effect requires typed goal alignment or an exact mandate',
      }],
    };
  }
  const inheritedGoal = host.resumableGoals.find((goal) => (
    projection.targetGoal !== null
    && goal.goalId === projection.targetGoal.goalId
    && goal.baseRevision === projection.targetGoal.baseRevision
  ));
  const construct = projection.goal?.construct ?? 'none';
  const slot = projection.slotAnswer;
  const withoutRoute: Omit<AdmittedClampedSemanticsV1, 'route'> = {
    kind: projection.kind,
    construct,
    ...(projection.goal?.collection ? { collection: projection.goal.collection } : {}),
    ...(projection.goal?.destinations?.length
      ? { destinations: projection.goal.destinations.map((entry) => ({ ...entry })) }
      : {}),
    ...(projection.goal?.destination ? { destination: projection.goal.destination } : {}),
    effectCeiling: clampedEffect.effect,
    requestedEffect: requested,
    goalId: projection.targetGoal?.goalId
      ?? (projection.kind === 'mint_goal'
        ? `goal:${host.source.sessionId}:${host.source.sourceUserSeq}`
        : inheritedGoal?.goalId),
    revision: projection.kind === 'amend_revision'
      ? (projection.targetGoal?.baseRevision ?? 0) + 1
      : (projection.targetGoal?.baseRevision
        ?? (projection.kind === 'mint_goal' ? 0 : inheritedGoal?.baseRevision)),
    ...(openSlotFromHost(host, projection) ? { openSlot: openSlotFromHost(host, projection) } : {}),
    ...(slot
      ? {
          slotAnswer: {
            kind: slot.kind,
            questionId: slot.questionId,
            slotKey: slot.slotKey,
            ...(slot.kind === 'option' ? { optionId: slot.optionId } : { value: slot.value }),
          },
        }
      : {}),
    ...(projection.goal?.operations?.length
      ? {
          operations: projection.goal.operations.map((operation) => {
            const canonical = reconcileOperationToTopology(operation, projection.goal?.topology);
            return {
              id: operation.id,
              role: operation.role,
              requestedEffect: canonical.requestedEffect,
              capabilityRef: bindCapabilityRefToSuccessor(operation.capabilityRef),
              dependsOn: canonical.dependsOn,
              evidence: [...operation.evidence],
            };
          }),
        }
      : {}),
    // HOST-OWNED DIGEST: derive it from the normalized topology rather than
    // requiring the model to supply one. Gating on the model's value dropped
    // the whole topology whenever it was absent, which silently discarded the
    // work a step had proposed.
    ...(projection.goal?.topology
      ? {
          workTopology: projection.goal.topology,
          workTopologyHash: admittedWorkTopologyDigest(projection.goal.topology),
        }
      : {}),
    ...(projection.goal?.evidenceRequirements
      ? { evidenceRequirements: [...projection.goal.evidenceRequirements] }
      : {}),
  };
  return {
    clamped: {
      ...withoutRoute,
      route: routeFromClamped(withoutRoute),
    },
  };
}

/**
 * Validate, project, and clamp. Not durable authority.
 */
/**
 * Reconcile one capability binding against the canonical topology.
 *
 * The topology is authoritative for lineage and for the operation's declared
 * effect; the binding only annotates it. Where they disagree:
 *   - `dependsOn` is taken from the topology (lineage is structure, not authority);
 *   - `requestedEffect` takes the MORE RESTRICTIVE of the two, so reconciling can
 *     never widen what the turn is allowed to do. The admitted-ceiling check
 *     downstream still applies on top of this.
 * With no topology present the binding stands unchanged.
 */
function reconcileOperationToTopology<E extends string>(
  operation: { requestedEffect: E; dependsOn: readonly string[]; id: string },
  topology: unknown,
): { requestedEffect: E; dependsOn: string[] } {
  const fallback = { requestedEffect: operation.requestedEffect, dependsOn: [...operation.dependsOn] };
  if (!topology) return fallback;
  const validated = validateWorkTopology(topology as never);
  if (!validated.ok) return fallback;
  const canonical = validated.topology.operations.find((entry) => entry.id === operation.id);
  if (!canonical) return fallback;
  const boundRank = EFFECT_RANK[operation.requestedEffect] ?? Number.POSITIVE_INFINITY;
  const canonicalRank = EFFECT_RANK[canonical.effect] ?? Number.POSITIVE_INFINITY;
  return {
    // Narrowing only: the canonical effect is adopted when it is at most as
    // permissive as the binding's. Never the other way round.
    requestedEffect: canonicalRank <= boundRank
      ? (canonical.effect as E)
      : operation.requestedEffect,
    dependsOn: [...canonical.dependsOn],
  };
}

/** The topology digest is host-owned. The proposal already passed
 * `validateWorkTopology`, so normalize once more here and digest the canonical
 * form — the same value the proposal validator compares a model-supplied hash
 * against, so a supplied-and-correct hash is unchanged and a supplied-and-wrong
 * one is still rejected upstream. */
function admittedWorkTopologyDigest(topology: unknown): string {
  const validated = validateWorkTopology(topology as never);
  return workTopologyDigest(validated.ok ? validated.topology : (topology as never));
}

export function admitTurnSemantics(
  raw: unknown,
  host: TurnSemanticHostViewV1,
  authority: HostSemanticAuthorityV1,
): AdmitTurnSemanticsResult {
  const identityIssues = bindIdentity(host, authority);
  if (identityIssues.length > 0) return { ok: false, issues: identityIssues };
  const checked = validateTurnSemanticProposalV1(raw, host);
  if (!checked.ok) return checked;
  if (!isContextCheckedTurnSemanticProposalV1(checked.checked)) {
    return { ok: false, issues: [{ code: 'not_checked', path: '', message: 'validator did not return a checked envelope' }] };
  }
  const projected = projectCheckedSemantics(checked.checked);
  if (!projected.ok) {
    return { ok: false, issues: [{ code: 'projection_failed', path: '', message: projected.reason }] };
  }
  const clamped = clampProjection(projected.projection, host, authority);
  if ('issues' in clamped) {
    return { ok: false, issues: clamped.issues };
  }
  const dagIssues = validateOperationDag(clamped.clamped.operations, clamped.clamped.effectCeiling);
  if (dagIssues.length > 0) return { ok: false, issues: dagIssues };
  return {
    ok: true,
    source: { ...checked.checked.source },
    policyRevision: host.policyRevision,
    clamped: clamped.clamped,
    payloadHash: checked.checked.payloadHash,
    contextHash: checked.checked.contextHash,
  };
}

function validateOperationDag(
  operations: AdmittedClampedSemanticsV1['operations'],
  effectCeiling: AdmittedClampedSemanticsV1['effectCeiling'],
): TurnSemanticValidationIssue[] {
  if (!operations || operations.length === 0) return [];
  const issues: TurnSemanticValidationIssue[] = [];
  const ids = operations.map((operation) => operation.id);
  if (new Set(ids).size !== ids.length) {
    issue(issues, 'duplicate_operation_id', 'work.operations', 'operation ids must be unique');
  }
  const known = new Set(ids);
  for (const operation of operations) {
    if (!operation.requestedEffect) {
      issue(issues, 'missing_effect', `work.operations.${operation.id}`, 'each operation must declare an effect');
    } else if (rank(operation.requestedEffect) > rank(effectCeiling)) {
      issue(
        issues,
        'effect_exceeds_ceiling',
        `work.operations.${operation.id}`,
        'operation effect exceeds the admitted graph ceiling and cannot be relabeled',
      );
    }
    for (const dep of operation.dependsOn) {
      if (!known.has(dep)) {
        issue(issues, 'unknown_dependency', `work.operations.${operation.id}`, `dependsOn references unknown operation ${dep}`);
      }
    }
  }
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const operation of operations) {
    for (const dep of operation.dependsOn) {
      if (!known.has(dep)) continue;
      outgoing.get(dep)?.push(operation.id);
      indegree.set(operation.id, (indegree.get(operation.id) ?? 0) + 1);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift() as string;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== ids.length) {
    issue(issues, 'cyclic_operations', 'work.operations', 'proposed operations must be acyclic');
  }
  return issues;
}
