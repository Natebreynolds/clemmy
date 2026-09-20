import { createHash } from 'node:crypto';
import type { ObjectiveJudgeGateInput } from './objective-judge.js';

/** Positive evidence for one narrow intentional skip. This is metadata only:
 * neither its presence nor its absence may waive an execution/review gate. */
export function isConversationalReviewSkip(gate: ObjectiveJudgeGateInput): boolean {
  return gate.optIn === true && gate.actionIntent === false
    && gate.meaningfulToolEvidence === false && gate.sourceWorkAttempted === false
    && gate.settledSourceEffects === 0 && gate.settledEvidenceAvailable === true
    && gate.nextAction === 'completed' && gate.promiseShaped === false
    && gate.claimedCompletedWork === false && gate.openApprovalCard === false
    && gate.continuationsUsed === 0;
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function reviewSkipReason(gate: ObjectiveJudgeGateInput): string | undefined {
  if (isConversationalReviewSkip(gate)) return 'conversation_without_work';
  // The existing policy does not review non-action lookups with no attempted
  // work. A bare path/URL trips the broad completion-claim heuristic without
  // changing that decision. Record the skip, not a fictitious reviewer outage.
  // This certifies only policy disposition, never the content of that answer.
  if (gate.claimedCompletedWork === true
    && isConversationalReviewSkip({ ...gate, claimedCompletedWork: false })) {
    return 'non_action_without_new_work';
  }
  // The existing judge policy also skips a single-result action answered from
  // retained history with no new work or completion claim. Describe that exact
  // branch; this record neither changes eligibility nor certifies the answer.
  if (gate.actionIntent === true && gate.meaningfulToolEvidence === true
    && gate.multiResultObjective === false && gate.acceptedExecutionEvidence === false
    && isConversationalReviewSkip({ ...gate, actionIntent: false, meaningfulToolEvidence: false })) {
    return 'retained_context_without_new_work';
  }
  return undefined;
}

export function conversationalReviewSkipRecord(input: {
  sourceUserSeq: number; objective: string; reply: string; gate: ObjectiveJudgeGateInput;
}): Record<string, unknown> | undefined {
  const reason = reviewSkipReason(input.gate);
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq < 1
    || !input.objective.trim() || !reason) return undefined;
  return { version: 1, sourceUserSeq: input.sourceUserSeq, reason,
    objectiveDigest: digest(input.objective), replyDigest: digest(input.reply), gate: input.gate };
}

export function conversationalReviewSkipMatches(raw: unknown, input: {
  sourceUserSeq: number; objective: string; reply: string;
}): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const data = raw as Record<string, unknown>;
  if (!data.gate || typeof data.gate !== 'object' || Array.isArray(data.gate)) return false;
  const reason = reviewSkipReason(data.gate as ObjectiveJudgeGateInput);
  return data.version === 1 && reason !== undefined && data.reason === reason
    && data.sourceUserSeq === input.sourceUserSeq
    && data.objectiveDigest === digest(input.objective) && data.replyDigest === digest(input.reply)
    ;
}
