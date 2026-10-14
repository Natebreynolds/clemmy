import { AsyncLocalStorage } from 'node:async_hooks';
import { actionBus } from '../action-bus.js';
import { harnessRunContextStorage } from './brackets.js';
import { acceptedTurnCallAuthorityFor } from './accepted-turn-call-authority.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { isDispatchLeaseCurrent } from './dispatch-lease.js';
import { listActiveRunAttemptOwnership, listEvents, openEventLog } from './eventlog.js';
import { assertRecoveryActivationOwned } from './recovery-activation.js';
import { hasUndeliveredSteerNotes, type TerminalSteeringOwner } from './steer-notes.js';

/** A stale review is neither a verdict nor a reviewer failure. The ordinary
 * final-candidate caller must adopt the durable note through its existing fence. */
export class CompletionReviewSupersededError extends Error {
  constructor() { super('completion review superseded by admitted owner steering'); this.name = 'CompletionReviewSupersededError'; }
}

/** Only the final reply's semantic review runs in this child cancellation
 * context. The accepted run, business calls, evidence and accounting keep their
 * original owner. A cancelled provider call is never assumed free or settled. */
export async function reviewWithOwnerSteering<T>(
  owner: TerminalSteeringOwner | undefined,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ status: 'reviewed'; value: T } | { status: 'superseded' }> {
  const context = harnessRunContextStorage.getStore();
  if (!owner || !context || context.workerScope === true || context.directOrchestrator === false
    || context.sessionId !== owner.sessionId || context.sourceUserSeq !== owner.sourceUserSeq
    || context.runAttemptId !== owner.attemptId || context.dispatchLease?.leaseId !== owner.lease.leaseId
    || context.dispatchLease?.scopeId !== owner.lease.scopeId) return { status: 'reviewed', value: await work() };
  const parentSignals = [signal, context.callerCancelSignal].filter((value): value is AbortSignal => Boolean(value));
  const parent = parentSignals.length ? AbortSignal.any(parentSignals) : undefined;
  parent?.throwIfAborted();
  const controller = new AbortController();
  const reviewSignal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  // Bus listeners run in the ingress emitter's context. Preserve every original
  // scope, including usage and recovery activation, when checking ownership.
  const inOwner = AsyncLocalStorage.snapshot();
  let active = true, queued = false, superseded = false;
  let wake!: () => void;
  const supersession = new Promise<{ status: 'superseded' }>(resolve => { wake = () => resolve({ status: 'superseded' }); });
  const check = () => inOwner(() => {
    if (!active || superseded || parent?.aborted) return;
    try {
      const db = openEventLog();
      // appendSteerNote's outer transaction may still own the bus callback.
      // Never treat its uncommitted event (or a forged bus row) as admission.
      if (db.inTransaction || !db.open || !isDispatchLeaseCurrent(owner.lease)) return;
      assertRecoveryActivationOwned();
      const attempt = db.prepare(`SELECT source_user_seq FROM run_attempts
        WHERE session_id = ? AND attempt_id = ? AND status = 'active' AND finished_at IS NULL`)
        .get(owner.sessionId, owner.attemptId) as { source_user_seq: number | null } | undefined;
      // First scope: ordinary source-owned finals. Approval/connection delivery
      // activations retain their existing review and terminal-fence behavior.
      if (attempt?.source_user_seq !== owner.sourceUserSeq
        || listActiveRunAttemptOwnership(owner.sessionId).some(row => row.attemptId !== owner.attemptId && !row.workflowHandoff)) return;
      const authority = acceptedTurnCallAuthorityFor(owner.sessionId, owner.sourceUserSeq);
      if (authority.status !== 'ok' || authority.authority.state !== 'open'
        || !hasUndeliveredSteerNotes(owner.sessionId, owner.sourceUserSeq)) return;
      const notes = listEvents(owner.sessionId, { sinceSeq: owner.sourceUserSeq,
        types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'] });
      const next = notes.find(row => row.type === 'user_input_received' && !isLiveApprovalAcknowledgement(row))?.seq ?? Number.MAX_SAFE_INTEGER;
      const delivered = new Set(notes.flatMap(row => row.type === 'user_steer_note_delivered'
        && Array.isArray(row.data.noteSeqs) ? row.data.noteSeqs : []));
      if (!notes.some(row => row.type === 'user_steer_note' && row.role === 'user'
        && row.seq < next && !delivered.has(row.seq))) return;
      superseded = true;
      wake();
      controller.abort(new CompletionReviewSupersededError());
    } catch { /* Unknown ownership/storage retains the original wait and fence. */ }
  });
  const unsubscribe = actionBus.subscribe(event => {
    if (!active || queued || event.kind !== 'harness.event' || event.sessionId !== owner.sessionId
      || event.event.type !== 'user_steer_note' || event.event.role !== 'user'
      || !Number.isSafeInteger(event.event.seq) || event.event.seq <= owner.sourceUserSeq) return;
    queued = true;
    queueMicrotask(() => { queued = false; check(); });
  });
  let abortParent!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abortParent = () => reject(parent?.reason);
    parent?.addEventListener('abort', abortParent, { once: true });
  });
  void stopped.catch(() => {}); // A synchronous adapter failure may precede race registration.
  try {
    // Subscribe before checking notes already accepted at the review boundary.
    check();
    parent?.throwIfAborted();
    if (superseded) return { status: 'superseded' };
    parent?.throwIfAborted();
    const pending = harnessRunContextStorage.run({ ...context, callerCancelSignal: reviewSignal }, work);
    // A transport may ignore abort (Jev's assessment signal is diagnostic only).
    // Drain its eventual result/error for accounting; it cannot publish a verdict.
    void pending.catch(() => {});
    const result = await Promise.race([pending.then(value => ({ status: 'reviewed' as const, value })), supersession, stopped]);
    parent?.throwIfAborted();
    check();
    return superseded ? { status: 'superseded' } : result;
  } catch (error) {
    parent?.throwIfAborted();
    if (superseded) return { status: 'superseded' };
    throw error;
  } finally {
    active = false;
    unsubscribe();
    parent?.removeEventListener('abort', abortParent);
  }
}
