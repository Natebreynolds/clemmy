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
): void {
  db.prepare(`
    UPDATE accepted_task_resolutions
       SET state = 'legacy_ambiguous', revision = revision + 1
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).run(sessionId, sourceUserSeq);
  if (logicalToolCallId) {
    db.prepare(`
      UPDATE logical_tool_calls SET state = 'conflict'
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(sessionId, sourceUserSeq, logicalToolCallId);
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
      poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId ?? undefined);
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
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId ?? undefined);
    return { status: 'conflict', reason: 'logical call names a different accepted task or unsafe identity' };
  }
  if (!contract) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId);
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

  if (
    !logicalMatches(row, expected.acceptedTaskId, contract.toolName, contract.argumentDigest, phase)
    || row.state !== 'open'
  ) {
    poisonResolution(db, input.sessionId, input.sourceUserSeq, logicalToolCallId);
    return { status: 'conflict', reason: 'logical call identity conflicts with its durable contract' };
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
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId ?? undefined);
        return { status: 'conflict', reason: 'contract refinement names a different accepted task or unsafe identity' };
      }
      if (!effective) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId);
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
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId);
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
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, logicalToolCallId);
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
export function beginPhysicalDispatch(input: {
  identity: PhysicalCrossingIdentity;
  tool: string;
  args?: unknown;
  turn?: number;
  relation?: DispatchRelation;
  /** 'host' when the crossing is the host invoking a tool in-process. NULL
   *  (the default) keeps its historical meaning: it left the machine. */
  executionSite?: 'host';
}): DispatchAdmissionResult {
  const expectedState = expectedForAdmission(input.identity.sessionId, input.identity.sourceUserSeq);
  if (expectedState.status !== 'ok') return expectedState;
  const expected = expectedState.expectation;
  const contract = durableLogicalCallContract(expected.acceptedTaskId, input.tool, input.args);
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchAdmissionResult => {
      const logicalAdmission = admitLogicalCallInTransaction(
        db,
        expected,
        input.identity,
        contract,
        'physical',
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
        if (!binding) {
          return {
            status: 'missing',
            reason: 'work_binding_required: active action dispatch has no exact frozen requirement binding',
          };
        }
      }

      const prior = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
               relation, retry_of, tool_name, argument_digest, state
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as DispatchRow | undefined;
      if (prior) {
        const same = prior.accepted_task_id === expected.acceptedTaskId
          && prior.logical_tool_call_id === input.identity.logicalToolCallId
          && prior.tool_name === tool
          && prior.argument_digest === digest;
        if (!same) {
          poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId);
          return { status: 'conflict', reason: 'physical dispatch id conflicts with an existing crossing' };
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
      const relation: DispatchRelation = input.relation
        ?? (input.identity.retryOf ? 'retry' : ordinal === 1 ? 'primary' : 'child');
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
        if (!retryTarget || retryTarget.state === 'started') {
          return { status: 'conflict', reason: 'retry target is missing or still in flight' };
        }
      }

      const admittedIdentity: PhysicalCrossingIdentity = {
        ...input.identity,
        ordinal,
        relation,
      };
      reserveWriteEvidenceDispatchInTransaction(db, {
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId: expected.acceptedTaskId,
        logicalToolCallId: input.identity.logicalToolCallId,
        physicalDispatchId: input.identity.physicalDispatchId,
        ordinal,
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
          ordinal,
          relation,
          ...(input.identity.retryOf ? { retryOf: input.identity.retryOf } : {}),
          tool,
          argumentDigest: digest,
        },
      });
      db.prepare(`
        INSERT INTO physical_dispatches
          (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
           physical_dispatch_id, ordinal, relation, retry_of, tool_name,
           argument_digest, state, started_at, start_event_id, execution_site)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)
      `).run(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        expected.acceptedTaskId,
        input.identity.logicalToolCallId,
        input.identity.physicalDispatchId,
        ordinal,
        relation,
        input.identity.retryOf ?? null,
        tool,
        digest,
        mirror.createdAt,
        mirror.id,
        input.executionSite ?? null,
      );
      return { status: 'inserted', identity: admittedIdentity };
    });
    const result = transaction.immediate();
    if (result.status === 'inserted' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Atomically close one exact crossing. */
export function settlePhysicalDispatch(input: {
  identity: PhysicalCrossingIdentity;
  tool: string;
  outcome: CrossingOutcome;
  turn?: number;
}): DispatchSettlementResult {
  const tool = safeToolName(input.tool);
  if (!tool) return { status: 'conflict', reason: 'dispatch tool identity is unsafe' };
  const db = openEventLog();
  let mirror: EventRow | null = null;
  try {
    const transaction = db.transaction((): DispatchSettlementResult => {
      const row = db.prepare(`
        SELECT accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
               relation, retry_of, tool_name, argument_digest, state
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
      `).get(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        input.identity.physicalDispatchId,
      ) as DispatchRow | undefined;
      if (!row) return { status: 'missing', reason: 'physical dispatch start is missing' };
      if (
        row.accepted_task_id !== input.identity.acceptedTaskId
        || row.logical_tool_call_id !== input.identity.logicalToolCallId
        || row.tool_name !== tool
      ) {
        poisonResolution(db, input.identity.sessionId, input.identity.sourceUserSeq, input.identity.logicalToolCallId);
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
