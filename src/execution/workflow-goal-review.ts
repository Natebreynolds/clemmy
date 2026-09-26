import { validateGoal, type ValidateGoalInput, type ValidateGoalDeps, type GoalValidationResult } from './goal-validate.js';
import type { WorkflowTargetEvidence } from './workflow-target-evidence.js';
import type { JudgeEvidenceSource } from '../runtime/harness/judge-evidence-tools.js';

/** Output contracts prove their individual criteria, not the whole workflow.
 * Keep objective coverage in the same batched review as the parked criteria. */
export function validateWorkflowRunGoal(input: ValidateGoalInput, deps: ValidateGoalDeps = {}) {
  const objectiveCriterion = `Complete the full workflow objective, including its constraints: ${input.objective}`;
  return validateGoal({
    ...input,
    successCriteria: [...input.successCriteria.filter(criterion => typeof criterion === 'string'
      ? criterion !== objectiveCriterion : criterion.scope !== 'objective'),
      { criterion: objectiveCriterion, scope: 'objective' }],
  }, deps);
}

/** A follow-up attempt's view of the attempts before it: what they landed,
 * which steps it carried from them, and their authenticated receipts. */
export interface WorkflowGoalEarlierAttempts {
  attempts: Array<{ runId: string; target: WorkflowTargetEvidence }>;
  carriedStepIds: string[];
  /** Plain lines naming the writes earlier attempts landed. */
  landedSummary: string;
}

/** Reuse the authenticated target-review evidence for pinned goals as well.
 * Large reads/writes stay behind exact refs instead of growing every prompt. */
export function workflowGoalExecutionEvidence(
  target: WorkflowTargetEvidence,
  definition: unknown,
  earlier?: WorkflowGoalEarlierAttempts,
): {
  summary: string; evidence: JudgeEvidenceSource;
} {
  const counts = new Map<string, number>();
  for (const result of target.results ?? []) {
    const key = JSON.stringify({ tool: result.toolName, status: result.status, outcome: result.outcome });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts].map(([key, count]) => `${key}: ${count}`);
  const refs = new Map((target.evidence?.refs() ?? []).map(ref => [ref, ref]));
  // An earlier attempt exposes its execution summary and, under its own run
  // id, every retained receipt its evidence holds. The reviewer opens those
  // with the same tools as this run's, and an earlier attempt's ref name can
  // never shadow one of this run's.
  const earlierSummaries = new Map((earlier?.attempts ?? []).map((attempt) => [`earlier_attempt_execution:${attempt.runId}`, attempt.target]));
  const earlierRetained = new Map<string, { target: WorkflowTargetEvidence; ref: string }>();
  for (const attempt of earlier?.attempts ?? []) {
    for (const ref of attempt.target.evidence?.refs() ?? []) {
      earlierRetained.set(`earlier_attempt:${attempt.runId}/${ref}`, { target: attempt.target, ref });
    }
  }
  const earlierLines = earlier && earlier.attempts.length > 0
    ? [
        `This run follows up on earlier attempts of the same goal (${earlier.attempts.map((attempt) => attempt.runId).join(', ')}). Their writes landed and stay; this run was not asked to repeat them.`,
        ...(earlier.carriedStepIds.length > 0
          ? [`Steps carried as completed from the attempt before this one, not re-executed here: ${earlier.carriedStepIds.join(', ')}. Their outputs above are the recorded outputs of that attempt.`]
          : []),
        ...(earlier.landedSummary ? [earlier.landedSummary] : []),
        `Open ${[...earlierSummaries.keys()].join(', ')} for the authenticated receipts of those attempts${earlierRetained.size > 0
          ? `; their ${earlierRetained.size} retained result${earlierRetained.size === 1 ? '' : 's'} open under refs of the form earlier_attempt:<run id>/<ref>`
          : ''}.`,
      ]
    : [];
  return {
    summary: [
      `Workflow execution evidence available: ${target.available}. Receipt verification is not proof of objective completion.`,
      ...entries.slice(0, 40),
      ...(entries.length > 40 ? [`${entries.length - 40} additional tool/outcome groups are retained; omitted groups are not absent.`] : []),
      'Open workflow_execution for authenticated read AND write receipts, and workflow_contract for the saved workflow instructions and constraints. Output keys and a URL alone do not prove fulfillment or preservation of existing data.',
      ...earlierLines,
    ].join('\n'),
    evidence: {
      refKind: 'the saved workflow contract, authenticated execution receipts, and retained result contents',
      refs: () => ['workflow_contract', 'workflow_execution', ...earlierSummaries.keys(), ...earlierRetained.keys(), ...refs.keys()],
      resolve(ref) {
        if (ref === 'workflow_contract') return { text: JSON.stringify(definition), value: definition };
        if (ref === 'workflow_execution') return { text: target.summary };
        const earlierTarget = earlierSummaries.get(ref);
        if (earlierTarget) return { text: earlierTarget.summary };
        const retained = earlierRetained.get(ref);
        if (retained) return retained.target.evidence?.resolve(retained.ref);
        const original = refs.get(ref);
        return original === undefined ? undefined : target.evidence?.resolve(original);
      },
    },
  };
}

/** Keep approved criterion identities stable for recurrence admission. The
 * additional whole-objective verdict is separate, but still contributes to
 * the overall pass bit and the workflow's terminal disposition. */
export function workflowGoalValidationReceipt(input: {
  objective: string; successCriteria: string[]; verdict: GoalValidationResult; validatedAt: string;
}) {
  const objectiveReview = input.verdict.perCriterion.find(criterion => criterion.scope === 'objective');
  return {
    version: 1 as const,
    objective: input.objective,
    successCriteria: [...input.successCriteria],
    pass: input.verdict.pass,
    judgeFailedOpen: input.verdict.judgeFailedOpen === true,
    perCriterion: input.verdict.perCriterion.filter(criterion => criterion.scope !== 'objective')
      .map(criterion => ({ ...criterion })),
    ...(objectiveReview ? { objectiveReview: { ...objectiveReview } } : {}),
    validatedAt: input.validatedAt,
  };
}
