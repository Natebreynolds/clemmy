/**
 * Durable, user-owned review boundary for AutomationOpportunity proposals.
 *
 * The chat tool represented here may stage only an exact proposal CAS and a
 * formal approval card. The card becomes visible before a proposed record is
 * advanced to reviewed. Only the exact resolved approval row may then advance
 * that reviewed record to approved or rejected. The projection closes crash
 * gaps between the separate opportunity database and eventlog database; it
 * never compiles, queues, runs, schedules, or creates another entity.
 */
import { createHash } from 'node:crypto';

import {
  listAutomationOpportunityProposalRevisions,
  loadAutomationOpportunityProposal,
  transitionAutomationOpportunityProposal,
  type AutomationOpportunityProposalRecordV1,
  type AutomationOpportunityProposalRevisionV1,
} from './automation-opportunity-store.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  registerResumableApprovalCardAtomically,
  type AtomicResumableApprovalCardResult,
} from '../runtime/harness/approval-card.js';
import { exactApprovalAuthorityMatches } from '../runtime/harness/approval-authority.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { getSession, openEventLog } from '../runtime/harness/eventlog.js';

const CONTROL_PLANE_VERSION = 1 as const;
const DECISION_TOOL = 'automation_opportunity_review_decision';
const RESUME_KEY_PREFIX = 'automation-opportunity-review:v1:';
const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const MAX_PROJECTION_BYTES = 512_000;

export interface RegisterAutomationOpportunityReviewProjectionInputV1 {
  proposalId: string;
  expectedProposalRevision: number;
  expectedProposalDigest: string;
  approvalSessionId: string;
  requestSourceUserSeq: number;
}

export type AutomationOpportunityReviewProjectionStatus =
  | 'registering'
  | 'card_visible'
  | 'reviewed'
  | 'approved'
  | 'rejected'
  | 'refused';

export interface AutomationOpportunityReviewProjectionV1 {
  version: typeof CONTROL_PLANE_VERSION;
  projectionId: string;
  proposalId: string;
  proposalRevisionAtRequest: number;
  proposalDigest: string;
  proposalStatusAtRequest: 'proposed' | 'reviewed';
  reviewedRevision: number;
  ownerSessionId: string;
  requestSourceUserSeq: number;
  approvalSessionId: string;
  approvalResumeKey: string;
  approvalArgsDigest: string;
  approvalId?: string;
  status: AutomationOpportunityReviewProjectionStatus;
  refusalCode?: string;
  refusalDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export type RegisterAutomationOpportunityReviewProjectionResult =
  | {
      ok: true;
      projection: AutomationOpportunityReviewProjectionV1;
      proposal: AutomationOpportunityProposalRecordV1;
      approval: approvalRegistry.PendingApprovalRow;
      projectionCreated: boolean;
      approvalCreated: boolean;
      cardCreated: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationOpportunityReviewProjectionV1;
      proposal?: AutomationOpportunityProposalRecordV1;
    };

export type ReconcileAutomationOpportunityReviewProjectionResult =
  | {
      ok: true;
      state: 'pending' | 'approved' | 'already_approved' | 'rejected' | 'already_rejected' | 'refused';
      projection: AutomationOpportunityReviewProjectionV1;
      proposal: AutomationOpportunityProposalRecordV1;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationOpportunityReviewProjectionV1;
      proposal?: AutomationOpportunityProposalRecordV1;
    };

export interface ReconcileAutomationOpportunityReviewProjectionsResult {
  scanned: number;
  pending: number;
  approved: number;
  alreadyApproved: number;
  rejected: number;
  alreadyRejected: number;
  refused: number;
  failed: number;
}

interface ProjectionSqlRow {
  projection_id: string;
  proposal_id: string;
  proposal_revision_at_request: number;
  proposal_digest: string;
  proposal_status_at_request: 'proposed' | 'reviewed';
  reviewed_revision: number;
  owner_session_id: string;
  request_source_user_seq: number;
  approval_session_id: string;
  approval_resume_key: string;
  approval_subject: string;
  approval_args_json: string;
  approval_args_digest: string;
  approval_id: string | null;
  status: AutomationOpportunityReviewProjectionStatus;
  refusal_code: string | null;
  refusal_detail: string | null;
  created_at: string;
  updated_at: string;
}

interface PreparedProjection {
  projectionId: string;
  proposal: AutomationOpportunityProposalRecordV1;
  proposalStatusAtRequest: 'proposed' | 'reviewed';
  reviewedRevision: number;
  ownerSessionId: string;
  approvalResumeKey: string;
  approvalSubject: string;
  approvalArgs: Record<string, unknown>;
  approvalArgsJson: string;
  approvalArgsDigest: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_opportunity_review_control_plane_migrations (
  version    INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_opportunity_review_projections (
  projection_id                 TEXT PRIMARY KEY,
  proposal_id                   TEXT NOT NULL,
  proposal_revision_at_request  INTEGER NOT NULL CHECK (proposal_revision_at_request >= 1),
  proposal_digest               TEXT NOT NULL,
  proposal_status_at_request    TEXT NOT NULL CHECK (proposal_status_at_request IN ('proposed','reviewed')),
  reviewed_revision             INTEGER NOT NULL CHECK (reviewed_revision >= 1),
  owner_session_id              TEXT NOT NULL,
  request_source_user_seq       INTEGER NOT NULL CHECK (request_source_user_seq >= 1),
  approval_session_id           TEXT NOT NULL,
  approval_resume_key           TEXT NOT NULL UNIQUE,
  approval_subject              TEXT NOT NULL,
  approval_args_json            TEXT NOT NULL,
  approval_args_digest          TEXT NOT NULL,
  approval_id                   TEXT UNIQUE,
  status                        TEXT NOT NULL CHECK (status IN (
    'registering','card_visible','reviewed','approved','rejected','refused'
  )),
  refusal_code                  TEXT,
  refusal_detail                TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_opportunity_review_one_active
  ON automation_opportunity_review_projections(proposal_id, reviewed_revision, proposal_digest)
  WHERE status IN ('registering','card_visible','reviewed');

CREATE INDEX IF NOT EXISTS automation_opportunity_review_reconcile
  ON automation_opportunity_review_projections(status, updated_at, projection_id);
`;

const REQUIRED_COLUMNS = new Set([
  'projection_id',
  'proposal_id',
  'proposal_revision_at_request',
  'proposal_digest',
  'proposal_status_at_request',
  'reviewed_revision',
  'owner_session_id',
  'request_source_user_seq',
  'approval_session_id',
  'approval_resume_key',
  'approval_subject',
  'approval_args_json',
  'approval_args_digest',
  'approval_id',
  'status',
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
    maxDepth: 24,
    maxNodes: 20_000,
    maxStringBytes: 64_000,
    maxTotalBytes: MAX_PROJECTION_BYTES,
  });
}

function exactId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && EXACT_ID_RE.test(value);
}

function database() {
  const db = openEventLog();
  const migrate = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_opportunity_review_control_plane_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migrate.immediate();
  const versions = db.prepare(
    'SELECT version FROM automation_opportunity_review_control_plane_migrations ORDER BY version ASC',
  ).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== CONTROL_PLANE_VERSION) {
    throw new Error('automation opportunity review control-plane schema version is unknown');
  }
  const columns = new Set((db.prepare(
    'PRAGMA table_info(automation_opportunity_review_projections)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if ([...REQUIRED_COLUMNS].some((column) => !columns.has(column))) {
    throw new Error('automation opportunity review control-plane schema is incomplete');
  }
  return db;
}

function rowToProjection(row: ProjectionSqlRow): AutomationOpportunityReviewProjectionV1 {
  return {
    version: CONTROL_PLANE_VERSION,
    projectionId: row.projection_id,
    proposalId: row.proposal_id,
    proposalRevisionAtRequest: row.proposal_revision_at_request,
    proposalDigest: row.proposal_digest,
    proposalStatusAtRequest: row.proposal_status_at_request,
    reviewedRevision: row.reviewed_revision,
    ownerSessionId: row.owner_session_id,
    requestSourceUserSeq: row.request_source_user_seq,
    approvalSessionId: row.approval_session_id,
    approvalResumeKey: row.approval_resume_key,
    approvalArgsDigest: row.approval_args_digest,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    status: row.status,
    ...(row.refusal_code ? { refusalCode: row.refusal_code } : {}),
    ...(row.refusal_detail ? { refusalDetail: row.refusal_detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadProjectionRow(projectionId: string): ProjectionSqlRow | undefined {
  if (!exactId(projectionId)) return undefined;
  return database().prepare(
    'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
  ).get(projectionId) as ProjectionSqlRow | undefined;
}

export function loadAutomationOpportunityReviewProjection(
  projectionId: string,
): AutomationOpportunityReviewProjectionV1 | undefined {
  const row = loadProjectionRow(projectionId);
  return row ? rowToProjection(row) : undefined;
}

export function listAutomationOpportunityReviewProjections(input: {
  status?: AutomationOpportunityReviewProjectionStatus;
  approvalId?: string;
  limit?: number;
} = {}): AutomationOpportunityReviewProjectionV1[] {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('review projection list limit must be from 1 through 1000');
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
  const rows = database().prepare(`
    SELECT * FROM automation_opportunity_review_projections ${where}
     ORDER BY updated_at ASC, projection_id ASC LIMIT ?
  `).all(...values, limit) as ProjectionSqlRow[];
  return rows.map(rowToProjection);
}

function sourceOwnerRevision(
  proposalId: string,
  sessionId: string,
): AutomationOpportunityProposalRevisionV1 | null {
  const first = listAutomationOpportunityProposalRevisions(proposalId)[0];
  if (!first || first.revision !== 1 || first.status !== 'proposed') return null;
  const prefix = `accepted-source:${sessionId}#`;
  if (!first.actorRef.startsWith(prefix)) return null;
  const sequence = first.actorRef.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(sequence) || !Number.isSafeInteger(Number(sequence))) return null;
  return first;
}

function projectionIdentity(input: RegisterAutomationOpportunityReviewProjectionInputV1): string {
  return `opportunity-review:${sha256(canonicalJson({
    domain: 'automation-opportunity-review-projection',
    version: CONTROL_PLANE_VERSION,
    proposalId: input.proposalId,
    proposalRevision: input.expectedProposalRevision,
    proposalDigest: input.expectedProposalDigest,
    approvalSessionId: input.approvalSessionId,
    requestSourceUserSeq: input.requestSourceUserSeq,
  }))}`;
}

function prepareProjection(
  input: RegisterAutomationOpportunityReviewProjectionInputV1,
): PreparedProjection | { code: string; reason: string; projectionId?: string } {
  try {
    canonicalJson(input);
  } catch (error) {
    return {
      code: 'review_request_invalid',
      reason: error instanceof Error ? error.message : 'Review request is not bounded plain JSON.',
    };
  }
  if (
    !exactId(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalRevision)
    || input.expectedProposalRevision < 1
    || !SHA256_RE.test(input.expectedProposalDigest)
    || !exactId(input.approvalSessionId)
    || !Number.isSafeInteger(input.requestSourceUserSeq)
    || input.requestSourceUserSeq < 1
  ) return { code: 'review_request_invalid', reason: 'Review request identity or proposal CAS is malformed.' };

  const projectionId = projectionIdentity(input);
  const replay = loadProjectionRow(projectionId);
  if (replay) {
    const proposal = loadAutomationOpportunityProposal(replay.proposal_id);
    if (!proposal) return { code: 'proposal_missing', reason: 'The exact automation proposal was not found.', projectionId };
    let approvalArgs: Record<string, unknown>;
    try {
      approvalArgs = JSON.parse(replay.approval_args_json) as Record<string, unknown>;
      if (
        canonicalJson(approvalArgs) !== replay.approval_args_json
        || sha256(replay.approval_args_json) !== replay.approval_args_digest
      ) throw new Error('stored review approval arguments failed their digest');
    } catch (error) {
      return {
        code: 'review_projection_integrity_failure',
        reason: error instanceof Error ? error.message : 'Stored review approval arguments are invalid.',
        projectionId,
      };
    }
    return {
      projectionId,
      proposal,
      proposalStatusAtRequest: replay.proposal_status_at_request,
      reviewedRevision: replay.reviewed_revision,
      ownerSessionId: replay.owner_session_id,
      approvalResumeKey: replay.approval_resume_key,
      approvalSubject: replay.approval_subject,
      approvalArgs,
      approvalArgsJson: replay.approval_args_json,
      approvalArgsDigest: replay.approval_args_digest,
    };
  }

  const session = getSession(input.approvalSessionId);
  if (!session || session.kind !== 'chat') {
    return { code: 'approval_session_invalid', reason: 'Proposal review requires an existing human chat session.' };
  }
  const proposal = loadAutomationOpportunityProposal(input.proposalId);
  if (!proposal) return { code: 'proposal_missing', reason: 'The exact automation proposal was not found.' };
  if (
    proposal.revision !== input.expectedProposalRevision
    || proposal.digest !== input.expectedProposalDigest
  ) return { code: 'proposal_stale', reason: 'The proposal revision or digest is stale.' };
  if (proposal.status !== 'proposed' && proposal.status !== 'reviewed') {
    return { code: 'proposal_terminal', reason: `The proposal is already ${proposal.status}.` };
  }
  const owner = sourceOwnerRevision(proposal.proposalId, input.approvalSessionId);
  if (!owner) {
    return {
      code: 'proposal_owner_mismatch',
      reason: 'The proposal is not owned by the exact accepted source chat requesting review.',
    };
  }
  const requiredMissing = proposal.opportunity.missingInputs.filter((missing) => missing.required);
  if (requiredMissing.length > 0) {
    return {
      code: 'proposal_missing_inputs',
      reason: `Required proposal inputs remain unresolved: ${requiredMissing.map((item) => item.id).join(', ')}.`,
    };
  }
  const reviewedRevision = proposal.status === 'proposed'
    ? proposal.revision + 1
    : proposal.revision;
  const approvalArgs = {
    controlVersion: CONTROL_PLANE_VERSION,
    kind: 'automation_opportunity_review_decision',
    projectionId,
    proposalId: proposal.proposalId,
    proposalRevisionAtRequest: proposal.revision,
    proposalStatusAtRequest: proposal.status,
    reviewedRevision,
    proposalDigest: proposal.digest,
  };
  const approvalArgsJson = canonicalJson(approvalArgs);
  const approvalResumeKey = `${RESUME_KEY_PREFIX}${sha256(approvalArgsJson)}`;
  const approvalSubject = `Approve exact automation opportunity: ${proposal.opportunity.title}`.slice(0, 1_024);
  return {
    projectionId,
    proposal,
    proposalStatusAtRequest: proposal.status,
    reviewedRevision,
    ownerSessionId: input.approvalSessionId,
    approvalResumeKey,
    approvalSubject,
    approvalArgs,
    approvalArgsJson,
    approvalArgsDigest: sha256(approvalArgsJson),
  };
}

function insertProjectionIntent(input: {
  prepared: PreparedProjection;
  request: RegisterAutomationOpportunityReviewProjectionInputV1;
}): { row: ProjectionSqlRow; created: boolean } | { code: string; reason: string } {
  const db = database();
  const now = new Date().toISOString();
  let changes = 0;
  try {
    changes = db.prepare(`
      INSERT OR IGNORE INTO automation_opportunity_review_projections (
        projection_id, proposal_id, proposal_revision_at_request, proposal_digest,
        proposal_status_at_request, reviewed_revision, owner_session_id,
        request_source_user_seq, approval_session_id, approval_resume_key,
        approval_subject, approval_args_json, approval_args_digest,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registering', ?, ?)
    `).run(
      input.prepared.projectionId,
      input.prepared.proposal.proposalId,
      input.request.expectedProposalRevision,
      input.request.expectedProposalDigest,
      input.prepared.proposalStatusAtRequest,
      input.prepared.reviewedRevision,
      input.prepared.ownerSessionId,
      input.request.requestSourceUserSeq,
      input.request.approvalSessionId,
      input.prepared.approvalResumeKey,
      input.prepared.approvalSubject,
      input.prepared.approvalArgsJson,
      input.prepared.approvalArgsDigest,
      now,
      now,
    ).changes;
  } catch (error) {
    return {
      code: 'review_projection_store_failed',
      reason: error instanceof Error ? error.message : 'Review projection intent could not be stored.',
    };
  }
  let row = db.prepare(
    'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
  ).get(input.prepared.projectionId) as ProjectionSqlRow | undefined;
  if (!row) {
    row = db.prepare(`
      SELECT * FROM automation_opportunity_review_projections
       WHERE proposal_id = ? AND reviewed_revision = ? AND proposal_digest = ?
         AND status IN ('registering','card_visible','reviewed')
       ORDER BY created_at ASC, projection_id ASC LIMIT 1
    `).get(
      input.prepared.proposal.proposalId,
      input.prepared.reviewedRevision,
      input.prepared.proposal.digest,
    ) as ProjectionSqlRow | undefined;
  }
  if (!row) return { code: 'review_projection_store_failed', reason: 'Review projection intent disappeared after insertion.' };
  if (
    row.proposal_id !== input.prepared.proposal.proposalId
    || row.proposal_digest !== input.prepared.proposal.digest
    || row.reviewed_revision !== input.prepared.reviewedRevision
    || row.owner_session_id !== input.prepared.ownerSessionId
    || row.approval_session_id !== input.request.approvalSessionId
  ) return {
    code: 'review_projection_conflict',
    reason: 'The exact proposal CAS already has a different active review projection.',
  };
  return { row, created: changes === 1 };
}

function decodeApprovalArgs(row: ProjectionSqlRow): Record<string, unknown> | null {
  try {
    const args = JSON.parse(row.approval_args_json) as Record<string, unknown>;
    if (
      canonicalJson(args) !== row.approval_args_json
      || sha256(row.approval_args_json) !== row.approval_args_digest
    ) return null;
    return args;
  } catch {
    return null;
  }
}

function approvalMatchesProjection(
  row: ProjectionSqlRow,
  approval: approvalRegistry.PendingApprovalRow,
  args: Record<string, unknown>,
): boolean {
  return approval.approvalId === row.approval_id
    && approval.sessionId === row.approval_session_id
    && exactApprovalAuthorityMatches(approval, {
      approvalId: row.approval_id ?? '',
      sessionId: row.approval_session_id,
      tool: DECISION_TOOL,
      args,
      resumeKey: row.approval_resume_key,
    });
}

function inspectOrCreateApproval(
  row: ProjectionSqlRow,
  args: Record<string, unknown>,
): { approval: approvalRegistry.PendingApprovalRow; approvalCreated: boolean; cardCreated: boolean } | {
  code: string;
  reason: string;
} {
  const inspected = approvalRegistry.inspectResumableApproval(row.approval_resume_key);
  if (inspected.state !== 'none') {
    const candidate = inspected.row;
    if (!exactApprovalAuthorityMatches(candidate, {
      approvalId: candidate.approvalId,
      sessionId: row.approval_session_id,
      tool: DECISION_TOOL,
      args,
      resumeKey: row.approval_resume_key,
    })) return {
      code: 'review_approval_conflict',
      reason: 'The durable review resume key names different approval authority.',
    };
    return { approval: candidate, approvalCreated: false, cardCreated: false };
  }
  if (row.approval_id !== null) {
    return {
      code: 'review_approval_missing',
      reason: 'The projection-linked formal approval row is missing; a sibling card cannot replace it.',
    };
  }
  let card: AtomicResumableApprovalCardResult;
  try {
    card = registerResumableApprovalCardAtomically({
      sessionId: row.approval_session_id,
      subject: row.approval_subject,
      tool: DECISION_TOOL,
      args,
      resumeKey: row.approval_resume_key,
      extra: {
        kind: 'automation_opportunity_review',
        projectionId: row.projection_id,
        proposalId: row.proposal_id,
        proposalRevision: row.reviewed_revision,
        proposalDigest: row.proposal_digest,
      },
    });
  } catch (error) {
    return {
      code: 'review_approval_request_failed',
      reason: error instanceof Error ? error.message : 'Formal proposal review approval registration failed.',
    };
  }
  return {
    approval: card.row,
    approvalCreated: card.approvalCreated,
    cardCreated: card.eventCreated,
  };
}

function terminalApprovalRegistrationFailure(code: string): boolean {
  return code === 'review_approval_conflict' || code === 'review_approval_missing';
}

function linkApproval(
  projectionId: string,
  approval: approvalRegistry.PendingApprovalRow,
): ProjectionSqlRow | null {
  const db = database();
  const transaction = db.transaction((): ProjectionSqlRow | null => {
    const current = db.prepare(
      'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
    ).get(projectionId) as ProjectionSqlRow | undefined;
    if (!current) return null;
    if (current.status === 'approved' || current.status === 'rejected' || current.status === 'refused') {
      return current.approval_id === approval.approvalId ? current : null;
    }
    const args = decodeApprovalArgs(current);
    if (
      !args
      || current.approval_resume_key !== approval.resumeKey
      || (current.approval_id !== null && current.approval_id !== approval.approvalId)
      || !exactApprovalAuthorityMatches(approval, {
        approvalId: approval.approvalId,
        sessionId: current.approval_session_id,
        tool: DECISION_TOOL,
        args,
        resumeKey: current.approval_resume_key,
      })
    ) return null;
    db.prepare(`
      UPDATE automation_opportunity_review_projections
         SET approval_id = ?,
             status = CASE WHEN status = 'registering' THEN 'card_visible' ELSE status END,
             updated_at = ?
       WHERE projection_id = ?
         AND status IN ('registering','card_visible','reviewed')
         AND (approval_id IS NULL OR approval_id = ?)
    `).run(approval.approvalId, new Date().toISOString(), projectionId, approval.approvalId);
    return db.prepare(
      'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
    ).get(projectionId) as ProjectionSqlRow;
  });
  return transaction.immediate();
}

function reviewActorRef(row: ProjectionSqlRow, approval: approvalRegistry.PendingApprovalRow): string {
  return `automation-review:${sha256(canonicalJson({
    domain: 'automation-opportunity-review-transition',
    version: CONTROL_PLANE_VERSION,
    projectionId: row.projection_id,
    approvalId: approval.approvalId,
    approvalSessionId: approval.sessionId,
    requestSourceUserSeq: row.request_source_user_seq,
  }))}`;
}

function decisionActorRef(row: ProjectionSqlRow, approval: approvalRegistry.PendingApprovalRow): string | null {
  const requestedAt = Date.parse(approval.requestedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  const resolvedAt = approval.resolvedAt ? Date.parse(approval.resolvedAt) : Number.NaN;
  if (
    approval.status !== 'resolved'
    || (approval.resolution !== 'approved' && approval.resolution !== 'rejected')
    || typeof approval.resolver !== 'string'
    || approval.resolver.trim().length === 0
    || typeof approval.resolvedAt !== 'string'
    || approval.resolvedAt.length === 0
    || !Number.isFinite(requestedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(resolvedAt)
    || resolvedAt < requestedAt
    || resolvedAt > expiresAt
  ) return null;
  return `automation-decision:${sha256(canonicalJson({
    domain: 'automation-opportunity-human-decision',
    version: CONTROL_PLANE_VERSION,
    projectionId: row.projection_id,
    approvalId: approval.approvalId,
    approvalSessionId: approval.sessionId,
    resolution: approval.resolution,
    resolver: approval.resolver,
    resolvedAt: approval.resolvedAt,
  }))}`;
}

function revisionAt(
  proposalId: string,
  revision: number,
): AutomationOpportunityProposalRevisionV1 | undefined {
  return listAutomationOpportunityProposalRevisions(proposalId)
    .find((candidate) => candidate.revision === revision);
}

function exactReviewRevision(
  row: ProjectionSqlRow,
  approval: approvalRegistry.PendingApprovalRow,
): boolean {
  const revision = revisionAt(row.proposal_id, row.reviewed_revision);
  return Boolean(
    revision
    && revision.status === 'reviewed'
    && revision.digest === row.proposal_digest
    && (row.proposal_status_at_request === 'reviewed'
      || revision.actorRef === reviewActorRef(row, approval)),
  );
}

function exactDecisionRevision(
  row: ProjectionSqlRow,
  approval: approvalRegistry.PendingApprovalRow,
  status: 'approved' | 'rejected',
): boolean {
  const actorRef = decisionActorRef(row, approval);
  if (!actorRef) return false;
  const revision = revisionAt(row.proposal_id, row.reviewed_revision + 1);
  return Boolean(
    revision
    && revision.status === status
    && revision.digest === row.proposal_digest
    && revision.actorRef === actorRef,
  );
}

function updateProjectionStatus(
  row: ProjectionSqlRow,
  status: 'reviewed' | 'approved' | 'rejected',
): ProjectionSqlRow {
  const db = database();
  db.prepare(`
    UPDATE automation_opportunity_review_projections
       SET status = ?, refusal_code = NULL, refusal_detail = NULL, updated_at = ?
     WHERE projection_id = ? AND status NOT IN ('approved','rejected','refused')
  `).run(status, new Date().toISOString(), row.projection_id);
  return db.prepare(
    'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
  ).get(row.projection_id) as ProjectionSqlRow;
}

function markRefused(
  row: ProjectionSqlRow,
  code: string,
  detail: string,
): ProjectionSqlRow {
  const db = database();
  db.prepare(`
    UPDATE automation_opportunity_review_projections
       SET status = 'refused', refusal_code = ?, refusal_detail = ?, updated_at = ?
     WHERE projection_id = ? AND status NOT IN ('approved','rejected')
  `).run(code, detail.slice(0, 8_192), new Date().toISOString(), row.projection_id);
  return db.prepare(
    'SELECT * FROM automation_opportunity_review_projections WHERE projection_id = ?',
  ).get(row.projection_id) as ProjectionSqlRow;
}

let afterIntentForTest: (() => void) | undefined;
let afterCardVisibleForTest: (() => void) | undefined;
let afterReviewTransitionForTest: (() => void) | undefined;
let afterDecisionClaimForTest: (() => void) | undefined;
let afterDecisionTransitionForTest: (() => void) | undefined;

export const automationOpportunityReviewControlPlaneInternalsForTest = {
  setAfterIntentHook(hook?: () => void): void {
    afterIntentForTest = hook;
  },
  setAfterCardVisibleHook(hook?: () => void): void {
    afterCardVisibleForTest = hook;
  },
  setAfterReviewTransitionHook(hook?: () => void): void {
    afterReviewTransitionForTest = hook;
  },
  setAfterDecisionClaimHook(hook?: () => void): void {
    afterDecisionClaimForTest = hook;
  },
  setAfterDecisionTransitionHook(hook?: () => void): void {
    afterDecisionTransitionForTest = hook;
  },
};

function reconcileReviewTransition(
  row: ProjectionSqlRow,
  approval: approvalRegistry.PendingApprovalRow,
): { ok: true; row: ProjectionSqlRow; proposal: AutomationOpportunityProposalRecordV1 } | {
  ok: false;
  code: string;
  reason: string;
  terminal: boolean;
  proposal?: AutomationOpportunityProposalRecordV1;
} {
  let proposal = loadAutomationOpportunityProposal(row.proposal_id);
  if (!proposal) return { ok: false, code: 'proposal_missing', reason: 'The exact proposal is missing.', terminal: true };

  if (
    (proposal.status === 'approved' || proposal.status === 'rejected')
    && proposal.revision === row.reviewed_revision + 1
    && proposal.digest === row.proposal_digest
    && exactDecisionRevision(row, approval, proposal.status)
  ) {
    return { ok: true, row: updateProjectionStatus(row, 'reviewed'), proposal };
  }

  if (
    proposal.status === 'reviewed'
    && proposal.revision === row.reviewed_revision
    && proposal.digest === row.proposal_digest
    && exactReviewRevision(row, approval)
  ) {
    return { ok: true, row: updateProjectionStatus(row, 'reviewed'), proposal };
  }

  if (
    row.proposal_status_at_request !== 'proposed'
    || proposal.status !== 'proposed'
    || proposal.revision !== row.proposal_revision_at_request
    || proposal.digest !== row.proposal_digest
  ) return {
    ok: false,
    code: 'proposal_stale',
    reason: 'The proposal changed before this exact review transition could be established.',
    terminal: true,
    proposal,
  };

  const transitioned = transitionAutomationOpportunityProposal({
    proposalId: row.proposal_id,
    to: 'reviewed',
    expectedRevision: row.proposal_revision_at_request,
    expectedDigest: row.proposal_digest,
    actorRef: reviewActorRef(row, approval),
    note: 'Formal review card became durably visible.',
  });
  if (transitioned.ok) {
    afterReviewTransitionForTest?.();
    proposal = transitioned.record;
  } else {
    proposal = loadAutomationOpportunityProposal(row.proposal_id);
  }
  if (
    !proposal
    || proposal.status !== 'reviewed'
    || proposal.revision !== row.reviewed_revision
    || proposal.digest !== row.proposal_digest
    || !exactReviewRevision(row, approval)
  ) return {
    ok: false,
    code: transitioned.ok ? 'review_transition_integrity_failure' : `review_transition_${transitioned.code}`,
    reason: transitioned.ok
      ? 'The reviewed proposal did not round-trip its exact transition lineage.'
      : transitioned.message,
    terminal: true,
    ...(proposal ? { proposal } : {}),
  };
  return { ok: true, row: updateProjectionStatus(row, 'reviewed'), proposal };
}

function reconcileDecision(
  row: ProjectionSqlRow,
  approval: approvalRegistry.PendingApprovalRow,
  proposal: AutomationOpportunityProposalRecordV1,
): ReconcileAutomationOpportunityReviewProjectionResult {
  if (approval.status === 'pending') {
    if (approvalRegistry.isExpired(approval)) {
      const refused = markRefused(row, 'review_approval_expired', 'The formal proposal decision expired.');
      return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal };
    }
    return { ok: true, state: 'pending', projection: rowToProjection(row), proposal };
  }
  if (
    approval.status === 'expired'
    || approval.status === 'cancelled'
    || approval.resolution === 'expired'
    || approval.resolution === 'cancelled_by_user'
    || approval.resolution === 'cancelled_by_system'
  ) {
    const refused = markRefused(
      row,
      approval.resolution === 'cancelled_by_user' || approval.resolution === 'cancelled_by_system'
        ? 'review_approval_cancelled'
        : 'review_approval_expired',
      'The formal proposal decision expired or was cancelled without granting approval authority.',
    );
    return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal };
  }
  if (
    approval.status !== 'resolved'
    || (approval.resolution !== 'approved' && approval.resolution !== 'rejected')
    || !decisionActorRef(row, approval)
  ) {
    const resolvedAfterExpiry = approval.resolvedAt !== null
      && Number.isFinite(Date.parse(approval.resolvedAt))
      && Number.isFinite(Date.parse(approval.expiresAt))
      && Date.parse(approval.resolvedAt) > Date.parse(approval.expiresAt);
    const refused = markRefused(
      row,
      resolvedAfterExpiry ? 'review_approval_expired' : 'review_approval_invalid',
      resolvedAfterExpiry
        ? 'The formal proposal decision resolved after its exact expiry boundary.'
        : 'The formal proposal decision row is incomplete.',
    );
    return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal };
  }

  const target = approval.resolution;
  if (
    proposal.status === target
    && proposal.revision === row.reviewed_revision + 1
    && proposal.digest === row.proposal_digest
    && exactDecisionRevision(row, approval, target)
  ) {
    const projected = updateProjectionStatus(row, target);
    return {
      ok: true,
      state: target === 'approved' ? 'approved' : 'rejected',
      projection: rowToProjection(projected),
      proposal,
    };
  }
  if (
    proposal.status !== 'reviewed'
    || proposal.revision !== row.reviewed_revision
    || proposal.digest !== row.proposal_digest
    || !exactReviewRevision(row, approval)
  ) {
    const refused = markRefused(row, 'proposal_stale', 'The reviewed proposal changed before the human decision could be committed.');
    return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal };
  }

  if (target === 'approved') {
    const claimed = approvalRegistry.claimResumableApproval(
      row.approval_resume_key,
      approval.approvalId,
    );
    if (claimed.state !== 'approved' && claimed.state !== 'consumed') {
      const refused = markRefused(row, 'review_approval_unclaimable', 'The exact human approval could not be claimed.');
      return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal };
    }
    afterDecisionClaimForTest?.();
  }
  const actorRef = decisionActorRef(row, approval)!;
  const transitioned = transitionAutomationOpportunityProposal({
    proposalId: row.proposal_id,
    to: target,
    expectedRevision: row.reviewed_revision,
    expectedDigest: row.proposal_digest,
    actorRef,
    note: target === 'approved'
      ? 'Exact formal human approval resolved.'
      : 'Exact formal human rejection resolved.',
  });
  if (transitioned.ok) afterDecisionTransitionForTest?.();
  const current = transitioned.ok
    ? transitioned.record
    : loadAutomationOpportunityProposal(row.proposal_id);
  if (
    !current
    || current.status !== target
    || current.revision !== row.reviewed_revision + 1
    || current.digest !== row.proposal_digest
    || !exactDecisionRevision(row, approval, target)
  ) {
    const refused = markRefused(
      row,
      transitioned.ok ? 'decision_transition_integrity_failure' : `decision_transition_${transitioned.code}`,
      transitioned.ok
        ? 'The proposal decision did not round-trip its exact human resolver lineage.'
        : transitioned.message,
    );
    return {
      ok: true,
      state: 'refused',
      projection: rowToProjection(refused),
      proposal: current ?? proposal,
    };
  }
  const projected = updateProjectionStatus(row, target);
  return {
    ok: true,
    state: target,
    projection: rowToProjection(projected),
    proposal: current,
  };
}

export function reconcileAutomationOpportunityReviewProjection(
  projectionId: string,
): ReconcileAutomationOpportunityReviewProjectionResult {
  let row = loadProjectionRow(projectionId);
  if (!row) return { ok: false, code: 'review_projection_missing', reason: 'The proposal review projection was not found.' };
  const current = loadAutomationOpportunityProposal(row.proposal_id);
  if (!current) {
    return { ok: false, code: 'proposal_missing', reason: 'The exact automation proposal was not found.', projection: rowToProjection(row) };
  }
  if (row.status === 'approved') {
    return { ok: true, state: 'already_approved', projection: rowToProjection(row), proposal: current };
  }
  if (row.status === 'rejected') {
    return { ok: true, state: 'already_rejected', projection: rowToProjection(row), proposal: current };
  }
  if (row.status === 'refused') {
    return { ok: true, state: 'refused', projection: rowToProjection(row), proposal: current };
  }
  const args = decodeApprovalArgs(row);
  if (!args) {
    const refused = markRefused(row, 'review_projection_integrity_failure', 'Stored approval arguments or digest are invalid.');
    return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal: current };
  }
  const registered = inspectOrCreateApproval(row, args);
  if ('code' in registered) {
    if (terminalApprovalRegistrationFailure(registered.code)) {
      const refused = markRefused(row, registered.code, registered.reason);
      return {
        ok: true,
        state: 'refused',
        projection: rowToProjection(refused),
        proposal: current,
      };
    }
    return { ok: false, ...registered, projection: rowToProjection(row), proposal: current };
  }
  const linked = linkApproval(row.projection_id, registered.approval);
  if (!linked) {
    return {
      ok: false,
      code: 'review_approval_link_failed',
      reason: 'The exact formal approval row could not be linked to the durable review projection.',
      projection: rowToProjection(row),
      proposal: current,
    };
  }
  row = linked;
  if (!row.approval_id || !approvalMatchesProjection(row, registered.approval, args)) {
    const refused = markRefused(row, 'review_approval_drift', 'The formal approval row names different review authority.');
    return { ok: true, state: 'refused', projection: rowToProjection(refused), proposal: current };
  }
  const reviewed = reconcileReviewTransition(row, registered.approval);
  if (!reviewed.ok) {
    if (!reviewed.terminal) {
      return {
        ok: false,
        code: reviewed.code,
        reason: reviewed.reason,
        projection: rowToProjection(row),
        ...(reviewed.proposal ? { proposal: reviewed.proposal } : {}),
      };
    }
    const refused = markRefused(row, reviewed.code, reviewed.reason);
    return {
      ok: true,
      state: 'refused',
      projection: rowToProjection(refused),
      proposal: reviewed.proposal ?? current,
    };
  }
  return reconcileDecision(reviewed.row, registered.approval, reviewed.proposal);
}

export function registerAutomationOpportunityReviewProjection(
  input: RegisterAutomationOpportunityReviewProjectionInputV1,
): RegisterAutomationOpportunityReviewProjectionResult {
  const prepared = prepareProjection(input);
  if ('code' in prepared) {
    return {
      ok: false,
      code: prepared.code,
      reason: prepared.reason,
      ...(prepared.projectionId
        ? { projection: loadAutomationOpportunityReviewProjection(prepared.projectionId) }
        : {}),
    };
  }
  const inserted = insertProjectionIntent({ prepared, request: input });
  if ('code' in inserted) return { ok: false, ...inserted };
  if (inserted.created) afterIntentForTest?.();
  let row = inserted.row;
  if (row.status === 'refused') {
    return {
      ok: false,
      code: row.refusal_code ?? 'review_projection_refused',
      reason: row.refusal_detail ?? 'The proposal review projection is terminally refused.',
      projection: rowToProjection(row),
      proposal: loadAutomationOpportunityProposal(row.proposal_id),
    };
  }
  const args = decodeApprovalArgs(row);
  if (!args) {
    return {
      ok: false,
      code: 'review_projection_integrity_failure',
      reason: 'Stored approval arguments or digest are invalid.',
      projection: rowToProjection(row),
      proposal: prepared.proposal,
    };
  }
  const registered = inspectOrCreateApproval(row, args);
  if ('code' in registered) {
    const projected = terminalApprovalRegistrationFailure(registered.code)
      ? markRefused(row, registered.code, registered.reason)
      : row;
    return { ok: false, ...registered, projection: rowToProjection(projected), proposal: prepared.proposal };
  }
  afterCardVisibleForTest?.();
  const linked = linkApproval(row.projection_id, registered.approval);
  if (!linked) {
    return {
      ok: false,
      code: 'review_approval_link_failed',
      reason: 'The exact formal approval row could not be linked to the durable review projection.',
      projection: rowToProjection(row),
      proposal: prepared.proposal,
    };
  }
  row = linked;
  const reconciled = reconcileAutomationOpportunityReviewProjection(row.projection_id);
  if (!reconciled.ok) return reconciled;
  const finalApproval = approvalRegistry.get(registered.approval.approvalId);
  if (!finalApproval) {
    return {
      ok: false,
      code: 'review_approval_missing',
      reason: 'The exact formal approval row disappeared after reconciliation.',
      projection: reconciled.projection,
      proposal: reconciled.proposal,
    };
  }
  if (reconciled.state === 'refused') {
    return {
      ok: false,
      code: reconciled.projection.refusalCode ?? 'review_projection_refused',
      reason: reconciled.projection.refusalDetail ?? 'The proposal review projection is terminally refused.',
      projection: reconciled.projection,
      proposal: reconciled.proposal,
    };
  }
  return {
    ok: true,
    projection: reconciled.projection,
    proposal: reconciled.proposal,
    approval: finalApproval,
    projectionCreated: inserted.created,
    approvalCreated: registered.approvalCreated,
    cardCreated: registered.cardCreated,
  };
}

export function reconcileAutomationOpportunityReviewProjections(input: {
  approvalId?: string;
  limit?: number;
} = {}): ReconcileAutomationOpportunityReviewProjectionsResult {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('review projection reconcile limit must be from 1 through 1000');
  }
  const rows = input.approvalId
    ? database().prepare(`
        SELECT * FROM automation_opportunity_review_projections
         WHERE approval_id = ? AND status IN ('registering','card_visible','reviewed')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(input.approvalId, limit) as ProjectionSqlRow[]
    : database().prepare(`
        SELECT * FROM automation_opportunity_review_projections
         WHERE status IN ('registering','card_visible','reviewed')
         ORDER BY updated_at ASC, projection_id ASC LIMIT ?
      `).all(limit) as ProjectionSqlRow[];
  const result: ReconcileAutomationOpportunityReviewProjectionsResult = {
    scanned: 0,
    pending: 0,
    approved: 0,
    alreadyApproved: 0,
    rejected: 0,
    alreadyRejected: 0,
    refused: 0,
    failed: 0,
  };
  for (const row of rows) {
    result.scanned += 1;
    try {
      const reconciled = reconcileAutomationOpportunityReviewProjection(row.projection_id);
      if (!reconciled.ok) result.failed += 1;
      else if (reconciled.state === 'pending') result.pending += 1;
      else if (reconciled.state === 'approved') result.approved += 1;
      else if (reconciled.state === 'already_approved') result.alreadyApproved += 1;
      else if (reconciled.state === 'rejected') result.rejected += 1;
      else if (reconciled.state === 'already_rejected') result.alreadyRejected += 1;
      else result.refused += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

let listenerInstalled = false;

/** Best-effort live kick; boot/timer scans close every lost-response window. */
export function installAutomationOpportunityReviewControlPlaneReconciler(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  approvalRegistry.onApprovalResolved((row) => {
    if (row.tool !== DECISION_TOOL || !row.resumeKey?.startsWith(RESUME_KEY_PREFIX)) return;
    reconcileAutomationOpportunityReviewProjections({ approvalId: row.approvalId, limit: 16 });
  });
}
