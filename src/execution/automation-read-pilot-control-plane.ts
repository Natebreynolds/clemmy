/**
 * Durable control-plane projection for the first exact automation read pilot.
 *
 * An AutomationOpportunity remains inert. This module can project only an
 * already-reviewed, exact one-phase read proposal plus one explicitly selected
 * live materialized capability into a formal pilot approval card. Resolution
 * of that exact card is then reconciled into the existing one-shot pilot queue.
 * No prose, catalog order, remembered alias, cadence, or recurrence field is
 * consulted for execution authority.
 */
import { createHash } from 'node:crypto';

import type { WorkflowInputDef } from '../memory/workflow-store.js';
import type {
  WorkflowNodeArgumentBindingV1,
  WorkflowNodeCompletenessContractV1,
  WorkflowNodeContinuationContractV1,
  WorkflowNodeEvidenceContractV1,
} from '../memory/workflow-node-invocation-plan.js';
import type { WorkflowCanonicalEntityResultProjectionV1 } from '../memory/workflow-result-projection-contract.js';
import {
  canonicalEntityWorkspaceSelectionDigest,
  parseCanonicalEntityWorkspaceBindingApproval,
  parseCanonicalEntityWorkspaceBindingSelection,
  type CanonicalEntityWorkspaceBindingSelectionV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore } from '../spaces/store.js';
import {
  listWorkflowSurfaceBindingsForWorkflow,
  putSoleActiveWorkflowSurfaceBinding,
} from '../spaces/workflow-surface-binding-store.js';
import { normalizeWorkflowRunInputs } from './workflow-inputs.js';
import {
  automationCapabilityRequirementDigest,
  automationLiveCapabilityContractDigest,
  automationLiveCapabilitySnapshotDigest,
  designApprovedAutomationWorkflowBridge,
  type AutomationLiveCapabilityContractV1,
  type AutomationSingleReadPilotContractV1,
} from './automation-workflow-bridge.js';
import {
  loadAutomationOpportunityProposal,
  type AutomationOpportunityProposalRecordV1,
} from './automation-opportunity-store.js';
import {
  queueApprovedAutomationReadPilot,
  requestAutomationReadPilotApproval,
  resolveApprovedAutomationReadPilotAuthority,
  type AutomationReadPilotCompilationInputV1,
} from './automation-read-pilot-run.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  peekCapabilityManifestStore,
  type InstalledCapabilityManifest,
} from '../runtime/harness/capability-manifest-store.js';
import { currentCapabilityManifest } from '../runtime/harness/capability-manifest.js';
import { resolveProductionPortsForManifest } from '../runtime/harness/production-capability-ports.js';
import { canonicalLogicalToolName } from '../runtime/harness/logical-call-contract.js';
import {
  fingerprintSchema,
  loadToolContract,
  type ToolContract,
} from '../tools/tool-contract-store.js';
import { readWorkflowTriggerReceiptAcceptance } from '../tools/workflow-run-queue.js';
import type { MaterializeLiveReadCapabilityResult } from '../runtime/harness/live-capability-materializer.js';

const CONTROL_PLANE_VERSION = 1 as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const MAX_PROJECTION_BYTES = 512_000;
const MATERIALIZER_ISSUER = 'host:live-capability-materializer:v1';

export interface AutomationReadPilotCapabilitySelectionV1 {
  capabilityId: string;
  expectedIdentityDigest: string;
}

export interface AutomationReadPilotTypedContractV1 {
  phaseId: string;
  requirementId: string;
  workflowInputs: Record<string, WorkflowInputDef>;
  arguments: Record<string, WorkflowNodeArgumentBindingV1>;
  evidence: WorkflowNodeEvidenceContractV1;
  completeness: WorkflowNodeCompletenessContractV1;
  continuation?: WorkflowNodeContinuationContractV1;
  resultProjection?: WorkflowCanonicalEntityResultProjectionV1;
  workspaceBindingSelection?: CanonicalEntityWorkspaceBindingSelectionV1;
}

export interface RegisterAutomationReadPilotProjectionInputV1 {
  proposalId: string;
  expectedProposalRevision: number;
  expectedProposalDigest: string;
  approvalSessionId: string;
  originSessionId?: string;
  /** Exactly one candidate is required. Zero is missing; two or more are
   * ambiguous. The control plane never picks the first catalog row. */
  selections: AutomationReadPilotCapabilitySelectionV1[];
  contract: AutomationReadPilotTypedContractV1;
  workflowInputs: Record<string, string>;
}

/** Provider-neutral acquisition boundary. Native MCP, a reviewed CLI, a
 * gateway, or a future carrier may implement this port. The returned manifest
 * remains only a nomination: registration re-reads the host catalog, manifest
 * store, observed schema, effect, account, and invocation port before it can
 * create an approval. */
export interface AutomationReadPilotCapabilityAcquisitionPortV1 {
  acquire(input: {
    proposalId: string;
    proposalRevision: number;
    proposalDigest: string;
    phaseId: string;
    requirementId: string;
    requirementDigest: string;
    objective: string;
    effect: 'read';
  }): Promise<MaterializeLiveReadCapabilityResult>;
}

export type AcquireAndRegisterAutomationReadPilotProjectionInputV1 = Omit<
  RegisterAutomationReadPilotProjectionInputV1,
  'selections'
> & {
  acquisition?: AutomationReadPilotCapabilityAcquisitionPortV1;
};

export type AutomationReadPilotProjectionStatus =
  | 'registering'
  | 'approval_pending'
  | 'queueing'
  | 'queued'
  | 'refused';

export interface AutomationReadPilotProjectionV1 {
  version: typeof CONTROL_PLANE_VERSION;
  projectionId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  approvalSessionId: string;
  originSessionId?: string;
  approvalResumeKey: string;
  approvalId?: string;
  compilationDigest: string;
  capabilityId: string;
  capabilityIdentityDigest: string;
  schemaFingerprint: string;
  workflowInputsDigest: string;
  status: AutomationReadPilotProjectionStatus;
  triggerReceiptId?: string;
  runId?: string;
  refusalCode?: string;
  refusalDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export type RegisterAutomationReadPilotProjectionResult =
  | {
      ok: true;
      projection: AutomationReadPilotProjectionV1;
      approval: approvalRegistry.PendingApprovalRow;
      approvalCreated: boolean;
      cardCreated: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationReadPilotProjectionV1;
    };

export type ReconcileAutomationReadPilotProjectionResult =
  | {
      ok: true;
      state: 'pending' | 'queued' | 'already_queued' | 'refused';
      projection: AutomationReadPilotProjectionV1;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationReadPilotProjectionV1;
    };

export interface ReconcileAutomationReadPilotProjectionsResult {
  scanned: number;
  pending: number;
  queued: number;
  alreadyQueued: number;
  refused: number;
  failed: number;
}

interface ProjectionSqlRow {
  projection_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_digest: string;
  approval_session_id: string;
  origin_session_id: string | null;
  approval_resume_key: string;
  approval_id: string | null;
  compilation_json: string;
  compilation_digest: string;
  capability_id: string;
  capability_identity_digest: string;
  schema_fingerprint: string;
  workflow_inputs_json: string;
  workflow_inputs_digest: string;
  status: AutomationReadPilotProjectionStatus;
  trigger_receipt_id: string | null;
  run_id: string | null;
  refusal_code: string | null;
  refusal_detail: string | null;
  created_at: string;
  updated_at: string;
}

interface PreparedProjection {
  compilation: AutomationReadPilotCompilationInputV1;
  proposal: AutomationOpportunityProposalRecordV1;
  capabilityId: string;
  capabilityIdentityDigest: string;
  schemaFingerprint: string;
  workflowInputs: Record<string, string>;
  workflowInputsJson: string;
  workflowInputsDigest: string;
  approvalResumeKey: string;
  compilationDigest: string;
  projectionId: string;
}

const CONTROL_PLANE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_read_pilot_control_plane_migrations (
  version    INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_read_pilot_projections (
  projection_id              TEXT PRIMARY KEY,
  proposal_id                TEXT NOT NULL,
  proposal_revision          INTEGER NOT NULL CHECK (proposal_revision >= 1),
  proposal_digest            TEXT NOT NULL,
  approval_session_id        TEXT NOT NULL,
  origin_session_id          TEXT,
  approval_resume_key        TEXT NOT NULL UNIQUE,
  approval_id                TEXT UNIQUE,
  compilation_json           TEXT NOT NULL,
  compilation_digest         TEXT NOT NULL,
  capability_id              TEXT NOT NULL,
  capability_identity_digest TEXT NOT NULL,
  schema_fingerprint         TEXT NOT NULL,
  workflow_inputs_json       TEXT NOT NULL,
  workflow_inputs_digest     TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN (
    'registering','approval_pending','queueing','queued','refused'
  )),
  trigger_receipt_id         TEXT UNIQUE,
  run_id                     TEXT,
  refusal_code               TEXT,
  refusal_detail             TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_read_pilot_projection_reconcile
  ON automation_read_pilot_projections(status, updated_at, projection_id);
`;

const CONTROL_PLANE_COLUMNS = new Set([
  'projection_id',
  'proposal_id',
  'proposal_revision',
  'proposal_digest',
  'approval_session_id',
  'origin_session_id',
  'approval_resume_key',
  'approval_id',
  'compilation_json',
  'compilation_digest',
  'capability_id',
  'capability_identity_digest',
  'schema_fingerprint',
  'workflow_inputs_json',
  'workflow_inputs_digest',
  'status',
  'trigger_receipt_id',
  'run_id',
  'refusal_code',
  'refusal_detail',
  'created_at',
  'updated_at',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 32,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: MAX_PROJECTION_BYTES,
  });
}

function safeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && EXACT_ID_RE.test(value);
}

function database() {
  const db = openEventLog();
  const migrate = db.transaction(() => {
    db.exec(CONTROL_PLANE_SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_read_pilot_control_plane_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migrate.immediate();
  const versions = db.prepare(
    'SELECT version FROM automation_read_pilot_control_plane_migrations ORDER BY version ASC',
  ).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== CONTROL_PLANE_VERSION) {
    throw new Error('automation read pilot control-plane schema version is unknown');
  }
  const columns = new Set((db.prepare(
    'PRAGMA table_info(automation_read_pilot_projections)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if ([...CONTROL_PLANE_COLUMNS].some((column) => !columns.has(column))) {
    throw new Error('automation read pilot control-plane schema is incomplete');
  }
  return db;
}

export function automationReadPilotCatalogIdentityDigest(
  identity: CanonicalCatalogIdentityV1,
): string {
  return sha256(canonicalJson({
    domain: 'automation-read-pilot-catalog-identity',
    version: CONTROL_PLANE_VERSION,
    identity,
  }));
}

function rowToProjection(row: ProjectionSqlRow): AutomationReadPilotProjectionV1 {
  return {
    version: CONTROL_PLANE_VERSION,
    projectionId: row.projection_id,
    proposalId: row.proposal_id,
    proposalRevision: row.proposal_revision,
    proposalDigest: row.proposal_digest,
    approvalSessionId: row.approval_session_id,
    ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {}),
    approvalResumeKey: row.approval_resume_key,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    compilationDigest: row.compilation_digest,
    capabilityId: row.capability_id,
    capabilityIdentityDigest: row.capability_identity_digest,
    schemaFingerprint: row.schema_fingerprint,
    workflowInputsDigest: row.workflow_inputs_digest,
    status: row.status,
    ...(row.trigger_receipt_id ? { triggerReceiptId: row.trigger_receipt_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.refusal_code ? { refusalCode: row.refusal_code } : {}),
    ...(row.refusal_detail ? { refusalDetail: row.refusal_detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadProjectionRow(projectionId: string): ProjectionSqlRow | undefined {
  if (!exactId(projectionId)) return undefined;
  return database().prepare(
    'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
  ).get(projectionId) as ProjectionSqlRow | undefined;
}

export function loadAutomationReadPilotProjection(
  projectionId: string,
): AutomationReadPilotProjectionV1 | undefined {
  const row = loadProjectionRow(projectionId);
  return row ? rowToProjection(row) : undefined;
}

export function listAutomationReadPilotProjections(input: {
  status?: AutomationReadPilotProjectionStatus;
  approvalId?: string;
  limit?: number;
} = {}): AutomationReadPilotProjectionV1[] {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('projection list limit must be from 1 through 1000');
  }
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.status) {
    conditions.push('status = ?');
    values.push(input.status);
  }
  if (input.approvalId) {
    conditions.push('approval_id = ?');
    values.push(input.approvalId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = database().prepare(
    `SELECT * FROM automation_read_pilot_projections ${where}
      ORDER BY updated_at ASC, projection_id ASC LIMIT ?`,
  ).all(...values, limit) as ProjectionSqlRow[];
  return rows.map(rowToProjection);
}

function manifestForExactIdentity(
  identity: CanonicalCatalogIdentityV1,
): InstalledCapabilityManifest | null {
  const store = peekCapabilityManifestStore();
  const installed = store?.get(identity.manifestId);
  if (
    !installed
    || installed.digest !== identity.manifestDigest
    || !currentCapabilityManifest(installed.manifest)
    || installed.manifest.manifestId !== identity.capabilityId
    || installed.manifest.operationId !== identity.operationId
    || installed.manifest.accountId !== identity.account
    || installed.manifest.effect !== 'read'
    || installed.manifest.invokePortId !== identity.invokePortId
    || installed.manifest.argumentCompiler.id !== identity.argumentCompiler.id
    || installed.manifest.argumentCompiler.version !== identity.argumentCompiler.version
    || installed.manifest.provenance.issuer !== MATERIALIZER_ISSUER
  ) return null;
  const port = resolveProductionPortsForManifest(installed.manifest);
  return port && typeof port.invoke === 'function' ? installed : null;
}

function exactCurrentCapability(input: {
  selection: AutomationReadPilotCapabilitySelectionV1;
}): { ok: true; identity: CanonicalCatalogIdentityV1; schema: ToolContract } | {
  ok: false;
  code: string;
  reason: string;
} {
  if (
    !exactId(input.selection.capabilityId)
    || !SHA256_RE.test(input.selection.expectedIdentityDigest)
  ) return { ok: false, code: 'selection_invalid', reason: 'Capability selection is malformed.' };
  const entry = peekHostCapabilityCatalogFactory()?.get(input.selection.capabilityId);
  const identity = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (!entry || !identity) {
    return { ok: false, code: 'capability_missing', reason: 'The exact selected live capability is unavailable.' };
  }
  const identityDigest = automationReadPilotCatalogIdentityDigest(identity);
  if (identityDigest !== input.selection.expectedIdentityDigest) {
    return { ok: false, code: 'capability_drift', reason: 'The exact selected live capability identity drifted.' };
  }
  if (identity.effect !== 'read' || entry.effect !== 'read') {
    return { ok: false, code: 'capability_effect_unsafe', reason: 'Only an attested read capability can enter the one-read pilot.' };
  }
  if (!manifestForExactIdentity(identity)) {
    return {
      ok: false,
      code: 'capability_not_materialized',
      reason: 'The selection is not backed by the exact current live materializer manifest and invocation port.',
    };
  }
  const schema = loadToolContract(identity.operationId);
  if (
    !schema
    || schema.identifier !== identity.operationId
    || schema.providerObservedFingerprint !== schema.fingerprint
    || Boolean(schema.providerAuthorityConflictAt)
  ) {
    return {
      ok: false,
      code: 'schema_unavailable',
      reason: 'The exact provider-observed input schema is unavailable or conflicted.',
    };
  }
  return { ok: true, identity, schema };
}

function schemaType(value: unknown): string | null {
  if (!safeRecord(value)) return null;
  if (typeof value.type === 'string') return value.type === 'integer' ? 'number' : value.type;
  return null;
}

function typedContractIssue(input: {
  contract: AutomationReadPilotTypedContractV1;
  workflowInputs: Record<string, string>;
  schema: ToolContract;
}): string | null {
  const schema = input.schema.schema;
  if (
    schema.type !== 'object'
    || schema.additionalProperties !== false
    || !safeRecord(schema.properties)
    || !Array.isArray(schema.required)
    || !schema.required.every((key) => typeof key === 'string' && key.trim() === key)
  ) return 'The live input schema is not a closed typed object contract.';

  const continuation = input.contract.continuation ?? { kind: 'none' as const };
  if (
    input.contract.completeness.kind === 'per_run_boundary'
    || (input.contract.completeness.kind === 'terminal_result' && continuation.kind !== 'none')
    || (input.contract.completeness.kind === 'finite_exhaustive' && continuation.kind !== 'cursor')
  ) return 'The typed pilot completeness and continuation contracts contradict one another.';
  const propertyNames = new Set(Object.keys(schema.properties));
  const requiredNames = new Set(schema.required as string[]);
  const argumentNames = Object.keys(input.contract.arguments);
  if (argumentNames.length === 0) return 'The typed pilot has no provider arguments.';
  if (argumentNames.some((key) => !propertyNames.has(key))) {
    return 'The typed pilot contains an argument absent from the exact live schema.';
  }
  if ([...requiredNames].some((key) => !(key in input.contract.arguments))) {
    return 'The typed pilot omits an argument required by the exact live schema.';
  }

  const referencedInputs = new Set<string>();
  for (const [argumentName, binding] of Object.entries(input.contract.arguments)) {
    if (!binding || (
      binding.source.kind !== 'workflow_input'
      && binding.source.kind !== 'continuation_cursor'
    )) {
      return 'The control-plane pilot accepts only workflow-input and host-owned continuation-cursor argument sources.';
    }
    const property = schema.properties[argumentName];
    const propertyType = schemaType(property);
    if (!propertyType || propertyType !== binding.type || binding.type !== 'string') {
      return `Argument "${argumentName}" does not preserve the exact live schema type.`;
    }
    if (requiredNames.has(argumentName) && binding.required !== true) {
      return `Required argument "${argumentName}" is not required by the typed binding.`;
    }
    if (binding.source.kind === 'continuation_cursor') {
      if (
        continuation.kind !== 'cursor'
        || continuation.cursorArgument !== argumentName
        || binding.required !== false
        || requiredNames.has(argumentName)
      ) return `Continuation argument "${argumentName}" is not an exact optional host-owned cursor.`;
    } else {
      referencedInputs.add(binding.source.key);
    }
  }
  if (continuation.kind === 'cursor') {
    const cursor = input.contract.arguments[continuation.cursorArgument];
    if (!cursor || cursor.source.kind !== 'continuation_cursor') {
      return 'The continuation contract does not bind its exact host-owned cursor argument.';
    }
  }
  if (
    Object.keys(input.contract.workflowInputs).length !== referencedInputs.size
    || Object.keys(input.contract.workflowInputs).some((key) => !referencedInputs.has(key))
  ) return 'Workflow input definitions do not exactly match the typed argument sources.';
  for (const key of referencedInputs) {
    const definition = input.contract.workflowInputs[key];
    if (
      !definition
      || definition.type !== 'string'
      || definition.required !== true
      || definition.default !== undefined
      || typeof input.workflowInputs[key] !== 'string'
      || input.workflowInputs[key].length === 0
    ) return `Workflow input "${key}" is not an exact required string source.`;
  }
  const workspaceSelection = input.contract.workspaceBindingSelection;
  if (input.contract.resultProjection) {
    const parsed = parseCanonicalEntityWorkspaceBindingSelection(workspaceSelection);
    if (!parsed.ok) return `The dataset pilot lacks an exact Workspace binding selection: ${parsed.errors.join(' ')}`;
    const workspace = spaceStore.get(parsed.selection.workspaceId);
    if (
      !workspace
      || workspace.version !== parsed.selection.expectedWorkspaceRevision
      || canonicalEntityWorkspaceSelectionDigest(workspace) !== parsed.selection.expectedWorkspaceDigest
    ) return 'The exact selected Workspace revision or digest is missing or stale.';
  } else if (workspaceSelection !== undefined) {
    return 'A dataset-less read pilot cannot provision a Workspace binding.';
  }
  return null;
}

function proposalIssue(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  expectedRevision: number;
  expectedDigest: string;
  contract: AutomationReadPilotTypedContractV1;
}): { code: string; reason: string } | null {
  if (
    input.proposal.revision !== input.expectedRevision
    || input.proposal.digest !== input.expectedDigest
  ) return { code: 'proposal_stale', reason: 'The proposal revision or digest is stale.' };
  if (input.proposal.status !== 'approved') {
    return { code: 'proposal_not_approved', reason: 'Only a separately reviewed and approved proposal can request a pilot.' };
  }
  const opportunity = input.proposal.opportunity;
  if (
    opportunity.phases.length !== 1
    || opportunity.capabilityRequirements.length !== 1
    || opportunity.partition.mode !== 'single'
  ) {
    return {
      code: 'pilot_shape_unsupported',
      reason: 'The first pilot supports exactly one unpartitioned phase and one capability.',
    };
  }
  const phase = opportunity.phases[0]!;
  const requirement = opportunity.capabilityRequirements[0]!;
  if (
    phase.id !== input.contract.phaseId
    || requirement.id !== input.contract.requirementId
    || phase.capabilityRequirementIds.length !== 1
    || phase.capabilityRequirementIds[0] !== requirement.id
  ) return { code: 'pilot_contract_mismatch', reason: 'The typed contract names a different phase or requirement.' };
  if (
    phase.effect.class !== 'read'
    || requirement.minimumEffect !== 'read'
    || opportunity.effectCeiling.class !== 'read'
  ) return { code: 'capability_effect_unsafe', reason: 'Compute or write work cannot enter the one-read pilot.' };
  return null;
}

function prepareProjection(
  input: RegisterAutomationReadPilotProjectionInputV1,
): PreparedProjection | { code: string; reason: string } {
  try {
    canonicalJson(input);
  } catch (error) {
    return {
      code: 'invalid_projection',
      reason: error instanceof Error ? error.message : 'Projection input is not bounded plain JSON.',
    };
  }
  if (
    !exactId(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalRevision)
    || input.expectedProposalRevision < 1
    || !SHA256_RE.test(input.expectedProposalDigest)
    || !exactId(input.approvalSessionId)
    || (input.originSessionId !== undefined && !exactId(input.originSessionId))
  ) return { code: 'invalid_projection', reason: 'Projection identity or proposal CAS is malformed.' };
  if (!Array.isArray(input.selections) || input.selections.length === 0) {
    return { code: 'capability_missing', reason: 'No exact live capability selection was supplied.' };
  }
  if (input.selections.length !== 1) {
    return { code: 'capability_ambiguous', reason: 'The pilot requires one exact live capability selection.' };
  }

  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal) return { code: 'proposal_missing', reason: 'The exact automation proposal was not found.' };
  const proposalProblem = proposalIssue({
    proposal,
    expectedRevision: input.expectedProposalRevision,
    expectedDigest: input.expectedProposalDigest,
    contract: input.contract,
  });
  if (proposalProblem) return proposalProblem;

  const selected = exactCurrentCapability({ selection: input.selections[0]! });
  if (!selected.ok) return selected;
  const typedProblem = typedContractIssue({
    contract: input.contract,
    workflowInputs: input.workflowInputs,
    schema: selected.schema,
  });
  if (typedProblem) return { code: 'typed_contract_invalid', reason: typedProblem };

  const workflowInputs = normalizeWorkflowRunInputs(input.workflowInputs);
  const logicalToolName = canonicalLogicalToolName(selected.identity.operationId);
  if (!logicalToolName) {
    return { code: 'capability_identity_invalid', reason: 'The exact operation has no canonical logical identity.' };
  }
  const capability: AutomationLiveCapabilityContractV1 = {
    lifecycle: 'current',
    logicalToolName,
    identity: selected.identity,
    matches: [{
      requirementId: input.contract.requirementId,
      requirementDigest: automationCapabilityRequirementDigest(
        proposal.opportunity.capabilityRequirements[0]!,
      ),
    }],
  };
  const readPilotContract: AutomationSingleReadPilotContractV1 = {
    phaseId: input.contract.phaseId,
    requirementId: input.contract.requirementId,
    workflowInputs: structuredClone(input.contract.workflowInputs),
    arguments: structuredClone(input.contract.arguments),
    evidence: structuredClone(input.contract.evidence),
    completeness: structuredClone(input.contract.completeness),
    ...(input.contract.continuation
      ? { continuation: structuredClone(input.contract.continuation) }
      : {}),
    ...(input.contract.resultProjection
      ? { resultProjection: structuredClone(input.contract.resultProjection) }
      : {}),
    ...(input.contract.workspaceBindingSelection
      ? { workspaceBindingSelection: structuredClone(input.contract.workspaceBindingSelection) }
      : {}),
  };
  const compilation: AutomationReadPilotCompilationInputV1 = {
    proposal,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    liveSnapshot: {
      capabilities: [capability],
      digest: automationLiveCapabilitySnapshotDigest([capability]),
    },
    selections: [{
      requirementId: input.contract.requirementId,
      capabilityId: selected.identity.capabilityId,
      expectedContractDigest: automationLiveCapabilityContractDigest(capability),
    }],
    readPilotContract,
  };
  const preview = designApprovedAutomationWorkflowBridge({
    ...compilation,
    activation: { kind: 'preview', target: 'pilot' },
  });
  if (
    !preview.ok
    || preview.issues.length > 0
    || !preview.preview
    || !preview.pilotApprovalRequest
  ) return {
    code: 'preview_blocked',
    reason: preview.issues.map((issue) => issue.message).join('; ')
      || 'The exact disabled pilot preview is not representable.',
  };
  const compilationJson = canonicalJson(compilation);
  const workflowInputsJson = canonicalJson(workflowInputs);
  const workflowInputsDigest = sha256(workflowInputsJson);
  const capabilityIdentityDigest = automationReadPilotCatalogIdentityDigest(selected.identity);
  const projectionId = `pilot-projection:${sha256(canonicalJson({
    domain: 'automation-read-pilot-projection',
    version: CONTROL_PLANE_VERSION,
    approvalResumeKey: preview.pilotApprovalRequest.resumeKey,
    approvalSessionId: input.approvalSessionId,
    compilationDigest: preview.preview.compilationDigest,
    capabilityIdentityDigest,
    schemaFingerprint: selected.schema.fingerprint,
    workflowInputsDigest,
  }))}`;
  // Parse the exact canonical bytes once before they become durable. This also
  // proves the stored representation cannot depend on prototypes or getters.
  const canonicalCompilation = JSON.parse(compilationJson) as AutomationReadPilotCompilationInputV1;
  return {
    compilation: canonicalCompilation,
    proposal,
    capabilityId: selected.identity.capabilityId,
    capabilityIdentityDigest,
    schemaFingerprint: selected.schema.fingerprint,
    workflowInputs,
    workflowInputsJson,
    workflowInputsDigest,
    approvalResumeKey: preview.pilotApprovalRequest.resumeKey,
    compilationDigest: preview.preview.compilationDigest,
    projectionId,
  };
}

function insertProjectionIntent(input: {
  prepared: PreparedProjection;
  request: RegisterAutomationReadPilotProjectionInputV1;
}): ProjectionSqlRow | { code: string; reason: string; row?: ProjectionSqlRow } {
  const db = database();
  const now = new Date().toISOString();
  const compilationJson = canonicalJson(input.prepared.compilation);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO automation_read_pilot_projections (
        projection_id, proposal_id, proposal_revision, proposal_digest,
        approval_session_id, origin_session_id, approval_resume_key,
        compilation_json, compilation_digest, capability_id,
        capability_identity_digest, schema_fingerprint, workflow_inputs_json,
        workflow_inputs_digest, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registering', ?, ?)
    `).run(
      input.prepared.projectionId,
      input.prepared.proposal.proposalId,
      input.prepared.proposal.revision,
      input.prepared.proposal.digest,
      input.request.approvalSessionId,
      input.request.originSessionId ?? null,
      input.prepared.approvalResumeKey,
      compilationJson,
      input.prepared.compilationDigest,
      input.prepared.capabilityId,
      input.prepared.capabilityIdentityDigest,
      input.prepared.schemaFingerprint,
      input.prepared.workflowInputsJson,
      input.prepared.workflowInputsDigest,
      now,
      now,
    );
  } catch (error) {
    return {
      code: 'projection_store_failed',
      reason: error instanceof Error ? error.message : 'Projection intent could not be stored.',
    };
  }
  const row = db.prepare(
    'SELECT * FROM automation_read_pilot_projections WHERE approval_resume_key = ?',
  ).get(input.prepared.approvalResumeKey) as ProjectionSqlRow | undefined;
  if (!row) return { code: 'projection_store_failed', reason: 'Projection intent disappeared after insertion.' };
  if (
    row.projection_id !== input.prepared.projectionId
    || row.compilation_json !== compilationJson
    || row.compilation_digest !== input.prepared.compilationDigest
    || row.workflow_inputs_json !== input.prepared.workflowInputsJson
    || row.workflow_inputs_digest !== input.prepared.workflowInputsDigest
    || row.capability_identity_digest !== input.prepared.capabilityIdentityDigest
    || row.schema_fingerprint !== input.prepared.schemaFingerprint
  ) return {
    code: 'projection_conflict',
    reason: 'This exact preview already has a durable projection with different input or binding bytes.',
    row,
  };
  return row;
}

function linkApproval(
  projectionId: string,
  approval: approvalRegistry.PendingApprovalRow,
): ProjectionSqlRow | null {
  const db = database();
  const now = new Date().toISOString();
  const transaction = db.transaction((): ProjectionSqlRow | null => {
    const current = db.prepare(
      'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
    ).get(projectionId) as ProjectionSqlRow | undefined;
    if (!current || current.status === 'refused') return null;
    if (
      current.approval_resume_key !== approval.resumeKey
      || (current.approval_id !== null && current.approval_id !== approval.approvalId)
    ) return null;
    db.prepare(`
      UPDATE automation_read_pilot_projections
         SET approval_id = ?, status = 'approval_pending', updated_at = ?
       WHERE projection_id = ?
         AND status IN ('registering','approval_pending')
         AND (approval_id IS NULL OR approval_id = ?)
    `).run(approval.approvalId, now, projectionId, approval.approvalId);
    return db.prepare(
      'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
    ).get(projectionId) as ProjectionSqlRow;
  });
  return transaction.immediate();
}

export function registerAutomationReadPilotProjection(
  input: RegisterAutomationReadPilotProjectionInputV1,
): RegisterAutomationReadPilotProjectionResult {
  const prepared = prepareProjection(input);
  if ('code' in prepared) return { ok: false, ...prepared };
  const inserted = insertProjectionIntent({ prepared, request: input });
  if ('code' in inserted) {
    return {
      ok: false,
      code: inserted.code,
      reason: inserted.reason,
      ...(inserted.row ? { projection: rowToProjection(inserted.row) } : {}),
    };
  }
  if (inserted.status === 'refused') {
    return {
      ok: false,
      code: inserted.refusal_code ?? 'projection_refused',
      reason: inserted.refusal_detail ?? 'The exact pilot projection is terminally refused.',
      projection: rowToProjection(inserted),
    };
  }
  if ((inserted.status === 'queued' || inserted.status === 'queueing') && inserted.approval_id) {
    const approval = approvalRegistry.get(inserted.approval_id);
    if (!approval) return {
      ok: false,
      code: 'approval_missing',
      reason: `${inserted.status === 'queued' ? 'Queued' : 'Queueing'} projection lost its approval row.`,
      projection: rowToProjection(inserted),
    };
    return {
      ok: true,
      projection: rowToProjection(inserted),
      approval,
      approvalCreated: false,
      cardCreated: false,
    };
  }
  const requested = requestAutomationReadPilotApproval({
    compilation: prepared.compilation,
    approvalSessionId: input.approvalSessionId,
  });
  if (!requested.ok) {
    return {
      ok: false,
      code: 'approval_request_failed',
      reason: requested.reason,
      projection: rowToProjection(inserted),
    };
  }
  const linked = linkApproval(prepared.projectionId, requested.approval.row);
  if (!linked) {
    return {
      ok: false,
      code: 'approval_link_failed',
      reason: 'The formal approval row could not be linked to the exact durable projection.',
      projection: rowToProjection(inserted),
    };
  }
  return {
    ok: true,
    projection: rowToProjection(linked),
    approval: requested.approval.row,
    approvalCreated: requested.approval.approvalCreated,
    cardCreated: requested.approval.eventCreated,
  };
}

/**
 * Canonical blank-state callsite. It asks one configured carrier boundary to
 * materialize the exact structured requirement, then immediately pins the
 * resulting manifest identity into normal registration. Absence of a carrier
 * port is a typed blocker; this function never falls back to a cached catalog,
 * provider name, remembered tool, or first search result.
 */
export async function acquireAndRegisterAutomationReadPilotProjection(
  input: AcquireAndRegisterAutomationReadPilotProjectionInputV1,
): Promise<RegisterAutomationReadPilotProjectionResult> {
  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal) return { ok: false, code: 'proposal_missing', reason: 'The exact automation proposal was not found.' };
  const proposalProblem = proposalIssue({
    proposal,
    expectedRevision: input.expectedProposalRevision,
    expectedDigest: input.expectedProposalDigest,
    contract: input.contract,
  });
  if (proposalProblem) return { ok: false, ...proposalProblem };
  if (!input.acquisition) {
    return {
      ok: false,
      code: 'capability_acquisition_unconfigured',
      reason: 'No provider-neutral live capability acquisition port owns this request.',
    };
  }
  const requirement = proposal.opportunity.capabilityRequirements[0]!;
  let acquired: MaterializeLiveReadCapabilityResult;
  try {
    acquired = await input.acquisition.acquire({
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      proposalDigest: proposal.digest,
      phaseId: input.contract.phaseId,
      requirementId: requirement.id,
      requirementDigest: automationCapabilityRequirementDigest(requirement),
      // Description is a retrieval objective only. The returned manifest is
      // independently closed and re-read below before it can become authority.
      objective: requirement.description,
      effect: 'read',
    });
  } catch (error) {
    return {
      ok: false,
      code: 'capability_acquisition_failed',
      reason: error instanceof Error ? error.message : 'Live capability acquisition failed.',
    };
  }
  if (acquired.status !== 'installed') {
    return {
      ok: false,
      code: `capability_acquisition_${acquired.reason}`,
      reason: acquired.detail,
    };
  }
  const entry = peekHostCapabilityCatalogFactory()?.get(acquired.manifest.manifestId);
  const identity = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (
    !identity
    || identity.manifestId !== acquired.manifest.manifestId
    || identity.manifestDigest !== fingerprintInstalledManifest(acquired.manifest.manifestId)
  ) {
    return {
      ok: false,
      code: 'capability_acquisition_projection_failed',
      reason: 'The acquired manifest did not round-trip through the exact host catalog and manifest store.',
    };
  }
  const { acquisition: _acquisition, ...registration } = input;
  return registerAutomationReadPilotProjection({
    ...registration,
    selections: [{
      capabilityId: identity.capabilityId,
      expectedIdentityDigest: automationReadPilotCatalogIdentityDigest(identity),
    }],
  });
}

function fingerprintInstalledManifest(manifestId: string): string | null {
  return peekCapabilityManifestStore()?.get(manifestId)?.digest ?? null;
}

function decodeProjectionPayload(row: ProjectionSqlRow): {
  compilation: AutomationReadPilotCompilationInputV1;
  workflowInputs: Record<string, string>;
} | null {
  try {
    const compilation = JSON.parse(row.compilation_json) as AutomationReadPilotCompilationInputV1;
    const workflowInputs = JSON.parse(row.workflow_inputs_json) as Record<string, string>;
    if (
      canonicalJson(compilation) !== row.compilation_json
      || canonicalJson(workflowInputs) !== row.workflow_inputs_json
      || sha256(row.workflow_inputs_json) !== row.workflow_inputs_digest
    ) return null;
    return { compilation, workflowInputs };
  } catch {
    return null;
  }
}

function currentProjectionIssue(
  row: ProjectionSqlRow,
  compilation: AutomationReadPilotCompilationInputV1,
): { code: string; reason: string; terminal: boolean } | null {
  const proposal = loadAutomationOpportunityProposal(row.proposal_id);
  if (
    !proposal
    || proposal.status !== 'approved'
    || proposal.revision !== row.proposal_revision
    || proposal.digest !== row.proposal_digest
    || compilation.expectedProposalRevision !== row.proposal_revision
    || compilation.expectedProposalDigest !== row.proposal_digest
  ) return {
    code: 'proposal_drift',
    reason: 'The exact approved proposal revision is missing or drifted.',
    terminal: true,
  };
  if (
    compilation.liveSnapshot.capabilities.length !== 1
    || compilation.liveSnapshot.capabilities[0]?.identity.capabilityId !== row.capability_id
  ) return {
    code: 'projection_integrity_failure',
    reason: 'The stored projection no longer contains one exact capability identity.',
    terminal: true,
  };
  const workspaceSelection = compilation.readPilotContract?.workspaceBindingSelection;
  if (proposal.opportunity.dataset) {
    const parsedSelection = parseCanonicalEntityWorkspaceBindingSelection(workspaceSelection);
    if (!parsedSelection.ok) return {
      code: 'workspace_binding_contract_invalid',
      reason: 'The reviewed dataset pilot no longer contains one exact Workspace binding selection.',
      terminal: true,
    };
    const workspace = spaceStore.get(parsedSelection.selection.workspaceId);
    if (
      !workspace
      || workspace.version !== parsedSelection.selection.expectedWorkspaceRevision
      || canonicalEntityWorkspaceSelectionDigest(workspace) !== parsedSelection.selection.expectedWorkspaceDigest
    ) return {
      code: 'workspace_binding_drift',
      reason: 'The selected Workspace is missing or drifted from the exact reviewed revision and digest.',
      terminal: true,
    };
  } else if (workspaceSelection !== undefined) return {
    code: 'workspace_binding_contract_invalid',
    reason: 'A dataset-less pilot cannot gain a Workspace binding.',
    terminal: true,
  };
  const entry = peekHostCapabilityCatalogFactory()?.get(row.capability_id);
  const identity = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (!identity) return {
    code: 'capability_unavailable',
    reason: 'The exact selected capability is not currently live.',
    terminal: false,
  };
  if (
    automationReadPilotCatalogIdentityDigest(identity) !== row.capability_identity_digest
    || canonicalJson(identity) !== canonicalJson(compilation.liveSnapshot.capabilities[0]!.identity)
  ) return {
    code: 'capability_drift',
    reason: 'The live capability no longer matches the approved identity bytes.',
    terminal: true,
  };
  if (!manifestForExactIdentity(identity)) return {
    code: 'capability_unavailable',
    reason: 'The approved materialized manifest or exact invocation port is unavailable.',
    terminal: false,
  };
  const schema = loadToolContract(identity.operationId);
  if (
    !schema
    || schema.identifier !== identity.operationId
    || schema.fingerprint !== row.schema_fingerprint
    || schema.providerObservedFingerprint !== schema.fingerprint
    || Boolean(schema.providerAuthorityConflictAt)
  ) return {
    code: schema && schema.fingerprint !== row.schema_fingerprint
      ? 'schema_drift'
      : 'schema_unavailable',
    reason: 'The exact provider-observed input schema is unavailable, conflicted, or drifted.',
    terminal: Boolean(schema && schema.fingerprint !== row.schema_fingerprint),
  };
  return null;
}

export type AutomationReadPilotProjectionAuthorityResolutionV1 =
  | {
      ok: true;
      projection: AutomationReadPilotProjectionV1;
      compilation: AutomationReadPilotCompilationInputV1;
      workflowInputs: Record<string, string>;
    }
  | { ok: false; code: string; reason: string };

/**
 * Resolve the exact durable pilot projection that owns a run and re-check its
 * current proposal, capability, account, schema, and Workspace selection.
 * This deliberately exposes no provider result body. Recurrence success
 * projection uses it to bind standing consent to the same reviewed compiler
 * bytes that admitted the one-shot pilot.
 */
export function loadCurrentAutomationReadPilotProjectionAuthorityForRun(
  runId: string,
): AutomationReadPilotProjectionAuthorityResolutionV1 {
  if (!exactId(runId)) {
    return { ok: false, code: 'run_identity_invalid', reason: 'Pilot run identity is invalid.' };
  }
  const rows = database().prepare(
    'SELECT * FROM automation_read_pilot_projections WHERE run_id = ? ORDER BY projection_id',
  ).all(runId) as ProjectionSqlRow[];
  if (rows.length === 0) {
    return { ok: false, code: 'projection_missing', reason: 'No durable pilot projection owns this run.' };
  }
  if (rows.length !== 1) {
    return { ok: false, code: 'projection_ambiguous', reason: 'More than one pilot projection claims this run.' };
  }
  const row = rows[0]!;
  if (row.status !== 'queued' || row.run_id !== runId || !row.trigger_receipt_id) {
    return { ok: false, code: 'projection_not_queued', reason: 'Pilot projection is not exactly queued with a trigger receipt.' };
  }
  const accepted = readWorkflowTriggerReceiptAcceptance(row.trigger_receipt_id);
  if (accepted !== runId) {
    return { ok: false, code: 'trigger_receipt_drift', reason: 'Pilot trigger receipt does not own this run.' };
  }
  const payload = decodeProjectionPayload(row);
  if (!payload) {
    return { ok: false, code: 'projection_integrity_failure', reason: 'Stored pilot projection bytes or digests are invalid.' };
  }
  const issue = currentProjectionIssue(row, payload.compilation);
  if (issue) return { ok: false, code: issue.code, reason: issue.reason };
  return {
    ok: true,
    projection: rowToProjection(row),
    compilation: JSON.parse(canonicalJson(payload.compilation)) as AutomationReadPilotCompilationInputV1,
    workflowInputs: JSON.parse(canonicalJson(payload.workflowInputs)) as Record<string, string>,
  };
}

function provisionReviewedCanonicalEntityWorkspaceBinding(
  compilation: AutomationReadPilotCompilationInputV1,
): { ok: true } | { ok: false; code: string; reason: string } {
  if (!compilation.proposal.opportunity.dataset) return { ok: true };
  const preview = designApprovedAutomationWorkflowBridge({
    ...compilation,
    activation: { kind: 'preview', target: 'pilot' },
  });
  const parsedApproval = parseCanonicalEntityWorkspaceBindingApproval(
    preview.preview?.canonicalEntityWorkspaceBinding,
  );
  if (
    !preview.ok
    || preview.issues.length > 0
    || !preview.preview
    || !parsedApproval.ok
    || parsedApproval.approval.binding.workflowId !== preview.preview.workflow.name
  ) return {
    ok: false,
    code: 'workspace_binding_contract_invalid',
    reason: !parsedApproval.ok
      ? parsedApproval.errors.join(' ')
      : 'The exact disabled preview does not carry its reviewed workflow-to-Workspace binding.',
  };
  const approved = parsedApproval.approval;
  const active = listWorkflowSurfaceBindingsForWorkflow(approved.binding.workflowId)
    .filter((binding) => binding.state !== 'retired');
  if (active.some((binding) => (
    binding.bindingId !== approved.binding.bindingId
    || binding.digest !== approved.bindingDigest
  ))) return {
    ok: false,
    code: 'workspace_binding_ambiguous',
    reason: 'The exact workflow already has a different non-retired Workspace binding.',
  };
  const stored = putSoleActiveWorkflowSurfaceBinding({ binding: approved.binding });
  if (!stored.ok || stored.digest !== approved.bindingDigest) return {
    ok: false,
    code: stored.ok ? 'workspace_binding_integrity_failure' : `workspace_binding_${stored.kind}`,
    reason: stored.ok
      ? 'The installed binding digest contradicted the reviewed approval bytes.'
      : stored.errors.join(' '),
  };
  return { ok: true };
}

function markRefused(
  row: ProjectionSqlRow,
  code: string,
  detail: string,
): AutomationReadPilotProjectionV1 {
  const db = database();
  db.prepare(`
    UPDATE automation_read_pilot_projections
       SET status = 'refused', refusal_code = ?, refusal_detail = ?, updated_at = ?
     WHERE projection_id = ? AND status <> 'queued'
  `).run(code, detail.slice(0, 8_192), new Date().toISOString(), row.projection_id);
  return rowToProjection(db.prepare(
    'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
  ).get(row.projection_id) as ProjectionSqlRow);
}

function recordQueueIntent(
  row: ProjectionSqlRow,
  receiptId: string,
): ProjectionSqlRow | null {
  const db = database();
  const transaction = db.transaction((): ProjectionSqlRow | null => {
    const changed = db.prepare(`
      UPDATE automation_read_pilot_projections
         SET status = 'queueing', trigger_receipt_id = ?, updated_at = ?
       WHERE projection_id = ?
         AND status IN ('approval_pending','queueing')
         AND (trigger_receipt_id IS NULL OR trigger_receipt_id = ?)
    `).run(receiptId, new Date().toISOString(), row.projection_id, receiptId).changes;
    if (changed !== 1) return null;
    return db.prepare(
      'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
    ).get(row.projection_id) as ProjectionSqlRow;
  });
  return transaction.immediate();
}

function markQueued(
  row: ProjectionSqlRow,
  receiptId: string,
  runId: string,
): AutomationReadPilotProjectionV1 | null {
  const db = database();
  const changed = db.prepare(`
    UPDATE automation_read_pilot_projections
       SET status = 'queued', run_id = ?, updated_at = ?
     WHERE projection_id = ?
       AND status IN ('queueing','queued')
       AND trigger_receipt_id = ?
       AND (run_id IS NULL OR run_id = ?)
  `).run(runId, new Date().toISOString(), row.projection_id, receiptId, runId).changes;
  if (changed !== 1) return null;
  return rowToProjection(db.prepare(
    'SELECT * FROM automation_read_pilot_projections WHERE projection_id = ?',
  ).get(row.projection_id) as ProjectionSqlRow);
}

let afterQueueAcceptedForTest: (() => void) | undefined;

/** Exact crash cut: the trigger receipt and run are durable, but projection
 * bookkeeping has not yet recorded the run id. */
export const automationReadPilotControlPlaneInternalsForTest = {
  setAfterQueueAcceptedHook(hook?: () => void): void {
    afterQueueAcceptedForTest = hook;
  },
};

function recoverApprovalRegistration(
  row: ProjectionSqlRow,
  payload: ReturnType<typeof decodeProjectionPayload> & {},
): ProjectionSqlRow | null {
  const requested = requestAutomationReadPilotApproval({
    compilation: payload.compilation,
    approvalSessionId: row.approval_session_id,
  });
  return requested.ok ? linkApproval(row.projection_id, requested.approval.row) : null;
}

export function reconcileAutomationReadPilotProjection(
  projectionId: string,
): ReconcileAutomationReadPilotProjectionResult {
  let row = loadProjectionRow(projectionId);
  if (!row) return { ok: false, code: 'projection_missing', reason: 'The pilot projection was not found.' };
  if (row.status === 'queued') {
    return { ok: true, state: 'already_queued', projection: rowToProjection(row) };
  }
  if (row.status === 'refused') {
    return { ok: true, state: 'refused', projection: rowToProjection(row) };
  }
  const payload = decodeProjectionPayload(row);
  if (!payload) {
    const projection = markRefused(row, 'projection_integrity_failure', 'Stored projection bytes or digests are invalid.');
    return { ok: true, state: 'refused', projection };
  }

  if (row.status === 'registering' || !row.approval_id) {
    const linked = recoverApprovalRegistration(row, payload);
    if (!linked) {
      return {
        ok: false,
        code: 'approval_registration_pending',
        reason: 'Formal approval registration has not converged yet.',
        projection: rowToProjection(row),
      };
    }
    row = linked;
  }
  if (!row.approval_id) {
    return { ok: false, code: 'approval_missing', reason: 'Projection has no exact formal approval.', projection: rowToProjection(row) };
  }

  // Queue acceptance is the durable winner. Recover it before consulting
  // mutable catalog state or the now-consumed approval row.
  if (row.trigger_receipt_id) {
    const accepted = readWorkflowTriggerReceiptAcceptance(row.trigger_receipt_id);
    if (accepted) {
      const projection = markQueued(row, row.trigger_receipt_id, accepted);
      if (!projection) {
        return { ok: false, code: 'projection_queue_commit_failed', reason: 'Accepted run could not be projected.', projection: rowToProjection(row) };
      }
      return { ok: true, state: 'queued', projection };
    }
  }

  const approval = approvalRegistry.get(row.approval_id);
  if (!approval || approval.resumeKey !== row.approval_resume_key) {
    const projection = markRefused(row, 'approval_drift', 'The exact formal approval row is missing or names different authority.');
    return { ok: true, state: 'refused', projection };
  }
  if (approval.status === 'pending') {
    if (approvalRegistry.isExpired(approval)) {
      const projection = markRefused(row, 'approval_expired', 'The exact pilot approval expired before queue admission.');
      return { ok: true, state: 'refused', projection };
    }
    return { ok: true, state: 'pending', projection: rowToProjection(row) };
  }
  if (approval.status !== 'resolved' || approval.resolution !== 'approved') {
    const projection = markRefused(
      row,
      `approval_${approval.resolution ?? approval.status}`,
      'The exact pilot approval was declined, expired, or cancelled.',
    );
    return { ok: true, state: 'refused', projection };
  }
  if (!approvalRegistry.approvalResolutionWithinLifetime(approval)) {
    const projection = markRefused(
      row,
      'approval_expired',
      'The exact pilot approval was resolved outside its validity window.',
    );
    return { ok: true, state: 'refused', projection };
  }

  const currentIssue = currentProjectionIssue(row, payload.compilation);
  if (currentIssue) {
    if (currentIssue.terminal) {
      const projection = markRefused(row, currentIssue.code, currentIssue.reason);
      return { ok: true, state: 'refused', projection };
    }
    return {
      ok: false,
      code: currentIssue.code,
      reason: currentIssue.reason,
      projection: rowToProjection(row),
    };
  }

  if (approval.consumedAt) {
    const recovered = resolveApprovedAutomationReadPilotAuthority({
      compilation: payload.compilation,
      approvalId: approval.approvalId,
      allowConsumed: true,
    });
    if (recovered.ok) {
      const accepted = readWorkflowTriggerReceiptAcceptance(recovered.triggerReceiptId);
      if (accepted) {
        const intent = recordQueueIntent(row, recovered.triggerReceiptId);
        const projection = intent
          ? markQueued(intent, recovered.triggerReceiptId, accepted)
          : null;
        if (projection) return { ok: true, state: 'queued', projection };
      }
    }
    const projection = markRefused(
      row,
      'approval_consumed_without_queue_receipt',
      'The one-shot approval was consumed without this projection owning a durable queue receipt.',
    );
    return { ok: true, state: 'refused', projection };
  }

  const authority = resolveApprovedAutomationReadPilotAuthority({
    compilation: payload.compilation,
    approvalId: approval.approvalId,
  });
  if (!authority.ok) {
    const projection = markRefused(row, 'approval_authority_mismatch', authority.reason);
    return { ok: true, state: 'refused', projection };
  }
  // Only an exact, still-unused approval that has already reconstructed queue
  // authority may install the binding shown on its card. Foreign consumption
  // or an authority mismatch therefore cannot strand an active empty binding.
  // This CAS remains inert and is replayable across every later queue cut.
  const workspaceBinding = provisionReviewedCanonicalEntityWorkspaceBinding(payload.compilation);
  if (!workspaceBinding.ok) {
    const projection = markRefused(row, workspaceBinding.code, workspaceBinding.reason);
    return { ok: true, state: 'refused', projection };
  }
  const intent = recordQueueIntent(row, authority.triggerReceiptId);
  if (!intent) {
    return {
      ok: false,
      code: 'projection_queue_intent_failed',
      reason: 'The exact trigger receipt could not be persisted before queueing.',
      projection: rowToProjection(row),
    };
  }
  const acceptedBeforeCall = readWorkflowTriggerReceiptAcceptance(authority.triggerReceiptId);
  if (acceptedBeforeCall) {
    const projection = markQueued(intent, authority.triggerReceiptId, acceptedBeforeCall);
    if (!projection) return { ok: false, code: 'projection_queue_commit_failed', reason: 'Accepted run could not be projected.', projection: rowToProjection(intent) };
    return { ok: true, state: 'queued', projection };
  }

  const queued = queueApprovedAutomationReadPilot({
    compilation: payload.compilation,
    approvalId: approval.approvalId,
    workflowInputs: payload.workflowInputs,
    ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {}),
  });
  if (!queued.ok) {
    return {
      ok: false,
      code: 'pilot_queue_failed',
      reason: queued.reason,
      projection: rowToProjection(intent),
    };
  }
  if (!queued.queue.id) {
    return {
      ok: false,
      code: 'pilot_queue_failed',
      reason: 'Pilot queue returned without a run identity.',
      projection: rowToProjection(intent),
    };
  }
  afterQueueAcceptedForTest?.();
  const accepted = readWorkflowTriggerReceiptAcceptance(authority.triggerReceiptId);
  if (!accepted || accepted !== queued.queue.id) {
    return {
      ok: false,
      code: 'pilot_queue_receipt_missing',
      reason: 'Pilot queue returned without its exact durable trigger receipt.',
      projection: rowToProjection(intent),
    };
  }
  const projection = markQueued(intent, authority.triggerReceiptId, accepted);
  if (!projection) {
    return {
      ok: false,
      code: 'projection_queue_commit_failed',
      reason: 'The queued run could not be projected after durable acceptance.',
      projection: rowToProjection(intent),
    };
  }
  return { ok: true, state: 'queued', projection };
}

export function reconcileAutomationReadPilotProjections(input: {
  approvalId?: string;
  limit?: number;
} = {}): ReconcileAutomationReadPilotProjectionsResult {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('projection reconcile limit must be from 1 through 1000');
  }
  const rows = input.approvalId
    ? database().prepare(`
        SELECT * FROM automation_read_pilot_projections
         WHERE approval_id = ? AND status IN ('registering','approval_pending','queueing')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(input.approvalId, limit) as ProjectionSqlRow[]
    : database().prepare(`
        SELECT * FROM automation_read_pilot_projections
         WHERE status IN ('registering','approval_pending','queueing')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(limit) as ProjectionSqlRow[];
  const result: ReconcileAutomationReadPilotProjectionsResult = {
    scanned: 0,
    pending: 0,
    queued: 0,
    alreadyQueued: 0,
    refused: 0,
    failed: 0,
  };
  for (const row of rows) {
    result.scanned += 1;
    try {
      const reconciled = reconcileAutomationReadPilotProjection(row.projection_id);
      if (!reconciled.ok) result.failed += 1;
      else if (reconciled.state === 'pending') result.pending += 1;
      else if (reconciled.state === 'queued') result.queued += 1;
      else if (reconciled.state === 'already_queued') result.alreadyQueued += 1;
      else result.refused += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

let listenerInstalled = false;

/** Register exactly one approval-row listener. The boot/timer scan remains the
 * recovery authority if a process dies before or during this best-effort kick. */
export function installAutomationReadPilotControlPlaneReconciler(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  approvalRegistry.onApprovalResolved((row) => {
    if (row.tool !== 'workflow_node_read' || !row.resumeKey?.startsWith('automation-pilot:v1:')) return;
    reconcileAutomationReadPilotProjections({ approvalId: row.approvalId, limit: 16 });
  });
}
