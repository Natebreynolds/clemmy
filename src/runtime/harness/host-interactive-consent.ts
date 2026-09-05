/**
 * Production-host adapter for the single provider-neutral consent reducer.
 *
 * This module owns I/O projection only: reopen the immutable work contract,
 * work binding, local capability definition, logical/crossing state and v57
 * host capability binding, then call `evaluateInteractiveConsentV1`. The graph
 * is an amendable projection, not a later consent authority. Tool and provider
 * names never enter the reducer as policy branches.
 */
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  evaluateInteractiveConsentV1,
  INTERACTIVE_CONSENT_POLICY_VERSION,
  type CapabilityRiskAttestationV1,
  type ExactWorkCoverageV1,
  type ExactUserGrantV1,
  type InteractiveConsentCardinality,
  type InteractiveConsentConsequence,
  type InteractiveConsentCrossing,
  type InteractiveConsentDecisionV1,
  type InteractiveConsentDestination,
  type InteractiveConsentReversibility,
} from './interactive-consent-policy.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { buildHostConsentEvidence } from './host-consent-evidence.js';
import { openEventLog } from './eventlog.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
  localPlanningArgumentsMatch,
  observeCurrentLocalPlanningDefinitions,
  type AuthorizedLocalPlanningDefinitionV1,
} from './local-planning-capability.js';
import {
  inspectPreparedHostWorkCall,
  type PreparedHostWorkCallV1,
} from '../../tools/work-call.js';
import {
  canonicalExternalInputSchemaDigestV1,
  deriveExternalCapabilityCallSignalsV1,
  loadCatalogManifestExternalRiskAttestationV1,
} from './external-capability-risk-loader.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  approvalResolutionWithinLifetime,
  get as getApproval,
} from './approval-registry.js';
import { approvalAuthorityMatchesToolCall } from './approval-authority.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
} from './capability-manifest.js';
import { loadExpectedWorkCallBindingState } from './expected-work-admission.js';
import {
  loadHostCallCapabilityBinding,
  hostCallCapabilityBindingMatchesAttestation,
} from './host-call-capability-binding.js';

export interface HostInteractiveConsentSubjectV1 {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  decisionSubjectDigest: string;
  callDigest: string;
  coverageDigest: string;
  riskDigest: string;
}

const CONSENT_SUBJECT_KEYS = new Set([
  'version', 'sessionId', 'sourceUserSeq', 'acceptedTaskId', 'logicalToolCallId',
  'decisionSubjectDigest', 'callDigest', 'coverageDigest', 'riskDigest',
]);

export function parseHostInteractiveConsentSubjectV1(
  value: unknown,
): HostInteractiveConsentSubjectV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subject = value as Record<string, unknown>;
  const keys = Object.keys(subject);
  if (keys.length !== CONSENT_SUBJECT_KEYS.size || keys.some((key) => !CONSENT_SUBJECT_KEYS.has(key))) {
    return null;
  }
  const digestFields = [
    subject.decisionSubjectDigest,
    subject.callDigest,
    subject.coverageDigest,
    subject.riskDigest,
  ];
  if (
    subject.version !== 1
    || typeof subject.sessionId !== 'string'
    || !subject.sessionId.trim()
    || typeof subject.sourceUserSeq !== 'number'
    || !Number.isSafeInteger(subject.sourceUserSeq)
    || subject.sourceUserSeq <= 0
    || typeof subject.acceptedTaskId !== 'string'
    || !subject.acceptedTaskId.trim()
    || typeof subject.logicalToolCallId !== 'string'
    || !subject.logicalToolCallId.trim()
    || !digestFields.every((entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry))
  ) return null;
  return subject as unknown as HostInteractiveConsentSubjectV1;
}

export function hostInteractiveConsentApprovalResumeKey(
  value: HostInteractiveConsentSubjectV1,
): string | null {
  const subject = parseHostInteractiveConsentSubjectV1(value);
  return subject ? `host-consent:v1:${digest(subject)}` : null;
}

export type HostInteractiveConsentResult =
  | {
      status: 'decided';
      decision: InteractiveConsentDecisionV1;
      call: CapabilityRiskAttestationV1;
      coverage: ExactWorkCoverageV1 | null;
      consentSubject?: HostInteractiveConsentSubjectV1;
      nestedAdmission?: object;
    }
  | { status: 'repair'; reason: string; retryable: true }
  | { status: 'hold'; reason: string; retryable: true }
  | { status: 'conflict'; reason: string };

interface DurableHostConsentApproval {
  approvalId: string;
  persistedSubject: HostInteractiveConsentSubjectV1;
  outerToolName: string;
  outerRawArguments: string;
}

/**
 * Process-local proof that one exact durable approval was re-evaluated against
 * the current prepared call and reduced to `proceed/exact_user_grant`.
 *
 * The visible marker is deliberately useless. Only this module can put an
 * object in the backing WeakMap; copying or reflecting the marker cannot copy
 * the authority it names.
 */
export interface HostConsentGrantAdmissionV1 {
  readonly version: 1;
}

export interface HostConsentGrantAdmissionExpectationV1 {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: CapabilityRiskAttestationV1['effect'];
  contractId: string;
  requirementId: string;
  hostCapabilityBindingDigest: string;
  authorityDigest: string;
}

export interface RedeemedHostConsentGrantV1 {
  approvalId: string;
  consentSubjectDigest: string;
  grantDigest: string;
}

interface HostConsentGrantAdmissionStateV1
  extends HostConsentGrantAdmissionExpectationV1, RedeemedHostConsentGrantV1 {
  requirementDigest: string;
  decisionSubjectDigest: string;
  callDigest: string;
  coverageDigest: string;
  riskDigest: string;
  grantScopeDigest: string;
}

const issuedHostConsentGrantAdmissions = new WeakMap<
  object,
  Readonly<HostConsentGrantAdmissionStateV1>
>();

function digest(value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson(value), 'utf8').digest('hex');
}

/**
 * Redeem the evaluator-owned grant at the immediate nested-admission edge.
 * Deletion precedes comparison so a failed sibling transplant also spends the
 * process token. Approval rows remain durable evidence, never a public minting
 * API for another logical call.
 */
export function consumeHostConsentGrantAdmission(input: {
  admission: HostConsentGrantAdmissionV1;
  expected: HostConsentGrantAdmissionExpectationV1;
}): RedeemedHostConsentGrantV1 | null {
  const state = issuedHostConsentGrantAdmissions.get(input.admission as object);
  issuedHostConsentGrantAdmissions.delete(input.admission as object);
  const expected = input.expected;
  if (
    !state
    || state.sessionId !== expected.sessionId
    || state.sourceUserSeq !== expected.sourceUserSeq
    || state.acceptedTaskId !== expected.acceptedTaskId
    || state.logicalToolCallId !== expected.logicalToolCallId
    || state.toolName !== expected.toolName
    || state.argumentDigest !== expected.argumentDigest
    || state.effect !== expected.effect
    || state.contractId !== expected.contractId
    || state.requirementId !== expected.requirementId
    || state.hostCapabilityBindingDigest !== expected.hostCapabilityBindingDigest
    || state.authorityDigest !== expected.authorityDigest
  ) return null;
  return Object.freeze({
    approvalId: state.approvalId,
    consentSubjectDigest: state.consentSubjectDigest,
    grantDigest: state.grantDigest,
  });
}

function exactConsentSubject(input: {
  prepared: Pick<PreparedHostWorkCallV1, 'sessionId' | 'sourceUserSeq' | 'acceptedTaskId' | 'logicalToolCallId'>;
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1;
  decisionSubjectDigest: string;
}): HostInteractiveConsentSubjectV1 {
  return {
    version: 1,
    sessionId: input.prepared.sessionId,
    sourceUserSeq: input.prepared.sourceUserSeq,
    acceptedTaskId: input.prepared.acceptedTaskId,
    logicalToolCallId: input.prepared.logicalToolCallId,
    decisionSubjectDigest: input.decisionSubjectDigest,
    callDigest: digest(input.call),
    coverageDigest: digest(input.coverage),
    riskDigest: digest(input.call.risk),
  };
}

function sameConsentSubject(
  left: HostInteractiveConsentSubjectV1,
  right: HostInteractiveConsentSubjectV1,
): boolean {
  try {
    const parsedLeft = parseHostInteractiveConsentSubjectV1(left);
    const parsedRight = parseHostInteractiveConsentSubjectV1(right);
    return Boolean(
      parsedLeft
      && parsedRight
      && closedCanonicalJson(parsedLeft) === closedCanonicalJson(parsedRight)
    );
  } catch {
    return false;
  }
}

export function durableHostApprovalResolutionMatches(input: {
  approvalId: string;
  persistedSubject: HostInteractiveConsentSubjectV1;
  outerToolName: string;
  outerRawArguments: string;
}): boolean {
  const subject = parseHostInteractiveConsentSubjectV1(input.persistedSubject);
  if (!subject) return false;
  const resumeKey = hostInteractiveConsentApprovalResumeKey(subject);
  if (!resumeKey) return false;
  const row = getApproval(input.approvalId);
  if (
    !row
    || row.sessionId !== subject.sessionId
    || row.status !== 'resolved'
    || row.resolution !== 'approved'
    || row.resumeKey !== resumeKey
    || !row.resolvedAt
    || !approvalResolutionWithinLifetime(row)
    || !approvalAuthorityMatchesToolCall(row, input.outerToolName, input.outerRawArguments)
  ) return false;
  return true;
}

function durableApprovalGrant(input: {
  approvalId: string;
  persistedSubject: HostInteractiveConsentSubjectV1;
  currentSubject: HostInteractiveConsentSubjectV1;
  outerToolName: string;
  outerRawArguments: string;
  call: CapabilityRiskAttestationV1;
}): ExactUserGrantV1 | null {
  if (
    !sameConsentSubject(input.persistedSubject, input.currentSubject)
    || !durableHostApprovalResolutionMatches(input)
  ) return null;
  const row = getApproval(input.approvalId)!;
  return {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    source: 'approval_resolution',
    grantDigest: digest({
      version: 1,
      approvalId: row.approvalId,
      requestedAt: row.requestedAt,
      expiresAt: row.expiresAt,
      resolvedAt: row.resolvedAt,
      subject: input.currentSubject,
    }),
    scope: {
      source: input.call.source,
      acceptedTaskId: input.call.acceptedTaskId,
      logicalToolCallId: input.call.logicalToolCallId,
      bindingDigest: input.call.bindingDigest,
      operationId: input.call.operationId,
      argumentDigest: input.call.argumentDigest,
      schemaFingerprint: input.call.schemaFingerprint,
      effect: input.call.effect,
      accountId: input.call.accountId,
      destination: input.call.destination,
      cardinality: input.call.cardinality,
      risk: input.call.risk,
      semanticBasis: input.call.semanticBasis,
    },
  };
}

/** Private mint: the only call site is the exact prepared-call evaluator after
 * it has recomputed current graph/work/risk state. Re-run both durable approval
 * redemption and the pure reducer here so even a future refactor cannot mint
 * from caller-authored grant fields. */
function mintHostConsentGrantAdmission(input: {
  prepared: PreparedHostWorkCallV1;
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1;
  crossing: InteractiveConsentCrossing;
  reservationAlreadyClaimed: boolean;
  decision: InteractiveConsentDecisionV1;
  consentSubject: HostInteractiveConsentSubjectV1;
  durableApproval: NonNullable<Parameters<typeof evaluatePreparedHostWorkCallConsent>[0]['durableApproval']>;
  userGrant: ExactUserGrantV1;
}): HostConsentGrantAdmissionV1 | null {
  try {
    if (
      input.decision.kind !== 'proceed'
      || input.decision.basis !== 'exact_user_grant'
      || input.userGrant.source !== 'approval_resolution'
      || input.decision.authorityDigest !== input.userGrant.grantDigest
    ) return null;
    const prepared = input.prepared;
    const host = prepared.hostCapabilityBinding;
    const work = prepared.binding;
    const logical = durableLogicalCallContract(
      prepared.acceptedTaskId,
      prepared.targetName,
      prepared.targetArgs,
    );
    if (
      !logical
      || prepared.sessionId !== host.sessionId
      || prepared.sourceUserSeq !== host.sourceUserSeq
      || prepared.acceptedTaskId !== host.acceptedTaskId
      || prepared.logicalToolCallId !== host.logicalToolCallId
      || prepared.sessionId !== work.sessionId
      || prepared.sourceUserSeq !== work.sourceUserSeq
      || prepared.acceptedTaskId !== work.acceptedTaskId
      || prepared.logicalToolCallId !== work.logicalToolCallId
      || logical.toolName !== host.toolName
      || logical.argumentDigest !== host.effectiveArgumentDigest
      || input.call.acceptedTaskId !== prepared.acceptedTaskId
      || input.call.logicalToolCallId !== prepared.logicalToolCallId
      || input.call.argumentDigest !== logical.argumentDigest
      || input.call.effect !== work.effect
      || input.coverage.acceptedTaskId !== prepared.acceptedTaskId
      || input.coverage.contractId !== work.contractId
      || input.coverage.requirementId !== work.requirementId
      || input.coverage.callBinding.logicalToolCallId !== prepared.logicalToolCallId
      || input.coverage.callBinding.argumentDigest !== logical.argumentDigest
      || input.coverage.callBinding.bindingDigest !== input.call.bindingDigest
      || input.consentSubject.sessionId !== prepared.sessionId
      || input.consentSubject.sourceUserSeq !== prepared.sourceUserSeq
      || input.consentSubject.acceptedTaskId !== prepared.acceptedTaskId
      || input.consentSubject.logicalToolCallId !== prepared.logicalToolCallId
      || input.consentSubject.callDigest !== digest(input.call)
      || input.consentSubject.coverageDigest !== digest(input.coverage)
      || input.consentSubject.riskDigest !== digest(input.call.risk)
    ) return null;
    const currentUngrantedDecision = evaluateInteractiveConsentV1({
      call: input.call,
      coverage: input.coverage,
      userGrant: null,
      readiness: { kind: 'ready' },
      crossing: input.crossing,
      reservationAlreadyClaimed: input.reservationAlreadyClaimed,
    });
    const currentDecisionSubjectDigest = currentUngrantedDecision.kind === 'needs_user'
      && currentUngrantedDecision.need === 'approval'
      ? currentUngrantedDecision.subjectDigest
      : input.call.bindingDigest;
    if (input.consentSubject.decisionSubjectDigest !== currentDecisionSubjectDigest) return null;
    const currentGrant = durableApprovalGrant({
      approvalId: input.durableApproval.approvalId,
      persistedSubject: input.durableApproval.persistedSubject,
      currentSubject: input.consentSubject,
      outerToolName: input.durableApproval.outerToolName,
      outerRawArguments: input.durableApproval.outerRawArguments,
      call: input.call,
    });
    if (
      !currentGrant
      || closedCanonicalJson(currentGrant) !== closedCanonicalJson(input.userGrant)
    ) return null;
    const reproduced = evaluateInteractiveConsentV1({
      call: input.call,
      coverage: input.coverage,
      userGrant: currentGrant,
      readiness: { kind: 'ready' },
      crossing: input.crossing,
      reservationAlreadyClaimed: input.reservationAlreadyClaimed,
    });
    if (
      reproduced.kind !== 'proceed'
      || reproduced.basis !== 'exact_user_grant'
      || closedCanonicalJson(reproduced) !== closedCanonicalJson(input.decision)
    ) return null;

    const candidate = Object.freeze({ version: 1 as const });
    issuedHostConsentGrantAdmissions.set(candidate, Object.freeze({
      sessionId: prepared.sessionId,
      sourceUserSeq: prepared.sourceUserSeq,
      acceptedTaskId: prepared.acceptedTaskId,
      logicalToolCallId: prepared.logicalToolCallId,
      toolName: logical.toolName,
      argumentDigest: logical.argumentDigest,
      effect: input.call.effect,
      contractId: work.contractId,
      requirementId: work.requirementId,
      requirementDigest: input.coverage.requirementDigest,
      hostCapabilityBindingDigest: host.durableBindingDigest,
      authorityDigest: reproduced.authorityDigest,
      approvalId: input.durableApproval.approvalId,
      consentSubjectDigest: digest(input.consentSubject),
      decisionSubjectDigest: input.consentSubject.decisionSubjectDigest,
      callDigest: input.consentSubject.callDigest,
      coverageDigest: input.consentSubject.coverageDigest,
      riskDigest: input.consentSubject.riskDigest,
      grantDigest: currentGrant.grantDigest,
      grantScopeDigest: digest(currentGrant.scope),
    }));
    return candidate;
  } catch {
    return null;
  }
}

function sourceFromHostBinding(binding: PreparedHostWorkCallV1['hostCapabilityBinding']) {
  return {
    kind: 'accepted_turn' as const,
    id: binding.sourceEventId,
    digest: binding.sourceEventDigest,
  };
}

function localDestinationFor(input: {
  requirementId: string;
  binding: PreparedHostWorkCallV1['hostCapabilityBinding'];
  definition: AuthorizedLocalPlanningDefinitionV1;
}): InteractiveConsentDestination {
  const posture = input.definition.descriptor.destinationPosture;
  return {
    posture: posture ?? 'not_applicable',
    digest: digest({
      version: 1,
      requirementId: input.requirementId,
      hostCapabilityBinding: input.binding.durableBindingDigest,
      effectiveArgumentDigest: input.binding.effectiveArgumentDigest,
      capabilityRef: input.definition.capabilityRef,
      posture,
      deliverableKind: input.definition.descriptor.deliverableKind,
      handleRequired: input.definition.descriptor.handleRequired,
    }),
  };
}

function externalDestinationFor(input: {
  requirementId: string;
  binding: PreparedHostWorkCallV1['hostCapabilityBinding'];
}): InteractiveConsentDestination | null {
  if (input.binding.bindingKind !== 'catalog_manifest') return null;
  const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
  const installed = store.get(input.binding.manifestId);
  const manifest = currentCapabilityManifest(installed?.manifest);
  if (
    !installed
    || !manifest
    || installed.digest !== input.binding.manifestDigest
    || capabilityManifestDigest(manifest) !== input.binding.manifestDigest
    || manifest.manifestId !== input.binding.manifestId
    || manifest.operationId !== input.binding.operationId
    || manifest.definitionFingerprint !== input.binding.schemaFingerprint
    || manifest.accountId !== input.binding.accountId
    || manifest.effect !== input.binding.effect
    || manifest.invokePortId !== input.binding.invokePortId
    || (manifest.externalDefinition?.providerInputSchemaDigest ?? null)
      !== (input.binding.providerInputSchemaDigest ?? null)
  ) return null;
  const posture = manifest.destination?.posture ?? 'not_applicable';
  if (posture !== 'create_new' && posture !== 'named_existing' && posture !== 'not_applicable') {
    return null;
  }
  return {
    posture,
    digest: digest({
      version: 1,
      requirementId: input.requirementId,
      hostCapabilityBinding: input.binding.durableBindingDigest,
      effectiveArgumentDigest: input.binding.effectiveArgumentDigest,
      capabilityId: input.binding.capabilityId,
      manifestDigest: input.binding.manifestDigest,
      accountId: input.binding.accountId,
      operationId: input.binding.operationId,
      schemaFingerprint: input.binding.schemaFingerprint,
      destination: manifest.destination ?? null,
    }),
  };
}

function policyCardinality(
  prepared: PreparedHostWorkCallV1,
): InteractiveConsentCardinality | null {
  const operation = prepared.contract.operations.find((entry) => (
    entry.id === prepared.binding.requirementId
  ));
  if (!operation || operation.cardinality.kind !== prepared.binding.cardinality) return null;
  if (operation.cardinality.kind === 'once') return { kind: 'once' };
  const universeId = operation.cardinality.universeId;
  const universe = prepared.contract.universes.find((entry) => (
    entry.id === universeId
  ));
  if (!universe) return null;
  const universeDigest = digest({
    version: 1,
    contractId: prepared.contract.contractId,
    universe,
    boundItem: prepared.binding.universeItemId ?? null,
    memberDigest: prepared.binding.universeMemberDigest ?? null,
    memberCount: prepared.binding.universeMemberCount ?? null,
  });
  return operation.cardinality.kind === 'each'
    ? { kind: 'each', universeDigest }
    : { kind: 'set', universeDigest };
}

function reservationKey(input: {
  prepared: PreparedHostWorkCallV1;
  cardinality: InteractiveConsentCardinality;
}): string {
  return digest({
    version: 1,
    contractId: input.prepared.contract.contractId,
    requirementId: input.prepared.binding.requirementId,
    cardinality: input.cardinality,
    universeItemId: input.prepared.binding.universeItemId ?? null,
    universeMemberDigest: input.prepared.binding.universeMemberDigest ?? null,
  });
}

function priorReservationExists(prepared: PreparedHostWorkCallV1): boolean {
  const binding = prepared.binding;
  try {
    const rows = openEventLog().prepare(`
      SELECT binding.logical_tool_call_id, binding.cardinality_kind,
             binding.universe_item_id, binding.universe_member_digest
        FROM expected_work_call_bindings binding
        LEFT JOIN logical_call_settlements settlement
          ON settlement.session_id = binding.session_id
         AND settlement.source_user_seq = binding.source_user_seq
         AND settlement.logical_tool_call_id = binding.logical_tool_call_id
       WHERE binding.session_id = ? AND binding.source_user_seq = ?
         AND binding.contract_id = ? AND binding.requirement_id = ?
         AND binding.logical_tool_call_id <> ?
         AND (
           settlement.logical_tool_call_id IS NULL
           OR settlement.execution_kind <> 'refused_pre_dispatch'
         )
    `).all(
      prepared.sessionId,
      prepared.sourceUserSeq,
      binding.contractId,
      binding.requirementId,
      prepared.logicalToolCallId,
    ) as Array<{
      logical_tool_call_id: string;
      cardinality_kind: string;
      universe_item_id: string | null;
      universe_member_digest: string | null;
    }>;
    if (binding.cardinality === 'once') return rows.length > 0;
    if (binding.cardinality === 'each') {
      return rows.some((row) => row.cardinality_kind === 'each'
        && row.universe_item_id === (binding.universeItemId ?? null));
    }
    return rows.some((row) => row.cardinality_kind === 'set'
      && row.universe_member_digest === (binding.universeMemberDigest ?? null));
  } catch {
    return true;
  }
}

function crossingFor(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): InteractiveConsentCrossing | null {
  try {
    const settlement = openEventLog().prepare(`
      SELECT 1 FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId);
    if (settlement) return 'settled';
    const rows = openEventLog().prepare(`
      SELECT state FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       ORDER BY ordinal
    `).all(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Array<{ state: string }>;
    if (rows.length === 0) return 'not_started';
    return rows.some((row) => row.state === 'started') ? 'started' : 'possibly_started';
  } catch {
    return null;
  }
}

function localRisk(definition: AuthorizedLocalPlanningDefinitionV1): {
  reversibility: InteractiveConsentReversibility;
  consequence: InteractiveConsentConsequence;
  destructive: boolean;
} {
  if (definition.descriptor.effect === 'read') {
    return {
      reversibility: 'read_only',
      consequence: 'read',
      destructive: false,
    };
  }
  const posture = definition.descriptor.destinationPosture;
  return {
    reversibility: definition.reversibility === 'irreversible'
      ? 'irreversible'
      : 'reversible',
    consequence: posture === 'create_new'
      ? 'create'
      : posture === 'named_existing'
        ? 'update'
        : 'execute',
    destructive: definition.destructive,
  };
}

async function exactLocalDefinitionForPrepared(input: {
  prepared: PreparedConsentTarget;
}): Promise<AuthorizedLocalPlanningDefinitionV1 | null> {
  const binding = input.prepared.hostCapabilityBinding;
  if (binding.bindingKind !== 'local_envelope') return null;
  const observed = await observeCurrentLocalPlanningDefinitions({
    name: input.prepared.targetName,
    carrier: 'work_call',
  });
  if (!observed.ok) return null;
  const definitions = binding.capabilityId.startsWith('cap:local:')
    ? observed.definitions.filter((definition) => definition.capabilityRef === binding.capabilityId)
    : observed.definitions;
  const candidates: AuthorizedLocalPlanningDefinitionV1[] = [];
  for (const current of definitions) {
    const loaded = await loadDurableAuthorizedLocalPlanningDefinition({
      sessionId: input.prepared.sessionId,
      sourceUserSeq: input.prepared.sourceUserSeq,
      capabilityRef: current.capabilityRef,
    });
    if (
      loaded.ok
      && loaded.definition.capabilityRef === current.capabilityRef
      && loaded.definition.name === input.prepared.targetName
      && loaded.definition.carrier === 'work_call'
      && loaded.definition.schemaFingerprint === current.schemaFingerprint
      && loaded.definition.envelopeFingerprint === current.envelopeFingerprint
      && localPlanningArgumentsMatch(loaded.definition, input.prepared.targetArgs)
    ) candidates.push(loaded.definition);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

interface PreparedConsentSemanticBasis {
  operationId: string;
  schemaFingerprint: string;
  effect: CapabilityRiskAttestationV1['effect'];
  accountId: string | null;
  destination: InteractiveConsentDestination;
  risk: CapabilityRiskAttestationV1['risk'];
  semanticBasis: CapabilityRiskAttestationV1['semanticBasis'];
  safety: CapabilityRiskAttestationV1['safety'];
  requirementCapabilityIdentity: string;
}

type PreparedConsentTarget = Pick<
  PreparedHostWorkCallV1,
  | 'sessionId'
  | 'sourceUserSeq'
  | 'acceptedTaskId'
  | 'logicalToolCallId'
  | 'targetName'
  | 'targetArgs'
  | 'targetInputSchema'
  | 'evidenceArgs'
  | 'evidenceInputSchema'
  | 'hostCapabilityBinding'
>;

type PreparedConsentSemanticBasisResolution =
  | { status: 'ready'; semantic: PreparedConsentSemanticBasis }
  | { status: 'repair' | 'hold'; reason: string };

// Keep canonical-byte equality on the same closed domain as
// canonicalExternalInputSchemaDigestV1; otherwise a large schema could match
// the durable digest and then be rejected only by this deduplication pass.
const EXTERNAL_SCHEMA_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 100_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 2_097_152,
});

export interface ExactPreparedExternalCallV1 {
  inputSchema: Readonly<Record<string, unknown>>;
  arguments: Readonly<Record<string, unknown>>;
  logicalToolName: string;
}

export function selectExactPreparedExternalCall(input: {
  providerInputSchemaDigest?: string;
  acceptedTaskId: string;
  effectiveArgumentDigest: string;
  effectiveToolName: string;
  candidates: readonly {
    inputSchema: unknown;
    arguments: unknown;
    logicalToolName: string;
  }[];
}): ExactPreparedExternalCallV1 | null {
  const expected = input.providerInputSchemaDigest?.trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return null;
  const matches = new Map<string, ExactPreparedExternalCallV1>();
  for (const candidate of input.candidates) {
    const schema = candidate.inputSchema;
    const args = candidate.arguments;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue;
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const schemaDigest = canonicalExternalInputSchemaDigestV1(schema);
    if (schemaDigest !== expected) continue;
    const contract = durableLogicalCallContract(
      input.acceptedTaskId,
      candidate.logicalToolName,
      args,
    );
    if (
      !contract
      || contract.toolName !== input.effectiveToolName
      || contract.argumentDigest !== input.effectiveArgumentDigest
    ) continue;
    try {
      const schemaBytes = closedCanonicalJson(schema, EXTERNAL_SCHEMA_CANONICAL_LIMITS);
      const argumentBytes = closedCanonicalJson(args, EXTERNAL_SCHEMA_CANONICAL_LIMITS);
      const selected = {
        inputSchema: schema as Readonly<Record<string, unknown>>,
        arguments: args as Readonly<Record<string, unknown>>,
        logicalToolName: candidate.logicalToolName,
      };
      matches.set(
        `${contract.toolName}\0${schemaDigest}\0${schemaBytes}\0${argumentBytes}`,
        selected,
      );
    } catch {
      return null;
    }
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}

function exactPreparedExternalCall(
  prepared: PreparedConsentTarget,
): ExactPreparedExternalCallV1 | null {
  const candidates: Array<{
    inputSchema: unknown;
    arguments: unknown;
    logicalToolName: string;
  }> = [{
    inputSchema: prepared.targetInputSchema,
    arguments: prepared.targetArgs,
    logicalToolName: prepared.targetName,
  }];
  if (prepared.evidenceInputSchema !== undefined && prepared.evidenceArgs !== undefined) {
    candidates.push({
      inputSchema: prepared.evidenceInputSchema,
      arguments: prepared.evidenceArgs,
      logicalToolName: prepared.hostCapabilityBinding.toolName,
    });
  }
  return selectExactPreparedExternalCall({
    providerInputSchemaDigest: prepared.hostCapabilityBinding.providerInputSchemaDigest,
    acceptedTaskId: prepared.acceptedTaskId,
    effectiveArgumentDigest: prepared.hostCapabilityBinding.effectiveArgumentDigest,
    effectiveToolName: prepared.hostCapabilityBinding.toolName,
    candidates,
  });
}

async function semanticBasisForExactCall(input: {
  prepared: PreparedConsentTarget;
  requirementId: string;
  effect: CapabilityRiskAttestationV1['effect'];
}): Promise<PreparedConsentSemanticBasisResolution> {
  const binding = input.prepared.hostCapabilityBinding;
  if (binding.bindingKind === 'local_envelope') {
    const local = await exactLocalDefinitionForPrepared(input);
    if (!local) {
      return { status: 'hold', reason: 'bound_local_definition_unavailable' };
    }
    if (!localPlanningArgumentsMatch(local, input.prepared.targetArgs)) {
      return { status: 'repair', reason: 'bound_local_arguments_do_not_match_definition' };
    }
    const effect = local.descriptor.effect;
    if (effect !== input.effect) {
      return { status: 'repair', reason: 'bound_local_effect_does_not_match_work' };
    }
    if (effect !== 'read' && effect !== 'local_write') {
      return { status: 'repair', reason: 'bound_local_effect_is_not_consent_projectable' };
    }
    return { status: 'ready', semantic: {
      operationId: local.capabilityRef,
      schemaFingerprint: local.schemaFingerprint,
      effect,
      accountId: local.accountIdentity,
      destination: localDestinationFor({
        requirementId: input.requirementId,
        binding,
        definition: local,
      }),
      risk: localRisk(local),
      semanticBasis: {
        kind: 'local_registry',
        digest: local.envelopeFingerprint,
      },
      safety: 'admissible',
      requirementCapabilityIdentity: local.capabilityRef,
    } };
  }
  if (binding.bindingKind !== 'catalog_manifest') {
    return { status: 'repair', reason: 'bound_capability_kind_is_not_consent_projectable' };
  }
  if (binding.effect !== input.effect) {
    return { status: 'repair', reason: 'bound_catalog_effect_does_not_match_work' };
  }
  if (binding.effect !== 'external_write' && binding.effect !== 'admin') {
    return { status: 'repair', reason: 'bound_catalog_effect_is_not_a_mutation' };
  }
  const externalCall = exactPreparedExternalCall(input.prepared);
  if (!externalCall) {
    return { status: 'repair', reason: 'bound_catalog_call_does_not_match_exact_schema_and_arguments' };
  }
  const callSignals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: externalCall.inputSchema,
    arguments: externalCall.arguments,
  });
  // Argument-dependent delivery is part of the exact risk subject. Keep an
  // unresolved signal named and retryable; it is never permission evidence.
  if (callSignals.status !== 'projected') {
    return { status: 'repair', reason: `bound_catalog_call_signal_${callSignals.reason}` };
  }
  // The logical/work/catalog ledgers already bind the exact operation and
  // arguments. Graph nodes are amendable bookkeeping, so consent must not
  // demand a one-node join or explicit-capability spelling before reaching
  // the reducer.
  const destination = externalDestinationFor({
    requirementId: input.requirementId,
    binding,
  });
  if (!destination) {
    return { status: 'hold', reason: 'bound_catalog_destination_projection_unavailable' };
  }
  const loaded = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest' as const,
      capabilityId: binding.capabilityId,
      ...(binding.providerInputSchemaDigest
        ? { providerInputSchemaDigest: binding.providerInputSchemaDigest }
        : {}),
      schemaFingerprint: binding.schemaFingerprint,
      accountId: binding.accountId,
      invokePortId: binding.invokePortId,
      operationId: binding.operationId,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      effect: binding.effect,
    },
    inputSchema: externalCall.inputSchema,
    destination,
    callSignals: callSignals.callSignals,
    safety: 'admissible' as const,
  });
  if (!loaded.ok) {
    return {
      status: loaded.reason === 'schema_drift' || loaded.reason === 'malformed_input'
        ? 'repair'
        : 'hold',
      reason: `bound_catalog_risk_projection_${loaded.reason}`,
    };
  }
  const external = loaded.attestation;
  if (
    external.manifest.manifestId !== binding.manifestId
    || external.manifest.manifestDigest !== binding.manifestDigest
    || external.manifest.operationId !== binding.operationId
    || external.manifest.definitionFingerprint !== binding.schemaFingerprint
    || external.manifest.accountId !== binding.accountId
    || external.projection.effect !== binding.effect
  ) {
    return { status: 'hold', reason: 'bound_catalog_risk_projection_identity_mismatch' };
  }
  return { status: 'ready', semantic: {
    operationId: binding.operationId,
    schemaFingerprint: binding.schemaFingerprint,
    effect: external.projection.effect,
    accountId: binding.accountId,
    destination,
    risk: external.projection.risk,
    semanticBasis: external.projection.semanticBasis,
    safety: external.projection.safety,
    requirementCapabilityIdentity: binding.capabilityId,
  } };
}

/** Pause and resume reduce the same exact evidence and durable approval. */
function reduceHostConsentEvidence(input: {
  identity: Parameters<typeof exactConsentSubject>[0]['prepared'];
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1;
  crossing: InteractiveConsentCrossing;
  reservationAlreadyClaimed: boolean;
  durableApproval?: DurableHostConsentApproval;
}) {
  const { call, coverage, crossing, reservationAlreadyClaimed } = input;
  const ungrantedDecision = evaluateInteractiveConsentV1({
    call, coverage, userGrant: null, readiness: { kind: 'ready' },
    crossing, reservationAlreadyClaimed,
  });
  const consentSubject = exactConsentSubject({
    prepared: input.identity, call, coverage,
    decisionSubjectDigest: ungrantedDecision.kind === 'needs_user'
      && ungrantedDecision.need === 'approval'
      ? ungrantedDecision.subjectDigest : call.bindingDigest,
  });
  const userGrant = input.durableApproval ? durableApprovalGrant({
    ...input.durableApproval, currentSubject: consentSubject, call,
  }) : null;
  const decision: InteractiveConsentDecisionV1 = input.durableApproval && !userGrant
    ? { kind: 'repair', reason: 'scope_mismatch' }
    : userGrant ? evaluateInteractiveConsentV1({
        call, coverage, userGrant, readiness: { kind: 'ready' },
        crossing, reservationAlreadyClaimed,
      }) : ungrantedDecision;
  return { decision, consentSubject, userGrant };
}

/** Evaluate a fully materialized plan-bound work_call. */
export async function evaluatePreparedHostWorkCallConsent(input: {
  preparation: object;
  durableApproval?: DurableHostConsentApproval;
}): Promise<HostInteractiveConsentResult> {
  const prepared = inspectPreparedHostWorkCall(input.preparation);
  if (!prepared) return { status: 'conflict', reason: 'work_call preparation is not host-issued' };
  const work = loadExpectedWorkCallBindingState({
    sessionId: prepared.sessionId,
    sourceUserSeq: prepared.sourceUserSeq,
    logicalToolCallId: prepared.logicalToolCallId,
  });
  const host = loadHostCallCapabilityBinding({
    db: openEventLog(),
    sessionId: prepared.sessionId,
    sourceUserSeq: prepared.sourceUserSeq,
    logicalToolCallId: prepared.logicalToolCallId,
  });
  const logical = durableLogicalCallContract(
    prepared.acceptedTaskId,
    prepared.targetName,
    prepared.targetArgs,
  );
  if (
    work.status !== 'ok'
    || closedCanonicalJson(work.binding) !== closedCanonicalJson(prepared.binding)
    || host.status !== 'ok'
    || closedCanonicalJson(host.binding) !== closedCanonicalJson(prepared.hostCapabilityBinding)
    || !logical
    || logical.argumentDigest !== prepared.hostCapabilityBinding.effectiveArgumentDigest
  ) {
    return { status: 'hold', reason: 'prepared_work_durable_authority_reopen_mismatch', retryable: true };
  }
  const operation = prepared.contract.operations.find((entry) => (
    entry.id === prepared.binding.requirementId
  ));
  const cardinality = policyCardinality(prepared);
  const crossing = crossingFor(prepared);
  if (!operation || operation.effect !== prepared.binding.effect || !cardinality) {
    return { status: 'repair', reason: 'prepared_work_binding_does_not_match_contract_operation', retryable: true };
  }
  if (!crossing) {
    return { status: 'hold', reason: 'prepared_work_crossing_state_unavailable', retryable: true };
  }
  const semanticResolution = await semanticBasisForExactCall({
    prepared,
    requirementId: prepared.binding.requirementId,
    effect: prepared.binding.effect,
  });
  if (semanticResolution.status !== 'ready') {
    return {
      status: semanticResolution.status,
      reason: semanticResolution.reason,
      retryable: true,
    };
  }
  const semantic = semanticResolution.semantic;
  if (operation.effect !== semantic.effect) {
    return { status: 'repair', reason: 'prepared_semantic_effect_does_not_match_contract_operation', retryable: true };
  }

  const source = sourceFromHostBinding(prepared.hostCapabilityBinding);
  const destination = semantic.destination;
  const argumentDigest = prepared.hostCapabilityBinding.effectiveArgumentDigest;
  const bindingDigest = digest({
    version: 1,
    hostCapabilityBinding: prepared.hostCapabilityBinding.durableBindingDigest,
    logicalToolCallId: prepared.logicalToolCallId,
    argumentDigest,
    contractId: prepared.contract.contractId,
    requirementId: prepared.binding.requirementId,
    capabilityIdentity: semantic.requirementCapabilityIdentity,
    semanticBasis: semantic.semanticBasis,
  });
  const { call, coverage } = buildHostConsentEvidence({ call: {
    source,
    acceptedTaskId: prepared.acceptedTaskId,
    bindingDigest,
    logicalToolCallId: prepared.logicalToolCallId,
    operationId: semantic.operationId,
    argumentDigest,
    schemaFingerprint: semantic.schemaFingerprint,
    effect: semantic.effect,
    accountId: semantic.accountId,
    destination,
    cardinality,
    risk: semantic.risk,
    semanticBasis: semantic.semanticBasis,
    safety: semantic.safety,
  }, coverage: (call) => ({
    contractId: prepared.contract.contractId,
    requirementId: prepared.binding.requirementId,
    requirementDigest: digest({
      version: 1,
      contractId: prepared.contract.contractId,
      graphHash: prepared.contract.graphHash,
      operation,
      capabilityIdentity: semantic.requirementCapabilityIdentity,
      destination,
      semanticBasis: call.semanticBasis,
    }),
    reservationKey: reservationKey({ prepared, cardinality }),
  }) });
  const reservationAlreadyClaimed = priorReservationExists(prepared);
  const { decision, consentSubject, userGrant } = reduceHostConsentEvidence({
    identity: prepared, call, coverage, crossing, reservationAlreadyClaimed,
    durableApproval: input.durableApproval,
  });
  if (decision.kind !== 'proceed') {
    return {
      status: 'decided',
      decision,
      call,
      coverage,
      ...(decision.kind === 'needs_user' && decision.need === 'approval'
        ? { consentSubject }
        : {}),
    };
  }
  if (decision.basis === 'settled_replay') {
    return { status: 'decided', decision, call, coverage };
  }
  const exactGrantAdmission = decision.basis === 'exact_user_grant'
    && input.durableApproval
    && userGrant
    ? mintHostConsentGrantAdmission({
        prepared,
        call,
        coverage,
        crossing,
        reservationAlreadyClaimed,
        decision,
        consentSubject,
        durableApproval: input.durableApproval,
        userGrant,
      })
    : null;
  if (decision.basis === 'exact_user_grant' && !exactGrantAdmission) {
    return { status: 'conflict', reason: 'exact host consent grant could not be sealed' };
  }
  // Dynamic import keeps the grant mint private to this module while allowing
  // the nested edge to statically import only the one-shot consumer.
  const { issueNestedCallAdmission } = await import('./nested-tool-approval-admission.js');
  const nestedAdmission = issueNestedCallAdmission({
    hostCapabilityBinding: prepared.hostCapabilityBinding,
    workBinding: prepared.binding,
    targetName: prepared.targetName,
    targetArgs: prepared.targetArgs,
    effect: prepared.binding.effect,
    authorityDigest: decision.authorityDigest,
    consentBasis: decision.basis,
    ...(exactGrantAdmission ? { exactGrantAdmission } : {}),
  });
  if (!nestedAdmission) {
    return { status: 'conflict', reason: 'exact nested call admission could not be issued' };
  }
  return { status: 'decided', decision, call, coverage, nestedAdmission };
}

/**
 * Evaluate a graph-neutral mutation. An exact catalog call reopens its already
 * admitted source/call binding as coverage; the graph is not an entrance. The
 * legacy uncovered local projection remains non-authorizing.
 */
export async function evaluateUncoveredHostMutationConsent(input: {
  attestation: HostCallAttestation;
  args: unknown;
  inputSchema?: unknown;
  durableApproval?: DurableHostConsentApproval;
}): Promise<HostInteractiveConsentResult> {
  const attestation = input.attestation;
  if (attestation.bindingKind === 'catalog_manifest') {
    const loaded = loadHostCallCapabilityBinding({ db: openEventLog(), ...attestation });
    if (loaded.status !== 'ok' || !hostCallCapabilityBindingMatchesAttestation(loaded.binding, attestation)) {
      return { status: 'hold', reason: 'exact_host_call_durable_authority_reopen_mismatch', retryable: true };
    }
    const binding = loaded.binding;
    const logical = durableLogicalCallContract(attestation.acceptedTaskId, binding.toolName, input.args);
    if (!logical || logical.argumentDigest !== binding.effectiveArgumentDigest) {
      return { status: 'repair', reason: 'exact_host_call_arguments_do_not_match_binding', retryable: true };
    }
    const target: PreparedConsentTarget = {
      ...attestation,
      targetName: binding.toolName,
      targetArgs: input.args,
      targetInputSchema: input.inputSchema ?? getCachedToolSchema(binding.operationId),
      hostCapabilityBinding: binding,
    };
    const semanticResolution = await semanticBasisForExactCall({
      prepared: target, requirementId: binding.logicalToolCallId, effect: binding.effect,
    });
    if (semanticResolution.status !== 'ready') {
      return { ...semanticResolution, retryable: true };
    }
    const semantic = semanticResolution.semantic;
    const source = sourceFromHostBinding(binding);
    const { call, coverage } = buildHostConsentEvidence({ call: {
      source,
      acceptedTaskId: binding.acceptedTaskId,
      bindingDigest: digest({ version: 1, hostCapabilityBinding: binding.durableBindingDigest,
        logicalToolCallId: binding.logicalToolCallId, argumentDigest: binding.effectiveArgumentDigest,
        semanticBasis: semantic.semanticBasis }),
      logicalToolCallId: binding.logicalToolCallId,
      operationId: semantic.operationId,
      argumentDigest: binding.effectiveArgumentDigest,
      schemaFingerprint: semantic.schemaFingerprint,
      effect: semantic.effect,
      accountId: semantic.accountId,
      destination: semantic.destination,
      cardinality: { kind: 'once' },
      risk: semantic.risk,
      semanticBasis: semantic.semanticBasis,
      safety: semantic.safety,
    }, coverage: () => ({
      contractId: `accepted-call:${digest({ source, acceptedTaskId: binding.acceptedTaskId })}`,
      requirementId: binding.logicalToolCallId,
      requirementDigest: binding.durableBindingDigest,
      reservationKey: digest({ version: 1, hostCapabilityBinding: binding.durableBindingDigest,
        logicalToolCallId: binding.logicalToolCallId, argumentDigest: binding.effectiveArgumentDigest }),
    }) });
    const crossing = crossingFor(binding) ?? 'possibly_started';
    const { decision, consentSubject } = reduceHostConsentEvidence({
      identity: binding, call, coverage, crossing, reservationAlreadyClaimed: false,
      durableApproval: input.durableApproval,
    });
    return { status: 'decided', decision, call, coverage,
      ...(decision.kind === 'needs_user' && decision.need === 'approval' ? { consentSubject } : {}) };
  }
  const source = {
    kind: 'accepted_turn' as const,
    id: attestation.sourceEventId,
    digest: attestation.sourceEventDigest,
  };
  const currentLocal = attestation.bindingKind === 'local_envelope'
    ? await observeCurrentLocalPlanningDefinitions({
        name: attestation.operationId,
        carrier: 'work_call',
      })
    : null;
  const matchingDefinitions = currentLocal?.ok
    ? currentLocal.definitions.filter((definition) => localPlanningArgumentsMatch(definition, input.args))
    : [];
  const definition = matchingDefinitions.length === 1 ? matchingDefinitions[0]! : null;
  const safeMode = definition !== null;
  const destination: InteractiveConsentDestination = definition
    ? {
        posture: definition.descriptor.destinationPosture ?? 'not_applicable',
        digest: digest({
          version: 1,
          source,
          capabilityRef: definition.capabilityRef,
          posture: definition.descriptor.destinationPosture,
        }),
      }
    : { posture: 'not_applicable', digest: digest({ version: 1, source, unknown: true }) };
  const { call, coverage } = buildHostConsentEvidence({ call: {
    source,
    acceptedTaskId: attestation.acceptedTaskId,
    bindingDigest: digest({
      version: 1,
      hostBindingDigest: attestation.bindingDigest,
      logicalToolCallId: attestation.logicalToolCallId,
      argumentDigest: attestation.argumentDigest,
    }),
    logicalToolCallId: attestation.logicalToolCallId,
    operationId: definition?.capabilityRef ?? attestation.operationId,
    argumentDigest: attestation.argumentDigest,
    schemaFingerprint: definition?.schemaFingerprint ?? attestation.schemaFingerprint,
    effect: attestation.effect,
    accountId: definition?.accountIdentity ?? (attestation.accountId || null),
    destination,
    cardinality: { kind: 'once' },
    risk: definition && safeMode
      ? localRisk(definition)
      : { reversibility: 'unknown', consequence: 'unknown', destructive: false },
    semanticBasis: {
      kind: definition ? 'local_registry' : 'documented_live_capability',
      digest: definition?.envelopeFingerprint ?? attestation.bindingDigest,
    },
    safety: 'admissible',
  }, coverage: null });
  const crossing = crossingFor({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    logicalToolCallId: attestation.logicalToolCallId,
  }) ?? 'possibly_started';
  const decision = evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing,
    reservationAlreadyClaimed: false,
  });
  return { status: 'decided', decision, call, coverage };
}
