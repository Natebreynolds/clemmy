/**
 * Atomic persistence kernel for one logical tool-call settlement.
 *
 * This module deliberately does not classify results or mutate recovery
 * policy.  It receives the provider-neutral kernel's typed verdict, validates
 * it against an already-admitted durable logical call, freezes the exact paid
 * crossings visible in the same IMMEDIATE transaction, writes one mirror
 * event plus normalized authority, and closes the logical call by CAS.
 */
import { createHash } from 'node:crypto';
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import type { AttemptOutcome, RecoveryDirective } from './attempt-outcome.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { normalizeCallableArguments } from './callable-contract.js';
import { isTrustedComposioGateway } from './runtime-tool-identity.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import {
  expectedTaskFor,
  recordResolvedOperationInTransaction,
} from './resolution-ledger.js';
import {
  recordDiscoveryEvidenceInTransaction,
  type DiscoveryEvidenceKind,
  type DiscoveryEvidenceOutcome,
} from './discovery-governor.js';
import {
  persistAuthoritativeResultHandleInTransaction,
  ResultHandleAuthorityError,
} from './result-handle.js';
import { recordWriteEvidenceSettlementOutcomeInTransaction } from './write-evidence-lifecycle.js';

export const LOGICAL_CALL_SETTLEMENT_PROTOCOL_VERSION = 1 as const;

export type LogicalCallExecutionKind =
  | 'refused_pre_dispatch'
  | 'local_execution'
  | 'provider_execution';

export type LogicalCallSettlementLane =
  | 'agents_runner'
  | 'native_mcp'
  | 'claude_sdk'
  | 'composio'
  | 'code_mode'
  | 'byo';

export interface CommitLogicalCallSettlementInput {
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
  };
  contract: { toolName: string; args?: unknown };
  execution: { kind: LogicalCallExecutionKind };
  /** Exact returned bytes. Required for a successful provider crossing. */
  result?: {
    payload: unknown;
    /** Stable initial arguments when this result participates in host pagination. */
    baseArgs?: unknown;
    continuationChainId?: string;
  };
  outcome: Pick<AttemptOutcome, 'kind' | 'evidence' | 'providerStatus' | 'detail' | 'directive'>;
  recovery: {
    businessCall: boolean;
    mutating: boolean;
    requirementId?: string;
    continuesRequirement?: boolean;
    /**
     * Value-opaque identity for a successful unit of progress.  The store
     * persists only its task-salted digest and atomically grants it once.
     */
    progressIdentity?: string;
    /** Runtime evidence to apply in the SAME transaction as settlement. */
    governorEvidence?: {
      kind: DiscoveryEvidenceKind;
      detail?: string;
      /** Successful progress moves the governor only when its progress key won. */
      onlyIfProgressClaimed?: boolean;
    };
  };
  observer: {
    lane: LogicalCallSettlementLane;
    callId?: string;
    turn?: number;
  };
}

export interface FrozenSettlementCrossing {
  physicalDispatchId: string;
  ordinal: number;
  relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
  retryOf?: string;
  toolName: string;
  argumentDigest: string;
}

export interface DurableLogicalCallSettlement {
  protocolVersion: 1;
  identity: CommitLogicalCallSettlementInput['identity'];
  toolName: string;
  argumentDigest: string;
  semanticDigest: string;
  executionKind: LogicalCallExecutionKind;
  outcome: CommitLogicalCallSettlementInput['outcome'];
  recovery: CommitLogicalCallSettlementInput['recovery'] & {
    progressKeyDigest?: string;
    progressClaimed: boolean;
    governorEvidenceKind?: DiscoveryEvidenceKind;
    governorOutcome?: DiscoveryEvidenceOutcome;
    openedDiscoveryEpoch: boolean;
    creditedProgress: boolean;
  };
  observer: CommitLogicalCallSettlementInput['observer'];
  /** Crossings that LEFT the machine. */
  physicalCrossingCount: number;
  /** Crossings the host made into its own process. */
  hostCrossingCount: number;
  physicalCrossingsDigest: string;
  crossings: FrozenSettlementCrossing[];
  resultHandleId?: string;
  settlementEventId: string;
  settledAt: string;
}

export type LogicalCallSettlementResult =
  | { status: 'committed'; settlement: DurableLogicalCallSettlement }
  | { status: 'replayed'; settlement: DurableLogicalCallSettlement }
  | { status: 'closed' | 'missing'; reason: string }
  | { status: 'conflict'; reason: string; poisoned: true }
  | { status: 'storage_error'; reason: string };

interface LogicalAuthorityRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  /** The call's own admission digest, immutable across refinement. */
  raw_argument_digest: string;
  state: 'open' | 'settled' | 'conflict';
  settlement_event_id: string | null;
  outcome_kind: string | null;
  resolution_state: 'open' | 'finalized' | 'legacy_ambiguous';
  resolution_accepted_task_id: string;
}

interface CrossingRow {
  accepted_task_id: string;
  physical_dispatch_id: string;
  ordinal: number;
  relation: FrozenSettlementCrossing['relation'];
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';
  /** 'host' when the crossing never left the process; NULL when it did. */
  execution_site: string | null;
}

type FrozenCrossingSource = Pick<
  CrossingRow,
  'physical_dispatch_id' | 'ordinal' | 'relation' | 'retry_of' | 'tool_name' | 'argument_digest'
>;

interface SettlementRow {
  accepted_task_id: string;
  tool_name: string;
  argument_digest: string;
  protocol_version: number;
  semantic_digest: string;
  execution_kind: LogicalCallExecutionKind;
  outcome_kind: AttemptOutcome['kind'];
  outcome_evidence: AttemptOutcome['evidence'];
  provider_status: string | null;
  outcome_detail: string | null;
  business_call: number;
  mutating: number;
  requirement_id: string | null;
  continues_requirement: number;
  recovery_action: RecoveryDirective['action'];
  retry_same_candidate: number;
  eliminates_candidate: number;
  discovery_epoch_requested: number;
  requires_reconciliation: number;
  progress_key_digest: string | null;
  progress_claimed: number;
  governor_evidence_kind: DiscoveryEvidenceKind | null;
  governor_evidence_detail: string | null;
  governor_requires_progress: number;
  governor_outcome: DiscoveryEvidenceOutcome | null;
  opened_discovery_epoch: number;
  credited_progress: number;
  physical_crossing_count: number;
  host_crossing_count: number | null;
  physical_crossings_digest: string;
  observer_lane: LogicalCallSettlementLane;
  observer_call_id: string | null;
  settlement_event_id: string;
  settled_at: string;
  result_handle_id: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180);
}

function normalizedDetail(detail: string | undefined): string | undefined {
  const bounded = detail?.replace(/\s+/g, ' ').trim().slice(0, 160);
  return bounded || undefined;
}

function normalizedProviderStatus(status: number | string | undefined): string | undefined {
  if (status === undefined) return undefined;
  const bounded = String(status).replace(/\s+/g, ' ').trim().slice(0, 64);
  return bounded || undefined;
}

function frozenCrossings(rows: FrozenCrossingSource[]): FrozenSettlementCrossing[] {
  return rows.map((row) => ({
    physicalDispatchId: row.physical_dispatch_id,
    ordinal: row.ordinal,
    relation: row.relation,
    ...(row.retry_of ? { retryOf: row.retry_of } : {}),
    toolName: row.tool_name,
    argumentDigest: row.argument_digest,
  }));
}

function crossingDigest(crossings: FrozenSettlementCrossing[]): string {
  return sha256(JSON.stringify(crossings.map((crossing) => ({
    physicalDispatchId: crossing.physicalDispatchId,
    ordinal: crossing.ordinal,
    relation: crossing.relation,
    retryOf: crossing.retryOf ?? null,
    toolName: crossing.toolName,
    argumentDigest: crossing.argumentDigest,
  }))));
}

function progressKeyDigest(acceptedTaskId: string, identity: string | undefined): string | undefined {
  if (identity === undefined) return undefined;
  return sha256(`${acceptedTaskId}\0${identity}`);
}

function semanticDigest(input: {
  toolName: string;
  argumentDigest: string;
  executionKind: LogicalCallExecutionKind;
  outcome: CommitLogicalCallSettlementInput['outcome'];
  recovery: CommitLogicalCallSettlementInput['recovery'];
  progressDigest?: string;
  resultHandleId?: string;
}): string {
  return sha256(JSON.stringify({
    protocolVersion: LOGICAL_CALL_SETTLEMENT_PROTOCOL_VERSION,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
    executionKind: input.executionKind,
    resultHandleId: input.resultHandleId ?? null,
    outcome: {
      kind: input.outcome.kind,
      evidence: input.outcome.evidence,
      providerStatus: normalizedProviderStatus(input.outcome.providerStatus) ?? null,
      detail: normalizedDetail(input.outcome.detail) ?? null,
      directive: {
        action: input.outcome.directive.action,
        retrySameCandidate: input.outcome.directive.retrySameCandidate,
        eliminatesCandidate: input.outcome.directive.eliminatesCandidate,
        opensDiscoveryEpoch: input.outcome.directive.opensDiscoveryEpoch,
        requiresReconciliation: input.outcome.directive.requiresReconciliation,
      },
    },
    recovery: {
      businessCall: input.recovery.businessCall,
      mutating: input.recovery.mutating,
      requirementId: input.recovery.requirementId ?? null,
      continuesRequirement: input.recovery.continuesRequirement === true,
      progressKeyDigest: input.progressDigest ?? null,
      governorEvidence: input.recovery.governorEvidence
        ? {
            kind: input.recovery.governorEvidence.kind,
            detail: input.recovery.governorEvidence.detail?.replace(/\s+/g, ' ').trim().slice(0, 256) || null,
            onlyIfProgressClaimed: input.recovery.governorEvidence.onlyIfProgressClaimed === true,
          }
        : null,
    },
  }));
}

function poison(
  db: ReturnType<typeof openEventLog>,
  identity: CommitLogicalCallSettlementInput['identity'],
  reason: string,
): void {
  // Record the FIRST cause and never overwrite it. Everything downstream sees
  // only 'conflict' — including this store's own retry, which then reports the
  // poisoned state rather than the check that failed — so a conflict with no
  // recorded reason is undiagnosable after the fact.
  db.prepare(`
    UPDATE logical_tool_calls
       SET state = 'conflict',
           conflict_reason = COALESCE(conflict_reason, ?)
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).run(
    reason.replace(/\s+/g, ' ').trim().slice(0, 240),
    identity.sessionId,
    identity.sourceUserSeq,
    identity.logicalToolCallId,
  );
  db.prepare(`
    UPDATE accepted_task_resolutions
       SET state = 'legacy_ambiguous', revision = revision + 1
     WHERE session_id = ? AND source_user_seq = ? AND state != 'legacy_ambiguous'
  `).run(identity.sessionId, identity.sourceUserSeq);
}

function conflict(
  db: ReturnType<typeof openEventLog>,
  identity: CommitLogicalCallSettlementInput['identity'],
  reason: string,
): LogicalCallSettlementResult {
  poison(db, identity, reason);
  return { status: 'conflict', reason, poisoned: true };
}

function readCrossings(
  db: ReturnType<typeof openEventLog>,
  identity: CommitLogicalCallSettlementInput['identity'],
): CrossingRow[] {
  return db.prepare(`
    SELECT accepted_task_id, physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest, state, execution_site
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(
    identity.sessionId,
    identity.sourceUserSeq,
    identity.logicalToolCallId,
  ) as CrossingRow[];
}

function readDurableSettlement(
  db: ReturnType<typeof openEventLog>,
  identity: CommitLogicalCallSettlementInput['identity'],
): DurableLogicalCallSettlement | null {
  const row = db.prepare(`
    SELECT s.*, l.accepted_task_id, l.tool_name, l.argument_digest
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?
  `).get(
    identity.sessionId,
    identity.sourceUserSeq,
    identity.logicalToolCallId,
  ) as SettlementRow | undefined;
  if (!row) return null;
  const crossings = db.prepare(`
    SELECT physical_dispatch_id, ordinal, relation, retry_of, tool_name, argument_digest
      FROM logical_call_settlement_crossings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(
    identity.sessionId,
    identity.sourceUserSeq,
    identity.logicalToolCallId,
  ) as Array<Omit<CrossingRow, 'accepted_task_id' | 'state'>>;
  const directive: RecoveryDirective = {
    action: row.recovery_action,
    retrySameCandidate: row.retry_same_candidate === 1,
    eliminatesCandidate: row.eliminates_candidate === 1,
    opensDiscoveryEpoch: row.discovery_epoch_requested === 1,
    requiresReconciliation: row.requires_reconciliation === 1,
  };
  return {
    protocolVersion: 1,
    identity: {
      ...identity,
      acceptedTaskId: row.accepted_task_id,
    },
    toolName: row.tool_name,
    argumentDigest: row.argument_digest,
    semanticDigest: row.semantic_digest,
    executionKind: row.execution_kind,
    outcome: {
      kind: row.outcome_kind,
      evidence: row.outcome_evidence,
      ...(row.provider_status !== null ? { providerStatus: row.provider_status } : {}),
      ...(row.outcome_detail !== null ? { detail: row.outcome_detail } : {}),
      directive,
    },
    recovery: {
      businessCall: row.business_call === 1,
      mutating: row.mutating === 1,
      ...(row.requirement_id !== null ? { requirementId: row.requirement_id } : {}),
      ...(row.continues_requirement === 1 ? { continuesRequirement: true } : {}),
      ...(row.progress_key_digest !== null ? { progressKeyDigest: row.progress_key_digest } : {}),
      progressClaimed: row.progress_claimed === 1,
      ...(row.governor_evidence_kind !== null
        ? {
            governorEvidence: {
              kind: row.governor_evidence_kind,
              ...(row.governor_evidence_detail !== null
                ? { detail: row.governor_evidence_detail }
                : {}),
              ...(row.governor_requires_progress === 1
                ? { onlyIfProgressClaimed: true }
                : {}),
            },
            governorEvidenceKind: row.governor_evidence_kind,
          }
        : {}),
      ...(row.governor_outcome !== null ? { governorOutcome: row.governor_outcome } : {}),
      openedDiscoveryEpoch: row.opened_discovery_epoch === 1,
      creditedProgress: row.credited_progress === 1,
    },
    observer: {
      lane: row.observer_lane,
      ...(row.observer_call_id !== null ? { callId: row.observer_call_id } : {}),
    },
    physicalCrossingCount: row.physical_crossing_count,
    hostCrossingCount: row.host_crossing_count ?? 0,
    physicalCrossingsDigest: row.physical_crossings_digest,
    crossings: frozenCrossings(crossings.map((crossing) => ({
      ...crossing,
      accepted_task_id: row.accepted_task_id,
    }))),
    ...(row.result_handle_id !== null ? { resultHandleId: row.result_handle_id } : {}),
    settlementEventId: row.settlement_event_id,
    settledAt: row.settled_at,
  };
}

export type DurableLogicalCallSettlementRedemption =
  | { status: 'ok'; settlement: DurableLogicalCallSettlement }
  | { status: 'missing' | 'corrupt' | 'storage_error'; reason: string };

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Rehydrate one settlement as host authority, recomputing rather than trusting
 * its stored semantic digest. The immutable-row trigger is the normal-write
 * guard; this redemption remains independently fail-closed if that trigger is
 * dropped and normalized bytes are changed behind the API.
 */
export function redeemDurableLogicalCallSettlementForHost(
  identity: CommitLogicalCallSettlementInput['identity'],
): DurableLogicalCallSettlementRedemption {
  if (
    !identity.sessionId.trim()
    || !Number.isSafeInteger(identity.sourceUserSeq)
    || identity.sourceUserSeq <= 0
    || !identity.acceptedTaskId.trim()
    || !identity.logicalToolCallId.trim()
  ) return { status: 'missing', reason: 'exact accepted logical-call identity is required' };

  try {
    const db = openEventLog();
    const settlement = readDurableSettlement(db, identity);
    if (!settlement) return { status: 'missing', reason: 'durable logical settlement is missing' };
    const parent = db.prepare(`
      SELECT accepted_task_id, tool_name, argument_digest, state,
             settlement_event_id, outcome_kind
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.logicalToolCallId,
    ) as {
      accepted_task_id: string;
      tool_name: string;
      argument_digest: string;
      state: string;
      settlement_event_id: string | null;
      outcome_kind: string | null;
    } | undefined;
    if (
      !parent
      || settlement.identity.acceptedTaskId !== identity.acceptedTaskId
      || parent.accepted_task_id !== identity.acceptedTaskId
      || parent.tool_name !== settlement.toolName
      || parent.argument_digest !== settlement.argumentDigest
      || parent.state !== 'settled'
      || parent.settlement_event_id !== settlement.settlementEventId
      || parent.outcome_kind !== settlement.outcome.kind
    ) return { status: 'corrupt', reason: 'logical parent and settlement authority disagree' };

    const recomputedSemantic = semanticDigest({
      toolName: settlement.toolName,
      argumentDigest: settlement.argumentDigest,
      executionKind: settlement.executionKind,
      outcome: settlement.outcome,
      recovery: {
        businessCall: settlement.recovery.businessCall,
        mutating: settlement.recovery.mutating,
        ...(settlement.recovery.requirementId
          ? { requirementId: settlement.recovery.requirementId }
          : {}),
        ...(settlement.recovery.continuesRequirement ? { continuesRequirement: true } : {}),
        ...(settlement.recovery.governorEvidence
          ? { governorEvidence: settlement.recovery.governorEvidence }
          : {}),
      },
      ...(settlement.recovery.progressKeyDigest
        ? { progressDigest: settlement.recovery.progressKeyDigest }
        : {}),
      ...(settlement.resultHandleId ? { resultHandleId: settlement.resultHandleId } : {}),
    });
    if (recomputedSemantic !== settlement.semanticDigest) {
      return { status: 'corrupt', reason: 'logical settlement semantic digest does not recompute' };
    }
    if (
      settlement.crossings.length
        !== settlement.physicalCrossingCount + settlement.hostCrossingCount
      || crossingDigest(settlement.crossings) !== settlement.physicalCrossingsDigest
    ) return { status: 'corrupt', reason: 'logical settlement crossing digest does not recompute' };

    const mirrorRow = db.prepare(`
      SELECT session_id, role, type, data_json FROM events WHERE id = ?
    `).get(settlement.settlementEventId) as {
      session_id: string;
      role: string;
      type: string;
      data_json: string;
    } | undefined;
    let mirror: Record<string, unknown> | null = null;
    try {
      mirror = mirrorRow ? plainRecord(JSON.parse(mirrorRow.data_json) as unknown) : null;
    } catch {
      mirror = null;
    }
    const mirrorDispatchIds = Array.isArray(mirror?.physicalDispatchIds)
      ? mirror.physicalDispatchIds
      : null;
    const exactMirror = mirrorRow?.session_id === identity.sessionId
      && mirrorRow.role === 'system'
      && mirrorRow.type === 'tool_attempt_settled'
      && mirror?.protocolVersion === LOGICAL_CALL_SETTLEMENT_PROTOCOL_VERSION
      && mirror.sourceUserSeq === identity.sourceUserSeq
      && mirror.acceptedTaskId === identity.acceptedTaskId
      && mirror.logicalToolCallId === identity.logicalToolCallId
      && mirror.tool === settlement.toolName
      && mirror.argumentDigest === settlement.argumentDigest
      && mirror.semanticDigest === settlement.semanticDigest
      && mirror.executionKind === settlement.executionKind
      && mirror.kind === settlement.outcome.kind
      && mirror.evidence === settlement.outcome.evidence
      && mirror.action === settlement.outcome.directive.action
      && mirror.businessCall === settlement.recovery.businessCall
      && mirror.mutating === settlement.recovery.mutating
      && (mirror.requirementId ?? null) === (settlement.recovery.requirementId ?? null)
      && mirror.physicalDispatchCount === settlement.physicalCrossingCount
      && mirror.physicalCrossingsDigest === settlement.physicalCrossingsDigest
      && JSON.stringify(mirrorDispatchIds) === JSON.stringify(
        settlement.crossings.map((crossing) => crossing.physicalDispatchId),
      )
      && (mirror.resultHandleId ?? null) === (settlement.resultHandleId ?? null)
      && (mirror.progressKeyDigest ?? null) === (settlement.recovery.progressKeyDigest ?? null)
      && (mirror.progressClaimed ?? false) === settlement.recovery.progressClaimed;
    if (!exactMirror) {
      return { status: 'corrupt', reason: 'logical settlement does not match its immutable event mirror' };
    }
    return { status: 'ok', settlement };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Commit or exactly replay one logical settlement.
 *
 * `committed` is the only result that creates authority. `replayed` returns
 * the byte-equivalent persisted verdict. Every other status is fail-closed and
 * distinguishable; storage failure is never reported as a duplicate.
 */
export function commitLogicalCallSettlement(
  input: CommitLogicalCallSettlementInput,
): LogicalCallSettlementResult {
  const { identity } = input;
  if (
    !identity.sessionId.trim()
    || !Number.isSafeInteger(identity.sourceUserSeq)
    || identity.sourceUserSeq <= 0
    || !identity.acceptedTaskId.trim()
    || !identity.logicalToolCallId.trim()
  ) {
    return { status: 'missing', reason: 'logical settlement identity is incomplete' };
  }
  let mirror: EventRow | null = null;
  let operationMirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): LogicalCallSettlementResult => {
      const logical = db.prepare(`
        SELECT l.accepted_task_id, l.logical_tool_call_id, l.tool_name,
               l.argument_digest, l.raw_argument_digest, l.state,
               l.settlement_event_id, l.outcome_kind,
               r.state AS resolution_state,
               r.accepted_task_id AS resolution_accepted_task_id
          FROM logical_tool_calls l
          JOIN accepted_task_resolutions r
            ON r.session_id = l.session_id
           AND r.source_user_seq = l.source_user_seq
         WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
      `).get(
        identity.sessionId,
        identity.sourceUserSeq,
        identity.logicalToolCallId,
      ) as LogicalAuthorityRow | undefined;
      if (!logical) return { status: 'missing', reason: 'admitted logical call is missing' };
      const workBinding = db.prepare(`
        SELECT requirement_id, universe_item_id
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        identity.sessionId,
        identity.sourceUserSeq,
        identity.logicalToolCallId,
      ) as { requirement_id: string; universe_item_id: string | null } | undefined;
      if (
        workBinding
        && input.recovery.requirementId
        && input.recovery.requirementId !== workBinding.requirement_id
      ) {
        return conflict(db, identity, 'settlement requirement conflicts with immutable work binding');
      }
      const recovery: CommitLogicalCallSettlementInput['recovery'] = {
        ...input.recovery,
        ...(workBinding ? {
          businessCall: true,
          requirementId: workBinding.requirement_id,
        } : {}),
      };
      if (recovery.requirementId && recovery.requirementId.length > 256) {
        return conflict(db, identity, 'requirement identity exceeds its durable bound');
      }
      const contract = durableLogicalCallContract(
        identity.acceptedTaskId,
        input.contract.toolName,
        input.contract.args,
      );
      if (!contract) return conflict(db, identity, 'logical call contract is unsafe');
      const progressDigest = progressKeyDigest(identity.acceptedTaskId, recovery.progressIdentity);
      if (
        logical.accepted_task_id !== identity.acceptedTaskId
        || logical.resolution_accepted_task_id !== identity.acceptedTaskId
      ) {
        return conflict(db, identity, 'logical call belongs to a different accepted task');
      }
      // A refinement REWRITES argument_digest from the call's raw admission
      // args to its provider-ready ones. Both digests describe the SAME call,
      // so a lane settling under the pre-refinement identity is not presenting
      // a different contract — and raw_argument_digest is immutable, so
      // accepting it cannot admit a foreign one. The dispatch ledger already
      // accepts either (logicalMatches, phase 'logical'); this seam accepted
      // only the refined digest, so a refined call whose INNER dispatch failed
      // was poisoned by its own outer wrapper settling it — killing the turn
      // and the scheduled workflow behind it (live 2026-08-11, platform-49
      // 23:00Z: composio_search_tools refined, inner ok:false, outer settled).
      if (
        logical.tool_name !== contract.toolName
        || (logical.argument_digest !== contract.argumentDigest
          && logical.raw_argument_digest !== contract.argumentDigest)
      ) {
        return conflict(db, identity, 'logical call contract conflicts with its admission');
      }
      // Either immutable identity may present the settlement, but the durable
      // verdict has one canonical contract: the current logical row (effective
      // after refinement, raw otherwise). Readers join this row back into the
      // settlement, crossings use it, and result authority redeems against it.
      // Canonicalizing here keeps commit, replay, mirror and handles coherent.
      const canonicalToolName = logical.tool_name;
      const canonicalArgumentDigest = logical.argument_digest;

      const crossingRows = readCrossings(db, identity);
      if (crossingRows.some((crossing) =>
        crossing.accepted_task_id !== identity.acceptedTaskId
        || crossing.tool_name !== logical.tool_name
        || crossing.argument_digest !== logical.argument_digest
      )) {
        return conflict(db, identity, 'a paid crossing conflicts with its logical parent');
      }
      if (crossingRows.some((crossing) => crossing.state === 'started')) {
        return { status: 'closed', reason: 'a paid crossing is still in flight' };
      }
      const crossings = frozenCrossings(crossingRows);
      const crossingsDigest = crossingDigest(crossings);
      // Every crossing is frozen and bound to this settlement, but only the
      // ones that LEFT the machine are counted as provider traffic: the
      // settlement's crossing count is what paid-work readers and this table's
      // own CHECK have always meant by it.
      const hostCrossingCount = crossingRows
        .filter((crossing) => crossing.execution_site === 'host').length;
      const crossingCount = crossings.length - hostCrossingCount;

      // A local execution may now carry the host's own crossing — but only
      // that. A crossing that LEFT the machine still makes this a provider
      // execution, and a pre-dispatch refusal still executed nothing at all.
      const executionConsistent = input.execution.kind === 'provider_execution'
        ? crossingCount > 0
        : input.execution.kind === 'local_execution'
          ? crossingRows.every((crossing) => crossing.execution_site === 'host')
          : crossingCount === 0;
      const refusalOutcomeConsistent = input.execution.kind !== 'refused_pre_dispatch'
        || !['succeeded', 'empty_result', 'uncertain_write'].includes(input.outcome.kind);
      if (!executionConsistent || !refusalOutcomeConsistent) {
        return conflict(db, identity, 'execution kind conflicts with durable crossings or outcome');
      }
      if (
        progressDigest
        && (
          input.outcome.kind !== 'succeeded'
          || recovery.businessCall !== true
          || recovery.continuesRequirement === true
        )
      ) {
        return conflict(db, identity, 'progress can only be claimed by completed business work');
      }
      if (
        recovery.governorEvidence?.onlyIfProgressClaimed === true
        && !progressDigest
      ) {
        return conflict(db, identity, 'progress-gated governor evidence requires a progress identity');
      }

      const executedSuccessfully = input.outcome.kind === 'succeeded'
        || input.outcome.kind === 'empty_result';
      const successfulProviderResult = input.execution.kind === 'provider_execution'
        && executedSuccessfully;
      // A local execution that recorded its own returned crossing holds exactly
      // the same redeemable evidence — the host invoked the tool and kept the
      // bytes it returned. Without this, work the host did itself could never
      // discharge a dependency, seal a universe, or be projected as observed.
      // Both conditions require a returned crossing, so neither can mint a
      // handle for a call that never executed.
      const successfulHostResult = input.execution.kind === 'local_execution'
        && executedSuccessfully
        && crossingRows.at(-1)?.state === 'returned'
        && Boolean(input.result && Object.prototype.hasOwnProperty.call(input.result, 'payload'));
      let resultHandleId: string | undefined;
      if (successfulProviderResult || successfulHostResult) {
        const lastCrossing = crossingRows.at(-1);
        if (!lastCrossing || lastCrossing.state !== 'returned') {
          return conflict(db, identity, 'successful provider result lacks a final returned crossing');
        }
        if (!input.result || !Object.prototype.hasOwnProperty.call(input.result, 'payload')) {
          throw new Error('successful provider result lacks durable raw payload input');
        }
        let resultHandle: ReturnType<typeof persistAuthoritativeResultHandleInTransaction>;
        try {
          resultHandle = persistAuthoritativeResultHandleInTransaction(
            db,
            input.result.payload,
            {
              sessionId: identity.sessionId,
              sourceUserSeq: identity.sourceUserSeq,
              acceptedTaskId: identity.acceptedTaskId,
              logicalToolCallId: identity.logicalToolCallId,
              physicalDispatchId: lastCrossing.physical_dispatch_id,
              toolName: canonicalToolName,
              args: input.contract.args,
              canonicalArgumentDigest,
              ...(input.result.baseArgs === undefined ? {} : { baseArgs: input.result.baseArgs }),
              ...(input.result.continuationChainId
                ? { continuationChainId: input.result.continuationChainId }
                : {}),
            },
          );
        } catch (error) {
          if (
            error instanceof ResultHandleAuthorityError
            && (error.status === 'conflict' || error.status === 'authority_mismatch')
          ) {
            return conflict(db, identity, error.reason);
          }
          throw error;
        }
        if (!resultHandle.success || !resultHandle.rawLocation) {
          throw new Error('successful provider result did not produce redeemable result authority');
        }
        resultHandleId = resultHandle.handle;
      }
      const semantic = semanticDigest({
        toolName: canonicalToolName,
        argumentDigest: canonicalArgumentDigest,
        executionKind: input.execution.kind,
        outcome: input.outcome,
        recovery,
        progressDigest,
        resultHandleId,
      });

      const prior = readDurableSettlement(db, identity);
      if (prior) {
        const persistedSemantic = semanticDigest({
          toolName: prior.toolName,
          argumentDigest: prior.argumentDigest,
          executionKind: prior.executionKind,
          outcome: prior.outcome,
          recovery: prior.recovery,
          progressDigest: prior.recovery.progressKeyDigest,
          resultHandleId: prior.resultHandleId,
        });
        const exact = logical.state === 'settled'
          && logical.settlement_event_id === prior.settlementEventId
          && logical.outcome_kind === prior.outcome.kind
          && prior.semanticDigest === semantic
          && persistedSemantic === prior.semanticDigest
          && prior.resultHandleId === resultHandleId
          && prior.physicalCrossingsDigest === crossingsDigest
          && crossingDigest(prior.crossings) === prior.physicalCrossingsDigest
          && prior.physicalCrossingCount === crossingCount
          && prior.hostCrossingCount === hostCrossingCount
          && prior.crossings.length === crossings.length;
        return exact
          ? { status: 'replayed', settlement: prior }
          : conflict(db, identity, 'logical settlement replay conflicts with durable authority');
      }
      if (logical.state !== 'open') {
        return conflict(db, identity, `logical call is ${logical.state} without a durable settlement`);
      }
      if (logical.resolution_state !== 'open') {
        return { status: 'closed', reason: `accepted task resolution is ${logical.resolution_state}` };
      }

      let progressClaimed = false;
      if (progressDigest) {
        const owner = db.prepare(`
          SELECT logical_tool_call_id FROM logical_call_progress_claims
           WHERE session_id = ? AND source_user_seq = ? AND progress_key_digest = ?
        `).get(identity.sessionId, identity.sourceUserSeq, progressDigest) as {
          logical_tool_call_id: string;
        } | undefined;
        progressClaimed = owner === undefined;
      }

      const applyGovernor = Boolean(
        recovery.governorEvidence
        && (
          recovery.governorEvidence.onlyIfProgressClaimed !== true
          || progressClaimed
        ),
      );
      const governorRecord = applyGovernor
        ? recordDiscoveryEvidenceInTransaction(db, {
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            kind: recovery.governorEvidence!.kind,
            ...(recovery.governorEvidence!.detail
              ? { detail: recovery.governorEvidence!.detail }
              : {}),
          })
        : undefined;
      const openedDiscoveryEpoch = governorRecord?.outcome === 'epoch_opened';
      const creditedProgress = progressClaimed
        && recovery.governorEvidence?.kind === 'capability_satisfied';

      const observerCallId = input.observer.callId?.trim().slice(0, 256) || undefined;
      const providerStatus = normalizedProviderStatus(input.outcome.providerStatus);
      const detail = normalizedDetail(input.outcome.detail);
      mirror = insertInternalEventInTransaction(db, {
        sessionId: identity.sessionId,
        turn: Number.isSafeInteger(input.observer.turn) && (input.observer.turn ?? 0) > 0
          ? input.observer.turn as number
          : 0,
        role: 'system',
        type: 'tool_attempt_settled',
        data: {
          protocolVersion: LOGICAL_CALL_SETTLEMENT_PROTOCOL_VERSION,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId: identity.acceptedTaskId,
          logicalToolCallId: identity.logicalToolCallId,
          lane: input.observer.lane,
          ...(observerCallId ? { callId: observerCallId } : {}),
          tool: canonicalToolName,
          argumentDigest: canonicalArgumentDigest,
          semanticDigest: semantic,
          executionKind: input.execution.kind,
          kind: input.outcome.kind,
          evidence: input.outcome.evidence,
          action: input.outcome.directive.action,
          dispatchState: input.execution.kind === 'refused_pre_dispatch' ? 'not_started' : 'dispatched',
          businessCall: recovery.businessCall,
          mutating: recovery.mutating,
          ...(recovery.requirementId ? { requirementId: recovery.requirementId } : {}),
          ...(workBinding?.universe_item_id ? { universeItemId: workBinding.universe_item_id } : {}),
          ...(providerStatus ? { providerStatus } : {}),
          ...(detail ? { detail } : {}),
          physicalDispatchIds: crossings.map((crossing) => crossing.physicalDispatchId),
          physicalDispatchCount: crossingCount,
          physicalCrossingsDigest: crossingsDigest,
          ...(resultHandleId ? { resultHandleId } : {}),
          ...(crossings.at(-1) ? {
            physicalAttemptId: crossings.at(-1)!.physicalDispatchId,
            physicalDispatchId: crossings.at(-1)!.physicalDispatchId,
          } : {}),
          ...(progressDigest ? { progressKeyDigest: progressDigest, progressClaimed } : {}),
          ...(recovery.governorEvidence ? {
            governorEvidenceKind: recovery.governorEvidence.kind,
          } : {}),
          ...(governorRecord ? { governorOutcome: governorRecord.outcome } : {}),
          openedDiscoveryEpoch,
          creditedProgress,
        },
      });

      db.prepare(`
        INSERT INTO logical_call_settlements
          (session_id, source_user_seq, logical_tool_call_id, protocol_version,
           semantic_digest, execution_kind, outcome_kind, outcome_evidence,
           provider_status, outcome_detail, business_call, mutating,
           requirement_id, continues_requirement, recovery_action,
           retry_same_candidate, eliminates_candidate,
           discovery_epoch_requested, requires_reconciliation,
           progress_key_digest, progress_claimed, physical_crossing_count,
           physical_crossings_digest, observer_lane, observer_call_id,
           settlement_event_id, settled_at, governor_evidence_kind,
           governor_evidence_detail, governor_requires_progress,
           governor_outcome, opened_discovery_epoch, credited_progress,
           result_handle_id, host_crossing_count)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.sessionId,
        identity.sourceUserSeq,
        identity.logicalToolCallId,
        semantic,
        input.execution.kind,
        input.outcome.kind,
        input.outcome.evidence,
        providerStatus ?? null,
        detail ?? null,
        recovery.businessCall ? 1 : 0,
        recovery.mutating ? 1 : 0,
        recovery.requirementId ?? null,
        recovery.continuesRequirement === true ? 1 : 0,
        input.outcome.directive.action,
        input.outcome.directive.retrySameCandidate ? 1 : 0,
        input.outcome.directive.eliminatesCandidate ? 1 : 0,
        input.outcome.directive.opensDiscoveryEpoch ? 1 : 0,
        input.outcome.directive.requiresReconciliation ? 1 : 0,
        progressDigest ?? null,
        progressClaimed ? 1 : 0,
        crossingCount,
        crossingsDigest,
        input.observer.lane,
        observerCallId ?? null,
        mirror.id,
        mirror.createdAt,
        recovery.governorEvidence?.kind ?? null,
        recovery.governorEvidence?.detail?.replace(/\s+/g, ' ').trim().slice(0, 256) || null,
        recovery.governorEvidence?.onlyIfProgressClaimed === true ? 1 : 0,
        governorRecord?.outcome ?? null,
        openedDiscoveryEpoch ? 1 : 0,
        creditedProgress ? 1 : 0,
        resultHandleId ?? null,
        hostCrossingCount,
      );
      const insertCrossing = db.prepare(`
        INSERT INTO logical_call_settlement_crossings
          (session_id, source_user_seq, logical_tool_call_id,
           physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const crossing of crossings) {
        insertCrossing.run(
          identity.sessionId,
          identity.sourceUserSeq,
          identity.logicalToolCallId,
          crossing.physicalDispatchId,
          crossing.ordinal,
          crossing.relation,
          crossing.retryOf ?? null,
          crossing.toolName,
          crossing.argumentDigest,
        );
      }
      recordWriteEvidenceSettlementOutcomeInTransaction(db, {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: identity.acceptedTaskId,
        logicalToolCallId: identity.logicalToolCallId,
        settlementEventId: mirror.id,
        executionKind: input.execution.kind,
        outcomeKind: input.outcome.kind,
        ...(resultHandleId ? { resultHandleId } : {}),
      });
      if (progressDigest && progressClaimed) {
        const inserted = db.prepare(`
          INSERT INTO logical_call_progress_claims
            (session_id, source_user_seq, progress_key_digest,
             logical_tool_call_id, claimed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          identity.sessionId,
          identity.sourceUserSeq,
          progressDigest,
          identity.logicalToolCallId,
          mirror.createdAt,
        );
        if (inserted.changes !== 1) throw new Error('progress claim lost its atomic admission');
      }
      if (
        (
          input.outcome.kind === 'succeeded'
          || (input.outcome.kind === 'empty_result' && recovery.mutating === false)
        )
        && recovery.businessCall === true
        && recovery.continuesRequirement !== true
        && (!progressDigest || progressClaimed)
      ) {
        const expected = expectedTaskFor(identity.sessionId, identity.sourceUserSeq);
        if (expected.status !== 'ok') {
          throw new Error(`successful business call has ${expected.status} task authority`);
        }
        if (!expected.expectation.workNodeId) {
          // A conversational graph legitimately owns NO work node — and the
          // model may still make a business call on such a turn (a greeting
          // followed by an opportunistic read; a typed-conversation control
          // beside a probe). There is no node to attribute an operation to,
          // and throwing here killed the WHOLE settlement — durable evidence
          // and all — for a turn the effect gates had already admitted. The
          // settlement row and its result handle remain the durable record;
          // only the graph-node attribution is skipped. A non-conversational
          // graph missing its work node is still a real authority defect and
          // keeps the throw.
          if (expected.expectation.workKind !== 'conversation') {
            throw new Error('successful business call has no accepted work node');
          }
        }
        const effective = unwrapRuntimeEffectiveToolIdentity(
          input.contract.toolName,
          input.contract.args,
        );
        const operationArgs = isTrustedComposioGateway(input.contract.toolName)
          ? normalizeCallableArguments(input.contract.args, contract.toolName).args
          : effective.args;
        const operation = !expected.expectation.workNodeId
          ? { status: 'skipped_conversational' as const }
          : recordResolvedOperationInTransaction(db, {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          turn: input.observer.turn,
          nodeId: expected.expectation.workNodeId,
          operationId: recovery.requirementId
            ? `${recovery.requirementId}${workBinding?.universe_item_id
              ? `:item:${sha256(workBinding.universe_item_id).slice(0, 16)}`
              : ''}`
            : identity.logicalToolCallId,
          resolvedTool: canonicalToolName,
          args: operationArgs,
          logicalToolCallId: identity.logicalToolCallId,
          ...(crossings.at(-1)
            ? { physicalDispatchId: crossings.at(-1)!.physicalDispatchId }
            : {}),
          outcomeKind: input.outcome.kind,
          dispatchState: crossings.length > 0 ? 'dispatched' : 'not_started',
        });
        if (operation.status === 'inserted') operationMirror = operation.event;
        else if (operation.status !== 'existing' && operation.status !== 'skipped_conversational') {
          throw new Error(`successful operation could not become authority: ${operation.reason}`);
        }
      }
      const closed = db.prepare(`
        UPDATE logical_tool_calls
           SET state = 'settled', settled_at = ?, settlement_event_id = ?, outcome_kind = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND logical_tool_call_id = ? AND state = 'open'
      `).run(
        mirror.createdAt,
        mirror.id,
        input.outcome.kind,
        identity.sessionId,
        identity.sourceUserSeq,
        identity.logicalToolCallId,
      );
      if (closed.changes !== 1) throw new Error('logical settlement lost its close CAS');

      const settlement = readDurableSettlement(db, identity);
      if (!settlement) throw new Error('committed logical settlement could not be read back');
      return { status: 'committed', settlement };
    });
    const result = transaction.immediate();
    if (result.status === 'committed') {
      if (mirror) publishCommittedInternalEvent(mirror);
      if (operationMirror) publishCommittedInternalEvent(operationMirror);
    }
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
