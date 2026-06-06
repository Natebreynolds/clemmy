import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../../config.js';
import { JUDGE_SYSTEM_PROMPT } from '../../agents/goal-loop.js';
import type { RuntimeContextValue } from '../../types.js';
import { normalizeZodForCodexStrict } from '../schema-normalizer.js';

/**
 * Independent objective-completion judge for the chat continuation loop.
 *
 * The harness loop already auto-continues until the ORCHESTRATOR declares
 * itself done (loop.ts). But LLMs over-declare completion — they answer "here
 * is what I'd do" or promise an artifact and stop. Hermes' edge is an
 * INDEPENDENT judge that verifies real evidence before yielding. This reuses
 * the same audit-checklist prompt as the /goal loop (JUDGE_SYSTEM_PROMPT) but
 * is invoked as a GATE on self-declared completion, so it FAILS OPEN: any
 * error / unparseable verdict resolves to done:true, so a flaky judge can
 * never wedge a turn that the model believes is finished.
 */

export interface ObjectiveJudgeVerdict {
  done: boolean;
  reason: string;
}

export interface ObjectiveJudgeGateInput {
  /** The chat caller opted in (workflow steps never do). */
  optIn: boolean;
  /** The objective classified as an explicit ACTION ("build/deploy/set up…"). */
  actionIntent: boolean;
  /** Tool calls made across the whole conversation so far. */
  totalToolCalls: number;
  /** A turn at/above this many tool calls did substantive multi-step work. */
  workThreshold: number;
  /** Independent judge continuations already spent this turn. */
  continuationsUsed: number;
  /** Hard cap on judge continuations. */
  maxContinuations: number;
  /** The orchestrator's self-declared next action. */
  nextAction: string;
  /**
   * The reply is a future-tense PROMISE of work ("I'll prep them…", "let me go
   * build that") with no evidence of an actual artifact/result. These are the
   * turns that look low-effort (non-action intent, few tool calls) and so used
   * to skip the judge — exactly the "chatbot" shape where Clem narrates intent
   * and marks itself done. Computed at the callsite from the reply text.
   */
  promiseShaped?: boolean;
}

/**
 * Whether to run the independent completion judge on a self-declared `done`.
 *
 * Gate on OBSERVED WORK, not phrasing. A turn that fired several tool calls did
 * real multi-step work and is worth verifying — even when the request reads as
 * a "lookup" ("find me the accounts and drop them in a sheet" classifies as
 * lookup but is multi-step action). The intent branch keeps the cheap path for
 * a clearly-phrased ACTION objective. A trivial lookup ("what's on my
 * calendar") stays below the work threshold and is never judged.
 *
 * PLUS: a PROMISE-SHAPED reply (future-tense intent, no artifact) is always
 * judged even when it looks low-effort — that is the precise turn where the
 * model says "I'll do that next" and completes without doing it. The judge's
 * own rubric rejects "a promise or plan", so running it forces a real artifact
 * or an honest blocker. Fail-open + bounded by maxContinuations, so a false
 * positive costs one cheap judge call, never a wedge.
 */
export function shouldRunObjectiveJudge(input: ObjectiveJudgeGateInput): boolean {
  return (
    input.optIn &&
    input.nextAction === 'completed' &&
    input.continuationsUsed < input.maxContinuations &&
    (input.actionIntent || input.totalToolCalls >= input.workThreshold || Boolean(input.promiseShaped))
  );
}

/**
 * Detect a future-tense PROMISE of work with no evidence of a produced artifact.
 * Pure + exported for tests. Future/deferral phrasing ("I'll…", "let me…",
 * "going to…", "let's…") with NO completion/artifact marker ("done", "created",
 * a URL, a path, "here's…"). The artifact whitelist suppresses false positives
 * on turns that actually delivered something. English-only (a backstop after the
 * existing observed-work gate, not the primary signal).
 */
const PROMISE_PHRASE_RE =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|going to|about to|let me|let'?s|i can (?:now )?(?:go|start|begin|prep|put together|pull)|once you|next i'?ll|then i'?ll|i'?ll go (?:ahead|and))\b/i;
const ARTIFACT_EVIDENCE_RE =
  /\b(?:done|completed|finished|created|drafted|generated|saved|wrote|written|sent|posted|updated|added|attached|here'?s|here is|i'?ve (?:created|drafted|saved|sent|added|updated|built|put together)|https?:\/\/|\/[\w.-]+\/)/i;

export function isPromiseShapedReply(reply?: string | null): boolean {
  const text = (reply ?? '').trim();
  if (!text) return false;
  return PROMISE_PHRASE_RE.test(text) && !ARTIFACT_EVIDENCE_RE.test(text);
}

/** Optional skill-execution rubric: the skills loaded this session + compact
 *  evidence of what tools actually fired. When present, the judge verifies the
 *  agent EXECUTED the skill (produced its deliverables), not just read it. */
export interface SkillExecutionContext {
  skills: { name: string; body: string }[];
  toolCallSummary: string;
}

export type ObjectiveJudgeFn = (
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
) => Promise<ObjectiveJudgeVerdict>;

const VerdictSchema = z.object({
  done: z.boolean().describe('True only when the objective is satisfied with verifiable evidence (artifact, URL, file path, emitted result) — not a promise or plan.'),
  reason: z.string().describe('One short sentence naming the missing evidence, or the artifact that satisfied the objective.'),
});

function buildJudgeAgent(): Agent<RuntimeContextValue, typeof VerdictSchema> {
  return new Agent<RuntimeContextValue, typeof VerdictSchema>({
    name: 'ObjectiveCompletionJudge',
    instructions: JUDGE_SYSTEM_PROMPT,
    model: MODELS.fast,
    outputType: normalizeZodForCodexStrict(VerdictSchema) as typeof VerdictSchema,
    tools: [],
  });
}

export function buildObjectiveJudgePrompt(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): string {
  const parts = [
    `Objective: ${objective}`,
    '',
    "Assistant's most recent response (truncated to 4000 chars):",
    assistantResponse.slice(0, 4000),
  ];
  if (skillContext && skillContext.skills.length > 0) {
    parts.push(
      '',
      '=== SKILLS LOADED THIS SESSION — verify they were EXECUTED, not just read ===',
      'A loaded skill is a procedure the assistant committed to run. For EACH skill below, check the assistant actually carried out its prescribed steps and produced its deliverables (a file, image, URL, record, deploy). Use the tool-call evidence: if a skill clearly prescribes a step (e.g. generate imagery, run a bundled script, create a file) and the evidence shows that step was NOT done, the objective is NOT done — set done=false and name the specific skipped step. A pure-advice/persona skill with no concrete deliverables has nothing to enforce.',
      `Tool calls made this session: ${skillContext.toolCallSummary || '(none recorded)'}`,
      ...skillContext.skills.map((s) => `\n--- skill: ${s.name} (first 2500 chars) ---\n${s.body.slice(0, 2500)}`),
    );
  }
  parts.push('', 'Audit it against the objective and respond with the structured verdict.');
  return parts.join('\n');
}

/**
 * Judge whether the objective is genuinely complete given the assistant's most
 * recent response. FAILS OPEN (done:true) on any error so completion is never
 * blocked by a judge hiccup.
 */
export async function judgeObjectiveComplete(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): Promise<ObjectiveJudgeVerdict> {
  if (!objective.trim() || !assistantResponse.trim()) {
    return { done: true, reason: 'insufficient text to judge — accepting completion' };
  }
  try {
    const runner = new Runner({ workflowName: 'clementine-objective-judge' });
    const result = await runner.run(buildJudgeAgent(), buildObjectiveJudgePrompt(objective, assistantResponse, skillContext), {
      maxTurns: 1,
    });
    const parsed = VerdictSchema.safeParse(result.finalOutput);
    if (!parsed.success) return { done: true, reason: 'judge output did not parse — accepting completion' };
    return { done: parsed.data.done, reason: parsed.data.reason };
  } catch {
    return { done: true, reason: 'judge unavailable — accepting completion' };
  }
}
