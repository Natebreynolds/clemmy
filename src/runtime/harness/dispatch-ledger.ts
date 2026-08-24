/**
 * Durable authority for every real provider crossing.
 *
 * A `provider_dispatch_started` event used to be best-effort telemetry: its
 * write result was ignored and the provider was called anyway. The normalized
 * rows below reverse that relationship. An inserted physical-dispatch row is
 * the permission to leave the process. It is committed with its mirror event
 * in one IMMEDIATE transaction while the accepted-task resolution is open.
 */
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import {
  ensureAcceptedTaskResolutionOpenInTransaction,
  expectedTaskFor,
  type AcceptedTaskExpectation,
} from './resolution-ledger.js';
import {
  acceptedTurnCallAuthorityFor,
  admitHostLogicalCallInTransaction,
  admitWorkflowLogicalCallInTransaction,
  poisonAcceptedTurnCallAuthorityInTransaction,
  type AcceptedTurnCallAuthority,
  type CallAdmissionEffect,
} from './accepted-turn-call-authority.js';
import { admitWorkflowPaginatedLogicalCallInTransaction } from './workflow-paginated-read-authority.js';
import {
  canonicalLogicalToolName,
  durableLogicalCallContract,
  type DurableLogicalCallContract,
} from './logical-call-contract.js';
import { reserveWriteEvidenceDispatchInTransaction } from './write-evidence-lifecycle.js';
import { approvedMandateAdmitsCall } from './expected-work-admission.js';
import {
  classifyRuntimeToolEffect,
  inspectTrustedRuntimeEffectCarrier,
  type TrustedRuntimeEffectCarrier,
} from './tool-effect.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
  observedIdentityMatches,
} from './independent-capability-observation.js';
import {
  canonicalArgumentDigestOf,
  parseResolvedCallAuthority,
  serializeResolvedCallAuthority,
  type ResolvedCallAuthorityV1,
} from './resolved-call-authority.js';
import { isProductionPackCapabilityId, typedExecutionCatalogReady } from '../semantic-boundary/configure-typed-execution-runtime.js';
import { openCanonicalArguments, sealCanonicalArguments } from './authority-argument-seal.js';
import { peekProductionCapabilityPort } from './production-capability-ports.js';
import {
  canonicalGraphNodeLeaseKey,
  consumeCanonicalGraphNodeLeaseInTransaction,
  inspectCanonicalGraphNodeLeaseInTransaction,
  parseCanonicalOwnerFence,
  reservationInsertFaultEnabled,
} from './canonical-graph-node-lease.js';
import { shippedTransportDigest, verifyShippedImplementationIdentity } from './shipped-implementation-identity.js';
import { derivePhysicalDispatchId } from './physical-crossing-identity.js';
import {
  currentDispatchLease,
  isDispatchLeaseCurrent,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  insertPreparedPhysicalReturnCheckpointInTransaction,
  persistedPhysicalReturnCheckpointOwns,
  preparedPhysicalReturnCheckpointOwns,
  stagedPhysicalReturnCheckpointIdentity,
  type PreparedPhysicalReturnCheckpoint,
} from './physical-return-checkpoint.js';
import {
  inspectStagedPhysicalDispatchAuthority,
  type StagedPhysicalDispatchAuthority,
  type StagedPhysicalDispatchAuthorityState,
} from './staged-transfer-authority.js';
export { derivePhysicalDispatchId } from './physical-crossing-identity.js';

const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);
const DEFINITIVE_CROSSING_STATES = new Set(['returned', 'threw']);
const SAFE_RETRY_STATES = new Set(['started', 'timed_out']);
const SAFE_RETRY_REASONS = new Set(['uncertain_recovery', 'owner_lost', 'explicit_retry']);

export function retryDispositionFor(
  state: string,
  effect: string,
  reason: string | undefined,
): 'allow' | 'require_reconciliation' | 'refuse' {
  if (
    WRITE_EFFECTS.has(effect)
    && (state === 'started' || state === 'timed_out' || state === 'cancelled' || state === 'unknown' || !state)
  ) {
    return 'require_reconciliation';
  }
  if (DEFINITIVE_CROSSING_STATES.has(state) || state === 'cancelled' || state === 'unknown') {
    return 'refuse';
  }
  if (SAFE_RETRY_STATES.has(state) && !WRITE_EFFECTS.has(effect) && reason && SAFE_RETRY_REASONS.has(reason)) {
    return 'allow';
  }
  return 'refuse';
}

function exactRetryPredecessorInTransaction(
  db: ReturnType<typeof openEventLog>,
  authority: ResolvedCallAuthorityV1,
  typed: TypedPhysicalDispatchPersist,
): { ok: true } | { ok: false; reason: string } {
  if (authority.relation !== 'retry') {
    return { ok: false, reason: 'retry reservation requires relation=retry' };
  }
  if (!authority.retryOf || !authority.predecessorAuthorityDigest || !authority.retryReason) {
    return { ok: false, reason: 'retry reservation is missing predecessor identity' };
  }
  const predecessor = db.prepare(`
    SELECT physical_dispatch_id, logical_tool_call_id, ordinal, relation, state,
           argument_digest, authority_digest, provider_argument_digest
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(
    authority.acceptedSource.sessionId,
    authority.acceptedSource.sourceUserSeq,
    authority.retryOf,
  ) as {
    physical_dispatch_id: string;
    logical_tool_call_id: string;
    ordinal: number;
    relation: string;
    state: string;
    argument_digest: string;
    authority_digest: string | null;
    provider_argument_digest: string | null;
  } | undefined;
  if (!predecessor) {
    return { ok: false, reason: 'retry predecessor crossing is missing' };
  }
  if (!predecessor.provider_argument_digest || !predecessor.authority_digest) {
    return { ok: false, reason: 'retry predecessor is an ambiguous legacy crossing' };
  }
  const disposition = retryDispositionFor(
    predecessor.state,
    authority.resolvedEffect,
    authority.retryReason,
  );
  if (disposition === 'refuse') {
    return { ok: false, reason: 'returned or settled crossing cannot receive retry authority' };
  }
  if (disposition === 'require_reconciliation') {
    return { ok: false, reason: 'started or unknown write requires reconciliation and cannot be redispatched' };
  }
  if (!predecessor.authority_digest || predecessor.authority_digest !== authority.predecessorAuthorityDigest) {
    return { ok: false, reason: 'retry predecessor authority digest does not match the reserved crossing' };
  }
  if (
    predecessor.physical_dispatch_id !== authority.retryOf
    || predecessor.logical_tool_call_id !== authority.logicalCallId
    || predecessor.ordinal + 1 !== authority.ordinal
    || predecessor.argument_digest !== authority.logicalArgumentDigest
    || predecessor.provider_argument_digest !== typed.providerArgumentDigest
    || predecessor.provider_argument_digest !== authority.canonicalArgumentDigest
  ) {
    return { ok: false, reason: 'retry predecessor identity does not match the reserved crossing' };
  }
  const sealed = db.prepare(`
    SELECT sealed_json AS authority_json
      FROM physical_dispatch_authority_sealed
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(
    authority.acceptedSource.sessionId,
    authority.acceptedSource.sourceUserSeq,
    authority.retryOf,
  ) as { authority_json: string } | undefined;
  if (!sealed?.authority_json) {
    return { ok: false, reason: 'retry predecessor authority payload is missing' };
  }
  const parsed = parseResolvedCallAuthority(sealed.authority_json);
  if (!parsed.ok || parsed.authority.authorityDigest !== predecessor.authority_digest) {
    return { ok: false, reason: 'retry predecessor authority payload is not reconstructable' };
  }
  const prior = parsed.authority;
  if (
    prior.physicalDispatchId !== authority.retryOf
    || prior.logicalCallId !== authority.logicalCallId
    || prior.ordinal + 1 !== authority.ordinal
    || prior.canonicalArgumentDigest !== authority.canonicalArgumentDigest
    || prior.logicalArgumentDigest !== authority.logicalArgumentDigest
    || prior.operationId !== authority.operationId
    || prior.manifestId !== authority.manifestId
    || prior.manifestDigest !== authority.manifestDigest
    || prior.accountId !== authority.accountId
    || prior.operationVersion !== authority.operationVersion
    || prior.liveFingerprint !== authority.liveFingerprint
    || prior.providerKind !== authority.providerKind
    || prior.providerIdentity !== authority.providerIdentity
    || prior.liveProviderVersion !== authority.liveProviderVersion
    || prior.idempotency.required !== authority.idempotency.required
    || prior.idempotency.policy !== authority.idempotency.policy
    || prior.reconciliationPolicy !== authority.reconciliationPolicy
    || (prior.reconcilePortId ?? '') !== (authority.reconcilePortId ?? '')
    || prior.invokeImplementationDigest !== authority.invokeImplementationDigest
    || (prior.reconcileImplementationDigest ?? '') !== (authority.reconcileImplementationDigest ?? '')
  ) {
    return { ok: false, reason: 'retry predecessor contract does not match the reserved crossing' };
  }
  return { ok: true };
}

export const DISPATCH_STARTED_EVENT = 'provider_dispatch_started' as const;
export const DISPATCH_SETTLED_EVENT = 'provider_dispatch_settled' as const;
export const LOGICAL_CALL_CONTRACT_REFINED_EVENT = 'logical_call_contract_refined' as const;

export type DispatchRelation = 'primary' | 'retry' | 'poll' | 'probe' | 'child';

export interface PhysicalCrossingIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  /** Assigned by the database; caller values are ignored at admission. */
  ordinal: number;
  relation?: DispatchRelation;
  retryOf?: string;
}

export interface DurableLogicalCallIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}

export interface AdmittedLogicalCall extends DurableLogicalCallIdentity {
  toolName: string;
  argumentDigest: string;
}

export interface RefinedLogicalCall extends AdmittedLogicalCall {
  rawArgumentDigest: string;
  effectiveArgumentDigest: string;
}

export type LogicalCallAdmissionResult =
  | { status: 'inserted'; identity: AdmittedLogicalCall }
  | { status: 'replayed'; identity: AdmittedLogicalCall }
  | { status: 'closed'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'conflict'; reason: string }
  | { status: 'storage_error'; reason: string };

export type LogicalCallRefinementResult =
  | { status: 'refined'; identity: RefinedLogicalCall }
  | { status: 'replayed'; identity: RefinedLogicalCall }
  | { status: 'closed'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'conflict'; reason: string }
  | { status: 'storage_error'; reason: string };

export type LogicalCallAuthorityStateResult =
  | { status: 'open' }
  | { status: 'settled' }
  | { status: 'closed' | 'missing' | 'conflict' | 'storage_error'; reason: string };

export type CrossingOutcome = 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';

export type DispatchAdmissionResult =
  | { status: 'inserted'; identity: PhysicalCrossingIdentity }
  | { status: 'replayed'; identity: PhysicalCrossingIdentity }
  | { status: 'closed'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'conflict'; reason: string }
  | { status: 'storage_error'; reason: string };

export type DispatchSettlementResult =
  | { status: 'inserted' }
  | { status: 'replayed' }
  | { status: 'closed'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'conflict'; reason: string }
  | { status: 'storage_error'; reason: string };

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180);
}

function safeToolName(tool: string): string | null {
  return canonicalLogicalToolName(tool);
}

interface LogicalRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  raw_argument_digest: string;
  effective_argument_digest: string | null;
  state: 'open' | 'settled' | 'conflict';
}

interface DispatchRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  physical_dispatch_id: string;
  ordinal: number;
  relation: DispatchRelation;
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state: 'started' | CrossingOutcome;
  execution_site: 'host' | null;
  authority_digest: string | null;
  provider_argument_digest: string | null;
  staged_authority_digest: string | null;
  lease_scope_id: string | null;
  lease_id: string | null;
}

function logicalMatches(
  row: LogicalRow,
  acceptedTaskId: string,
  tool: string,
  digest: string,
  phase: 'logical' | 'physical',
): boolean {
  return row.accepted_task_id === acceptedTaskId
    && row.tool_name === tool
    && (
      phase === 'physical'
        ? row.argument_digest === digest
        : row.raw_argument_digest === digest || row.argument_digest === digest
    );
}

function safeLogicalToolCallId(value: string): string | null {
  if (value !== value.trim() || value.length < 1 || value.length > 512) return null;
  return value;
}

function poisonResolution(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  sourceUserSeq: number,
  logicalToolCallId?: string,
  reason?: string,
): void {
  poisonAcceptedTurnCallAuthorityInTransaction(db, {
    sessionId,
    sourceUserSeq,
    reason: reason ?? 'dispatch authority poisoned without a stated cause',
  });
  db.prepare(`
    UPDATE accepted_task_resolutions
       SET state = 'legacy_ambiguous', revision = revision + 1
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).run(sessionId, sourceUserSeq);
  if (logicalToolCallId) {
    // Record the FIRST cause here too. This is the OTHER poison path, and it
    // recorded nothing: a live workflow died on it twice a day for two days
    // and the store could not say which check failed (platform-49).
    db.prepare(`
      UPDATE logical_tool_calls
         SET state = 'conflict',
             conflict_reason = COALESCE(conflict_reason, ?)
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(
      (reason ?? 'dispatch authority poisoned without a stated cause')
        .replace(/\s+/g, ' ').trim().slice(0, 240),
      sessionId,
      sourceUserSeq,
      logicalToolCallId,
    );
  }
}

type LogicalCallAdmissionInTransactionResult = Exclude<
  LogicalCallAdmissionResult,
  { status: 'storage_error' }
>;

type CallAdmissionAuthority =
  | {
      authorityKind: 'turn_graph';
      acceptedTaskId: string;
      identity: AcceptedTaskExpectation['identity'];
      expectation: AcceptedTaskExpectation;
    }
  | {
      authorityKind: 'host_v1';
      acceptedTaskId: string;
      identity: { sessionId: string; sourceUserSeq: number; turn: number };
      authority: AcceptedTurnCallAuthority;
    }
  | {
      authorityKind: 'host_v1_read_only';
      acceptedTaskId: string;
      identity: { sessionId: string; sourceUserSeq: number; turn: number };
      authority: AcceptedTurnCallAuthority;
    }
  | {
      authorityKind: 'workflow_v1_read_only';
      acceptedTaskId: string;
      identity: { sessionId: string; sourceUserSeq: number; turn: number };
      authority: AcceptedTurnCallAuthority;
    }
  | {
      authorityKind: 'workflow_v2_paginated_read';
      acceptedTaskId: string;
      identity: { sessionId: string; sourceUserSeq: number; turn: number };
      authority: AcceptedTurnCallAuthority;
    };

function ensureCallAdmissionOpenInTransaction(
  db: ReturnType<typeof openEventLog>,
  authority: CallAdmissionAuthority,
  input: DurableLogicalCallIdentity,
  contract: DurableLogicalCallContract | null,
  effect: CallAdmissionEffect,
  isNew: boolean,
): { status: 'ok' } | Extract<LogicalCallAdmissionResult, { status: 'closed' | 'missing' | 'conflict' }> {
  if (authority.authorityKind === 'turn_graph') {
    let open: boolean;
    try {
      open = ensureAcceptedTaskResolutionOpenInTransaction(db, authority.expectation);
    } catch (error) {
      const reason = boundedReason(error);
      if (reason.includes('conflicts with its persisted graph') || reason.includes('is ambiguous')) {
        poisonResolution(db, input.sessionId, input.sourceUserSeq, input.logicalToolCallId, reason);
        return { status: 'conflict', reason };
      }
      throw error;
    }
    return open
      ? { status: 'ok' }
      : { status: 'closed', reason: 'accepted task resolution is closed' };
  }
  const admitted = authority.authorityKind === 'host_v1_read_only' || authority.authorityKind === 'host_v1'
    ? admitHostLogicalCallInTransaction(db, {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        toolName: contract?.toolName ?? '',
        argumentDigest: contract?.argumentDigest ?? '',
        effect,
        isNew,
      })
    : authority.authorityKind === 'workflow_v1_read_only'
      ? admitWorkflowLogicalCallInTransaction(db, {
        sessionId: input.sessionId,
        sourceEventSeq: input.sourceUserSeq,
        authorityRootId: input.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        toolName: contract?.toolName ?? '',
        argumentDigest: contract?.argumentDigest ?? '',
        effect,
        isNew,
      })
      : admitWorkflowPaginatedLogicalCallInTransaction(db, {
        sessionId: input.sessionId,
        sourceEventSeq: input.sourceUserSeq,
        authorityRootId: input.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        toolName: contract?.toolName ?? '',
        argumentDigest: contract?.argumentDigest ?? '',
        effect,
        isNew,
      });
  return admitted.status === 'ok' ? { status: 'ok' } : admitted;
}

/**
 * The one logical-call admission implementation used both before a gate and
 * immediately before a paid crossing. The caller owns the surrounding
 * transaction so physical-dispatch admission can extend the same authority
 * decision without a check/append race.
 */
function admitLogicalCallInTransaction(
  db: ReturnType<typeof openEventLog>,
  authority: CallAdmissionAuthority,
  input: DurableLogicalCallIdentity,
  contract: DurableLogicalCallContract | null,
  phase: 'logical' | 'physical',
  effect: CallAdmissionEffect,
): LogicalCallAdmissionInTransactionResult {
  const logicalToolCallId = safeLogicalToolCallId(input.logicalToolCallId);
  const row = db.prepare(`
    SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest,
           raw_argument_digest, effective_argument_digest, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    logicalToolCallId,
  ) as LogicalRow | undefined;
  const open = ensureCallAdmissionOpenInTransaction(
    db,
    authority,
    { ...input, logicalToolCallId: logicalToolCallId ?? input.logicalToolCallId },
    contract,
    effect,
    row === undefined,
  );
  if (open.status !== 'ok') return open;
  if (
    input.acceptedTaskId !== authority.acceptedTaskId
    || input.sessionId !== authority.identity.sessionId
    || input.sourceUserSeq !== authority.identity.sourceUserSeq
    || !logicalToolCallId
  ) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId ?? undefined, 'logical call names a different accepted task or unsafe identity');
    return { status: 'conflict', reason: 'logical call names a different accepted task or unsafe identity' };
  }
  if (!contract) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId, 'logical call tool identity is unsafe');
    return { status: 'conflict', reason: 'logical call tool identity is unsafe' };
  }

  const identity: AdmittedLogicalCall = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: authority.acceptedTaskId,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
  };
  if (!row) {
    db.prepare(`
      INSERT INTO logical_tool_calls
        (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
         tool_name, argument_digest, raw_argument_digest, state, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(
      input.sessionId,
      input.sourceUserSeq,
      authority.acceptedTaskId,
      logicalToolCallId,
      contract.toolName,
      contract.argumentDigest,
      contract.argumentDigest,
      new Date().toISOString(),
    );
    return { status: 'inserted', identity };
  }

  if (!logicalMatches(row, authority.acceptedTaskId, contract.toolName, contract.argumentDigest, phase)) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId, 'logical call identity conflicts with its durable contract');
    return { status: 'conflict', reason: 'logical call identity conflicts with its durable contract' };
  }
  // AN EXACT RE-ADMISSION OF A CALL THAT ALREADY SETTLED IS NOT A FORGERY.
  // The identity matched on the line above, so this is the same tool with the
  // same digest under the same accepted task — an idempotent second admission,
  // which a refusal path produces routinely: the refusal settles the call, then
  // the ordinary post-tool accounting admits the same provider call id again.
  // Folding it into the conflict branch above poisoned the WHOLE accepted task,
  // so every later work_call was refused "accepted task resolution is ambiguous"
  // and the turn could no longer dispatch anything (live 2026-08-14: one denied
  // tool_search strangled two consecutive turns until the row was edited by
  // hand). Contract refinement already draws this exact distinction below —
  // mismatch poisons, already-settled returns 'closed' — so this says the same
  // thing in the same words rather than inventing a third answer.
  //
  // A PAID crossing is the other question. Re-admitting a settled call to cross
  // the boundary again risks a duplicate effect, so that keeps failing closed
  // exactly as before. Only the logical admission is benign.
  if (row.state !== 'open') {
    if (phase === 'physical') {
      poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId, 'logical call identity conflicts with its durable contract');
      return { status: 'conflict', reason: 'logical call identity conflicts with its durable contract' };
    }
    return { status: 'closed', reason: 'logical call is already settled' };
  }
  return {
    status: 'replayed',
    identity: {
      ...identity,
      argumentDigest: row.argument_digest,
    },
  };
}

function expectedForAdmission(
  sessionId: string,
  sourceUserSeq: number,
):
  | { status: 'ok'; authority: CallAdmissionAuthority }
  | Extract<LogicalCallAdmissionResult, { status: 'missing' | 'conflict' | 'storage_error' }> {
  const root = acceptedTurnCallAuthorityFor(sessionId, sourceUserSeq);
  if (
    root.status === 'ok'
    && (root.authority.authorityKind === 'host_v1_read_only' || root.authority.authorityKind === 'host_v1')
  ) {
    return {
      status: 'ok',
      authority: {
        authorityKind: root.authority.authorityKind,
        acceptedTaskId: root.authority.identity.acceptedTaskId,
        identity: {
          sessionId: root.authority.identity.sessionId,
          sourceUserSeq: root.authority.identity.sourceUserSeq,
          turn: root.authority.identity.sourceTurn,
        },
        authority: root.authority,
      },
    };
  }
  if (root.status === 'ok' && root.authority.authorityKind === 'workflow_v1_read_only') {
    return {
      status: 'ok',
      authority: {
        authorityKind: 'workflow_v1_read_only',
        acceptedTaskId: root.authority.identity.acceptedTaskId,
        identity: {
          sessionId: root.authority.identity.sessionId,
          sourceUserSeq: root.authority.identity.sourceUserSeq,
          turn: root.authority.identity.sourceTurn,
        },
        authority: root.authority,
      },
    };
  }
  if (root.status === 'ok' && root.authority.authorityKind === 'workflow_v2_paginated_read') {
    return {
      status: 'ok',
      authority: {
        authorityKind: 'workflow_v2_paginated_read',
        acceptedTaskId: root.authority.identity.acceptedTaskId,
        identity: {
          sessionId: root.authority.identity.sessionId,
          sourceUserSeq: root.authority.identity.sourceUserSeq,
          turn: root.authority.identity.sourceTurn,
        },
        authority: root.authority,
      },
    };
  }
  if (root.status === 'conflict') return root;
  if (root.status === 'storage_error') return root;
  const expected = expectedTaskFor(sessionId, sourceUserSeq);
  if (expected.status === 'ok') {
    if (
      root.status === 'ok'
      && (
        root.authority.authorityKind !== 'turn_graph'
        || root.authority.identity.acceptedTaskId !== expected.expectation.acceptedTaskId
        || root.authority.graphEventId !== expected.expectation.graphEventId
        || root.authority.graphHash !== expected.expectation.graphHash
      )
    ) return { status: 'conflict', reason: 'graph call authority conflicts with its persisted graph' };
    return {
      status: 'ok',
      authority: {
        authorityKind: 'turn_graph',
        acceptedTaskId: expected.expectation.acceptedTaskId,
        identity: expected.expectation.identity,
        expectation: expected.expectation,
      },
    };
  }
  if (expected.status === 'missing') return expected;
  if (expected.reason.startsWith('turn graph store unreadable:')) {
    return { status: 'storage_error', reason: expected.reason };
  }
  return { status: 'conflict', reason: expected.reason };
}

/**
 * Persist one logical invocation before any policy, schema, routing or approval
 * gate can refuse it. A successful call can therefore settle truthfully with
 * zero physical crossings, and a retry can only replay the exact OPEN contract.
 */
export function admitLogicalCall(input: {
  identity: DurableLogicalCallIdentity;
  tool: string;
  args?: unknown;
}): LogicalCallAdmissionResult {
  const expectedState = expectedForAdmission(input.identity.sessionId, input.identity.sourceUserSeq);
  if (expectedState.status !== 'ok') return expectedState;
  const authority = expectedState.authority;
  const contract = durableLogicalCallContract(authority.acceptedTaskId, input.tool, input.args);
  const effect = classifyRuntimeToolEffect(input.tool, input.args).effect;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): LogicalCallAdmissionInTransactionResult => {
      return admitLogicalCallInTransaction(db, authority, input.identity, contract, 'logical', effect);
    });
    return transaction.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Replace the pre-gate argument digest with the exact provider-ready digest
 * produced by a trusted host resolver.
 *
 * This is deliberately a one-way refinement, not a general update API. The
 * raw digest remains immutable for audit; one effective digest may be frozen
 * only while the accepted resolution and logical call are open and before any
 * physical crossing exists. Arguments themselves never enter SQLite.
 */
export function refineLogicalCallContract(input: {
  identity: DurableLogicalCallIdentity;
  tool: string;
  effectiveArgs?: unknown;
  turn?: number;
}): LogicalCallRefinementResult {
  const expectedState = expectedForAdmission(input.identity.sessionId, input.identity.sourceUserSeq);
  if (expectedState.status !== 'ok') return expectedState;
  const authority = expectedState.authority;
  const logicalToolCallId = safeLogicalToolCallId(input.identity.logicalToolCallId);
  const effective = durableLogicalCallContract(
    authority.acceptedTaskId,
    input.tool,
    input.effectiveArgs,
  );
  const effectiveEffect = classifyRuntimeToolEffect(input.tool, input.effectiveArgs).effect;
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): LogicalCallRefinementResult => {
      if (
        input.identity.acceptedTaskId !== authority.acceptedTaskId
        || input.identity.sessionId !== authority.identity.sessionId
        || input.identity.sourceUserSeq !== authority.identity.sourceUserSeq
        || !logicalToolCallId
      ) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId ?? undefined, 'contract refinement names a different accepted task or unsafe identity');
        return { status: 'conflict', reason: 'contract refinement names a different accepted task or unsafe identity' };
      }
      if (!effective) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId, 'effective logical call contract is unsafe');
        return { status: 'conflict', reason: 'effective logical call contract is unsafe' };
      }

      const row = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest,
               raw_argument_digest, effective_argument_digest, state
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        logicalToolCallId,
      ) as LogicalRow | undefined;
      if (!row) return { status: 'missing', reason: 'logical call authority is missing' };
      const open = ensureCallAdmissionOpenInTransaction(
        db,
        authority,
        { ...input.identity, logicalToolCallId },
        effective,
        effectiveEffect,
        false,
      );
      if (open.status !== 'ok') return open;
      if (
        row.accepted_task_id !== authority.acceptedTaskId
        || row.tool_name !== effective.toolName
        || row.state === 'conflict'
      ) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId, 'contract refinement conflicts with its logical owner or tool');
        return { status: 'conflict', reason: 'contract refinement conflicts with its logical owner or tool' };
      }
      if (row.state !== 'open') {
        return { status: 'closed', reason: 'logical call is already settled' };
      }

      const crossingCount = (db.prepare(`
        SELECT COUNT(*) AS count
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        logicalToolCallId,
      ) as { count: number }).count;
      const settled = Boolean(db.prepare(`
        SELECT 1 AS present FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        logicalToolCallId,
      ));
      if (crossingCount > 0 || settled) {
        return { status: 'closed', reason: 'logical call contract is frozen by execution or settlement' };
      }

      const identity = (digest: string): RefinedLogicalCall => ({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId: authority.acceptedTaskId,
        logicalToolCallId,
        toolName: row.tool_name,
        argumentDigest: digest,
        rawArgumentDigest: row.raw_argument_digest,
        effectiveArgumentDigest: digest,
      });

      // Parsing a string carrier, sorting object keys, or removing transport
      // representation drift produces the same canonical digest. It is a
      // replay, not a semantic host rewrite, and consumes no refinement.
      if (effective.argumentDigest === row.raw_argument_digest && row.effective_argument_digest === null) {
        return { status: 'replayed', identity: identity(row.raw_argument_digest) };
      }
      if (row.effective_argument_digest !== null) {
        if (
          row.effective_argument_digest === effective.argumentDigest
          && row.argument_digest === effective.argumentDigest
        ) {
          return { status: 'replayed', identity: identity(row.effective_argument_digest) };
        }
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId, 'logical call already has a different effective contract');
        return { status: 'conflict', reason: 'logical call already has a different effective contract' };
      }

      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.identity.sessionId,
        turn: input.turn ?? authority.identity.turn,
        role: 'system',
        type: LOGICAL_CALL_CONTRACT_REFINED_EVENT,
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          acceptedTaskId: authority.acceptedTaskId,
          logicalToolCallId,
          tool: row.tool_name,
          rawArgumentDigest: row.raw_argument_digest,
          effectiveArgumentDigest: effective.argumentDigest,
        },
      });
      const updated = db.prepare(`
        UPDATE logical_tool_calls
           SET argument_digest = ?, effective_argument_digest = ?,
               refined_at = ?, refinement_event_id = ?
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
           AND state = 'open' AND effective_argument_digest IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM physical_dispatches p
              WHERE p.session_id = logical_tool_calls.session_id
                AND p.source_user_seq = logical_tool_calls.source_user_seq
                AND p.logical_tool_call_id = logical_tool_calls.logical_tool_call_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM logical_call_settlements s
              WHERE s.session_id = logical_tool_calls.session_id
                AND s.source_user_seq = logical_tool_calls.source_user_seq
                AND s.logical_tool_call_id = logical_tool_calls.logical_tool_call_id
           )
      `).run(
        effective.argumentDigest,
        effective.argumentDigest,
        mirror.createdAt,
        mirror.id,
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        logicalToolCallId,
      );
      if (updated.changes !== 1) throw new Error('logical call contract refinement lost its CAS');
      return { status: 'refined', identity: identity(effective.argumentDigest) };
    });
    const result = transaction.immediate();
    if (result.status === 'refined' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Read the exact logical owner without changing it. Nested wrappers use this
 * to avoid contradicting an inner boundary that already committed the one
 * authoritative outcome. */
export function logicalCallAuthorityState(
  identity: DurableLogicalCallIdentity,
): LogicalCallAuthorityStateResult {
  try {
    const row = openEventLog().prepare(`
      SELECT l.accepted_task_id, l.state, l.conflict_reason,
             a.accepted_task_id AS authority_accepted_task_id,
             a.authority_kind, a.state AS authority_state,
             r.state AS resolution_state
        FROM logical_tool_calls l
        JOIN accepted_turn_call_authorities a
          ON a.session_id = l.session_id AND a.source_user_seq = l.source_user_seq
        LEFT JOIN accepted_task_resolutions r
          ON r.session_id = l.session_id AND r.source_user_seq = l.source_user_seq
       WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.logicalToolCallId,
    ) as {
      accepted_task_id: string;
      state: LogicalRow['state'];
      conflict_reason: string | null;
      authority_accepted_task_id: string;
      authority_kind:
        | 'turn_graph'
        | 'host_v1'
        | 'host_v1_read_only'
        | 'workflow_v1_read_only'
        | 'workflow_v2_paginated_read';
      authority_state: 'open' | 'closed' | 'conflict';
      resolution_state: 'open' | 'finalized' | 'legacy_ambiguous' | null;
    } | undefined;
    if (!row) return { status: 'missing', reason: 'logical call authority is missing' };
    if (
      row.accepted_task_id !== identity.acceptedTaskId
      || row.authority_accepted_task_id !== identity.acceptedTaskId
      || row.state === 'conflict'
      || row.authority_state === 'conflict'
    ) {
      // Report the FIRST cause when one was recorded. Without it every reader
      // of a poisoned call — including the error that ends the run — describes
      // the poisoning rather than the check that failed.
      return {
        status: 'conflict',
        reason: row.conflict_reason
          ? `logical call authority was poisoned: ${row.conflict_reason}`
          : 'logical call authority conflicts with its accepted task',
      };
    }
    if (row.authority_kind === 'turn_graph' && row.resolution_state === 'legacy_ambiguous') {
      return { status: 'conflict', reason: 'accepted task resolution is ambiguous' };
    }
    if (
      row.state === 'open'
      && (
        row.authority_state !== 'open'
        || (row.authority_kind === 'turn_graph' && row.resolution_state !== 'open')
      )
    ) {
      return { status: 'closed', reason: 'accepted-turn call authority closed before logical settlement' };
    }
    return { status: row.state };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Atomically claim one paid crossing while its accepted task is still open.
 * Only `inserted` authorizes a new provider call. A replay is observable but
 * must never repeat I/O.
 */
interface CompatibilityPhysicalDispatchInput {
  identity: PhysicalCrossingIdentity;
  tool: string;
  args?: unknown;
  turn?: number;
  relation?: DispatchRelation;
  trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
  executionSite?: 'host';
  /** Exact host-owned generation authorizing this physical admission. When
   * omitted, the ambient generation is used. */
  dispatchLease?: DispatchLeaseRef;
}

interface TypedPhysicalDispatchPersist {
  authorityDigest: string;
  providerArgumentDigest: string;
  typedAuthorityJson: string;
  argumentCipher: string;
}

interface StagedPhysicalDispatchPersist {
  authority: StagedPhysicalDispatchAuthority;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
}

/**
 * Compatibility reservation. Cannot persist typed authority rows even if a
 * caller smuggles digest fields on the object.
 */
export function beginPhysicalDispatch(input: CompatibilityPhysicalDispatchInput): DispatchAdmissionResult {
  return beginPhysicalDispatchCore(input);
}

/**
 * Consume one process-opaque staged attempt at the final pre-body edge.  The
 * copyable IDs stored in SQLite are deliberately not accepted by this API;
 * they are only evidence that the opaque carrier still re-opens exactly.
 */
export function beginStagedPhysicalDispatch(input: {
  authority: StagedPhysicalDispatchAuthority;
  turn?: number;
}): DispatchAdmissionResult {
  const state = inspectStagedPhysicalDispatchAuthority(input.authority);
  if (!state) {
    return { status: 'conflict', reason: 'staged physical authority no longer reopens' };
  }
  return beginPhysicalDispatchCore({
    identity: {
      sessionId: state.sessionId,
      sourceUserSeq: state.sourceUserSeq,
      acceptedTaskId: state.acceptedTaskId,
      logicalToolCallId: state.logicalToolCallId,
      physicalDispatchId: state.physicalDispatchId,
      ordinal: 1,
    },
    tool: state.toolName,
    turn: input.turn,
    relation: 'primary',
    dispatchLease: state.lease,
  }, undefined, { authority: input.authority, state });
}

function beginPhysicalDispatchCore(
  input: CompatibilityPhysicalDispatchInput,
  typed?: TypedPhysicalDispatchPersist,
  staged?: StagedPhysicalDispatchPersist,
): DispatchAdmissionResult {
  if (typed && staged) {
    return { status: 'conflict', reason: 'physical dispatch cannot combine graph and staged authority' };
  }
  const expectedState = expectedForAdmission(input.identity.sessionId, input.identity.sourceUserSeq);
  if (expectedState.status !== 'ok') return expectedState;
  const authority = expectedState.authority;
  const contract = staged
    ? {
        toolName: staged.state.toolName,
        argumentDigest: staged.state.argumentDigest,
      }
    : durableLogicalCallContract(authority.acceptedTaskId, input.tool, input.args);
  const trustedAdmissionCarrier = inspectTrustedRuntimeEffectCarrier(input.trustedEffectCarrier);
  const trustedAdmissionContract = trustedAdmissionCarrier
    ? durableLogicalCallContract(
      authority.acceptedTaskId,
      trustedAdmissionCarrier.toolName,
      trustedAdmissionCarrier.args,
    )
    : null;
  // Opaque provenance is authority only for THESE exact canonical bytes. A
  // trusted carrier accidentally forwarded to a sibling operation must be no
  // stronger than no carrier at all.
  const trustedAdmissionDecision = trustedAdmissionCarrier
    && contract
    && trustedAdmissionContract?.toolName === contract.toolName
    && trustedAdmissionContract.argumentDigest === contract.argumentDigest
    ? trustedAdmissionCarrier.decision
    : null;
  const admissionEffect = staged?.state.effect ?? trustedAdmissionDecision?.effect
    ?? classifyRuntimeToolEffect(input.tool, input.args).effect;
  const dispatchLease = input.dispatchLease ?? currentDispatchLease();
  if (
    dispatchLease
    && (
      dispatchLease.sessionId !== input.identity.sessionId
      || dispatchLease.sourceUserSeq !== input.identity.sourceUserSeq
      || dispatchLease.acceptedTaskId !== input.identity.acceptedTaskId
      || dispatchLease.logicalToolCallId !== input.identity.logicalToolCallId
    )
  ) {
    return { status: 'conflict', reason: 'physical dispatch lease does not own the exact logical call' };
  }
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchAdmissionResult => {
      if (dispatchLease && !isDispatchLeaseCurrent(dispatchLease)) {
        return { status: 'closed', reason: 'physical dispatch lease is no longer current' };
      }
      if (typed && authority.authorityKind !== 'turn_graph') {
        return { status: 'conflict', reason: 'typed graph reservation requires turn-graph call authority' };
      }
      if (staged) {
        const reopened = inspectStagedPhysicalDispatchAuthority(staged.authority);
        if (
          !reopened
          || reopened.authorityDigest !== staged.state.authorityDigest
          || reopened.physicalDispatchId !== input.identity.physicalDispatchId
          || reopened.logicalToolCallId !== input.identity.logicalToolCallId
          || reopened.toolName !== contract?.toolName
          || reopened.argumentDigest !== contract?.argumentDigest
          || reopened.providerArgumentDigest !== staged.state.providerArgumentDigest
          || reopened.lease.scopeId !== dispatchLease?.scopeId
          || reopened.lease.leaseId !== dispatchLease?.leaseId
        ) {
          return { status: 'conflict', reason: 'staged physical authority changed before reservation' };
        }
      }
      const stagedReservationOwner = db.prepare(`
        SELECT stage_authority_id FROM staged_transfer_stage_authorities
         WHERE session_id = ? AND source_user_seq = ?
           AND (physical_dispatch_id = ? OR logical_tool_call_id = ?)
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
        input.identity.logicalToolCallId,
      ) as { stage_authority_id: string } | undefined;
      // A copyable staged tuple is not a forgery of the host root. Refuse it
      // before ordinary host admission so the exact opaque carrier can still
      // consume the same durable attempt.
      if (stagedReservationOwner && !staged) {
        return { status: 'conflict', reason: 'staged crossing requires its exact opaque attempt authority' };
      }
      const existingLogical = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, tool_name,
               argument_digest, raw_argument_digest,
               effective_argument_digest, state
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.logicalToolCallId,
      ) as LogicalRow | undefined;
      const logicalAdmission: LogicalCallAdmissionInTransactionResult = staged
        ? existingLogical
          && existingLogical.accepted_task_id === authority.acceptedTaskId
          && existingLogical.logical_tool_call_id === input.identity.logicalToolCallId
          && existingLogical.tool_name === contract?.toolName
          && existingLogical.argument_digest === contract?.argumentDigest
          && existingLogical.state === 'open'
          ? {
              status: 'replayed',
              identity: {
                sessionId: input.identity.sessionId,
                sourceUserSeq: input.identity.sourceUserSeq,
                acceptedTaskId: authority.acceptedTaskId,
                logicalToolCallId: input.identity.logicalToolCallId,
                toolName: existingLogical.tool_name,
                argumentDigest: existingLogical.argument_digest,
              },
            }
          : { status: 'conflict', reason: 'staged logical call no longer matches its exact persisted contract' }
        : admitLogicalCallInTransaction(
            db,
            authority,
            input.identity,
            contract,
            // Provider I/O is authorized only by the current refined contract.
            // A host crossing is different: it records execution that already
            // occurred in-process, and its outer wrapper may still hold the call's
            // immutable raw contract. An already-admitted logical row is the same
            // reuse, even when the crossing itself left the machine.
            input.executionSite === 'host' || existingLogical ? 'logical' : 'physical',
            admissionEffect,
          );
      if (logicalAdmission.status !== 'inserted' && logicalAdmission.status !== 'replayed') {
        return logicalAdmission;
      }
      const tool = logicalAdmission.identity.toolName;
      const digest = logicalAdmission.identity.argumentDigest;

      // v32 action-topology backstop. The action-only carrier is activated on
      // the exact accepted graph before the model runs. Once active, a paid
      // crossing is authorized only by the immutable requirement binding for
      // this logical call. Local wrappers apply the same rule earlier for
      // clearer model correction; this database check makes a future/bypassing
      // provider adapter unable to escape it.
      const expectedWork = db.prepare(`
        SELECT expected_work_required, work_contract_id
          FROM accepted_task_authority
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.identity.sessionId, input.identity.sourceUserSeq) as {
        expected_work_required: number;
        work_contract_id: string | null;
      } | undefined;
      if (authority.authorityKind === 'turn_graph' && expectedWork?.expected_work_required === 1) {
        const binding = db.prepare(`
          SELECT 1 FROM expected_work_call_bindings
           WHERE session_id = ? AND source_user_seq = ?
             AND logical_tool_call_id = ?
             AND contract_id = ?
             AND tool_name = ? AND argument_digest = ?
        `).get(
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.identity.logicalToolCallId,
          expectedWork.work_contract_id,
          tool,
          digest,
        );
        // A READ OR COMPUTE IS NEVER GATED HERE EITHER. This backstop exists so
        // a bypassing adapter cannot make an unproposed PAID EFFECT; a status
        // read duplicates nothing. Refusing it broke the only recovery path an
        // uncertain write has (live 2026-08-12 — see the twin comment in
        // expected-work-admission.ts). The mandate below is matched on the RAW
        // carrier call: the approval card stored exactly what the user saw,
        // before logical canonicalization.
        const dispatchEffect = trustedAdmissionDecision?.effect
          ?? classifyRuntimeToolEffect(input.tool, input.args).effect;
        const gentleRead = dispatchEffect === 'read' || dispatchEffect === 'compute';
        if (!binding && !gentleRead && !approvedMandateAdmitsCall(
          db,
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.tool,
          input.args,
        )) {
          return {
            status: 'missing',
            reason: 'work_binding_required: active action dispatch has no exact frozen requirement binding',
          };
        }
      }

      const prior = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
               relation, retry_of, tool_name, argument_digest, state,
               authority_digest, provider_argument_digest, execution_site,
               staged_authority_digest, lease_scope_id, lease_id
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as DispatchRow | undefined;
      const stagedOwner = db.prepare(`
        SELECT stage_authority_id, authority_digest, provider_argument_digest,
               physical_dispatch_id, logical_tool_call_id, tool_name,
               argument_digest, lease_scope_id, lease_id
          FROM staged_transfer_stage_authorities
         WHERE session_id = ? AND source_user_seq = ?
           AND (physical_dispatch_id = ? OR logical_tool_call_id = ?)
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
        input.identity.logicalToolCallId,
      ) as {
        stage_authority_id: string;
        authority_digest: string;
        provider_argument_digest: string;
        physical_dispatch_id: string;
        logical_tool_call_id: string;
        tool_name: string;
        argument_digest: string;
        lease_scope_id: string;
        lease_id: string;
      } | undefined;
      if (stagedOwner) {
        if (
          !staged
          || stagedOwner.stage_authority_id !== staged.state.stageAuthorityId
          || stagedOwner.authority_digest !== staged.state.authorityDigest
          || stagedOwner.provider_argument_digest !== staged.state.providerArgumentDigest
          || stagedOwner.physical_dispatch_id !== input.identity.physicalDispatchId
          || stagedOwner.logical_tool_call_id !== input.identity.logicalToolCallId
          || stagedOwner.tool_name !== contract?.toolName
          || stagedOwner.argument_digest !== contract?.argumentDigest
          || stagedOwner.lease_scope_id !== dispatchLease?.scopeId
          || stagedOwner.lease_id !== dispatchLease?.leaseId
        ) {
          return { status: 'conflict', reason: 'staged crossing requires its exact opaque attempt authority' };
        }
      } else if (staged) {
        return { status: 'conflict', reason: 'staged attempt row is missing' };
      }
      if (typed?.authorityDigest) {
        const taken = db.prepare(`
          SELECT physical_dispatch_id FROM physical_dispatches
           WHERE authority_digest = ?
        `).get(typed.authorityDigest) as { physical_dispatch_id: string } | undefined;
        if (taken && taken.physical_dispatch_id !== input.identity.physicalDispatchId) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'typed authority already reserved a different physical crossing');
          return { status: 'conflict', reason: 'typed authority already reserved a different physical crossing' };
        }
      }
      if (prior) {
        const storedTyped = Boolean(
          prior.authority_digest
          || prior.provider_argument_digest
          || prior.staged_authority_digest,
        );
        const incomingTyped = Boolean(
          typed?.authorityDigest
          || typed?.providerArgumentDigest
          || staged?.state.authorityDigest,
        );
        if (storedTyped && !staged && !typed?.typedAuthorityJson && incomingTyped) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'compatibility dispatch cannot consume typed authority rows');
          return { status: 'conflict', reason: 'compatibility dispatch cannot consume typed authority rows' };
        }
        if (storedTyped && !incomingTyped) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'compatibility dispatch cannot consume typed authority rows');
          return { status: 'conflict', reason: 'compatibility dispatch cannot consume typed authority rows' };
        }
        if (storedTyped || incomingTyped) {
          const exactGraph = Boolean(
            prior.authority_digest
            && typed?.authorityDigest
            && prior.authority_digest === typed.authorityDigest
            && prior.provider_argument_digest
            && typed.providerArgumentDigest
            && prior.provider_argument_digest === typed.providerArgumentDigest
            && prior.staged_authority_digest === null,
          );
          const exactStaged = Boolean(
            staged
            && prior.authority_digest === null
            && prior.provider_argument_digest === staged.state.providerArgumentDigest
            && prior.staged_authority_digest === staged.state.authorityDigest,
          );
          if (!exactGraph && !exactStaged) {
            poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'typed authority replay requires exact digest equality');
            return { status: 'conflict', reason: 'typed authority replay requires exact digest equality' };
          }
        }
        const same = prior.accepted_task_id === authority.acceptedTaskId
          && prior.logical_tool_call_id === input.identity.logicalToolCallId
          && prior.tool_name === tool
          && prior.argument_digest === digest
          && prior.lease_scope_id === (dispatchLease?.scopeId ?? null)
          && prior.lease_id === (dispatchLease?.leaseId ?? null);
        if (!same) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'physical dispatch id conflicts with an existing crossing');
          return { status: 'conflict', reason: 'physical dispatch id conflicts with an existing crossing' };
        }
        if (typed?.typedAuthorityJson) {
          const sealedReplay = parseResolvedCallAuthority(typed.typedAuthorityJson);
          if (!sealedReplay.ok) {
            return { status: 'conflict', reason: 'typed authority envelope is not reconstructable' };
          }
          const inspectedReplay = inspectCanonicalGraphNodeLeaseInTransaction(db, sealedReplay.authority);
          if (!inspectedReplay.ok) {
            const parsed = parseCanonicalOwnerFence(sealedReplay.authority.ownerFence);
            const key = canonicalGraphNodeLeaseKey({
              sessionId: sealedReplay.authority.acceptedSource.sessionId,
              sourceUserSeq: sealedReplay.authority.acceptedSource.sourceUserSeq,
              graphId: sealedReplay.authority.graphId,
              nodeId: sealedReplay.authority.nodeId,
            });
            const lease = db.prepare(
              `SELECT owner, fence, revision, expires_at AS expiresAt, released FROM graph_node_leases WHERE lease_key = ?`,
            ).get(key) as { owner: string; fence: number; revision: number; expiresAt: number; released: number } | undefined;
            if (
              !parsed
              || !lease
              || lease.owner !== parsed.owner
              || lease.fence !== parsed.fence
              || lease.released === 1
              || lease.expiresAt <= Date.now()
              || (lease.revision !== parsed.revision && lease.revision !== parsed.revision + 1)
            ) {
              return { status: 'conflict', reason: inspectedReplay.reason };
            }
          }
        }
        return {
          status: 'replayed',
          identity: {
            ...input.identity,
            ordinal: prior.ordinal,
            relation: prior.relation,
            ...(prior.retry_of ? { retryOf: prior.retry_of } : {}),
          },
        };
      }

      const ordinal = (db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.logicalToolCallId,
      ) as { ordinal: number }).ordinal;
      const relation: DispatchRelation = input.identity.retryOf
        ? 'retry'
        : ordinal === 1 ? 'primary' : 'child';
      if (input.relation && input.relation !== relation) {
        return { status: 'conflict', reason: 'caller relation does not match the host-assigned crossing' };
      }
      if (ordinal > 1) {
        const predecessors = db.prepare(`
          SELECT state, relation FROM physical_dispatches
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).all(
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.identity.logicalToolCallId,
        ) as Array<{ state: string; relation: string }>;
        const typedEffect = typed?.typedAuthorityJson
          ? parseResolvedCallAuthority(typed.typedAuthorityJson)
          : null;
        const effect = typedEffect?.ok ? typedEffect.authority.resolvedEffect : '';
        const blocking = predecessors.some((row) => row.state === 'started' || row.state === 'unknown' || !row.state);
        if (WRITE_EFFECTS.has(effect) && blocking) {
          const retryOk = relation === 'retry' && typed?.typedAuthorityJson && typedEffect?.ok
            && exactRetryPredecessorInTransaction(db, typedEffect.authority, typed).ok;
          if (!retryOk) {
            return { status: 'conflict', reason: 'consequential write already has a started or unknown crossing' };
          }
        }
      }
      if (input.identity.retryOf) {
        const retryTarget = db.prepare(`
          SELECT state FROM physical_dispatches
           WHERE session_id = ? AND source_user_seq = ?
             AND logical_tool_call_id = ? AND physical_dispatch_id = ?
        `).get(
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.identity.logicalToolCallId,
          input.identity.retryOf,
        ) as { state: string } | undefined;
        if (!retryTarget) {
          return { status: 'conflict', reason: 'retry target is missing or still in flight' };
        }
        if (typed && (retryTarget.state === 'returned' || retryTarget.state === 'threw')) {
          return { status: 'conflict', reason: 'returned crossing cannot receive retry authority' };
        }
        if (!typed && retryTarget.state === 'started') {
          return { status: 'conflict', reason: 'retry target is missing or still in flight' };
        }
      }
      let persistOrdinal = ordinal;
      let persistRelation = relation;
      if (staged) {
        persistOrdinal = ordinal;
        persistRelation = relation;
        if (ordinal !== 1 || relation !== 'primary' || input.identity.retryOf) {
          return { status: 'conflict', reason: 'staged attempt requires one exact primary crossing' };
        }
      }
      if (typed?.typedAuthorityJson) {
        const sealed = parseResolvedCallAuthority(typed.typedAuthorityJson);
        if (!sealed.ok) {
          return { status: 'conflict', reason: 'typed authority envelope is not reconstructable' };
        }
        const derivedId = derivePhysicalDispatchId({
          sessionId: sealed.authority.acceptedSource.sessionId,
          sourceUserSeq: sealed.authority.acceptedSource.sourceUserSeq,
          graphId: sealed.authority.graphId,
          nodeId: sealed.authority.nodeId,
          logicalCallId: sealed.authority.logicalCallId,
          ordinal,
          relation,
        });
        if (
          sealed.authority.ordinal !== ordinal
          || sealed.authority.relation !== relation
          || (sealed.authority.retryOf ?? undefined) !== (input.identity.retryOf ?? undefined)
          || sealed.authority.physicalDispatchId !== derivedId
          || input.identity.physicalDispatchId !== derivedId
          || input.identity.logicalToolCallId !== sealed.authority.logicalCallId
          || input.identity.sessionId !== sealed.authority.acceptedSource.sessionId
          || input.identity.sourceUserSeq !== sealed.authority.acceptedSource.sourceUserSeq
        ) {
          return { status: 'conflict', reason: 'sealed crossing identity does not match the host-assigned crossing' };
        }
        if (sealed.authority.relation === 'retry') {
          const predecessorCheck = exactRetryPredecessorInTransaction(db, sealed.authority, typed);
          if (!predecessorCheck.ok) {
            return { status: 'conflict', reason: predecessorCheck.reason };
          }
        }
        const inspected = inspectCanonicalGraphNodeLeaseInTransaction(db, sealed.authority);
        if (!inspected.ok) {
          return { status: 'conflict', reason: inspected.reason };
        }
        persistOrdinal = sealed.authority.ordinal;
        persistRelation = sealed.authority.relation;
        if (digest !== sealed.authority.logicalArgumentDigest) {
          return { status: 'conflict', reason: 'logical argument digest does not match the prospective crossing' };
        }
        if (typed.providerArgumentDigest !== sealed.authority.canonicalArgumentDigest) {
          return { status: 'conflict', reason: 'provider argument digest does not match the sealed authority' };
        }
        const lease = consumeCanonicalGraphNodeLeaseInTransaction(db, sealed.authority);
        if (!lease.ok) {
          return { status: 'conflict', reason: lease.reason };
        }
        if (reservationInsertFaultEnabled()) {
          throw new Error('forced reservation insert failure after lease CAS');
        }
      }

      const admittedIdentity: PhysicalCrossingIdentity = {
        ...input.identity,
        ordinal: persistOrdinal,
        relation: persistRelation,
      };
      reserveWriteEvidenceDispatchInTransaction(db, {
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId: authority.acceptedTaskId,
        logicalToolCallId: input.identity.logicalToolCallId,
        physicalDispatchId: input.identity.physicalDispatchId,
        ordinal: persistOrdinal,
      });
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.identity.sessionId,
        turn: input.turn ?? authority.identity.turn,
        role: 'system',
        type: DISPATCH_STARTED_EVENT,
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          acceptedTaskId: authority.acceptedTaskId,
          logicalToolCallId: input.identity.logicalToolCallId,
          physicalDispatchId: input.identity.physicalDispatchId,
          ordinal: persistOrdinal,
          relation: persistRelation,
          ...(input.identity.retryOf ? { retryOf: input.identity.retryOf } : {}),
          tool,
          argumentDigest: digest,
        },
      });
      db.prepare(`
        INSERT INTO physical_dispatches
          (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
           physical_dispatch_id, ordinal, relation, retry_of, tool_name,
           argument_digest, state, started_at, start_event_id, execution_site,
           authority_digest, provider_argument_digest, staged_authority_digest,
           lease_scope_id, lease_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        authority.acceptedTaskId,
        input.identity.logicalToolCallId,
        input.identity.physicalDispatchId,
        persistOrdinal,
        persistRelation,
        input.identity.retryOf ?? null,
        tool,
        digest,
        mirror.createdAt,
        mirror.id,
        input.executionSite ?? null,
        typed?.authorityDigest ?? null,
        typed?.providerArgumentDigest ?? staged?.state.providerArgumentDigest ?? null,
        staged?.state.authorityDigest ?? null,
        dispatchLease?.scopeId ?? null,
        dispatchLease?.leaseId ?? null,
      );
      if (typed) {
        db.prepare(`
          INSERT INTO physical_dispatch_authority
            (session_id, source_user_seq, physical_dispatch_id,
             authority_digest, provider_argument_digest, authority_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.identity.physicalDispatchId,
          typed.authorityDigest,
          typed.providerArgumentDigest,
          null,
        );
        const sealed = parseResolvedCallAuthority(typed.typedAuthorityJson);
        if (!sealed.ok) {
          throw new Error(`typed authority envelope ${sealed.reason}`);
        }
        db.prepare(`
          INSERT INTO physical_dispatch_authority_sealed
            (session_id, source_user_seq, physical_dispatch_id,
             authority_digest, provider_argument_digest, observation_digest,
             sealed_json, byte_length, retention_class, created_at, argument_cipher)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
        `).run(
          input.identity.sessionId,
          input.identity.sourceUserSeq,
          input.identity.physicalDispatchId,
          typed.authorityDigest,
          typed.providerArgumentDigest,
          sealed.authority.observationDigest,
          typed.typedAuthorityJson,
          Buffer.byteLength(typed.typedAuthorityJson, 'utf8'),
          new Date().toISOString(),
          typed.argumentCipher,
        );
      }
      return { status: 'inserted', identity: admittedIdentity };
    });
    const result = transaction.immediate();
    if (result.status === 'inserted' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function beginTypedPhysicalDispatch(input: {
  authority: ResolvedCallAuthorityV1;
  identity: PhysicalCrossingIdentity;
  turn?: number;
  relation?: DispatchRelation;
  executionSite?: 'host';
  /** Logical ledger args. Provider-ready bytes stay in the sealed envelope. */
  ledgerArgs?: Record<string, unknown>;
}): DispatchAdmissionResult {
  const serialized = serializeResolvedCallAuthority(input.authority);
  const checked = parseResolvedCallAuthority(serialized);
  if (!checked.ok) {
    return { status: 'conflict', reason: 'typed authority envelope is not reconstructable' };
  }
  const authority = checked.authority;
  if (!typedExecutionCatalogReady()) {
    return { status: 'conflict', reason: 'typed catalog is not ready' };
  }
  const boundArgs = input.authority.canonicalArgs;
  const boundDigest = canonicalArgumentDigestOf(boundArgs);
  if (boundDigest !== authority.canonicalArgumentDigest) {
    return { status: 'conflict', reason: 'canonical argument digest does not match bound arguments' };
  }
  if (
    input.identity.sessionId !== authority.acceptedSource.sessionId
    || input.identity.sourceUserSeq !== authority.acceptedSource.sourceUserSeq
    || input.identity.acceptedTaskId !== authority.acceptedTaskId
    || input.identity.logicalToolCallId !== authority.logicalCallId
    || input.identity.physicalDispatchId !== authority.physicalDispatchId
    || (input.identity.ordinal !== undefined && input.identity.ordinal !== authority.ordinal)
    || (input.relation && input.relation !== authority.relation)
    || (input.identity.retryOf ?? undefined) !== authority.retryOf
  ) {
    return { status: 'conflict', reason: 'typed reservation identity does not match the sealed envelope' };
  }
  const derivedPhysicalId = derivePhysicalDispatchId({
    sessionId: authority.acceptedSource.sessionId,
    sourceUserSeq: authority.acceptedSource.sourceUserSeq,
    graphId: authority.graphId,
    nodeId: authority.nodeId,
    logicalCallId: authority.logicalCallId,
    ordinal: authority.ordinal,
    relation: authority.relation,
  });
  if (authority.physicalDispatchId !== derivedPhysicalId || input.identity.physicalDispatchId !== derivedPhysicalId) {
    return { status: 'conflict', reason: 'physical dispatch id does not match the host-derived crossing identity' };
  }
  const observed = independentlyObserveCapability(authority.operationId, authority.accountId);
  if (!observed) {
    return { status: 'missing', reason: 'independent_observation_unavailable' };
  }
  if (observed.origin !== 'independent' || authority.observationOrigin !== 'independent') {
    return { status: 'conflict', reason: 'typed reservation requires an independent observation' };
  }
  if (!observationIsFresh(observed) || !observationIsFresh({
    ...observed,
    observedAt: authority.observationObservedAt,
    origin: authority.observationOrigin,
  })) {
    return { status: 'conflict', reason: 'independent observation is stale' };
  }
  // The crossing observes the capability again, at a later instant. What must
  // be identical is the observed IDENTITY; the instant is freshness evidence,
  // already checked above. Requiring the volatile observedAt/observationId/
  // whole-evidence digest to match would make an admitted authority
  // unsatisfiable by its own reservation.
  if (!observedIdentityMatches(
    {
      operationId: authority.operationId,
      accountId: authority.accountId,
      definitionFingerprint: authority.liveFingerprint,
      providerVersion: authority.liveProviderVersion,
      operationVersion: authority.operationVersion,
      origin: authority.observationOrigin,
      ...(authority.observerImplementationId ? { observerImplementationId: authority.observerImplementationId } : {}),
    },
    observed,
  )) {
    return { status: 'conflict', reason: 'independent observation does not match frozen authority' };
  }
  if (
    authority.providerKind !== 'local_registry'
    && !peekProductionCapabilityPort({
      manifestId: authority.manifestId,
      manifestDigest: authority.manifestDigest,
      operationId: authority.operationId,
      definitionFingerprint: authority.liveFingerprint,
      providerKind: authority.providerKind,
      accountId: authority.accountId,
    })
  ) {
    return { status: 'conflict', reason: 'exact immutable invoke port is missing' };
  }
  if (
    (authority.resolvedEffect === 'external_write' || authority.resolvedEffect === 'local_write' || authority.resolvedEffect === 'admin')
    && (!authority.reconcilePortId || authority.reconcilePortId === authority.invokePortId)
  ) {
    return { status: 'conflict', reason: 'exact immutable reconcile port is missing' };
  }
  const shipped = verifyShippedImplementationIdentity();
  if (!shipped.ok) {
    return { status: 'conflict', reason: shipped.reason };
  }
  if (authority.invokeImplementationDigest !== shipped.digests.invoke) {
    return { status: 'conflict', reason: 'invoke implementation identity does not match the shipped artifact' };
  }
  if (authority.transportImplementationDigest !== shippedTransportDigest()) {
    return { status: 'conflict', reason: 'transport implementation identity does not match the shipped artifact' };
  }
  if (authority.reconcilePortId || authority.reconcileImplementationDigest) {
    if (authority.reconcileImplementationDigest !== shipped.digests.reconcile) {
      return { status: 'conflict', reason: 'reconcile implementation identity does not match the shipped artifact' };
    }
  }
  if (observed.observerImplementationId && authority.observerImplementationId
    && observed.observerImplementationId !== authority.observerImplementationId) {
    return { status: 'conflict', reason: 'observer implementation identity does not match frozen authority' };
  }
  const ledgerArgs = input.ledgerArgs ?? input.authority.canonicalArgs;
  const logicalContract = durableLogicalCallContract(authority.acceptedTaskId, authority.operationId, ledgerArgs);
  if (logicalContract && logicalContract.argumentDigest !== authority.logicalArgumentDigest) {
    return { status: 'conflict', reason: 'logical argument digest does not match ledger arguments' };
  }
  const openedArgs = input.authority.canonicalArgs;
  const recomputedCanonical = canonicalArgumentDigestOf(openedArgs);
  const argumentCipher = sealCanonicalArguments(openedArgs);
  const decrypted = openCanonicalArguments(argumentCipher);
  if (!decrypted) {
    return { status: 'conflict', reason: 'sealed provider arguments could not be reopened' };
  }
  const providerArgumentDigest = canonicalArgumentDigestOf(decrypted);
  const parsedSealed = parseResolvedCallAuthority(serialized);
  if (!parsedSealed.ok) {
    return { status: 'conflict', reason: 'typed authority envelope is not reconstructable' };
  }
  if (
    recomputedCanonical !== authority.canonicalArgumentDigest
    || providerArgumentDigest !== authority.canonicalArgumentDigest
    || parsedSealed.authority.authorityDigest !== authority.authorityDigest
    || parsedSealed.authority.canonicalArgumentDigest !== authority.canonicalArgumentDigest
  ) {
    return { status: 'conflict', reason: 'canonical argument digest does not match bound arguments' };
  }
  return beginPhysicalDispatchCore({
    identity: input.identity,
    tool: authority.operationId,
    args: input.ledgerArgs ?? input.authority.canonicalArgs,
    turn: input.turn,
    relation: input.relation,
    executionSite: input.executionSite,
  }, {
    authorityDigest: authority.authorityDigest,
    providerArgumentDigest,
    typedAuthorityJson: serialized,
    argumentCipher,
  });
}

export function loadPersistedCallAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
}): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: string } {
  const db = openEventLog();
  const sealed = db.prepare(`
    SELECT sealed_json AS authority_json, authority_digest, argument_cipher
      FROM physical_dispatch_authority_sealed
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.physicalDispatchId) as {
    authority_json: string;
    authority_digest: string;
    argument_cipher?: string | null;
  } | undefined;
  if (!sealed?.authority_json) {
    return { ok: false, reason: 'typed authority payload is missing' };
  }
  if (/"canonicalArgs"\s*:/.test(sealed.authority_json) && !/"argsRedacted"\s*:\s*true/.test(sealed.authority_json)) {
    return { ok: false, reason: 'plaintext authority payload is not reconstructable' };
  }
  const parsed = parseResolvedCallAuthority(sealed.authority_json);
  if (!parsed.ok) return { ok: false, reason: `typed authority payload ${parsed.reason}` };
  if (parsed.authority.authorityDigest !== sealed.authority_digest) {
    return { ok: false, reason: 'typed authority payload digest mismatch' };
  }
  if (!sealed.argument_cipher) {
    return { ok: false, reason: 'sealed provider arguments are missing' };
  }
  const args = openCanonicalArguments(sealed.argument_cipher);
  if (!args) return { ok: false, reason: 'sealed provider arguments could not be opened' };
  if (canonicalArgumentDigestOf(args) !== parsed.authority.canonicalArgumentDigest) {
    return { ok: false, reason: 'sealed provider arguments digest mismatch' };
  }
  return {
    ok: true,
    authority: { ...parsed.authority, canonicalArgs: args },
  };
}

export function authorizeTypedReconciliation(input: {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
  authority: ResolvedCallAuthorityV1;
  accountId: string;
  operationId: string;
  operationVersion: string;
  schemaFingerprint: string;
  reconcilePortId: string;
}): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: string } {
  const persisted = loadPersistedCallAuthority({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    physicalDispatchId: input.physicalDispatchId,
  });
  if (!persisted.ok) return persisted;
  const checked = parseResolvedCallAuthority(serializeResolvedCallAuthority(input.authority));
  if (!checked.ok) {
    return { ok: false, reason: 'reconciliation authority envelope is not reconstructable' };
  }
  if (checked.authority.authorityDigest !== persisted.authority.authorityDigest) {
    return { ok: false, reason: 'reconciliation authority does not match the reserved envelope' };
  }
  if (
    checked.authority.accountId !== input.accountId
    || checked.authority.operationId !== input.operationId
    || checked.authority.operationVersion !== input.operationVersion
    || checked.authority.liveFingerprint !== input.schemaFingerprint
    || !checked.authority.reconcilePortId
    || checked.authority.reconcilePortId === checked.authority.invokePortId
    || checked.authority.reconcilePortId !== input.reconcilePortId
  ) {
    return { ok: false, reason: 'reconciliation identity does not match the reserved envelope' };
  }
  const shipped = verifyShippedImplementationIdentity();
  if (!shipped.ok) {
    return { ok: false, reason: shipped.reason };
  }
  const reservedInvoke = persisted.authority.invokeImplementationDigest;
  const reservedReconcile = persisted.authority.reconcileImplementationDigest;
  if (
    reservedInvoke !== shipped.digests.invoke
    || reservedInvoke !== checked.authority.invokeImplementationDigest
    || (reservedReconcile ?? '') !== (persisted.authority.reconcilePortId ? shipped.digests.reconcile : '')
    || (reservedReconcile ?? '') !== (checked.authority.reconcileImplementationDigest ?? '')
  ) {
    return { ok: false, reason: 'reconciliation implementation does not match the reserved artifact' };
  }
  return { ok: true, authority: persisted.authority };
}

interface PhysicalDispatchSettlementInput {
  identity: PhysicalCrossingIdentity;
  tool: string;
  outcome: CrossingOutcome;
  turn?: number;
  authorityDigest?: string;
  /** Exact generation that opened the crossing. Ambient when omitted. */
  dispatchLease?: DispatchLeaseRef;
  /** Staged provider-return bytes. Required for a returned staged crossing;
   * forbidden for ordinary or non-returned crossings. The checkpoint INSERT
   * shares this settlement's transaction and therefore cannot become an
   * independent success oracle. */
  returnCheckpoint?: PreparedPhysicalReturnCheckpoint;
}

interface StagedPhysicalSettlementPersist {
  authority: StagedPhysicalDispatchAuthority;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
}

/** Ordinary/graph settlement. Copyable staged IDs cannot use this surface. */
export function settlePhysicalDispatch(
  input: PhysicalDispatchSettlementInput,
): DispatchSettlementResult {
  return settlePhysicalDispatchCore(input);
}

/** Exact staged settlement. Returned attempts require the checkpoint minted by
 * `executeStagedProviderBody`; every terminal state appends one immutable stage
 * receipt in the same transaction as the physical CAS. */
export function settleStagedPhysicalDispatch(input: {
  authority: StagedPhysicalDispatchAuthority;
  outcome: CrossingOutcome;
  turn?: number;
  returnCheckpoint?: PreparedPhysicalReturnCheckpoint;
}): DispatchSettlementResult {
  const state = inspectStagedPhysicalDispatchAuthority(input.authority);
  if (!state) return { status: 'conflict', reason: 'staged settlement authority no longer reopens' };
  return settlePhysicalDispatchCore({
    identity: {
      sessionId: state.sessionId,
      sourceUserSeq: state.sourceUserSeq,
      acceptedTaskId: state.acceptedTaskId,
      logicalToolCallId: state.logicalToolCallId,
      physicalDispatchId: state.physicalDispatchId,
      ordinal: 1,
    },
    tool: state.toolName,
    outcome: input.outcome,
    turn: input.turn,
    dispatchLease: state.lease,
    returnCheckpoint: input.returnCheckpoint,
  }, { authority: input.authority, state });
}

function settlePhysicalDispatchCore(
  input: PhysicalDispatchSettlementInput,
  staged?: StagedPhysicalSettlementPersist,
): DispatchSettlementResult {
  const tool = safeToolName(input.tool);
  if (!tool) return { status: 'conflict', reason: 'dispatch tool identity is unsafe' };
  if (settlementStorageFault) {
    return { status: 'storage_error', reason: 'forced settlement storage failure' };
  }
  const dispatchLease = input.dispatchLease ?? currentDispatchLease();
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchSettlementResult => {
      const row = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
               relation, retry_of, tool_name, argument_digest, state, authority_digest,
               provider_argument_digest, staged_authority_digest,
               execution_site, lease_scope_id, lease_id
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as DispatchRow | undefined;
      if (!row) return { status: 'missing', reason: 'physical dispatch start is missing' };
      if (row.staged_authority_digest) {
        const reopened = staged
          ? inspectStagedPhysicalDispatchAuthority(staged.authority)
          : null;
        if (
          !staged
          || !reopened
          || reopened.authorityDigest !== row.staged_authority_digest
          || reopened.authorityDigest !== staged.state.authorityDigest
          || reopened.providerArgumentDigest !== row.provider_argument_digest
          || reopened.physicalDispatchId !== row.physical_dispatch_id
          || reopened.logicalToolCallId !== row.logical_tool_call_id
        ) {
          return { status: 'conflict', reason: 'staged crossing requires its exact opaque settlement authority' };
        }
      } else if (staged) {
        return { status: 'conflict', reason: 'staged settlement authority does not own this crossing' };
      }
      if (row.lease_scope_id !== null || row.lease_id !== null) {
        if (
          !dispatchLease
          || row.lease_scope_id !== dispatchLease.scopeId
          || row.lease_id !== dispatchLease.leaseId
          || dispatchLease.sessionId !== input.identity.sessionId
          || dispatchLease.sourceUserSeq !== input.identity.sourceUserSeq
          || dispatchLease.acceptedTaskId !== input.identity.acceptedTaskId
          || dispatchLease.logicalToolCallId !== input.identity.logicalToolCallId
          || !isDispatchLeaseCurrent(dispatchLease)
        ) {
          return { status: 'closed', reason: 'physical settlement lease is no longer current' };
        }
      }
      if (row.authority_digest) {
        if (!input.authorityDigest || input.authorityDigest !== row.authority_digest) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'settlement authority digest does not match the reservation');
          return { status: 'conflict', reason: 'settlement authority digest does not match the reservation' };
        }
      }
      if (
        row.accepted_task_id !== input.identity.acceptedTaskId
        || row.logical_tool_call_id !== input.identity.logicalToolCallId
        || row.tool_name !== tool
      ) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'physical settlement conflicts with its start');
        return { status: 'conflict', reason: 'physical settlement conflicts with its start' };
      }
      const stagedReturnIdentity = stagedPhysicalReturnCheckpointIdentity(db, {
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId: input.identity.acceptedTaskId,
        logicalToolCallId: input.identity.logicalToolCallId,
        physicalDispatchId: input.identity.physicalDispatchId,
        toolName: tool,
        argumentDigest: row.argument_digest,
        leaseScopeId: row.lease_scope_id,
        leaseId: row.lease_id,
      });
      if (input.returnCheckpoint && input.outcome !== 'returned') {
        return { status: 'conflict', reason: 'a physical return checkpoint requires a returned outcome' };
      }
      if (stagedReturnIdentity) {
        if (
          input.outcome === 'returned'
          && (!input.returnCheckpoint
            || !preparedPhysicalReturnCheckpointOwns(input.returnCheckpoint, stagedReturnIdentity))
        ) {
          return { status: 'conflict', reason: 'returned staged dispatch requires its exact physical return checkpoint' };
        }
      } else if (input.returnCheckpoint) {
        return { status: 'conflict', reason: 'physical return checkpoint does not own this crossing' };
      }
      if (row.state !== 'started') {
        if (row.state !== input.outcome) {
          return { status: 'conflict', reason: `crossing already settled as ${row.state}` };
        }
        if (
          input.returnCheckpoint
          && !persistedPhysicalReturnCheckpointOwns(db, input.returnCheckpoint)
        ) {
          return { status: 'conflict', reason: 'replayed physical return checkpoint does not match durable authority' };
        }
        if (staged) {
          const receipt = db.prepare(`
            SELECT terminal_state, result_digest
              FROM staged_transfer_stage_receipts
             WHERE stage_authority_id = ?
          `).get(staged.state.stageAuthorityId) as {
            terminal_state: string;
            result_digest: string | null;
          } | undefined;
          if (!receipt || receipt.terminal_state !== input.outcome) {
            return { status: 'conflict', reason: 'staged settlement replay lacks its exact terminal receipt' };
          }
        }
        return { status: 'replayed' };
      }
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.identity.sessionId,
        turn: input.turn ?? 0,
        role: 'system',
        type: DISPATCH_SETTLED_EVENT,
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          acceptedTaskId: input.identity.acceptedTaskId,
          logicalToolCallId: input.identity.logicalToolCallId,
          physicalDispatchId: input.identity.physicalDispatchId,
          ordinal: row.ordinal,
          relation: row.relation,
          ...(row.retry_of ? { retryOf: row.retry_of } : {}),
          tool,
          outcome: input.outcome,
        },
      });
      const updated = db.prepare(`
        UPDATE physical_dispatches
           SET state = ?, settled_at = ?, settle_event_id = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND physical_dispatch_id = ? AND state = 'started'
      `).run(
        input.outcome,
        mirror.createdAt,
        mirror.id,
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      );
      if (updated.changes !== 1) throw new Error('physical dispatch settlement lost its CAS');
      if (input.returnCheckpoint) {
        insertPreparedPhysicalReturnCheckpointInTransaction(db, input.returnCheckpoint);
      } else if (staged) {
        const receipt = db.prepare(`
          INSERT INTO staged_transfer_stage_receipts
            (stage_authority_id, stage_id, plan_id, session_id, source_user_seq,
             stage_ordinal, attempt_ordinal, physical_dispatch_id, terminal_state,
             result_digest, recorded_at)
          SELECT authority.stage_authority_id, authority.stage_id, authority.plan_id,
                 authority.session_id, authority.source_user_seq,
                 authority.stage_ordinal, authority.attempt_ordinal,
                 authority.physical_dispatch_id, ?, NULL, ?
            FROM staged_transfer_stage_authorities authority
           WHERE authority.stage_authority_id = ?
        `).run(input.outcome, mirror.createdAt, staged.state.stageAuthorityId);
        if (receipt.changes !== 1) throw new Error('staged terminal receipt lost its exact authority');
      }
      db.prepare(`
        UPDATE physical_dispatch_authority_sealed
           SET retention_class = 'settled'
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).run(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      );
      return { status: 'inserted' };
    });
    const result = transaction.immediate();
    if (result.status === 'inserted' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type StoppedDispatchOutcome = Extract<
  CrossingOutcome,
  'timed_out' | 'cancelled' | 'unknown'
>;

export type DispatchLeaseTerminalizationResult =
  | { status: 'inserted' | 'replayed'; settled: number; physicalDispatchIds: string[] }
  | { status: 'closed' | 'missing' | 'conflict' | 'storage_error'; reason: string };

/**
 * Close every still-started crossing owned by one exact, already-revoked call
 * generation. This is the only API allowed to terminalize a detached body: it
 * cannot address a newer generation and it commits every terminal row before
 * the host is permitted to recover.
 */
export function settleStartedPhysicalDispatchesForLease(input: {
  lease: DispatchLeaseRef;
  outcome: StoppedDispatchOutcome;
  turn?: number;
}): DispatchLeaseTerminalizationResult {
  const { lease } = input;
  if (
    lease.sourceUserSeq === undefined
    || !lease.acceptedTaskId
    || !lease.logicalToolCallId
  ) {
    return { status: 'conflict', reason: 'terminalization requires an exact call-bound lease' };
  }
  if (settlementStorageFault) {
    return { status: 'storage_error', reason: 'forced settlement storage failure' };
  }
  const db = openEventLog();
  const mirrors: EventRow[] = [];
  try {
    const transaction = db.transaction((): DispatchLeaseTerminalizationResult => {
      const owner = db.prepare(`
        SELECT revoked_at, source_user_seq, accepted_task_id, logical_tool_call_id
          FROM run_dispatch_leases
         WHERE session_id = ? AND scope_id = ? AND lease_id = ?
      `).get(lease.sessionId, lease.scopeId, lease.leaseId) as {
        revoked_at: string | null;
        source_user_seq: number | null;
        accepted_task_id: string | null;
        logical_tool_call_id: string | null;
      } | undefined;
      if (!owner) return { status: 'missing', reason: 'dispatch lease generation is missing' };
      if (
        owner.revoked_at === null
        || owner.source_user_seq !== lease.sourceUserSeq
        || owner.accepted_task_id !== lease.acceptedTaskId
        || owner.logical_tool_call_id !== lease.logicalToolCallId
      ) {
        return { status: 'conflict', reason: 'dispatch lease is not the exact revoked call generation' };
      }
      const rows = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id,
               ordinal, relation, retry_of, tool_name, argument_digest, state,
               authority_digest, provider_argument_digest, staged_authority_digest,
               execution_site, lease_scope_id, lease_id
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
           AND lease_scope_id = ? AND lease_id = ?
         ORDER BY logical_tool_call_id, ordinal, physical_dispatch_id
      `).all(
        lease.sessionId,
        lease.sourceUserSeq,
        lease.scopeId,
        lease.leaseId,
      ) as DispatchRow[];
      if (!rows.length) {
        return { status: 'missing', reason: 'revoked dispatch lease owns no physical crossing' };
      }
      if (rows.some((row) => (
        row.accepted_task_id !== lease.acceptedTaskId
        || row.logical_tool_call_id !== lease.logicalToolCallId
        || row.lease_scope_id !== lease.scopeId
        || row.lease_id !== lease.leaseId
      ))) {
        return { status: 'conflict', reason: 'dispatch rows contradict their lease owner' };
      }
      const started = rows.filter((row) => row.state === 'started');
      for (const row of started) {
        const mirror = insertInternalEventInTransaction(db, {
          sessionId: lease.sessionId,
          turn: input.turn ?? 0,
          role: 'system',
          type: DISPATCH_SETTLED_EVENT,
          data: {
            sourceUserSeq: lease.sourceUserSeq,
            acceptedTaskId: lease.acceptedTaskId,
            logicalToolCallId: lease.logicalToolCallId,
            physicalDispatchId: row.physical_dispatch_id,
            ordinal: row.ordinal,
            relation: row.relation,
            ...(row.retry_of ? { retryOf: row.retry_of } : {}),
            tool: row.tool_name,
            outcome: input.outcome,
          },
        });
        const updated = db.prepare(`
          UPDATE physical_dispatches
             SET state = ?, settled_at = ?, settle_event_id = ?
           WHERE session_id = ? AND source_user_seq = ?
             AND physical_dispatch_id = ? AND lease_scope_id = ? AND lease_id = ?
             AND state = 'started'
        `).run(
          input.outcome,
          mirror.createdAt,
          mirror.id,
          lease.sessionId,
          lease.sourceUserSeq,
          row.physical_dispatch_id,
          lease.scopeId,
          lease.leaseId,
        );
        if (updated.changes !== 1) throw new Error('lease terminalization lost its physical CAS');
        if (row.staged_authority_digest) {
          const receipt = db.prepare(`
            INSERT INTO staged_transfer_stage_receipts
              (stage_authority_id, stage_id, plan_id, session_id, source_user_seq,
               stage_ordinal, attempt_ordinal, physical_dispatch_id, terminal_state,
               result_digest, recorded_at)
            SELECT authority.stage_authority_id, authority.stage_id, authority.plan_id,
                   authority.session_id, authority.source_user_seq,
                   authority.stage_ordinal, authority.attempt_ordinal,
                   authority.physical_dispatch_id, ?, NULL, ?
              FROM staged_transfer_stage_authorities authority
             WHERE authority.session_id = ? AND authority.source_user_seq = ?
               AND authority.physical_dispatch_id = ?
               AND authority.authority_digest = ?
          `).run(
            input.outcome,
            mirror.createdAt,
            lease.sessionId,
            lease.sourceUserSeq,
            row.physical_dispatch_id,
            row.staged_authority_digest,
          );
          if (receipt.changes !== 1) throw new Error('lease terminalization lost its staged receipt authority');
        }
        db.prepare(`
          UPDATE physical_dispatch_authority_sealed
             SET retention_class = 'settled'
           WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
        `).run(lease.sessionId, lease.sourceUserSeq, row.physical_dispatch_id);
        mirrors.push(mirror);
      }
      return {
        status: started.length ? 'inserted' : 'replayed',
        settled: started.length,
        physicalDispatchIds: rows.map((row) => row.physical_dispatch_id),
      };
    });
    const result = transaction.immediate();
    if (result.status === 'inserted') {
      for (const mirror of mirrors) publishCommittedInternalEvent(mirror);
    }
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Compatibility wrappers while callers move to typed results. */
export function recordDispatchStarted(input: {
  identity: PhysicalCrossingIdentity;
  tool: string;
  args?: unknown;
  turn?: number;
}): boolean {
  return beginPhysicalDispatch(input).status === 'inserted';
}

export function recordDispatchSettled(input: {
  identity: PhysicalCrossingIdentity;
  tool: string;
  outcome: CrossingOutcome;
  turn?: number;
}): boolean {
  const result = settlePhysicalDispatch(input);
  return result.status === 'inserted' || result.status === 'replayed';
}

export interface PhysicalCrossing {
  physicalDispatchId: string;
  logicalToolCallId: string;
  ordinal: number;
  relation: DispatchRelation;
  retryOf?: string;
  tool: string;
  outcome?: CrossingOutcome;
  settled: boolean;
  executionSite?: 'host';
  leaseScopeId?: string;
  leaseId?: string;
}

/** Every crossing this accepted task paid for, in database-assigned order. */
export function physicalCrossingsFor(
  sessionId: string,
  sourceUserSeq: number,
): PhysicalCrossing[] {
  try {
    return (openEventLog().prepare(`
      SELECT physical_dispatch_id, logical_tool_call_id, ordinal, relation,
             retry_of, tool_name, state, execution_site, lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id, ordinal
    `).all(sessionId, sourceUserSeq) as Array<{
      physical_dispatch_id: string;
      logical_tool_call_id: string;
      ordinal: number;
      relation: DispatchRelation;
      retry_of: string | null;
      tool_name: string;
      state: DispatchRow['state'];
      execution_site: 'host' | null;
      lease_scope_id: string | null;
      lease_id: string | null;
    }>).map((row) => ({
      physicalDispatchId: row.physical_dispatch_id,
      logicalToolCallId: row.logical_tool_call_id,
      ordinal: row.ordinal,
      relation: row.relation,
      ...(row.retry_of ? { retryOf: row.retry_of } : {}),
      tool: row.tool_name,
      ...(row.state !== 'started' ? { outcome: row.state } : {}),
      settled: row.state !== 'started',
      ...(row.execution_site === 'host' ? { executionSite: 'host' as const } : {}),
      ...(row.lease_scope_id ? { leaseScopeId: row.lease_scope_id } : {}),
      ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    }));
  } catch {
    return [];
  }
}

/** Paid crossings owned by one logical call, in authoritative ordinal order. */
export function physicalCrossingsForLogicalCall(
  sessionId: string,
  sourceUserSeq: number,
  logicalToolCallId: string,
): PhysicalCrossing[] {
  return physicalCrossingsFor(sessionId, sourceUserSeq)
    .filter((crossing) => crossing.logicalToolCallId === logicalToolCallId)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** Settled reserved crossings age out after 14 days. */
export const SETTLED_AUTHORITY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Archived sessions keep sealed rows for 7 days, then the reaper deletes them. */
export const ARCHIVED_AUTHORITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let settlementStorageFault = false;

export function setSettlementStorageFault(enabled: boolean): void {
  settlementStorageFault = enabled;
}

export function deleteAuthorityPayloadsForSession(sessionId: string): number {
  const db = openEventLog();
  const deleted = db.transaction(() => {
    const sealed = db.prepare(`DELETE FROM physical_dispatch_authority_sealed WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM physical_dispatch_authority_payload WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM physical_dispatch_authority WHERE session_id = ?`).run(sessionId);
    return sealed.changes;
  })();
  return deleted;
}

export function permanentlyDeleteSessionAuthorityPayloads(sessionId: string): number {
  return deleteAuthorityPayloadsForSession(sessionId);
}

export function archiveAuthorityPayloadsForSession(sessionId: string): number {
  const db = openEventLog();
  const result = db.prepare(`
    UPDATE physical_dispatch_authority_sealed
       SET retention_class = 'archived'
     WHERE session_id = ?
  `).run(sessionId);
  return result.changes;
}

export function retainUncertainReconciliationMaterial(input: {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
}): void {
  const db = openEventLog();
  db.transaction(() => {
    db.prepare(`
      UPDATE physical_dispatch_authority_sealed
         SET retention_class = 'uncertain'
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).run(input.sessionId, input.sourceUserSeq, input.physicalDispatchId);
    db.prepare(`
      DELETE FROM physical_dispatch_authority_payload
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).run(input.sessionId, input.sourceUserSeq, input.physicalDispatchId);
    db.prepare(`
      UPDATE physical_dispatch_authority
         SET authority_json = NULL
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).run(input.sessionId, input.sourceUserSeq, input.physicalDispatchId);
  })();
}

export function reapSettledAuthorityPayloads(now = Date.now()): number {
  const db = openEventLog();
  const settledCutoff = new Date(now - SETTLED_AUTHORITY_RETENTION_MS).toISOString();
  const archivedCutoff = new Date(now - ARCHIVED_AUTHORITY_RETENTION_MS).toISOString();
  const settled = db.prepare(`
    DELETE FROM physical_dispatch_authority_sealed
     WHERE retention_class = 'settled' AND created_at < ?
  `).run(settledCutoff);
  const archived = db.prepare(`
    DELETE FROM physical_dispatch_authority_sealed
     WHERE retention_class = 'archived' AND created_at < ?
  `).run(archivedCutoff);
  return settled.changes + archived.changes;
}

export function markAuthorityRetention(input: {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
  retentionClass: 'reserved' | 'settled' | 'blocked' | 'uncertain' | 'archived';
}): void {
  const db = openEventLog();
  db.prepare(`
    UPDATE physical_dispatch_authority_sealed
       SET retention_class = ?
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).run(input.retentionClass, input.sessionId, input.sourceUserSeq, input.physicalDispatchId);
  if (input.retentionClass === 'uncertain') {
    retainUncertainReconciliationMaterial(input);
  }
}
