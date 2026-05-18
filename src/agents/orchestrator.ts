import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { buildPlannerTool } from './planner.js';
import { defaultOrchestratorHandoffs } from './sub-agents.js';
import { harnessInstructions } from './harness-context.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import type { Tool } from '@openai/agents';
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
  'Researcher returned "not found" — when Researcher reports it could not locate the specific thing the user asked about after a reasonable search, DO NOT hand off again hoping for better results. Call `ask_user_question` with what was searched and a concrete question about where to look ("I searched <list of places> for <thing the user asked about> and didn\'t find it — is it in a specific folder I should look in, or somewhere outside the linked workspaces?"). One cheap clarifying exchange beats burning another budget on the same dead-end.',
  'After approval — when the user has just approved a destructive / external-mutating action, you ALREADY have what you need to hand off. Do not emit a structured output saying "I cannot continue because the tool is not available." Instead, hand off to the sub-agent that can actually do the work (almost always Executor for cx_* / Composio actions, file writes, shell commands, or external API calls; Writer for drafts; Deployer for releases). The handoffs are real — you can see them in your tool list as transfer_to_Researcher / transfer_to_Writer / transfer_to_Reviewer / transfer_to_Executor / transfer_to_Deployer. If you genuinely don\'t see the handoff you need, ask the user with a specific question about what tool/integration to enable — never silently give up after collecting approval.',
  'External actions — DISCOVER YOURSELF, then EXECUTE. Composio is part of Clementine; you have direct access to `composio_search_tools` (read-only, doesn\'t violate the no-action-tools rule). When the user wants an action on a connected external service (Instagram post, Slack DM, Trello card, send an email, anything outside the curated cx_* tools):',
  '  1. Call `composio_search_tools` with a focused query (e.g. {query: "instagram create post", toolkit_slug: "instagram"}). It returns matching slugs + parameter schemas for whichever toolkits the user has connected. No need to hand off to Researcher for this — discovery is YOUR job.',
  '  2. Pick the best matching slug. Compose the JSON args from the returned `inputParameters` schema.',
  '  3. Call `request_approval` (external mutations need user consent). Surface the resolved slug in the approval summary.',
  '  4. After approval, hand off to Executor — and FILL IN THE STRUCTURED HANDOFF INPUT. The transfer_to_Executor tool expects:',
  '       { directive: "<one line of what to do>", toolCall: { slug: "<exact slug>", args: "<JSON string of args>", rationale: "<why or null>" } | null }',
  '     For external Composio actions, populate toolCall with the slug you discovered and the JSON-encoded args. For non-Composio work (file writes, shell commands, tracked-execution updates), set toolCall: null. The Executor reads this directly and calls composio_execute_tool with your slug/args — no re-discovery on its end. Same shape applies for transfer_to_Deployer.',
  '  Handing off without populating toolCall when the work IS a Composio action forces the Executor to either re-discover (wasted turn) or fail. Fill the structured input every time.',
  'EXCEPTIONS:',
  '  - If a curated `cx_<toolkit>_<action>` obviously matches (e.g. user says "send a Gmail draft" and there\'s a cx_gmail_create_draft), skip the search step. Hand off with toolCall: null and the Executor will call the cx_* tool directly from its own surface.',
  '  - If composio_search_tools returns no matches AND no curated cx_* exists, ask the user with ask_user_question what they want — DO NOT silently report "tool not available." The status field on returned toolkits is informational only; Composio reports EXPIRED for connections that work fine, so do not refuse to attempt a tool just because the status looks stale. Let the actual execute call surface a real error if there is one.',
  'Return an OrchestratorDecision. Be specific. `summary` is what you decided and (if done) what was accomplished. Pick `nextAction` honestly: did you finish, are you waiting on the user, are you waiting on approval, or did you hand off and expect a follow-up turn?',
].join('\n\n');

export async function buildOrchestratorAgent(): Promise<
  Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>
> {
  // The 0.3 harness uses request_approval as the gate for
  // destructive and external-mutating work, so the v0.2 "tracked
  // execution" pre-condition that gated Executor/Deployer handoffs
  // is redundant here. Without disabling that gate, the orchestrator
  // sees no transfer_to_Executor in its tool surface (the handoff
  // is hidden by isEnabled until a tracked execution exists) and
  // gives up with "tool not available" even after the user approved
  // the action.
  const handoffs = await defaultOrchestratorHandoffs({
    requireWorkflowApprovalForExecution: false,
  });
  const plannerTool = buildPlannerTool();

  // Read-only Composio discovery tool. Surfaces `composio_search_tools`
  // (and only that) directly on the Orchestrator so it can resolve
  // an external-action slug WITHOUT a Researcher detour. This is the
  // discover-once-then-execute pattern in code: the Orchestrator
  // owns "what tool should run", the Executor owns "run it". Search
  // is pure read — it doesn't violate the orchestrator's
  // zero-action-tools discipline (it doesn't mutate; it returns
  // descriptions). composio_execute_tool is NOT added here — that
  // stays on the Executor side of the handoff boundary.
  const allCoreTools = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const composioSearch = allCoreTools.find(
    (t) => (t as { name?: string }).name === 'composio_search_tools',
  ) as Tool<RuntimeContextValue> | undefined;
  const composioTools: Tool<RuntimeContextValue>[] = composioSearch ? [composioSearch] : [];

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
    tools: [plannerTool, buildRequestApprovalTool(), buildAskUserQuestionTool(), ...composioTools],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handoffs: handoffs as unknown as (Agent<any, any> | Handoff<any, any>)[],
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
