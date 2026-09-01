import {
  hasRegisteredStepContract,
  peekStepResult,
} from '../../tools/step-result-tool.js';
import { auditAcceptedSourceSettlementTruth } from './accepted-source-settlement-audit.js';

export const MAX_WORKFLOW_STEP_RESULT_CONTINUATIONS = 2;

export interface WorkflowTerminalDecisionLike {
  done?: boolean;
  nextAction?: string;
}

export function workflowStepDecisionEndedWithoutResult(
  decision: WorkflowTerminalDecisionLike | null | undefined,
): boolean {
  if (!decision) return true;
  if (
    decision.nextAction === 'awaiting_user_input'
    || decision.nextAction === 'awaiting_approval'
    || decision.nextAction === 'awaiting_handoff_result'
  ) return false;
  return decision.done === true || decision.nextAction === 'abandoned';
}

/**
 * A workflow with an active output contract is not allowed to turn partial
 * prose into a terminal. Keep the SAME accepted source and retained results
 * alive long enough to finish unfinished work and emit workflow_step_result.
 *
 * This is intentionally not a blind retry. An in-flight call, uncertain write,
 * or unreadable settlement spine cannot start another model/effect pass. Known
 * failures remain recoverable; successful calls remain retained and must not
 * be repeated.
 */
export function missingWorkflowStepResultContinuation(input: {
  sessionId: string;
  sourceUserSeq: number | undefined;
  endedWithoutResult: boolean;
  used: number;
  stepIndex: number;
  maxSteps: number;
}): { directive: string; auditStatus: string; auditReason: string } | null {
  if (
    !hasRegisteredStepContract(input.sessionId)
    || peekStepResult(input.sessionId).found
    || !input.endedWithoutResult
    || input.used >= MAX_WORKFLOW_STEP_RESULT_CONTINUATIONS
    || input.stepIndex >= input.maxSteps
    || !Number.isSafeInteger(input.sourceUserSeq)
    || (input.sourceUserSeq ?? 0) <= 0
  ) return null;

  const audit = auditAcceptedSourceSettlementTruth({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq as number,
    requiresBusinessEvidence: false,
    requireEveryBusinessReadToSettle: false,
  });
  if (
    audit.status === 'in_flight'
    || audit.status === 'uncertain_write'
    || audit.status === 'storage_error'
  ) return null;

  return {
    auditStatus: audit.status,
    auditReason: audit.reason,
    directive: [
      'WORKFLOW STEP CONTINUATION — this step is not complete because it has not emitted its required structured result.',
      'All prior calls and returned results are retained in this same accepted step. Reuse them; do not repeat a successful call or any write whose outcome is uncertain.',
      audit.status === 'unrecovered_failure'
        ? `Repair the known failed call(s) while preserving successful work (${audit.reason}).`
        : 'Continue only the unfinished actions from the original workflow step.',
      'When the required work is actually complete, call the ACTUAL workflow_step_result tool exactly once with the contracted JSON object.',
      'Do not answer in prose and do not declare completion before that tool call settles.',
    ].join(' '),
  };
}
