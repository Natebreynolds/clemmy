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
export { derivePhysicalDispatchId } from './physical-crossing-identity.js';

const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);
const SETTLED_CROSSING_STATES = new Set(['returned', 'threw']);
const SAFE_RETRY_STATES = new Set(['started']);
const SAFE_RETRY_REASONS = new Set(['uncertain_recovery', 'owner_lost', 'explicit_retry']);

export function retryDispositionFor(
  state: string,
  effect: string,
  reason: string | undefined,
): 'allow' | 'require_reconciliation' | 'refuse' {
  if (SETTLED_CROSSING_STATES.has(state)) return 'refuse';
  if (WRITE_EFFECTS.has(effect) && (state === 'started' || state === 'unknown' || !state)) {
    return 'require_reconciliation';
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

export type CrossingOutcome = 'returned' | 'threw';

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
  state: 'started' | CrossingOutcome | 'timed_out' | 'cancelled' | 'unknown';
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
  { status: 'missing' | 'storage_error' }
>;

/**
 * The one logical-call admission implementation used both before a gate and
 * immediately before a paid crossing. The caller owns the surrounding
 * transaction so physical-dispatch admission can extend the same authority
 * decision without a check/append race.
 */
function admitLogicalCallInTransaction(
  db: ReturnType<typeof openEventLog>,
  expected: AcceptedTaskExpectation,
  input: DurableLogicalCallIdentity,
  contract: DurableLogicalCallContract | null,
  phase: 'logical' | 'physical',
): LogicalCallAdmissionInTransactionResult {
  const logicalToolCallId = safeLogicalToolCallId(input.logicalToolCallId);
  let open: boolean;
  try {
    open = ensureAcceptedTaskResolutionOpenInTransaction(db, expected);
  } catch (error) {
    const reason = boundedReason(error);
    if (reason.includes('conflicts with its persisted graph') || reason.includes('is ambiguous')) {
      poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId ?? undefined, reason);
      return { status: 'conflict', reason };
    }
    throw error;
  }
  if (!open) return { status: 'closed', reason: 'accepted task resolution is closed' };
  if (
    input.acceptedTaskId !== expected.acceptedTaskId
    || input.sessionId !== expected.identity.sessionId
    || input.sourceUserSeq !== expected.identity.sourceUserSeq
    || !logicalToolCallId
  ) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId ?? undefined, 'logical call names a different accepted task or unsafe identity');
    return { status: 'conflict', reason: 'logical call names a different accepted task or unsafe identity' };
  }
  if (!contract) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId, 'logical call tool identity is unsafe');
    return { status: 'conflict', reason: 'logical call tool identity is unsafe' };
  }

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

  const identity: AdmittedLogicalCall = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: expected.acceptedTaskId,
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
      expected.acceptedTaskId,
      logicalToolCallId,
      contract.toolName,
      contract.argumentDigest,
      contract.argumentDigest,
      new Date().toISOString(),
    );
    return { status: 'inserted', identity };
  }

  if (!logicalMatches(row, expected.acceptedTaskId, contract.toolName, contract.argumentDigest, phase)) {
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
  | { status: 'ok'; expectation: AcceptedTaskExpectation }
  | Extract<LogicalCallAdmissionResult, { status: 'missing' | 'conflict' | 'storage_error' }> {
  const expected = expectedTaskFor(sessionId, sourceUserSeq);
  if (expected.status === 'ok') return { status: 'ok', expectation: expected.expectation };
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
  const expected = expectedState.expectation;
  const contract = durableLogicalCallContract(expected.acceptedTaskId, input.tool, input.args);
  try {
    const db = openEventLog();
    const transaction = db.transaction((): LogicalCallAdmissionInTransactionResult => {
      return admitLogicalCallInTransaction(db, expected, input.identity, contract, 'logical');
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
  const expected = expectedState.expectation;
  const logicalToolCallId = safeLogicalToolCallId(input.identity.logicalToolCallId);
  const effective = durableLogicalCallContract(
    expected.acceptedTaskId,
    input.tool,
    input.effectiveArgs,
  );
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): LogicalCallRefinementResult => {
      const resolution = db.prepare(`
        SELECT accepted_task_id, state
          FROM accepted_task_resolutions
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.identity.sessionId, input.identity.sourceUserSeq) as {
        accepted_task_id: string;
        state: 'open' | 'finalized' | 'legacy_ambiguous';
      } | undefined;
      if (!resolution) return { status: 'missing', reason: 'accepted task resolution is missing' };
      if (resolution.state === 'legacy_ambiguous') {
        return { status: 'conflict', reason: 'accepted task resolution is ambiguous' };
      }
      if (resolution.state !== 'open') {
        return { status: 'closed', reason: 'accepted task resolution is closed' };
      }
      if (
        input.identity.acceptedTaskId !== expected.acceptedTaskId
        || resolution.accepted_task_id !== expected.acceptedTaskId
        || input.identity.sessionId !== expected.identity.sessionId
        || input.identity.sourceUserSeq !== expected.identity.sourceUserSeq
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
      if (
        row.accepted_task_id !== expected.acceptedTaskId
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
        acceptedTaskId: expected.acceptedTaskId,
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
        turn: input.turn ?? expected.identity.turn,
        role: 'system',
        type: LOGICAL_CALL_CONTRACT_REFINED_EVENT,
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          acceptedTaskId: expected.acceptedTaskId,
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
      SELECT l.accepted_task_id, l.state, l.conflict_reason, r.state AS resolution_state
        FROM logical_tool_calls l
        JOIN accepted_task_resolutions r
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
      resolution_state: 'open' | 'finalized' | 'legacy_ambiguous';
    } | undefined;
    if (!row) return { status: 'missing', reason: 'logical call authority is missing' };
    if (row.accepted_task_id !== identity.acceptedTaskId || row.state === 'conflict') {
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
    if (row.resolution_state === 'legacy_ambiguous') {
      return { status: 'conflict', reason: 'accepted task resolution is ambiguous' };
    }
    if (row.resolution_state !== 'open' && row.state === 'open') {
      return { status: 'closed', reason: 'accepted task resolution closed before logical settlement' };
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
}

interface TypedPhysicalDispatchPersist {
  authorityDigest: string;
  providerArgumentDigest: string;
  typedAuthorityJson: string;
  argumentCipher: string;
}

/**
 * Compatibility reservation. Cannot persist typed authority rows even if a
 * caller smuggles digest fields on the object.
 */
export function beginPhysicalDispatch(input: CompatibilityPhysicalDispatchInput): DispatchAdmissionResult {
  return beginPhysicalDispatchCore(input);
}

function beginPhysicalDispatchCore(
  input: CompatibilityPhysicalDispatchInput,
  typed?: TypedPhysicalDispatchPersist,
): DispatchAdmissionResult {
  const expectedState = expectedForAdmission(input.identity.sessionId, input.identity.sourceUserSeq);
  if (expectedState.status !== 'ok') return expectedState;
  const expected = expectedState.expectation;
  const contract = durableLogicalCallContract(expected.acceptedTaskId, input.tool, input.args);
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchAdmissionResult => {
      const existingLogical = db.prepare(`
        SELECT 1 FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.logicalToolCallId,
      );
      const logicalAdmission = admitLogicalCallInTransaction(
        db,
        expected,
        input.identity,
        contract,
        // Provider I/O is authorized only by the current refined contract.
        // A host crossing is different: it records execution that already
        // occurred in-process, and its outer wrapper may still hold the call's
        // immutable raw contract. An already-admitted logical row is the same
        // reuse, even when the crossing itself left the machine.
        input.executionSite === 'host' || existingLogical ? 'logical' : 'physical',
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
      if (expectedWork?.expected_work_required === 1) {
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
        const trustedCarrier = inspectTrustedRuntimeEffectCarrier(input.trustedEffectCarrier);
        // Provenance is useful only when it describes THESE exact canonical
        // bytes. This prevents a host wiring mistake from reusing a read
        // carrier to bless another provider call. The wrapper and bare provider
        // forms intentionally share one durable contract, while the row below
        // continues to store the bare tool/digest supplied at the dispatch edge.
        const trustedContract = trustedCarrier
          ? durableLogicalCallContract(
            expected.acceptedTaskId,
            trustedCarrier.toolName,
            trustedCarrier.args,
          )
          : null;
        const trustedDecision = trustedCarrier
          && trustedContract?.toolName === tool
          && trustedContract.argumentDigest === digest
          ? trustedCarrier.decision
          : null;
        const dispatchEffect = trustedDecision?.effect
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
               authority_digest, provider_argument_digest
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as (DispatchRow & { authority_digest?: string | null; provider_argument_digest?: string | null }) | undefined;
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
        const storedTyped = Boolean(prior.authority_digest || prior.provider_argument_digest);
        const incomingTyped = Boolean(typed?.authorityDigest || typed?.providerArgumentDigest);
        if (storedTyped && !typed?.typedAuthorityJson && incomingTyped) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'compatibility dispatch cannot consume typed authority rows');
          return { status: 'conflict', reason: 'compatibility dispatch cannot consume typed authority rows' };
        }
        if (storedTyped && !incomingTyped) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'compatibility dispatch cannot consume typed authority rows');
          return { status: 'conflict', reason: 'compatibility dispatch cannot consume typed authority rows' };
        }
        if (storedTyped || incomingTyped) {
          if (
            !prior.authority_digest
            || !typed?.authorityDigest
            || prior.authority_digest !== typed.authorityDigest
            || !prior.provider_argument_digest
            || !typed.providerArgumentDigest
            || prior.provider_argument_digest !== typed.providerArgumentDigest
          ) {
            poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId, 'typed authority replay requires exact digest equality');
            return { status: 'conflict', reason: 'typed authority replay requires exact digest equality' };
          }
        }
        const same = prior.accepted_task_id === expected.acceptedTaskId
          && prior.logical_tool_call_id === input.identity.logicalToolCallId
          && prior.tool_name === tool
          && prior.argument_digest === digest;
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
        acceptedTaskId: expected.acceptedTaskId,
        logicalToolCallId: input.identity.logicalToolCallId,
        physicalDispatchId: input.identity.physicalDispatchId,
        ordinal: persistOrdinal,
      });
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.identity.sessionId,
        turn: input.turn ?? expected.identity.turn,
        role: 'system',
        type: DISPATCH_STARTED_EVENT,
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          acceptedTaskId: expected.acceptedTaskId,
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
           authority_digest, provider_argument_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?)
      `).run(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        expected.acceptedTaskId,
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
        typed?.providerArgumentDigest ?? null,
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

/** Atomically close one exact crossing. */
export function settlePhysicalDispatch(input: {
  identity: PhysicalCrossingIdentity;
  tool: string;
  outcome: CrossingOutcome;
  turn?: number;
  authorityDigest?: string;
}): DispatchSettlementResult {
  const tool = safeToolName(input.tool);
  if (!tool) return { status: 'conflict', reason: 'dispatch tool identity is unsafe' };
  if (settlementStorageFault) {
    return { status: 'storage_error', reason: 'forced settlement storage failure' };
  }
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchSettlementResult => {
      const row = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
               relation, retry_of, tool_name, argument_digest, state, authority_digest
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as (DispatchRow & { authority_digest?: string | null }) | undefined;
      if (!row) return { status: 'missing', reason: 'physical dispatch start is missing' };
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
      if (row.state !== 'started') {
        return row.state === input.outcome
          ? { status: 'replayed' }
          : { status: 'conflict', reason: `crossing already settled as ${row.state}` };
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
}

/** Every crossing this accepted task paid for, in database-assigned order. */
export function physicalCrossingsFor(
  sessionId: string,
  sourceUserSeq: number,
): PhysicalCrossing[] {
  try {
    return (openEventLog().prepare(`
      SELECT physical_dispatch_id, logical_tool_call_id, ordinal, relation,
             retry_of, tool_name, state
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
    }>).map((row) => ({
      physicalDispatchId: row.physical_dispatch_id,
      logicalToolCallId: row.logical_tool_call_id,
      ordinal: row.ordinal,
      relation: row.relation,
      ...(row.retry_of ? { retryOf: row.retry_of } : {}),
      tool: row.tool_name,
      ...(row.state === 'returned' || row.state === 'threw' ? { outcome: row.state } : {}),
      settled: row.state !== 'started',
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
