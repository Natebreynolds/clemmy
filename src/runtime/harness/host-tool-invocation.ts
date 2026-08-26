import { createHash, randomUUID } from 'node:crypto';
import {
  acceptedTaskIdFor,
  withLogicalToolCall,
} from './attempt-identity.js';
import {
  beginPhysicalDispatch,
  settlePhysicalDispatch,
  settleStartedPhysicalDispatchesForLease,
  type PhysicalCrossingIdentity,
  type StoppedDispatchOutcome,
} from './dispatch-ledger.js';
import {
  activateDispatchLease,
  assertDispatchLeaseCurrent,
  revokeDispatchLeaseBeforeRecovery,
  runWithDispatchLease,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  durableLogicalCallRecoveryMaterial,
} from './logical-call-contract.js';
import {
  settleAdmittedLogicalCallPreDispatchRefusal,
  settleToolAttempt,
  type SettledToolAttempt,
} from './attempt-settlement.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import type { AttemptSignals } from './attempt-outcome.js';
import {
  currentHostToolInvocationObservation,
  runWithHostToolInvocationObservation,
} from './tool-invocation-observation-context.js';
import { activateSettledPlanTaskAfterLogicalSettlement } from './plan-task-post-settlement.js';
import { runWithToolAbortSignal } from '../tool-abort-context.js';
import {
  harnessRunContextStorage,
  withHarnessRunContext,
  type HarnessRunContext,
} from './brackets.js';
import type { RuntimeToolEffect, TrustedRuntimeEffectCarrier } from './tool-effect.js';
import { openEventLog } from './eventlog.js';
import { openCanonicalArguments } from './authority-argument-seal.js';
import { currentHostCallAttestation } from './accepted-turn-call-authority.js';
import {
  persistHostCallCapabilityBinding,
  verifyHostCallCapabilityBindingForReplay,
} from './host-call-capability-binding.js';

export type HostToolInvocationStopReason = 'deadline' | 'caller' | 'kill';
export type HostToolInvocationBoundary =
  | 'host_owned_local'
  | 'host_owned_external'
  | 'nested_owned';

export class HostToolInvocationDeadlineError extends Error {
  override readonly name = 'HostToolInvocationDeadlineError';
  constructor(readonly deadlineMs: number) {
    super(`Host tool invocation exceeded its ${deadlineMs}ms deadline.`);
  }
}

export class HostToolInvocationCancelledError extends Error {
  override readonly name = 'HostToolInvocationCancelledError';
  constructor(readonly reason: Exclude<HostToolInvocationStopReason, 'deadline'>) {
    super(`Host tool invocation was cancelled by ${reason}.`);
  }
}

export class HostToolInvocationUncertainError extends Error {
  override readonly name = 'HostToolInvocationUncertainError';
  constructor(
    readonly reason: HostToolInvocationStopReason,
    readonly settlement: SettledToolAttempt,
  ) {
    super('The invocation may have changed state; reconciliation is required before replay.');
  }
}

export class HostToolInvocationAuthorityError extends Error {
  override readonly name = 'HostToolInvocationAuthorityError';
  constructor(readonly reason: string, options?: ErrorOptions) {
    super(`Host tool invocation authority failed closed: ${reason}`, options);
  }
}

export interface HostToolBeforePhysicalAdmissionContext {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  tool: string;
  args?: unknown;
  lease: DispatchLeaseRef;
}

export interface InvokeHostToolCallInput<T> {
  identity: {
    sessionId: string;
    sourceUserSeq: number;
    modelCallId: string;
    toolName: string;
    args?: unknown;
    turn?: number;
  };
  parentLease: DispatchLeaseRef;
  effect: RuntimeToolEffect;
  /** `nested_owned` means a trusted wrapper owns any paid crossing and the
   * normal-completion logical settlement. The host still owns deadline, lease,
   * fencing, and interrupted-call recovery. */
  boundary: HostToolInvocationBoundary;
  deadlineMs: number;
  callerSignal?: AbortSignal;
  isKillRequested?: () => boolean;
  killPollMs?: number;
  businessCall?: boolean;
  /** Opaque provenance for an exact provider operation whose transport
   * envelope was peeled by the trusted host before this shared kernel. */
  trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
  /** Optional synchronous policy edge owned by the host adapter. It runs
   * inside the exact child-lease context, immediately before this kernel owns
   * a physical reservation. Throwing is a proven zero-crossing refusal and
   * follows the same durable recovery path as reservation denial. */
  beforePhysicalAdmission?: (context: HostToolBeforePhysicalAdmissionContext) => void;
  invoke: (context: { signal: AbortSignal; lease: DispatchLeaseRef }) => Promise<T> | T;
}

export interface HostToolInvocationResult<T> {
  value: T;
  settlement: SettledToolAttempt;
}

const RECOVERY_EFFECTS = new Set<RuntimeToolEffect>([
  'read',
  'compute',
  'host_only',
  'local_write',
  'external_write',
  'admin',
  'unknown',
]);

interface FrozenHostToolRecoveryContract {
  toolName: string;
  args: Record<string, unknown>;
  effect: RuntimeToolEffect;
  businessCall: boolean;
  turn?: number;
}

type FrozenPhysicalCrossingPresence = 'none' | 'owned' | 'foreign';

/**
 * Inspect the complete physical history for one logical call. A successful
 * zero-row read is the only fact that permits pre-dispatch refusal recovery.
 * An exact-generation row stays on physical reconciliation truth, while a row
 * owned by another generation is held for a wider authority owner rather than
 * being rewritten as a zero-crossing refusal.
 */
function frozenPhysicalCrossingPresence(
  lease: DispatchLeaseRef,
): FrozenPhysicalCrossingPresence {
  if (
    lease.sourceUserSeq === undefined
    || !lease.acceptedTaskId
    || !lease.logicalToolCallId
  ) throw new HostToolInvocationAuthorityError('physical recovery requires an exact call-bound lease');
  let rows: Array<{
    accepted_task_id: string;
    lease_scope_id: string | null;
    lease_id: string | null;
  }>;
  try {
    rows = openEventLog().prepare(`
      SELECT accepted_task_id, lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       ORDER BY ordinal, physical_dispatch_id
    `).all(
      lease.sessionId,
      lease.sourceUserSeq,
      lease.logicalToolCallId,
    ) as Array<{
      accepted_task_id: string;
      lease_scope_id: string | null;
      lease_id: string | null;
    }>;
  } catch (error) {
    throw new HostToolInvocationAuthorityError(
      'physical recovery inspection was not authoritative',
      { cause: error },
    );
  }
  if (rows.length === 0) return 'none';
  return rows.some((row) => (
    row.accepted_task_id === lease.acceptedTaskId
    && row.lease_scope_id === lease.scopeId
    && row.lease_id === lease.leaseId
  )) ? 'owned' : 'foreign';
}

function frozenRecoveryContract(lease: DispatchLeaseRef): FrozenHostToolRecoveryContract {
  if (
    lease.sourceUserSeq === undefined
    || !lease.acceptedTaskId
    || !lease.logicalToolCallId
  ) throw new HostToolInvocationAuthorityError('recovery requires an exact call-bound lease');
  const row = openEventLog().prepare(`
    SELECT lease.revoked_at, lease.recovery_effect, lease.recovery_business_call,
           lease.recovery_tool_name, lease.recovery_argument_digest,
           lease.recovery_argument_cipher, lease.recovery_turn,
           call.accepted_task_id, call.tool_name, call.argument_digest,
           call.raw_argument_digest, call.state
      FROM run_dispatch_leases lease
      JOIN logical_tool_calls call
        ON call.session_id = lease.session_id
       AND call.source_user_seq = lease.source_user_seq
       AND call.logical_tool_call_id = lease.logical_tool_call_id
     WHERE lease.session_id = ? AND lease.scope_id = ? AND lease.lease_id = ?
       AND lease.source_user_seq = ? AND lease.accepted_task_id = ?
       AND lease.logical_tool_call_id = ?
  `).get(
    lease.sessionId,
    lease.scopeId,
    lease.leaseId,
    lease.sourceUserSeq,
    lease.acceptedTaskId,
    lease.logicalToolCallId,
  ) as {
    revoked_at: string | null;
    recovery_effect: string | null;
    recovery_business_call: number | null;
    recovery_tool_name: string | null;
    recovery_argument_digest: string | null;
    recovery_argument_cipher: string | null;
    recovery_turn: number | null;
    accepted_task_id: string;
    tool_name: string;
    argument_digest: string;
    raw_argument_digest: string;
    state: string;
  } | undefined;
  if (!row || row.revoked_at === null) {
    throw new HostToolInvocationAuthorityError('recovery lease is missing or still current');
  }
  if (
    !row.recovery_effect
    || !RECOVERY_EFFECTS.has(row.recovery_effect as RuntimeToolEffect)
    || (row.recovery_business_call !== 0 && row.recovery_business_call !== 1)
    || !row.recovery_tool_name
    || !row.recovery_argument_digest
    || !row.recovery_argument_cipher
    || row.accepted_task_id !== lease.acceptedTaskId
    || row.tool_name !== row.recovery_tool_name
    || (row.argument_digest !== row.recovery_argument_digest
      && row.raw_argument_digest !== row.recovery_argument_digest)
    || (row.recovery_turn !== null
      && (!Number.isSafeInteger(row.recovery_turn) || row.recovery_turn <= 0))
  ) throw new HostToolInvocationAuthorityError('frozen recovery contract is incomplete or conflicts');
  const opened = openCanonicalArguments(row.recovery_argument_cipher);
  const args = opened?.args;
  if (
    !opened
    || Object.keys(opened).length !== 1
    || !args
    || typeof args !== 'object'
    || Array.isArray(args)
  ) throw new HostToolInvocationAuthorityError('frozen recovery arguments are unreadable');
  const material = durableLogicalCallRecoveryMaterial(
    lease.acceptedTaskId,
    row.recovery_tool_name,
    args,
  );
  if (
    !material
    || material.toolName !== row.recovery_tool_name
    || material.argumentDigest !== row.recovery_argument_digest
  ) throw new HostToolInvocationAuthorityError('frozen recovery arguments fail their logical digest');
  return {
    toolName: material.toolName,
    args: material.args,
    effect: row.recovery_effect as RuntimeToolEffect,
    businessCall: row.recovery_business_call === 1,
    ...(row.recovery_turn === null ? {} : { turn: row.recovery_turn }),
  };
}

/** Restart/recovery seam for the narrow crash window where the exact child
 * generation was revoked but terminal/logical persistence did not finish.
 * It never re-enters the tool body. A proven zero-crossing call is refused
 * pre-dispatch. Otherwise any still-started exact-generation crossing becomes
 * `unknown`; an already-terminal crossing is preserved, and the shared logical
 * kernel freezes a reconcile-only/failed outcome over those bytes. */
export function reconcileRevokedHostToolInvocation(input: {
  lease: DispatchLeaseRef;
}): SettledToolAttempt {
  const frozen = frozenRecoveryContract(input.lease);
  const presence = frozenPhysicalCrossingPresence(input.lease);
  const isMutating = mutatingEffect(frozen.effect);
  if (presence === 'none') {
    return settleAdmittedLogicalCallPreDispatchRefusal({
      sessionId: input.lease.sessionId,
      sourceUserSeq: input.lease.sourceUserSeq!,
      logicalToolCallId: input.lease.logicalToolCallId!,
      toolName: frozen.toolName,
      args: frozen.args,
      lane: 'byo',
      turn: frozen.turn,
      mutating: isMutating,
      reason: 'revoked_before_physical_admission',
    });
  }
  if (presence === 'foreign') {
    throw new HostToolInvocationAuthorityError(
      'logical call has physical crossings outside the revoked recovery generation',
    );
  }
  const terminal = settleStartedPhysicalDispatchesForLease({
    lease: input.lease,
    outcome: 'unknown',
    turn: frozen.turn,
  });
  if (terminal.status !== 'inserted' && terminal.status !== 'replayed') {
    throw new HostToolInvocationAuthorityError(
      'reason' in terminal ? terminal.reason : 'recovery physical terminalization was not authoritative',
    );
  }
  return settleToolAttempt({
    sessionId: input.lease.sessionId,
    sourceUserSeq: input.lease.sourceUserSeq,
    acceptedTaskId: input.lease.acceptedTaskId,
    callId: input.lease.logicalToolCallId,
    turn: frozen.turn,
    lane: 'byo',
    toolName: frozen.toolName,
    args: frozen.args,
    mutating: isMutating,
    businessCall: frozen.businessCall,
    thrown: new HostToolInvocationAuthorityError(
      'invocation settlement was interrupted after dispatch; durable recovery is required',
    ),
    signals: {
      executionFailed: true,
      mutating: isMutating,
      ...(isMutating ? { acknowledged: false } : {}),
    },
  });
}

export interface HostToolInvocationRecoveryRecord {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  leaseScopeId: string;
  leaseId: string;
  status: 'settled' | 'held';
  reason?: string;
}

export interface HostToolInvocationRecoverySweep {
  scanned: number;
  settled: number;
  held: number;
  records: HostToolInvocationRecoveryRecord[];
}

/**
 * Bounded restart/reaper owner for revoked call generations. Selection is
 * purely structural: an exact revoked call-bound lease and an open logical
 * call. Every semantic byte is reopened from the frozen lease contract; the
 * current tool catalog is not consulted and the tool body is never entered.
 * A zero-row call converges through the pre-dispatch refusal seam; existing
 * crossings retain their physical reconciliation truth.
 */
export function reconcileRevokedHostToolInvocations(
  options: { limit?: number } = {},
): HostToolInvocationRecoverySweep {
  const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 100)));
  type Candidate = {
    session_id: string;
    source_user_seq: number;
    accepted_task_id: string;
    logical_tool_call_id: string;
    scope_id: string;
    lease_id: string;
    run_attempt_id: string | null;
    parent_scope_id: string | null;
    parent_lease_id: string | null;
  };
  let candidates: Candidate[];
  try {
    candidates = openEventLog().prepare(`
      SELECT lease.session_id, lease.source_user_seq, lease.accepted_task_id,
             lease.logical_tool_call_id, lease.scope_id, lease.lease_id,
             lease.run_attempt_id, lease.parent_scope_id, lease.parent_lease_id
        FROM run_dispatch_leases lease
        JOIN logical_tool_calls call
          ON call.session_id = lease.session_id
         AND call.source_user_seq = lease.source_user_seq
         AND call.logical_tool_call_id = lease.logical_tool_call_id
       WHERE lease.revoked_at IS NOT NULL
         AND lease.source_user_seq IS NOT NULL
         AND lease.accepted_task_id IS NOT NULL
         AND lease.logical_tool_call_id IS NOT NULL
         AND call.state = 'open'
       ORDER BY lease.revoked_at, lease.session_id, lease.source_user_seq,
                lease.logical_tool_call_id, lease.scope_id, lease.lease_id
       LIMIT ?
    `).all(limit) as Candidate[];
  } catch (error) {
    return {
      scanned: 0,
      settled: 0,
      held: 1,
      records: [{
        sessionId: '',
        sourceUserSeq: 0,
        logicalToolCallId: '',
        leaseScopeId: '',
        leaseId: '',
        status: 'held',
        reason: `recovery scan failed: ${String(error instanceof Error ? error.message : error).slice(0, 180)}`,
      }],
    };
  }
  const records: HostToolInvocationRecoveryRecord[] = [];
  for (const candidate of candidates) {
    const lease: DispatchLeaseRef = {
      sessionId: candidate.session_id,
      scopeId: candidate.scope_id,
      leaseId: candidate.lease_id,
      sourceUserSeq: candidate.source_user_seq,
      acceptedTaskId: candidate.accepted_task_id,
      logicalToolCallId: candidate.logical_tool_call_id,
      ...(candidate.run_attempt_id ? { runAttemptId: candidate.run_attempt_id } : {}),
      ...(candidate.parent_scope_id && candidate.parent_lease_id ? {
        parentScopeId: candidate.parent_scope_id,
        parentLeaseId: candidate.parent_lease_id,
      } : {}),
    };
    try {
      reconcileRevokedHostToolInvocation({ lease });
      records.push({
        sessionId: lease.sessionId,
        sourceUserSeq: candidate.source_user_seq,
        logicalToolCallId: candidate.logical_tool_call_id,
        leaseScopeId: lease.scopeId,
        leaseId: lease.leaseId,
        status: 'settled',
      });
    } catch (error) {
      records.push({
        sessionId: lease.sessionId,
        sourceUserSeq: candidate.source_user_seq,
        logicalToolCallId: candidate.logical_tool_call_id,
        leaseScopeId: lease.scopeId,
        leaseId: lease.leaseId,
        status: 'held',
        reason: String(error instanceof Error ? error.message : error).slice(0, 180),
      });
    }
  }
  return {
    scanned: candidates.length,
    settled: records.filter((record) => record.status === 'settled').length,
    held: records.filter((record) => record.status === 'held').length,
    records,
  };
}

function exactModelCallId(value: string): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > 512
  ) throw new HostToolInvocationAuthorityError('model call id is not exact');
  return value;
}

function exactPhysicalId(input: InvokeHostToolCallInput<unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    modelCallId: input.identity.modelCallId,
  })).digest('hex');
  return `dispatch:host:v1:${digest}`;
}

function mutatingEffect(effect: RuntimeToolEffect): boolean {
  return effect === 'local_write' || effect === 'external_write' || effect === 'admin';
}

function stopError(reason: HostToolInvocationStopReason, deadlineMs: number): Error {
  return reason === 'deadline'
    ? new HostToolInvocationDeadlineError(deadlineMs)
    : new HostToolInvocationCancelledError(reason);
}

type SettledPlanTaskResultDisposition = 'activation_required' | 'settled_refusal';

const PLAN_TASK_RESULT_MAX_BYTES = 64 * 1024;
const PLAN_TASK_RESULT_MAX_REQUIREMENTS = 32;
const PLAN_TASK_RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const PLAN_TASK_RESULT_EFFECTS = new Set([
  'read',
  'compute',
  'local_write',
  'external_write',
  'admin',
]);
const PLAN_TASK_RESULT_COVERAGE = new Set([
  'single',
  'accepted_set',
  'complete_set',
  'resolved_operation',
]);

function exactPlanTaskResultRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable);
  });
}

function exactPlanTaskResultKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key) => typeof key === 'string')
    && (keys as string[]).sort().every((key, index) => key === sortedExpected[index]);
}

function boundedPlanTaskResultText(value: unknown, maxBytes = 8_192): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !value.includes('\0');
}

function exactPlanTaskResultId(value: unknown): value is string {
  return typeof value === 'string' && PLAN_TASK_RESULT_ID.test(value);
}

function exactPlanTaskResultCardinality(value: unknown): boolean {
  if (!exactPlanTaskResultRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'once') return exactPlanTaskResultKeys(value, ['kind']);
  return (value.kind === 'each' || value.kind === 'set')
    && exactPlanTaskResultKeys(value, ['kind', 'universeId'])
    && exactPlanTaskResultId(value.universeId);
}

function exactPlanTaskResultRequirement(value: unknown): value is Record<string, unknown> {
  if (
    !exactPlanTaskResultRecord(value)
    || !exactPlanTaskResultKeys(value, [
      'id', 'effect', 'coverage', 'dependsOn', 'cardinality',
    ])
    || !exactPlanTaskResultId(value.id)
    || typeof value.effect !== 'string'
    || !PLAN_TASK_RESULT_EFFECTS.has(value.effect)
    || (value.coverage !== null && (
      typeof value.coverage !== 'string'
      || !PLAN_TASK_RESULT_COVERAGE.has(value.coverage)
    ))
    || !Array.isArray(value.dependsOn)
    || value.dependsOn.length > PLAN_TASK_RESULT_MAX_REQUIREMENTS
    || value.dependsOn.some((dependency) => !exactPlanTaskResultId(dependency))
    || new Set(value.dependsOn).size !== value.dependsOn.length
    || !exactPlanTaskResultCardinality(value.cardinality)
  ) return false;
  return value.effect === 'read' ? value.coverage !== null : value.coverage === null;
}

/**
 * `plan_task` has one closed result union. A successful member may cross into
 * expected-work activation; the two typed refusal members are ordinary,
 * durably settled repair outcomes. Nothing else is authority to choose either
 * branch, including a truthy/falsy or missing `ok` field.
 */
function settledPlanTaskResultDisposition(input: {
  value: unknown;
  acceptedTaskId: string;
  sourceUserSeq: number;
}): SettledPlanTaskResultDisposition | null {
  let payload = input.value;
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > PLAN_TASK_RESULT_MAX_BYTES) return null;
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (!exactPlanTaskResultRecord(payload) || typeof payload.ok !== 'boolean') return null;
  if (payload.ok === false) {
    if (
      payload.code === 'plan_not_admitted'
      && exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail', 'repair'])
      && boundedPlanTaskResultText(payload.detail)
      && boundedPlanTaskResultText(payload.repair)
    ) return 'settled_refusal';
    if (
      payload.code === 'plan_not_required'
      && exactPlanTaskResultKeys(payload, ['ok', 'code', 'detail'])
      && boundedPlanTaskResultText(payload.detail)
    ) return 'settled_refusal';
    return null;
  }
  if (
    !exactPlanTaskResultKeys(payload, [
      'ok', 'acceptedTaskId', 'graphId', 'graphHash', 'contractId',
      'requirements', 'next',
    ])
    || payload.acceptedTaskId !== input.acceptedTaskId
    || payload.graphId !== `turn-graph:v1:${input.sourceUserSeq}`
    || typeof payload.graphHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(payload.graphHash)
    || typeof payload.contractId !== 'string'
    || !/^expected-work:v1:[a-f0-9]{64}$/.test(payload.contractId)
    || !Array.isArray(payload.requirements)
    || payload.requirements.length < 1
    || payload.requirements.length > PLAN_TASK_RESULT_MAX_REQUIREMENTS
    || payload.requirements.some((requirement) => !exactPlanTaskResultRequirement(requirement))
    || new Set(payload.requirements.map((requirement) => (
      (requirement as Record<string, unknown>).id
    ))).size !== payload.requirements.length
    || !boundedPlanTaskResultText(payload.next, 2_048)
  ) return null;
  return 'activation_required';
}

function enforceSettledPlanTaskResult(input: {
  value: unknown;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): void {
  const disposition = settledPlanTaskResultDisposition(input);
  if (!disposition) {
    throw new HostToolInvocationAuthorityError(
      'settled plan_task result is not an exact typed success or refusal',
    );
  }
  if (disposition === 'settled_refusal') return;
  const activation = activateSettledPlanTaskAfterLogicalSettlement({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
  });
  if (activation.status === 'not_ready') {
    throw new HostToolInvocationAuthorityError(
      'settled plan_task lacks exact durable delivery/activation authority',
    );
  }
}

/**
 * One host-owned invocation state machine. There is one deadline and one
 * terminal owner. A stop first wins synchronously, then durably revokes and
 * terminalizes its exact generation, and only then delivers the abort signal
 * or permits recovery. The detached body can never settle or publish through a
 * stale generation.
 */
export async function invokeHostToolCall<T>(
  input: InvokeHostToolCallInput<T>,
): Promise<HostToolInvocationResult<T>> {
  const modelCallId = exactModelCallId(input.identity.modelCallId);
  if (
    !input.identity.sessionId.trim()
    || !Number.isSafeInteger(input.identity.sourceUserSeq)
    || input.identity.sourceUserSeq <= 0
    || !Number.isSafeInteger(input.deadlineMs)
    || input.deadlineMs <= 0
    || input.parentLease.sessionId !== input.identity.sessionId
  ) throw new HostToolInvocationAuthorityError('invocation identity, parent lease, or deadline is invalid');
  if (input.callerSignal?.aborted) throw new HostToolInvocationCancelledError('caller');
  if (input.isKillRequested?.()) throw new HostToolInvocationCancelledError('kill');

  const acceptedTaskId = acceptedTaskIdFor(
    input.identity.sessionId,
    input.identity.sourceUserSeq,
  );
  const recoveryMaterial = durableLogicalCallRecoveryMaterial(
    acceptedTaskId,
    input.identity.toolName,
    input.identity.args,
  );
  if (!recoveryMaterial) throw new HostToolInvocationAuthorityError('tool call contract is unsafe');
  const contract = {
    toolName: recoveryMaterial.toolName,
    argumentDigest: recoveryMaterial.argumentDigest,
  };
  const frozenBusinessCall = input.businessCall ?? true;
  if (
    input.parentLease.sourceUserSeq !== undefined
    || input.parentLease.acceptedTaskId !== undefined
    || input.parentLease.logicalToolCallId !== undefined
  ) throw new HostToolInvocationAuthorityError('host parent lease must own the run, not another logical call');

  // Continuation/restart fast path. A terminal success is immutable execution
  // state, so adopt its exact retained bytes before logical admission (which
  // correctly rejects a settled call) and before minting a child lease or
  // reserving another provider crossing. Missing means first execution and
  // proceeds through the normal kernel below; every unreadable, non-success,
  // or contract-mismatched terminal fails closed rather than entering `invoke`.
  const prior = redeemDurableLogicalCallSettlementForHost({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: modelCallId,
  });
  if (prior.status !== 'missing') {
    if (prior.status !== 'ok') {
      throw new HostToolInvocationAuthorityError(
        `settled logical call is ${prior.status}: ${prior.reason}`,
      );
    }
    const replayCapability = verifyHostCallCapabilityBindingForReplay({
      db: openEventLog(),
      attestation: currentHostCallAttestation(),
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      logicalToolCallId: modelCallId,
      acceptedTaskId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: input.effect as Exclude<RuntimeToolEffect, 'unknown'>,
    });
    if (replayCapability.status !== 'replayed' && replayCapability.status !== 'not_applicable') {
      throw new HostToolInvocationAuthorityError(
        `settled replay capability binding is ${replayCapability.status}: ${'reason' in replayCapability ? replayCapability.reason : 'unexpected admission state'}`,
      );
    }
    const parentContext = harnessRunContextStorage.getStore();
    if (
      !parentContext
      || parentContext.sessionId !== input.identity.sessionId
      || parentContext.sourceUserSeq !== input.identity.sourceUserSeq
      || parentContext.dispatchLease?.scopeId !== input.parentLease.scopeId
      || parentContext.dispatchLease.leaseId !== input.parentLease.leaseId
    ) {
      throw new HostToolInvocationAuthorityError(
        'ambient run context does not own the parent lease for settled replay',
      );
    }
    try {
      assertDispatchLeaseCurrent(input.parentLease);
    } catch (error) {
      throw new HostToolInvocationAuthorityError(
        'parent lease is not current for settled replay',
        { cause: error },
      );
    }
    if (
      prior.settlement.toolName !== contract.toolName
      || prior.settlement.argumentDigest !== contract.argumentDigest
      || prior.settlement.recovery.businessCall !== frozenBusinessCall
      || prior.settlement.recovery.mutating !== mutatingEffect(input.effect)
    ) {
      throw new HostToolInvocationAuthorityError(
        'settled logical call conflicts with the current invocation contract',
      );
    }
    if (!['succeeded', 'empty_result'].includes(prior.settlement.outcome.kind)) {
      throw new HostToolInvocationAuthorityError(
        `settled logical outcome ${prior.settlement.outcome.kind} is not replayable`,
      );
    }
    const result = redeemSuccessfulSettlementResultForHost({
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: modelCallId,
    });
    if (result.status !== 'ok') {
      throw new HostToolInvocationAuthorityError(
        `settled logical result is ${result.status}: ${result.reason}`,
      );
    }
    if (
      result.value.toolName !== contract.toolName
      || result.value.outcomeKind !== prior.settlement.outcome.kind
      || result.value.resultHandleId !== prior.settlement.resultHandleId
    ) {
      throw new HostToolInvocationAuthorityError(
        'settled logical result conflicts with its immutable settlement',
      );
    }
    if (contract.toolName === 'plan_task') {
      enforceSettledPlanTaskResult({
        value: result.value.rawPayload,
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: modelCallId,
      });
    }
    return {
      value: result.value.rawPayload as T,
      settlement: {
        outcome: prior.settlement.outcome,
        openedDiscoveryEpoch: prior.settlement.recovery.openedDiscoveryEpoch,
        creditedProgress: prior.settlement.recovery.creditedProgress,
        resultHandleId: result.value.resultHandleId,
        duplicate: true,
      },
    };
  }

  return withLogicalToolCall({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    logicalToolCallId: modelCallId,
    tool: input.identity.toolName,
    args: input.identity.args,
    trustedEffectCarrier: input.trustedEffectCarrier,
  }, async (logical) => {
    if (
      logical.acceptedTaskId !== acceptedTaskId
      || logical.logicalToolCallId !== modelCallId
    ) throw new HostToolInvocationAuthorityError('logical admission changed the exact model call id');

    const scopeDigest = createHash('sha256').update(JSON.stringify({
      parentScopeId: input.parentLease.scopeId,
      parentLeaseId: input.parentLease.leaseId,
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      modelCallId,
    })).digest('hex');
    const settleSetupRefusal = (reason: string): void => {
      settleAdmittedLogicalCallPreDispatchRefusal({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        logicalToolCallId: modelCallId,
        toolName: input.identity.toolName,
        args: input.identity.args,
        lane: 'byo',
        turn: input.identity.turn,
        mutating: mutatingEffect(input.effect),
        reason,
      });
    };
    const capabilityBinding = persistHostCallCapabilityBinding({
      db: openEventLog(),
      attestation: currentHostCallAttestation(),
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      logicalToolCallId: modelCallId,
      acceptedTaskId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: input.effect as Exclude<RuntimeToolEffect, 'unknown'>,
    });
    if (
      capabilityBinding.status !== 'bound'
      && capabilityBinding.status !== 'replayed'
      && capabilityBinding.status !== 'not_applicable'
    ) {
      try {
        settleSetupRefusal('host_capability_binding_failed');
      } catch (settlementError) {
        throw new HostToolInvocationAuthorityError(
          'host capability binding and pre-dispatch settlement both failed',
          { cause: settlementError },
        );
      }
      throw new HostToolInvocationAuthorityError(
        `host capability binding is ${capabilityBinding.status}: ${'reason' in capabilityBinding ? capabilityBinding.reason : 'unexpected admission state'}`,
      );
    }
    let childLease: DispatchLeaseRef;
    try {
      childLease = activateDispatchLease({
        sessionId: input.identity.sessionId,
        // Keep every generation addressable after restart. Rotating one
        // deterministic scope would overwrite the revoked lease row that an
        // unresolved physical crossing still names, destroying the exact CAS
        // needed to reconcile it.
        scopeId: `${input.parentLease.scopeId}::call:${scopeDigest}:${randomUUID()}`,
        runAttemptId: input.parentLease.runAttemptId,
        parentLease: input.parentLease,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: modelCallId,
        recovery: {
          effect: input.effect,
          businessCall: frozenBusinessCall,
          material: recoveryMaterial,
          ...(input.identity.turn === undefined ? {} : { turn: input.identity.turn }),
        },
      });
    } catch (error) {
      try {
        settleSetupRefusal('child_lease_activation_failed');
      } catch (settlementError) {
        throw new HostToolInvocationAuthorityError(
          'child lease activation and pre-dispatch settlement both failed',
          { cause: settlementError },
        );
      }
      throw new HostToolInvocationAuthorityError('child lease activation failed', { cause: error });
    }
    const parentContext = harnessRunContextStorage.getStore();
    if (
      !parentContext
      || parentContext.sessionId !== input.identity.sessionId
      || parentContext.sourceUserSeq !== input.identity.sourceUserSeq
      || parentContext.dispatchLease?.scopeId !== input.parentLease.scopeId
      || parentContext.dispatchLease.leaseId !== input.parentLease.leaseId
    ) {
      await revokeDispatchLeaseBeforeRecovery(childLease);
      try {
        settleSetupRefusal('ambient_parent_mismatch');
      } catch (error) {
        throw new HostToolInvocationAuthorityError(
          'ambient parent mismatch could not be durably refused',
          { cause: error },
        );
      }
      throw new HostToolInvocationAuthorityError('ambient run context does not own the parent lease');
    }
    const childContext: HarnessRunContext = {
      ...parentContext,
      dispatchLease: childLease,
      hostOwnsToolDeadlineAndSettlement: true,
    };

    return runWithDispatchLease(childLease, () => withHarnessRunContext(
      childContext,
      () => {
        let topCrossing: PhysicalCrossingIdentity | undefined;
        let topCrossingTool: string | undefined;
        const rememberTopCrossing = (identity: PhysicalCrossingIdentity): void => {
          const stored = openEventLog().prepare(`
            SELECT tool_name FROM physical_dispatches
             WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
          `).get(
            input.identity.sessionId,
            input.identity.sourceUserSeq,
            identity.physicalDispatchId,
          ) as { tool_name: string } | undefined;
          if (!stored) {
            throw new HostToolInvocationAuthorityError(
              'physical reservation was inserted without readable exact tool identity',
            );
          }
          topCrossing = identity;
          topCrossingTool = stored.tool_name;
        };
        const closeTop = (outcome: 'returned' | 'threw'): void => {
          if (!topCrossing) return;
          if (!topCrossingTool) {
            throw new HostToolInvocationAuthorityError(
              'physical reservation lost its exact tool identity before settlement',
            );
          }
          const settled = settlePhysicalDispatch({
            identity: topCrossing,
            tool: topCrossingTool,
            outcome,
            turn: input.identity.turn,
            dispatchLease: childLease,
          });
          if (settled.status !== 'inserted' && settled.status !== 'replayed') {
            throw new HostToolInvocationAuthorityError(settled.reason);
          }
        };
        const nestedPhysicalDispatch = input.boundary === 'nested_owned'
          ? {
              reserve: (request: { toolName: string; args?: unknown }): void => {
                assertDispatchLeaseCurrent(childLease);
                const admitted = beginPhysicalDispatch({
                  identity: {
                    sessionId: input.identity.sessionId,
                    sourceUserSeq: input.identity.sourceUserSeq,
                    acceptedTaskId,
                    logicalToolCallId: modelCallId,
                    // Match the long-standing host-execution evidence id used
                    // by settleToolAttempt. Its later evidence pass therefore
                    // observes this exact row instead of minting a second one.
                    physicalDispatchId: `dispatch:host:${modelCallId}`,
                    ordinal: 1,
                  },
                  tool: request.toolName,
                  args: request.args,
                  turn: input.identity.turn,
                  relation: 'primary',
                  executionSite: 'host',
                  dispatchLease: childLease,
                });
                if (admitted.status === 'inserted') {
                  rememberTopCrossing(admitted.identity);
                  return;
                }
                if (
                  admitted.status === 'replayed'
                  && topCrossing?.physicalDispatchId === admitted.identity.physicalDispatchId
                ) return;
                throw new HostToolInvocationAuthorityError(
                  'reason' in admitted
                    ? admitted.reason
                    : `nested physical admission was ${admitted.status}`,
                );
              },
              settle: closeTop,
            }
          : undefined;
        return runWithHostToolInvocationObservation(async () => {
        if (input.boundary !== 'nested_owned') {
          const refuseBeforePhysical = async (
            reason: string,
            cause?: unknown,
          ): Promise<never> => {
            await revokeDispatchLeaseBeforeRecovery(childLease);
            try {
              // This exact revoked generation is now the sole recovery owner.
              // Its durable inspector decides whether the call has provably
              // zero crossings or an existing crossing whose terminal truth
              // must be preserved. Neither path re-enters the tool body.
              reconcileRevokedHostToolInvocation({ lease: childLease });
            } catch (recoveryError) {
              throw new HostToolInvocationAuthorityError(
                `${reason}; revoked generation recovery failed`,
                { cause: recoveryError },
              );
            }
            throw new HostToolInvocationAuthorityError(
              reason,
              cause === undefined ? undefined : { cause },
            );
          };
          if (input.beforePhysicalAdmission) {
            try {
              assertDispatchLeaseCurrent(childLease);
              const callbackResult: unknown = input.beforePhysicalAdmission({
                sessionId: input.identity.sessionId,
                sourceUserSeq: input.identity.sourceUserSeq,
                acceptedTaskId,
                logicalToolCallId: modelCallId,
                tool: contract.toolName,
                args: input.identity.args,
                lease: childLease,
              });
              if (
                callbackResult
                && typeof callbackResult === 'object'
                && 'then' in callbackResult
              ) {
                throw new Error('beforePhysicalAdmission must be synchronous');
              }
            } catch (error) {
              const detail = String(error instanceof Error ? error.message : error)
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 180);
              await refuseBeforePhysical(
                detail
                  ? `before-physical admission refused: ${detail}`
                  : 'before-physical admission refused',
                error,
              );
            }
          }
          const admitted = beginPhysicalDispatch({
            identity: {
              sessionId: input.identity.sessionId,
              sourceUserSeq: input.identity.sourceUserSeq,
              acceptedTaskId,
              logicalToolCallId: modelCallId,
              physicalDispatchId: exactPhysicalId(input),
              ordinal: 1,
            },
            tool: contract.toolName,
            args: input.identity.args,
            turn: input.identity.turn,
            relation: 'primary',
            trustedEffectCarrier: input.trustedEffectCarrier,
            ...(input.boundary === 'host_owned_local' ? { executionSite: 'host' as const } : {}),
            dispatchLease: childLease,
          });
          if (admitted.status !== 'inserted') {
            const admissionReason = 'reason' in admitted
              ? admitted.reason
              : `physical admission was ${admitted.status}`;
            await refuseBeforePhysical(admissionReason);
          } else {
            rememberTopCrossing(admitted.identity);
          }
        }

        const controller = new AbortController();
        const isMutating = mutatingEffect(input.effect);
        type State = 'pending' | 'settling' | 'stopping' | 'done';
        let state: State = 'pending';
        let deadlineTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const absoluteDeadlineAt = Date.now() + input.deadlineMs;
        return new Promise<HostToolInvocationResult<T>>((resolve, reject) => {
          const cleanup = (): void => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (killTimer) clearInterval(killTimer);
            input.callerSignal?.removeEventListener('abort', callerAbort);
          };
          const assertFrozenObservation = (): void => {
            const observed = currentHostToolInvocationObservation();
            if (
              // Legacy wrappers report "mutating" through the external-write
              // classifier. A local control write (for example run_worker)
              // therefore reports false even though the exact host authority
              // correctly freezes it as local_write. That observation may
              // never upgrade a read, nor downgrade an external/admin effect;
              // it simply is not authority to downgrade an exact local write.
              (observed?.mutating === true && !isMutating)
              || (observed?.mutating === false
                && (input.effect === 'external_write' || input.effect === 'admin'))
              || (observed?.businessCall !== undefined
                && observed.businessCall !== frozenBusinessCall)
            ) {
              throw new HostToolInvocationAuthorityError(
                'nested observation conflicts with the frozen invocation contract',
              );
            }
          };
          const logicalSettlement = (args: {
            result?: unknown;
            resultPresent?: boolean;
            thrown?: unknown;
            thrownPresent?: boolean;
            signals?: AttemptSignals;
          }): SettledToolAttempt => {
            assertFrozenObservation();
            const observed = currentHostToolInvocationObservation();
            return settleToolAttempt({
              sessionId: input.identity.sessionId,
              sourceUserSeq: input.identity.sourceUserSeq,
              acceptedTaskId,
              callId: modelCallId,
              turn: input.identity.turn,
              lane: 'byo',
              toolName: input.identity.toolName,
              args: input.identity.args,
              mutating: isMutating,
              businessCall: frozenBusinessCall,
              ...(observed?.resultPresent
                ? { result: observed.result }
                : args.resultPresent === true ? { result: args.result } : {}),
              ...(observed?.thrownPresent
                ? { thrown: observed.thrown }
                : args.thrownPresent === true ? { thrown: args.thrown } : {}),
              signals: { ...observed?.signals, ...args.signals },
            });
          };
          const adoptedNestedSettlement = (): SettledToolAttempt => {
            const redeemed = redeemDurableLogicalCallSettlementForHost({
              sessionId: input.identity.sessionId,
              sourceUserSeq: input.identity.sourceUserSeq,
              acceptedTaskId,
              logicalToolCallId: modelCallId,
            });
            if (redeemed.status !== 'ok') {
              throw new HostToolInvocationAuthorityError(
                `nested-owned logical settlement is ${redeemed.status}: ${redeemed.reason}`,
              );
            }
            const observed = currentHostToolInvocationObservation();
            // For a nested carrier the outer wrapper may conservatively
            // report `mutating:false`; the exact inner durable settlement is
            // the one effect owner and is checked below. The outer observation
            // may still never upgrade a read or relabel business/control work.
            if (
              (observed?.mutating === true && !isMutating)
              // A nested wrapper's registry role is only a conservative
              // pre-binding default. It may never upgrade an unbound control
              // to business work, but `false` cannot downgrade the exact
              // expected-work settlement adopted immediately below.
              || (observed?.businessCall === true && !frozenBusinessCall)
            ) {
              throw new HostToolInvocationAuthorityError(
                'nested observation conflicts with the frozen invocation contract',
              );
            }
            if (
              redeemed.settlement.recovery.mutating !== isMutating
              || redeemed.settlement.recovery.businessCall !== frozenBusinessCall
            ) {
              throw new HostToolInvocationAuthorityError(
                'nested-owned logical settlement conflicts with the frozen invocation contract',
              );
            }
            return {
              outcome: redeemed.settlement.outcome,
              openedDiscoveryEpoch: redeemed.settlement.recovery.openedDiscoveryEpoch,
              creditedProgress: redeemed.settlement.recovery.creditedProgress,
              ...(redeemed.settlement.resultHandleId
                ? { resultHandleId: redeemed.settlement.resultHandleId }
                : {}),
              // The inner dispatcher settled this same invocation for the
              // first time. The host merely adopts it; this is not a replayed
              // model call and must not be reported as one.
              duplicate: false,
            };
          };
          const stop = (reason: HostToolInvocationStopReason): void => {
            if (state !== 'pending') return;
            // Winner is claimed synchronously. No normal completion callback
            // may settle or publish after this assignment.
            state = 'stopping';
            cleanup();
            void (async () => {
              const error = stopError(reason, input.deadlineMs);
              try {
                await revokeDispatchLeaseBeforeRecovery(childLease);
                const physicalOutcome: StoppedDispatchOutcome = isMutating
                  ? 'unknown'
                  : reason === 'deadline' ? 'timed_out' : 'cancelled';
                const terminal = settleStartedPhysicalDispatchesForLease({
                  lease: childLease,
                  outcome: physicalOutcome,
                  turn: input.identity.turn,
                });
                if (
                  terminal.status !== 'inserted'
                  && terminal.status !== 'replayed'
                  && !(input.boundary === 'nested_owned' && terminal.status === 'missing')
                ) throw new HostToolInvocationAuthorityError(
                  'reason' in terminal ? terminal.reason : 'physical terminalization was not authoritative',
                );
                controller.abort(error);
                const settlement = logicalSettlement({
                  thrown: error,
                  thrownPresent: true,
                  signals: reason === 'deadline'
                    ? {
                        errorName: 'TimeoutError',
                        mutating: isMutating,
                        ...(isMutating ? { acknowledged: false } : {}),
                      }
                    : {
                        cancelled: true,
                        mutating: isMutating,
                        ...(isMutating ? { acknowledged: false } : {}),
                      },
                });
                state = 'done';
                reject(isMutating
                  ? new HostToolInvocationUncertainError(reason, settlement)
                  : error);
              } catch (authorityError) {
                controller.abort(authorityError);
                state = 'done';
                reject(authorityError instanceof HostToolInvocationAuthorityError
                  ? authorityError
                  : new HostToolInvocationAuthorityError('stop settlement did not commit', {
                      cause: authorityError,
                    }));
              }
            })();
          };
          const stopForUnreadableKillAuthority = (cause: unknown): void => {
            if (state !== 'pending') return;
            state = 'stopping';
            cleanup();
            void (async () => {
              const authorityError = new HostToolInvocationAuthorityError(
                'kill authority became unreadable',
                { cause },
              );
              try {
                await revokeDispatchLeaseBeforeRecovery(childLease);
                const terminal = settleStartedPhysicalDispatchesForLease({
                  lease: childLease,
                  outcome: 'unknown',
                  turn: input.identity.turn,
                });
                if (
                  terminal.status !== 'inserted'
                  && terminal.status !== 'replayed'
                  && !(input.boundary === 'nested_owned' && terminal.status === 'missing')
                ) throw new HostToolInvocationAuthorityError(
                  'reason' in terminal ? terminal.reason : 'kill terminalization was not authoritative',
                );
                controller.abort(authorityError);
                logicalSettlement({
                  thrown: authorityError,
                  thrownPresent: true,
                  signals: {
                    executionFailed: true,
                    mutating: isMutating,
                    ...(isMutating ? { acknowledged: false } : {}),
                  },
                });
                state = 'done';
                reject(authorityError);
              } catch (error) {
                controller.abort(error);
                state = 'done';
                reject(error instanceof HostToolInvocationAuthorityError
                  ? error
                  : new HostToolInvocationAuthorityError(
                      'unreadable kill authority did not terminalize',
                      { cause: error },
                    ));
              }
            })();
          };
          const callerAbort = (): void => stop('caller');
          input.callerSignal?.addEventListener('abort', callerAbort, { once: true });
          deadlineTimer = setTimeout(() => stop('deadline'), input.deadlineMs);
          if (input.isKillRequested) {
            killTimer = setInterval(() => {
              try {
                if (input.isKillRequested?.()) stop('kill');
              } catch (error) {
                stopForUnreadableKillAuthority(error);
              }
            }, Math.max(5, input.killPollMs ?? 100));
            killTimer.unref?.();
          }

          Promise.resolve().then(() => runWithToolAbortSignal(
            controller.signal,
            () => input.invoke({ signal: controller.signal, lease: childLease }),
            absoluteDeadlineAt,
          )).then(
            (value) => {
              if (state !== 'pending') return;
              state = 'settling';
              cleanup();
              void (async () => {
                try {
                  assertDispatchLeaseCurrent(childLease);
                  closeTop('returned');
                  const settlement = input.boundary === 'nested_owned'
                    ? adoptedNestedSettlement()
                    : logicalSettlement({ result: value, resultPresent: true });
                  if (contract.toolName === 'plan_task') {
                    enforceSettledPlanTaskResult({
                      value,
                      sessionId: input.identity.sessionId,
                      sourceUserSeq: input.identity.sourceUserSeq,
                      acceptedTaskId,
                      logicalToolCallId: modelCallId,
                    });
                  }
                  await revokeDispatchLeaseBeforeRecovery(childLease);
                  state = 'done';
                  resolve({ value, settlement });
                } catch (error) {
                  await revokeDispatchLeaseBeforeRecovery(childLease);
                  controller.abort(error);
                  state = 'done';
                  reject(error);
                }
              })();
            },
            (error) => {
              if (state !== 'pending') return;
              state = 'settling';
              cleanup();
              void (async () => {
                try {
                  assertDispatchLeaseCurrent(childLease);
                  closeTop('threw');
                  if (input.boundary === 'nested_owned') adoptedNestedSettlement();
                  else logicalSettlement({ thrown: error, thrownPresent: true });
                  await revokeDispatchLeaseBeforeRecovery(childLease);
                  state = 'done';
                  reject(error);
                } catch (authorityError) {
                  await revokeDispatchLeaseBeforeRecovery(childLease);
                  controller.abort(authorityError);
                  state = 'done';
                  reject(authorityError);
                }
              })();
            },
          );
        });
        }, nestedPhysicalDispatch);
      },
    )) as Promise<HostToolInvocationResult<T>>;
  });
}
