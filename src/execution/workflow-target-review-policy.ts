import { getRuntimeEnv } from '../config.js';
import { captureBoundaryJudgeSelection, isCapturedBoundaryJudgeSelection, type CapturedBoundaryJudgeSelection } from '../runtime/harness/debate-model.js';
import { readCapturedCompletionPolicy } from '../runtime/harness/host-turn-runner.js';
import { readWorkflowRunOriginRecords } from '../tools/workflow-run-queue.js';
import { readWorkflowRunRecordUnlocked, withWorkflowRunRecordLock, writeWorkflowRunRecordDurablyUnlocked } from './workflow-run-record.js';

export type WorkflowTargetReviewPolicy = {
  version: 1;
  status: 'captured';
  enabled: boolean;
  judgeSelection: CapturedBoundaryJudgeSelection;
} | { version: 1; status: 'unavailable'; reason: string };

function unavailable(reason: string): WorkflowTargetReviewPolicy {
  return { version: 1, status: 'unavailable', reason };
}

export function parseWorkflowTargetReviewPolicy(value: unknown): WorkflowTargetReviewPolicy {
  if (value && typeof value === 'object') {
    const policy = value as Record<string, unknown>;
    if (policy.version === 1 && policy.status === 'captured' && typeof policy.enabled === 'boolean'
      && isCapturedBoundaryJudgeSelection(policy.judgeSelection)) return policy as WorkflowTargetReviewPolicy;
    if (policy.version === 1 && policy.status === 'unavailable' && typeof policy.reason === 'string' && policy.reason.trim()) {
      return policy as WorkflowTargetReviewPolicy;
    }
  }
  return unavailable('The saved workflow review policy is unreadable.');
}

/** This optional reviewer follows the accepted chat's capture when there is
 * one. Scheduled/legacy runs capture the owner's setting at first execution
 * admission. A resumed run never chooses again from mutable global settings.
 * A capture outage disables only optional review, never workflow execution.
 */
function effectivePolicy(runId: string): WorkflowTargetReviewPolicy {
  const policies: WorkflowTargetReviewPolicy[] = [];
  for (const origin of readWorkflowRunOriginRecords(runId)) {
    if (origin.version !== 2) continue;
    const captured = readCapturedCompletionPolicy({ sessionId: origin.originSessionId, sourceUserSeq: origin.sourceUserSeq });
    if (captured.status === 'unreadable') return unavailable('The originating request review policy is unreadable.');
    if (captured.status === 'captured') policies.push({ version: 1, status: 'captured',
      enabled: captured.policy.enabled, judgeSelection: captured.policy.judgeSelection });
  }
  if (policies.length) return policies.every((value) => JSON.stringify(value) === JSON.stringify(policies[0]))
    ? policies[0]!
    : unavailable('Joined requests have different review policies; their own report-back reviews retain those choices.');
  return { version: 1, status: 'captured',
    enabled: (getRuntimeEnv('CLEMMY_COMPLETION_REVIEW', 'on') || 'on').trim().toLowerCase() !== 'off',
    judgeSelection: captureBoundaryJudgeSelection() };
}

export function captureWorkflowTargetReviewPolicy(filePath: string, runId: string): WorkflowTargetReviewPolicy {
  try {
    return withWorkflowRunRecordLock(filePath, () => {
      const record = readWorkflowRunRecordUnlocked<{ id: string; targetReviewPolicy?: unknown }>(filePath);
      if (!record || record.id !== runId) return unavailable('The exact workflow run record is unavailable.');
      if (Object.hasOwn(record, 'targetReviewPolicy')) return parseWorkflowTargetReviewPolicy(record.targetReviewPolicy);
      const policy = effectivePolicy(runId);
      writeWorkflowRunRecordDurablyUnlocked(filePath, { ...record, targetReviewPolicy: policy });
      return policy;
    });
  } catch {
    return unavailable('The workflow review policy could not be captured.');
  }
}
