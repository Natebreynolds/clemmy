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

/** Reuse the authenticated target-review evidence for pinned goals as well.
 * Large reads/writes stay behind exact refs instead of growing every prompt. */
export function workflowGoalExecutionEvidence(target: WorkflowTargetEvidence, definition: unknown): {
  summary: string; evidence: JudgeEvidenceSource;
} {
  const counts = new Map<string, number>();
  for (const result of target.results ?? []) {
    const key = JSON.stringify({ tool: result.toolName, status: result.status, outcome: result.outcome });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts].map(([key, count]) => `${key}: ${count}`);
  const refs = new Map((target.evidence?.refs() ?? []).map(ref => [ref, ref]));
  return {
    summary: [
      `Workflow execution evidence available: ${target.available}. Receipt verification is not proof of objective completion.`,
      ...entries.slice(0, 40),
      ...(entries.length > 40 ? [`${entries.length - 40} additional tool/outcome groups are retained; omitted groups are not absent.`] : []),
      'Open workflow_execution for authenticated read AND write receipts, and workflow_contract for the saved workflow instructions and constraints. Output keys and a URL alone do not prove fulfillment or preservation of existing data.',
    ].join('\n'),
    evidence: {
      refKind: 'the saved workflow contract, authenticated execution receipts, and retained result contents',
      refs: () => ['workflow_contract', 'workflow_execution', ...refs.keys()],
      resolve(ref) {
        if (ref === 'workflow_contract') return { text: JSON.stringify(definition), value: definition };
        if (ref === 'workflow_execution') return { text: target.summary };
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
