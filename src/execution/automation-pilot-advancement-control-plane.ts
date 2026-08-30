/**
 * Durable advancement saga from an exact approved automation proposal to the
 * existing one-shot pilot approval boundary.
 *
 * This control plane deliberately owns no human decision and no provider/tool
 * selection. It may stage the already-existing Workspace creation card,
 * materialize one registry-wide read capability as metadata, publish an
 * authority-free authoring request, and stage the already-existing full pilot
 * card. Workspace choice is accepted only through an injected host/UI human
 * authority. Pilot approval and queueing remain owned by the pilot control
 * plane.
 */
import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  canonicalEntityWorkspaceCreationContractDigest,
  canonicalEntityWorkspaceSelectionDigest,
  parseCanonicalEntityWorkspaceBindingSelection,
  type CanonicalEntityWorkspaceBindingSelectionV1,
  type CanonicalEntityWorkspaceCreationContractV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore, type SpaceRecord } from '../spaces/store.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
} from '../runtime/harness/host-capability-catalog-factory.js';
import { capabilityManifestDigest } from '../runtime/harness/capability-manifest.js';
import {
  configuredProductionLiveReadAcquisitionPort,
} from '../runtime/harness/production-live-read-acquisition-registry.js';
import type { MaterializeLiveReadCapabilityResult } from '../runtime/harness/live-capability-materializer.js';
import {
  loadAutomationOpportunityReviewProjection,
  listAutomationOpportunityReviewProjections,
} from './automation-opportunity-review-control-plane.js';
import {
  loadAutomationOpportunityProposal,
  type AutomationOpportunityProposalRecordV1,
} from './automation-opportunity-store.js';
import {
  automationCapabilityRequirementDigest,
} from './automation-workflow-bridge.js';
import { selectAutomaticReadPilotTarget } from './automation-pilot-target.js';
import {
  loadAutomationReadPilotWorkspaceCreation,
  reconcileAutomationReadPilotWorkspaceCreation,
  requestAutomationReadPilotWorkspaceCreation,
} from './automation-read-pilot-workspace-control-plane.js';
import {
  automationReadPilotCatalogIdentityDigest,
  loadAutomationReadPilotProjection,
  registerAutomationReadPilotProjection,
  type AutomationReadPilotCapabilityAcquisitionPortV1,
  type AutomationReadPilotTypedContractV1,
  type RegisterAutomationReadPilotProjectionResult,
} from './automation-read-pilot-control-plane.js';

const VERSION = 1 as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 4_194_304;
const MAX_AUTHORING_LEASE_MS = 30 * 60_000;
const MIN_AUTHORING_LEASE_MS = 5_000;

export type AutomationPilotAdvancementStage =
  | 'workspace_destination_required'
  | 'workspace_creation_pending'
  | 'acquisition_pending'
  | 'authoring_required'
  | 'pilot_registering'
  | 'pilot_approval_pending'
  | 'queued'
  | 'blocked';

export interface AutomationPilotWorkspaceOptionV1 {
  version: 1;
  workspaceId: string;
  expectedWorkspaceRevision: number;
  expectedWorkspaceDigest: string;
}

export type AutomationPilotWorkspaceDestinationChoiceV1 =
  | {
      kind: 'existing';
      workspace: AutomationPilotWorkspaceOptionV1;
    }
  | {
      kind: 'create_new';
      creationContractDigest: string;
    };

export interface AutomationPilotWorkspaceDestinationDecisionReceiptV1 {
  version: 1;
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  choice: AutomationPilotWorkspaceDestinationChoiceV1;
  actorRef: string;
  decidedAt: string;
  nonce: string;
}

/** Implemented only by the trusted host/UI decision surface. This interface is
 * never registered as a model-callable tool. */
export interface AutomationPilotWorkspaceDecisionAuthorityV1 {
  verify(input: {
    receipt: AutomationPilotWorkspaceDestinationDecisionReceiptV1;
    expectedChoicesDigest: string;
  }): { ok: true } | { ok: false; reason: string };
}

export interface AutomationPilotAcquisitionSnapshotV1 {
  version: 1;
  capabilityId: string;
  capabilityIdentityDigest: string;
  manifestDigest: string;
  providerKind: string;
  operationId: string;
  providerIdentity: string;
  providerVersion: string;
  operationVersion: string;
  accountId: string;
  definitionFingerprint: string;
  schemaFingerprint: string;
  inputSchema: Record<string, unknown>;
  /** Exact read-only definition metadata. Absence is meaningful and causes
   * automatic output-path authoring to refuse instead of sampling a live call. */
  outputShape?: {
    source: 'carrier_declared' | 'host_reviewed';
    schemaFingerprint: string;
    schema: Record<string, unknown>;
  };
  invokePortId: string;
  argumentCompiler: { id: string; version: string };
}

export interface AutomationPilotAuthoringRequestV1 {
  version: 1;
  requestId: string;
  advancementId: string;
  proposal: {
    proposalId: string;
    revision: number;
    digest: string;
    opportunity: AutomationOpportunityProposalRecordV1['opportunity'];
  };
  acceptedSource: {
    sessionId: string;
    sourceUserSeq: number;
  };
  requirement: {
    phaseId: string;
    requirementId: string;
    requirementDigest: string;
    effect: 'read';
  };
  workspaceSelection?: CanonicalEntityWorkspaceBindingSelectionV1;
  acquisition: AutomationPilotAcquisitionSnapshotV1;
  authority: {
    workspaceMutation: 'none';
    providerSelection: 'none';
    businessInvoke: 'none';
    pilotDecision: 'none';
    queue: 'none';
    schedule: 'none';
    recurrence: 'none';
    permittedOutput: 'typed_pilot_contract_candidate_only';
  };
}

export interface AutomationPilotAuthoringClaimV1 {
  version: 1;
  claimId: string;
  workerId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface AutomationPilotAuthoringFailureV1 {
  version: 1;
  attempt: number;
  code: string;
  detail: string;
  failedAt: string;
}

export interface AutomationPilotAuthoringResultV1 {
  version: 1;
  requestId: string;
  requestDigest: string;
  contract: AutomationReadPilotTypedContractV1;
  workflowInputs: Record<string, string>;
}

interface AutomationPilotBlockedV1 {
  code: string;
  detail: string;
}

interface AutomationPilotAdvancementStateV1 {
  version: 1;
  advancementId: string;
  reviewProjectionId: string;
  reviewApprovalId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  ownerSessionId: string;
  sourceUserSeq: number;
  stage: AutomationPilotAdvancementStage;
  workspaceOptions?: AutomationPilotWorkspaceOptionV1[];
  workspaceChoicesDigest?: string;
  workspaceCreationContract?: CanonicalEntityWorkspaceCreationContractV1;
  workspaceCreationProjectionId?: string;
  workspaceSelection?: CanonicalEntityWorkspaceBindingSelectionV1;
  workspaceDecision?: AutomationPilotWorkspaceDestinationDecisionReceiptV1;
  acquisition?: AutomationPilotAcquisitionSnapshotV1;
  authoringRequest?: AutomationPilotAuthoringRequestV1;
  authoringRequestDigest?: string;
  authoringClaim?: AutomationPilotAuthoringClaimV1;
  authoringAttemptCount?: number;
  authoringLastFailure?: AutomationPilotAuthoringFailureV1;
  authoringResult?: AutomationPilotAuthoringResultV1;
  authoringResultDigest?: string;
  pilotProjectionId?: string;
  blocked?: AutomationPilotBlockedV1;
}

export interface AutomationPilotAdvancementProjectionV1 extends AutomationPilotAdvancementStateV1 {
  stateRevision: number;
  stateDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationPilotAdvancementPortsV1 {
  acquisition?: AutomationReadPilotCapabilityAcquisitionPortV1;
  requestWorkspaceCreation?: typeof requestAutomationReadPilotWorkspaceCreation;
  reconcileWorkspaceCreation?: typeof reconcileAutomationReadPilotWorkspaceCreation;
  registerPilot?: (input: Parameters<typeof registerAutomationReadPilotProjection>[0]) => RegisterAutomationReadPilotProjectionResult;
}

export type RegisterAutomationPilotAdvancementResult =
  | { ok: true; projection: AutomationPilotAdvancementProjectionV1; created: boolean }
  | { ok: false; code: string; reason: string; projection?: AutomationPilotAdvancementProjectionV1 };

export type ReconcileAutomationPilotAdvancementResult =
  | { ok: true; state: 'waiting' | 'advanced' | 'queued' | 'blocked'; projection: AutomationPilotAdvancementProjectionV1 }
  | { ok: false; code: string; reason: string; projection?: AutomationPilotAdvancementProjectionV1 };

export interface ReconcileAutomationPilotAdvancementsResult {
  approvedReviewsScanned: number;
  advancementsCreated: number;
  advancementsScanned: number;
  waiting: number;
  advanced: number;
  queued: number;
  blocked: number;
  failed: number;
}

interface AdvancementSqlRow {
  advancement_id: string;
  review_projection_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_digest: string;
  owner_session_id: string;
  source_user_seq: number;
  stage: AutomationPilotAdvancementStage;
  state_revision: number;
  state_json: string;
  state_digest: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_pilot_advancement_control_plane_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_pilot_advancements (
  advancement_id TEXT PRIMARY KEY,
  review_projection_id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  proposal_digest TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  source_user_seq INTEGER NOT NULL CHECK (source_user_seq >= 1),
  stage TEXT NOT NULL CHECK (stage IN (
    'workspace_destination_required','workspace_creation_pending',
    'acquisition_pending','authoring_required','pilot_registering',
    'pilot_approval_pending','queued','blocked'
  )),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_pilot_advancement_reconcile
  ON automation_pilot_advancements(stage, updated_at, advancement_id);
`;

const EXPECTED_COLUMNS = new Set([
  'advancement_id', 'review_projection_id', 'proposal_id', 'proposal_revision',
  'proposal_digest', 'owner_session_id', 'source_user_seq', 'stage',
  'state_revision', 'state_json', 'state_digest', 'created_at', 'updated_at',
]);

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 40,
    maxNodes: 250_000,
    maxStringBytes: 1_048_576,
    maxTotalBytes: MAX_STATE_BYTES,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stateDigest(state: AutomationPilotAdvancementStateV1): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-advancement-state',
    version: VERSION,
    state,
  }));
}

function authoringDigest(request: AutomationPilotAuthoringRequestV1): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-authoring-request',
    version: VERSION,
    request,
  }));
}

function authoringResultDigest(result: AutomationPilotAuthoringResultV1): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-authoring-result',
    version: VERSION,
    result,
  }));
}

function choicesDigest(input: {
  options: readonly AutomationPilotWorkspaceOptionV1[];
  creationContractDigest: string;
}): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-workspace-destination-choices',
    version: VERSION,
    options: input.options,
    createNew: { creationContractDigest: input.creationContractDigest },
  }));
}

function database() {
  const db = openEventLog();
  const migration = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_pilot_advancement_control_plane_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migration.immediate();
  const versions = db.prepare(`
    SELECT version FROM automation_pilot_advancement_control_plane_migrations
    ORDER BY version ASC
  `).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== VERSION) {
    throw new Error('automation pilot advancement control-plane schema version is unknown');
  }
  const columns = new Set((db.prepare(
    'PRAGMA table_info(automation_pilot_advancements)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if ([...EXPECTED_COLUMNS].some((column) => !columns.has(column))) {
    throw new Error('automation pilot advancement control-plane schema is incomplete');
  }
  return db;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function validStateShape(state: AutomationPilotAdvancementStateV1): boolean {
  return state.version === VERSION
    && ID_RE.test(state.advancementId)
    && ID_RE.test(state.reviewProjectionId)
    && ID_RE.test(state.reviewApprovalId)
    && ID_RE.test(state.proposalId)
    && Number.isSafeInteger(state.proposalRevision)
    && state.proposalRevision >= 1
    && DIGEST_RE.test(state.proposalDigest)
    && ID_RE.test(state.ownerSessionId)
    && Number.isSafeInteger(state.sourceUserSeq)
    && state.sourceUserSeq >= 1
    && (state.authoringAttemptCount === undefined || (
      Number.isSafeInteger(state.authoringAttemptCount)
      && state.authoringAttemptCount >= 1
      && state.authoringAttemptCount <= 10
    ))
    && (state.authoringLastFailure === undefined || (
      state.authoringLastFailure.version === VERSION
      && Number.isSafeInteger(state.authoringLastFailure.attempt)
      && state.authoringLastFailure.attempt >= 1
      && ID_RE.test(state.authoringLastFailure.code)
      && typeof state.authoringLastFailure.detail === 'string'
      && state.authoringLastFailure.detail.length > 0
      && state.authoringLastFailure.detail.length <= 8_192
      && validIso(state.authoringLastFailure.failedAt)
    ));
}

function decodeRow(row: AdvancementSqlRow): AutomationPilotAdvancementProjectionV1 | null {
  try {
    const state = JSON.parse(row.state_json) as AutomationPilotAdvancementStateV1;
    if (
      canonicalJson(state) !== row.state_json
      || !validStateShape(state)
      || stateDigest(state) !== row.state_digest
      || state.advancementId !== row.advancement_id
      || state.reviewProjectionId !== row.review_projection_id
      || state.proposalId !== row.proposal_id
      || state.proposalRevision !== row.proposal_revision
      || state.proposalDigest !== row.proposal_digest
      || state.ownerSessionId !== row.owner_session_id
      || state.sourceUserSeq !== row.source_user_seq
      || state.stage !== row.stage
      || !Number.isSafeInteger(row.state_revision)
      || row.state_revision < 1
      || !DIGEST_RE.test(row.state_digest)
      || !validIso(row.created_at)
      || !validIso(row.updated_at)
    ) return null;
    return {
      ...structuredClone(state),
      stateRevision: row.state_revision,
      stateDigest: row.state_digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function rowFor(advancementId: string): AdvancementSqlRow | undefined {
  if (!ID_RE.test(advancementId)) return undefined;
  return database().prepare(
    'SELECT * FROM automation_pilot_advancements WHERE advancement_id = ?',
  ).get(advancementId) as AdvancementSqlRow | undefined;
}

export function loadAutomationPilotAdvancement(
  advancementId: string,
): AutomationPilotAdvancementProjectionV1 | undefined {
  const row = rowFor(advancementId);
  if (!row) return undefined;
  return decodeRow(row) ?? undefined;
}

export function listAutomationPilotAdvancements(input: {
  stage?: AutomationPilotAdvancementStage;
  limit?: number;
} = {}): AutomationPilotAdvancementProjectionV1[] {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('advancement list limit must be from 1 through 1000');
  }
  const rows = input.stage
    ? database().prepare(`
        SELECT * FROM automation_pilot_advancements
         WHERE stage = ? ORDER BY updated_at ASC, advancement_id ASC LIMIT ?
      `).all(input.stage, limit) as AdvancementSqlRow[]
    : database().prepare(`
        SELECT * FROM automation_pilot_advancements
         ORDER BY updated_at ASC, advancement_id ASC LIMIT ?
      `).all(limit) as AdvancementSqlRow[];
  return rows.flatMap((row) => {
    const decoded = decodeRow(row);
    return decoded ? [decoded] : [];
  });
}

function stateFromProjection(
  projection: AutomationPilotAdvancementProjectionV1,
): AutomationPilotAdvancementStateV1 {
  const {
    stateRevision: _stateRevision,
    stateDigest: _stateDigest,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...state
  } = projection;
  return state;
}

function transitionState(input: {
  current: AutomationPilotAdvancementProjectionV1;
  next: AutomationPilotAdvancementStateV1;
  now?: string;
}): AutomationPilotAdvancementProjectionV1 | null {
  if (
    !validStateShape(input.next)
    || input.next.advancementId !== input.current.advancementId
    || input.next.reviewProjectionId !== input.current.reviewProjectionId
    || input.next.reviewApprovalId !== input.current.reviewApprovalId
    || input.next.proposalId !== input.current.proposalId
    || input.next.proposalRevision !== input.current.proposalRevision
    || input.next.proposalDigest !== input.current.proposalDigest
    || input.next.ownerSessionId !== input.current.ownerSessionId
    || input.next.sourceUserSeq !== input.current.sourceUserSeq
  ) return null;
  const json = canonicalJson(input.next);
  const digest = stateDigest(input.next);
  const now = input.now ?? new Date().toISOString();
  if (!validIso(now)) return null;
  const changed = database().prepare(`
    UPDATE automation_pilot_advancements
       SET stage = ?, state_revision = ?, state_json = ?, state_digest = ?, updated_at = ?
     WHERE advancement_id = ? AND state_revision = ? AND state_digest = ?
  `).run(
    input.next.stage,
    input.current.stateRevision + 1,
    json,
    digest,
    now,
    input.current.advancementId,
    input.current.stateRevision,
    input.current.stateDigest,
  );
  if (changed.changes !== 1) return null;
  const row = rowFor(input.current.advancementId);
  return row ? decodeRow(row) : null;
}

function blockedState(
  current: AutomationPilotAdvancementProjectionV1,
  code: string,
  detail: string,
): AutomationPilotAdvancementStateV1 {
  return {
    ...stateFromProjection(current),
    stage: 'blocked',
    blocked: { code, detail: detail.slice(0, 8_192) },
  };
}

function block(
  current: AutomationPilotAdvancementProjectionV1,
  code: string,
  detail: string,
): AutomationPilotAdvancementProjectionV1 | null {
  return transitionState({ current, next: blockedState(current, code, detail) });
}

function cleanWorkspaceTitle(title: string): string {
  return title.slice(0, 200).trimEnd() || 'Automation Workspace';
}

function cleanWorkspaceObjective(objective: string): string {
  return objective.slice(0, 2_000).trimEnd() || 'Review canonical pilot results.';
}

export function deterministicAutomationPilotWorkspaceCreationContract(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  originSessionId: string;
}): CanonicalEntityWorkspaceCreationContractV1 {
  const dataset = input.proposal.opportunity.dataset;
  if (!dataset) throw new TypeError('a dataset proposal is required for Workspace creation');
  const selectedCriteria = new Set(input.proposal.opportunity.pilot.successCriterionIds);
  const successCriteria = [...new Set(input.proposal.opportunity.successCriteria
    .filter((criterion) => selectedCriteria.has(criterion.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((criterion) => criterion.description))];
  const datasetDigest = sha256(canonicalJson(dataset));
  return {
    version: 1,
    workspaceId: `automation-${input.proposal.digest.slice(0, 48)}`,
    title: cleanWorkspaceTitle(input.proposal.opportunity.title),
    objective: cleanWorkspaceObjective(input.proposal.opportunity.objective),
    successCriteria,
    invariants: [
      `Canonical entity truth remains bound to reviewed dataset contract ${datasetDigest}.`,
      'Ambiguous identity and merge conflicts retain their reviewed proposal disposition.',
      'Source snapshots and source, run, and observation references remain retained.',
      'Workspace visibility grants no provider, execution, schedule, or recurrence authority.',
    ],
    originSessionId: input.originSessionId,
  };
}

function workspaceOptions(records: readonly SpaceRecord[]): AutomationPilotWorkspaceOptionV1[] {
  return records
    .filter((record) => record.status !== 'archived')
    .map((record) => ({
      version: 1 as const,
      workspaceId: record.id,
      expectedWorkspaceRevision: record.version,
      expectedWorkspaceDigest: canonicalEntityWorkspaceSelectionDigest(record),
    }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

function advancementIdentity(input: {
  reviewProjectionId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  reviewApprovalId: string;
}): string {
  return `automation-pilot-advancement:${sha256(canonicalJson({
    domain: 'automation-pilot-advancement',
    version: VERSION,
    ...input,
  }))}`;
}

function supportedProposalIssue(proposal: AutomationOpportunityProposalRecordV1): string | null {
  const target = selectAutomaticReadPilotTarget(proposal.opportunity);
  return target.ok ? null : target.reason;
}

export function registerAutomationPilotAdvancement(input: {
  reviewProjectionId: string;
  listWorkspaces?: () => readonly SpaceRecord[];
}): RegisterAutomationPilotAdvancementResult {
  if (!ID_RE.test(input.reviewProjectionId)) {
    return { ok: false, code: 'review_projection_invalid', reason: 'The review projection identity is malformed.' };
  }
  const review = loadAutomationOpportunityReviewProjection(input.reviewProjectionId);
  if (!review) return { ok: false, code: 'review_projection_missing', reason: 'The exact review projection was not found.' };
  if (review.status !== 'approved' || !review.approvalId) {
    return { ok: false, code: 'proposal_not_approved', reason: 'Only an exact resolved proposal approval can start pilot advancement.' };
  }
  const proposal = loadAutomationOpportunityProposal(review.proposalId);
  if (
    !proposal
    || proposal.status !== 'approved'
    || proposal.digest !== review.proposalDigest
    || proposal.revision !== review.reviewedRevision + 1
  ) {
    return { ok: false, code: 'proposal_drift', reason: 'The approved proposal no longer matches its exact review lineage.' };
  }
  const unsupported = supportedProposalIssue(proposal);
  if (unsupported) return { ok: false, code: 'pilot_shape_unsupported', reason: unsupported };
  const advancementId = advancementIdentity({
    reviewProjectionId: review.projectionId,
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    reviewApprovalId: review.approvalId,
  });
  const replay = loadAutomationPilotAdvancement(advancementId);
  if (replay) return { ok: true, projection: replay, created: false };

  const base = {
    version: VERSION,
    advancementId,
    reviewProjectionId: review.projectionId,
    reviewApprovalId: review.approvalId,
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    ownerSessionId: review.ownerSessionId,
    sourceUserSeq: review.requestSourceUserSeq,
  } as const;
  let state: AutomationPilotAdvancementStateV1;
  if (!proposal.opportunity.dataset) {
    state = { ...base, stage: 'acquisition_pending' };
  } else {
    const creationContract = deterministicAutomationPilotWorkspaceCreationContract({
      proposal,
      originSessionId: review.ownerSessionId,
    });
    const options = workspaceOptions((input.listWorkspaces ?? (() => spaceStore.list()))());
    if (options.length === 0) {
      state = {
        ...base,
        stage: 'workspace_creation_pending',
        workspaceCreationContract: creationContract,
      };
    } else {
      const creationDigest = canonicalEntityWorkspaceCreationContractDigest(creationContract);
      state = {
        ...base,
        stage: 'workspace_destination_required',
        workspaceOptions: options,
        workspaceChoicesDigest: choicesDigest({ options, creationContractDigest: creationDigest }),
        workspaceCreationContract: creationContract,
      };
    }
  }
  const json = canonicalJson(state);
  const digest = stateDigest(state);
  const now = new Date().toISOString();
  database().prepare(`
    INSERT OR IGNORE INTO automation_pilot_advancements (
      advancement_id, review_projection_id, proposal_id, proposal_revision,
      proposal_digest, owner_session_id, source_user_seq, stage, state_revision,
      state_json, state_digest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    state.advancementId,
    state.reviewProjectionId,
    state.proposalId,
    state.proposalRevision,
    state.proposalDigest,
    state.ownerSessionId,
    state.sourceUserSeq,
    state.stage,
    json,
    digest,
    now,
    now,
  );
  const retained = loadAutomationPilotAdvancement(advancementId);
  if (!retained) {
    return { ok: false, code: 'advancement_store_failed', reason: 'The durable advancement intent did not round-trip.' };
  }
  if (
    retained.reviewProjectionId !== state.reviewProjectionId
    || retained.proposalRevision !== state.proposalRevision
    || retained.proposalDigest !== state.proposalDigest
  ) {
    return {
      ok: false,
      code: 'advancement_identity_conflict',
      reason: 'The deterministic advancement identity names different reviewed bytes.',
      projection: retained,
    };
  }
  return { ok: true, projection: retained, created: true };
}

function exactWorkspaceSelection(option: AutomationPilotWorkspaceOptionV1, proposalDigest: string): CanonicalEntityWorkspaceBindingSelectionV1 {
  return {
    version: 1,
    workspaceId: option.workspaceId,
    expectedWorkspaceRevision: option.expectedWorkspaceRevision,
    expectedWorkspaceDigest: option.expectedWorkspaceDigest,
    bindingId: `binding:${proposalDigest.slice(0, 24)}`,
    role: 'primary',
  };
}

export function recordAutomationPilotWorkspaceDestination(input: {
  advancementId: string;
  receipt: AutomationPilotWorkspaceDestinationDecisionReceiptV1;
  authority: AutomationPilotWorkspaceDecisionAuthorityV1;
}): RegisterAutomationPilotAdvancementResult {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  if (current.stage !== 'workspace_destination_required') {
    return { ok: false, code: 'workspace_destination_not_required', reason: 'This advancement is not awaiting a Workspace destination.', projection: current };
  }
  let receipt: AutomationPilotWorkspaceDestinationDecisionReceiptV1;
  try {
    receipt = JSON.parse(canonicalJson(input.receipt)) as AutomationPilotWorkspaceDestinationDecisionReceiptV1;
  } catch (error) {
    return {
      ok: false,
      code: 'workspace_destination_receipt_invalid',
      reason: error instanceof Error ? error.message : 'The Workspace destination receipt is not bounded plain JSON.',
      projection: current,
    };
  }
  if (
    receipt.version !== VERSION
    || receipt.advancementId !== current.advancementId
    || receipt.expectedStateRevision !== current.stateRevision
    || receipt.expectedStateDigest !== current.stateDigest
    || !ID_RE.test(receipt.actorRef)
    || !ID_RE.test(receipt.nonce)
    || !validIso(receipt.decidedAt)
    || !current.workspaceChoicesDigest
  ) {
    return { ok: false, code: 'workspace_destination_receipt_invalid', reason: 'The Workspace destination receipt is malformed or stale.', projection: current };
  }
  let verified: ReturnType<AutomationPilotWorkspaceDecisionAuthorityV1['verify']>;
  try {
    verified = input.authority.verify({
      receipt: structuredClone(receipt),
      expectedChoicesDigest: current.workspaceChoicesDigest,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'workspace_destination_authority_failed',
      reason: error instanceof Error ? error.message : String(error),
      projection: current,
    };
  }
  if (!verified.ok) {
    return { ok: false, code: 'workspace_destination_unverified', reason: verified.reason, projection: current };
  }
  let next: AutomationPilotAdvancementStateV1;
  if (receipt.choice.kind === 'create_new') {
    const contract = current.workspaceCreationContract;
    if (
      !contract
      || receipt.choice.creationContractDigest !== canonicalEntityWorkspaceCreationContractDigest(contract)
    ) {
      return { ok: false, code: 'workspace_creation_choice_drift', reason: 'The create-new choice does not name the exact staged creation contract.', projection: current };
    }
    const {
      workspaceOptions: _workspaceOptions,
      workspaceChoicesDigest: _workspaceChoicesDigest,
      ...withoutChoices
    } = stateFromProjection(current);
    next = {
      ...withoutChoices,
      stage: 'workspace_creation_pending',
      workspaceDecision: structuredClone(receipt),
    };
  } else {
    const selected = receipt.choice.workspace;
    const option = current.workspaceOptions?.find((candidate) => (
      candidate.workspaceId === selected.workspaceId
      && candidate.expectedWorkspaceRevision === selected.expectedWorkspaceRevision
      && candidate.expectedWorkspaceDigest === selected.expectedWorkspaceDigest
    ));
    if (!option) {
      return { ok: false, code: 'workspace_selection_not_offered', reason: 'The human receipt names a Workspace outside the exact offered inventory.', projection: current };
    }
    const workspace = spaceStore.get(option.workspaceId);
    if (
      !workspace
      || workspace.status === 'archived'
      || workspace.version !== option.expectedWorkspaceRevision
      || canonicalEntityWorkspaceSelectionDigest(workspace) !== option.expectedWorkspaceDigest
    ) {
      return { ok: false, code: 'workspace_selection_drift', reason: 'The selected Workspace revision or digest changed before it could be retained.', projection: current };
    }
    const {
      workspaceOptions: _workspaceOptions,
      workspaceChoicesDigest: _workspaceChoicesDigest,
      workspaceCreationContract: _workspaceCreationContract,
      ...withoutChoices
    } = stateFromProjection(current);
    next = {
      ...withoutChoices,
      stage: 'acquisition_pending',
      workspaceDecision: structuredClone(receipt),
      workspaceSelection: exactWorkspaceSelection(option, current.proposalDigest),
    };
  }
  const transitioned = transitionState({ current, next });
  if (!transitioned) {
    return { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the exact Workspace decision first.' };
  }
  return { ok: true, projection: transitioned, created: false };
}

function exactProposal(current: AutomationPilotAdvancementProjectionV1): AutomationOpportunityProposalRecordV1 | null {
  const proposal = loadAutomationOpportunityProposal(current.proposalId);
  if (
    !proposal
    || proposal.status !== 'approved'
    || proposal.revision !== current.proposalRevision
    || proposal.digest !== current.proposalDigest
  ) return null;
  const review = loadAutomationOpportunityReviewProjection(current.reviewProjectionId);
  if (
    !review
    || review.status !== 'approved'
    || review.approvalId !== current.reviewApprovalId
    || review.ownerSessionId !== current.ownerSessionId
    || review.requestSourceUserSeq !== current.sourceUserSeq
    || review.proposalId !== current.proposalId
    || review.proposalDigest !== current.proposalDigest
    || review.reviewedRevision + 1 !== current.proposalRevision
  ) return null;
  return proposal;
}

function workspaceSelectionCurrent(selection: CanonicalEntityWorkspaceBindingSelectionV1 | undefined): boolean {
  const parsed = parseCanonicalEntityWorkspaceBindingSelection(selection);
  if (!parsed.ok) return false;
  const workspace = spaceStore.get(parsed.selection.workspaceId);
  return Boolean(
    workspace
    && workspace.status !== 'archived'
    && workspace.version === parsed.selection.expectedWorkspaceRevision
    && canonicalEntityWorkspaceSelectionDigest(workspace) === parsed.selection.expectedWorkspaceDigest,
  );
}

function acquisitionRequest(proposal: AutomationOpportunityProposalRecordV1) {
  const target = selectAutomaticReadPilotTarget(proposal.opportunity);
  if (!target.ok) throw new TypeError(target.reason);
  const { phase, requirement } = target;
  return {
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    phaseId: phase.id,
    requirementId: requirement.id,
    requirementDigest: automationCapabilityRequirementDigest(requirement),
    objective: requirement.description,
    effect: 'read' as const,
  };
}

function acquisitionSnapshot(
  result: Extract<MaterializeLiveReadCapabilityResult, { status: 'installed' }>,
): AutomationPilotAcquisitionSnapshotV1 | null {
  const { manifest, attestation } = result;
  const entry = peekHostCapabilityCatalogFactory()?.get(manifest.manifestId);
  const identity = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (
    !identity
    || manifest.effect !== 'read'
    || attestation.effect !== 'read'
    || manifest.manifestId !== identity.capabilityId
    || manifest.operationId !== attestation.reference.identifier
    || manifest.operationId !== identity.operationId
    || manifest.providerIdentity !== attestation.providerIdentity
    || manifest.providerVersion !== attestation.providerVersion
    || manifest.operationVersion !== attestation.operationVersion
    || manifest.accountId !== attestation.accountId
    || manifest.accountId !== identity.account
    || manifest.definitionFingerprint !== attestation.definitionFingerprint
    || manifest.invokePortId !== attestation.invoke.portId
    || manifest.invokePortId !== identity.invokePortId
    || manifest.argumentCompiler.id !== attestation.invoke.argumentCompiler.id
    || manifest.argumentCompiler.version !== attestation.invoke.argumentCompiler.version
  ) return null;
  const outputShapeParts = [
    attestation.outputSchema,
    attestation.outputSchemaFingerprint,
    attestation.outputSchemaAttestation,
  ].filter((part) => part !== undefined).length;
  if (outputShapeParts !== 0 && outputShapeParts !== 3) return null;
  try {
    const inputSchema = JSON.parse(canonicalJson(attestation.inputSchema)) as Record<string, unknown>;
    const outputShape = attestation.outputSchema
      && attestation.outputSchemaFingerprint
      && attestation.outputSchemaAttestation
      ? {
          source: attestation.outputSchemaAttestation,
          schemaFingerprint: attestation.outputSchemaFingerprint,
          schema: JSON.parse(canonicalJson(attestation.outputSchema)) as Record<string, unknown>,
        }
      : undefined;
    return {
      version: 1,
      capabilityId: identity.capabilityId,
      capabilityIdentityDigest: automationReadPilotCatalogIdentityDigest(identity),
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      operationId: manifest.operationId,
      providerIdentity: manifest.providerIdentity,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      schemaFingerprint: attestation.schemaFingerprint,
      inputSchema,
      ...(outputShape ? { outputShape } : {}),
      invokePortId: manifest.invokePortId,
      argumentCompiler: structuredClone(manifest.argumentCompiler),
    };
  } catch {
    return null;
  }
}

function sameAcquisition(
  left: AutomationPilotAcquisitionSnapshotV1,
  right: AutomationPilotAcquisitionSnapshotV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function buildAuthoringRequest(input: {
  current: AutomationPilotAdvancementProjectionV1;
  proposal: AutomationOpportunityProposalRecordV1;
  acquisition: AutomationPilotAcquisitionSnapshotV1;
}): AutomationPilotAuthoringRequestV1 {
  const target = selectAutomaticReadPilotTarget(input.proposal.opportunity);
  if (!target.ok) throw new TypeError(target.reason);
  const { phase, requirement } = target;
  const requestCore = {
    version: VERSION,
    advancementId: input.current.advancementId,
    proposal: {
      proposalId: input.proposal.proposalId,
      revision: input.proposal.revision,
      digest: input.proposal.digest,
      opportunity: structuredClone(input.proposal.opportunity),
    },
    acceptedSource: {
      sessionId: input.current.ownerSessionId,
      sourceUserSeq: input.current.sourceUserSeq,
    },
    requirement: {
      phaseId: phase.id,
      requirementId: requirement.id,
      requirementDigest: automationCapabilityRequirementDigest(requirement),
      effect: 'read' as const,
    },
    ...(input.current.workspaceSelection
      ? { workspaceSelection: structuredClone(input.current.workspaceSelection) }
      : {}),
    acquisition: structuredClone(input.acquisition),
    authority: {
      workspaceMutation: 'none' as const,
      providerSelection: 'none' as const,
      businessInvoke: 'none' as const,
      pilotDecision: 'none' as const,
      queue: 'none' as const,
      schedule: 'none' as const,
      recurrence: 'none' as const,
      permittedOutput: 'typed_pilot_contract_candidate_only' as const,
    },
  };
  const requestId = `automation-pilot-authoring:${sha256(canonicalJson({
    domain: 'automation-pilot-authoring-request-identity',
    version: VERSION,
    request: requestCore,
  }))}`;
  return { ...requestCore, requestId };
}

function resolvedPorts(ports: AutomationPilotAdvancementPortsV1): Required<AutomationPilotAdvancementPortsV1> {
  return {
    acquisition: ports.acquisition ?? configuredProductionLiveReadAcquisitionPort(),
    requestWorkspaceCreation: ports.requestWorkspaceCreation ?? requestAutomationReadPilotWorkspaceCreation,
    reconcileWorkspaceCreation: ports.reconcileWorkspaceCreation ?? reconcileAutomationReadPilotWorkspaceCreation,
    registerPilot: ports.registerPilot ?? registerAutomationReadPilotProjection,
  };
}

let afterPilotRegistrationForTest: (() => void) | undefined;

async function reacquire(input: {
  proposal: AutomationOpportunityProposalRecordV1;
  acquisition: AutomationReadPilotCapabilityAcquisitionPortV1;
}): Promise<{ ok: true; snapshot: AutomationPilotAcquisitionSnapshotV1 } | { ok: false; code: string; reason: string }> {
  let acquired: MaterializeLiveReadCapabilityResult;
  try {
    acquired = await input.acquisition.acquire(acquisitionRequest(input.proposal));
  } catch (error) {
    return { ok: false, code: 'capability_acquisition_failed', reason: error instanceof Error ? error.message : String(error) };
  }
  if (acquired.status !== 'installed') {
    return { ok: false, code: `capability_acquisition_${acquired.reason}`, reason: acquired.detail };
  }
  const snapshot = acquisitionSnapshot(acquired);
  if (!snapshot) {
    return { ok: false, code: 'capability_acquisition_identity_invalid', reason: 'The materialized capability did not round-trip its exact catalog, schema, account, and invoke identity.' };
  }
  return { ok: true, snapshot };
}

export async function reconcileAutomationPilotAdvancement(
  advancementId: string,
  portsInput: AutomationPilotAdvancementPortsV1 = {},
): Promise<ReconcileAutomationPilotAdvancementResult> {
  const ports = resolvedPorts(portsInput);
  let current = loadAutomationPilotAdvancement(advancementId);
  if (!current) return { ok: false, code: 'advancement_missing_or_corrupt', reason: 'The exact advancement was not found or failed integrity validation.' };

  for (let transitions = 0; transitions < 8; transitions += 1) {
    if (current.stage === 'blocked') return { ok: true, state: 'blocked', projection: current };
    if (current.stage === 'queued') return { ok: true, state: 'queued', projection: current };
    const proposal = exactProposal(current);
    if (!proposal) {
      const refused = block(current, 'proposal_or_review_drift', 'The exact approved proposal or its human review lineage drifted.');
      return refused
        ? { ok: true, state: 'blocked', projection: refused }
        : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
    }

    if (current.stage === 'workspace_destination_required' || current.stage === 'authoring_required') {
      return { ok: true, state: 'waiting', projection: current };
    }

    if (current.stage === 'workspace_creation_pending') {
      const contract = current.workspaceCreationContract;
      if (!contract) {
        const refused = block(current, 'workspace_creation_contract_missing', 'The durable Workspace creation intent is incomplete.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      const requested = ports.requestWorkspaceCreation({
        proposalId: current.proposalId,
        expectedProposalRevision: current.proposalRevision,
        expectedProposalDigest: current.proposalDigest,
        approvalSessionId: current.ownerSessionId,
        sourceUserSeq: current.sourceUserSeq,
        contract,
      });
      if (!requested.ok) {
        const refused = block(current, requested.code, requested.reason);
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (current.workspaceCreationProjectionId !== requested.projection.projectionId) {
        const next = {
          ...stateFromProjection(current),
          workspaceCreationProjectionId: requested.projection.projectionId,
        };
        const transitioned = transitionState({ current, next });
        if (!transitioned) {
          current = loadAutomationPilotAdvancement(advancementId) ?? current;
          continue;
        }
        current = transitioned;
      }
      const reconciled = ports.reconcileWorkspaceCreation(requested.projection.projectionId);
      if (!reconciled.ok) {
        const refused = block(current, reconciled.code, reconciled.reason);
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (reconciled.state === 'pending') return { ok: true, state: 'waiting', projection: current };
      if (reconciled.state === 'refused' || !reconciled.projection.selection) {
        const refused = block(
          current,
          reconciled.projection.refusalCode ?? 'workspace_creation_refused',
          reconciled.projection.refusalDetail ?? 'The exact Workspace creation was not authorized.',
        );
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (!workspaceSelectionCurrent(reconciled.projection.selection)) {
        const refused = block(current, 'workspace_creation_selection_drift', 'The created Workspace no longer matches its exact retained selection.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      const transitioned = transitionState({
        current,
        next: {
          ...stateFromProjection(current),
          stage: 'acquisition_pending',
          workspaceSelection: structuredClone(reconciled.projection.selection),
        },
      });
      if (!transitioned) {
        current = loadAutomationPilotAdvancement(advancementId) ?? current;
        continue;
      }
      current = transitioned;
      continue;
    }

    if (proposal.opportunity.dataset && !workspaceSelectionCurrent(current.workspaceSelection)) {
      const refused = block(current, 'workspace_selection_drift', 'The exact Workspace selection changed before pilot authoring or registration.');
      return refused
        ? { ok: true, state: 'blocked', projection: refused }
        : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
    }

    if (current.stage === 'acquisition_pending') {
      const acquired = await reacquire({ proposal, acquisition: ports.acquisition });
      if (!acquired.ok) {
        const refused = block(current, acquired.code, acquired.reason);
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      const request = buildAuthoringRequest({ current, proposal, acquisition: acquired.snapshot });
      const next: AutomationPilotAdvancementStateV1 = {
        ...stateFromProjection(current),
        stage: 'authoring_required',
        acquisition: acquired.snapshot,
        authoringRequest: request,
        authoringRequestDigest: authoringDigest(request),
      };
      const transitioned = transitionState({ current, next });
      if (!transitioned) {
        current = loadAutomationPilotAdvancement(advancementId) ?? current;
        continue;
      }
      return { ok: true, state: 'advanced', projection: transitioned };
    }

    if (current.stage === 'pilot_registering') {
      if (!current.acquisition || !current.authoringResult || !current.authoringResultDigest) {
        const refused = block(current, 'pilot_registration_intent_incomplete', 'The durable pilot registration intent is incomplete.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (authoringResultDigest(current.authoringResult) !== current.authoringResultDigest) {
        const refused = block(current, 'authoring_result_integrity_failure', 'The retained authoring result failed its exact digest.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      const refreshed = await reacquire({ proposal, acquisition: ports.acquisition });
      if (!refreshed.ok) {
        const refused = block(current, refreshed.code, refreshed.reason);
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (!sameAcquisition(current.acquisition, refreshed.snapshot)) {
        const refused = block(current, 'capability_acquisition_drift', 'The exact capability, account, schema, or invoke identity changed after authoring.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      const registered = ports.registerPilot({
        proposalId: current.proposalId,
        expectedProposalRevision: current.proposalRevision,
        expectedProposalDigest: current.proposalDigest,
        approvalSessionId: current.ownerSessionId,
        originSessionId: current.ownerSessionId,
        selections: [{
          capabilityId: refreshed.snapshot.capabilityId,
          expectedIdentityDigest: refreshed.snapshot.capabilityIdentityDigest,
        }],
        contract: structuredClone(current.authoringResult.contract),
        workflowInputs: structuredClone(current.authoringResult.workflowInputs),
      });
      if (!registered.ok) {
        const refused = block(current, registered.code, registered.reason);
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (
        registered.projection.capabilityId !== refreshed.snapshot.capabilityId
        || registered.projection.capabilityIdentityDigest !== refreshed.snapshot.capabilityIdentityDigest
        || registered.projection.schemaFingerprint !== refreshed.snapshot.schemaFingerprint
        || registered.projection.proposalRevision !== current.proposalRevision
        || registered.projection.proposalDigest !== current.proposalDigest
      ) {
        const refused = block(current, 'pilot_projection_identity_drift', 'The staged pilot card names different capability or proposal bytes.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      afterPilotRegistrationForTest?.();
      const nextStage = registered.projection.status === 'queued' ? 'queued' : 'pilot_approval_pending';
      const transitioned = transitionState({
        current,
        next: {
          ...stateFromProjection(current),
          stage: nextStage,
          pilotProjectionId: registered.projection.projectionId,
        },
      });
      if (!transitioned) {
        current = loadAutomationPilotAdvancement(advancementId) ?? current;
        continue;
      }
      current = transitioned;
      if (current.stage === 'queued') return { ok: true, state: 'queued', projection: current };
      continue;
    }

    if (current.stage === 'pilot_approval_pending') {
      const pilot = current.pilotProjectionId
        ? loadAutomationReadPilotProjection(current.pilotProjectionId)
        : undefined;
      if (!pilot) {
        const refused = block(current, 'pilot_projection_missing', 'The exact staged pilot projection is missing.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (
        pilot.proposalId !== current.proposalId
        || pilot.proposalRevision !== current.proposalRevision
        || pilot.proposalDigest !== current.proposalDigest
        || pilot.capabilityId !== current.acquisition?.capabilityId
        || pilot.capabilityIdentityDigest !== current.acquisition?.capabilityIdentityDigest
        || pilot.schemaFingerprint !== current.acquisition?.schemaFingerprint
      ) {
        const refused = block(current, 'pilot_projection_drift', 'The staged pilot projection changed its exact proposal or capability identity.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (pilot.status === 'refused') {
        const refused = block(current, pilot.refusalCode ?? 'pilot_refused', pilot.refusalDetail ?? 'The exact pilot approval or queue admission was refused.');
        return refused
          ? { ok: true, state: 'blocked', projection: refused }
          : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
      }
      if (pilot.status !== 'queued') return { ok: true, state: 'waiting', projection: current };
      const transitioned = transitionState({
        current,
        next: { ...stateFromProjection(current), stage: 'queued' },
      });
      return transitioned
        ? { ok: true, state: 'queued', projection: transitioned }
        : { ok: false, code: 'advancement_cas_lost', reason: 'Another reconciler advanced the saga first.' };
    }
  }
  return { ok: false, code: 'advancement_transition_budget', reason: 'The advancement exceeded its bounded transition budget.', projection: current };
}

/** Boot/timer entry point. It discovers only exact already-approved review
 * projections, registers their content-addressed saga once, and advances each
 * durable non-terminal row. Chat prose, titles, catalog order, and provider
 * names are never scanned. */
export async function reconcileAutomationPilotAdvancements(input: {
  limit?: number;
  ports?: AutomationPilotAdvancementPortsV1;
  listWorkspaces?: () => readonly SpaceRecord[];
} = {}): Promise<ReconcileAutomationPilotAdvancementsResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('advancement reconcile limit must be from 1 through 1000');
  }
  const result: ReconcileAutomationPilotAdvancementsResult = {
    approvedReviewsScanned: 0,
    advancementsCreated: 0,
    advancementsScanned: 0,
    waiting: 0,
    advanced: 0,
    queued: 0,
    blocked: 0,
    failed: 0,
  };
  const approved = listAutomationOpportunityReviewProjections({ status: 'approved', limit });
  for (const reviewProjection of approved) {
    result.approvedReviewsScanned += 1;
    try {
      const registered = registerAutomationPilotAdvancement({
        reviewProjectionId: reviewProjection.projectionId,
        ...(input.listWorkspaces ? { listWorkspaces: input.listWorkspaces } : {}),
      });
      if (!registered.ok) result.failed += 1;
      else if (registered.created) result.advancementsCreated += 1;
    } catch {
      result.failed += 1;
    }
  }
  const rows = listAutomationPilotAdvancements({ limit });
  for (const row of rows) {
    if (row.stage === 'queued') {
      result.queued += 1;
      continue;
    }
    if (row.stage === 'blocked') {
      result.blocked += 1;
      continue;
    }
    result.advancementsScanned += 1;
    try {
      const reconciled = await reconcileAutomationPilotAdvancement(row.advancementId, input.ports);
      if (!reconciled.ok) result.failed += 1;
      else result[reconciled.state] += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export function claimAutomationPilotAuthoringRequest(input: {
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  workerId: string;
  leaseMs: number;
  nowMs?: number;
}): { ok: true; projection: AutomationPilotAdvancementProjectionV1; request: AutomationPilotAuthoringRequestV1; requestDigest: string; claim: AutomationPilotAuthoringClaimV1 } | {
  ok: false;
  code: string;
  reason: string;
  projection?: AutomationPilotAdvancementProjectionV1;
} {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  if (
    current.stage !== 'authoring_required'
    || !current.authoringRequest
    || !current.authoringRequestDigest
    || current.stateRevision !== input.expectedStateRevision
    || current.stateDigest !== input.expectedStateDigest
    || !ID_RE.test(input.workerId)
    || !Number.isSafeInteger(input.leaseMs)
    || input.leaseMs < MIN_AUTHORING_LEASE_MS
    || input.leaseMs > MAX_AUTHORING_LEASE_MS
  ) return { ok: false, code: 'authoring_claim_invalid', reason: 'The authoring request, state CAS, worker, or lease is invalid.', projection: current };
  if (authoringDigest(current.authoringRequest) !== current.authoringRequestDigest) {
    return { ok: false, code: 'authoring_request_integrity_failure', reason: 'The exact authoring request failed its digest.', projection: current };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    return { ok: false, code: 'authoring_claim_time_invalid', reason: 'The authoring claim time is invalid.', projection: current };
  }
  if (current.authoringClaim && Date.parse(current.authoringClaim.expiresAt) > nowMs) {
    return { ok: false, code: 'authoring_already_claimed', reason: 'The exact authoring request has an active worker lease.', projection: current };
  }
  const claimedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + input.leaseMs).toISOString();
  const claim: AutomationPilotAuthoringClaimV1 = {
    version: 1,
    claimId: `automation-pilot-authoring-claim:${sha256(canonicalJson({
      domain: 'automation-pilot-authoring-claim',
      version: VERSION,
      advancementId: current.advancementId,
      requestDigest: current.authoringRequestDigest,
      workerId: input.workerId,
      claimedAt,
      expiresAt,
    }))}`,
    workerId: input.workerId,
    claimedAt,
    expiresAt,
  };
  const authoringAttemptCount = (current.authoringAttemptCount ?? 0) + 1;
  const transitioned = transitionState({
    current,
    next: {
      ...stateFromProjection(current),
      authoringClaim: claim,
      authoringAttemptCount,
    },
    now: claimedAt,
  });
  if (!transitioned) return { ok: false, code: 'advancement_cas_lost', reason: 'Another authoring worker won the exact state claim.' };
  return {
    ok: true,
    projection: transitioned,
    request: structuredClone(current.authoringRequest),
    requestDigest: current.authoringRequestDigest,
    claim,
  };
}

export function recordAutomationPilotAuthoringAttemptFailure(input: {
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  claimId: string;
  code: string;
  detail: string;
  maxAttempts: number;
  nowMs?: number;
}): RegisterAutomationPilotAdvancementResult {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  const nowMs = input.nowMs ?? Date.now();
  if (
    current.stage !== 'authoring_required'
    || current.stateRevision !== input.expectedStateRevision
    || current.stateDigest !== input.expectedStateDigest
    || !current.authoringClaim
    || current.authoringClaim.claimId !== input.claimId
    || !ID_RE.test(input.code)
    || typeof input.detail !== 'string'
    || input.detail.length < 1
    || !Number.isSafeInteger(input.maxAttempts)
    || input.maxAttempts < 1
    || input.maxAttempts > 10
    || !Number.isSafeInteger(nowMs)
    || nowMs < Date.parse(current.authoringClaim.claimedAt)
  ) {
    return {
      ok: false,
      code: 'authoring_failure_invalid',
      reason: 'The authoring failure does not own the exact active attempt.',
      projection: current,
    };
  }
  const attempt = current.authoringAttemptCount ?? 1;
  const failure: AutomationPilotAuthoringFailureV1 = {
    version: VERSION,
    attempt,
    code: input.code,
    detail: input.detail.slice(0, 8_192),
    failedAt: new Date(nowMs).toISOString(),
  };
  const {
    authoringClaim: _authoringClaim,
    blocked: _blocked,
    ...withoutClaim
  } = stateFromProjection(current);
  const next: AutomationPilotAdvancementStateV1 = attempt >= input.maxAttempts
    ? {
        ...withoutClaim,
        stage: 'blocked',
        authoringLastFailure: failure,
        blocked: {
          code: 'authoring_attempt_budget_exhausted',
          detail: `Automatic pilot authoring exhausted ${attempt} bounded attempt${attempt === 1 ? '' : 's'}: ${failure.detail}`.slice(0, 8_192),
        },
      }
    : {
        ...withoutClaim,
        stage: 'authoring_required',
        authoringLastFailure: failure,
      };
  const transitioned = transitionState({ current, next, now: failure.failedAt });
  if (!transitioned) return { ok: false, code: 'advancement_cas_lost', reason: 'Another authoring worker changed the exact attempt first.' };
  return { ok: true, projection: transitioned, created: false };
}

export function blockAutomationPilotAuthoringRequest(input: {
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  code: string;
  detail: string;
}): RegisterAutomationPilotAdvancementResult {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  if (
    current.stage !== 'authoring_required'
    || current.stateRevision !== input.expectedStateRevision
    || current.stateDigest !== input.expectedStateDigest
    || !ID_RE.test(input.code)
    || typeof input.detail !== 'string'
    || input.detail.length < 1
  ) {
    return { ok: false, code: 'authoring_block_invalid', reason: 'The exact authoring request cannot be blocked by these bytes.', projection: current };
  }
  const transitioned = block(current, input.code, input.detail);
  if (!transitioned) return { ok: false, code: 'advancement_cas_lost', reason: 'Another authoring worker changed the exact request first.' };
  return { ok: true, projection: transitioned, created: false };
}

export function blockAutomationPilotWorkspaceDestination(input: {
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  code: string;
  detail: string;
}): RegisterAutomationPilotAdvancementResult {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  if (
    current.stage !== 'workspace_destination_required'
    || current.stateRevision !== input.expectedStateRevision
    || current.stateDigest !== input.expectedStateDigest
    || !ID_RE.test(input.code)
    || typeof input.detail !== 'string'
    || input.detail.length < 1
  ) {
    return { ok: false, code: 'workspace_destination_block_invalid', reason: 'The exact Workspace chooser cannot be blocked by these bytes.', projection: current };
  }
  const transitioned = block(current, input.code, input.detail);
  if (!transitioned) return { ok: false, code: 'advancement_cas_lost', reason: 'Another host changed the Workspace destination first.' };
  return { ok: true, projection: transitioned, created: false };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function authoringResultIssue(input: {
  current: AutomationPilotAdvancementProjectionV1;
  result: AutomationPilotAuthoringResultV1;
}): string | null {
  const { current, result } = input;
  if (
    result.version !== VERSION
    || !current.authoringRequest
    || !current.authoringRequestDigest
    || result.requestId !== current.authoringRequest.requestId
    || result.requestDigest !== current.authoringRequestDigest
    || !plainRecord(result.contract)
    || !plainRecord(result.workflowInputs)
    || Object.values(result.workflowInputs).some((value) => typeof value !== 'string' || value.length === 0)
  ) return 'The authoring result does not match the exact retained request or typed object shape.';
  const proposal = loadAutomationOpportunityProposal(current.proposalId);
  if (!proposal) return 'The exact approved proposal is missing.';
  const target = selectAutomaticReadPilotTarget(proposal.opportunity);
  if (!target.ok) return target.reason;
  const { phase, requirement } = target;
  if (result.contract.phaseId !== phase.id || result.contract.requirementId !== requirement.id) {
    return 'The authoring result names a different phase or requirement.';
  }
  if (proposal.opportunity.dataset) {
    if (!current.workspaceSelection) return 'The dataset authoring result has no exact Workspace selection.';
    if (canonicalJson(result.contract.workspaceBindingSelection) !== canonicalJson(current.workspaceSelection)) {
      return 'The authoring result changed the human-selected Workspace bytes.';
    }
    if (!result.contract.resultProjection) return 'The dataset authoring result omitted its canonical entity projection.';
  } else if (result.contract.workspaceBindingSelection !== undefined || result.contract.resultProjection !== undefined) {
    return 'A dataset-less authoring result cannot add a Workspace or canonical entity projection.';
  }
  try {
    canonicalJson(result);
  } catch (error) {
    return error instanceof Error ? error.message : 'The authoring result is not bounded plain JSON.';
  }
  return null;
}

export function submitAutomationPilotAuthoringResult(input: {
  advancementId: string;
  expectedStateRevision: number;
  expectedStateDigest: string;
  claimId: string;
  result: AutomationPilotAuthoringResultV1;
  nowMs?: number;
}): RegisterAutomationPilotAdvancementResult {
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  let closedResult: AutomationPilotAuthoringResultV1;
  try {
    closedResult = JSON.parse(canonicalJson(input.result)) as AutomationPilotAuthoringResultV1;
  } catch (error) {
    return {
      ok: false,
      code: 'authoring_result_invalid',
      reason: error instanceof Error ? error.message : 'The authoring result is not bounded plain JSON.',
      projection: current,
    };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (
    current.stage !== 'authoring_required'
    || current.stateRevision !== input.expectedStateRevision
    || current.stateDigest !== input.expectedStateDigest
    || !current.authoringClaim
    || current.authoringClaim.claimId !== input.claimId
    || !Number.isSafeInteger(nowMs)
    || nowMs < Date.parse(current.authoringClaim.claimedAt)
    || nowMs > Date.parse(current.authoringClaim.expiresAt)
  ) return { ok: false, code: 'authoring_submission_unclaimed', reason: 'The authoring result does not own the exact active state lease.', projection: current };
  const issue = authoringResultIssue({ current, result: closedResult });
  if (issue) return { ok: false, code: 'authoring_result_invalid', reason: issue, projection: current };
  const result = closedResult;
  const next: AutomationPilotAdvancementStateV1 = {
    ...stateFromProjection(current),
    stage: 'pilot_registering',
    authoringResult: result,
    authoringResultDigest: authoringResultDigest(result),
  };
  const transitioned = transitionState({ current, next, now: new Date(nowMs).toISOString() });
  if (!transitioned) return { ok: false, code: 'advancement_cas_lost', reason: 'Another result advanced the exact authoring request first.' };
  return { ok: true, projection: transitioned, created: false };
}

export const automationPilotAdvancementControlPlaneInternalsForTest = {
  setAfterPilotRegistrationHook(hook?: () => void): void {
    afterPilotRegistrationForTest = hook;
  },
};
