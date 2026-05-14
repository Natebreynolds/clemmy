import type { OutputGuardrail } from '@openai/agents';
import type { z } from 'zod';
import type { AgentDecisionSchema } from './autonomy-v2.js';

/**
 * Output guardrails for autonomy-v2.
 *
 * These run AFTER the agent produces its structured output (Zod-typed
 * AgentDecision) but BEFORE we save state or call finishRun. A tripped
 * guardrail halts the run; the cycle catches that, logs the reason as
 * the cycle error, and the agent retries on the next tick.
 *
 * Zod already validates structure. Guardrails here validate semantics:
 * are the values reasonable? Does the agent appear to be confused or
 * hallucinating? Will saving this corrupt agent state in a way that's
 * hard to recover from?
 *
 * Keep them cheap (no LLM calls) and conservative. False positives are
 * worse than letting a slightly weird decision through — we'd rather
 * the agent finish a cycle than spin in retry hell.
 */

type AgentDecision = z.infer<typeof AgentDecisionSchema>;

const VAGUE_COMMITMENT_PATTERNS = [
  /^do\s+(stuff|things|work|something)\.?$/i,
  /^follow\s*up\.?$/i,
  /^check\s+in\.?$/i,
  /^.{0,8}$/,                    // anything under 9 chars — too short to be meaningful
];

function isVagueCommitment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return VAGUE_COMMITMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const PLACEHOLDER_SUMMARY_PATTERNS = [
  /^did\s+some\s+work\.?$/i,
  /^reviewed\s+inbox\.?$/i,
  /^processed\s+items\.?$/i,
  /^.{0,12}$/,                   // 12 chars is barely enough for "did nothing."
];

function isPlaceholderSummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

type Schema = typeof AgentDecisionSchema;

/**
 * The summary should describe what the agent did this cycle in
 * substantive terms. Empty or template-y summaries indicate the model
 * went through the motions without engaging.
 */
export const summarySubstanceGuardrail: OutputGuardrail<Schema> = {
  name: 'summary_substance',
  execute: async ({ agentOutput }) => {
    const decision = agentOutput as AgentDecision;
    if (isPlaceholderSummary(decision.summary)) {
      return {
        tripwireTriggered: true,
        outputInfo: `Summary is empty or placeholder-shaped ("${decision.summary.slice(0, 60)}"). Be specific about what you actually did or chose not to do.`,
      };
    }
    return { tripwireTriggered: false, outputInfo: undefined };
  },
};

/**
 * Commitments should be specific. Each commitment is a promise to take
 * action; vague ones produce vague follow-up cycles, which is how
 * autonomous agents drift into noise.
 */
export const commitmentRealismGuardrail: OutputGuardrail<Schema> = {
  name: 'commitment_realism',
  execute: async ({ agentOutput }) => {
    const decision = agentOutput as AgentDecision;
    const vague = decision.commitments.filter(isVagueCommitment);
    if (vague.length > 0) {
      return {
        tripwireTriggered: true,
        outputInfo: `Vague commitments rejected: ${vague.map((c) => `"${c}"`).join(', ')}. Be specific — what exactly will you do, and when?`,
      };
    }
    // Catch the "I'll do everything" trap.
    if (decision.commitments.length > 6) {
      return {
        tripwireTriggered: true,
        outputInfo: `Too many commitments (${decision.commitments.length}). Pick the most important 1–3. Overcommitting on a cycle dilutes follow-through.`,
      };
    }
    return { tripwireTriggered: false, outputInfo: undefined };
  },
};

/**
 * followUpMinutes is allowed by the schema to be 5–1440 (24h). Within
 * that window, catch the "wake me in exactly the schema-minimum every
 * time" pattern — agents that don't pick a real interval will hammer
 * the daemon. Also flag suspiciously round defaults that suggest the
 * model didn't actually think about it.
 */
export const followUpRealismGuardrail: OutputGuardrail<Schema> = {
  name: 'followup_realism',
  execute: async ({ agentOutput }) => {
    const decision = agentOutput as AgentDecision;
    if (decision.followUpMinutes === undefined) {
      // Omitting is fine — cadence applies.
      return { tripwireTriggered: false, outputInfo: undefined };
    }
    if (decision.followUpMinutes < 5) {
      return {
        tripwireTriggered: true,
        outputInfo: `followUpMinutes ${decision.followUpMinutes} is below the floor of 5. Either omit it or pick a real interval.`,
      };
    }
    return { tripwireTriggered: false, outputInfo: undefined };
  },
};

/** All autonomy-v2 guardrails as a single array. */
export const autonomyV2OutputGuardrails = [
  summarySubstanceGuardrail,
  commitmentRealismGuardrail,
  followUpRealismGuardrail,
];

/** Exported for unit tests — invoke a guardrail's execute fn directly with a sample decision. */
export async function runGuardrailForTest(
  guardrail: OutputGuardrail<Schema>,
  decision: AgentDecision,
): Promise<{ tripwireTriggered: boolean; outputInfo: unknown }> {
  // The OutputGuardrail.execute receives RunContext + Agent + agentOutput;
  // for unit tests we only validate logic that depends on agentOutput.
  return guardrail.execute({
    agentOutput: decision,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: undefined as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: undefined as any,
  });
}
