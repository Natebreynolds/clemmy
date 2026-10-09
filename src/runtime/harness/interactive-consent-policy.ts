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

const REVERSIBILITY_VALUES: ReadonlySet<string> = new Set<InteractiveConsentReversibility>([
  'read_only', 'reversible', 'ordinary_non_destructive', 'irreversible', 'unknown',
]);
const CONSEQUENCE_VALUES: ReadonlySet<string> = new Set<InteractiveConsentConsequence>([
  'read', 'create', 'update', 'delete', 'send', 'execute', 'admin', 'unknown',
]);

/** Closed-value guards for a consent classification persisted elsewhere
 *  (the write ledger) and read back from untyped event data. */
export function isInteractiveConsentReversibility(value: unknown): value is InteractiveConsentReversibility {
  return typeof value === 'string' && REVERSIBILITY_VALUES.has(value);
}

export function isInteractiveConsentConsequence(value: unknown): value is InteractiveConsentConsequence {
  return typeof value === 'string' && CONSEQUENCE_VALUES.has(value);
}

const AFFIRMED_CHANGE_CONSEQUENCES: ReadonlySet<InteractiveConsentConsequence> = new Set<InteractiveConsentConsequence>([
  'create', 'update', 'delete', 'send', 'admin',
]);

/**
 * Whether a consent classification affirms that the call changes something
 * outside Clementine: a named create, update, delete, send or administrative
 * consequence, or a destructive declaration. The classifier affirms neither
 * `execute` nor `unknown`. A call that is a write only because its carrier
 * could not be proven read-only proves, when it returns cleanly, that it ran,
 * not that anything changed.
 */
export function consentRiskAffirmsChange(
  risk: { consequence: InteractiveConsentConsequence; destructive: boolean },
): boolean {
  return risk.destructive || AFFIRMED_CHANGE_CONSEQUENCES.has(risk.consequence);
}

/** The same verdict read back from a write's ledger row. A row recorded
 *  without a consent classification keeps its historical reading: a change. */
export function recordedConsentAffirmsChange(data: Readonly<Record<string, unknown>>): boolean {
  if (data.observedEffect === 'none') return false;
  return isInteractiveConsentConsequence(data.consequence)
    ? consentRiskAffirmsChange({ consequence: data.consequence, destructive: data.destructive === true })
    : true;
}

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
        | 'exact_carrier_bounded_work'
        /** A planning turn exercised a carrier-bounded call once as
         * preparation; the plan binds the arguments that worked. */
        | 'plan_preparation_probe'
        | 'exact_user_grant'
        /** A published workflow's run: the owner approved the workflow, and
         * its accepted work carries that approval end to end (owner
         * 2026-10-06). Human-in-the-loop steps pause as explicit checkpoints
         * above; nothing else in the run asks. */
        | 'workflow_approval'
        /** The owner tapped exactly this action on a choice Clem offered
         * on Home (owner 2026-10-09: the tap is the approval). One call. */
        | 'owner_choice'
        | 'settled_replay';
      authorityDigest: string;
      reservationKey?: string;
    }
  | {
      kind: 'needs_user';
      need: 'approval' | 'credential' | 'choice' | 'essential_input';
      subjectDigest: string;
      reason: string;
      /** The pause is Ask mode's, not the call's own risk: approving it once
       * teaches this kind of change, so the same operation runs next time. */
      teaches?: 'external_write_kind';
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
      reason:
        | 'protected_target'
        | 'untrusted_execution'
        | 'malformed_call'
        | 'policy_denied'
        /** A planning turn proposes this effect; it never performs it. */
        | 'plan_mode_external_effect';
    };

/** The basis a proceed decision carries. Dispatch and settlement read it so a
 * planning turn's preparation probe is accounted like a read crossing. */
export type InteractiveConsentProceedBasis =
  Extract<InteractiveConsentDecisionV1, { kind: 'proceed' }>['basis'];

export interface EvaluateInteractiveConsentInputV1 {
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1 | null;
  userGrant: ExactUserGrantV1 | null;
  readiness: InteractiveConsentReadiness;
  crossing: InteractiveConsentCrossing;
  explicitHumanCheckpoint?: { subjectDigest: string };
  reservationAlreadyClaimed: boolean;
  /**
   * The accepted source is a planning turn. Planning holds no expected-work
   * graph, so no coverage can exist; the adapter sets this from the durable
   * task mode, never from model text.
   */
  preparationProbe?: boolean;
  /**
   * The owner's mode. Auto: anything that is not disruptive runs. Ask: a
   * change in a connected app also waits for the owner once, unless that kind
   * of change was approved before. Local work is never gated by the mode.
   */
  mode?: 'auto' | 'ask';
  /** Ask mode only: the owner already approved this operation once. */
  learnedExternalWrite?: boolean;
  /** The call runs inside a published workflow's step session. */
  workflowApproval?: boolean;
  /** A provider (or command) refused a write earlier in this same turn, so
   * this call is a change of plan. */
  afterAnsweredRefusal?: boolean;
  /** The owner tapped exactly this change on a choice Clem offered on Home;
   * the host read it from the accepted source and a judge confirmed it. */
  ownerChoice?: { authorityDigest: string };
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

  // Host bookkeeping and recovery are controls, not user-owned
  // dependencies. A projector that attaches a credential, target/account
  // choice, missing business input, or explicit human checkpoint to a
  // host-only call has produced contradictory authority facts. Keep that
  // repair inside the host instead of manufacturing a card the user cannot
  // meaningfully resolve.
  if (
    call.effect === 'host_only'
    && (input.readiness.kind !== 'ready' || input.explicitHumanCheckpoint)
  ) {
    return { kind: 'repair', reason: 'authority_conflict' };
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

  // A PLANNING TURN NAMES WHAT IT WILL CALL AND COMMITS NOTHING.
  //
  // Planning has no expected-work graph, so the coverage gate below could
  // only ever repair; the ceiling that matters here is external consequence.
  // Reads (schemas, catalogs, lookups) already proceeded above as no_effect,
  // which is how a plan identifies the tools it needs. Every external effect
  // is refused as a typed planning boundary: never a card, never a coverage
  // repair, never a one-off "preparation" execution (owner 2026-10-06: in
  // Plan mode Clem identifies the tools without committing writes). The plan
  // proposes the action; the reviewed revision performs it.
  if (input.preparationProbe) {
    return { kind: 'refuse', reason: 'plan_mode_external_effect' };
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

  // A published workflow works end to end without the owner: the owner
  // approved the workflow, so its exact accepted work (coverage, scope and
  // reservation already checked above) carries that approval for every
  // external effect, a sheet update or a send alike. Owner 2026-10-06, after
  // an hourly sheet update sat on a first-time card: "a workflow that is
  // approved on an external write … should carry the approval from the
  // workflow; the whole point of workflows is that they work end to end
  // without the user." A human-in-the-loop step is the explicit checkpoint
  // gate above; protected targets, uncertain crossings and surprise writes
  // were answered above as well.
  if (input.workflowApproval) {
    return {
      kind: 'proceed',
      basis: 'workflow_approval',
      authorityDigest: input.coverage.requirementDigest,
      reservationKey: input.coverage.reservationKey,
    };
  }

  // A change of plan after a refusal is the owner's call. The provider said
  // no and why; Clem decides what has to change and the changed write waits
  // for the owner, in Auto as in Ask and whatever kind was learned before
  // (owner 2026-10-09). It teaches nothing: the approval covers this change.
  if (input.afterAnsweredRefusal && (call.effect === 'external_write' || call.effect === 'admin')) {
    return {
      kind: 'needs_user',
      need: 'approval',
      subjectDigest: call.bindingDigest,
      reason: 'An earlier write in this turn was refused by the app it went to; this changed attempt waits for the owner.',
    };
  }

  // The owner already said yes by tapping exactly this change on a choice
  // Clem offered (owner 2026-10-09: "Tap is the approval"). It covers one
  // ordinary, non-destructive change in a connected app, never an admin or
  // destructive change, a sealed bulk set, or a change of plan after a
  // refusal; it teaches no kind. Composed content the card never showed was
  // already ruled out by the judge that granted it.
  if (
    input.ownerChoice
    && call.effect === 'external_write'
    && !call.risk.destructive
    && call.risk.consequence !== 'delete'
    && call.risk.consequence !== 'admin'
    && call.cardinality.kind !== 'set'
    && !input.afterAnsweredRefusal
  ) {
    return {
      kind: 'proceed',
      basis: 'owner_choice',
      authorityDigest: input.ownerChoice.authorityDigest,
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
    || call.risk.consequence === 'admin'
    // A sealed set is one true bulk crossing and therefore one exact approval
    // subject. `each` is intentionally absent: each member has its own host-
    // derived occurrence and bulk orchestration owns any aggregate card.
    || call.cardinality.kind === 'set';
  if (highConsequence) {
    return {
      kind: 'needs_user',
      need: 'approval',
      subjectDigest: call.bindingDigest,
      reason: 'This exact accepted call is destructive, irreversible, administrative, or a sealed bulk mutation.',
    };
  }

  // An ordinary change in a connected app waits for the owner the first
  // time, in Auto as well as Ask. The approval teaches the kind (this
  // operation on this account), so it is asked once, never on every call.
  // Owner 2026-10-06, after a fixture turn put a reminder in their Slack and
  // another ran a production backup through the shell with no card: "Non
  // disruptive writes should get a card where Clem says in plain English
  // what she's doing." Everything above still decides first: a send, a
  // delete, an irreversible or administrative change asks every time; local
  // work never reaches this line; a call the carrier cannot classify keeps
  // its own card below.
  const firstTimeExternalWrite = call.effect === 'external_write' && !input.learnedExternalWrite;
  const firstTimeCard = (): InteractiveConsentDecisionV1 => ({
    kind: 'needs_user',
    need: 'approval',
    subjectDigest: call.bindingDigest,
    reason: 'This changes something in a connected app, and it is the first time Clem does this kind of change for you. It runs after you approve it; approving once teaches her the kind.',
    teaches: 'external_write_kind',
  });

  // A carrier that declares the operation non-destructive bounds an otherwise
  // unnamed consequence; with exact coverage, no send/delete evidence in the
  // arguments, and no explicit checkpoint, that is ordinary accepted work.
  // Every gate above (safety, crossing, readiness, checkpoint, coverage,
  // reservation, grant, high consequence) has already been answered.
  if (
    call.effect === 'external_write'
    && call.risk.consequence === 'unknown'
    && call.risk.reversibility === 'ordinary_non_destructive'
  ) {
    if (firstTimeExternalWrite) return firstTimeCard();
    return {
      kind: 'proceed',
      basis: 'exact_carrier_bounded_work',
      authorityDigest: input.coverage.requirementDigest,
      reservationKey: input.coverage.reservationKey,
    };
  }

  // A current external definition can describe a generic carrier whose exact
  // consequences remain unknown. Changing otherwise valid arguments cannot
  // repair that fact. Surface the existing exact-call consent path; do not
  // infer safety, widen coverage, or auto-authorize from a tool name. Missing
  // coverage, stale authority and uncertain prior effects were handled above.
  if (call.risk.reversibility === 'unknown' || call.risk.consequence === 'unknown') {
    if (call.effect === 'external_write') return {
      kind: 'needs_user',
      need: 'approval',
      subjectDigest: call.bindingDigest,
      reason: 'The current tool definition cannot classify this exact external action. Review its arguments and destination before proceeding.',
    };
    return { kind: 'repair', reason: 'risk_unknown' };
  }

  if (
    call.risk.reversibility !== 'reversible'
    && call.risk.reversibility !== 'ordinary_non_destructive'
  ) {
    return { kind: 'repair', reason: 'scope_mismatch' };
  }

  if (firstTimeExternalWrite) return firstTimeCard();
  return {
    kind: 'proceed',
    basis: call.risk.reversibility === 'reversible'
      ? 'exact_reversible_work'
      : 'exact_ordinary_work',
    authorityDigest: input.coverage.requirementDigest,
    reservationKey: input.coverage.reservationKey,
  };
}
