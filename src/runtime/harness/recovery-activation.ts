import { readApprovalRecoveryActivationRead, readConnectionRecoveryActivationRead, type RecoveryActivationOwner } from './recovery-activation-read.js';
export type { RecoveryActivationOwner } from './recovery-activation-read.js';
/** Delivery activation and execution source are distinct after a task control.
 * This scope changes checkpoint ownership only, never tool/batch authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSession, openEventLog } from './eventlog.js';
import { readConnectionExecutionActivation } from './connection-execution-activation-proof.js';
import { readApprovalExecutionSource } from './approval-execution-source.js';

const scope = new AsyncLocalStorage<{ sessionId: string; owner: RecoveryActivationOwner; assertOwned?: () => void }>();

export function withRecoveryActivation<T>(sessionId: string, owner: RecoveryActivationOwner, fn: () => T, assertOwned?: () => void): T {
  if (owner.approvalContinuation && owner.connectionContinuation) throw new Error('A recovery cannot have two activation kinds.');
  return scope.run({ sessionId, owner, ...(assertOwned ? { assertOwned } : {}) }, fn);
}

/** Process-local dispatch guard, never persisted as authority. The executor
 * supplies a reader of the current durable lease, Stop and account binding. */
export function assertRecoveryActivationOwned(): void { scope.getStore()?.assertOwned?.(); }

export function recoveryActivationOwner(sessionId: string, owner: RecoveryActivationOwner): RecoveryActivationOwner {
  const active = scope.getStore();
  return active?.sessionId === sessionId
    && (active.owner.approvalContinuation ?? active.owner.connectionContinuation)?.requestSourceUserSeq === owner.sourceUserSeq
    ? { ...active.owner, ...(owner.attemptId ? { attemptId: owner.attemptId } : {}) }
    : owner;
}

/** The attempt a delivery activation runs its linked request under. The
 * request's own review keeps that attempt only while this exact activation,
 * delivery source and attempt are current; any other scope names none. */
export function activationAttemptForRequest(sessionId: string,
  delivery: { sourceUserSeq: number; attemptId?: string }, requestSourceUserSeq: number): string | undefined {
  const active = scope.getStore();
  const link = active?.owner.approvalContinuation ?? active?.owner.connectionContinuation;
  return active?.sessionId === sessionId && link?.requestSourceUserSeq === requestSourceUserSeq
    && active.owner.sourceUserSeq === delivery.sourceUserSeq && active.owner.attemptId
    && active.owner.attemptId === delivery.attemptId ? active.owner.attemptId : undefined;
}

const activationReader = { database: openEventLog, metadata: (sessionId: string) => getSession(sessionId)?.metadata };
export function readApprovalRecoveryActivation(sessionId: string): RecoveryActivationOwner | null {
  return readApprovalRecoveryActivationRead(sessionId, activationReader);
}
export function readConnectionRecoveryActivation(sessionId: string): RecoveryActivationOwner | null {
  return readConnectionRecoveryActivationRead(sessionId, activationReader);
}
export function readRecoveryActivation(sessionId: string): RecoveryActivationOwner | null {
  return readConnectionRecoveryActivation(sessionId) ?? readApprovalRecoveryActivation(sessionId);
}

/** The host's durable resume marker binds publication to the work actually
 * reviewed. Never borrow a latest-session verdict or trust a caller's source. */
export function completionEvidenceSource(input: { sessionId: string; sourceUserSeq: number }): typeof input {
  const db = openEventLog();
  const row = db.prepare("SELECT data_json FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'")
    .get(input.sessionId, input.sourceUserSeq) as { data_json: string } | undefined;
  if (!row) return input;
  const control = JSON.parse(row.data_json) as Record<string, unknown>;
  if (control.source === 'connection_continuation') {
    const connection = readConnectionExecutionActivation(db, { sessionId: input.sessionId, deliverySourceUserSeq: input.sourceUserSeq });
    // An accepted setup-shaped message alone is not a continuation. A missing
    // or invalid durable activation must never borrow an execution source.
    if (!connection) throw new Error('The connection control has no durable activation.');
    return { sessionId: input.sessionId, sourceUserSeq: connection.activation.executionSourceUserSeq };
  }
  const source = readApprovalExecutionSource(db, input);
  return source === null ? input : { sessionId: input.sessionId, sourceUserSeq: source };
}
