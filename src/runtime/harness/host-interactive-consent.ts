/**
 * Production-host adapter for the single provider-neutral consent reducer.
 *
 * This module owns I/O projection only: reopen the exact accepted graph,
 * work binding, local capability definition, logical/crossing state and v57
 * host capability binding, then call `evaluateInteractiveConsentV1`. Tool and
 * provider names never enter the reducer as policy branches.
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
import { openEventLog } from './eventlog.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
  loadDurableAuthorizedLocalPlanningDefinition,
  localPlanningArgumentsMatch,
  observeCurrentLocalPlanningDefinition,
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
  | { status: 'conflict'; reason: string };

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
  prepared: PreparedHostWorkCallV1;
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
  graphHash: string;
  nodeId: string;
  definition: AuthorizedLocalPlanningDefinitionV1;
}): InteractiveConsentDestination {
  const posture = input.definition.descriptor.destinationPosture;
  return {
    posture: posture ?? 'not_applicable',
    digest: digest({
      version: 1,
      graphHash: input.graphHash,
      nodeId: input.nodeId,
      capabilityRef: input.definition.capabilityRef,
      posture,
      deliverableKind: input.definition.descriptor.deliverableKind,
      handleRequired: input.definition.descriptor.handleRequired,
    }),
  };
}

function nodeOwnsExplicitCapability(
  node: { capabilities: Array<{ kind: string; resolution: string; names?: string[] }> },
  capabilityId: string,
): boolean {
  return node.capabilities.some((entry) => (
    entry.kind === 'tool'
    && entry.resolution === 'explicit'
    && (entry.names ?? []).length === 1
    && entry.names?.[0] === capabilityId
  ));
}

function externalDestinationFor(input: {
  graph: ReturnType<typeof expectedTaskFor> & { status: 'ok' };
  nodeId: string;
  binding: PreparedHostWorkCallV1['hostCapabilityBinding'];
}): InteractiveConsentDestination | null {
  const goals = input.graph.graph.classification.goalConstraints;
  const destinations = goals?.destinations?.length
    ? goals.destinations
    : goals?.destination ? [goals.destination] : [];
  // Every catalog mutation must be covered by one exact destination frozen in
  // the accepted graph. Absence is unknown coverage, never "not applicable".
  if (destinations.length === 0) return null;
  const exact = destinations.filter((destination) => {
    const binding = destination.binding;
    return Boolean(
      binding
      && binding.manifestId === input.binding.manifestId
      && binding.manifestDigest === input.binding.manifestDigest
      && binding.accountId === input.binding.accountId
      && binding.operationId === input.binding.operationId
      && binding.definitionFingerprint === input.binding.schemaFingerprint
      && binding.effect === input.binding.effect
      && binding.posture === destination.posture,
    );
  });
  if (exact.length !== 1) return null;
  const destination = exact[0]!;
  return {
    posture: destination.posture,
    digest: digest({
      version: 1,
      graphHash: input.graph.graph.compiler.graphHash,
      nodeId: input.nodeId,
      capabilityId: input.binding.capabilityId,
      manifestDigest: input.binding.manifestDigest,
      accountId: input.binding.accountId,
      operationId: input.binding.operationId,
      schemaFingerprint: input.binding.schemaFingerprint,
      posture: destination.posture,
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
  const posture = definition.descriptor.destinationPosture;
  return {
    reversibility: 'reversible',
    consequence: posture === 'create_new'
      ? 'create'
      : posture === 'named_existing'
        ? 'update'
        : 'execute',
    destructive: definition.destructive,
  };
}

async function exactLocalDefinitionForPrepared(input: {
  prepared: PreparedHostWorkCallV1;
  graph: ReturnType<typeof expectedTaskFor> & { status: 'ok' };
}): Promise<{
  definition: AuthorizedLocalPlanningDefinitionV1;
  nodeId: string;
} | null> {
  const nodes = input.graph.graph.nodes.filter((node) => (
    node.operationId === input.prepared.binding.requirementId
  ));
  const candidates: Array<{ definition: AuthorizedLocalPlanningDefinitionV1; nodeId: string }> = [];
  for (const node of nodes) {
    const refs = node.capabilities
      .filter((entry) => entry.kind === 'tool' && entry.resolution === 'explicit')
      .flatMap((entry) => entry.names ?? []);
    for (const capabilityRef of refs) {
      const loaded = await loadDurableAuthorizedLocalPlanningDefinition({
        sessionId: input.prepared.sessionId,
        sourceUserSeq: input.prepared.sourceUserSeq,
        capabilityRef,
      });
      if (
        loaded.ok
        && loaded.definition.name === input.prepared.targetName
        && loaded.definition.carrier === 'work_call'
      ) candidates.push({ definition: loaded.definition, nodeId: node.id });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

interface PreparedConsentSemanticBasis {
  nodeId: string;
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
  prepared: PreparedHostWorkCallV1,
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

async function semanticBasisForPrepared(input: {
  prepared: PreparedHostWorkCallV1;
  graph: ReturnType<typeof expectedTaskFor> & { status: 'ok' };
}): Promise<PreparedConsentSemanticBasis | null> {
  const binding = input.prepared.hostCapabilityBinding;
  if (binding.bindingKind === 'local_envelope') {
    const local = await exactLocalDefinitionForPrepared(input);
    if (
      !local
      || !localPlanningArgumentsMatch(local.definition, input.prepared.targetArgs)
      || local.definition.descriptor.effect !== input.prepared.binding.effect
      || input.prepared.binding.effect !== 'local_write'
    ) return null;
    return {
      nodeId: local.nodeId,
      operationId: local.definition.capabilityRef,
      schemaFingerprint: local.definition.schemaFingerprint,
      effect: 'local_write',
      accountId: local.definition.accountIdentity,
      destination: localDestinationFor({
        graphHash: input.graph.graph.compiler.graphHash,
        nodeId: local.nodeId,
        definition: local.definition,
      }),
      risk: localRisk(local.definition),
      semanticBasis: {
        kind: 'local_registry',
        digest: local.definition.envelopeFingerprint,
      },
      safety: 'admissible',
      requirementCapabilityIdentity: local.definition.capabilityRef,
    };
  }
  if (
    binding.bindingKind !== 'catalog_manifest'
    || binding.effect !== input.prepared.binding.effect
    || (binding.effect !== 'external_write' && binding.effect !== 'admin')
  ) return null;
  const externalCall = exactPreparedExternalCall(input.prepared);
  if (!externalCall) return null;
  const callSignals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: externalCall.inputSchema,
    arguments: externalCall.arguments,
  });
  // Argument-dependent delivery is part of the exact risk subject. A schema
  // that exposes such behavior but cannot close it repairs to the model; null
  // is used only when the projector proved no affirmative signal.
  if (callSignals.status !== 'projected') return null;
  const nodes = input.graph.graph.nodes.filter((node) => (
    node.operationId === input.prepared.binding.requirementId
    && nodeOwnsExplicitCapability(node, binding.capabilityId)
  ));
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  const destination = externalDestinationFor({
    graph: input.graph,
    nodeId: node.id,
    binding,
  });
  if (!destination) return null;
  const loaded = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest',
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
    safety: 'admissible',
  });
  if (!loaded.ok) return null;
  const external = loaded.attestation;
  if (
    external.manifest.manifestId !== binding.manifestId
    || external.manifest.manifestDigest !== binding.manifestDigest
    || external.manifest.operationId !== binding.operationId
    || external.manifest.definitionFingerprint !== binding.schemaFingerprint
    || external.manifest.accountId !== binding.accountId
    || external.projection.effect !== binding.effect
  ) return null;
  return {
    nodeId: node.id,
    operationId: binding.operationId,
    schemaFingerprint: binding.schemaFingerprint,
    effect: external.projection.effect,
    accountId: binding.accountId,
    destination,
    risk: external.projection.risk,
    semanticBasis: external.projection.semanticBasis,
    safety: external.projection.safety,
    requirementCapabilityIdentity: binding.capabilityId,
  };
}

/** Evaluate a fully materialized plan-bound work_call. */
export async function evaluatePreparedHostWorkCallConsent(input: {
  preparation: object;
  durableApproval?: {
    approvalId: string;
    persistedSubject: HostInteractiveConsentSubjectV1;
    outerToolName: string;
    outerRawArguments: string;
  };
}): Promise<HostInteractiveConsentResult> {
  const prepared = inspectPreparedHostWorkCall(input.preparation);
  if (!prepared) return { status: 'conflict', reason: 'work_call preparation is not host-issued' };
  const expected = expectedTaskFor(prepared.sessionId, prepared.sourceUserSeq);
  if (
    expected.status !== 'ok'
    || expected.expectation.acceptedTaskId !== prepared.acceptedTaskId
    || expected.expectation.graphEventId !== prepared.contract.graphEventId
    || expected.expectation.graphId !== prepared.contract.graphId
    || expected.expectation.graphHash !== prepared.contract.graphHash
    || expected.graph.compiler.graphHash !== prepared.contract.graphHash
  ) return { status: 'conflict', reason: 'prepared work no longer matches its accepted graph' };
  const semantic = await semanticBasisForPrepared({
    prepared,
    graph: expected as ReturnType<typeof expectedTaskFor> & { status: 'ok' },
  });
  if (!semantic) {
    return { status: 'conflict', reason: 'prepared capability has no exact current semantic basis' };
  }
  const operation = prepared.contract.operations.find((entry) => (
    entry.id === prepared.binding.requirementId
  ));
  const cardinality = policyCardinality(prepared);
  const crossing = crossingFor(prepared);
  if (
    !operation
    || operation.effect !== prepared.binding.effect
    || operation.effect !== semantic.effect
    || !cardinality
    || !crossing
  ) return { status: 'conflict', reason: 'prepared work binding is not the exact local contract operation' };

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
  const call: CapabilityRiskAttestationV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
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
  };
  const requirementDigest = digest({
    version: 1,
    contractId: prepared.contract.contractId,
    graphHash: prepared.contract.graphHash,
    operation,
    capabilityIdentity: semantic.requirementCapabilityIdentity,
    destination,
    semanticBasis: call.semanticBasis,
  });
  const coverage: ExactWorkCoverageV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    source,
    acceptedTaskId: prepared.acceptedTaskId,
    contractId: prepared.contract.contractId,
    requirementId: prepared.binding.requirementId,
    requirementDigest,
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: call.destination,
      cardinality: call.cardinality,
      semanticBasis: call.semanticBasis,
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: reservationKey({ prepared, cardinality }),
  };
  const reservationAlreadyClaimed = priorReservationExists(prepared);
  // The durable subject is derived from the same pure reducer result on both
  // pause and resume. Do not seed it from a caller-selected approximation:
  // explicit checkpoints may use a subject distinct from the call binding.
  const ungrantedDecision = evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing,
    reservationAlreadyClaimed,
  });
  const decisionSubjectDigest = ungrantedDecision.kind === 'needs_user'
    && ungrantedDecision.need === 'approval'
    ? ungrantedDecision.subjectDigest
    : call.bindingDigest;
  const consentSubject = exactConsentSubject({
    prepared,
    call,
    coverage,
    decisionSubjectDigest,
  });
  const userGrant = input.durableApproval
    ? durableApprovalGrant({
        approvalId: input.durableApproval.approvalId,
        persistedSubject: input.durableApproval.persistedSubject,
        currentSubject: consentSubject,
        outerToolName: input.durableApproval.outerToolName,
        outerRawArguments: input.durableApproval.outerRawArguments,
        call,
      })
    : null;
  if (input.durableApproval && !userGrant) {
    return {
      status: 'decided',
      decision: { kind: 'repair', reason: 'scope_mismatch' },
      call,
      coverage,
    };
  }
  const decision = userGrant
    ? evaluateInteractiveConsentV1({
        call,
        coverage,
        userGrant,
        readiness: { kind: 'ready' },
        crossing,
        reservationAlreadyClaimed,
      })
    : ungrantedDecision;
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
 * Evaluate a graph-neutral mutation. Current local semantics may attest risk,
 * but no accepted-work coverage is manufactured; the reducer therefore emits
 * repair rather than a user approval request.
 */
export async function evaluateUncoveredHostMutationConsent(input: {
  attestation: HostCallAttestation;
  args: unknown;
}): Promise<HostInteractiveConsentResult> {
  const attestation = input.attestation;
  const source = {
    kind: 'accepted_turn' as const,
    id: attestation.sourceEventId,
    digest: attestation.sourceEventDigest,
  };
  const currentLocal = attestation.bindingKind === 'local_envelope'
    ? await observeCurrentLocalPlanningDefinition({
        name: attestation.operationId,
        carrier: 'work_call',
      })
    : null;
  const definition = currentLocal?.ok ? currentLocal.definition : null;
  const safeMode = definition ? localPlanningArgumentsMatch(definition, input.args) : false;
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
  const call: CapabilityRiskAttestationV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
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
  };
  const crossing = crossingFor({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    logicalToolCallId: attestation.logicalToolCallId,
  }) ?? 'possibly_started';
  const decision = evaluateInteractiveConsentV1({
    call,
    coverage: null,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing,
    reservationAlreadyClaimed: false,
  });
  return { status: 'decided', decision, call, coverage: null };
}
