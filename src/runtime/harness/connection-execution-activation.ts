/** Server-owned activation of one retained reviewed task. Account verification
 * is not tool consent. This function installs recovery only; it calls no model
 * and performs no business action. UI Execute continuation remains disabled
 * until the executor, completion closure and installed acceptance are wired. */
import {
  appendEvent, claimRunAttemptLease, getHarnessChatCancellation, getLatestRunAttempt, getLatestRunAttemptByRunId,
  getRunAttemptBySourceUserSeq, isKillRequested, renewRunAttemptLease,
  openEventLog, recordRunAttemptUserInput, withEventPublicationTransaction, type EventRow,
} from './eventlog.js';
import {
  assertConnectionContinuationAccount, assertConnectionContinuationCurrent, connectionContinuationAudience, connectionContinuationIdentity,
  readConnectionSetup,
  type ConnectionContinuationVerification, type ConnectionSetupContext,
} from './connection-setup.js';
import { readConnectionExecutionPause } from './connection-execution-pause.js';
import { readSourceConnectionCheckpoint } from './source-connection-checkpoints.js';
import { readSourceConnectionHostRecovery } from './connection-host-recovery.js';
import { readConnectionExecutionActivation, type ConnectionExecutionActivationV1 } from './connection-execution-activation-proof.js';
import { HarnessSession } from './session.js';
import { readConnectionRecoveryActivation, withRecoveryActivation, type RecoveryActivationOwner } from './recovery-activation.js';
import { resolveExactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import { HostRecoveryState } from './host-turn-runner.js';
import { readConnectionPreparationHold } from './connection-preparation-hold.js';
import { readConnectionExecutionProgress } from './connection-execution-progress.js';
import { prepareAcceptedModelBatchRestart } from './accepted-model-batch-checkpoint.js';

export const CONNECTION_EXECUTION_LEASE_MS = 90_000;
export const CONNECTION_EXECUTION_LEASE_RENEW_MS = 30_000;

export class ConnectionExecutionOwnershipError extends Error {
  constructor(message: string) { super(message); this.name = 'ConnectionExecutionOwnershipError'; }
}

type ExecutionOwnerInput = { sessionId: string; deliverySourceUserSeq: number; attemptId: string };

/** Recheck around asynchronous preparation and before dispatch. Historical
 * activation/recovery records establish identity, not current ownership. A
 * replayed button receipt cannot reacquire a lease or undo Stop. */
function readConnectionExecutionOwner(input: ExecutionOwnerInput) {
  const db = openEventLog();
  const marker = readConnectionExecutionActivation(db, input);
  if (!marker) throw new Error('This connection continuation has no durable activation.');
  const { activation } = marker;
  const owner = readConnectionRecoveryActivation(input.sessionId);
  const session = HarnessSession.load(input.sessionId);
  if (owner?.sourceUserSeq !== input.deliverySourceUserSeq || owner.attemptId !== input.attemptId
    || owner.connectionContinuation?.activationEventId !== marker.eventId
    || session?.continuationOwnerState(owner) !== 'ours') {
    throw new ConnectionExecutionOwnershipError('This connection continuation no longer owns the conversation.');
  }
  const attempt = getLatestRunAttemptByRunId(input.sessionId, activation.runId);
  if (!attempt || attempt.attemptId !== input.attemptId || attempt.sourceUserSeq !== input.deliverySourceUserSeq) {
    throw new ConnectionExecutionOwnershipError('This connection continuation no longer owns its execution attempt.');
  }
  if (isKillRequested(input.sessionId, attempt) || getHarnessChatCancellation(activation.receiptRequestId)
    || originalTaskStopped(input.sessionId, activation.executionSourceUserSeq)) {
    throw new Error('The original task or its connection continuation was stopped.');
  }
  const latest = db.prepare(`SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received'
    AND role = 'user' AND (json_type(data_json, '$.synthetic') IS NULL OR json_type(data_json, '$.synthetic') = 'false')
    ORDER BY seq DESC LIMIT 1`).get(input.sessionId) as { seq: number } | undefined;
  if (latest?.seq !== input.deliverySourceUserSeq) throw new ConnectionExecutionOwnershipError('A newer request owns this conversation.');
  assertConnectionContinuationAccount({ sessionId: input.sessionId, connectionRequestId: activation.requestId }, activation.verificationBinding);
  return { marker, owner, session, attempt };
}

export function assertConnectionExecutionOwned(input: ExecutionOwnerInput & { leaseOwner: string }): void {
  const { attempt } = readConnectionExecutionOwner(input);
  if (attempt.status !== 'active' || attempt.finishedAt || attempt.leaseOwner !== input.leaseOwner
    || !liveLease(attempt.leaseExpiresAt)) {
    throw new ConnectionExecutionOwnershipError('This connection continuation does not own a live execution lease.');
  }
}

/** Renewal is not acquisition. Even this process must not resurrect an
 * expired lease after a long sleep or overwrite a successor's ownership. */
export function renewConnectionExecutionLease(input: ExecutionOwnerInput & { leaseOwner: string }): void {
  withEventPublicationTransaction(() => {
    assertConnectionExecutionOwned(input);
    if (!renewRunAttemptLease({ sessionId: input.sessionId, attemptId: input.attemptId },
      input.leaseOwner, CONNECTION_EXECUTION_LEASE_MS)) {
      throw new ConnectionExecutionOwnershipError('This connection continuation lost its execution lease.');
    }
  });
}

/** Reconstruct only the latest proven batch with the running executor's exact
 * spent allowances. This installs bookkeeping, never a lease or permission to
 * dispatch. Missing, stale, partial or uncertain evidence stays retained. */
export function promoteConnectionExecutionCheckpoint(input: {
  sessionId: string; deliverySourceUserSeq: number;
}): boolean {
  return withEventPublicationTransaction(() => {
    const marker = readConnectionExecutionActivation(openEventLog(), input);
    if (!marker) return false;
    const prior = getLatestRunAttemptByRunId(input.sessionId, marker.activation.runId);
    if (!prior || prior.sourceUserSeq !== input.deliverySourceUserSeq) return false;
    const owned = readConnectionExecutionOwner({ ...input, attemptId: prior.attemptId });
    if (owned.session.loadRecoveryState()) return true;
    if (getLatestRunAttempt(input.sessionId)?.attemptId !== prior.attemptId
      || (prior.status !== 'active' && prior.status !== 'interrupted')
      || (prior.status === 'active' && liveLease(prior.leaseExpiresAt))
      || resolveExactTerminalForAcceptedSource(readControlSource(input.sessionId, input.deliverySourceUserSeq)).kind !== 'absent') return false;
    const progress = readConnectionExecutionProgress(input.sessionId, owned.owner);
    if (!progress) return false;
    const prepared = prepareAcceptedModelBatchRestart({ sessionId: input.sessionId,
      sourceUserSeq: marker.activation.executionSourceUserSeq });
    if (prepared.status !== 'ready') return false;
    const batch = prepared.checkpoint;
    if ((['sessionId', 'sourceUserSeq', 'acceptedTaskId', 'batchOrdinal', 'batchId', 'authorityDigest'] as const)
      .some(key => batch[key] !== progress.batch[key])) return false;
    const state = progress.recovery;
    const recovery = HostRecoveryState.fromString(new HostRecoveryState(input.sessionId, batch.sourceUserSeq,
      'continue', batch.history, [], [], batch.lastResponseId, undefined, state.turnEngine,
      state.noProgressCheckpoint, state.stepIndex, progress.batch, state.objectiveJudgeContinuations,
      state.completionReviewFeedback, progress).toString());
    const retained = readSourceConnectionCheckpoint({ sessionId: input.sessionId, requestId: marker.activation.requestId });
    if (!retained?.agent) return false;
    const saved = withRecoveryActivation(input.sessionId, owned.owner, () => owned.session.saveRecoveryState(
      recovery.toString(), { owner: { sourceUserSeq: batch.sourceUserSeq, attemptId: prior.attemptId },
        mcpToolScope: retained.agent!.mcpToolScope }));
    if (!saved.installed) throw new Error('The connection checkpoint promotion could not retain its current owner.');
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'restart_recovery_decision',
      parentEventId: marker.eventId, data: { decision: 'connection_execution_checkpoint_promoted',
        sourceUserSeq: input.deliverySourceUserSeq, executionSourceUserSeq: batch.sourceUserSeq,
        attemptId: prior.attemptId, batchId: batch.batchId, batchOrdinal: batch.batchOrdinal,
        stepIndex: state.stepIndex, toolCallsUsed: progress.activation.toolCalls.used } });
    return true;
  });
}

/** Only a trusted recovery/retry dispatcher calls this. A browser receipt is
 * not a lease. Keep the exact current blob; never reinstall the setup pause. */
export function claimConnectionExecutionRecovery(input: {
  sessionId: string; deliverySourceUserSeq: number; leaseOwner: string; purpose: 'recovery' | 'retry';
}) {
  return withEventPublicationTransaction(() => {
    const db = openEventLog();
    const marker = readConnectionExecutionActivation(db, input);
    if (!marker) throw new Error('The connection recovery has no retained execution.');
    const source = readControlSource(input.sessionId, input.deliverySourceUserSeq);
    const prior = getLatestRunAttemptByRunId(input.sessionId, marker.activation.runId);
    if (!prior || prior.sourceUserSeq !== input.deliverySourceUserSeq) throw new Error('The retained execution attempt is missing.');
    const terminal = resolveExactTerminalForAcceptedSource(source);
    if (terminal.kind === 'terminal') return { claimed: false as const, reason: 'terminal' as const, attempt: prior };
    if (terminal.kind !== 'absent') throw new Error('The connection terminal cannot be verified.');
    const owned = readConnectionExecutionOwner({ ...input, attemptId: prior.attemptId });
    if (getLatestRunAttempt(input.sessionId)?.attemptId !== prior.attemptId) {
      throw new ConnectionExecutionOwnershipError('A newer execution attempt owns this conversation.');
    }
    if (input.purpose === 'recovery' && readConnectionPreparationHold(input)) {
      return { claimed: false as const, reason: 'connection_wait' as const, attempt: prior };
    }
    if (prior.status === 'active' && liveLease(prior.leaseExpiresAt)) {
      return { claimed: false as const, reason: 'active' as const, attempt: prior };
    }
    if (!owned.session.loadRecoveryState()) {
      promoteConnectionExecutionCheckpoint(input);
      owned.session.refresh();
    }
    const blob = owned.session.loadRecoveryState();
    if (!blob) throw new Error('Connection recovery needs its current canonical checkpoint; the setup pause was not restored.');
    const recovery = HostRecoveryState.fromString(blob);
    if (recovery.sourceUserSeq !== marker.activation.executionSourceUserSeq || !recovery.connectionProgress) {
      throw new Error('The connection recovery lost its retained execution progress.');
    }
    if (prior.status !== 'active' && prior.status !== 'interrupted') throw new Error('The prior connection attempt cannot be resumed.');
    const claim = claimRunAttemptLease({ sessionId: input.sessionId, runId: marker.activation.runId,
      ownerId: input.leaseOwner, leaseMs: CONNECTION_EXECUTION_LEASE_MS });
    if (!claim.claimed) return claim;
    const nextAttempt = claim.attempt;
    if (!nextAttempt) throw new Error('The connection recovery lease has no execution attempt.');
    const owner = activationOwner(marker.activation, marker.eventId, nextAttempt.attemptId);
    withRecoveryActivation(input.sessionId, owner, () => {
      recordRunAttemptUserInput(nextAttempt, { turn: source.turn, role: 'user', data: source.data },
        { existingEventSeq: source.seq, armRunInFlight: true });
      const saved = owned.session.saveRecoveryState(blob, { mcpToolScope: owned.session.loadRecoveryMcpToolScope(),
        owner: { sourceUserSeq: recovery.sourceUserSeq, attemptId: nextAttempt.attemptId } });
      if (!saved.installed || !owned.session.claimContinuationOwner({ sourceUserSeq: recovery.sourceUserSeq,
        attemptId: nextAttempt.attemptId })) throw new Error('The connection recovery could not adopt its current checkpoint.');
    });
    assertConnectionExecutionOwned({ ...input, attemptId: nextAttempt.attemptId });
    appendEvent({ sessionId: input.sessionId, turn: source.turn, role: 'system', type: 'restart_recovery_decision',
      parentEventId: marker.eventId, data: { decision: 'connection_execution_lease_adopted', sourceUserSeq: source.seq,
        executionSourceUserSeq: recovery.sourceUserSeq, previousAttemptId: prior.attemptId,
        attemptId: nextAttempt.attemptId, purpose: input.purpose } });
    return claim;
  });
}

function liveLease(expiresAt: string | null): boolean {
  const expiration = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(expiration) && expiration > Date.now();
}

function originalTaskStopped(sessionId: string, sourceUserSeq: number): boolean {
  const original = getRunAttemptBySourceUserSeq(sessionId, sourceUserSeq);
  const requestId = readControlSource(sessionId, sourceUserSeq).data.requestId;
  return Boolean((typeof requestId === 'string' && getHarnessChatCancellation(requestId))
    || (original && (['failed', 'cancelled', 'superseded'].includes(original.status) || isKillRequested(sessionId, original))));
}

export function activateConnectionExecution(input: {
  context: ConnectionSetupContext;
  verified: ConnectionContinuationVerification;
  text: string;
  clientRequestId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
}): { kind: 'activated' | 'existing'; source: EventRow; owner: RecoveryActivationOwner; activation: ConnectionExecutionActivationV1 } {
  return withEventPublicationTransaction(() => {
    const { sessionId, connectionRequestId: requestId } = input.context;
    const identity = connectionContinuationIdentity(input.context, input.text, input.clientRequestId);
    const audience = connectionContinuationAudience(input.context, input.runId, input.text);
    const db = openEventLog();
    const existing = readConnectionExecutionActivation(db, { sessionId, requestId });
    if (existing) {
      if (existing.activation.receiptRequestId !== identity.requestId || existing.activation.inputHash !== identity.inputHash
        || existing.activation.runId !== input.runId) throw new Error('This connection already belongs to another continuation.');
      const source = readControlSource(sessionId, existing.activation.deliverySourceUserSeq);
      // Returning an existing receipt never reinstalls the old checkpoint. The
      // task may already have spent more work since that first activation.
      return { kind: 'existing', source, activation: existing.activation,
        owner: activationOwner(existing.activation, existing.eventId) };
    }
    assertConnectionContinuationCurrent(input.context, input.verified.sourceUserSeq, input.verified.binding);
    if (readConnectionSetup(sessionId, requestId)?.continueLabel !== input.text) throw new Error('This is not the original connection continuation action.');
    const paused = readConnectionExecutionPause(sessionId, requestId);
    if (!paused || paused.sourceUserSeq !== input.verified.sourceUserSeq) throw new Error('The reviewed task has no current connection pause.');
    const attempt = getLatestRunAttemptByRunId(sessionId, input.runId);
    if (!attempt || attempt.attemptId !== input.attemptId || attempt.status !== 'active' || attempt.finishedAt
      || attempt.leaseOwner !== input.leaseOwner || !liveLease(attempt.leaseExpiresAt)
      || attempt.sourceUserSeq != null || isKillRequested(sessionId, attempt)) {
      throw new Error('This connection continuation does not own a live execution lease.');
    }
    if (originalTaskStopped(sessionId, paused.sourceUserSeq)) throw new Error('The original task was stopped or replaced.');
    const retained = readSourceConnectionCheckpoint({ sessionId, requestId })!;
    const recovery = readSourceConnectionHostRecovery({ sessionId, requestId });
    if (recovery.rootState !== 'open') throw new Error('The original execution is no longer open.');
    const session = HarnessSession.load(sessionId);
    if (!session || session.loadRecoveryState()) throw new Error('Another checkpoint already owns this conversation.');
    const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
      text: input.text, displayText: input.text, source: 'connection_continuation', connectionRequestId: requestId,
      ...audience, requestId: identity.requestId, clientRequestId: identity.requestId, runId: input.runId,
      attemptId: attempt.attemptId,
    } }, { armRunInFlight: true });
    const activation: ConnectionExecutionActivationV1 = { version: 1, requestId, pauseEventId: paused.eventId,
      checkpointDigest: paused.binding.checkpointDigest, executionSourceUserSeq: paused.sourceUserSeq,
      deliverySourceUserSeq: source.seq, receiptRequestId: identity.requestId, inputHash: identity.inputHash,
      runId: input.runId, verificationBinding: input.verified.binding };
    const marker = appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'run_resumed', parentEventId: source.id,
      data: { connectionContinuationVersion: 1, connectionContinuation: activation } });
    const owner = activationOwner(activation, marker.id, attempt.attemptId);
    withRecoveryActivation(sessionId, owner, () => {
      const saved = session.saveRecoveryState(recovery.hostState.toString(), {
        owner: { sourceUserSeq: paused.sourceUserSeq, attemptId: attempt.attemptId }, mcpToolScope: retained.agent!.mcpToolScope,
      });
      if (!saved.installed || !session.claimContinuationOwner({ sourceUserSeq: paused.sourceUserSeq, attemptId: attempt.attemptId })) {
        throw new Error('The connection continuation could not retain its execution owner.');
      }
    });
    // Validate before commit/publication, including the newly accepted control.
    if (!readConnectionExecutionActivation(db, { sessionId, activationEventId: marker.id })) {
      throw new Error('The connection activation was not persisted.');
    }
    return { kind: 'activated', source, owner, activation };
  });
}

function activationOwner(activation: ConnectionExecutionActivationV1, eventId: string, attemptId?: string): RecoveryActivationOwner {
  return { sourceUserSeq: activation.deliverySourceUserSeq, ...(attemptId ? { attemptId } : {}),
    connectionContinuation: { requestSourceUserSeq: activation.executionSourceUserSeq,
      requestId: activation.requestId, activationEventId: eventId } };
}

function readControlSource(sessionId: string, sourceUserSeq: number): EventRow {
  // Use the ordinary row projection without rewriting accepted control bytes.
  const row = openEventLog().prepare(`SELECT id, seq, turn, role, parent_event_id, data_json, created_at
    FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'`)
    .get(sessionId, sourceUserSeq) as { id: string; seq: number; turn: number; role: string;
      parent_event_id: string | null; data_json: string; created_at: string } | undefined;
  if (!row) throw new Error('The connection continuation lost its accepted control.');
  return { id: row.id, seq: row.seq, sessionId, turn: row.turn, role: row.role, type: 'user_input_received',
    parentEventId: row.parent_event_id, data: JSON.parse(row.data_json), createdAt: row.created_at };
}
