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
 */
export function shouldRunObjectiveJudge(input: ObjectiveJudgeGateInput): boolean {
  return (
    input.optIn &&
    input.nextAction === 'completed' &&
    input.continuationsUsed < input.maxContinuations &&
    (input.actionIntent || input.totalToolCalls >= input.workThreshold)
  );
}

export type ObjectiveJudgeFn = (
  objective: string,
  assistantResponse: string,
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

export function buildObjectiveJudgePrompt(objective: string, assistantResponse: string): string {
  return [
    `Objective: ${objective}`,
    '',
    "Assistant's most recent response (truncated to 4000 chars):",
    assistantResponse.slice(0, 4000),
    '',
    'Audit it against the objective and respond with the structured verdict.',
  ].join('\n');
}

/**
 * Judge whether the objective is genuinely complete given the assistant's most
 * recent response. FAILS OPEN (done:true) on any error so completion is never
 * blocked by a judge hiccup.
 */
export async function judgeObjectiveComplete(
  objective: string,
  assistantResponse: string,
): Promise<ObjectiveJudgeVerdict> {
  if (!objective.trim() || !assistantResponse.trim()) {
    return { done: true, reason: 'insufficient text to judge — accepting completion' };
  }
  try {
    const runner = new Runner({ workflowName: 'clementine-objective-judge' });
    const result = await runner.run(buildJudgeAgent(), buildObjectiveJudgePrompt(objective, assistantResponse), {
      maxTurns: 1,
    });
    const parsed = VerdictSchema.safeParse(result.finalOutput);
    if (!parsed.success) return { done: true, reason: 'judge output did not parse — accepting completion' };
    return { done: parsed.data.done, reason: parsed.data.reason };
  } catch {
    return { done: true, reason: 'judge unavailable — accepting completion' };
  }
}
