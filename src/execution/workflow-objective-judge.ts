import { judgeObjectiveComplete, type ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

/**
 * Workflow-level "did we reach the target?" judge.
 *
 * A background workflow is only valuable if its FINAL deliverable is exactly
 * what the user needs — it runs out of sight, so a wrong-but-confident
 * "completed" is the worst outcome (north-star: reports back without fail).
 * This is the end-of-run analogue of the chat objective judge: after the last
 * step produces the deliverable, judge it against the workflow's declared
 * target (description + body + synthesis intent + this run's inputs).
 *
 * Design constraints (all load-bearing):
 *  - FAIL OPEN. Any error / empty text / unparseable verdict → reached:true.
 *    A judge hiccup can NEVER turn a good 5am run into a false failure.
 *  - CONSERVATIVE. Only a CONFIDENT, specific miss flips the run to
 *    needs-attention; uncertainty resolves to reached. (judgeObjectiveComplete
 *    already fails toward done; the prompt reinforces it.)
 *  - DETECTION ONLY. This never re-runs the workflow — a blind re-run could
 *    double irreversible side effects (re-sent emails, duplicate records). The
 *    caller routes a miss through the existing Doctor self-heal pipeline
 *    (diagnose → propose a fix the user applies), and always DELIVERS the
 *    output with an honest "couldn't confirm the target" note.
 *  - SKIP partial single-step re-runs and runs with no deliverable.
 */

export interface WorkflowTargetVerdict {
  /** True = deliverable satisfies the target, OR we couldn't/shouldn't judge (fail-open). */
  reached: boolean;
  /** !reached → the specific missing piece. reached → satisfying evidence or skip reason. */
  gap: string;
  /** False when the judge was deliberately skipped (no target/deliverable, or a partial run). */
  judged: boolean;
}

const MAX_OBJECTIVE_CHARS = 2000;
const MAX_DELIVERABLE_CHARS = 6000;
const MAX_INPUT_SCALAR_CHARS = 200;
const JUDGE_TIMEOUT_MS = 25_000;

/** Race the judge against a wall-clock timeout so a model HANG can never stall
 *  the completion hot path. Resolves to null on timeout → caller accepts (fail-open). */
async function withJudgeTimeout<T>(p: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), JUDGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type WorkflowTargetFields = Pick<
  WorkflowDefinition,
  'name' | 'description' | 'description_body' | 'whenToUse' | 'synthesis'
>;

function truncateScalar(v: unknown): string {
  const s = typeof v === 'string' ? v : safeJson(v);
  return (s ?? '').slice(0, MAX_INPUT_SCALAR_CHARS);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Assemble the workflow's TARGET from its declared intent + this run's inputs. */
export function buildWorkflowObjective(
  workflow: WorkflowTargetFields,
  inputs: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if (workflow.description?.trim()) parts.push(workflow.description.trim());
  if (workflow.description_body?.trim()) parts.push(workflow.description_body.trim());
  else if (workflow.whenToUse?.trim()) parts.push(`When to use: ${workflow.whenToUse.trim()}`);
  if (workflow.synthesis?.prompt?.trim()) {
    parts.push(`The final deliverable should satisfy: ${workflow.synthesis.prompt.trim()}`);
  }
  const inputKeys = Object.keys(inputs ?? {});
  if (inputKeys.length) {
    const rendered = inputKeys.map((k) => `${k}=${truncateScalar(inputs[k])}`).join(', ');
    parts.push(`This run's inputs: ${rendered}`);
  }
  return parts.join('\n').slice(0, MAX_OBJECTIVE_CHARS).trim();
}

/** Render the run's final deliverable as the text the judge audits. */
export function renderDeliverableForJudge(finalOutput: unknown, fallbackBody?: string): string {
  const fromOutput =
    typeof finalOutput === 'string'
      ? finalOutput
      : finalOutput == null
        ? ''
        : safeJson(finalOutput);
  const text = fromOutput && fromOutput.trim() ? fromOutput : (fallbackBody ?? '');
  return text.slice(0, MAX_DELIVERABLE_CHARS).trim();
}

export interface JudgeWorkflowTargetInput {
  workflow: WorkflowTargetFields & { steps?: unknown };
  inputs: Record<string, unknown>;
  finalOutput: unknown;
  /** Humanized success body — fallback deliverable text when finalOutput is thin. */
  fallbackBody?: string;
  /** True for a `targetStepId` single-step re-run → not judged against the full target. */
  isPartialRun?: boolean;
  /** Test injection. Defaults to the real fail-open objective judge. */
  judgeFn?: ObjectiveJudgeFn;
}

/**
 * Judge whether the run's deliverable reached the workflow's target. Fail-open
 * + conservative + detection-only (see module doc).
 */
export async function judgeWorkflowTarget(
  opts: JudgeWorkflowTargetInput,
): Promise<WorkflowTargetVerdict> {
  if (opts.isPartialRun) {
    return {
      reached: true,
      judged: false,
      gap: 'single-step re-run — not judged against the full workflow target',
    };
  }
  const objective = buildWorkflowObjective(opts.workflow, opts.inputs);
  const deliverable = renderDeliverableForJudge(opts.finalOutput, opts.fallbackBody);
  if (!objective || !deliverable) {
    return {
      reached: true,
      judged: false,
      gap: 'no target or deliverable to judge — accepting completion',
    };
  }
  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  const objectivePrompt = [
    "This is a BACKGROUND WORKFLOW's target — the complete deliverable the user needs while they are away:",
    objective,
    '',
    'The run is successful ONLY if the deliverable below fully reaches that target. Be CONSERVATIVE: report NOT done only when a SPECIFIC required part of the target is clearly missing or unfulfilled in the deliverable. If the deliverable plausibly satisfies the target, accept it (done=true).',
  ].join('\n');
  try {
    const verdict = await withJudgeTimeout(judge(objectivePrompt, deliverable));
    if (!verdict) {
      return { reached: true, judged: false, gap: 'target judge timed out — accepting completion' };
    }
    return { reached: verdict.done, judged: true, gap: verdict.reason };
  } catch {
    return { reached: true, judged: false, gap: 'target judge unavailable — accepting completion' };
  }
}
