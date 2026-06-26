import { judgeObjectiveComplete, type ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import { summarizeToolCallsForJudge } from '../runtime/harness/skill-execution.js';
import { withJudgeTimeout } from '../runtime/harness/judge-family.js';
import { loadSkill } from '../memory/skill-store.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

/**
 * Per-step skill-execution judge — the workflow-path half of the global "run
 * skills as designed" fix (chat already has Layer 2 via the objective judge).
 *
 * A workflow step that declares `usesSkill` has the skill BODY prepended to its
 * prompt by applySkillToPrompt — it is a procedure the step committed to
 * execute, not background reading. This judge verifies the step actually
 * EXECUTED that skill (produced its deliverables), using the skill's own text
 * as the rubric + the step session's tool-call evidence. It catches the
 * PARTIAL-skip class (e.g. a redesign skill that prescribes generating imagery
 * while no image tool fired).
 *
 * Note: the chat helpers gatherSessionSkills/sessionReadAnySkill key off the
 * `skill_read` TOOL — but workflow steps inject the skill via prompt-prepend,
 * NOT skill_read — so this module loads the skill body directly from
 * `step.usesSkill` instead. Tool-call evidence still comes from the shared
 * summarizeToolCallsForJudge (it reads `tool_called` events, which DO fire).
 *
 * FAIL-OPEN throughout: any error / missing skill / empty text resolves to
 * executed:true so the judge can never wedge or false-fail a real step. Engages
 * ONLY for steps that declare `usesSkill`; every other step is untouched and
 * zero-cost.
 */

export interface StepSkillVerdict {
  /** True = the step executed its skill (or we couldn't/shouldn't judge → fail-open). */
  executed: boolean;
  /** !executed → the specific skipped deliverable. executed → evidence / skip reason. */
  reason: string;
  /** False when the judge was deliberately skipped (no usesSkill, unloadable skill, no output). */
  judged: boolean;
}

const MAX_DELIVERABLE_CHARS = 6000;

export interface JudgeStepSkillInput {
  step: WorkflowStepInput;
  /** The real harness session id the step ran in (for tool-call evidence). */
  sessionId: string;
  /** The step (or forEach item) output. */
  output: unknown;
  /** The rendered step prompt/intent (without the injected skill body). */
  stepIntent?: string;
  /** Test injection. Defaults to the real fail-open objective judge. */
  judgeFn?: ObjectiveJudgeFn;
  /** Test injection. Defaults to the real skill-store loader. */
  loadSkillBody?: (name: string) => string | null;
  /** Test injection. Defaults to the shared tool-call summarizer. */
  toolSummaryFn?: (sessionId: string) => string;
}

function renderOutput(output: unknown): string {
  const s = typeof output === 'string' ? output : output == null ? '' : safeJson(output);
  return (s ?? '').slice(0, MAX_DELIVERABLE_CHARS).trim();
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function defaultLoadSkillBody(name: string): string | null {
  try {
    const skill = loadSkill(name);
    const body = (skill?.body ?? '').trim();
    return body || null;
  } catch {
    return null;
  }
}

/**
 * Judge whether a `usesSkill` step executed its skill. Fail-open + conservative.
 * Returns executed:true (judged:false) for any step that doesn't declare a
 * skill, whose skill can't be loaded, or that produced no output.
 */
export async function judgeStepSkillExecution(
  opts: JudgeStepSkillInput,
): Promise<StepSkillVerdict> {
  const skillName = opts.step.usesSkill?.trim();
  if (!skillName) {
    return { executed: true, judged: false, reason: 'step declares no skill — nothing to enforce' };
  }
  const loadBody = opts.loadSkillBody ?? defaultLoadSkillBody;
  const body = loadBody(skillName);
  if (!body) {
    // applySkillToPrompt already fails loud BEFORE execution when a declared
    // skill is missing, so reaching here without a body means a transient
    // loader hiccup — fail open rather than false-fail a completed step.
    return { executed: true, judged: false, reason: `skill "${skillName}" body unavailable — accepting` };
  }
  const deliverable = renderOutput(opts.output);
  if (!deliverable) {
    return { executed: true, judged: false, reason: 'no step output to judge — accepting' };
  }
  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  const objective = [
    `This workflow step committed to EXECUTE the "${skillName}" skill. The skill's full text was INJECTED directly into the step's prompt, so the step did NOT need to read it via any tool — do NOT treat "no file/skill read happened" as a miss.`,
    opts.stepIntent?.trim() ? `Step task: ${opts.stepIntent.trim().slice(0, 1500)}` : '',
    'Judge ONLY whether the skill\'s concrete OUTPUT DELIVERABLES were produced — a created file, generated image, deployed/published URL, written record, or sent message. IGNORE internal/process steps (reading a reference file, "review the brand voice", thinking steps) — those are satisfied by the injected text and produce no tool evidence. Be CONSERVATIVE: report NOT done ONLY when the skill clearly prescribes a concrete output artifact that is plainly absent from the deliverable and the tool-call evidence. If it plausibly produced the deliverables, accept it (done=true). A pure-advice/persona skill with no concrete output artifact has nothing to enforce → done=true.',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    // toolSummary is built INSIDE the try so a summarizer hiccup also fails open.
    const toolSummary = (opts.toolSummaryFn ?? summarizeToolCallsForJudge)(opts.sessionId);
    const verdict = await withJudgeTimeout(
      judge(objective, deliverable, { skills: [{ name: skillName, body }], toolCallSummary: toolSummary }),
    );
    if (!verdict) {
      return { executed: true, judged: false, reason: 'step skill judge timed out — accepting' };
    }
    return { executed: verdict.done, judged: true, reason: verdict.reason };
  } catch {
    return { executed: true, judged: false, reason: 'step skill judge unavailable — accepting' };
  }
}
