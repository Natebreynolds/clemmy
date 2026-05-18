import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { buildPlannerTool } from './planner.js';
import { defaultOrchestratorHandoffs } from './sub-agents.js';
import { harnessInstructions } from './harness-context.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { DEFAULT_MAX_TURNS } from '../runtime/harness/brackets.js';

/**
 * Orchestrator — the top of the 0.3 harness.
 *
 * Plan contract: this agent has ZERO action tools. It physically
 * cannot mutate state. Its tool palette is three "deliberation"
 * tools and the handoff set:
 *
 *   - draft_plan           — Planner.asTool, returns a structured Plan
 *   - request_approval     — SDK needsApproval interrupt; the harness
 *                            pauses, persists state, resolves via UI,
 *                            and resumes the run
 *   - ask_user_question    — records an awaiting_user_input event;
 *                            the next turn carries the user's reply
 *   - handoffs to {Researcher, Writer, Reviewer, Executor, Deployer}
 *
 * outputType is structured (OrchestratorDecisionSchema) so the loop
 * can reason over `done` / `nextAction` without parsing free text.
 * Per the SDK, structured output disables parallel_tool_calls on
 * this agent — sub-agents stay free-form so they retain it.
 *
 * Input + output guardrails come from the harness registry so the
 * SDK enforces policy_violation / missing_capability before any
 * tokens are spent, and secret_leak after the final output.
 */

export const OrchestratorDecisionSchema = z.object({
  summary: z
    .string()
    .min(8)
    .describe('One-sentence statement of what was decided and/or done this turn.'),
  done: z
    .boolean()
    .describe(
      'Whether the user request is fully handled. False means another turn (or user reply) is still needed.',
    ),
  nextAction: z
    .enum([
      'awaiting_user_input',
      'awaiting_approval',
      'awaiting_handoff_result',
      'completed',
      'abandoned',
    ])
    .describe('What the harness should expect next.'),
  reason: z.string().nullable().describe('Free-form context for the next caller.'),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

// ---------- internal helpers ----------

function extractSessionId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: { sessionId?: unknown } }).context;
  if (!ctx) return undefined;
  return typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined;
}

function extractTurn(runContext: unknown): number {
  if (!runContext || typeof runContext !== 'object') return 0;
  const ctx = (runContext as { context?: { turn?: unknown } }).context;
  if (!ctx) return 0;
  return typeof ctx.turn === 'number' ? ctx.turn : 0;
}

// ---------- deliberation tools ----------

const requestApprovalParams = z.object({
  subject: z.string().min(4).describe('What is being approved — one-line summary.'),
  reason: z.string().nullable().describe('Why this needs human approval. Pass null if none.'),
  destructive: z.boolean().describe('Is the approved action destructive?'),
});

export function buildRequestApprovalTool() {
  return tool({
    name: 'request_approval',
    description:
      'Pause and ask the user to approve a specific action. The harness records an approval_requested event; the next turn resumes after the user responds.',
    parameters: requestApprovalParams,
    // Force-trigger the SDK's approval interrupt. The harness catches
    // it (loop.ts awaiting_approval branch), emits approval_requested
    // with the tool args, persists RunState, and resumes after the UI
    // resolves the request. execute() only runs after approval — at
    // that point the approved action's already in motion, so the only
    // thing left is to acknowledge it to the model.
    needsApproval: async () => true,
    execute: async (args) =>
      `Approved: ${args.subject}. Proceed with the action you described.`,
  });
}

const askUserQuestionParams = z.object({
  question: z.string().min(4).describe('A single concise question for the user.'),
  options: z
    .array(z.string())
    .max(5)
    .nullable()
    .describe('Pre-canned answers; pass null if none.'),
});

export function buildAskUserQuestionTool() {
  return tool({
    name: 'ask_user_question',
    description:
      'Ask the user a clarifying question. The harness records awaiting_user_input; the next turn resumes after the user replies.',
    parameters: askUserQuestionParams,
    execute: async (args, runContext) => {
      const sessionId = extractSessionId(runContext);
      if (sessionId) {
        appendEvent({
          sessionId,
          turn: extractTurn(runContext),
          role: 'orchestrator',
          type: 'awaiting_user_input',
          data: {
            question: args.question,
            options: args.options ?? null,
          },
        });
      }
      return `Question posted: ${args.question}. Awaiting user reply.`;
    },
  });
}

// ---------- orchestrator factory ----------

const ORCHESTRATOR_INSTRUCTIONS = [
  'You are the Orchestrator at the top of the Clementine 0.3 harness.',
  'You have ZERO action tools. You cannot write files, run commands, or send messages directly. Your job is to route, plan, and decide. Doing the work is a sub-agent\'s job.',
  'Your tool palette:',
  '  - `draft_plan`         draft a structured plan when work is multi-step or the path is not obvious. Read-only.',
  '  - `request_approval`   pause and ask the user to approve a specific action. Triggers an approval interrupt — the run pauses until resolved.',
  '  - `ask_user_question`  ask the user a clarifying question when the request is ambiguous.',
  '  - handoffs:            Researcher (read-only info gathering), Writer (vault/document content), Reviewer (quality check), Executor (does the work — files, commands, tasks), Deployer (releases, deploys).',
  'Memory layering — the persistent context block above (Identity, Soul, Working Memory, top Facts, Goals, Profile) is curated and bounded. It is NOT the full history. For deeper recall — past conversations, specific files, prior decisions, archived notes — hand off to Researcher to call memory_recall / memory_search / memory_read. Do this BEFORE asking the user to repeat themselves: if the message references something they\'ve discussed with Clementine before ("that project from last week", "the file we talked about", "what we decided yesterday"), assume the answer is in memory and route to Researcher first.',
  'Decision rubric:',
  '  1. Greeting / chitchat → answer directly. No handoff, no memory call. Done.',
  '  2. Trivial single-tool ask → hand off to Executor with a one-line directive. Do not over-plan.',
  '  3. Multi-step ask → call `draft_plan` first, then hand off to the right sub-agent for step 1.',
  '  4. Destructive or external-mutating step → call `request_approval` before handing off.',
  '  5. Ambiguous ask that references prior context → hand off to Researcher to recall context FIRST, then re-decide. Only call `ask_user_question` when the request is genuinely unparseable (not when you can look it up).',
  'Return an OrchestratorDecision. Be specific. `summary` is what you decided and (if done) what was accomplished. Pick `nextAction` honestly: did you finish, are you waiting on the user, are you waiting on approval, or did you hand off and expect a follow-up turn?',
].join('\n\n');

export async function buildOrchestratorAgent(): Promise<
  Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>
> {
  const handoffs = await defaultOrchestratorHandoffs();
  const plannerTool = buildPlannerTool();

  return new Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>({
    name: 'Orchestrator',
    handoffDescription:
      'Routes work. Plans, decides, and hands off to sub-agents. Cannot mutate state directly.',
    // Function form so the SDK re-renders persistent memory context
    // (SOUL, MEMORY, IDENTITY, working memory, facts, goals) each
    // turn — vault edits and new facts surface immediately without
    // restarting the daemon.
    instructions: harnessInstructions(ORCHESTRATOR_INSTRUCTIONS),
    model: MODELS.primary,
    outputType: OrchestratorDecisionSchema,
    tools: [plannerTool, buildRequestApprovalTool(), buildAskUserQuestionTool()],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handoffs: handoffs as unknown as (Agent<any, any> | Handoff<any, any>)[],
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
