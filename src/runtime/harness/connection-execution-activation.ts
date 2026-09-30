/** Server-owned activation of one retained reviewed task. Account verification
 * is not tool consent. This function installs recovery only; it calls no model
 * and performs no business action. UI Execute continuation remains disabled
 * until the executor, completion closure and installed acceptance are wired. */
import {
  appendEvent, getHarnessChatCancellation, getLatestRunAttemptByRunId, getRunAttemptBySourceUserSeq, isKillRequested,
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

/** Recheck around asynchronous preparation and before dispatch. Historical
 * activation/recovery records establish identity, not current ownership. A
 * replayed button receipt cannot reacquire a lease or undo Stop. */
export function assertConnectionExecutionOwned(input: {
  sessionId: string; deliverySourceUserSeq: number; attemptId: string; leaseOwner: string;
}): void {
  const db = openEventLog();
  const marker = readConnectionExecutionActivation(db, input);
  if (!marker) throw new Error('This connection continuation has no durable activation.');
  const { activation } = marker;
  const owner = readConnectionRecoveryActivation(input.sessionId);
  const session = HarnessSession.load(input.sessionId);
  if (owner?.sourceUserSeq !== input.deliverySourceUserSeq || owner.attemptId !== input.attemptId
    || owner.connectionContinuation?.activationEventId !== marker.eventId
    || session?.continuationOwnerState(owner) !== 'ours') {
    throw new Error('This connection continuation no longer owns the conversation.');
  }
  const attempt = getLatestRunAttemptByRunId(input.sessionId, activation.runId);
  if (!attempt || attempt.attemptId !== input.attemptId || attempt.sourceUserSeq !== input.deliverySourceUserSeq
    || attempt.status !== 'active' || attempt.finishedAt || attempt.leaseOwner !== input.leaseOwner
    || !liveLease(attempt.leaseExpiresAt) || isKillRequested(input.sessionId, attempt)) {
    throw new Error('This connection continuation does not own a live execution lease.');
  }
  if (getHarnessChatCancellation(activation.receiptRequestId)
    || originalTaskStopped(input.sessionId, activation.executionSourceUserSeq)) {
    throw new Error('The original task or its connection continuation was stopped.');
  }
  const latest = db.prepare(`SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received'
    AND role = 'user' AND (json_type(data_json, '$.synthetic') IS NULL OR json_type(data_json, '$.synthetic') = 'false')
    ORDER BY seq DESC LIMIT 1`).get(input.sessionId) as { seq: number } | undefined;
  if (latest?.seq !== input.deliverySourceUserSeq) throw new Error('A newer request owns this conversation.');
  assertConnectionContinuationAccount({ sessionId: input.sessionId, connectionRequestId: activation.requestId }, activation.verificationBinding);
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
