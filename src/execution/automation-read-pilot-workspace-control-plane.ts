/**
 * Human-owned provisioning boundary for an empty canonical-entity Workspace.
 *
 * A chat tool may stage only an exact proposal CAS plus exact local Workspace
 * manifest bytes. The durable reconciler alone consumes the matching formal
 * approval row and creates that manifest. It cannot request/approve a pilot,
 * bind a workflow, queue, run, or schedule anything.
 */
import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  canonicalEntityWorkspaceCreationContractDigest,
  canonicalEntityWorkspaceMatchesCreationContract,
  canonicalEntityWorkspaceSelectionDigest,
  parseCanonicalEntityWorkspaceCreationContract,
  type CanonicalEntityWorkspaceBindingSelectionV1,
  type CanonicalEntityWorkspaceCreationContractV1,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore } from '../spaces/store.js';
import { registerResumableApprovalCardAtomically } from '../runtime/harness/approval-card.js';
import { exactApprovalAuthorityMatches } from '../runtime/harness/approval-authority.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { loadAutomationOpportunityProposal } from './automation-opportunity-store.js';

const VERSION = 1 as const;
const DECISION_TOOL = 'automation_read_pilot_workspace_creation_decision';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 256_000;

export type AutomationReadPilotWorkspaceCreationStatus =
  | 'registering'
  | 'approval_pending'
  | 'creating'
  | 'created'
  | 'refused';

export interface AutomationReadPilotWorkspaceCreationProjectionV1 {
  version: 1;
  projectionId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  approvalSessionId: string;
  sourceUserSeq: number;
  approvalResumeKey: string;
  approvalId?: string;
  creationContractDigest: string;
  workspaceId: string;
  status: AutomationReadPilotWorkspaceCreationStatus;
  selection?: CanonicalEntityWorkspaceBindingSelectionV1;
  refusalCode?: string;
  refusalDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export type RequestAutomationReadPilotWorkspaceCreationResult =
  | {
      ok: true;
      projection: AutomationReadPilotWorkspaceCreationProjectionV1;
      approval: approvalRegistry.PendingApprovalRow;
      approvalCreated: boolean;
      cardCreated: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationReadPilotWorkspaceCreationProjectionV1;
    };

export type ReconcileAutomationReadPilotWorkspaceCreationResult =
  | {
      ok: true;
      state: 'pending' | 'created' | 'already_created' | 'refused';
      projection: AutomationReadPilotWorkspaceCreationProjectionV1;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationReadPilotWorkspaceCreationProjectionV1;
    };

export interface ReconcileAutomationReadPilotWorkspaceCreationsResult {
  scanned: number;
  pending: number;
  created: number;
  alreadyCreated: number;
  refused: number;
  failed: number;
}

interface CreationSqlRow {
  projection_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_digest: string;
  approval_session_id: string;
  source_user_seq: number;
  approval_resume_key: string;
  approval_id: string | null;
  creation_contract_json: string;
  creation_contract_digest: string;
  approval_args_json: string;
  approval_args_digest: string;
  workspace_id: string;
  status: AutomationReadPilotWorkspaceCreationStatus;
  workspace_revision: number | null;
  workspace_digest: string | null;
  refusal_code: string | null;
  refusal_detail: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_read_pilot_workspace_control_plane_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_read_pilot_workspace_creations (
  projection_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  proposal_digest TEXT NOT NULL,
  approval_session_id TEXT NOT NULL,
  source_user_seq INTEGER NOT NULL CHECK (source_user_seq >= 1),
  approval_resume_key TEXT NOT NULL UNIQUE,
  approval_id TEXT UNIQUE,
  creation_contract_json TEXT NOT NULL,
  creation_contract_digest TEXT NOT NULL,
  approval_args_json TEXT NOT NULL,
  approval_args_digest TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'registering','approval_pending','creating','created','refused'
  )),
  workspace_revision INTEGER,
  workspace_digest TEXT,
  refusal_code TEXT,
  refusal_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_read_pilot_workspace_creation_reconcile
  ON automation_read_pilot_workspace_creations(status, updated_at, projection_id);
`;

const COLUMNS = new Set([
  'projection_id', 'proposal_id', 'proposal_revision', 'proposal_digest',
  'approval_session_id', 'source_user_seq', 'approval_resume_key', 'approval_id',
  'creation_contract_json', 'creation_contract_digest', 'approval_args_json',
  'approval_args_digest', 'workspace_id', 'status', 'workspace_revision',
  'workspace_digest', 'refusal_code', 'refusal_detail', 'created_at', 'updated_at',
]);

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 24,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: MAX_BYTES,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function database() {
  const db = openEventLog();
  const migrate = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_read_pilot_workspace_control_plane_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migrate.immediate();
  const versions = db.prepare(`
    SELECT version FROM automation_read_pilot_workspace_control_plane_migrations
    ORDER BY version ASC
  `).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== VERSION) {
    throw new Error('automation read-pilot Workspace control-plane schema version is unknown');
  }
  const columns = new Set((db.prepare(
    'PRAGMA table_info(automation_read_pilot_workspace_creations)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if ([...COLUMNS].some((column) => !columns.has(column))) {
    throw new Error('automation read-pilot Workspace control-plane schema is incomplete');
  }
  return db;
}

function rowToProjection(row: CreationSqlRow): AutomationReadPilotWorkspaceCreationProjectionV1 {
  const selection = row.status === 'created'
    && row.workspace_revision !== null
    && row.workspace_digest !== null
    ? {
        version: 1 as const,
        workspaceId: row.workspace_id,
        expectedWorkspaceRevision: row.workspace_revision,
        expectedWorkspaceDigest: row.workspace_digest,
        bindingId: `binding:${row.proposal_digest.slice(0, 24)}`,
        role: 'primary' as const,
      }
    : undefined;
  return {
    version: 1,
    projectionId: row.projection_id,
    proposalId: row.proposal_id,
    proposalRevision: row.proposal_revision,
    proposalDigest: row.proposal_digest,
    approvalSessionId: row.approval_session_id,
    sourceUserSeq: row.source_user_seq,
    approvalResumeKey: row.approval_resume_key,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    creationContractDigest: row.creation_contract_digest,
    workspaceId: row.workspace_id,
    status: row.status,
    ...(selection ? { selection } : {}),
    ...(row.refusal_code ? { refusalCode: row.refusal_code } : {}),
    ...(row.refusal_detail ? { refusalDetail: row.refusal_detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadRow(projectionId: string): CreationSqlRow | undefined {
  if (!ID_RE.test(projectionId)) return undefined;
  return database().prepare(`
    SELECT * FROM automation_read_pilot_workspace_creations WHERE projection_id = ?
  `).get(projectionId) as CreationSqlRow | undefined;
}

export function loadAutomationReadPilotWorkspaceCreation(
  projectionId: string,
): AutomationReadPilotWorkspaceCreationProjectionV1 | undefined {
  const row = loadRow(projectionId);
  return row ? rowToProjection(row) : undefined;
}

function approvalArgs(input: {
  projectionId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  approvalSessionId: string;
  sourceUserSeq: number;
  contract: CanonicalEntityWorkspaceCreationContractV1;
  contractDigest: string;
}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'automation_read_pilot_workspace_creation',
    projectionId: input.projectionId,
    proposal: {
      proposalId: input.proposalId,
      revision: input.proposalRevision,
      digest: input.proposalDigest,
    },
    acceptedSource: {
      sessionId: input.approvalSessionId,
      sourceUserSeq: input.sourceUserSeq,
    },
    creation: input.contract,
    creationContractDigest: input.contractDigest,
    authority: {
      workspaceMutation: 'create_if_absent_exact',
      workflowBinding: 'none',
      execution: 'none',
      schedule: 'none',
      recurrence: 'none',
    },
  };
}

function decode(row: CreationSqlRow): {
  contract: CanonicalEntityWorkspaceCreationContractV1;
  args: Record<string, unknown>;
} | null {
  try {
    const contract = JSON.parse(row.creation_contract_json) as unknown;
    const args = JSON.parse(row.approval_args_json) as unknown;
    const parsed = parseCanonicalEntityWorkspaceCreationContract(contract);
    if (!parsed.ok
      || !args || typeof args !== 'object' || Array.isArray(args)
      || canonicalJson(parsed.contract) !== row.creation_contract_json
      || canonicalEntityWorkspaceCreationContractDigest(parsed.contract) !== row.creation_contract_digest
      || canonicalJson(args) !== row.approval_args_json
      || sha256(row.approval_args_json) !== row.approval_args_digest) return null;
    return { contract: parsed.contract, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

function exactApproval(row: CreationSqlRow, approval: approvalRegistry.PendingApprovalRow): boolean {
  const payload = decode(row);
  return payload !== null
    && approval.approvalId === row.approval_id
    && exactApprovalAuthorityMatches(approval, {
      approvalId: approval.approvalId,
      sessionId: row.approval_session_id,
      tool: DECISION_TOOL,
      args: payload.args,
      resumeKey: row.approval_resume_key,
    });
}

function linkApproval(
  projectionId: string,
  approval: approvalRegistry.PendingApprovalRow,
): CreationSqlRow | null {
  const db = database();
  const commit = db.transaction((): CreationSqlRow | null => {
    const current = db.prepare(`
      SELECT * FROM automation_read_pilot_workspace_creations WHERE projection_id = ?
    `).get(projectionId) as CreationSqlRow | undefined;
    if (!current) return null;
    if (current.approval_id !== null && current.approval_id !== approval.approvalId) return null;
    const candidate = { ...current, approval_id: approval.approvalId };
    if (!exactApproval(candidate, approval)) return null;
    if (current.status === 'registering') {
      db.prepare(`
        UPDATE automation_read_pilot_workspace_creations
           SET approval_id = ?, status = 'approval_pending', updated_at = ?
         WHERE projection_id = ? AND status = 'registering' AND approval_id IS NULL
      `).run(approval.approvalId, new Date().toISOString(), projectionId);
    }
    return db.prepare(`
      SELECT * FROM automation_read_pilot_workspace_creations WHERE projection_id = ?
    `).get(projectionId) as CreationSqlRow;
  });
  return commit.immediate();
}

function inspectOrCreateApproval(row: CreationSqlRow): {
  approval: approvalRegistry.PendingApprovalRow;
  approvalCreated: boolean;
  cardCreated: boolean;
} | { code: string; reason: string } {
  const payload = decode(row);
  if (!payload) return { code: 'workspace_creation_projection_corrupt', reason: 'The durable creation projection is corrupt.' };
  const inspected = approvalRegistry.inspectResumableApproval(row.approval_resume_key);
  if (inspected.state !== 'none') {
    if (!exactApproval({ ...row, approval_id: inspected.row.approvalId }, inspected.row)) {
      return { code: 'workspace_creation_approval_conflict', reason: 'The resume key names different approval authority.' };
    }
    return { approval: inspected.row, approvalCreated: false, cardCreated: false };
  }
  if (row.approval_id !== null) {
    return { code: 'workspace_creation_approval_missing', reason: 'The linked approval row is missing.' };
  }
  try {
    const card = registerResumableApprovalCardAtomically({
      sessionId: row.approval_session_id,
      subject: `Create exact Workspace ${row.workspace_id} for reviewed dataset pilot`,
      tool: DECISION_TOOL,
      args: payload.args,
      resumeKey: row.approval_resume_key,
      extra: {
        kind: 'automation_read_pilot_workspace_creation',
        projectionId: row.projection_id,
        proposalId: row.proposal_id,
        proposalRevision: row.proposal_revision,
        proposalDigest: row.proposal_digest,
      },
    });
    return {
      approval: card.row,
      approvalCreated: card.approvalCreated,
      cardCreated: card.eventCreated,
    };
  } catch (error) {
    return {
      code: 'workspace_creation_approval_request_failed',
      reason: error instanceof Error ? error.message : 'Workspace creation approval registration failed.',
    };
  }
}

export function requestAutomationReadPilotWorkspaceCreation(input: {
  proposalId: string;
  expectedProposalRevision: number;
  expectedProposalDigest: string;
  approvalSessionId: string;
  sourceUserSeq: number;
  contract: CanonicalEntityWorkspaceCreationContractV1;
}): RequestAutomationReadPilotWorkspaceCreationResult {
  const parsed = parseCanonicalEntityWorkspaceCreationContract(input.contract);
  if (!parsed.ok) return { ok: false, code: 'workspace_creation_contract_invalid', reason: parsed.errors.join(' ') };
  if (!ID_RE.test(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalRevision) || input.expectedProposalRevision < 1
    || !DIGEST_RE.test(input.expectedProposalDigest)
    || !ID_RE.test(input.approvalSessionId)
    || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq < 1
    || parsed.contract.originSessionId !== input.approvalSessionId) {
    return { ok: false, code: 'workspace_creation_request_invalid', reason: 'The exact proposal or accepted-source identity is invalid.' };
  }
  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal
    || proposal.status !== 'approved'
    || proposal.revision !== input.expectedProposalRevision
    || proposal.digest !== input.expectedProposalDigest
    || !proposal.opportunity.dataset) {
    return { ok: false, code: 'workspace_creation_proposal_drift', reason: 'An exact approved dataset proposal is required.' };
  }

  const contractJson = canonicalJson(parsed.contract);
  const contractDigest = canonicalEntityWorkspaceCreationContractDigest(parsed.contract);
  const projectionId = `automation-workspace:${sha256(canonicalJson({
    version: 1,
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    approvalSessionId: input.approvalSessionId,
    sourceUserSeq: input.sourceUserSeq,
    contractDigest,
  }))}`;
  const resumeKey = `automation-workspace:v1:${projectionId}`;
  const args = approvalArgs({
    projectionId,
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    proposalDigest: proposal.digest,
    approvalSessionId: input.approvalSessionId,
    sourceUserSeq: input.sourceUserSeq,
    contract: parsed.contract,
    contractDigest,
  });
  const argsJson = canonicalJson(args);
  const now = new Date().toISOString();
  const db = database();
  const retainedBeforeInsert = loadRow(projectionId);
  if (!retainedBeforeInsert && spaceStore.get(parsed.contract.workspaceId)) {
    return { ok: false, code: 'workspace_creation_target_exists', reason: 'The exact Workspace ID already exists.' };
  }
  db.prepare(`
    INSERT OR IGNORE INTO automation_read_pilot_workspace_creations (
      projection_id, proposal_id, proposal_revision, proposal_digest,
      approval_session_id, source_user_seq, approval_resume_key, approval_id,
      creation_contract_json, creation_contract_digest, approval_args_json,
      approval_args_digest, workspace_id, status, workspace_revision,
      workspace_digest, refusal_code, refusal_detail, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'registering', NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    projectionId,
    proposal.proposalId,
    proposal.revision,
    proposal.digest,
    input.approvalSessionId,
    input.sourceUserSeq,
    resumeKey,
    contractJson,
    contractDigest,
    argsJson,
    sha256(argsJson),
    parsed.contract.workspaceId,
    now,
    now,
  );
  const row = loadRow(projectionId);
  if (!row || row.creation_contract_json !== contractJson || row.approval_args_json !== argsJson) {
    return { ok: false, code: 'workspace_creation_projection_conflict', reason: 'The deterministic projection identity names different bytes.' };
  }
  const existing = spaceStore.get(parsed.contract.workspaceId);
  if (existing && row.status !== 'creating' && row.status !== 'created') {
    const refused = refuse(row, 'workspace_creation_target_exists', 'The exact Workspace ID already exists.');
    return {
      ok: false,
      code: 'workspace_creation_target_exists',
      reason: 'The exact Workspace ID already exists.',
      projection: rowToProjection(refused),
    };
  }
  const requested = inspectOrCreateApproval(row);
  if ('code' in requested) return { ok: false, code: requested.code, reason: requested.reason, projection: rowToProjection(row) };
  const linked = linkApproval(projectionId, requested.approval);
  if (!linked) return { ok: false, code: 'workspace_creation_approval_link_failed', reason: 'The exact approval could not be linked.' };
  return {
    ok: true,
    projection: rowToProjection(linked),
    approval: requested.approval,
    approvalCreated: requested.approvalCreated,
    cardCreated: requested.cardCreated,
  };
}

function refuse(row: CreationSqlRow, code: string, detail: string): CreationSqlRow {
  const db = database();
  db.prepare(`
    UPDATE automation_read_pilot_workspace_creations
       SET status = 'refused', refusal_code = ?, refusal_detail = ?, updated_at = ?
     WHERE projection_id = ? AND status <> 'created'
  `).run(code, detail.slice(0, 8_192), new Date().toISOString(), row.projection_id);
  return db.prepare(`
    SELECT * FROM automation_read_pilot_workspace_creations WHERE projection_id = ?
  `).get(row.projection_id) as CreationSqlRow;
}

let afterWorkspaceSaveHook: (() => void) | undefined;
let beforeWorkspaceCreateHook: (() => void) | undefined;

export const automationReadPilotWorkspaceControlPlaneInternalsForTest = {
  setAfterWorkspaceSaveHook(hook?: () => void): void {
    afterWorkspaceSaveHook = hook;
  },
  setBeforeWorkspaceCreateHook(hook?: () => void): void {
    beforeWorkspaceCreateHook = hook;
  },
};

export function reconcileAutomationReadPilotWorkspaceCreation(
  projectionId: string,
): ReconcileAutomationReadPilotWorkspaceCreationResult {
  let row = loadRow(projectionId);
  if (!row) return { ok: false, code: 'workspace_creation_projection_missing', reason: 'The exact creation projection was not found.' };
  if (row.status === 'created') return { ok: true, state: 'already_created', projection: rowToProjection(row) };
  if (row.status === 'refused') return { ok: true, state: 'refused', projection: rowToProjection(row) };
  const payload = decode(row);
  if (!payload) {
    row = refuse(row, 'workspace_creation_projection_corrupt', 'The durable creation projection is corrupt.');
    return { ok: true, state: 'refused', projection: rowToProjection(row) };
  }
  // Once the exact approval has been claimed and the projection entered
  // `creating`, that immutable human decision owns crash recovery. A later
  // proposal edit cannot strand a manifest already written before process
  // death. Prior to that cut, current proposal CAS remains mandatory.
  if (row.status !== 'creating') {
    const proposal = loadAutomationOpportunityProposal(row.proposal_id);
    if (!proposal
      || proposal.status !== 'approved'
      || proposal.revision !== row.proposal_revision
      || proposal.digest !== row.proposal_digest
      || !proposal.opportunity.dataset) {
      row = refuse(row, 'workspace_creation_proposal_drift', 'The exact approved dataset proposal drifted before creation.');
      return { ok: true, state: 'refused', projection: rowToProjection(row) };
    }
  }
  if (!row.approval_id) {
    const requested = inspectOrCreateApproval(row);
    if ('code' in requested) return { ok: false, code: requested.code, reason: requested.reason, projection: rowToProjection(row) };
    const linked = linkApproval(row.projection_id, requested.approval);
    if (!linked) return { ok: false, code: 'workspace_creation_approval_link_failed', reason: 'The approval link could not be recovered.' };
    row = linked;
  }
  const approval = row.approval_id ? approvalRegistry.get(row.approval_id) : undefined;
  if (!approval || !exactApproval(row, approval)) {
    row = refuse(row, 'workspace_creation_approval_drift', 'The exact formal approval row is missing or contradictory.');
    return { ok: true, state: 'refused', projection: rowToProjection(row) };
  }
  if (approval.status === 'pending') {
    if (approvalRegistry.isExpired(approval)) {
      row = refuse(row, 'workspace_creation_approval_expired', 'The exact Workspace creation approval expired.');
      return { ok: true, state: 'refused', projection: rowToProjection(row) };
    }
    return { ok: true, state: 'pending', projection: rowToProjection(row) };
  }
  const decisionWithinWindow = approvalRegistry.approvalResolutionWithinLifetime(approval);
  if (approval.status !== 'resolved'
    || approval.resolution !== 'approved'
    || !approval.resolver?.trim()
    || !approval.resolvedAt
    || !decisionWithinWindow) {
    const lateApproval = approval.status === 'resolved'
      && approval.resolution === 'approved'
      && !decisionWithinWindow;
    row = refuse(
      row,
      lateApproval
        ? 'workspace_creation_approval_expired'
        : `workspace_creation_approval_${approval.resolution ?? approval.status}`,
      lateApproval
        ? 'The exact Workspace creation approval was resolved outside its validity window.'
        : 'The exact human decision did not approve Workspace creation.',
    );
    return { ok: true, state: 'refused', projection: rowToProjection(row) };
  }
  const claim = approvalRegistry.claimResumableApproval(row.approval_resume_key, approval.approvalId);
  if (claim.state !== 'approved' && claim.state !== 'consumed') {
    return { ok: false, code: 'workspace_creation_approval_claim_failed', reason: 'The exact approved creation row could not be claimed.', projection: rowToProjection(row) };
  }
  if (row.status !== 'creating') {
    database().prepare(`
      UPDATE automation_read_pilot_workspace_creations
         SET status = 'creating', updated_at = ?
       WHERE projection_id = ? AND status = 'approval_pending'
    `).run(new Date().toISOString(), row.projection_id);
    row = loadRow(row.projection_id)!;
    if (row.status !== 'creating') {
      return { ok: false, code: 'workspace_creation_state_conflict', reason: 'The creation projection lost its exact state CAS.', projection: rowToProjection(row) };
    }
  }

  let workspace = spaceStore.get(payload.contract.workspaceId);
  let inserted = false;
  if (!workspace) {
    try {
      beforeWorkspaceCreateHook?.();
      const creation = spaceStore.createIfAbsent({
        id: payload.contract.workspaceId,
        title: payload.contract.title,
        status: 'active',
        contract: {
          objective: payload.contract.objective,
          successCriteria: [...payload.contract.successCriteria],
          invariants: [...payload.contract.invariants],
        },
        viewEntry: 'view/index.html',
        dataSources: [],
        actions: [],
        originSessionId: payload.contract.originSessionId,
        focusId: null,
      });
      workspace = creation.record;
      inserted = creation.created;
    } catch (error) {
      return {
        ok: false,
        code: 'workspace_creation_store_failed',
        reason: error instanceof Error ? error.message : 'The exact Workspace could not be created.',
        projection: rowToProjection(row),
      };
    }
  }
  if (inserted) afterWorkspaceSaveHook?.();
  if (!workspace || !canonicalEntityWorkspaceMatchesCreationContract(workspace, payload.contract)) {
    row = refuse(row, 'workspace_creation_target_drift', 'The Workspace target contradicts the exact human-reviewed creation bytes.');
    return { ok: true, state: 'refused', projection: rowToProjection(row) };
  }
  const workspaceDigest = canonicalEntityWorkspaceSelectionDigest(workspace);
  const commit = database().prepare(`
    UPDATE automation_read_pilot_workspace_creations
       SET status = 'created', workspace_revision = ?, workspace_digest = ?, updated_at = ?
     WHERE projection_id = ? AND status = 'creating'
  `).run(workspace.version, workspaceDigest, new Date().toISOString(), row.projection_id);
  row = loadRow(row.projection_id)!;
  if (commit.changes !== 1 && row.status !== 'created') {
    return { ok: false, code: 'workspace_creation_commit_failed', reason: 'The exact created Workspace could not be committed.', projection: rowToProjection(row) };
  }
  return { ok: true, state: 'created', projection: rowToProjection(row) };
}

export function reconcileAutomationReadPilotWorkspaceCreations(input: {
  approvalId?: string;
  limit?: number;
} = {}): ReconcileAutomationReadPilotWorkspaceCreationsResult {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Workspace creation reconcile limit must be from 1 through 1000');
  }
  const rows = input.approvalId
    ? database().prepare(`
        SELECT projection_id FROM automation_read_pilot_workspace_creations
         WHERE approval_id = ? AND status IN ('registering','approval_pending','creating')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(input.approvalId, limit) as Array<{ projection_id: string }>
    : database().prepare(`
        SELECT projection_id FROM automation_read_pilot_workspace_creations
         WHERE status IN ('registering','approval_pending','creating')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(limit) as Array<{ projection_id: string }>;
  const result: ReconcileAutomationReadPilotWorkspaceCreationsResult = {
    scanned: 0,
    pending: 0,
    created: 0,
    alreadyCreated: 0,
    refused: 0,
    failed: 0,
  };
  for (const row of rows) {
    result.scanned += 1;
    try {
      const reconciled = reconcileAutomationReadPilotWorkspaceCreation(row.projection_id);
      if (!reconciled.ok) result.failed += 1;
      else if (reconciled.state === 'pending') result.pending += 1;
      else if (reconciled.state === 'created') result.created += 1;
      else if (reconciled.state === 'already_created') result.alreadyCreated += 1;
      else result.refused += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

let listenerInstalled = false;

export function installAutomationReadPilotWorkspaceControlPlaneReconciler(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  approvalRegistry.onApprovalResolved((row) => {
    if (row.tool !== DECISION_TOOL || !row.resumeKey?.startsWith('automation-workspace:v1:')) return;
    reconcileAutomationReadPilotWorkspaceCreations({ approvalId: row.approvalId, limit: 16 });
  });
}
