/** Private progress at a host connection pause. No history, credentials,
 * callable grants, or new execution owner live here. The canonical batch
 * journal remains the sole owner of conversation and settled-result bytes. */
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';
import type { HostRecoveryState } from './host-turn-runner.js';

export interface HostConnectionProgress {
  version: 1;
  batch: AcceptedModelBatchRef;
  recovery: Pick<HostRecoveryState, 'turnEngine' | 'stepIndex' | 'noProgressCheckpoint'
    | 'objectiveJudgeContinuations' | 'completionReviewFeedback'>;
  activation: {
    maxTurns: number;
    toolCalls: { used: number; limit: number };
    elapsedMs: number;
    judgeCompletion: boolean;
  };
  continuations: {
    acceptedReadPlanUsed: boolean;
    acceptedUniqueWorkflowUsed: boolean;
    workflowStepResultUsed: number;
    continueMarkerUsed: number;
    planFinalPublishSpent: boolean;
    modelStallRetriesRemaining: number;
    judgedBusinessCallsAtLastVerdict?: number;
  };
  watcher: {
    checksUsed: number;
    injectionsUsed: number;
    deliveredSteers: number;
    unresolvedDrift: boolean;
    lastCheckedAt: number;
    lastFailureSeq: number;
    /** A pending verdict is not a completed review. Re-entry must read fresh
     * evidence, never fabricate an on-track result for the unfinished call. */
    checkInFlight: boolean;
    /** A verdict waiting for the next model boundary must survive a pause.
     * Its ordinary objective/plan/settlement freshness checks still apply. */
    pendingSteer?: {
      onTrack: boolean; miss: string; steer: string;
      objective: string; reviewId: string; workerProgress: string;
      toolCallCount: number; planIdentity: string;
    };
  };
}

// One bounded record per agent, replaced on entry. Reusing an agent for a new
// source cannot inherit its previous task's private continuation counters.
const progress = new WeakMap<object, HostConnectionProgress>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function clearHostConnectionProgress(agent: object): void { progress.delete(agent); }

export function assertHostConnectionProgress(value: HostConnectionProgress): void {
  const fail = () => { throw new Error('The retained host connection progress is inconsistent.'); };
  if (!value || value.version !== 1 || !value.batch || !value.recovery
    || !value.activation || !value.continuations || !value.watcher) return fail();
  const { batch, recovery, activation, continuations, watcher } = value;
  const natural = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const nonempty = (s: unknown) => typeof s === 'string' && s.length > 0;
  if (!nonempty(batch.sessionId) || !natural(batch.sourceUserSeq) || batch.sourceUserSeq < 1
    || !nonempty(batch.acceptedTaskId) || !nonempty(batch.batchId) || !nonempty(batch.authorityDigest)
    || !natural(batch.batchOrdinal) || batch.batchOrdinal < 1
    || !['host_v1', 'host_v1_read_only'].includes(recovery.turnEngine)
    || !natural(recovery.stepIndex) || !natural(recovery.objectiveJudgeContinuations)
    || !natural(activation.maxTurns) || activation.maxTurns < 1
    || !activation.toolCalls || !natural(activation.toolCalls.used)
    || !natural(activation.toolCalls.limit) || activation.toolCalls.limit < 1
    || !natural(activation.elapsedMs) || typeof activation.judgeCompletion !== 'boolean'
    || !natural(continuations.workflowStepResultUsed) || !natural(continuations.continueMarkerUsed)
    || !natural(continuations.modelStallRetriesRemaining)
    || (continuations.judgedBusinessCallsAtLastVerdict !== undefined
      && !natural(continuations.judgedBusinessCallsAtLastVerdict))
    || !natural(watcher.checksUsed) || !natural(watcher.injectionsUsed)
    || !natural(watcher.deliveredSteers) || !natural(watcher.lastCheckedAt) || !natural(watcher.lastFailureSeq)
    || [continuations.acceptedReadPlanUsed, continuations.acceptedUniqueWorkflowUsed,
      continuations.planFinalPublishSpent, watcher.unresolvedDrift, watcher.checkInFlight]
      .some(v => typeof v !== 'boolean')) return fail();
  const pending = watcher.pendingSteer;
  if (pending !== undefined && (!pending || typeof pending.onTrack !== 'boolean'
    || !natural(pending.toolCallCount)
    || [pending.miss, pending.steer, pending.objective, pending.reviewId, pending.workerProgress, pending.planIdentity]
      .some(v => typeof v !== 'string'))) return fail();
}

export function bindHostConnectionProgress(agent: object, value: HostConnectionProgress): void {
  assertHostConnectionProgress(value);
  progress.set(agent, clone(value));
}

export function boundHostConnectionProgress(agent: object | undefined,
  source: { sessionId: string; sourceUserSeq: number }): HostConnectionProgress | undefined {
  const value = agent && progress.get(agent);
  return value && value.batch.sessionId === source.sessionId && value.batch.sourceUserSeq === source.sourceUserSeq
    ? clone(value) : undefined;
}
