/** Expand retained progress against its canonical batch. This is deliberately
 * not an executor: connection/account validation, the delivery lease, Stop,
 * original composition and remaining allowance enforcement still own entry. */
import { inspectRetainedModelBatchFromToken } from './accepted-model-batch-checkpoint.js';
import { readSourceConnectionCheckpoint } from './source-connection-checkpoints.js';
import { HostRecoveryState } from './host-turn-runner.js';

export function readSourceConnectionHostRecovery(input: { sessionId: string; requestId: string }) {
  const retained = readSourceConnectionCheckpoint(input);
  if (!retained?.hostProgress) throw new Error('The paused execution has no retained host progress.');
  const progress = retained.hostProgress;
  const reopened = inspectRetainedModelBatchFromToken(retained.restartToken);
  if (reopened.status !== 'inspected') throw new Error(`The paused execution cannot be inspected: ${reopened.reason}`);
  const batch = reopened.checkpoint;
  // The generic restart token deliberately permits later descendants. A
  // connection snapshot does not: those later calls have spent allowances
  // that this older private record cannot honestly reconstruct.
  if (batch.batchOrdinal !== progress.batch.batchOrdinal || batch.batchId !== progress.batch.batchId
    || batch.historyDigest !== retained.restartToken.resumeFromHistoryDigest) {
    throw new Error('The execution advanced beyond its retained connection progress.');
  }
  const state = progress.recovery;
  const feedback = state.completionReviewFeedback;
  if (feedback && (feedback.sessionId !== input.sessionId || feedback.sourceUserSeq !== retained.sourceUserSeq)) {
    throw new Error('The retained completion review belongs to another accepted request.');
  }
  // Use the ordinary host parser; it validates the no-progress cursor against
  // the exact canonical prefix and the retained review digests. Never clamp a
  // cursor or discard an invalid review in order to make a resume succeed.
  const hostState = HostRecoveryState.fromString(new HostRecoveryState(
    input.sessionId, retained.sourceUserSeq, 'continue', batch.history, [], [],
    batch.lastResponseId, undefined, state.turnEngine, state.noProgressCheckpoint,
    state.stepIndex, progress.batch, state.objectiveJudgeContinuations, feedback,
  ).toString());
  // A needs-input terminal currently closes host authority. Reporting that
  // fact is essential: inspection must never masquerade as executable state.
  return { hostState, progress, rootState: reopened.rootState };
}
