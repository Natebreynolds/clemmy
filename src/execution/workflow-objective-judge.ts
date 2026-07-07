import { judgeObjectiveComplete, JUDGE_RESPONSE_MAX_CHARS, type ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import { withJudgeTimeout } from '../runtime/harness/judge-family.js';
import type { WorkflowDefinition, WorkflowStepOutputContract } from '../memory/workflow-store.js';
import { inferOutputContractFromPrompt } from './workflow-deliverable-hints.js';

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
// >= the binding judge cap (JUDGE_RESPONSE_MAX_CHARS) so this layer never
// pre-starves the deliverable below what the judge can actually see; matches
// DEFAULT_TOOL_RESULT_MAX_CHARS so a deliverable the model already saw in full
// can be judged in full. Overflow is windowed head+tail downstream, not lost.
const MAX_DELIVERABLE_CHARS = 12000;
// A "gap" that is really about the deliverable being cut off / not fully
// visible is an artifact of OUR length window, never a real target miss — a
// genuine miss names a missing TARGET element. Suppressed when we windowed.
const TRUNCATION_SHAPED_GAP = /truncat|cut ?off|incomplete (response|text|json|output|deliverable|data)|no complete verifiable|not fully (visible|shown|present)|appears? (to be )?(cut|incomplete)|omitted/i;
const MAX_INPUT_SCALAR_CHARS = 200;
const SEND_TARGET_RE = /\b(?:send|sent|emails?|e-?mails?|emailing|notify|notifies|notification|message|dm)\b/i;
const SEND_EVIDENCE_RE = /(?:"(?:sent|notified|delivered)"\s*:\s*true\b|(?:^|[\s,{])(?:sent|notified|delivered)\s*[:=]\s*true\b)/i;
const SEND_PROOF_RE = /"?(?:logId|messageId|notificationId|emailId|sentAt|sent_at|to|recipient|recipients|from|subject|summary)"?\s*[:=]/i;
const SEND_NEGATIVE_RE = /(?:"blocked"\s*:\s*true\b|status["']?\s*:\s*["']?blocked\b|not\s+sent|failed\s+to\s+send|could\s+not\s+send)/i;

type WorkflowTargetFields = Pick<
  WorkflowDefinition,
  'name' | 'description' | 'description_body' | 'whenToUse' | 'synthesis'
>;

type LegacyGoalStep = {
  id?: string;
  prompt?: string;
  output?: WorkflowStepOutputContract;
};

export interface LegacyWorkflowRunGoal {
  source: 'legacy';
  objective: string;
  successCriteria: string[];
  /** Legacy inferred goals never auto-re-pursue. */
  maxAttempts: 1;
}

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
  const pushUnique = (part: string | undefined): void => {
    const trimmed = part?.trim();
    if (!trimmed) return;
    if (!parts.includes(trimmed)) parts.push(trimmed);
  };
  pushUnique(workflow.description);
  if (workflow.description_body?.trim()) pushUnique(workflow.description_body);
  else if (workflow.whenToUse?.trim()) pushUnique(`When to use: ${workflow.whenToUse.trim()}`);
  if (workflow.synthesis?.prompt?.trim()) {
    pushUnique(`The final deliverable should satisfy: ${workflow.synthesis.prompt.trim()}`);
  }
  const inputKeys = Object.keys(inputs ?? {});
  if (inputKeys.length) {
    const rendered = inputKeys.map((k) => `${k}=${truncateScalar(inputs[k])}`).join(', ');
    parts.push(`This run's inputs: ${rendered}`);
  }
  return parts.join('\n').slice(0, MAX_OBJECTIVE_CHARS).trim();
}

function appendContractCriteria(out: string[], step: LegacyGoalStep): void {
  const id = step.id || 'unnamed';
  const c = step.output && Object.keys(step.output).length > 0
    ? step.output
    : inferOutputContractFromPrompt(step.prompt ?? '');
  if (!c || Object.keys(c).length === 0) return;
  if (c.required_keys?.length) {
    out.push(`Step "${id}" output includes required keys: ${c.required_keys.join(', ')}.`);
  }
  for (const p of c.non_empty ?? []) {
    out.push(`Step "${id}" output has non-empty value at "${p || '(root)'}".`);
  }
  for (const [p, min] of Object.entries(c.min_items ?? {})) {
    out.push(`Step "${id}" output has at least ${min} item(s) at "${p || '(root)'}".`);
  }
  for (const p of c.verify?.url_present ?? []) {
    out.push(`Step "${id}" output has a real non-empty http(s) URL at "${p}".`);
  }
  for (const p of c.verify?.path_exists ?? []) {
    out.push(`Step "${id}" output has an existing local file path at "${p}".`);
  }
}

export function deriveLegacyWorkflowRunGoal(
  workflow: WorkflowTargetFields & { steps?: LegacyGoalStep[] },
  inputs: Record<string, unknown>,
): LegacyWorkflowRunGoal | null {
  const objective = buildWorkflowObjective(workflow, inputs);
  if (!objective) return null;
  const successCriteria: string[] = [];
  if (workflow.synthesis?.prompt?.trim()) {
    successCriteria.push(`Final deliverable satisfies synthesis intent: ${workflow.synthesis.prompt.trim()}`);
  }
  for (const step of workflow.steps ?? []) {
    appendContractCriteria(successCriteria, step);
  }
  return {
    source: 'legacy',
    objective,
    successCriteria: [...new Set(successCriteria)],
    maxAttempts: 1,
  };
}

/** Render the run's final deliverable as the text the judge audits. */
export function renderDeliverableForJudge(finalOutput: unknown, fallbackBody?: string): string {
  const fromOutput =
    typeof finalOutput === 'string'
      ? finalOutput
      : finalOutput == null
        ? ''
        : safeJson(finalOutput);
  const text = (fromOutput && fromOutput.trim() ? fromOutput : (fallbackBody ?? '')).trim();
  if (text.length <= MAX_DELIVERABLE_CHARS) return text;
  // Self-describing cut: tell the judge the tail exists and is complete, so a
  // mid-content slice is never read as a genuinely incomplete deliverable.
  return `${text.slice(0, MAX_DELIVERABLE_CHARS)}\n\n…[deliverable truncated to ${MAX_DELIVERABLE_CHARS} chars for judging — the run's full output is longer and complete]…`;
}

function deterministicSendEvidence(objective: string, deliverable: string): string | null {
  if (!SEND_TARGET_RE.test(objective)) return null;
  if (SEND_NEGATIVE_RE.test(deliverable)) return null;
  if (!SEND_EVIDENCE_RE.test(deliverable)) return null;
  if (!SEND_PROOF_RE.test(deliverable)) return null;
  return 'structured dispatch evidence present in the workflow output';
}

export interface JudgeWorkflowTargetInput {
  workflow: WorkflowTargetFields & { steps?: unknown };
  inputs: Record<string, unknown>;
  finalOutput: unknown;
  /** Optional explicit/provisional goal. Legacy workflows pass a derived one. */
  goal?: Pick<LegacyWorkflowRunGoal, 'objective' | 'successCriteria'>;
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
  const objective = opts.goal?.objective ?? buildWorkflowObjective(opts.workflow, opts.inputs);
  const deliverable = renderDeliverableForJudge(opts.finalOutput, opts.fallbackBody);
  if (!objective || !deliverable) {
    return {
      reached: true,
      judged: false,
      gap: 'no target or deliverable to judge — accepting completion',
    };
  }
  const sendEvidence = deterministicSendEvidence(objective, deliverable);
  if (sendEvidence) {
    return { reached: true, judged: false, gap: sendEvidence };
  }
  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  // True when the deliverable is long enough that the judge sees only a
  // head+tail window of it (the slice happens inside buildObjectiveJudgePrompt
  // at JUDGE_RESPONSE_MAX_CHARS). Used to suppress truncation-shaped "gaps".
  const wasWindowedForJudge = deliverable.length > JUDGE_RESPONSE_MAX_CHARS;
  const objectivePrompt = [
    "This is a BACKGROUND WORKFLOW's target — the complete deliverable the user needs while they are away:",
    objective,
    ...((opts.goal?.successCriteria?.length ?? 0) > 0
      ? [
          '',
          'Success criteria inferred from the workflow contract and deliverable hints:',
          ...opts.goal!.successCriteria.map((c, i) => `${i + 1}. ${c}`),
        ]
      : []),
    '',
    'The run is successful ONLY if the deliverable below fully reaches that target. Be CONSERVATIVE: report NOT done only when a SPECIFIC required part of the target is clearly missing or unfulfilled in the deliverable. If the deliverable plausibly satisfies the target, accept it (done=true).',
    ...(wasWindowedForJudge
      ? ['', 'NOTE: the deliverable is shown to you windowed to its head and tail for length. Judge ONLY the visible content; NEVER report NOT done merely because the deliverable looks cut off or an expected item might sit in the omitted middle.']
      : []),
  ].join('\n');
  try {
    const verdict = await withJudgeTimeout(judge(objectivePrompt, deliverable));
    if (!verdict) {
      return { reached: true, judged: false, gap: 'target judge timed out — accepting completion' };
    }
    // A truncation-shaped gap on a deliverable WE windowed for length is a
    // self-inflicted artifact, never a real target miss — fall open so it can
    // never flip a good run to needs-attention. (Detection-only: the report
    // still delivers in full regardless of this verdict.)
    if (!verdict.done && wasWindowedForJudge && TRUNCATION_SHAPED_GAP.test(verdict.reason)) {
      return { reached: true, judged: false, gap: `truncation-shaped gap suppressed (judge saw a length-windowed view): ${verdict.reason.slice(0, 160)}` };
    }
    return { reached: verdict.done, judged: true, gap: verdict.reason };
  } catch {
    return { reached: true, judged: false, gap: 'target judge unavailable — accepting completion' };
  }
}
