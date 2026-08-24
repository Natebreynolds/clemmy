/**
 * The sole provider-neutral decision for whether an admitted call needs a
 * human interaction before execution.
 *
 * This module is deliberately pure. It does not inspect prose, tool names,
 * providers, PlanScope, environment policy, or storage. Adapters must first
 * re-open the exact accepted-work and logical-call facts and project them into
 * these closed structural values. A missing or stale fact is a repair outcome,
 * never a fabricated approval question.
 */

export const INTERACTIVE_CONSENT_POLICY_VERSION = 1 as const;

export type InteractiveConsentEffect =
  | 'read'
  | 'compute'
  | 'host_only'
  | 'local_write'
  | 'external_write'
  | 'admin';

export type InteractiveConsentReversibility =
  | 'read_only'
  | 'reversible'
  /**
   * A current capability definition structurally proves an ordinary create or
   * update, with no destructive, delivery, or administrative evidence. This
   * is deliberately NOT called reversible: a schema and an operation verb do
   * not prove that the provider can restore the prior state.
   */
  | 'ordinary_non_destructive'
  | 'irreversible'
  | 'unknown';

export type InteractiveConsentConsequence =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'send'
  | 'execute'
  | 'admin'
  | 'unknown';

export type InteractiveConsentCardinality =
  | { kind: 'once' }
  | { kind: 'each'; universeDigest: string }
  | { kind: 'set'; universeDigest: string };

export interface InteractiveConsentDestination {
  digest: string;
  posture: 'create_new' | 'named_existing' | 'not_applicable';
}

/** Current, host-minted identity and risk facts for the exact resolved call. */
export interface CapabilityRiskAttestationV1 {
  version: typeof INTERACTIVE_CONSENT_POLICY_VERSION;
  source: {
    kind: 'accepted_turn' | 'workflow_activation' | 'workspace_action';
    id: string;
    digest: string;
  };
  acceptedTaskId: string;
  bindingDigest: string;
  logicalToolCallId: string;
  operationId: string;
  argumentDigest: string;
  schemaFingerprint: string;
  effect: InteractiveConsentEffect;
  accountId: string | null;
  destination: InteractiveConsentDestination;
  cardinality: InteractiveConsentCardinality;
  risk: {
    reversibility: InteractiveConsentReversibility;
    consequence: InteractiveConsentConsequence;
    destructive: boolean;
  };
  semanticBasis: {
    kind:
      | 'local_registry'
      | 'documented_live_capability'
      | 'current_external_definition'
      | 'reviewed_cli';
    digest: string;
  };
  safety: 'admissible' | 'protected' | 'untrusted';
}

/**
 * Exact accepted-work coverage is split intentionally:
 *
 * - `semanticScope` was frozen before the work-emitting model step.
 * - `callBinding` is the later logical admission that binds the model-filled
 *   arguments to that already-frozen operation.
 *
 * Foreground plans do not contain business arguments today. Requiring them to
 * be frozen before the model call would be ceremony the real path cannot
 * satisfy. Letting the model mint semanticScope at call time would instead be
 * self-authorization. Both halves must match here.
 */
export interface ExactWorkCoverageV1 {
  version: typeof INTERACTIVE_CONSENT_POLICY_VERSION;
  source: {
    kind: 'accepted_turn' | 'workflow_activation' | 'workspace_action';
    id: string;
    digest: string;
  };
  acceptedTaskId: string;
  contractId: string;
  requirementId: string;
  requirementDigest: string;
  semanticScope: {
    operationId: string;
    schemaFingerprint: string;
    effect: InteractiveConsentEffect;
    accountId: string | null;
    destination: InteractiveConsentDestination;
    cardinality: InteractiveConsentCardinality;
    semanticBasis: CapabilityRiskAttestationV1['semanticBasis'];
  };
  callBinding: {
    logicalToolCallId: string;
    argumentDigest: string;
    bindingDigest: string;
  };
  /** Host-derived occurrence identity. For `each`, this includes the exact
   * universe member; for `set`, the exact sealed set. Models never supply it. */
  reservationKey: string;
}

/** Exact durable consent for a high-consequence call. Wildcards are absent. */
export interface ExactUserGrantV1 {
  version: typeof INTERACTIVE_CONSENT_POLICY_VERSION;
  source: 'accepted_explicit_scope' | 'approval_resolution' | 'standing_workflow_scope';
  grantDigest: string;
  scope: {
    source: CapabilityRiskAttestationV1['source'];
    acceptedTaskId: string;
    logicalToolCallId: string;
    bindingDigest: string;
    operationId: string;
    argumentDigest: string;
    schemaFingerprint: string;
    effect: InteractiveConsentEffect;
    accountId: string | null;
    destination: InteractiveConsentDestination;
    cardinality: InteractiveConsentCardinality;
    risk: CapabilityRiskAttestationV1['risk'];
    semanticBasis: CapabilityRiskAttestationV1['semanticBasis'];
  };
}

export type InteractiveConsentReadiness =
  | { kind: 'ready' }
  | { kind: 'credential_missing'; connectionRef: string }
  | { kind: 'choice_required'; field: 'account' | 'destination' | 'target'; candidates: string[] }
  | { kind: 'essential_input'; slot: string }
  | { kind: 'invalid'; reason: string };

export type InteractiveConsentCrossing =
  | 'not_started'
  | 'started'
  | 'settled'
  | 'possibly_started';

export type InteractiveConsentDecisionV1 =
  | {
      kind: 'proceed';
      basis:
        | 'no_effect'
        | 'exact_reversible_work'
        | 'exact_ordinary_work'
        | 'exact_user_grant'
        | 'settled_replay';
      authorityDigest: string;
      reservationKey?: string;
    }
  | {
      kind: 'needs_user';
      need: 'approval' | 'credential' | 'choice' | 'essential_input';
      subjectDigest: string;
      reason: string;
    }
  | {
      kind: 'repair';
      reason:
        | 'coverage_missing'
        | 'scope_mismatch'
        | 'risk_unknown'
        | 'schema_stale'
        | 'authority_conflict'
        | 'cardinality_spent';
    }
  | { kind: 'reconcile'; reason: 'possible_effect'; retry: 'never_blind' }
  | {
      kind: 'refuse';
      reason: 'protected_target' | 'untrusted_execution' | 'malformed_call' | 'policy_denied';
    };

export interface EvaluateInteractiveConsentInputV1 {
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1 | null;
  userGrant: ExactUserGrantV1 | null;
  readiness: InteractiveConsentReadiness;
  crossing: InteractiveConsentCrossing;
  explicitHumanCheckpoint?: { subjectDigest: string };
  reservationAlreadyClaimed: boolean;
}

function sameDestination(
  left: InteractiveConsentDestination,
  right: InteractiveConsentDestination,
): boolean {
  return left.digest === right.digest && left.posture === right.posture;
}

function sameCardinality(
  left: InteractiveConsentCardinality,
  right: InteractiveConsentCardinality,
): boolean {
  return left.kind === right.kind
    && (left.kind === 'once'
      || (right.kind !== 'once' && left.universeDigest === right.universeDigest));
}

function exactCoverageMatches(
  call: CapabilityRiskAttestationV1,
  coverage: ExactWorkCoverageV1,
): boolean {
  const scope = coverage.semanticScope;
  const binding = coverage.callBinding;
  return coverage.source.kind === call.source.kind
    && coverage.source.id === call.source.id
    && coverage.source.digest === call.source.digest
    && coverage.acceptedTaskId === call.acceptedTaskId
    && scope.operationId === call.operationId
    && scope.schemaFingerprint === call.schemaFingerprint
    && scope.effect === call.effect
    && scope.accountId === call.accountId
    && sameDestination(scope.destination, call.destination)
    && sameCardinality(scope.cardinality, call.cardinality)
    && scope.semanticBasis.kind === call.semanticBasis.kind
    && scope.semanticBasis.digest === call.semanticBasis.digest
    && binding.logicalToolCallId === call.logicalToolCallId
    && binding.argumentDigest === call.argumentDigest
    && binding.bindingDigest === call.bindingDigest;
}

function exactGrantMatches(
  call: CapabilityRiskAttestationV1,
  grant: ExactUserGrantV1,
): boolean {
  const scope = grant.scope;
  return scope.source.kind === call.source.kind
    && scope.source.id === call.source.id
    && scope.source.digest === call.source.digest
    && scope.acceptedTaskId === call.acceptedTaskId
    && scope.logicalToolCallId === call.logicalToolCallId
    && scope.bindingDigest === call.bindingDigest
    && scope.operationId === call.operationId
    && scope.argumentDigest === call.argumentDigest
    && scope.schemaFingerprint === call.schemaFingerprint
    && scope.effect === call.effect
    && scope.accountId === call.accountId
    && sameDestination(scope.destination, call.destination)
    && sameCardinality(scope.cardinality, call.cardinality)
    && scope.risk.reversibility === call.risk.reversibility
    && scope.risk.consequence === call.risk.consequence
    && scope.risk.destructive === call.risk.destructive
    && scope.semanticBasis.kind === call.semanticBasis.kind
    && scope.semanticBasis.digest === call.semanticBasis.digest;
}

/**
 * Decide only whether this exact call needs human interaction. Execution,
 * retries, settlement, and presentation remain owned by their existing
 * kernels. Every adapter receives the same discriminated result.
 */
export function evaluateInteractiveConsentV1(
  input: EvaluateInteractiveConsentInputV1,
): InteractiveConsentDecisionV1 {
  const { call } = input;

  if (call.safety === 'protected') return { kind: 'refuse', reason: 'protected_target' };
  if (call.safety === 'untrusted') return { kind: 'refuse', reason: 'untrusted_execution' };

  if (input.crossing === 'started' || input.crossing === 'possibly_started') {
    return { kind: 'reconcile', reason: 'possible_effect', retry: 'never_blind' };
  }

  // A completed call is replayed from its exact settlement. Current readiness
  // (for example a connection removed after success) cannot create a new human
  // gate or authorize another dispatch.
  if (input.crossing === 'settled') {
    return {
      kind: 'proceed',
      basis: 'settled_replay',
      authorityDigest: call.bindingDigest,
    };
  }

  switch (input.readiness.kind) {
    case 'credential_missing':
      return {
        kind: 'needs_user',
        need: 'credential',
        subjectDigest: input.readiness.connectionRef,
        reason: 'The required connection is not available.',
      };
    case 'choice_required':
      return {
        kind: 'needs_user',
        need: 'choice',
        subjectDigest: call.bindingDigest,
        reason: `The accepted request does not uniquely identify ${input.readiness.field}.`,
      };
    case 'essential_input':
      return {
        kind: 'needs_user',
        need: 'essential_input',
        subjectDigest: call.bindingDigest,
        reason: `The accepted request is missing required input ${input.readiness.slot}.`,
      };
    case 'invalid':
      return { kind: 'repair', reason: 'authority_conflict' };
    case 'ready':
      break;
  }

  // An explicit workflow/user checkpoint is an exact human-owned gate even
  // when the underlying operation is read-only. Its exact resolution may be
  // redeemed once; ordinary reads carry no implicit checkpoint.
  if (input.explicitHumanCheckpoint) {
    if (input.userGrant && !exactGrantMatches(call, input.userGrant)) {
      return { kind: 'repair', reason: 'scope_mismatch' };
    }
    if (input.userGrant) {
      return {
        kind: 'proceed',
        basis: 'exact_user_grant',
        authorityDigest: input.userGrant.grantDigest,
      };
    }
    return {
      kind: 'needs_user',
      need: 'approval',
      subjectDigest: input.explicitHumanCheckpoint.subjectDigest,
      reason: 'This accepted workflow explicitly requires a human checkpoint.',
    };
  }

  const noExternalEffect = call.effect === 'read'
    || call.effect === 'compute'
    || call.effect === 'host_only';
  const contradictsNoEffect = call.risk.destructive
    || call.risk.reversibility === 'irreversible'
    || call.risk.consequence === 'send'
    || call.risk.consequence === 'delete'
    || call.risk.consequence === 'admin';
  // Effect and risk are independently attested. Never let a stale/buggy
  // `read` projection erase affirmative high-consequence evidence (the old
  // classifiers produced the impossible state nonmutating + irreversible for
  // GET_POST-style reads). This is an authority defect to repair, not work to
  // execute and not an approval question for the user.
  if (noExternalEffect && contradictsNoEffect) {
    return { kind: 'repair', reason: 'authority_conflict' };
  }

  if (noExternalEffect) {
    return {
      kind: 'proceed',
      basis: 'no_effect',
      authorityDigest: call.bindingDigest,
    };
  }

  // Every mutation must first belong to exact accepted work. A surprise
  // model-authored write is a planning defect to repair, not a permission
  // question to hand to the user.
  if (!input.coverage) return { kind: 'repair', reason: 'coverage_missing' };
  if (!exactCoverageMatches(call, input.coverage)) return { kind: 'repair', reason: 'scope_mismatch' };
  if (input.reservationAlreadyClaimed) return { kind: 'repair', reason: 'cardinality_spent' };

  const grantMatches = input.userGrant !== null && exactGrantMatches(call, input.userGrant);
  if (input.userGrant && !grantMatches) return { kind: 'repair', reason: 'scope_mismatch' };
  if (grantMatches) {
    return {
      kind: 'proceed',
      basis: 'exact_user_grant',
      authorityDigest: input.userGrant!.grantDigest,
      reservationKey: input.coverage.reservationKey,
    };
  }

  // Consequence is independently load-bearing. An adapter bug must not turn a
  // SEND or DELETE into ordinary work merely by projecting its reversibility
  // as ordinary/unknown. Conversely, exact coverage is checked above so a
  // surprise high-consequence mutation repairs to the model instead of
  // manufacturing an approval question for work the user never accepted.
  const highConsequence = call.effect === 'admin'
    || call.risk.destructive
    || call.risk.reversibility === 'irreversible'
    || call.risk.consequence === 'send'
    || call.risk.consequence === 'delete'
    || call.risk.consequence === 'admin';
  if (highConsequence) {
    return {
      kind: 'needs_user',
      need: 'approval',
      subjectDigest: call.bindingDigest,
      reason: 'This exact accepted call is destructive, irreversible, or administrative.',
    };
  }

  // A genuinely mixed or noun-shaped mutation is a planning/retrieval defect,
  // not a reason to ask the user for blind permission. It reaches this branch
  // only after exact accepted-work coverage was re-opened above.
  if (call.risk.reversibility === 'unknown' || call.risk.consequence === 'unknown') {
    return { kind: 'repair', reason: 'risk_unknown' };
  }

  if (
    call.risk.reversibility !== 'reversible'
    && call.risk.reversibility !== 'ordinary_non_destructive'
  ) {
    return { kind: 'repair', reason: 'scope_mismatch' };
  }

  return {
    kind: 'proceed',
    basis: call.risk.reversibility === 'reversible'
      ? 'exact_reversible_work'
      : 'exact_ordinary_work',
    authorityDigest: input.coverage.requirementDigest,
    reservationKey: input.coverage.reservationKey,
  };
}
