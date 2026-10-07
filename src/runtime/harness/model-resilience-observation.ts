import { randomUUID } from 'node:crypto';
import { appendEvent } from './eventlog.js';
import type { ResilienceTelemetryEvent, ResilienceTelemetryObserver } from './resilient-model.js';

interface ObservationOwner {
  sessionId: string;
  sourceUserSeq: number;
  runAttemptId?: string;
}

/** Observations are source-bound diagnostics, never usage or continuation authority.
 * The cached provider model cannot keep a mutable owner callback. The caller
 * scopes this observer with withModelResilienceTelemetry for one model step. */
export function createModelResilienceObservation(input: {
  owner: ObservationOwner;
  requestOrdinal: () => number | undefined;
  retired: () => boolean;
  now?: () => number;
  record?: (data: Record<string, unknown>) => void;
}): { observer: ResilienceTelemetryObserver; close: (outcome: 'returned' | 'failed' | 'cancelled') => void } {
  const { owner } = input;
  if (!owner.sessionId || !Number.isSafeInteger(owner.sourceUserSeq) || owner.sourceUserSeq <= 0) {
    throw new Error('A model timing observation requires an exact accepted source.');
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const stepId = randomUUID();
  let closed = false;
  const record = input.record ?? ((data: Record<string, unknown>) => {
    appendEvent({ sessionId: owner.sessionId, turn: 0, role: 'system',
      type: 'model_resilience_observed', data });
  });
  const emit = (fields: Record<string, unknown>): void => {
    try {
      const ordinal = input.requestOrdinal();
      record({ ...fields, version: 1, sourceUserSeq: owner.sourceUserSeq, stepId,
        ...(owner.runAttemptId ? { runAttemptId: owner.runAttemptId } : {}),
        ...(Number.isSafeInteger(ordinal) && Number(ordinal) > 0 ? { requestOrdinal: ordinal } : {}),
        retired: closed || fields.requestAborted === true || input.retired() });
    } catch { /* Diagnostics cannot change output, retry budgets or stop authority. */ }
  };
  const observer: ResilienceTelemetryObserver = (event) => {
    // Copy only declared content-free fields. A future adapter cannot smuggle
    // request bytes, raw errors or credentials into this observation channel.
    const fields: Record<string, unknown> = { phase: event.type };
    const keys: readonly string[] = [
      'callId', 'label', 'path', 'at', 'elapsedMs', 'maxRetries', 'requestAborted', 'attempt',
      'durationMs', 'outcome', 'contentCommitted', 'completionObserved',
      'failureKind', 'status', 'afterAttempt', 'nextAttempt', 'reason',
      'plannedBackoffMs', 'attemptCount', 'failedAttemptCount', 'attemptMs',
      'failedAttemptMs', 'retryWaitMs',
    ];
    const data = event as unknown as Record<string, unknown>;
    for (const key of keys) if (Object.hasOwn(data, key)) fields[key] = data[key];
    emit(fields);
  };
  return { observer, close(outcome) {
    if (closed) return;
    emit({ phase: 'host_step_finished', outcome, at: now(),
      durationMs: Math.max(0, now() - startedAt) });
    closed = true;
  } };
}
