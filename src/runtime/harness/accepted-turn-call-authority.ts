/**
 * One graph-neutral parent for accepted-turn tool calls.
 *
 * Graph execution keeps accepted_task_resolutions as its topology/expected-work
 * authority. Foreground host chat never fabricates one: it arms a distinct,
 * bounded read/compute root. Both kinds parent the same logical_tool_calls and
 * therefore reuse the same physical-dispatch and settlement evidence.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  acceptedTurnCallAuthorityDigest,
  acceptedTurnCallSurfaceDigest,
  acceptedTurnSourceEventDigest,
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  workflowNodeCallAuthorityRootId,
  workflowNodeInvocationActivationDigest,
  workflowNodeInvocationActivationId,
  workflowPaginatedReadActivationDigest,
  workflowPaginatedReadActivationId,
  workflowPaginatedReadAuthorityRootId,
  type EventRow,
  type WorkflowPaginatedReadActivationDigestInput,
  type WorkflowNodeInvocationActivationDigestInput,
} from './eventlog.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import { capabilityManifestDigest, currentCapabilityManifest } from './capability-manifest.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from './independent-capability-observation.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import { parseWorkflowNodeInvocationPlan } from '../../memory/workflow-node-invocation-plan.js';
import { canonicalArgumentDigestOf } from './resolved-call-authority.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { approvalResolutionWithinLifetime } from './approval-registry.js';
import {
  HISTORICAL_TERMINAL_COMPLETE_CLOSE_REASON,
  proveHistoricalTerminalCallAuthorityInTransaction,
} from './historical-terminal-call-authority-proof.js';
import { proveHostPlannedResolutionCoexistenceInTransaction } from './host-planned-resolution-coexistence.js';
import {
  hostCallCapabilityBindingMatchesAttestation,
  loadHostCallCapabilityBinding,
} from './host-call-capability-binding.js';
import {
  deriveExternalCapabilityCallSignalsV1,
  loadCatalogManifestExternalRiskAttestationV1,
} from './external-capability-risk-loader.js';
import {
  evaluateInteractiveConsentV1,
  INTERACTIVE_CONSENT_POLICY_VERSION,
  type CapabilityRiskAttestationV1,
  type ExactWorkCoverageV1,
  type InteractiveConsentDecisionV1,
} from './interactive-consent-policy.js';
import { workflowCapabilityDigest } from '../../execution/workflow-capability-digest.js';

export const HOST_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION = 'host_v1_read_only' as const;
export const HOST_READ_ONLY_EFFECT_CEILING = 'read_compute_host_only' as const;
export const HOST_READ_ONLY_EFFECT_BOUNDS = ['compute', 'host_only', 'read'] as const;
const HOST_READ_ONLY_EFFECT_BOUNDS_JSON = JSON.stringify(HOST_READ_ONLY_EFFECT_BOUNDS);
export const HOST_CALL_AUTHORITY_ENGINE_VERSION = 'host_v1' as const;
export const HOST_CALL_AUTHORITY_SURFACE_VERSION = 'configured_harness_capability_surface_v1' as const;
export const HOST_EFFECT_CEILING = 'admin' as const;
export const HOST_EFFECT_BOUNDS = [
  'admin',
  'compute',
  'external_write',
  'host_only',
  'local_write',
  'read',
] as const;
const HOST_EFFECT_BOUNDS_JSON = JSON.stringify(HOST_EFFECT_BOUNDS);
export const WORKFLOW_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION = 'workflow_v1_read_only' as const;
export const WORKFLOW_READ_ONLY_CALL_AUTHORITY_SURFACE_VERSION = 'workflow_node_invocation_plan_v1' as const;
export const WORKFLOW_READ_ONLY_EFFECT_CEILING = 'read' as const;
export const WORKFLOW_READ_ONLY_EFFECT_BOUNDS = ['read'] as const;
const WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON = JSON.stringify(WORKFLOW_READ_ONLY_EFFECT_BOUNDS);
export const WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION = 'workflow_v2_paginated_read' as const;
export const WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION = 'workflow_paginated_read_plan_v1' as const;
export const WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION = 'workflow_v3_call' as const;
export const WORKFLOW_V3_CALL_AUTHORITY_SURFACE_VERSION = 'workflow_node_invocation_plan_v1' as const;

export type AcceptedTurnCallAuthorityKind =
  | 'turn_graph'
  | 'host_v1'
  | 'host_v1_read_only'
  | 'workflow_v1_read_only'
  | 'workflow_v2_paginated_read'
  | 'workflow_v3_call';
export type HostReadOnlyAdmissibleEffect = typeof HOST_READ_ONLY_EFFECT_BOUNDS[number];
export type HostAdmissibleEffect = typeof HOST_EFFECT_BOUNDS[number];
export type CallAdmissionEffect = HostReadOnlyAdmissibleEffect
  | 'local_write'
  | 'external_write'
  | 'admin'
  | 'unknown';

export interface AcceptedTurnCallAuthority {
  protocolVersion: 1;
  authorityKind: AcceptedTurnCallAuthorityKind;
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    sourceTurn: number;
  };
  sourceEventId: string;
  sourceEventDigest: string;
  engineVersion: string;
  surfaceVersion: string;
  surfaceDigest: string;
  effectCeiling: string;
  effectBounds: string[];
  maxLogicalCalls?: number;
  maxParallelCalls?: number;
  catalogRevisionDigest?: string;
  bindingRevisionDigest?: string;
  graphEventId?: string;
  graphHash?: string;
  workflow?: {
    activationId: string;
    activationDigest: string;
    authorityRootId: string;
    workflowId: string;
    workflowRevision: number;
    workflowDigest: string;
    runId: string;
    runOccurrenceId: string;
    nodeId: string;
    nodeAttempt: number;
    invocationPlanDigest: string;
    bindingSnapshotDigest: string;
    controlDigest: string;
    logicalCallId: string;
  };
  paginatedWorkflow?: {
    activationId: string;
    activationDigest: string;
    authorityRootId: string;
    workflowId: string;
    workflowRevision: number;
    workflowDigest: string;
    runId: string;
    runOccurrenceId: string;
    nodeId: string;
    nodeAttempt: number;
    invocationPlanDigest: string;
    bindingSnapshotDigest: string;
    controlDigest: string;
    maxPages: number;
  };
  authorityDigest: string;
  state: 'open' | 'closed' | 'conflict';
  revision: number;
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
}

interface AuthorityRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  authority_protocol: number;
  authority_kind: AcceptedTurnCallAuthorityKind;
  source_event_id: string;
  source_event_digest: string;
  source_turn: number;
  engine_version: string;
  surface_version: string;
  surface_digest: string;
  effect_ceiling: string;
  effect_bounds_json: string;
  max_logical_calls: number | null;
  max_parallel_calls: number | null;
  catalog_revision_digest: string | null;
  binding_revision_digest: string | null;
  graph_event_id: string | null;
  graph_hash: string | null;
  workflow_activation_id: string | null;
  workflow_activation_digest: string | null;
  workflow_id: string | null;
  workflow_revision: number | null;
  workflow_digest: string | null;
  run_id: string | null;
  run_occurrence_id: string | null;
  workflow_node_id: string | null;
  workflow_node_attempt: number | null;
  invocation_plan_digest: string | null;
  binding_snapshot_digest: string | null;
  control_digest: string | null;
  workflow_logical_call_id: string | null;
  authority_digest: string;
  state: AcceptedTurnCallAuthority['state'];
  revision: number;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

interface SourceRow {
  id: string;
  session_id: string;
  seq: number;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

interface WorkflowActivationRow {
  activation_id: string;
  authority_root_id: string;
  session_id: string;
  source_event_seq: number;
  source_event_id: string;
  source_event_digest: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  run_id: string;
  run_occurrence_id: string;
  node_id: string;
  node_attempt: number;
  invocation_plan_digest: string;
  binding_snapshot_digest: string;
  control_digest: string;
  logical_call_id: string;
  one_shot_authorization_approval_id: string | null;
  one_shot_authorization_resume_key: string | null;
  one_shot_authorization_decision_digest: string | null;
  activation_digest: string;
  activated_at: string;
}

interface WorkflowV3ActivationBindingRow {
  activation_id: string;
  session_id: string;
  authority_binding_digest: string;
  requirement_id: string;
  logical_capability_id: string;
  effect: 'host_only' | 'local_write' | 'external_write' | 'admin';
  canonical_argument_digest: string;
  source_argument_digest: string;
  obligation_digest: string;
  capability_id: string;
  manifest_id: string;
  manifest_digest: string;
  operation_id: string;
  operation_version: string;
  schema_digest: string;
  provider_version: string;
  live_fingerprint: string;
  account_id: string;
  invoke_port_id: string;
  argument_compiler_id: string;
  argument_compiler_version: string;
  activated_at: string;
}

interface WorkflowPaginatedActivationRow {
  activation_id: string;
  authority_root_id: string;
  session_id: string;
  source_event_seq: number;
  source_event_id: string;
  source_event_digest: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  run_id: string;
  run_occurrence_id: string;
  node_id: string;
  node_attempt: number;
  invocation_plan_digest: string;
  binding_snapshot_digest: string;
  control_digest: string;
  max_pages: number;
  cursor_argument: string;
  next_cursor_path: string;
  exhausted_path: string;
  one_shot_authorization_approval_id: string | null;
  one_shot_authorization_resume_key: string | null;
  one_shot_authorization_decision_digest: string | null;
  activation_digest: string;
  aggregate_state: 'open' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'conflict';
  next_page_ordinal: number;
  latest_page_receipt_digest: string | null;
  terminal_aggregate_receipt_id: string | null;
  terminal_aggregate_receipt_digest: string | null;
  activated_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

interface OneShotAuthorizationApprovalRow {
  approval_id: string;
  session_id: string;
  requested_at: string;
  expires_at: string;
  subject: string;
  tool: string | null;
  args_json: string | null;
  status: string;
  resolution: string | null;
  resolver: string | null;
  resolved_at: string | null;
  resume_key: string | null;
  consumed_at: string | null;
  presentation_json: string | null;
}

/** Opaque in-process proof minted only at the host boundary after the exact
 * configured wrapper, sealed capability, current binding revision, accepted
 * source and model call id all agree. Arguments remain value-opaque: the
 * canonical contract digest is enough for the transactional admission wall. */
export interface HostReadOnlyCallAttestation {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  engineVersion: string;
  surfaceVersion: string;
  authorityDigest: string;
  authorityRevision: number;
  surfaceDigest: string;
  catalogRevisionDigest: string;
  bindingRevisionDigest: string;
}

const hostReadOnlyCallAttestationStorage = new AsyncLocalStorage<Readonly<HostReadOnlyCallAttestation>>();

/** One opaque production-host dispatch envelope. Local calls bind the exact
 * configured wrapper/schema; connected calls additionally bind the frozen
 * manifest, account, operation and invoke port. The detailed binding is kept
 * in-process and content-addressed so serialized/model-authored lookalikes are
 * inert. */
export interface HostCallAttestation {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: HostAdmissibleEffect;
  bindingKind: 'local_envelope' | 'catalog_manifest';
  capabilityId: string;
  /** Full canonical digest of the exact provider input schema disclosed with
   * this catalog entry. Distinct from the legacy 32-hex selector fingerprint
   * and from `schemaFingerprint`, which binds the complete manifest. */
  providerInputSchemaDigest?: string;
  schemaFingerprint: string;
  accountId: string;
  invokePortId: string;
  operationId: string;
  manifestId: string;
  manifestDigest: string;
  bindingDigest: string;
  engineVersion: string;
  surfaceVersion: string;
  authorityDigest: string;
  authorityRevision: number;
  surfaceDigest: string;
  catalogRevisionDigest: string;
  bindingRevisionDigest: string;
}

const hostCallAttestationStorage = new AsyncLocalStorage<Readonly<HostCallAttestation>>();

/**
 * Read the exact production-host envelope currently owning this invocation.
 * The value is module-minted, frozen, and ALS-scoped; it is never serialized
 * into model arguments or durable event bytes.
 */
export function currentHostCallAttestation(): Readonly<HostCallAttestation> | undefined {
  return hostCallAttestationStorage.getStore();
}


interface WorkflowReadOnlyCallAttestation {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  activationId: string;
  activationDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  logicalCallId: string;
  /** Canonical logical/ledger name. Provider spelling remains separately
   * sealed as operationId so case normalization cannot fork admission. */
  toolName: string;
  operationId: string;
  argumentDigest: string;
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationVersion: string;
  schemaDigest: string;
  providerVersion: string;
  liveFingerprint: string;
  accountId: string;
  invokePortId: string;
  argumentCompilerId: string;
  argumentCompilerVersion: string;
  authorityDigest: string;
  authorityRevision: number;
}

/** Opaque process capability. Its public fields are audit-only: possession is
 * accepted only when the exact object was minted into the module-private
 * WeakMap after the durable root, plan, live manifest, observation and args all
 * agreed. A model/serialized payload cannot reconstruct one. */
export interface WorkflowReadOnlyCallAttestationProof {
  readonly kind: 'workflow_v1_read_only_call_attestation';
  readonly activationId: string;
  readonly authorityRootId: string;
  readonly logicalCallId: string;
}

const workflowReadOnlyProofs = new WeakMap<object, Readonly<WorkflowReadOnlyCallAttestation>>();
const workflowReadOnlyCallAttestationStorage = new AsyncLocalStorage<Readonly<WorkflowReadOnlyCallAttestation>>();

interface WorkflowV3CallAttestation extends WorkflowReadOnlyCallAttestation {
  authorityBindingDigest: string;
  requirementId: string;
  logicalCapabilityId: string;
  effect: WorkflowV3DurableCapabilityBinding['effect'];
  canonicalArgumentDigest: string;
  sourceArgumentDigest: string;
  obligationDigest: string;
}

export interface WorkflowV3CallAttestationProof {
  readonly kind: 'workflow_v3_call_attestation';
  readonly activationId: string;
  readonly authorityRootId: string;
  readonly logicalCallId: string;
  readonly authorityBindingDigest: string;
}

const workflowV3Proofs = new WeakMap<object, Readonly<WorkflowV3CallAttestation>>();
const workflowV3CallAttestationStorage = new AsyncLocalStorage<Readonly<WorkflowV3CallAttestation>>();

type HarnessDb = ReturnType<typeof openEventLog>;

interface WorkflowV3BindingSqlAdmission {
  values: readonly unknown[];
  consumed: boolean;
}

const workflowV3BindingSqlFunctionInstalled = new WeakSet<object>();
const activeWorkflowV3BindingSqlAdmissions = new WeakMap<object, WorkflowV3BindingSqlAdmission>();

function installWorkflowV3BindingSqlAdmissionFunction(db: HarnessDb): void {
  if (workflowV3BindingSqlFunctionInstalled.has(db)) return;
  db.function(
    'clementine_workflow_v3_binding_admitted_v1',
    { varargs: true },
    (...values: unknown[]): number => {
      const admission = activeWorkflowV3BindingSqlAdmissions.get(db);
      if (
        !admission
        || admission.consumed
        || values.length !== admission.values.length
        || values.some((value, index) => value !== admission.values[index])
      ) return 0;
      admission.consumed = true;
      return 1;
    },
  );
  workflowV3BindingSqlFunctionInstalled.add(db);
}

export type WorkflowV3ActivationFailurePoint = 'after_activation' | 'after_binding';
let workflowV3ActivationFailurePoint: WorkflowV3ActivationFailurePoint | null = null;

/** Isolated-test crash seam. A thrown point is inside the one IMMEDIATE
 * transaction, so activation, consent, binding, event, and root must roll back. */
export function setWorkflowV3ActivationFailurePointForTests(
  point: WorkflowV3ActivationFailurePoint | null,
): void {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') {
    throw new Error('workflow v3 activation failure injection is test-only');
  }
  workflowV3ActivationFailurePoint = point;
}

function crashWorkflowV3ActivationForTest(point: WorkflowV3ActivationFailurePoint): void {
  if (workflowV3ActivationFailurePoint === point) {
    throw new Error(`Injected workflow v3 activation crash ${point}`);
  }
}

export type AcceptedTurnCallAuthorityReadResult =
  | { status: 'ok'; authority: AcceptedTurnCallAuthority }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Keep the proof scoped to the one wrapper invocation. A model cannot mint or
 * serialize this ALS frame, and a sibling concurrent call cannot inherit it. */
export function withHostReadOnlyCallAttestation<T>(
  input: HostReadOnlyCallAttestation,
  work: () => T,
): T {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || input.acceptedTaskId !== acceptedTaskIdFor(input.sessionId, input.sourceUserSeq)
    || !input.sourceEventId.trim()
    || !isSha256(input.sourceEventDigest)
    || input.logicalToolCallId !== input.logicalToolCallId.trim()
    || input.logicalToolCallId.length < 1
    || input.logicalToolCallId.length > 512
    || input.toolName !== input.toolName.trim()
    || input.toolName.length < 1
    || !isSha256(input.argumentDigest)
    || !safeVersion(input.engineVersion)
    || !safeVersion(input.surfaceVersion)
    || !isSha256(input.authorityDigest)
    || !Number.isSafeInteger(input.authorityRevision)
    || input.authorityRevision < 0
    || !isSha256(input.surfaceDigest)
    || !isSha256(input.catalogRevisionDigest)
    || !isSha256(input.bindingRevisionDigest)
  ) throw new Error('host read-only call attestation is malformed');
  return hostReadOnlyCallAttestationStorage.run(Object.freeze({ ...input }), work);
}

function hostReadOnlyCallAttestationMatches(
  authority: AcceptedTurnCallAuthority,
  input: {
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
  },
): boolean {
  const attested = hostReadOnlyCallAttestationStorage.getStore();
  return Boolean(
    attested
    && attested.sessionId === authority.identity.sessionId
    && attested.sourceUserSeq === authority.identity.sourceUserSeq
    && attested.acceptedTaskId === authority.identity.acceptedTaskId
    && attested.acceptedTaskId === input.acceptedTaskId
    && attested.sourceEventId === authority.sourceEventId
    && attested.sourceEventDigest === authority.sourceEventDigest
    && attested.logicalToolCallId === input.logicalToolCallId
    && attested.toolName === input.toolName
    && attested.argumentDigest === input.argumentDigest
    && attested.engineVersion === authority.engineVersion
    && attested.surfaceVersion === authority.surfaceVersion
    && attested.authorityDigest === authority.authorityDigest
    && attested.authorityRevision === authority.revision
    && attested.surfaceDigest === authority.surfaceDigest
    && attested.catalogRevisionDigest === authority.catalogRevisionDigest
    && attested.bindingRevisionDigest === authority.bindingRevisionDigest
  );
}

export function withHostCallAttestation<T>(
  input: HostCallAttestation,
  work: () => T,
): T {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || input.acceptedTaskId !== acceptedTaskIdFor(input.sessionId, input.sourceUserSeq)
    || !input.sourceEventId.trim()
    || !isSha256(input.sourceEventDigest)
    || input.logicalToolCallId !== input.logicalToolCallId.trim()
    || input.logicalToolCallId.length < 1
    || input.logicalToolCallId.length > 512
    || input.toolName !== input.toolName.trim()
    || input.toolName.length < 1
    || !isSha256(input.argumentDigest)
    || !HOST_EFFECT_BOUNDS.includes(input.effect)
    || (input.bindingKind !== 'local_envelope' && input.bindingKind !== 'catalog_manifest')
    || !input.capabilityId.trim()
    || (input.providerInputSchemaDigest !== undefined
      && !isSha256(input.providerInputSchemaDigest))
    || !isSha256(input.schemaFingerprint)
    || !input.invokePortId.trim()
    || !input.operationId.trim()
    || !isSha256(input.bindingDigest)
    || (input.bindingKind === 'catalog_manifest'
      && (!input.accountId.trim() || !input.manifestId.trim() || !isSha256(input.manifestDigest)))
    || (input.bindingKind === 'local_envelope'
      && (input.accountId !== '' || input.manifestId !== '' || input.manifestDigest !== ''))
    || !safeVersion(input.engineVersion)
    || !safeVersion(input.surfaceVersion)
    || !isSha256(input.authorityDigest)
    || !Number.isSafeInteger(input.authorityRevision)
    || input.authorityRevision < 0
    || !isSha256(input.surfaceDigest)
    || !isSha256(input.catalogRevisionDigest)
    || !isSha256(input.bindingRevisionDigest)
  ) throw new Error('host call attestation is malformed');
  return hostCallAttestationStorage.run(Object.freeze({ ...input }), work);
}

function hostCallAttestationMatches(
  db: HarnessDb,
  authority: AcceptedTurnCallAuthority,
  input: {
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: CallAdmissionEffect;
    isNew: boolean;
  },
): boolean {
  const attested = hostCallAttestationStorage.getStore();
  const exactRootAndCall = Boolean(
    attested
    && attested.sessionId === authority.identity.sessionId
    && attested.sourceUserSeq === authority.identity.sourceUserSeq
    && attested.acceptedTaskId === authority.identity.acceptedTaskId
    && attested.acceptedTaskId === input.acceptedTaskId
    && attested.sourceEventId === authority.sourceEventId
    && attested.sourceEventDigest === authority.sourceEventDigest
    && attested.logicalToolCallId === input.logicalToolCallId
    && attested.toolName === input.toolName
    && attested.effect === input.effect
    && attested.engineVersion === authority.engineVersion
    && attested.surfaceVersion === authority.surfaceVersion
    && attested.authorityDigest === authority.authorityDigest
    && attested.authorityRevision === authority.revision
    && attested.surfaceDigest === authority.surfaceDigest
    && attested.catalogRevisionDigest === authority.catalogRevisionDigest
    && attested.bindingRevisionDigest === authority.bindingRevisionDigest
  );
  if (!exactRootAndCall || !attested) return false;
  if (attested.argumentDigest === input.argumentDigest) return true;

  // The trusted resolver may perform one durable raw -> effective argument
  // refinement after the production host has already bound the model's exact
  // carrier envelope. The same inner wrapper then re-enters logical admission
  // under the effective digest. Accept that narrow replay only when all three
  // independent facts agree: this is not a new logical call, the immutable v57
  // host binding verifies the still-live raw attestation, and the logical row
  // proves either the pre-refinement raw state or that exact effective digest.
  // No different tool, call id, effect, account/schema/invoke binding, or
  // second effective contract can pass this branch.
  if (input.isNew) return false;
  const logical = db.prepare(`
    SELECT accepted_task_id, tool_name, argument_digest, raw_argument_digest,
           effective_argument_digest, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    authority.identity.sessionId,
    authority.identity.sourceUserSeq,
    input.logicalToolCallId,
  ) as {
    accepted_task_id: string;
    tool_name: string;
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string | null;
    state: string;
  } | undefined;
  if (
    !logical
    || logical.state !== 'open'
    || logical.accepted_task_id !== input.acceptedTaskId
    || logical.tool_name !== input.toolName
    || logical.raw_argument_digest !== attested.argumentDigest
    || (logical.effective_argument_digest === null
      ? logical.argument_digest !== logical.raw_argument_digest
      : logical.argument_digest !== logical.effective_argument_digest
        || logical.effective_argument_digest !== input.argumentDigest)
  ) return false;
  const binding = loadHostCallCapabilityBinding({
    db,
    sessionId: authority.identity.sessionId,
    sourceUserSeq: authority.identity.sourceUserSeq,
    logicalToolCallId: input.logicalToolCallId,
  });
  return binding.status === 'ok'
    && hostCallCapabilityBindingMatchesAttestation(binding.binding, attested);
}

/** Run exactly one synchronous/async invocation scope under a proof that this
 * module minted. Structural clones and JSON round-trips are inert. */
export function withWorkflowReadOnlyCallAttestation<T>(
  proof: WorkflowReadOnlyCallAttestationProof,
  work: () => T,
): T {
  const attestation = workflowReadOnlyProofs.get(proof as object);
  if (!attestation) throw new Error('workflow read-only call attestation proof is not authentic');
  if (
    proof.kind !== 'workflow_v1_read_only_call_attestation'
    || proof.activationId !== attestation.activationId
    || proof.authorityRootId !== attestation.authorityRootId
    || proof.logicalCallId !== attestation.logicalCallId
  ) throw new Error('workflow read-only call attestation proof was altered');
  return workflowReadOnlyCallAttestationStorage.run(attestation, work);
}

export function withWorkflowV3CallAttestation<T>(
  proof: WorkflowV3CallAttestationProof,
  work: () => T,
): T {
  const attestation = workflowV3Proofs.get(proof as object);
  if (!attestation) throw new Error('workflow v3 call attestation proof is not authentic');
  if (
    proof.kind !== 'workflow_v3_call_attestation'
    || proof.activationId !== attestation.activationId
    || proof.authorityRootId !== attestation.authorityRootId
    || proof.logicalCallId !== attestation.logicalCallId
    || proof.authorityBindingDigest !== attestation.authorityBindingDigest
  ) throw new Error('workflow v3 call attestation proof was altered');
  return workflowV3CallAttestationStorage.run(attestation, work);
}

function workflowReadOnlyCallAttestationMatches(
  authority: AcceptedTurnCallAuthority,
  input: {
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
  },
): boolean {
  const workflow = authority.workflow;
  const attested = workflowReadOnlyCallAttestationStorage.getStore();
  return Boolean(
    workflow
    && attested
    && authority.authorityKind === 'workflow_v1_read_only'
    && attested.sessionId === authority.identity.sessionId
    && attested.sourceEventSeq === authority.identity.sourceUserSeq
    && attested.authorityRootId === authority.identity.acceptedTaskId
    && attested.authorityRootId === input.acceptedTaskId
    && attested.sourceEventId === authority.sourceEventId
    && attested.sourceEventDigest === authority.sourceEventDigest
    && attested.activationId === workflow.activationId
    && attested.activationDigest === workflow.activationDigest
    && attested.workflowId === workflow.workflowId
    && attested.workflowRevision === workflow.workflowRevision
    && attested.workflowDigest === workflow.workflowDigest
    && attested.runId === workflow.runId
    && attested.runOccurrenceId === workflow.runOccurrenceId
    && attested.nodeId === workflow.nodeId
    && attested.nodeAttempt === workflow.nodeAttempt
    && attested.invocationPlanDigest === workflow.invocationPlanDigest
    && attested.bindingSnapshotDigest === workflow.bindingSnapshotDigest
    && attested.controlDigest === workflow.controlDigest
    && attested.logicalCallId === workflow.logicalCallId
    && attested.logicalCallId === input.logicalToolCallId
    && attested.toolName === input.toolName
    && attested.argumentDigest === input.argumentDigest
    && attested.authorityDigest === authority.authorityDigest
    && attested.authorityRevision === authority.revision
  );
}

function workflowV3CallAttestationMatches(
  authority: AcceptedTurnCallAuthority,
  input: {
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: CallAdmissionEffect;
  },
): boolean {
  const workflow = authority.workflow;
  const attested = workflowV3CallAttestationStorage.getStore();
  return Boolean(
    workflow
    && attested
    && authority.authorityKind === 'workflow_v3_call'
    && attested.sessionId === authority.identity.sessionId
    && attested.sourceEventSeq === authority.identity.sourceUserSeq
    && attested.authorityRootId === authority.identity.acceptedTaskId
    && attested.authorityRootId === input.acceptedTaskId
    && attested.sourceEventId === authority.sourceEventId
    && attested.sourceEventDigest === authority.sourceEventDigest
    && attested.activationId === workflow.activationId
    && attested.activationDigest === workflow.activationDigest
    && attested.workflowId === workflow.workflowId
    && attested.workflowRevision === workflow.workflowRevision
    && attested.workflowDigest === workflow.workflowDigest
    && attested.runId === workflow.runId
    && attested.runOccurrenceId === workflow.runOccurrenceId
    && attested.nodeId === workflow.nodeId
    && attested.nodeAttempt === workflow.nodeAttempt
    && attested.invocationPlanDigest === workflow.invocationPlanDigest
    && attested.bindingSnapshotDigest === workflow.bindingSnapshotDigest
    && attested.controlDigest === workflow.controlDigest
    && attested.logicalCallId === workflow.logicalCallId
    && attested.logicalCallId === input.logicalToolCallId
    && attested.toolName === input.toolName
    && attested.argumentDigest === input.argumentDigest
    && attested.effect === input.effect
    && attested.authorityBindingDigest === authority.bindingRevisionDigest
    && attested.authorityDigest === authority.authorityDigest
    && attested.authorityRevision === authority.revision
  );
}

/** Narrow bridge for the shared ledger's independent effect admission. It
 * exposes only the exact effect already sealed by the ambient opaque v3 proof,
 * and only for the same root/tool/argument digest. */
export function workflowV3AttestedEffectForLogicalContract(input: {
  acceptedTaskId: string;
  toolName: string;
  argumentDigest: string;
}): WorkflowV3DurableCapabilityBinding['effect'] | undefined {
  const attested = workflowV3CallAttestationStorage.getStore();
  return attested
    && attested.authorityRootId === input.acceptedTaskId
    && attested.toolName === input.toolName
    && attested.argumentDigest === input.argumentDigest
    ? attested.effect
    : undefined;
}

/** Used only by the physical-I/O CAS after logical/physical reservation. It
 * deliberately exposes a boolean, never the ambient proof bytes. */
export function workflowReadOnlyPhysicalClaimAttestationMatches(input: {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  logicalCallId: string;
  physicalToolName: string;
}): boolean {
  const attested = workflowReadOnlyCallAttestationStorage.getStore();
  return Boolean(
    attested
    && attested.sessionId === input.sessionId
    && attested.sourceEventSeq === input.sourceEventSeq
    && attested.authorityRootId === input.authorityRootId
    && attested.activationId === input.activationId
    && attested.activationDigest === input.activationDigest
    && attested.authorityDigest === input.authorityDigest
    && attested.authorityRevision === input.authorityRevision
    && attested.logicalCallId === input.logicalCallId
    && attested.toolName === input.physicalToolName
  );
}

export function workflowV3PhysicalClaimAttestationMatches(input: {
  sessionId: string;
  sourceEventSeq: number;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  logicalCallId: string;
  physicalToolName: string;
}): boolean {
  const attested = workflowV3CallAttestationStorage.getStore();
  return Boolean(
    attested
    && attested.sessionId === input.sessionId
    && attested.sourceEventSeq === input.sourceEventSeq
    && attested.authorityRootId === input.authorityRootId
    && attested.activationId === input.activationId
    && attested.activationDigest === input.activationDigest
    && attested.authorityDigest === input.authorityDigest
    && attested.authorityRevision === input.authorityRevision
    && attested.logicalCallId === input.logicalCallId
    && attested.toolName === input.physicalToolName
  );
}

function safeVersion(value: string): string | null {
  const normalized = value.trim();
  return normalized.length >= 1
    && normalized.length <= 128
    && /^[A-Za-z0-9._:@/+\-]+$/.test(normalized)
    ? normalized
    : null;
}

function acceptedTaskIdFor(sessionId: string, sourceUserSeq: number): string {
  return `task:${sessionId}#${sourceUserSeq}`;
}

const EMPTY_WORKFLOW_AUTHORITY_COLUMNS = {
  workflow_activation_id: null,
  workflow_activation_digest: null,
  workflow_id: null,
  workflow_revision: null,
  workflow_digest: null,
  run_id: null,
  run_occurrence_id: null,
  workflow_node_id: null,
  workflow_node_attempt: null,
  invocation_plan_digest: null,
  binding_snapshot_digest: null,
  control_digest: null,
  workflow_logical_call_id: null,
} as const;

function sourceRowInTransaction(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
): SourceRow | undefined {
  return db.prepare(`
    SELECT id, session_id, seq, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ? AND seq = ?
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as SourceRow | undefined;
}

function sourceDigest(row: SourceRow): string {
  return acceptedTurnSourceEventDigest({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    turn: row.turn,
    role: row.role,
    type: row.type,
    parentEventId: row.parent_event_id,
    dataJson: row.data_json,
    createdAt: row.created_at,
  });
}

function readRow(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
): AuthorityRow | undefined {
  return db.prepare(`
    SELECT * FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as AuthorityRow | undefined;
}

function project(row: AuthorityRow): AcceptedTurnCallAuthority {
  const effectBounds = JSON.parse(row.effect_bounds_json) as string[];
  return {
    protocolVersion: 1,
    authorityKind: row.authority_kind,
    identity: {
      sessionId: row.session_id,
      sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id,
      sourceTurn: row.source_turn,
    },
    sourceEventId: row.source_event_id,
    sourceEventDigest: row.source_event_digest,
    engineVersion: row.engine_version,
    surfaceVersion: row.surface_version,
    surfaceDigest: row.surface_digest,
    effectCeiling: row.effect_ceiling,
    effectBounds,
    ...(row.max_logical_calls === null ? {} : { maxLogicalCalls: row.max_logical_calls }),
    ...(row.max_parallel_calls === null ? {} : { maxParallelCalls: row.max_parallel_calls }),
    ...(row.catalog_revision_digest ? { catalogRevisionDigest: row.catalog_revision_digest } : {}),
    ...(row.binding_revision_digest ? { bindingRevisionDigest: row.binding_revision_digest } : {}),
    ...(row.graph_event_id ? { graphEventId: row.graph_event_id } : {}),
    ...(row.graph_hash ? { graphHash: row.graph_hash } : {}),
    ...((row.authority_kind === 'workflow_v1_read_only' || row.authority_kind === 'workflow_v3_call')
      && row.workflow_activation_id
      && row.workflow_activation_digest
      && row.workflow_id
      && row.workflow_revision
      && row.workflow_digest
      && row.run_id
      && row.run_occurrence_id
      && row.workflow_node_id
      && row.workflow_node_attempt
      && row.invocation_plan_digest
      && row.binding_snapshot_digest
      && row.control_digest
      && row.workflow_logical_call_id
      ? {
          workflow: {
            activationId: row.workflow_activation_id,
            activationDigest: row.workflow_activation_digest,
            authorityRootId: row.accepted_task_id,
            workflowId: row.workflow_id,
            workflowRevision: row.workflow_revision,
            workflowDigest: row.workflow_digest,
            runId: row.run_id,
            runOccurrenceId: row.run_occurrence_id,
            nodeId: row.workflow_node_id,
            nodeAttempt: row.workflow_node_attempt,
            invocationPlanDigest: row.invocation_plan_digest,
            bindingSnapshotDigest: row.binding_snapshot_digest,
            controlDigest: row.control_digest,
            logicalCallId: row.workflow_logical_call_id,
          },
        }
      : {}),
    ...(row.authority_kind === 'workflow_v2_paginated_read'
      && row.workflow_activation_digest
      && row.workflow_id
      && row.workflow_revision
      && row.workflow_digest
      && row.run_id
      && row.run_occurrence_id
      && row.workflow_node_id
      && row.workflow_node_attempt
      && row.invocation_plan_digest
      && row.binding_snapshot_digest
      && row.control_digest
      && row.max_logical_calls
      ? {
          paginatedWorkflow: {
            activationId: workflowPaginatedReadActivationId(row.workflow_activation_digest),
            activationDigest: row.workflow_activation_digest,
            authorityRootId: row.accepted_task_id,
            workflowId: row.workflow_id,
            workflowRevision: row.workflow_revision,
            workflowDigest: row.workflow_digest,
            runId: row.run_id,
            runOccurrenceId: row.run_occurrence_id,
            nodeId: row.workflow_node_id,
            nodeAttempt: row.workflow_node_attempt,
            invocationPlanDigest: row.invocation_plan_digest,
            bindingSnapshotDigest: row.binding_snapshot_digest,
            controlDigest: row.control_digest,
            maxPages: row.max_logical_calls,
          },
        }
      : {}),
    authorityDigest: row.authority_digest,
    state: row.state,
    revision: row.revision,
    openedAt: row.opened_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
  };
}

function readWorkflowActivationRow(
  db: HarnessDb,
  activationId: string,
): WorkflowActivationRow | undefined {
  return db.prepare(`
    SELECT * FROM workflow_node_invocation_activations
     WHERE activation_id = ?
  `).get(activationId) as WorkflowActivationRow | undefined;
}

function readWorkflowV3ActivationBindingRow(
  db: HarnessDb,
  activationId: string,
): WorkflowV3ActivationBindingRow | undefined {
  return db.prepare(`
    SELECT * FROM workflow_v3_call_activation_bindings
     WHERE activation_id = ?
  `).get(activationId) as WorkflowV3ActivationBindingRow | undefined;
}

function readWorkflowPaginatedActivationRow(
  db: HarnessDb,
  activationId: string,
): WorkflowPaginatedActivationRow | undefined {
  return db.prepare(`
    SELECT * FROM workflow_paginated_read_activations
     WHERE activation_id = ?
  `).get(activationId) as WorkflowPaginatedActivationRow | undefined;
}

function workflowPaginatedActivationInput(
  row: WorkflowPaginatedActivationRow,
): WorkflowPaginatedReadActivationDigestInput {
  return {
    workflowId: row.workflow_id,
    workflowRevision: row.workflow_revision,
    workflowDigest: row.workflow_digest,
    runId: row.run_id,
    runOccurrenceId: row.run_occurrence_id,
    nodeId: row.node_id,
    nodeAttempt: row.node_attempt,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    maxPages: row.max_pages,
    cursorArgument: row.cursor_argument,
    nextCursorPath: row.next_cursor_path,
    exhaustedPath: row.exhausted_path,
    ...(row.one_shot_authorization_approval_id
      && row.one_shot_authorization_resume_key
      && row.one_shot_authorization_decision_digest
      ? {
          oneShotActivationAuthorization: {
            approvalId: row.one_shot_authorization_approval_id,
            resumeKey: row.one_shot_authorization_resume_key,
            decisionDigest: row.one_shot_authorization_decision_digest,
          },
        }
      : {}),
  };
}

function workflowActivationInput(row: WorkflowActivationRow): WorkflowNodeInvocationActivationDigestInput {
  return {
    workflowId: row.workflow_id,
    workflowRevision: row.workflow_revision,
    workflowDigest: row.workflow_digest,
    runId: row.run_id,
    runOccurrenceId: row.run_occurrence_id,
    nodeId: row.node_id,
    nodeAttempt: row.node_attempt,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    logicalCallId: row.logical_call_id,
    ...(row.one_shot_authorization_approval_id
      && row.one_shot_authorization_resume_key
      && row.one_shot_authorization_decision_digest
      ? {
          oneShotActivationAuthorization: {
            approvalId: row.one_shot_authorization_approval_id,
            resumeKey: row.one_shot_authorization_resume_key,
            decisionDigest: row.one_shot_authorization_decision_digest,
          },
        }
      : {}),
  };
}

function oneShotAuthorizationDecisionFromRow(
  row: OneShotAuthorizationApprovalRow,
): ApprovedOneShotActivationDecision | null {
  if (
    row.status !== 'resolved'
    || row.resolution !== 'approved'
    || !row.resume_key
    || !row.resolver
    || !row.resolved_at
    // Conversational approvals belong to their frozen PendingAction and may
    // not be stolen to activate an unrelated workflow occurrence.
    || row.presentation_json !== null
    || !approvalResolutionWithinLifetime({
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
    })
  ) return null;
  let args: Record<string, unknown> | null = null;
  if (row.args_json !== null) {
    try {
      const parsed = JSON.parse(row.args_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      args = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return {
    approvalId: row.approval_id,
    approvalSessionId: row.session_id,
    resumeKey: row.resume_key,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    subject: row.subject,
    tool: row.tool,
    args,
    resolver: row.resolver,
    resolvedAt: row.resolved_at,
  };
}

function exactOneShotAuthorizationRow(
  db: HarnessDb,
  authorization: OneShotActivationAuthorization,
): OneShotAuthorizationApprovalRow | null {
  const row = db.prepare(`
    SELECT approval_id, session_id, requested_at, expires_at, subject, tool,
           args_json, status, resolution, resolver, resolved_at, resume_key,
           consumed_at, presentation_json
      FROM pending_approvals
     WHERE approval_id = ? AND resume_key = ?
     LIMIT 1
  `).get(authorization.approvalId, authorization.resumeKey) as OneShotAuthorizationApprovalRow | undefined;
  const decision = row ? oneShotAuthorizationDecisionFromRow(row) : null;
  if (!row || !decision) return null;
  try {
    return oneShotActivationAuthorizationDecisionDigest(decision) === authorization.decisionDigest
      ? row
      : null;
  } catch {
    return null;
  }
}

/** Generic same-database one-shot grant seam shared by workflow authority
 * kinds. The caller must invoke it inside the transaction that inserts its
 * activation and root; a successful result is not permission to commit later. */
export function consumeOneShotActivationAuthorizationInTransaction(
  db: ReturnType<typeof openEventLog>,
  authorization: OneShotActivationAuthorization,
): { ok: true } | { ok: false; reason: string } {
  const approval = exactOneShotAuthorizationRow(db, authorization);
  if (!approval) {
    return { ok: false, reason: 'workflow activation one-shot authorization is not exact and approved' };
  }
  if (approval.consumed_at !== null) {
    return { ok: false, reason: 'workflow activation one-shot authorization was already consumed' };
  }
  const consumed = db.prepare(`
    UPDATE pending_approvals
       SET consumed_at = ?
     WHERE approval_id = ?
       AND resume_key = ?
       AND status = 'resolved'
       AND resolution = 'approved'
       AND consumed_at IS NULL
       AND presentation_json IS NULL
  `).run(
    new Date().toISOString(),
    authorization.approvalId,
    authorization.resumeKey,
  ).changes;
  return consumed === 1
    ? { ok: true }
    : { ok: false, reason: 'workflow activation one-shot authorization lost its consume CAS' };
}

export function oneShotActivationAuthorizationIsConsumedInTransaction(
  db: ReturnType<typeof openEventLog>,
  authorization: OneShotActivationAuthorization,
): boolean {
  return exactOneShotAuthorizationRow(db, authorization)?.consumed_at !== null;
}

function workflowDigestFields(row: AuthorityRow): Pick<
  import('./eventlog.js').AcceptedTurnCallAuthorityDigestInput,
  | 'workflowActivationId'
  | 'workflowActivationDigest'
  | 'workflowId'
  | 'workflowRevision'
  | 'workflowDigest'
  | 'runId'
  | 'runOccurrenceId'
  | 'workflowNodeId'
  | 'workflowNodeAttempt'
  | 'invocationPlanDigest'
  | 'bindingSnapshotDigest'
  | 'controlDigest'
  | 'workflowLogicalCallId'
> | Record<string, never> {
  if (
    row.authority_kind !== 'workflow_v1_read_only'
    && row.authority_kind !== 'workflow_v2_paginated_read'
    && row.authority_kind !== 'workflow_v3_call'
  ) return {};
  return {
    workflowActivationId: row.workflow_activation_id,
    workflowActivationDigest: row.workflow_activation_digest,
    workflowId: row.workflow_id,
    workflowRevision: row.workflow_revision,
    workflowDigest: row.workflow_digest,
    runId: row.run_id,
    runOccurrenceId: row.run_occurrence_id,
    workflowNodeId: row.workflow_node_id,
    workflowNodeAttempt: row.workflow_node_attempt,
    invocationPlanDigest: row.invocation_plan_digest,
    bindingSnapshotDigest: row.binding_snapshot_digest,
    controlDigest: row.control_digest,
    workflowLogicalCallId: row.workflow_logical_call_id,
  };
}

function verifyRow(
  db: HarnessDb,
  row: AuthorityRow,
): AcceptedTurnCallAuthorityReadResult {
  if (
    row.authority_protocol !== 1
    || (
      !['workflow_v1_read_only', 'workflow_v2_paginated_read', 'workflow_v3_call'].includes(row.authority_kind)
      && row.accepted_task_id !== acceptedTaskIdFor(row.session_id, row.source_user_seq)
    )
    || !isSha256(row.source_event_digest)
    || !isSha256(row.surface_digest)
    || !isSha256(row.authority_digest)
  ) return { status: 'conflict', reason: 'accepted-turn call authority identity is malformed' };
  const source = sourceRowInTransaction(db, row.session_id, row.source_user_seq);
  if (
    !source
    || source.id !== row.source_event_id
    || source.turn !== row.source_turn
    || ((row.authority_kind === 'workflow_v1_read_only' || row.authority_kind === 'workflow_v3_call')
      ? source.role !== 'system' || source.type !== 'workflow_node_invocation_activated'
      : row.authority_kind === 'workflow_v2_paginated_read'
        ? source.role !== 'system' || source.type !== 'workflow_paginated_read_activated'
        : source.role !== 'user' || source.type !== 'user_input_received')
    || sourceDigest(source) !== row.source_event_digest
  ) return { status: 'conflict', reason: 'accepted-turn call authority source digest does not recompute' };
  let effectBounds: string[];
  try {
    const parsed = JSON.parse(row.effect_bounds_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      return { status: 'conflict', reason: 'accepted-turn call authority effect bounds are malformed' };
    }
    effectBounds = parsed;
  } catch {
    return { status: 'conflict', reason: 'accepted-turn call authority effect bounds are unreadable' };
  }
  const recomputedSurface = acceptedTurnCallSurfaceDigest({
    authorityKind: row.authority_kind,
    engineVersion: row.engine_version,
    surfaceVersion: row.surface_version,
    effectCeiling: row.effect_ceiling,
    effectBoundsJson: row.effect_bounds_json,
    maxLogicalCalls: row.max_logical_calls,
    maxParallelCalls: row.max_parallel_calls,
    catalogRevisionDigest: row.catalog_revision_digest,
    bindingRevisionDigest: row.binding_revision_digest,
    graphEventId: row.graph_event_id,
    graphHash: row.graph_hash,
    ...workflowDigestFields(row),
  });
  const recomputedAuthority = acceptedTurnCallAuthorityDigest({
    authorityKind: row.authority_kind,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    sourceEventId: row.source_event_id,
    sourceEventDigest: row.source_event_digest,
    sourceTurn: row.source_turn,
    engineVersion: row.engine_version,
    surfaceVersion: row.surface_version,
    surfaceDigest: row.surface_digest,
    effectCeiling: row.effect_ceiling,
    effectBoundsJson: row.effect_bounds_json,
    maxLogicalCalls: row.max_logical_calls,
    maxParallelCalls: row.max_parallel_calls,
    catalogRevisionDigest: row.catalog_revision_digest,
    bindingRevisionDigest: row.binding_revision_digest,
    graphEventId: row.graph_event_id,
    graphHash: row.graph_hash,
    ...workflowDigestFields(row),
  });
  if (recomputedSurface !== row.surface_digest || recomputedAuthority !== row.authority_digest) {
    return { status: 'conflict', reason: 'accepted-turn call authority digest does not recompute' };
  }
  if (row.authority_kind === 'host_v1') {
    const graphResolution = db.prepare(`
      SELECT 1 FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq);
    const exactPlannedResolution = graphResolution
      ? proveHostPlannedResolutionCoexistenceInTransaction({
          db,
          sessionId: row.session_id,
          sourceUserSeq: row.source_user_seq,
          phase: 'existing',
        })
      : false;
    if (
      (graphResolution && !exactPlannedResolution)
      || row.engine_version !== HOST_CALL_AUTHORITY_ENGINE_VERSION
      || row.surface_version !== HOST_CALL_AUTHORITY_SURFACE_VERSION
      || row.effect_ceiling !== HOST_EFFECT_CEILING
      || row.effect_bounds_json !== HOST_EFFECT_BOUNDS_JSON
      || !Number.isSafeInteger(row.max_logical_calls)
      || !Number.isSafeInteger(row.max_parallel_calls)
      || (row.max_logical_calls ?? 0) <= 0
      || (row.max_parallel_calls ?? 0) <= 0
      || (row.max_parallel_calls ?? 0) > (row.max_logical_calls ?? 0)
      || !isSha256(row.catalog_revision_digest)
      || !isSha256(row.binding_revision_digest)
      || row.graph_event_id !== null
      || row.graph_hash !== null
      || effectBounds.join('\0') !== HOST_EFFECT_BOUNDS.join('\0')
    ) return { status: 'conflict', reason: 'host call authority bounds do not recompute' };
  } else if (row.authority_kind === 'host_v1_read_only') {
    const graphResolution = db.prepare(`
      SELECT 1 FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq);
    if (
      graphResolution
      || row.engine_version !== HOST_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION
      || row.effect_ceiling !== HOST_READ_ONLY_EFFECT_CEILING
      || row.effect_bounds_json !== HOST_READ_ONLY_EFFECT_BOUNDS_JSON
      || !Number.isSafeInteger(row.max_logical_calls)
      || !Number.isSafeInteger(row.max_parallel_calls)
      || (row.max_logical_calls ?? 0) <= 0
      || (row.max_parallel_calls ?? 0) <= 0
      || (row.max_parallel_calls ?? 0) > (row.max_logical_calls ?? 0)
      || !isSha256(row.catalog_revision_digest)
      || !isSha256(row.binding_revision_digest)
      || row.graph_event_id !== null
      || row.graph_hash !== null
      || effectBounds.join('\0') !== HOST_READ_ONLY_EFFECT_BOUNDS.join('\0')
    ) return { status: 'conflict', reason: 'host read-only call authority bounds do not recompute' };
  } else if (row.authority_kind === 'turn_graph') {
    const resolution = db.prepare(`
      SELECT accepted_task_id, graph_event_id, graph_hash, compiler_version,
             effect_ceiling, state
        FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq) as {
      accepted_task_id: string;
      graph_event_id: string;
      graph_hash: string;
      compiler_version: string;
      effect_ceiling: string;
      state: 'open' | 'finalized' | 'legacy_ambiguous';
    } | undefined;
    const expectedState = resolution?.state === 'open'
      ? 'open'
      : resolution?.state === 'finalized' ? 'closed' : 'conflict';
    const historicalTerminalProof = resolution?.state === 'open'
      && row.state === 'closed'
      && row.close_reason === HISTORICAL_TERMINAL_COMPLETE_CLOSE_REASON
      ? proveHistoricalTerminalCallAuthorityInTransaction(db, {
          sessionId: row.session_id,
          sourceUserSeq: row.source_user_seq,
          acceptedTaskId: row.accepted_task_id,
          sourceEventId: row.source_event_id,
          sourceTurn: row.source_turn,
        })
      : null;
    const exactHistoricalTerminalClose = historicalTerminalProof?.status === 'complete'
      && row.closed_at === historicalTerminalProof.terminalAt;
    if (
      !resolution
      || resolution.accepted_task_id !== row.accepted_task_id
      || resolution.graph_event_id !== row.graph_event_id
      || resolution.graph_hash !== row.graph_hash
      || resolution.compiler_version !== row.engine_version
      || resolution.effect_ceiling !== row.effect_ceiling
      || row.surface_version !== 'turn_graph_ir_v1'
      || row.effect_bounds_json !== '[]'
      || row.catalog_revision_digest !== null
      || row.binding_revision_digest !== row.graph_hash
      || !isSha256(row.graph_hash)
      || row.max_logical_calls !== null
      || row.max_parallel_calls !== null
      || (row.state !== expectedState && !exactHistoricalTerminalClose)
    ) return { status: 'conflict', reason: 'graph call authority does not match its exact resolution' };
  } else if (row.authority_kind === 'workflow_v1_read_only') {
    const activation = row.workflow_activation_id
      ? readWorkflowActivationRow(db, row.workflow_activation_id)
      : undefined;
    const activationDigest = activation
      ? workflowNodeInvocationActivationDigest(workflowActivationInput(activation))
      : '';
    const activationAuthorization = activation?.one_shot_authorization_approval_id
      && activation.one_shot_authorization_resume_key
      && activation.one_shot_authorization_decision_digest
      ? {
          approvalId: activation.one_shot_authorization_approval_id,
          resumeKey: activation.one_shot_authorization_resume_key,
          decisionDigest: activation.one_shot_authorization_decision_digest,
        }
      : null;
    const activationAuthorizationHasPartialIdentity = Boolean(activation && (
      activation.one_shot_authorization_approval_id
      || activation.one_shot_authorization_resume_key
      || activation.one_shot_authorization_decision_digest
    )) && !activationAuthorization;
    const authorizationRow = activationAuthorization
      ? exactOneShotAuthorizationRow(db, activationAuthorization)
      : null;
    const graphResolution = db.prepare(`
      SELECT 1 FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq);
    if (
      !activation
      || graphResolution
      || activationAuthorizationHasPartialIdentity
      || (activationAuthorization !== null && (!authorizationRow || authorizationRow.consumed_at === null))
      || activation.activation_digest !== activationDigest
      || activation.activation_id !== workflowNodeInvocationActivationId(activationDigest)
      || activation.authority_root_id !== workflowNodeCallAuthorityRootId(activationDigest)
      || activation.authority_root_id !== row.accepted_task_id
      || activation.session_id !== row.session_id
      || activation.source_event_seq !== row.source_user_seq
      || activation.source_event_id !== row.source_event_id
      || activation.source_event_digest !== row.source_event_digest
      || activation.workflow_id !== row.workflow_id
      || activation.workflow_revision !== row.workflow_revision
      || activation.workflow_digest !== row.workflow_digest
      || activation.run_id !== row.run_id
      || activation.run_occurrence_id !== row.run_occurrence_id
      || activation.node_id !== row.workflow_node_id
      || activation.node_attempt !== row.workflow_node_attempt
      || activation.invocation_plan_digest !== row.invocation_plan_digest
      || activation.binding_snapshot_digest !== row.binding_snapshot_digest
      || activation.control_digest !== row.control_digest
      || activation.logical_call_id !== row.workflow_logical_call_id
      || row.engine_version !== WORKFLOW_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION
      || row.surface_version !== WORKFLOW_READ_ONLY_CALL_AUTHORITY_SURFACE_VERSION
      || row.effect_ceiling !== WORKFLOW_READ_ONLY_EFFECT_CEILING
      || row.effect_bounds_json !== WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON
      || row.max_logical_calls !== 1
      || row.max_parallel_calls !== 1
      || row.catalog_revision_digest !== row.binding_snapshot_digest
      || row.binding_revision_digest !== row.invocation_plan_digest
      || row.graph_event_id !== null
      || row.graph_hash !== null
      || effectBounds.join('\0') !== WORKFLOW_READ_ONLY_EFFECT_BOUNDS.join('\0')
    ) return { status: 'conflict', reason: 'workflow read-only call authority does not match its exact activation' };
  } else if (row.authority_kind === 'workflow_v3_call') {
    const activation = row.workflow_activation_id
      ? readWorkflowActivationRow(db, row.workflow_activation_id)
      : undefined;
    const binding = activation
      ? readWorkflowV3ActivationBindingRow(db, activation.activation_id)
      : undefined;
    const exactInput = activation && binding
      ? workflowV3InputFromRows(db, activation, binding)
      : null;
    const activationDigest = exactInput ? workflowV3ActivationDigest(exactInput) : '';
    const authorization = exactInput?.oneShotActivationAuthorization;
    const authorizationRow = authorization
      ? exactOneShotAuthorizationRow(db, authorization)
      : null;
    const autoReceipt = exactInput && !authorization
      ? exactWorkflowV3AutoReceiptInTransaction(db, workflowV3AutoConsentArmInput(exactInput))
      : null;
    const graphResolution = db.prepare(`
      SELECT 1 FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq);
    if (
      !activation
      || !binding
      || !exactInput
      || graphResolution
      || (binding.effect !== 'host_only'
        && (!authorizationRow || authorizationRow.consumed_at === null)
        && !autoReceipt)
      || activation.activation_digest !== activationDigest
      || activation.activation_id !== workflowNodeInvocationActivationId(activationDigest)
      || activation.authority_root_id !== workflowNodeCallAuthorityRootId(activationDigest)
      || activation.authority_root_id !== row.accepted_task_id
      || activation.session_id !== row.session_id
      || binding.session_id !== row.session_id
      || binding.activated_at !== activation.activated_at
      || activation.source_event_seq !== row.source_user_seq
      || activation.source_event_id !== row.source_event_id
      || activation.source_event_digest !== row.source_event_digest
      || activation.workflow_id !== row.workflow_id
      || activation.workflow_revision !== row.workflow_revision
      || activation.workflow_digest !== row.workflow_digest
      || activation.run_id !== row.run_id
      || activation.run_occurrence_id !== row.run_occurrence_id
      || activation.node_id !== row.workflow_node_id
      || activation.node_attempt !== row.workflow_node_attempt
      || activation.invocation_plan_digest !== row.invocation_plan_digest
      || activation.binding_snapshot_digest !== row.binding_snapshot_digest
      || activation.control_digest !== row.control_digest
      || activation.logical_call_id !== row.workflow_logical_call_id
      || row.engine_version !== WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION
      || row.surface_version !== WORKFLOW_V3_CALL_AUTHORITY_SURFACE_VERSION
      || row.effect_ceiling !== binding.effect
      || row.effect_bounds_json !== JSON.stringify([binding.effect])
      || row.max_logical_calls !== 1
      || row.max_parallel_calls !== 1
      || row.catalog_revision_digest !== row.binding_snapshot_digest
      || row.binding_revision_digest !== binding.authority_binding_digest
      || row.graph_event_id !== null
      || row.graph_hash !== null
      || effectBounds.length !== 1
      || effectBounds[0] !== binding.effect
    ) return { status: 'conflict', reason: 'workflow v3 call authority does not match its exact activation binding' };
  } else {
    const activationId = row.workflow_activation_digest
      ? workflowPaginatedReadActivationId(row.workflow_activation_digest)
      : '';
    const activation = activationId
      ? readWorkflowPaginatedActivationRow(db, activationId)
      : undefined;
    const activationDigest = activation
      ? workflowPaginatedReadActivationDigest(workflowPaginatedActivationInput(activation))
      : '';
    const activationAuthorization = activation?.one_shot_authorization_approval_id
      && activation.one_shot_authorization_resume_key
      && activation.one_shot_authorization_decision_digest
      ? {
          approvalId: activation.one_shot_authorization_approval_id,
          resumeKey: activation.one_shot_authorization_resume_key,
          decisionDigest: activation.one_shot_authorization_decision_digest,
        }
      : null;
    const activationAuthorizationHasPartialIdentity = Boolean(activation && (
      activation.one_shot_authorization_approval_id
      || activation.one_shot_authorization_resume_key
      || activation.one_shot_authorization_decision_digest
    )) && !activationAuthorization;
    const authorizationRow = activationAuthorization
      ? exactOneShotAuthorizationRow(db, activationAuthorization)
      : null;
    const graphResolution = db.prepare(`
      SELECT 1 FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(row.session_id, row.source_user_seq);
    const activationState = activation?.aggregate_state === 'open'
      ? 'open'
      : activation?.aggregate_state === 'conflict'
        ? 'conflict'
        : 'closed';
    if (
      !activation
      || graphResolution
      || activationAuthorizationHasPartialIdentity
      || (activationAuthorization !== null && (!authorizationRow || authorizationRow.consumed_at === null))
      || activation.activation_digest !== activationDigest
      || activation.activation_id !== workflowPaginatedReadActivationId(activationDigest)
      || activation.authority_root_id !== workflowPaginatedReadAuthorityRootId(activationDigest)
      || activation.authority_root_id !== row.accepted_task_id
      || activation.session_id !== row.session_id
      || activation.source_event_seq !== row.source_user_seq
      || activation.source_event_id !== row.source_event_id
      || activation.source_event_digest !== row.source_event_digest
      || activation.workflow_id !== row.workflow_id
      || activation.workflow_revision !== row.workflow_revision
      || activation.workflow_digest !== row.workflow_digest
      || activation.run_id !== row.run_id
      || activation.run_occurrence_id !== row.run_occurrence_id
      || activation.node_id !== row.workflow_node_id
      || activation.node_attempt !== row.workflow_node_attempt
      || activation.invocation_plan_digest !== row.invocation_plan_digest
      || activation.binding_snapshot_digest !== row.binding_snapshot_digest
      || activation.control_digest !== row.control_digest
      || activation.max_pages !== row.max_logical_calls
      || row.workflow_activation_id !== null
      || row.workflow_logical_call_id !== null
      || row.engine_version !== WORKFLOW_PAGINATED_READ_AUTHORITY_ENGINE_VERSION
      || row.surface_version !== WORKFLOW_PAGINATED_READ_AUTHORITY_SURFACE_VERSION
      || row.effect_ceiling !== WORKFLOW_READ_ONLY_EFFECT_CEILING
      || row.effect_bounds_json !== WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON
      || row.max_parallel_calls !== 1
      || row.catalog_revision_digest !== row.binding_snapshot_digest
      || row.binding_revision_digest !== row.invocation_plan_digest
      || row.graph_event_id !== null
      || row.graph_hash !== null
      || effectBounds.join('\0') !== WORKFLOW_READ_ONLY_EFFECT_BOUNDS.join('\0')
      || row.state !== activationState
    ) return { status: 'conflict', reason: 'paginated workflow authority does not match its exact activation' };
  }
  if (row.state === 'conflict') {
    return { status: 'conflict', reason: row.close_reason ?? 'accepted-turn call authority is conflicted' };
  }
  return { status: 'ok', authority: project(row) };
}

export function readAcceptedTurnCallAuthorityInTransaction(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
): AcceptedTurnCallAuthorityReadResult {
  const row = readRow(db, sessionId, sourceUserSeq);
  return row
    ? verifyRow(db, row)
    : { status: 'missing', reason: 'accepted-turn call authority is missing' };
}

export function acceptedTurnCallAuthorityFor(
  sessionId: string,
  sourceUserSeq: number,
): AcceptedTurnCallAuthorityReadResult {
  try {
    return readAcceptedTurnCallAuthorityInTransaction(openEventLog(), sessionId, sourceUserSeq);
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface ArmHostReadOnlyCallAuthorityInput {
  sessionId: string;
  sourceUserSeq: number;
  surfaceVersion: string;
  catalogRevisionDigest: string;
  bindingRevisionDigest: string;
  maxLogicalCalls: number;
  maxParallelCalls: number;
}

export type ArmHostReadOnlyCallAuthorityResult =
  | { status: 'armed' | 'existing'; authority: AcceptedTurnCallAuthority }
  | { status: 'closed' | 'missing' | 'conflict' | 'storage_error'; reason: string };

function hostFrozenInput(
  input: ArmHostReadOnlyCallAuthorityInput,
  source: SourceRow,
): Omit<AuthorityRow, 'state' | 'revision' | 'opened_at' | 'closed_at' | 'close_reason'> | null {
  const sessionId = input.sessionId.trim();
  const surfaceVersion = safeVersion(input.surfaceVersion);
  if (
    !sessionId
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !surfaceVersion
    || !isSha256(input.catalogRevisionDigest)
    || !isSha256(input.bindingRevisionDigest)
    || !Number.isSafeInteger(input.maxLogicalCalls)
    || !Number.isSafeInteger(input.maxParallelCalls)
    || input.maxLogicalCalls <= 0
    || input.maxParallelCalls <= 0
    || input.maxParallelCalls > input.maxLogicalCalls
    || source.session_id !== sessionId
    || source.seq !== input.sourceUserSeq
    || source.role !== 'user'
    || source.type !== 'user_input_received'
    || source.turn < 0
  ) return null;
  const acceptedTaskId = acceptedTaskIdFor(sessionId, input.sourceUserSeq);
  const sourceEventDigest = sourceDigest(source);
  const surfaceDigest = acceptedTurnCallSurfaceDigest({
    authorityKind: 'host_v1_read_only',
    engineVersion: HOST_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
    surfaceVersion,
    effectCeiling: HOST_READ_ONLY_EFFECT_CEILING,
    effectBoundsJson: HOST_READ_ONLY_EFFECT_BOUNDS_JSON,
    maxLogicalCalls: input.maxLogicalCalls,
    maxParallelCalls: input.maxParallelCalls,
    catalogRevisionDigest: input.catalogRevisionDigest,
    bindingRevisionDigest: input.bindingRevisionDigest,
    graphEventId: null,
    graphHash: null,
  });
  const authorityDigest = acceptedTurnCallAuthorityDigest({
    authorityKind: 'host_v1_read_only',
    sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    sourceEventId: source.id,
    sourceEventDigest,
    sourceTurn: source.turn,
    engineVersion: HOST_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
    surfaceVersion,
    surfaceDigest,
    effectCeiling: HOST_READ_ONLY_EFFECT_CEILING,
    effectBoundsJson: HOST_READ_ONLY_EFFECT_BOUNDS_JSON,
    maxLogicalCalls: input.maxLogicalCalls,
    maxParallelCalls: input.maxParallelCalls,
    catalogRevisionDigest: input.catalogRevisionDigest,
    bindingRevisionDigest: input.bindingRevisionDigest,
    graphEventId: null,
    graphHash: null,
  });
  return {
    session_id: sessionId,
    source_user_seq: input.sourceUserSeq,
    accepted_task_id: acceptedTaskId,
    authority_protocol: 1,
    authority_kind: 'host_v1_read_only',
    source_event_id: source.id,
    source_event_digest: sourceEventDigest,
    source_turn: source.turn,
    engine_version: HOST_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
    surface_version: surfaceVersion,
    surface_digest: surfaceDigest,
    effect_ceiling: HOST_READ_ONLY_EFFECT_CEILING,
    effect_bounds_json: HOST_READ_ONLY_EFFECT_BOUNDS_JSON,
    max_logical_calls: input.maxLogicalCalls,
    max_parallel_calls: input.maxParallelCalls,
    catalog_revision_digest: input.catalogRevisionDigest,
    binding_revision_digest: input.bindingRevisionDigest,
    graph_event_id: null,
    graph_hash: null,
    ...EMPTY_WORKFLOW_AUTHORITY_COLUMNS,
    authority_digest: authorityDigest,
  };
}

export interface ArmHostCallAuthorityInput {
  sessionId: string;
  sourceUserSeq: number;
  catalogRevisionDigest: string;
  bindingRevisionDigest: string;
  maxLogicalCalls: number;
  maxParallelCalls: number;
}

export type ArmHostCallAuthorityResult = ArmHostReadOnlyCallAuthorityResult;

function productionHostFrozenInput(
  input: ArmHostCallAuthorityInput,
  source: SourceRow,
): Omit<AuthorityRow, 'state' | 'revision' | 'opened_at' | 'closed_at' | 'close_reason'> | null {
  const sessionId = input.sessionId.trim();
  if (
    !sessionId
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !isSha256(input.catalogRevisionDigest)
    || !isSha256(input.bindingRevisionDigest)
    || !Number.isSafeInteger(input.maxLogicalCalls)
    || !Number.isSafeInteger(input.maxParallelCalls)
    || input.maxLogicalCalls <= 0
    || input.maxParallelCalls <= 0
    || input.maxParallelCalls > input.maxLogicalCalls
    || source.session_id !== sessionId
    || source.seq !== input.sourceUserSeq
    || source.role !== 'user'
    || source.type !== 'user_input_received'
    || source.turn < 0
  ) return null;
  const acceptedTaskId = acceptedTaskIdFor(sessionId, input.sourceUserSeq);
  const sourceEventDigest = sourceDigest(source);
  const surfaceDigest = acceptedTurnCallSurfaceDigest({
    authorityKind: 'host_v1',
    engineVersion: HOST_CALL_AUTHORITY_ENGINE_VERSION,
    surfaceVersion: HOST_CALL_AUTHORITY_SURFACE_VERSION,
    effectCeiling: HOST_EFFECT_CEILING,
    effectBoundsJson: HOST_EFFECT_BOUNDS_JSON,
    maxLogicalCalls: input.maxLogicalCalls,
    maxParallelCalls: input.maxParallelCalls,
    catalogRevisionDigest: input.catalogRevisionDigest,
    bindingRevisionDigest: input.bindingRevisionDigest,
    graphEventId: null,
    graphHash: null,
  });
  const authorityDigest = acceptedTurnCallAuthorityDigest({
    authorityKind: 'host_v1',
    sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    sourceEventId: source.id,
    sourceEventDigest,
    sourceTurn: source.turn,
    engineVersion: HOST_CALL_AUTHORITY_ENGINE_VERSION,
    surfaceVersion: HOST_CALL_AUTHORITY_SURFACE_VERSION,
    surfaceDigest,
    effectCeiling: HOST_EFFECT_CEILING,
    effectBoundsJson: HOST_EFFECT_BOUNDS_JSON,
    maxLogicalCalls: input.maxLogicalCalls,
    maxParallelCalls: input.maxParallelCalls,
    catalogRevisionDigest: input.catalogRevisionDigest,
    bindingRevisionDigest: input.bindingRevisionDigest,
    graphEventId: null,
    graphHash: null,
  });
  return {
    session_id: sessionId,
    source_user_seq: input.sourceUserSeq,
    accepted_task_id: acceptedTaskId,
    authority_protocol: 1,
    authority_kind: 'host_v1',
    source_event_id: source.id,
    source_event_digest: sourceEventDigest,
    source_turn: source.turn,
    engine_version: HOST_CALL_AUTHORITY_ENGINE_VERSION,
    surface_version: HOST_CALL_AUTHORITY_SURFACE_VERSION,
    surface_digest: surfaceDigest,
    effect_ceiling: HOST_EFFECT_CEILING,
    effect_bounds_json: HOST_EFFECT_BOUNDS_JSON,
    max_logical_calls: input.maxLogicalCalls,
    max_parallel_calls: input.maxParallelCalls,
    catalog_revision_digest: input.catalogRevisionDigest,
    binding_revision_digest: input.bindingRevisionDigest,
    graph_event_id: null,
    graph_hash: null,
    ...EMPTY_WORKFLOW_AUTHORITY_COLUMNS,
    authority_digest: authorityDigest,
  };
}

function immutableRowsMatch(
  row: AuthorityRow,
  expected: Omit<AuthorityRow, 'state' | 'revision' | 'opened_at' | 'closed_at' | 'close_reason'>,
): boolean {
  return Object.entries(expected).every(([key, value]) => row[key as keyof AuthorityRow] === value);
}

export function armHostReadOnlyCallAuthority(
  input: ArmHostReadOnlyCallAuthorityInput,
): ArmHostReadOnlyCallAuthorityResult {
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ArmHostReadOnlyCallAuthorityResult => {
      const source = sourceRowInTransaction(db, input.sessionId.trim(), input.sourceUserSeq);
      if (!source) return { status: 'missing', reason: 'exact accepted user source is missing' };
      const frozen = hostFrozenInput(input, source);
      if (!frozen) return { status: 'conflict', reason: 'host read-only call-authority input is invalid' };
      const existing = readRow(db, frozen.session_id, frozen.source_user_seq);
      if (existing) {
        if (!immutableRowsMatch(existing, frozen)) {
          return { status: 'conflict', reason: 'accepted source already has different call authority' };
        }
        const verified = verifyRow(db, existing);
        if (verified.status !== 'ok') return verified;
        if (verified.authority.state !== 'open') {
          return { status: 'closed', reason: 'host read-only call authority is already closed' };
        }
        return { status: 'existing', authority: verified.authority };
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO accepted_turn_call_authorities
          (session_id, source_user_seq, accepted_task_id, authority_protocol,
           authority_kind, source_event_id, source_event_digest, source_turn,
           engine_version, surface_version, surface_digest, effect_ceiling,
           effect_bounds_json, max_logical_calls, max_parallel_calls,
           catalog_revision_digest, binding_revision_digest, graph_event_id,
           graph_hash, authority_digest, state, revision, opened_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'open', 0, ?)
      `).run(
        frozen.session_id,
        frozen.source_user_seq,
        frozen.accepted_task_id,
        frozen.authority_kind,
        frozen.source_event_id,
        frozen.source_event_digest,
        frozen.source_turn,
        frozen.engine_version,
        frozen.surface_version,
        frozen.surface_digest,
        frozen.effect_ceiling,
        frozen.effect_bounds_json,
        frozen.max_logical_calls,
        frozen.max_parallel_calls,
        frozen.catalog_revision_digest,
        frozen.binding_revision_digest,
        frozen.authority_digest,
        now,
      );
      const armed = readAcceptedTurnCallAuthorityInTransaction(db, frozen.session_id, frozen.source_user_seq);
      if (armed.status !== 'ok') throw new Error(`armed host call authority is ${armed.status}: ${armed.reason}`);
      return { status: 'armed', authority: armed.authority };
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function armHostCallAuthority(
  input: ArmHostCallAuthorityInput,
): ArmHostCallAuthorityResult {
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ArmHostCallAuthorityResult => {
      const source = sourceRowInTransaction(db, input.sessionId.trim(), input.sourceUserSeq);
      if (!source) return { status: 'missing', reason: 'exact accepted user source is missing' };
      const frozen = productionHostFrozenInput(input, source);
      if (!frozen) return { status: 'conflict', reason: 'host call-authority input is invalid' };
      const existing = readRow(db, frozen.session_id, frozen.source_user_seq);
      if (existing) {
        if (!immutableRowsMatch(existing, frozen)) {
          return { status: 'conflict', reason: 'accepted source already has different call authority' };
        }
        const verified = verifyRow(db, existing);
        if (verified.status !== 'ok') return verified;
        if (verified.authority.state !== 'open') {
          return { status: 'closed', reason: 'host call authority is already closed' };
        }
        return { status: 'existing', authority: verified.authority };
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO accepted_turn_call_authorities
          (session_id, source_user_seq, accepted_task_id, authority_protocol,
           authority_kind, source_event_id, source_event_digest, source_turn,
           engine_version, surface_version, surface_digest, effect_ceiling,
           effect_bounds_json, max_logical_calls, max_parallel_calls,
           catalog_revision_digest, binding_revision_digest, graph_event_id,
           graph_hash, authority_digest, state, revision, opened_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'open', 0, ?)
      `).run(
        frozen.session_id,
        frozen.source_user_seq,
        frozen.accepted_task_id,
        frozen.authority_kind,
        frozen.source_event_id,
        frozen.source_event_digest,
        frozen.source_turn,
        frozen.engine_version,
        frozen.surface_version,
        frozen.surface_digest,
        frozen.effect_ceiling,
        frozen.effect_bounds_json,
        frozen.max_logical_calls,
        frozen.max_parallel_calls,
        frozen.catalog_revision_digest,
        frozen.binding_revision_digest,
        frozen.authority_digest,
        now,
      );
      const armed = readAcceptedTurnCallAuthorityInTransaction(db, frozen.session_id, frozen.source_user_seq);
      if (armed.status !== 'ok') throw new Error(`armed host call authority is ${armed.status}: ${armed.reason}`);
      return { status: 'armed', authority: armed.authority };
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface ArmWorkflowReadOnlyCallAuthorityInput {
  sessionId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  logicalCallId: string;
  /** Optional exact human/system grant. The approved registry row is consumed
   * in the same SQLite transaction as the activation event and authority root. */
  oneShotActivationAuthorization?: OneShotActivationAuthorization;
}

export interface WorkflowV3DurableCapabilityBinding {
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  operationVersion: string;
  schemaDigest: string;
  providerVersion: string;
  liveFingerprint: string;
  accountId: string;
  effect: 'host_only' | 'local_write' | 'external_write' | 'admin';
  invokePortId: string;
  argumentCompiler: { id: string; version: string };
}

/**
 * Exact call bytes embedded in a pre-existing non-Workflow approval card.
 *
 * A Workspace action already asks the human one exact question containing the
 * action snapshot and caller arguments. Requiring a second workflow_v3_call
 * card for the same effect would create two consent paths. This contract lets
 * that existing row carry the provider-ready v3 binding while keeping the
 * shared activation transaction as the only consumer and dispatch authority.
 * `runOccurrence: approval_id` makes every deliberate later click a new
 * occurrence without inventing an authority id before the registry row exists.
 */
export interface WorkflowV3DelegatedApprovalContractV1 {
  version: 1;
  approvalTool: 'space_execute_action';
  runOccurrence: 'approval_id';
  activationSessionId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  requirementId: string;
  logicalCapabilityId: string;
  canonicalArgumentDigest: string;
  sourceArgumentDigest: string;
  obligationDigest: string;
  binding: WorkflowV3DurableCapabilityBinding;
}

export function workflowV3DelegatedApprovalContract(input: Omit<
  WorkflowV3DelegatedApprovalContractV1,
  'version' | 'approvalTool' | 'runOccurrence'
>): Readonly<WorkflowV3DelegatedApprovalContractV1> {
  return Object.freeze({
    version: 1 as const,
    approvalTool: 'space_execute_action' as const,
    runOccurrence: 'approval_id' as const,
    ...input,
    binding: Object.freeze({
      ...input.binding,
      argumentCompiler: Object.freeze({ ...input.binding.argumentCompiler }),
    }),
  });
}

export interface ArmWorkflowV3CallAuthorityInput extends ArmWorkflowReadOnlyCallAuthorityInput {
  authorityBindingDigest: string;
  requirementId: string;
  logicalCapabilityId: string;
  canonicalArgumentDigest: string;
  sourceArgumentDigest: string;
  obligationDigest: string;
  binding: WorkflowV3DurableCapabilityBinding;
  /** Opaque canonical-Auto decision minted from this exact current binding.
   * It is deliberately not an approval row and carries no copyable authority
   * fields. The durable decision receipt is appended atomically by arm(). */
  autoConsentAuthorization?: WorkflowV3AutoConsentAuthorizationV1;
}

/** Process-opaque authority for one canonical Auto decision. A structural
 * clone has no entry in the module-private WeakMap and grants nothing. */
export interface WorkflowV3AutoConsentAuthorizationV1 {
  readonly version: 1;
}

export type WorkflowV3AutoConsentArmInput = Omit<
  ArmWorkflowV3CallAuthorityInput,
  'oneShotActivationAuthorization' | 'autoConsentAuthorization'
>;

interface WorkflowV3AutoConsentDecisionReceiptV1 {
  version: 1;
  receiptId: string;
  receiptDigest: string;
  authorityInputDigest: string;
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1;
  decision: Extract<InteractiveConsentDecisionV1, { kind: 'proceed' }>;
}

interface WorkflowV3AutoConsentAuthorizationState {
  authorityInput: WorkflowV3AutoConsentArmInput;
  receipt: WorkflowV3AutoConsentDecisionReceiptV1;
}

const workflowV3AutoConsentAuthorizations = new WeakMap<
  object,
  WorkflowV3AutoConsentAuthorizationState
>();

export interface OneShotActivationAuthorization {
  approvalId: string;
  resumeKey: string;
  decisionDigest: string;
}

export interface ApprovedOneShotActivationDecision {
  approvalId: string;
  approvalSessionId: string;
  resumeKey: string;
  requestedAt: string;
  expiresAt: string;
  subject: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  resolver: string;
  resolvedAt: string;
}

function canonicalDecisionJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('one-shot authorization decision is not canonical JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalDecisionJson(entry, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalDecisionJson(record[key], seen)}`
    )).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** Digest callers put beside a one-shot activation authorization. It binds the
 * exact registry request bytes and the exact approved decision, not merely an
 * addressable card id or a user-facing subject. */
export function oneShotActivationAuthorizationDecisionDigest(
  input: ApprovedOneShotActivationDecision,
): string {
  if (
    !input.approvalId.trim()
    || input.approvalId !== input.approvalId.trim()
    || !input.approvalSessionId.trim()
    || input.approvalSessionId !== input.approvalSessionId.trim()
    || !input.resumeKey.trim()
    || input.resumeKey !== input.resumeKey.trim()
    || !input.requestedAt.trim()
    || !input.expiresAt.trim()
    || !input.subject.trim()
    || (input.tool !== null && (!input.tool.trim() || input.tool !== input.tool.trim()))
    || !input.resolver.trim()
    || !input.resolvedAt.trim()
  ) throw new Error('one-shot authorization decision identity is invalid');
  return createHash('sha256').update(canonicalDecisionJson({
    protocolVersion: 1,
    decision: 'approved',
    approvalId: input.approvalId,
    approvalSessionId: input.approvalSessionId,
    resumeKey: input.resumeKey,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    subject: input.subject,
    tool: input.tool,
    args: input.args,
    resolver: input.resolver,
    resolvedAt: input.resolvedAt,
  }), 'utf8').digest('hex');
}

export interface WorkflowReadOnlyCallAuthorityRef {
  sessionId: string;
  sourceEventSeq: number;
  sourceEventId: string;
  sourceEventDigest: string;
  authorityRootId: string;
  activationId: string;
  activationDigest: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  nodeAttempt: number;
  invocationPlanDigest: string;
  bindingSnapshotDigest: string;
  controlDigest: string;
  logicalCallId: string;
  authorityDigest: string;
  authorityRevision: number;
}

export type ArmWorkflowReadOnlyCallAuthorityResult =
  | {
      status: 'armed' | 'existing' | 'existing_closed';
      authority: AcceptedTurnCallAuthority;
      ref: WorkflowReadOnlyCallAuthorityRef;
    }
  | { status: 'closed' | 'missing' | 'conflict' | 'storage_error'; reason: string };

const EXACT_WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

function exactWorkflowId(value: string): boolean {
  return value === value.trim() && EXACT_WORKFLOW_ID_RE.test(value);
}

function validWorkflowArmInput(
  input: ArmWorkflowReadOnlyCallAuthorityInput,
): input is ArmWorkflowReadOnlyCallAuthorityInput {
  const authorization = input.oneShotActivationAuthorization;
  return exactWorkflowId(input.sessionId)
    && exactWorkflowId(input.workflowId)
    && Number.isSafeInteger(input.workflowRevision)
    && input.workflowRevision > 0
    && isSha256(input.workflowDigest)
    && exactWorkflowId(input.runId)
    && exactWorkflowId(input.runOccurrenceId)
    && exactWorkflowId(input.nodeId)
    && Number.isSafeInteger(input.nodeAttempt)
    && input.nodeAttempt > 0
    && isSha256(input.invocationPlanDigest)
    && isSha256(input.bindingSnapshotDigest)
    && isSha256(input.controlDigest)
    && input.logicalCallId === input.logicalCallId.trim()
    && input.logicalCallId.length >= 1
    && input.logicalCallId.length <= 512
    && (authorization === undefined || (
      authorization.approvalId === authorization.approvalId.trim()
      && authorization.approvalId.length >= 1
      && authorization.approvalId.length <= 128
      && authorization.resumeKey === authorization.resumeKey.trim()
      && authorization.resumeKey.length >= 1
      && authorization.resumeKey.length <= 1024
      && isSha256(authorization.decisionDigest)
    ));
}

function workflowActivationDigestInput(
  input: ArmWorkflowReadOnlyCallAuthorityInput,
): WorkflowNodeInvocationActivationDigestInput {
  return {
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: input.invocationPlanDigest,
    bindingSnapshotDigest: input.bindingSnapshotDigest,
    controlDigest: input.controlDigest,
    logicalCallId: input.logicalCallId,
    ...(input.oneShotActivationAuthorization
      ? { oneShotActivationAuthorization: { ...input.oneShotActivationAuthorization } }
      : {}),
  };
}

function validWorkflowV3BaseArmInput(
  input: ArmWorkflowV3CallAuthorityInput,
): input is ArmWorkflowV3CallAuthorityInput {
  const binding = input.binding;
  return validWorkflowArmInput(input)
    && isSha256(input.authorityBindingDigest)
    && exactWorkflowId(input.requirementId)
    && exactWorkflowId(input.logicalCapabilityId)
    && isSha256(input.canonicalArgumentDigest)
    && isSha256(input.sourceArgumentDigest)
    && isSha256(input.obligationDigest)
    && exactWorkflowId(binding.capabilityId)
    && exactWorkflowId(binding.manifestId)
    && isSha256(binding.manifestDigest)
    && exactWorkflowId(binding.operationId)
    && exactWorkflowId(binding.operationVersion)
    && isSha256(binding.schemaDigest)
    && exactWorkflowId(binding.providerVersion)
    && isSha256(binding.liveFingerprint)
    && exactWorkflowId(binding.accountId)
    && ['host_only', 'local_write', 'external_write', 'admin'].includes(binding.effect)
    && exactWorkflowId(binding.invokePortId)
    && exactWorkflowId(binding.argumentCompiler.id)
    && exactWorkflowId(binding.argumentCompiler.version);
}

function workflowV3AutoConsentArmInput(
  input: ArmWorkflowV3CallAuthorityInput,
): WorkflowV3AutoConsentArmInput {
  return {
    sessionId: input.sessionId,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: input.invocationPlanDigest,
    bindingSnapshotDigest: input.bindingSnapshotDigest,
    controlDigest: input.controlDigest,
    logicalCallId: input.logicalCallId,
    authorityBindingDigest: input.authorityBindingDigest,
    requirementId: input.requirementId,
    logicalCapabilityId: input.logicalCapabilityId,
    canonicalArgumentDigest: input.canonicalArgumentDigest,
    sourceArgumentDigest: input.sourceArgumentDigest,
    obligationDigest: input.obligationDigest,
    binding: {
      ...input.binding,
      argumentCompiler: { ...input.binding.argumentCompiler },
    },
  };
}

function exactWorkflowV3AutoConsentState(
  input: ArmWorkflowV3CallAuthorityInput,
): WorkflowV3AutoConsentAuthorizationState | null {
  const authorization = input.autoConsentAuthorization;
  if (!authorization || authorization.version !== 1) return null;
  const state = workflowV3AutoConsentAuthorizations.get(authorization as object);
  if (!state) return null;
  try {
    return closedCanonicalJson(state.authorityInput)
      === closedCanonicalJson(workflowV3AutoConsentArmInput(input))
      ? state
      : null;
  } catch {
    return null;
  }
}

function validWorkflowV3ArmInput(
  input: ArmWorkflowV3CallAuthorityInput,
): input is ArmWorkflowV3CallAuthorityInput {
  if (!validWorkflowV3BaseArmInput(input)) return false;
  const human = input.oneShotActivationAuthorization !== undefined;
  const automatic = exactWorkflowV3AutoConsentState(input) !== null;
  if (human && automatic) return false;
  return input.binding.effect === 'host_only'
    ? !human && !automatic
    : human || automatic;
}

function workflowV3AutoDigest(domain: string, value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson({
    domain,
    version: 1,
    value,
  }), 'utf8').digest('hex');
}

function canonicalSnapshot<T>(value: T): T {
  return JSON.parse(closedCanonicalJson(value)) as T;
}

function workflowV3AutoSource(input: WorkflowV3AutoConsentArmInput): CapabilityRiskAttestationV1['source'] {
  return {
    kind: 'workspace_action',
    id: `workspace:${workflowV3AutoDigest('workspace-action-source-id', {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
    }).slice(0, 40)}`,
    digest: workflowV3AutoDigest('workspace-action-source', {
      workflowId: input.workflowId,
      workflowRevision: input.workflowRevision,
      workflowDigest: input.workflowDigest,
      nodeId: input.nodeId,
    }),
  };
}

function workflowV3AutoAcceptedTaskId(input: WorkflowV3AutoConsentArmInput): string {
  return `workspace-task:${workflowV3AutoDigest('workspace-action-task', {
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
  }).slice(0, 40)}`;
}

function workflowV3AutoBindingDigest(input: {
  authority: WorkflowV3AutoConsentArmInput;
  source: CapabilityRiskAttestationV1['source'];
  destination: CapabilityRiskAttestationV1['destination'];
  semanticBasis: CapabilityRiskAttestationV1['semanticBasis'];
}): string {
  return workflowV3AutoDigest('workspace-action-call-binding', {
    authorityInputDigest: workflowV3AutoDigest('workspace-action-authority-input', input.authority),
    source: input.source,
    destination: input.destination,
    semanticBasis: input.semanticBasis,
  });
}

function workflowV3AutoReceipt(input: {
  authority: WorkflowV3AutoConsentArmInput;
  call: CapabilityRiskAttestationV1;
  coverage: ExactWorkCoverageV1;
  decision: Extract<InteractiveConsentDecisionV1, { kind: 'proceed' }>;
}): WorkflowV3AutoConsentDecisionReceiptV1 {
  const authorityInputDigest = workflowV3AutoDigest(
    'workspace-action-authority-input',
    input.authority,
  );
  const receiptDigest = workflowV3AutoDigest('workflow-v3-auto-consent-receipt', {
    authorityInputDigest,
    call: input.call,
    coverage: input.coverage,
    decision: input.decision,
  });
  return {
    version: 1,
    receiptId: `workflow-v3-auto:${receiptDigest}`,
    receiptDigest,
    authorityInputDigest,
    call: canonicalSnapshot(input.call),
    coverage: canonicalSnapshot(input.coverage),
    decision: canonicalSnapshot(input.decision),
  };
}

function workflowV3AutoReceiptMatchesAuthority(
  receipt: WorkflowV3AutoConsentDecisionReceiptV1,
  authority: WorkflowV3AutoConsentArmInput,
): boolean {
  try {
    if (
      receipt.version !== 1
      || !isSha256(receipt.receiptDigest)
      || receipt.receiptId !== `workflow-v3-auto:${receipt.receiptDigest}`
      || receipt.authorityInputDigest !== workflowV3AutoDigest(
        'workspace-action-authority-input',
        authority,
      )
      || receipt.call.version !== INTERACTIVE_CONSENT_POLICY_VERSION
      || receipt.call.source.kind !== 'workspace_action'
      || receipt.call.source.id !== workflowV3AutoSource(authority).id
      || receipt.call.source.digest !== workflowV3AutoSource(authority).digest
      || receipt.call.acceptedTaskId !== workflowV3AutoAcceptedTaskId(authority)
      || receipt.call.logicalToolCallId !== authority.logicalCallId
      || receipt.call.operationId !== authority.binding.operationId
      || receipt.call.argumentDigest !== authority.canonicalArgumentDigest
      || receipt.call.schemaFingerprint !== authority.binding.liveFingerprint
      || receipt.call.effect !== authority.binding.effect
      || receipt.call.accountId !== authority.binding.accountId
      || receipt.call.cardinality.kind !== 'once'
      || receipt.coverage.acceptedTaskId !== receipt.call.acceptedTaskId
      || receipt.coverage.requirementId !== authority.requirementId
      || receipt.coverage.callBinding.logicalToolCallId !== authority.logicalCallId
      || receipt.coverage.callBinding.argumentDigest !== authority.canonicalArgumentDigest
      || receipt.coverage.callBinding.bindingDigest !== receipt.call.bindingDigest
      || receipt.call.bindingDigest !== workflowV3AutoBindingDigest({
        authority,
        source: receipt.call.source,
        destination: receipt.call.destination,
        semanticBasis: receipt.call.semanticBasis,
      })
    ) return false;
    const reproduced = evaluateInteractiveConsentV1({
      call: receipt.call,
      coverage: receipt.coverage,
      userGrant: null,
      readiness: { kind: 'ready' },
      crossing: 'not_started',
      reservationAlreadyClaimed: false,
    });
    if (
      reproduced.kind !== 'proceed'
      || (reproduced.basis !== 'exact_ordinary_work'
        && reproduced.basis !== 'exact_reversible_work')
      || closedCanonicalJson(reproduced) !== closedCanonicalJson(receipt.decision)
    ) return false;
    return closedCanonicalJson(workflowV3AutoReceipt({
      authority,
      call: receipt.call,
      coverage: receipt.coverage,
      decision: receipt.decision,
    })) === closedCanonicalJson(receipt);
  } catch {
    return false;
  }
}

function workflowV3AutoReceiptFromRow(value: unknown): WorkflowV3AutoConsentDecisionReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = (value as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  return receipt as WorkflowV3AutoConsentDecisionReceiptV1;
}

function exactWorkflowV3AutoReceiptInTransaction(
  db: HarnessDb,
  authority: WorkflowV3AutoConsentArmInput,
): WorkflowV3AutoConsentDecisionReceiptV1 | null {
  const rows = db.prepare(`
    SELECT data_json
      FROM events
     WHERE session_id = ? AND type = 'workflow_v3_auto_consent_decided'
     ORDER BY seq ASC
  `).all(authority.sessionId) as Array<{ data_json: string }>;
  const matches: WorkflowV3AutoConsentDecisionReceiptV1[] = [];
  for (const row of rows) {
    try {
      const receipt = workflowV3AutoReceiptFromRow(JSON.parse(row.data_json));
      if (receipt && workflowV3AutoReceiptMatchesAuthority(receipt, authority)) matches.push(receipt);
    } catch {
      // A malformed private receipt grants nothing and cannot shadow an exact
      // later row. More than one exact row below is still a hard conflict.
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

export type EvaluateWorkflowV3AutoConsentResult =
  | {
      status: 'decided';
      decision: InteractiveConsentDecisionV1;
      call?: CapabilityRiskAttestationV1;
      coverage?: ExactWorkCoverageV1;
      authorization?: WorkflowV3AutoConsentAuthorizationV1;
    }
  | { status: 'conflict'; reason: string };

/** Project one exact current workflow-v3 provider binding through the shared
 * consent reducer. Only ordinary/reversible decisions mint the opaque Auto
 * token; all high-consequence outcomes remain normal human approval needs. */
export function evaluateWorkflowV3AutoConsent(input: {
  authority: WorkflowV3AutoConsentArmInput;
  inputSchema: unknown;
  args: Record<string, unknown>;
}): EvaluateWorkflowV3AutoConsentResult {
  const authority = canonicalSnapshot(input.authority);
  const candidate = authority as ArmWorkflowV3CallAuthorityInput;
  if (
    !validWorkflowV3BaseArmInput(candidate)
    || candidate.oneShotActivationAuthorization !== undefined
    || candidate.autoConsentAuthorization !== undefined
    || authority.binding.effect === 'host_only'
    || canonicalArgumentDigestOf(input.args) !== authority.canonicalArgumentDigest
  ) return { status: 'conflict', reason: 'workflow v3 Auto input is not one exact mutating call' };

  // A committed receipt is already paired atomically with this exact
  // activation. Reissue only the process-opaque address so restart/reentry can
  // reach the kernel's settled replay without consulting a now-drifted live
  // definition and, critically, without creating another provider crossing.
  const existingReceipt = exactWorkflowV3AutoReceiptInTransaction(openEventLog(), authority);
  if (existingReceipt) {
    const authorization = Object.freeze({ version: 1 as const });
    workflowV3AutoConsentAuthorizations.set(authorization, {
      authorityInput: authority,
      receipt: existingReceipt,
    });
    return {
      status: 'decided',
      decision: canonicalSnapshot(existingReceipt.decision),
      call: canonicalSnapshot(existingReceipt.call),
      coverage: canonicalSnapshot(existingReceipt.coverage),
      authorization,
    };
  }

  const factory = peekHostCapabilityCatalogFactory();
  const entry = factory?.get(authority.binding.capabilityId);
  const live = entry ? canonicalCatalogIdentityOf(entry) : null;
  const manifest = entry?.manifest;
  if (
    !entry
    || !live
    || !manifest
    || !currentCapabilityManifest(manifest)
    || capabilityManifestDigest(manifest) !== authority.binding.manifestDigest
    || live.capabilityId !== authority.binding.capabilityId
    || live.manifestId !== authority.binding.manifestId
    || live.manifestDigest !== authority.binding.manifestDigest
    || live.operationId !== authority.binding.operationId
    || live.schemaVersion !== authority.binding.operationVersion
    || workflowCapabilityDigest(live.schemaDigest) !== authority.binding.schemaDigest
    || live.providerVersion !== authority.binding.providerVersion
    || workflowCapabilityDigest(live.liveFingerprint) !== authority.binding.liveFingerprint
    || live.account !== authority.binding.accountId
    || live.effect !== authority.binding.effect
    || live.invokePortId !== authority.binding.invokePortId
    || live.argumentCompiler.id !== authority.binding.argumentCompiler.id
    || live.argumentCompiler.version !== authority.binding.argumentCompiler.version
  ) return { status: 'conflict', reason: 'workflow v3 Auto binding is not the exact current capability' };

  const posture = manifest.destination?.posture;
  if (posture !== 'create_new' && posture !== 'named_existing') {
    return { status: 'conflict', reason: 'workflow v3 Auto destination is not structurally bounded' };
  }
  const destination = {
    posture,
    digest: workflowV3AutoDigest('workspace-action-destination', {
      workflowId: authority.workflowId,
      runOccurrenceId: authority.runOccurrenceId,
      nodeId: authority.nodeId,
      operationId: authority.binding.operationId,
      accountId: authority.binding.accountId,
      manifestDigest: authority.binding.manifestDigest,
      canonicalArgumentDigest: authority.canonicalArgumentDigest,
    }),
  } as const;
  const signals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: input.inputSchema,
    arguments: input.args,
  });
  if (signals.status !== 'projected') {
    return { status: 'conflict', reason: 'workflow v3 Auto call signals are unresolved' };
  }
  const loaded = loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: authority.binding.capabilityId,
      ...(live.providerInputSchemaDigest
        ? { providerInputSchemaDigest: live.providerInputSchemaDigest }
        : {}),
      schemaFingerprint: live.liveFingerprint,
      accountId: authority.binding.accountId,
      invokePortId: authority.binding.invokePortId,
      operationId: authority.binding.operationId,
      manifestId: authority.binding.manifestId,
      manifestDigest: authority.binding.manifestDigest,
      effect: authority.binding.effect,
    },
    inputSchema: input.inputSchema,
    destination,
    callSignals: signals.callSignals,
    safety: 'admissible',
  });
  if (!loaded.ok || loaded.attestation.projection.effect !== authority.binding.effect) {
    return { status: 'conflict', reason: 'workflow v3 Auto risk attestation is unavailable or drifted' };
  }

  const source = workflowV3AutoSource(authority);
  const acceptedTaskId = workflowV3AutoAcceptedTaskId(authority);
  const call: CapabilityRiskAttestationV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    source,
    acceptedTaskId,
    bindingDigest: workflowV3AutoBindingDigest({
      authority,
      source,
      destination,
      semanticBasis: loaded.attestation.projection.semanticBasis,
    }),
    logicalToolCallId: authority.logicalCallId,
    operationId: authority.binding.operationId,
    argumentDigest: authority.canonicalArgumentDigest,
    schemaFingerprint: authority.binding.liveFingerprint,
    effect: authority.binding.effect,
    accountId: authority.binding.accountId,
    destination,
    cardinality: { kind: 'once' },
    risk: loaded.attestation.projection.risk,
    semanticBasis: loaded.attestation.projection.semanticBasis,
    safety: loaded.attestation.projection.safety,
  };
  const coverage: ExactWorkCoverageV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    source: { ...source },
    acceptedTaskId,
    contractId: `workspace-contract:${workflowV3AutoDigest('workspace-action-contract', {
      workflowId: authority.workflowId,
      workflowDigest: authority.workflowDigest,
    }).slice(0, 40)}`,
    requirementId: authority.requirementId,
    requirementDigest: workflowV3AutoDigest('workspace-action-requirement', {
      authorityBindingDigest: authority.authorityBindingDigest,
      requirementId: authority.requirementId,
      call,
    }),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      semanticBasis: { ...call.semanticBasis },
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: `workspace-reservation:${workflowV3AutoDigest('workspace-action-reservation', {
      workflowId: authority.workflowId,
      runId: authority.runId,
      runOccurrenceId: authority.runOccurrenceId,
      nodeId: authority.nodeId,
      nodeAttempt: authority.nodeAttempt,
      authorityBindingDigest: authority.authorityBindingDigest,
    })}`,
  };
  const decision = evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing: 'not_started',
    reservationAlreadyClaimed: false,
  });
  if (
    decision.kind !== 'proceed'
    || (decision.basis !== 'exact_ordinary_work'
      && decision.basis !== 'exact_reversible_work')
  ) return { status: 'decided', decision, call, coverage };

  const receipt = workflowV3AutoReceipt({ authority, call, coverage, decision });
  const authorization = Object.freeze({ version: 1 as const });
  workflowV3AutoConsentAuthorizations.set(authorization, {
    authorityInput: authority,
    receipt,
  });
  return { status: 'decided', decision, call, coverage, authorization };
}

function workflowV3ActivationDigest(input: ArmWorkflowV3CallAuthorityInput): string {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: 1,
    authorityKind: WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowDigest: input.workflowDigest,
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: input.nodeAttempt,
    invocationPlanDigest: input.invocationPlanDigest,
    bindingSnapshotDigest: input.bindingSnapshotDigest,
    controlDigest: input.controlDigest,
    logicalCallId: input.logicalCallId,
    authorityBindingDigest: input.authorityBindingDigest,
    requirementId: input.requirementId,
    logicalCapabilityId: input.logicalCapabilityId,
    canonicalArgumentDigest: input.canonicalArgumentDigest,
    sourceArgumentDigest: input.sourceArgumentDigest,
    obligationDigest: input.obligationDigest,
    binding: input.binding,
    ...(input.oneShotActivationAuthorization
      ? { oneShotActivationAuthorization: input.oneShotActivationAuthorization }
      : {}),
  }), 'utf8').digest('hex');
}

function workflowV3ConsentArgs(input: ArmWorkflowV3CallAuthorityInput): Record<string, unknown> {
  return {
    authorityBindingDigest: input.authorityBindingDigest,
    operationId: input.binding.operationId,
    accountId: input.binding.accountId,
    effect: input.binding.effect,
    canonicalArgumentDigest: input.canonicalArgumentDigest,
  };
}

function workflowV3AuthorizationMatchesExactCall(
  row: OneShotAuthorizationApprovalRow,
  input: ArmWorkflowV3CallAuthorityInput,
): boolean {
  if (!row.args_json) return false;
  try {
    const parsed = JSON.parse(row.args_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (
      row.session_id === input.sessionId
      && row.tool === WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION
    ) {
      return closedCanonicalJson(parsed)
        === closedCanonicalJson(workflowV3ConsentArgs(input));
    }

    // Workspace buttons already own one exact human approval. The host embeds
    // this closed v3 binding in that row before presentation, then revalidates
    // the live action/caller args before reaching this transaction. The row id
    // itself becomes the unique run occurrence, so a later deliberate click
    // receives a distinct activation while replay of this click is stable.
    if (
      row.tool !== 'space_execute_action'
      || input.runId !== row.approval_id
      || input.runOccurrenceId !== row.approval_id
    ) return false;
    const delegated = (parsed as Record<string, unknown>).workflowV3CallAuthorization;
    if (!delegated || typeof delegated !== 'object' || Array.isArray(delegated)) return false;
    const expected = workflowV3DelegatedApprovalContract({
      activationSessionId: input.sessionId,
      workflowId: input.workflowId,
      workflowRevision: input.workflowRevision,
      workflowDigest: input.workflowDigest,
      nodeId: input.nodeId,
      nodeAttempt: input.nodeAttempt,
      invocationPlanDigest: input.invocationPlanDigest,
      bindingSnapshotDigest: input.bindingSnapshotDigest,
      controlDigest: input.controlDigest,
      requirementId: input.requirementId,
      logicalCapabilityId: input.logicalCapabilityId,
      canonicalArgumentDigest: input.canonicalArgumentDigest,
      sourceArgumentDigest: input.sourceArgumentDigest,
      obligationDigest: input.obligationDigest,
      binding: { ...input.binding, argumentCompiler: { ...input.binding.argumentCompiler } },
    });
    return closedCanonicalJson(delegated) === closedCanonicalJson(expected);
  } catch {
    return false;
  }
}

function workflowV3InputFromRows(
  db: HarnessDb,
  activation: WorkflowActivationRow,
  binding: WorkflowV3ActivationBindingRow,
): ArmWorkflowV3CallAuthorityInput | null {
  const authorization = activation.one_shot_authorization_approval_id
    && activation.one_shot_authorization_resume_key
    && activation.one_shot_authorization_decision_digest
    ? {
        approvalId: activation.one_shot_authorization_approval_id,
        resumeKey: activation.one_shot_authorization_resume_key,
        decisionDigest: activation.one_shot_authorization_decision_digest,
      }
    : undefined;
  const input: ArmWorkflowV3CallAuthorityInput = {
    sessionId: activation.session_id,
    workflowId: activation.workflow_id,
    workflowRevision: activation.workflow_revision,
    workflowDigest: activation.workflow_digest,
    runId: activation.run_id,
    runOccurrenceId: activation.run_occurrence_id,
    nodeId: activation.node_id,
    nodeAttempt: activation.node_attempt,
    invocationPlanDigest: activation.invocation_plan_digest,
    bindingSnapshotDigest: activation.binding_snapshot_digest,
    controlDigest: activation.control_digest,
    logicalCallId: activation.logical_call_id,
    authorityBindingDigest: binding.authority_binding_digest,
    requirementId: binding.requirement_id,
    logicalCapabilityId: binding.logical_capability_id,
    canonicalArgumentDigest: binding.canonical_argument_digest,
    sourceArgumentDigest: binding.source_argument_digest,
    obligationDigest: binding.obligation_digest,
    binding: {
      capabilityId: binding.capability_id,
      manifestId: binding.manifest_id,
      manifestDigest: binding.manifest_digest,
      operationId: binding.operation_id,
      operationVersion: binding.operation_version,
      schemaDigest: binding.schema_digest,
      providerVersion: binding.provider_version,
      liveFingerprint: binding.live_fingerprint,
      accountId: binding.account_id,
      effect: binding.effect,
      invokePortId: binding.invoke_port_id,
      argumentCompiler: {
        id: binding.argument_compiler_id,
        version: binding.argument_compiler_version,
      },
    },
    ...(authorization ? { oneShotActivationAuthorization: authorization } : {}),
  };
  if (!validWorkflowV3BaseArmInput(input)) return null;
  if (input.binding.effect === 'host_only') {
    return authorization ? null : input;
  }
  if (authorization) return validWorkflowV3ArmInput(input) ? input : null;
  return exactWorkflowV3AutoReceiptInTransaction(
    db,
    workflowV3AutoConsentArmInput(input),
  ) ? input : null;
}

function workflowAuthorityRef(
  authority: AcceptedTurnCallAuthority,
  expectedKind: 'workflow_v1_read_only' | 'workflow_v3_call' = 'workflow_v1_read_only',
): WorkflowReadOnlyCallAuthorityRef | null {
  const workflow = authority.workflow;
  if (authority.authorityKind !== expectedKind || !workflow) return null;
  return {
    sessionId: authority.identity.sessionId,
    sourceEventSeq: authority.identity.sourceUserSeq,
    sourceEventId: authority.sourceEventId,
    sourceEventDigest: authority.sourceEventDigest,
    authorityRootId: authority.identity.acceptedTaskId,
    activationId: workflow.activationId,
    activationDigest: workflow.activationDigest,
    workflowId: workflow.workflowId,
    workflowRevision: workflow.workflowRevision,
    workflowDigest: workflow.workflowDigest,
    runId: workflow.runId,
    runOccurrenceId: workflow.runOccurrenceId,
    nodeId: workflow.nodeId,
    nodeAttempt: workflow.nodeAttempt,
    invocationPlanDigest: workflow.invocationPlanDigest,
    bindingSnapshotDigest: workflow.bindingSnapshotDigest,
    controlDigest: workflow.controlDigest,
    logicalCallId: workflow.logicalCallId,
    authorityDigest: authority.authorityDigest,
    authorityRevision: authority.revision,
  };
}

function activationMatchesInput(
  row: WorkflowActivationRow,
  input: ArmWorkflowReadOnlyCallAuthorityInput,
  activationDigest: string,
): boolean {
  return row.activation_id === workflowNodeInvocationActivationId(activationDigest)
    && row.authority_root_id === workflowNodeCallAuthorityRootId(activationDigest)
    && row.session_id === input.sessionId
    && row.workflow_id === input.workflowId
    && row.workflow_revision === input.workflowRevision
    && row.workflow_digest === input.workflowDigest
    && row.run_id === input.runId
    && row.run_occurrence_id === input.runOccurrenceId
    && row.node_id === input.nodeId
    && row.node_attempt === input.nodeAttempt
    && row.invocation_plan_digest === input.invocationPlanDigest
    && row.binding_snapshot_digest === input.bindingSnapshotDigest
    && row.control_digest === input.controlDigest
    && row.logical_call_id === input.logicalCallId
    && row.one_shot_authorization_approval_id
      === (input.oneShotActivationAuthorization?.approvalId ?? null)
    && row.one_shot_authorization_resume_key
      === (input.oneShotActivationAuthorization?.resumeKey ?? null)
    && row.one_shot_authorization_decision_digest
      === (input.oneShotActivationAuthorization?.decisionDigest ?? null)
    && row.activation_digest === activationDigest;
}

function readWorkflowAuthorityByActivationInTransaction(
  db: HarnessDb,
  activationId: string,
): AcceptedTurnCallAuthorityReadResult {
  const activation = readWorkflowActivationRow(db, activationId);
  if (!activation) return { status: 'missing', reason: 'workflow node invocation activation is missing' };
  return readAcceptedTurnCallAuthorityInTransaction(
    db,
    activation.session_id,
    activation.source_event_seq,
  );
}

export function readWorkflowReadOnlyCallAuthority(
  activationId: string,
): AcceptedTurnCallAuthorityReadResult {
  if (!activationId.trim()) return { status: 'missing', reason: 'workflow activation id is missing' };
  try {
    return readWorkflowAuthorityByActivationInTransaction(openEventLog(), activationId);
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Atomically append one real workflow activation event, its immutable
 * normalized receipt, and the shared call-authority root. No prompt or
 * provider body can precede a successful result from this function. */
export function armWorkflowReadOnlyCallAuthority(
  input: ArmWorkflowReadOnlyCallAuthorityInput,
): ArmWorkflowReadOnlyCallAuthorityResult {
  if (!validWorkflowArmInput(input)) {
    return { status: 'conflict', reason: 'workflow read-only call-authority input is invalid' };
  }
  const activationDigest = workflowNodeInvocationActivationDigest(
    workflowActivationDigestInput(input),
  );
  const activationId = workflowNodeInvocationActivationId(activationDigest);
  const authorityRootId = workflowNodeCallAuthorityRootId(activationDigest);
  const db = openEventLog();
  let activationEvent: EventRow | null = null;
  try {
    const transaction = db.transaction((): ArmWorkflowReadOnlyCallAuthorityResult => {
      const session = db.prepare('SELECT kind FROM sessions WHERE id = ?').get(input.sessionId) as {
        kind: string;
      } | undefined;
      if (!session) return { status: 'missing', reason: 'workflow activation session is missing' };
      if (session.kind !== 'workflow') {
        return { status: 'conflict', reason: 'workflow activation requires a workflow session' };
      }
      const existingActivation = readWorkflowActivationRow(db, activationId);
      if (existingActivation) {
        if (!activationMatchesInput(existingActivation, input, activationDigest)) {
          return { status: 'conflict', reason: 'workflow activation content address conflicts with its identity' };
        }
        const loaded = readAcceptedTurnCallAuthorityInTransaction(
          db,
          existingActivation.session_id,
          existingActivation.source_event_seq,
        );
        if (loaded.status !== 'ok') return loaded;
        const ref = workflowAuthorityRef(loaded.authority);
        if (!ref) return { status: 'conflict', reason: 'workflow activation has a different call-authority kind' };
        if (loaded.authority.state !== 'open') {
          return { status: 'existing_closed', authority: loaded.authority, ref };
        }
        return { status: 'existing', authority: loaded.authority, ref };
      }
      const foreignOccurrence = db.prepare(`
        SELECT activation_id FROM workflow_node_invocation_activations
         WHERE workflow_id = ? AND workflow_revision = ? AND run_id = ?
           AND run_occurrence_id = ? AND node_id = ? AND node_attempt = ?
      `).get(
        input.workflowId,
        input.workflowRevision,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
      ) as { activation_id: string } | undefined;
      if (foreignOccurrence) {
        return { status: 'conflict', reason: 'workflow node attempt already has a different activation' };
      }
      const authorization = input.oneShotActivationAuthorization;
      if (authorization) {
        const approval = exactOneShotAuthorizationRow(db, authorization);
        if (!approval) {
          return { status: 'conflict', reason: 'workflow activation one-shot authorization is not exact and approved' };
        }
        if (approval.consumed_at !== null) {
          return { status: 'conflict', reason: 'workflow activation one-shot authorization was already consumed' };
        }
        const consumed = db.prepare(`
          UPDATE pending_approvals
             SET consumed_at = ?
           WHERE approval_id = ?
             AND resume_key = ?
             AND status = 'resolved'
             AND resolution = 'approved'
             AND consumed_at IS NULL
             AND presentation_json IS NULL
        `).run(
          new Date().toISOString(),
          authorization.approvalId,
          authorization.resumeKey,
        ).changes;
        if (consumed !== 1) {
          return { status: 'conflict', reason: 'workflow activation one-shot authorization lost its consume CAS' };
        }
      }
      activationEvent = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'workflow_node_invocation_activated',
        data: {
          protocolVersion: 1,
          activationId,
          authorityRootId,
          activationDigest,
          workflowId: input.workflowId,
          workflowRevision: input.workflowRevision,
          workflowDigest: input.workflowDigest,
          runId: input.runId,
          runOccurrenceId: input.runOccurrenceId,
          nodeId: input.nodeId,
          nodeAttempt: input.nodeAttempt,
          invocationPlanDigest: input.invocationPlanDigest,
          bindingSnapshotDigest: input.bindingSnapshotDigest,
          controlDigest: input.controlDigest,
          logicalCallId: input.logicalCallId,
          ...(authorization
            ? { oneShotActivationAuthorization: { ...authorization } }
            : {}),
        },
      });
      const source = sourceRowInTransaction(db, input.sessionId, activationEvent.seq);
      if (!source || source.id !== activationEvent.id) throw new Error('workflow activation source event was not readable');
      const sourceEventDigest = sourceDigest(source);
      db.prepare(`
        INSERT INTO workflow_node_invocation_activations (
          activation_id, authority_root_id, session_id, source_event_seq,
          source_event_id, source_event_digest, workflow_id, workflow_revision,
          workflow_digest, run_id, run_occurrence_id, node_id, node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          logical_call_id, one_shot_authorization_approval_id,
          one_shot_authorization_resume_key,
          one_shot_authorization_decision_digest, activation_digest, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activationId,
        authorityRootId,
        input.sessionId,
        activationEvent.seq,
        activationEvent.id,
        sourceEventDigest,
        input.workflowId,
        input.workflowRevision,
        input.workflowDigest,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
        input.invocationPlanDigest,
        input.bindingSnapshotDigest,
        input.controlDigest,
        input.logicalCallId,
        authorization?.approvalId ?? null,
        authorization?.resumeKey ?? null,
        authorization?.decisionDigest ?? null,
        activationDigest,
        activationEvent.createdAt,
      );
      const workflowFields = {
        workflowActivationId: activationId,
        workflowActivationDigest: activationDigest,
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        workflowDigest: input.workflowDigest,
        runId: input.runId,
        runOccurrenceId: input.runOccurrenceId,
        workflowNodeId: input.nodeId,
        workflowNodeAttempt: input.nodeAttempt,
        invocationPlanDigest: input.invocationPlanDigest,
        bindingSnapshotDigest: input.bindingSnapshotDigest,
        controlDigest: input.controlDigest,
        workflowLogicalCallId: input.logicalCallId,
      } as const;
      const surfaceDigest = acceptedTurnCallSurfaceDigest({
        authorityKind: 'workflow_v1_read_only',
        engineVersion: WORKFLOW_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_READ_ONLY_CALL_AUTHORITY_SURFACE_VERSION,
        effectCeiling: WORKFLOW_READ_ONLY_EFFECT_CEILING,
        effectBoundsJson: WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON,
        maxLogicalCalls: 1,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: input.invocationPlanDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      const authorityDigest = acceptedTurnCallAuthorityDigest({
        authorityKind: 'workflow_v1_read_only',
        sessionId: input.sessionId,
        sourceUserSeq: activationEvent.seq,
        acceptedTaskId: authorityRootId,
        sourceEventId: activationEvent.id,
        sourceEventDigest,
        sourceTurn: 0,
        engineVersion: WORKFLOW_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_READ_ONLY_CALL_AUTHORITY_SURFACE_VERSION,
        surfaceDigest,
        effectCeiling: WORKFLOW_READ_ONLY_EFFECT_CEILING,
        effectBoundsJson: WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON,
        maxLogicalCalls: 1,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: input.invocationPlanDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      db.prepare(`
        INSERT INTO accepted_turn_call_authorities (
          session_id, source_user_seq, accepted_task_id, authority_protocol,
          authority_kind, source_event_id, source_event_digest, source_turn,
          engine_version, surface_version, surface_digest, effect_ceiling,
          effect_bounds_json, max_logical_calls, max_parallel_calls,
          catalog_revision_digest, binding_revision_digest, graph_event_id,
          graph_hash, workflow_activation_id, workflow_activation_digest,
          workflow_id, workflow_revision, workflow_digest, run_id,
          run_occurrence_id, workflow_node_id, workflow_node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          workflow_logical_call_id, authority_digest, state, revision, opened_at
        ) VALUES (
          ?, ?, ?, 1, 'workflow_v1_read_only', ?, ?, 0,
          ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, 'open', 0, ?
        )
      `).run(
        input.sessionId,
        activationEvent.seq,
        authorityRootId,
        activationEvent.id,
        sourceEventDigest,
        WORKFLOW_READ_ONLY_CALL_AUTHORITY_ENGINE_VERSION,
        WORKFLOW_READ_ONLY_CALL_AUTHORITY_SURFACE_VERSION,
        surfaceDigest,
        WORKFLOW_READ_ONLY_EFFECT_CEILING,
        WORKFLOW_READ_ONLY_EFFECT_BOUNDS_JSON,
        input.bindingSnapshotDigest,
        input.invocationPlanDigest,
        activationId,
        activationDigest,
        input.workflowId,
        input.workflowRevision,
        input.workflowDigest,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
        input.invocationPlanDigest,
        input.bindingSnapshotDigest,
        input.controlDigest,
        input.logicalCallId,
        authorityDigest,
        activationEvent.createdAt,
      );
      const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, activationEvent.seq);
      if (loaded.status !== 'ok') throw new Error(`armed workflow call authority is ${loaded.status}: ${loaded.reason}`);
      const ref = workflowAuthorityRef(loaded.authority);
      if (!ref) throw new Error('armed workflow call authority lost its workflow identity');
      return { status: 'armed', authority: loaded.authority, ref };
    });
    const result = transaction.immediate();
    if (result.status === 'armed' && activationEvent) publishCommittedInternalEvent(activationEvent);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type ArmWorkflowV3CallAuthorityResult = ArmWorkflowReadOnlyCallAuthorityResult;

function workflowV3BindingSqlValues(input: {
  activationId: string;
  sessionId: string;
  authorityBindingDigest: string;
  requirementId: string;
  logicalCapabilityId: string;
  canonicalArgumentDigest: string;
  sourceArgumentDigest: string;
  obligationDigest: string;
  binding: WorkflowV3DurableCapabilityBinding;
  activatedAt: string;
}): readonly unknown[] {
  return Object.freeze([
    input.activationId,
    input.sessionId,
    input.authorityBindingDigest,
    input.requirementId,
    input.logicalCapabilityId,
    input.binding.effect,
    input.canonicalArgumentDigest,
    input.sourceArgumentDigest,
    input.obligationDigest,
    input.binding.capabilityId,
    input.binding.manifestId,
    input.binding.manifestDigest,
    input.binding.operationId,
    input.binding.operationVersion,
    input.binding.schemaDigest,
    input.binding.providerVersion,
    input.binding.liveFingerprint,
    input.binding.accountId,
    input.binding.invokePortId,
    input.binding.argumentCompiler.id,
    input.binding.argumentCompiler.version,
    input.activatedAt,
  ]);
}

/** Atomically consume exact consent (when required), append the immutable
 * activation event/base row, persist the complete v3 binding, and open the
 * shared one-call authority root. No partial row is executable. */
export function armWorkflowV3CallAuthority(
  input: ArmWorkflowV3CallAuthorityInput,
): ArmWorkflowV3CallAuthorityResult {
  if (!validWorkflowV3ArmInput(input)) {
    return { status: 'conflict', reason: 'workflow v3 call-authority input is invalid or lacks exact consent' };
  }
  const autoConsent = exactWorkflowV3AutoConsentState(input);
  const activationDigest = workflowV3ActivationDigest(input);
  const activationId = workflowNodeInvocationActivationId(activationDigest);
  const authorityRootId = workflowNodeCallAuthorityRootId(activationDigest);
  const db = openEventLog();
  installWorkflowV3BindingSqlAdmissionFunction(db);
  let activationEvent: EventRow | null = null;
  let autoConsentEvent: EventRow | null = null;
  try {
    const transaction = db.transaction((): ArmWorkflowV3CallAuthorityResult => {
      const session = db.prepare('SELECT kind FROM sessions WHERE id = ?').get(input.sessionId) as {
        kind: string;
      } | undefined;
      if (!session) return { status: 'missing', reason: 'workflow v3 activation session is missing' };
      if (session.kind !== 'workflow') {
        return { status: 'conflict', reason: 'workflow v3 activation requires a workflow session' };
      }

      const existingActivation = readWorkflowActivationRow(db, activationId);
      if (existingActivation) {
        const existingBinding = readWorkflowV3ActivationBindingRow(db, activationId);
        const reconstructed = existingBinding
          ? workflowV3InputFromRows(db, existingActivation, existingBinding)
          : null;
        if (
          !existingBinding
          || !reconstructed
          || workflowV3ActivationDigest(reconstructed) !== activationDigest
          || existingBinding.authority_binding_digest !== input.authorityBindingDigest
          || existingActivation.authority_root_id !== authorityRootId
        ) return { status: 'conflict', reason: 'workflow v3 activation content address conflicts with its identity' };
        const loaded = readAcceptedTurnCallAuthorityInTransaction(
          db,
          existingActivation.session_id,
          existingActivation.source_event_seq,
        );
        if (loaded.status !== 'ok') return loaded;
        const ref = workflowAuthorityRef(loaded.authority, 'workflow_v3_call');
        if (!ref) return { status: 'conflict', reason: 'workflow v3 activation has a different call-authority kind' };
        return loaded.authority.state === 'open'
          ? { status: 'existing', authority: loaded.authority, ref }
          : { status: 'existing_closed', authority: loaded.authority, ref };
      }

      const foreignOccurrence = db.prepare(`
        SELECT activation_id FROM workflow_node_invocation_activations
         WHERE workflow_id = ? AND workflow_revision = ? AND run_id = ?
           AND run_occurrence_id = ? AND node_id = ? AND node_attempt = ?
      `).get(
        input.workflowId,
        input.workflowRevision,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
      ) as { activation_id: string } | undefined;
      if (foreignOccurrence) {
        return { status: 'conflict', reason: 'workflow node attempt already has a different activation' };
      }

      if (input.oneShotActivationAuthorization) {
        const exactApproval = exactOneShotAuthorizationRow(db, input.oneShotActivationAuthorization);
        if (!exactApproval || !workflowV3AuthorizationMatchesExactCall(exactApproval, input)) {
          return { status: 'conflict', reason: 'workflow v3 authorization does not bind the exact call identity' };
        }
        const consumed = consumeOneShotActivationAuthorizationInTransaction(
          db,
          input.oneShotActivationAuthorization,
        );
        if (!consumed.ok) return { status: 'conflict', reason: consumed.reason };
      }

      if (autoConsent) {
        if (
          !workflowV3AutoReceiptMatchesAuthority(autoConsent.receipt, autoConsent.authorityInput)
          || exactWorkflowV3AutoReceiptInTransaction(db, autoConsent.authorityInput)
        ) {
          return { status: 'conflict', reason: 'workflow v3 Auto decision receipt is invalid or already bound' };
        }
        autoConsentEvent = insertInternalEventInTransaction(db, {
          sessionId: input.sessionId,
          turn: 0,
          role: 'system',
          type: 'workflow_v3_auto_consent_decided',
          data: {
            protocolVersion: 1,
            receipt: canonicalSnapshot(autoConsent.receipt),
          },
        });
      }

      activationEvent = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'workflow_node_invocation_activated',
        data: {
          protocolVersion: 1,
          activationId,
          authorityRootId,
          activationDigest,
          workflowId: input.workflowId,
          workflowRevision: input.workflowRevision,
          workflowDigest: input.workflowDigest,
          runId: input.runId,
          runOccurrenceId: input.runOccurrenceId,
          nodeId: input.nodeId,
          nodeAttempt: input.nodeAttempt,
          invocationPlanDigest: input.invocationPlanDigest,
          bindingSnapshotDigest: input.bindingSnapshotDigest,
          controlDigest: input.controlDigest,
          logicalCallId: input.logicalCallId,
          ...(input.oneShotActivationAuthorization
            ? { oneShotActivationAuthorization: { ...input.oneShotActivationAuthorization } }
            : {}),
        },
      });
      const source = sourceRowInTransaction(db, input.sessionId, activationEvent.seq);
      if (!source || source.id !== activationEvent.id) throw new Error('workflow v3 activation source event was not readable');
      const sourceEventDigest = sourceDigest(source);
      db.prepare(`
        INSERT INTO workflow_node_invocation_activations (
          activation_id, authority_root_id, session_id, source_event_seq,
          source_event_id, source_event_digest, workflow_id, workflow_revision,
          workflow_digest, run_id, run_occurrence_id, node_id, node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          logical_call_id, one_shot_authorization_approval_id,
          one_shot_authorization_resume_key,
          one_shot_authorization_decision_digest, activation_digest, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activationId,
        authorityRootId,
        input.sessionId,
        activationEvent.seq,
        activationEvent.id,
        sourceEventDigest,
        input.workflowId,
        input.workflowRevision,
        input.workflowDigest,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
        input.invocationPlanDigest,
        input.bindingSnapshotDigest,
        input.controlDigest,
        input.logicalCallId,
        input.oneShotActivationAuthorization?.approvalId ?? null,
        input.oneShotActivationAuthorization?.resumeKey ?? null,
        input.oneShotActivationAuthorization?.decisionDigest ?? null,
        activationDigest,
        activationEvent.createdAt,
      );
      crashWorkflowV3ActivationForTest('after_activation');

      const bindingValues = workflowV3BindingSqlValues({
        activationId,
        sessionId: input.sessionId,
        authorityBindingDigest: input.authorityBindingDigest,
        requirementId: input.requirementId,
        logicalCapabilityId: input.logicalCapabilityId,
        canonicalArgumentDigest: input.canonicalArgumentDigest,
        sourceArgumentDigest: input.sourceArgumentDigest,
        obligationDigest: input.obligationDigest,
        binding: input.binding,
        activatedAt: activationEvent.createdAt,
      });
      const admission: WorkflowV3BindingSqlAdmission = { values: bindingValues, consumed: false };
      activeWorkflowV3BindingSqlAdmissions.set(db, admission);
      try {
        db.prepare(`
          INSERT INTO workflow_v3_call_activation_bindings (
            activation_id, session_id, authority_binding_digest,
            requirement_id, logical_capability_id, effect,
            canonical_argument_digest, source_argument_digest, obligation_digest,
            capability_id, manifest_id, manifest_digest, operation_id,
            operation_version, schema_digest, provider_version, live_fingerprint,
            account_id, invoke_port_id, argument_compiler_id,
            argument_compiler_version, activated_at
          ) VALUES (${bindingValues.map(() => '?').join(', ')})
        `).run(...bindingValues);
      } finally {
        activeWorkflowV3BindingSqlAdmissions.delete(db);
      }
      if (!admission.consumed) throw new Error('workflow v3 binding did not consume its opaque SQL admission');
      crashWorkflowV3ActivationForTest('after_binding');

      const workflowFields = {
        workflowActivationId: activationId,
        workflowActivationDigest: activationDigest,
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        workflowDigest: input.workflowDigest,
        runId: input.runId,
        runOccurrenceId: input.runOccurrenceId,
        workflowNodeId: input.nodeId,
        workflowNodeAttempt: input.nodeAttempt,
        invocationPlanDigest: input.invocationPlanDigest,
        bindingSnapshotDigest: input.bindingSnapshotDigest,
        controlDigest: input.controlDigest,
        workflowLogicalCallId: input.logicalCallId,
      } as const;
      const effectBoundsJson = JSON.stringify([input.binding.effect]);
      const surfaceDigest = acceptedTurnCallSurfaceDigest({
        authorityKind: 'workflow_v3_call',
        engineVersion: WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_V3_CALL_AUTHORITY_SURFACE_VERSION,
        effectCeiling: input.binding.effect,
        effectBoundsJson,
        maxLogicalCalls: 1,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: input.authorityBindingDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      const authorityDigest = acceptedTurnCallAuthorityDigest({
        authorityKind: 'workflow_v3_call',
        sessionId: input.sessionId,
        sourceUserSeq: activationEvent.seq,
        acceptedTaskId: authorityRootId,
        sourceEventId: activationEvent.id,
        sourceEventDigest,
        sourceTurn: 0,
        engineVersion: WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
        surfaceVersion: WORKFLOW_V3_CALL_AUTHORITY_SURFACE_VERSION,
        surfaceDigest,
        effectCeiling: input.binding.effect,
        effectBoundsJson,
        maxLogicalCalls: 1,
        maxParallelCalls: 1,
        catalogRevisionDigest: input.bindingSnapshotDigest,
        bindingRevisionDigest: input.authorityBindingDigest,
        graphEventId: null,
        graphHash: null,
        ...workflowFields,
      });
      db.prepare(`
        INSERT INTO accepted_turn_call_authorities (
          session_id, source_user_seq, accepted_task_id, authority_protocol,
          authority_kind, source_event_id, source_event_digest, source_turn,
          engine_version, surface_version, surface_digest, effect_ceiling,
          effect_bounds_json, max_logical_calls, max_parallel_calls,
          catalog_revision_digest, binding_revision_digest, graph_event_id,
          graph_hash, workflow_activation_id, workflow_activation_digest,
          workflow_id, workflow_revision, workflow_digest, run_id,
          run_occurrence_id, workflow_node_id, workflow_node_attempt,
          invocation_plan_digest, binding_snapshot_digest, control_digest,
          workflow_logical_call_id, authority_digest, state, revision, opened_at
        ) VALUES (
          ?, ?, ?, 1, 'workflow_v3_call', ?, ?, 0,
          ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, 'open', 0, ?
        )
      `).run(
        input.sessionId,
        activationEvent.seq,
        authorityRootId,
        activationEvent.id,
        sourceEventDigest,
        WORKFLOW_V3_CALL_AUTHORITY_ENGINE_VERSION,
        WORKFLOW_V3_CALL_AUTHORITY_SURFACE_VERSION,
        surfaceDigest,
        input.binding.effect,
        effectBoundsJson,
        input.bindingSnapshotDigest,
        input.authorityBindingDigest,
        activationId,
        activationDigest,
        input.workflowId,
        input.workflowRevision,
        input.workflowDigest,
        input.runId,
        input.runOccurrenceId,
        input.nodeId,
        input.nodeAttempt,
        input.invocationPlanDigest,
        input.bindingSnapshotDigest,
        input.controlDigest,
        input.logicalCallId,
        authorityDigest,
        activationEvent.createdAt,
      );
      const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, activationEvent.seq);
      if (loaded.status !== 'ok') throw new Error(`armed workflow v3 authority is ${loaded.status}: ${loaded.reason}`);
      const ref = workflowAuthorityRef(loaded.authority, 'workflow_v3_call');
      if (!ref) throw new Error('armed workflow v3 authority lost its workflow identity');
      return { status: 'armed', authority: loaded.authority, ref };
    });
    const result = transaction.immediate();
    if (result.status === 'armed') {
      if (autoConsentEvent) publishCommittedInternalEvent(autoConsentEvent);
      if (activationEvent) publishCommittedInternalEvent(activationEvent);
    }
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function readWorkflowV3CallAuthority(
  activationId: string,
): AcceptedTurnCallAuthorityReadResult {
  if (!activationId.trim()) return { status: 'missing', reason: 'workflow v3 activation id is missing' };
  try {
    const loaded = readWorkflowAuthorityByActivationInTransaction(openEventLog(), activationId);
    if (loaded.status !== 'ok') return loaded;
    return loaded.authority.authorityKind === 'workflow_v3_call'
      ? loaded
      : { status: 'conflict', reason: 'activation is not owned by workflow v3 authority' };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type MintWorkflowV3CallAttestationResult =
  | {
      status: 'minted';
      proof: WorkflowV3CallAttestationProof;
      ref: WorkflowReadOnlyCallAuthorityRef;
      toolName: string;
      argumentDigest: string;
    }
  | { status: 'missing' | 'closed' | 'conflict' | 'storage_error'; reason: string };

function workflowV3ObligationDigest(plan: {
  requirementId: string;
  binding: { effect: string };
  evidence: unknown;
  completeness: unknown;
  continuation: unknown;
}): string {
  return createHash('sha256').update(closedCanonicalJson({
    domain: 'workflow-v3-call-obligation',
    version: 1,
    requirementId: plan.requirementId,
    effect: plan.binding.effect,
    evidence: plan.evidence,
    completeness: plan.completeness,
    continuation: plan.continuation,
  }), 'utf8').digest('hex');
}

/** Last-edge v3 revalidation. Durable bytes select exactly one current
 * manifest/account/port/compiler and one canonical argument object; the
 * resulting proof is process-opaque and scoped by ALS during the shared kernel. */
export function mintWorkflowV3CallAttestation(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
}): MintWorkflowV3CallAttestationResult {
  try {
    const loaded = readWorkflowV3CallAuthority(input.activationId);
    if (loaded.status !== 'ok') {
      return {
        status: loaded.status === 'conflict' ? 'conflict'
          : loaded.status === 'storage_error' ? 'storage_error' : 'missing',
        reason: loaded.reason,
      };
    }
    const authority = loaded.authority;
    const ref = workflowAuthorityRef(authority, 'workflow_v3_call');
    if (!ref) return { status: 'conflict', reason: 'activation is not owned by workflow v3 authority' };
    if (authority.state !== 'open') return { status: 'closed', reason: 'workflow v3 authority is not open' };
    const durable = readWorkflowV3ActivationBindingRow(openEventLog(), input.activationId);
    if (!durable) return { status: 'missing', reason: 'workflow v3 durable binding is missing' };
    const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
    if (!parsed.ok || parsed.plan.bindingDigest !== ref.invocationPlanDigest) {
      return { status: 'conflict', reason: 'workflow v3 invocation plan does not match the activation digest' };
    }
    const binding = parsed.plan.binding;
    if (
      binding.effect === 'read'
      || binding.effect === 'compute'
      || parsed.plan.requirementId !== durable.requirement_id
      || parsed.plan.logicalCapabilityId !== durable.logical_capability_id
      || workflowV3ObligationDigest(parsed.plan) !== durable.obligation_digest
      || canonicalArgumentDigestOf(input.args) !== durable.canonical_argument_digest
      || binding.capabilityId !== durable.capability_id
      || binding.manifestId !== durable.manifest_id
      || binding.manifestDigest !== durable.manifest_digest
      || binding.operationId !== durable.operation_id
      || binding.operationVersion !== durable.operation_version
      || binding.schemaDigest !== durable.schema_digest
      || binding.providerVersion !== durable.provider_version
      || binding.liveFingerprint !== durable.live_fingerprint
      || binding.accountId !== durable.account_id
      || binding.effect !== durable.effect
      || binding.invokePortId !== durable.invoke_port_id
      || binding.argumentCompiler.id !== durable.argument_compiler_id
      || binding.argumentCompiler.version !== durable.argument_compiler_version
      || authority.bindingRevisionDigest !== durable.authority_binding_digest
    ) return { status: 'conflict', reason: 'workflow v3 plan/arguments differ from their exact durable binding' };

    const factory = peekHostCapabilityCatalogFactory();
    const capability = factory?.get(binding.capabilityId);
    const live = capability ? canonicalCatalogIdentityOf(capability) : null;
    if (
      !capability
      || !live
      || !capability.manifest
      || !currentCapabilityManifest(capability.manifest)
      || capabilityManifestDigest(capability.manifest) !== binding.manifestDigest
      || live.capabilityId !== binding.capabilityId
      || live.manifestId !== binding.manifestId
      || live.manifestDigest !== binding.manifestDigest
      || live.operationId !== binding.operationId
      || live.schemaVersion !== binding.operationVersion
      || workflowCapabilityDigest(live.schemaDigest) !== binding.schemaDigest
      || live.providerVersion !== binding.providerVersion
      || workflowCapabilityDigest(live.liveFingerprint) !== binding.liveFingerprint
      || live.account !== binding.accountId
      || live.effect !== binding.effect
      || live.invokePortId !== binding.invokePortId
      || live.argumentCompiler.id !== binding.argumentCompiler.id
      || live.argumentCompiler.version !== binding.argumentCompiler.version
    ) return { status: 'conflict', reason: 'workflow v3 live binding differs from its exact invocation plan' };
    if (!resolveProductionPortsForManifest(capability.manifest)) {
      return { status: 'missing', reason: 'workflow v3 exact immutable invoke port is missing' };
    }
    const observation = independentlyObserveCapability(binding.operationId, binding.accountId);
    if (
      !observation
      || observation.origin !== 'independent'
      || !observationIsFresh(observation)
      || observation.operationId !== binding.operationId
      || observation.operationVersion !== binding.operationVersion
      || observation.providerVersion !== binding.providerVersion
      || workflowCapabilityDigest(observation.definitionFingerprint) !== binding.liveFingerprint
      || observation.accountId !== binding.accountId
    ) return { status: 'conflict', reason: 'workflow v3 independent live observation differs from its plan' };
    const contract = durableLogicalCallContract(ref.authorityRootId, binding.operationId, input.args);
    if (!contract) return { status: 'conflict', reason: 'workflow v3 arguments do not form a canonical logical contract' };
    const attestation = Object.freeze<WorkflowV3CallAttestation>({
      sessionId: ref.sessionId,
      sourceEventSeq: ref.sourceEventSeq,
      authorityRootId: ref.authorityRootId,
      sourceEventId: ref.sourceEventId,
      sourceEventDigest: ref.sourceEventDigest,
      activationId: ref.activationId,
      activationDigest: ref.activationDigest,
      workflowId: ref.workflowId,
      workflowRevision: ref.workflowRevision,
      workflowDigest: ref.workflowDigest,
      runId: ref.runId,
      runOccurrenceId: ref.runOccurrenceId,
      nodeId: ref.nodeId,
      nodeAttempt: ref.nodeAttempt,
      invocationPlanDigest: ref.invocationPlanDigest,
      bindingSnapshotDigest: ref.bindingSnapshotDigest,
      controlDigest: ref.controlDigest,
      logicalCallId: ref.logicalCallId,
      toolName: contract.toolName,
      operationId: binding.operationId,
      argumentDigest: contract.argumentDigest,
      capabilityId: binding.capabilityId,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      operationVersion: binding.operationVersion,
      schemaDigest: binding.schemaDigest,
      providerVersion: binding.providerVersion,
      liveFingerprint: binding.liveFingerprint,
      accountId: binding.accountId,
      invokePortId: binding.invokePortId,
      argumentCompilerId: binding.argumentCompiler.id,
      argumentCompilerVersion: binding.argumentCompiler.version,
      authorityBindingDigest: durable.authority_binding_digest,
      requirementId: durable.requirement_id,
      logicalCapabilityId: durable.logical_capability_id,
      effect: durable.effect,
      canonicalArgumentDigest: durable.canonical_argument_digest,
      sourceArgumentDigest: durable.source_argument_digest,
      obligationDigest: durable.obligation_digest,
      authorityDigest: ref.authorityDigest,
      authorityRevision: ref.authorityRevision,
    });
    const proof = Object.freeze<WorkflowV3CallAttestationProof>({
      kind: 'workflow_v3_call_attestation',
      activationId: ref.activationId,
      authorityRootId: ref.authorityRootId,
      logicalCallId: ref.logicalCallId,
      authorityBindingDigest: durable.authority_binding_digest,
    });
    workflowV3Proofs.set(proof as object, attestation);
    return { status: 'minted', proof, ref, toolName: contract.toolName, argumentDigest: contract.argumentDigest };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type MintWorkflowReadOnlyCallAttestationResult =
  | {
      status: 'minted';
      proof: WorkflowReadOnlyCallAttestationProof;
      ref: WorkflowReadOnlyCallAuthorityRef;
      toolName: string;
      argumentDigest: string;
    }
  | { status: 'missing' | 'closed' | 'conflict' | 'storage_error'; reason: string };

/** Last-edge live binding proof. The plan bytes are parsed and content-bound,
 * the selected catalog entry and immutable invocation port are re-read, and an
 * independent observation must still match before an opaque ALS proof exists. */
export function mintWorkflowReadOnlyCallAttestation(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
}): MintWorkflowReadOnlyCallAttestationResult {
  try {
    const loaded = readWorkflowReadOnlyCallAuthority(input.activationId);
    if (loaded.status !== 'ok') {
      return {
        status: loaded.status === 'conflict' ? 'conflict'
          : loaded.status === 'storage_error' ? 'storage_error' : 'missing',
        reason: loaded.reason,
      };
    }
    const authority = loaded.authority;
    const ref = workflowAuthorityRef(authority);
    if (!ref) return { status: 'conflict', reason: 'activation is not owned by workflow read-only authority' };
    if (authority.state !== 'open') return { status: 'closed', reason: 'workflow read-only authority is not open' };
    const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
    if (!parsed.ok || parsed.plan.bindingDigest !== ref.invocationPlanDigest) {
      return { status: 'conflict', reason: 'workflow invocation plan does not match the activation digest' };
    }
    const binding = parsed.plan.binding;
    if (binding.effect !== 'read') {
      return { status: 'conflict', reason: 'workflow_v1_read_only admits only an exact read binding' };
    }
    const factory = peekHostCapabilityCatalogFactory();
    const capability = factory?.get(binding.capabilityId);
    const live = capability ? canonicalCatalogIdentityOf(capability) : null;
    if (
      !capability
      || !live
      || !capability.manifest
      || !currentCapabilityManifest(capability.manifest)
      || capabilityManifestDigest(capability.manifest) !== binding.manifestDigest
      || live.capabilityId !== binding.capabilityId
      || live.manifestId !== binding.manifestId
      || live.manifestDigest !== binding.manifestDigest
      || live.operationId !== binding.operationId
      || live.schemaVersion !== binding.operationVersion
      || workflowCapabilityDigest(live.schemaDigest) !== binding.schemaDigest
      || live.providerVersion !== binding.providerVersion
      || workflowCapabilityDigest(live.liveFingerprint) !== binding.liveFingerprint
      || live.account !== binding.accountId
      || live.effect !== 'read'
      || live.invokePortId !== binding.invokePortId
      || live.argumentCompiler.id !== binding.argumentCompiler.id
      || live.argumentCompiler.version !== binding.argumentCompiler.version
    ) return { status: 'conflict', reason: 'workflow call live binding differs from its exact invocation plan' };
    if (!resolveProductionPortsForManifest(capability.manifest)) {
      return { status: 'missing', reason: 'workflow call exact immutable invoke port is missing' };
    }
    const observation = independentlyObserveCapability(binding.operationId, binding.accountId);
    if (
      !observation
      || observation.origin !== 'independent'
      || !observationIsFresh(observation)
      || observation.operationId !== binding.operationId
      || observation.operationVersion !== binding.operationVersion
      || observation.providerVersion !== binding.providerVersion
      || workflowCapabilityDigest(observation.definitionFingerprint) !== binding.liveFingerprint
      || observation.accountId !== binding.accountId
    ) return { status: 'conflict', reason: 'workflow call independent live observation differs from its plan' };
    const contract = durableLogicalCallContract(ref.authorityRootId, binding.operationId, input.args);
    if (!contract) return { status: 'conflict', reason: 'workflow call arguments do not form a canonical logical contract' };
    const attestation = Object.freeze<WorkflowReadOnlyCallAttestation>({
      sessionId: ref.sessionId,
      sourceEventSeq: ref.sourceEventSeq,
      authorityRootId: ref.authorityRootId,
      sourceEventId: ref.sourceEventId,
      sourceEventDigest: ref.sourceEventDigest,
      activationId: ref.activationId,
      activationDigest: ref.activationDigest,
      workflowId: ref.workflowId,
      workflowRevision: ref.workflowRevision,
      workflowDigest: ref.workflowDigest,
      runId: ref.runId,
      runOccurrenceId: ref.runOccurrenceId,
      nodeId: ref.nodeId,
      nodeAttempt: ref.nodeAttempt,
      invocationPlanDigest: ref.invocationPlanDigest,
      bindingSnapshotDigest: ref.bindingSnapshotDigest,
      controlDigest: ref.controlDigest,
      logicalCallId: ref.logicalCallId,
      toolName: contract.toolName,
      operationId: binding.operationId,
      argumentDigest: contract.argumentDigest,
      capabilityId: binding.capabilityId,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      operationVersion: binding.operationVersion,
      schemaDigest: binding.schemaDigest,
      providerVersion: binding.providerVersion,
      liveFingerprint: binding.liveFingerprint,
      accountId: binding.accountId,
      invokePortId: binding.invokePortId,
      argumentCompilerId: binding.argumentCompiler.id,
      argumentCompilerVersion: binding.argumentCompiler.version,
      authorityDigest: ref.authorityDigest,
      authorityRevision: ref.authorityRevision,
    });
    const proof = Object.freeze<WorkflowReadOnlyCallAttestationProof>({
      kind: 'workflow_v1_read_only_call_attestation',
      activationId: ref.activationId,
      authorityRootId: ref.authorityRootId,
      logicalCallId: ref.logicalCallId,
    });
    workflowReadOnlyProofs.set(proof as object, attestation);
    return { status: 'minted', proof, ref, toolName: contract.toolName, argumentDigest: contract.argumentDigest };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface GraphCallAuthorityInput {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  graphEventId: string;
  graphHash: string;
  compilerVersion: string;
  effectCeiling: string;
  resolutionState: 'open' | 'finalized' | 'legacy_ambiguous';
  openedAt: string;
  finalizedAt?: string | null;
}

function graphFrozenInput(
  db: HarnessDb,
  input: GraphCallAuthorityInput,
): Omit<AuthorityRow, 'state' | 'revision' | 'opened_at' | 'closed_at' | 'close_reason'> {
  const source = sourceRowInTransaction(db, input.sessionId, input.sourceUserSeq);
  if (
    !source
    || source.role !== 'user'
    || source.type !== 'user_input_received'
    || input.acceptedTaskId !== acceptedTaskIdFor(input.sessionId, input.sourceUserSeq)
    || !isSha256(input.graphHash)
    || !safeVersion(input.compilerVersion)
    || !input.effectCeiling.trim()
  ) throw new Error('graph call authority input is invalid');
  const effectBoundsJson = '[]';
  const surfaceDigest = acceptedTurnCallSurfaceDigest({
    authorityKind: 'turn_graph',
    engineVersion: input.compilerVersion,
    surfaceVersion: 'turn_graph_ir_v1',
    effectCeiling: input.effectCeiling,
    effectBoundsJson,
    maxLogicalCalls: null,
    maxParallelCalls: null,
    catalogRevisionDigest: null,
    bindingRevisionDigest: input.graphHash,
    graphEventId: input.graphEventId,
    graphHash: input.graphHash,
  });
  const sourceEventDigest = sourceDigest(source);
  const authorityDigest = acceptedTurnCallAuthorityDigest({
    authorityKind: 'turn_graph',
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    sourceEventId: source.id,
    sourceEventDigest,
    sourceTurn: source.turn,
    engineVersion: input.compilerVersion,
    surfaceVersion: 'turn_graph_ir_v1',
    surfaceDigest,
    effectCeiling: input.effectCeiling,
    effectBoundsJson,
    maxLogicalCalls: null,
    maxParallelCalls: null,
    catalogRevisionDigest: null,
    bindingRevisionDigest: input.graphHash,
    graphEventId: input.graphEventId,
    graphHash: input.graphHash,
  });
  return {
    session_id: input.sessionId,
    source_user_seq: input.sourceUserSeq,
    accepted_task_id: input.acceptedTaskId,
    authority_protocol: 1,
    authority_kind: 'turn_graph',
    source_event_id: source.id,
    source_event_digest: sourceEventDigest,
    source_turn: source.turn,
    engine_version: input.compilerVersion,
    surface_version: 'turn_graph_ir_v1',
    surface_digest: surfaceDigest,
    effect_ceiling: input.effectCeiling,
    effect_bounds_json: effectBoundsJson,
    max_logical_calls: null,
    max_parallel_calls: null,
    catalog_revision_digest: null,
    binding_revision_digest: input.graphHash,
    graph_event_id: input.graphEventId,
    graph_hash: input.graphHash,
    ...EMPTY_WORKFLOW_AUTHORITY_COLUMNS,
    authority_digest: authorityDigest,
  };
}

function targetGraphState(input: GraphCallAuthorityInput): {
  state: AcceptedTurnCallAuthority['state'];
  closedAt: string | null;
  closeReason: string | null;
} {
  if (input.resolutionState === 'open') return { state: 'open', closedAt: null, closeReason: null };
  return input.resolutionState === 'finalized'
    ? {
        state: 'closed',
        closedAt: input.finalizedAt ?? input.openedAt,
        closeReason: 'graph_finalized',
      }
    : {
        state: 'conflict',
        closedAt: input.finalizedAt ?? input.openedAt,
        closeReason: 'graph_legacy_ambiguous',
      };
}

/** Graph lane provisioning. This never relaxes or replaces the graph
 * resolution; the graph row must already exist and match exactly. */
export function ensureGraphCallAuthorityInTransaction(
  db: HarnessDb,
  input: GraphCallAuthorityInput,
): AcceptedTurnCallAuthority {
  const frozen = graphFrozenInput(db, input);
  const target = targetGraphState(input);
  let existing = readRow(db, input.sessionId, input.sourceUserSeq);
  if (!existing) {
    db.prepare(`
      INSERT INTO accepted_turn_call_authorities
        (session_id, source_user_seq, accepted_task_id, authority_protocol,
         authority_kind, source_event_id, source_event_digest, source_turn,
         engine_version, surface_version, surface_digest, effect_ceiling,
         effect_bounds_json, max_logical_calls, max_parallel_calls,
         catalog_revision_digest, binding_revision_digest, graph_event_id,
         graph_hash, authority_digest, state, revision, opened_at, closed_at,
         close_reason)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      frozen.session_id,
      frozen.source_user_seq,
      frozen.accepted_task_id,
      frozen.authority_kind,
      frozen.source_event_id,
      frozen.source_event_digest,
      frozen.source_turn,
      frozen.engine_version,
      frozen.surface_version,
      frozen.surface_digest,
      frozen.effect_ceiling,
      frozen.effect_bounds_json,
      frozen.binding_revision_digest,
      frozen.graph_event_id,
      frozen.graph_hash,
      frozen.authority_digest,
      target.state,
      target.state === 'open' ? 0 : 1,
      input.openedAt,
      target.closedAt,
      target.closeReason,
    );
    existing = readRow(db, input.sessionId, input.sourceUserSeq);
  } else {
    if (!immutableRowsMatch(existing, frozen)) {
      throw new Error('graph call authority conflicts with its exact resolution');
    }
    if (existing.state === 'open' && target.state !== 'open') {
      db.prepare(`
        UPDATE accepted_turn_call_authorities
           SET state = ?, revision = revision + 1, closed_at = ?, close_reason = ?
         WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
      `).run(
        target.state,
        target.closedAt,
        target.closeReason,
        input.sessionId,
        input.sourceUserSeq,
      );
      existing = readRow(db, input.sessionId, input.sourceUserSeq);
    }
  }
  if (!existing) throw new Error('graph call authority could not be read back');
  const verified = verifyRow(db, existing);
  if (verified.status !== 'ok') {
    if (target.state === 'conflict' && existing.state === 'conflict') return project(existing);
    throw new Error(`graph call authority is ${verified.status}: ${verified.reason}`);
  }
  if (verified.authority.state !== target.state) {
    throw new Error('graph call authority state does not match its exact resolution');
  }
  return verified.authority;
}

export function poisonAcceptedTurnCallAuthorityInTransaction(
  db: HarnessDb,
  input: { sessionId: string; sourceUserSeq: number; reason: string },
): void {
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 160)
    || 'accepted-turn call authority conflict';
  db.prepare(`
    UPDATE accepted_turn_call_authorities
       SET state = 'conflict', revision = revision + 1,
           closed_at = COALESCE(closed_at, ?), close_reason = ?
     WHERE session_id = ? AND source_user_seq = ? AND state != 'conflict'
  `).run(new Date().toISOString(), reason, input.sessionId, input.sourceUserSeq);
}

export type HostLogicalAdmissionResult =
  | { status: 'ok'; authority: AcceptedTurnCallAuthority }
  | { status: 'closed' | 'missing' | 'conflict'; reason: string };

/** Same-transaction host budget/effect admission. The caller inserts the
 * logical row only after this succeeds. */
export function admitHostLogicalCallInTransaction(
  db: HarnessDb,
  input: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: CallAdmissionEffect;
    isNew: boolean;
  },
): HostLogicalAdmissionResult {
  const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, input.sourceUserSeq);
  if (loaded.status !== 'ok') {
    return {
      status: loaded.status === 'missing' ? 'missing' : 'conflict',
      reason: loaded.reason,
    };
  }
  const authority = loaded.authority;
  if (
    (authority.authorityKind !== 'host_v1_read_only' && authority.authorityKind !== 'host_v1')
    || authority.identity.acceptedTaskId !== input.acceptedTaskId
  ) return { status: 'conflict', reason: 'logical call does not belong to host authority' };
  if (authority.state !== 'open') {
    return { status: 'closed', reason: `host call authority is ${authority.state}` };
  }
  const readOnly = authority.authorityKind === 'host_v1_read_only';
  const effectAdmitted = readOnly
    ? HOST_READ_ONLY_EFFECT_BOUNDS.includes(input.effect as HostReadOnlyAdmissibleEffect)
    : HOST_EFFECT_BOUNDS.includes(input.effect as HostAdmissibleEffect);
  if (!effectAdmitted) {
    poisonAcceptedTurnCallAuthorityInTransaction(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      reason: `${readOnly ? 'host read-only' : 'host'} effect violation: ${input.effect}`,
    });
    return { status: 'conflict', reason: `${readOnly ? 'host read-only' : 'host'} authority does not admit ${input.effect}` };
  }
  const attested = readOnly
    ? hostReadOnlyCallAttestationMatches(authority, input)
    : hostCallAttestationMatches(db, authority, input);
  if (!attested) {
    poisonAcceptedTurnCallAuthorityInTransaction(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      reason: `${readOnly ? 'host read-only' : 'host'} call lacks exact live capability attestation`,
    });
    return {
      status: 'conflict',
      reason: `${readOnly ? 'host read-only' : 'host'} call lacks exact live capability attestation`,
    };
  }
  if (!input.isNew) return { status: 'ok', authority };
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_count
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as { total: number; open_count: number | null };
  if (counts.total >= (authority.maxLogicalCalls ?? 0)) {
    return { status: 'closed', reason: 'host logical-call ceiling reached' };
  }
  if ((counts.open_count ?? 0) >= (authority.maxParallelCalls ?? 0)) {
    return { status: 'closed', reason: 'host parallel-call ceiling reached' };
  }
  return { status: 'ok', authority };
}

export type WorkflowLogicalAdmissionResult =
  | { status: 'ok'; authority: AcceptedTurnCallAuthority }
  | { status: 'closed' | 'missing' | 'conflict'; reason: string };

/** Same shared-transaction admission wall as graph/host, specialized only by
 * the workflow root and its opaque last-edge proof. */
export function admitWorkflowLogicalCallInTransaction(
  db: HarnessDb,
  input: {
    sessionId: string;
    sourceEventSeq: number;
    authorityRootId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: CallAdmissionEffect;
    isNew: boolean;
  },
): WorkflowLogicalAdmissionResult {
  const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, input.sourceEventSeq);
  if (loaded.status !== 'ok') {
    return {
      status: loaded.status === 'missing' ? 'missing' : 'conflict',
      reason: loaded.reason,
    };
  }
  const authority = loaded.authority;
  const workflowV3 = authority.authorityKind === 'workflow_v3_call';
  if (
    authority.authorityKind !== 'workflow_v1_read_only'
    && !workflowV3
    || authority.identity.acceptedTaskId !== input.authorityRootId
  ) return { status: 'conflict', reason: 'logical call does not belong to workflow authority' };
  if (authority.state !== 'open') {
    return { status: 'closed', reason: `workflow call authority is ${authority.state}` };
  }
  if (authority.workflow?.logicalCallId !== input.logicalToolCallId) {
    poisonAcceptedTurnCallAuthorityInTransaction(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceEventSeq,
      reason: 'workflow logical call differs from its activation',
    });
    return {
      status: 'conflict',
      reason: 'workflow logical call differs from its activation',
    };
  }
  const attested = workflowV3
    ? workflowV3CallAttestationMatches(authority, {
        acceptedTaskId: input.authorityRootId,
        logicalToolCallId: input.logicalToolCallId,
        toolName: input.toolName,
        argumentDigest: input.argumentDigest,
        effect: input.effect,
      })
    : workflowReadOnlyCallAttestationMatches(authority, {
    acceptedTaskId: input.authorityRootId,
    logicalToolCallId: input.logicalToolCallId,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
  });
  if (!attested) {
    poisonAcceptedTurnCallAuthorityInTransaction(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceEventSeq,
      reason: 'workflow call lacks exact live capability attestation',
    });
    return { status: 'conflict', reason: 'workflow call lacks exact live capability attestation' };
  }
  if (!input.isNew) return { status: 'ok', authority };
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_count
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceEventSeq) as { total: number; open_count: number | null };
  if (counts.total >= 1) return { status: 'closed', reason: 'workflow logical-call ceiling reached' };
  if ((counts.open_count ?? 0) >= 1) return { status: 'closed', reason: 'workflow parallel-call ceiling reached' };
  return { status: 'ok', authority };
}

export type WorkflowCallAuthorityCloseOutcome = 'completed' | 'failed' | 'cancelled' | 'blocked';
export type CloseWorkflowReadOnlyCallAuthorityResult =
  | { status: 'closed' | 'replayed'; authority: AcceptedTurnCallAuthority }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

function closeWorkflowCallAuthority(input: {
  activationId: string;
  outcome: WorkflowCallAuthorityCloseOutcome;
}, authorityKind: 'workflow_v1_read_only' | 'workflow_v3_call'): CloseWorkflowReadOnlyCallAuthorityResult {
  if (!(['completed', 'failed', 'cancelled', 'blocked'] as const).includes(input.outcome)) {
    return { status: 'conflict', reason: 'workflow call-authority outcome is invalid' };
  }
  try {
    const db = openEventLog();
    const transaction = db.transaction((): CloseWorkflowReadOnlyCallAuthorityResult => {
      const activation = readWorkflowActivationRow(db, input.activationId);
      if (!activation) return { status: 'missing', reason: 'workflow activation is missing' };
      const row = readRow(db, activation.session_id, activation.source_event_seq);
      if (!row || row.authority_kind !== authorityKind) {
        return { status: 'conflict', reason: 'workflow activation has no exact call-authority root' };
      }
      const closeReason = `workflow_${input.outcome}`;
      const targetState = input.outcome === 'failed' ? 'conflict' : 'closed';
      if (row.state !== 'open') {
        return row.state === targetState && row.close_reason === closeReason
          ? { status: 'replayed', authority: project(row) }
          : { status: 'conflict', reason: 'workflow call authority already closed with a different outcome' };
      }
      const verified = verifyRow(db, row);
      if (verified.status !== 'ok') return verified;
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ?) AS logical_total,
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND state != 'settled') AS logical_unsettled,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS physical_unsettled
      `).get(
        activation.session_id,
        activation.source_event_seq,
        activation.session_id,
        activation.source_event_seq,
        activation.session_id,
        activation.source_event_seq,
      ) as { logical_total: number; logical_unsettled: number; physical_unsettled: number };
      if (counts.logical_unsettled > 0 || counts.physical_unsettled > 0) {
        return { status: 'not_ready', reason: 'workflow call authority still owns unsettled work' };
      }
      if (input.outcome === 'completed' && counts.logical_total !== 1) {
        return { status: 'not_ready', reason: 'completed workflow call authority requires its one settled logical call' };
      }
      const updated = db.prepare(`
        UPDATE accepted_turn_call_authorities
           SET state = ?, revision = revision + 1, closed_at = ?, close_reason = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND authority_kind = ? AND state = 'open'
      `).run(
        targetState,
        new Date().toISOString(),
        closeReason,
        activation.session_id,
        activation.source_event_seq,
        authorityKind,
      );
      if (updated.changes !== 1) throw new Error('workflow call-authority close lost its CAS');
      const closed = readRow(db, activation.session_id, activation.source_event_seq);
      if (!closed) throw new Error('closed workflow call-authority root disappeared');
      return { status: 'closed', authority: project(closed) };
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function closeWorkflowReadOnlyCallAuthority(input: {
  activationId: string;
  outcome: WorkflowCallAuthorityCloseOutcome;
}): CloseWorkflowReadOnlyCallAuthorityResult {
  return closeWorkflowCallAuthority(input, 'workflow_v1_read_only');
}

export function closeWorkflowV3CallAuthority(input: {
  activationId: string;
  outcome: WorkflowCallAuthorityCloseOutcome;
}): CloseWorkflowReadOnlyCallAuthorityResult {
  return closeWorkflowCallAuthority(input, 'workflow_v3_call');
}

export function poisonWorkflowReadOnlyCallAuthority(input: {
  activationId: string;
  reason: string;
}): { status: 'poisoned' | 'replayed' | 'missing' | 'storage_error'; reason?: string } {
  try {
    const db = openEventLog();
    const transaction = db.transaction(() => {
      const activation = readWorkflowActivationRow(db, input.activationId);
      if (!activation) return { status: 'missing' as const, reason: 'workflow activation is missing' };
      const before = readRow(db, activation.session_id, activation.source_event_seq);
      if (!before) return { status: 'missing' as const, reason: 'workflow call-authority root is missing' };
      if (before.state === 'conflict') return { status: 'replayed' as const };
      poisonAcceptedTurnCallAuthorityInTransaction(db, {
        sessionId: activation.session_id,
        sourceUserSeq: activation.source_event_seq,
        reason: input.reason,
      });
      return { status: 'poisoned' as const };
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function poisonWorkflowV3CallAuthority(input: {
  activationId: string;
  reason: string;
}): ReturnType<typeof poisonWorkflowReadOnlyCallAuthority> {
  const loaded = readWorkflowV3CallAuthority(input.activationId);
  if (loaded.status === 'missing') return { status: 'missing', reason: loaded.reason };
  if (loaded.status === 'storage_error') return { status: 'storage_error', reason: loaded.reason };
  if (loaded.status === 'conflict' && !readWorkflowActivationRow(openEventLog(), input.activationId)) {
    return { status: 'missing', reason: loaded.reason };
  }
  return poisonWorkflowReadOnlyCallAuthority(input);
}

export type HostCallAuthorityCloseOutcome = 'completed' | 'failed' | 'cancelled' | 'blocked';
export type CloseHostReadOnlyCallAuthorityResult =
  | { status: 'closed' | 'replayed'; authority: AcceptedTurnCallAuthority }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

function closeHostAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  outcome: HostCallAuthorityCloseOutcome;
}, authorityKind: 'host_v1' | 'host_v1_read_only'): CloseHostReadOnlyCallAuthorityResult {
  if (!(['completed', 'failed', 'cancelled', 'blocked'] as const).includes(input.outcome)) {
    return { status: 'conflict', reason: 'host call-authority outcome is invalid' };
  }
  try {
    const db = openEventLog();
    const transaction = db.transaction((): CloseHostReadOnlyCallAuthorityResult => {
      const loaded = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, input.sourceUserSeq);
      if (loaded.status !== 'ok') return loaded;
      const authority = loaded.authority;
      if (authority.authorityKind !== authorityKind) {
        return { status: 'conflict', reason: 'graph call authority cannot be closed by the host-turn closer' };
      }
      const closeReason = `host_${input.outcome}`;
      if (authority.state === 'closed') {
        return authority.closeReason === closeReason
          ? { status: 'replayed', authority }
          : { status: 'conflict', reason: 'host call authority already closed with a different outcome' };
      }
      const unsettled = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND state != 'settled') AS logical_count,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS physical_count
      `).get(
        input.sessionId,
        input.sourceUserSeq,
        input.sessionId,
        input.sourceUserSeq,
      ) as { logical_count: number; physical_count: number };
      if (unsettled.logical_count > 0 || unsettled.physical_count > 0) {
        return { status: 'not_ready', reason: 'host call authority still owns unsettled work' };
      }
      const now = new Date().toISOString();
      const closed = db.prepare(`
        UPDATE accepted_turn_call_authorities
           SET state = 'closed', revision = revision + 1,
               closed_at = ?, close_reason = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND authority_kind = ? AND state = 'open'
      `).run(now, closeReason, input.sessionId, input.sourceUserSeq, authorityKind);
      if (closed.changes !== 1) throw new Error('host call-authority close lost its CAS');
      const result = readAcceptedTurnCallAuthorityInTransaction(db, input.sessionId, input.sourceUserSeq);
      if (result.status !== 'ok') throw new Error(`closed host call authority is ${result.status}: ${result.reason}`);
      return { status: 'closed', authority: result.authority };
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function closeHostReadOnlyCallAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  outcome: HostCallAuthorityCloseOutcome;
}): CloseHostReadOnlyCallAuthorityResult {
  return closeHostAuthority(input, 'host_v1_read_only');
}

export type CloseHostCallAuthorityResult = CloseHostReadOnlyCallAuthorityResult;

export function closeHostCallAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  outcome: HostCallAuthorityCloseOutcome;
}): CloseHostCallAuthorityResult {
  return closeHostAuthority(input, 'host_v1');
}
