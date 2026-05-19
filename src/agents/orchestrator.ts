import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { buildPlannerTool } from './planner.js';
import { defaultOrchestratorHandoffs } from './sub-agents.js';
import { harnessInstructions } from './harness-context.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { Tool } from '@openai/agents';
import { appendEvent } from '../runtime/harness/eventlog.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { DEFAULT_MAX_TURNS, wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';

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
    .describe('One-sentence INTERNAL description of what you decided and/or did this turn. This is a log entry, NOT what the user sees. e.g. "Replied to greeting directly", "Handed off to Researcher for slug discovery".'),
  reply: z
    .string()
    .nullish()
    .describe('The natural-language message to show the user IN THIS TURN. REQUIRED whenever you answer directly without handing off (e.g. greetings, simple questions, confirmations). Pass null ONLY when you are handing off, asking for approval, or otherwise not the one producing the user-visible text. Without a reply here, the chat surface renders nothing and the user sees an empty bubble.'),
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

/**
 * Detect when the orchestrator is asking for approval on something that
 * is clearly LOCAL (memory / vault / tasks / plans / goals / files in
 * the user's workspace). The user already consented by asking; an
 * approval gate here is friction the user reads as a bug.
 *
 * Observed failure mode (sess-mpbpih0u, 2026-05-18 14:27): user said
 * "save salesforce CLI rule to memory please" → orchestrator called
 * request_approval(subject="Save Salesforce access rule to memory",
 * destructive:false) → the user's later "approve" landed on a
 * different paused session, and the rule was never written. The agent
 * then re-asked the same context question on every follow-up because
 * the rule didn't make it into the vault.
 *
 * Returns true when the subject + reason patterns indicate a local
 * save the orchestrator should NOT have gated. Used by needsApproval
 * to skip the SDK interrupt, so the request_approval call acts like
 * an auto-resolved "yes" and the orchestrator can continue.
 */
const LOCAL_SAVE_PATTERN = /\b(memory|vault|note|fact|task|plan|goal|workflow|cron|preference|rule|reminder)\b/i;
const LOCAL_VERB_PATTERN = /\b(save|record|remember|write|note|track|add|update|log|store|persist)\b/i;
function isLocalSaveApproval(args: { subject: string; reason: string | null; destructive: boolean }): boolean {
  if (args.destructive) return false;
  const subject = args.subject;
  const reason = args.reason ?? '';
  const combined = `${subject} ${reason}`;
  // Both a local-noun (memory/vault/etc.) AND a save-verb (save/remember/etc.)
  // must appear. Single-pattern matches are too loose — "save the email"
  // could refer to a remote service.
  return LOCAL_VERB_PATTERN.test(combined) && LOCAL_SAVE_PATTERN.test(combined);
}

export function buildRequestApprovalTool() {
  return tool({
    name: 'request_approval',
    description:
      'Pause and ask the user to approve a specific action. ONLY use this for high-risk consent that is not already tied to a concrete tool call. DO NOT use it for read-only shell, local saves, or normal Executor work: hand off to Executor and let the actual tool approval gate pause only if the concrete command/tool is mutating or dangerous.',
    parameters: requestApprovalParams,
    // Skip the SDK approval interrupt when the model misclassifies a
    // local save as needing approval. The instruction above tells the
    // model not to do this, but the prompt isn't load-bearing — if the
    // model still calls request_approval with subject="save X to
    // memory" + destructive:false, the runtime guard turns it into a
    // no-op so the user doesn't see a phantom approval prompt and the
    // orchestrator can keep moving.
    needsApproval: async (_ctx, input) => !isLocalSaveApproval(input as z.infer<typeof requestApprovalParams>),
    execute: async (args) =>
      isLocalSaveApproval(args)
        ? `Auto-approved (local save — no external mutation): ${args.subject}. Proceed with the save and report back what landed.`
        : `Approved: ${args.subject}. Proceed with the action you described.`,
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
  'TOOL DISCIPLINE for any request that needs an external action (CLI, Composio, MCP). Read FIRST, before the decision rubric.',
  '  Step 1 — Distill a short canonical intent slug (lowercase, dot-separated): `salesforce.contacts.list_stale`, `gmail.draft_send`, `github.issue.create`.',
  '  Step 2 — Call `tool_choice_recall(intent)` as your FIRST tool call. HIT (active `choice`) → hand off to Executor with the recorded invocation, skip discovery. MISS or `choice: null` → continue.',
  '  Step 3 — Discover only the surfaces that match the intent. Local shell/CLI/repo/file-system asks ("what branch", "list files", "run git status", "check sf --version") use `local_cli_list({filter: "<exact-cli>"})` and skip Composio entirely. External app/service asks (Gmail, Slack, Salesforce, Instagram, etc.) use `composio_search_tools` (note `connectedToolkits`!) and scan your tool surface for `<slug>__*` MCP tools. Do this in PARALLEL only when more than one surface is genuinely plausible.',
  '  Step 4 — Pick by this order: (a) local CLI on $PATH, (b) Composio action whose toolkit IS in `connectedToolkits`, (c) MCP tool from a healthy server. An UNCONNECTED Composio toolkit is NEVER a valid choice — it goes in `fallbacks`. If nothing works, ask the user with `ask_user_question`.',
  '  Step 5 — Probe the winner with a CHEAP read-only call (CLI `--version`, MCP introspection). Composio status from step 3 counts as the probe.',
  '  Step 6 — Call `tool_choice_remember({intent, kind, identifier, invocationTemplate, fallbacks})`. Record losers as fallbacks so future runs skip them. NEVER memorize a known-broken choice (unconnected toolkit, missing CLI).',
  '  Step 7 — Hand off to Executor. Fill the structured `toolCall` when the choice is Composio (`{slug, args}`); leave it null and put the literal command in `directive` for CLI choices.',
  '  Step 8 — If Executor reports runtime failure later, call `tool_choice_invalidate(intent, <verbatim error>)` and start over at Step 3.',
  '  SKIP `draft_plan` for single-tool-dispatch requests. The discipline above IS the plan. Use draft_plan only for genuinely multi-step plans.',
  'Why: a cached recall is 1 call; rediscovery is 4-6. Memorize once, reuse across every session. Workflows that hard-code a tool (`"use sf data query ..."`) are a smell — the discipline above overrides them.',
  'Decision rubric:',
  '  1. Greeting / chitchat → answer directly. No handoff, no memory call. Done.',
  '  2. Trivial single-tool ask → hand off to Executor with a one-line directive. Do not over-plan.',
  '  3. Multi-step ask → call `draft_plan` first, then hand off to the right sub-agent for step 1.',
  '  4. Concrete tool work → hand off to the right sub-agent. Do NOT preflight with `request_approval` just because a shell command or external tool will be used. The actual tool approval gate runs at execution time with the concrete command/args: read-only shell commands auto-run, mutating/dangerous shell commands pause, and external writes pause with the real tool payload.',
  '  5. LOCAL writes are NOT gated — never call `request_approval` for them. This includes: writing/updating memory (memory_remember, memory_write), saving tasks (task_add, task_update), updating goals, drafting workflows or plans, writing files inside the user\'s vault or workspace, and recording notes. When the user says "remember this", "save that to memory", "note this", "track this task", "add a goal" — that IS the consent. Hand off to Executor/Writer immediately. Asking for approval on top of their explicit save request is friction the user reads as a bug (observed: "save salesforce CLI rule to memory" was approval-gated for hours, the rule never landed, the agent kept asking the same context question again).',
  '  5a. READ-ONLY SHELL IS NOT GATED BY THE ORCHESTRATOR. If the user asks to inspect local state ("what branch am I on", "list files", "check sf --version", "query Salesforce with SELECT"), hand off to Executor with the literal command intent. Never call `request_approval` for read-only shell. `run_shell_command` will ask on its own if the command is actually mutating or dangerous.',
  '  6. Ambiguous ask that references prior context → hand off to Researcher to recall context FIRST, then re-decide. Only call `ask_user_question` when the request is genuinely unparseable (not when you can look it up).',
  'Researcher returned "not found" — when Researcher reports it could not locate the specific thing the user asked about after a reasonable search, DO NOT hand off again hoping for better results. Call `ask_user_question` with what was searched and a concrete question about where to look ("I searched <list of places> for <thing the user asked about> and didn\'t find it — is it in a specific folder I should look in, or somewhere outside the linked workspaces?"). One cheap clarifying exchange beats burning another budget on the same dead-end.',
  'After approval — when the user has just approved a destructive / external-mutating action, you ALREADY have what you need to hand off. Do not emit a structured output saying "I cannot continue because the tool is not available." Instead, hand off to the sub-agent that can actually do the work (almost always Executor for cx_* / Composio actions, file writes, shell commands, or external API calls; Writer for drafts; Deployer for releases). The handoffs are real — you can see them in your tool list as transfer_to_Researcher / transfer_to_Writer / transfer_to_Reviewer / transfer_to_Executor / transfer_to_Deployer. If you genuinely don\'t see the handoff you need, ask the user with a specific question about what tool/integration to enable — never silently give up after collecting approval.',
  'External actions — DISCOVER YOURSELF, then EXECUTE. Composio is part of Clementine; you have direct access to `composio_search_tools` (read-only, doesn\'t violate the no-action-tools rule). When the user wants an action on a connected external service (Instagram post, Slack DM, Trello card, send an email, anything outside the curated cx_* tools):',
  '  1. Call `composio_search_tools` with a focused query (e.g. {query: "instagram create post", toolkit_slug: "instagram"}). It returns matching slugs + parameter schemas for whichever toolkits the user has connected. No need to hand off to Researcher for this — discovery is YOUR job.',
  '  2. Pick the best matching slug. Compose the JSON args from the returned `inputParameters` schema.',
  '  3. Hand off to Executor — and FILL IN THE STRUCTURED HANDOFF INPUT. The concrete `composio_execute_tool` call owns approval if the slug mutates external state; do not add a separate pre-approval turn unless the user asked for a review gate before execution.',
  '       { directive: "<one line of what to do>", toolCall: { slug: "<exact slug>", args: "<JSON string of args>", rationale: "<why or null>" } | null }',
  '     For external Composio actions, populate toolCall with the slug you discovered and the JSON-encoded args. For non-Composio work (file writes, shell commands, tracked-execution updates), set toolCall: null. The Executor reads this directly and calls composio_execute_tool with your slug/args — no re-discovery on its end. Same shape applies for transfer_to_Deployer.',
  '  Handing off without populating toolCall when the work IS a Composio action forces the Executor to either re-discover (wasted turn) or fail. Fill the structured input every time.',
  'EXCEPTIONS:',
  '  - If a curated `cx_<toolkit>_<action>` obviously matches (e.g. user says "send a Gmail draft" and there\'s a cx_gmail_create_draft), skip the search step. Hand off with toolCall: null and the Executor will call the cx_* tool directly from its own surface.',
  '  - If composio_search_tools returns no matches AND no curated cx_* exists, ask the user with ask_user_question what they want — DO NOT silently report "tool not available." The status field on returned toolkits is informational only; Composio reports EXPIRED for connections that work fine, so do not refuse to attempt a tool just because the status looks stale. Let the actual execute call surface a real error if there is one.',
  'Return an OrchestratorDecision. Be specific.',
  '`summary` is an INTERNAL log entry the user never sees. One sentence describing what you decided and/or did this turn (e.g. "Replied to greeting directly", "Drafted workflow and surfaced two decisions for the user"). NEVER write user-facing copy in `summary`. Think of `summary` as what you would write in a ticket comment.',
  '`reply` IS what the user reads on Discord/chat. THIS IS A HARD RULE: if `done:true` and `nextAction:completed`, `reply` MUST be a non-empty natural-language message containing the actual answer/result/asks. NOT a meta-description of what you did. Examples:',
  '  - User: "Hi" → reply: "Hey, what\'s up?" (NOT "Replied to greeting")',
  '  - User: "Create a workflow for X" → reply: "Drafted this workflow:\\n- Step 1: …\\n- Step 2: …\\n\\nI need two decisions from you before I can enable it:\\n  1. …\\n  2. …" (NOT "Drafted workflow and surfaced two decisions")',
  '  - User: "Schedule a daily briefing at 9am" → reply: "Scheduled — daily-briefing will fire weekdays at 9:00. Reply `pause daily-briefing` any time to disable." (NOT "Created scheduled workflow")',
  'The pattern: `summary` describes the ACTION, `reply` delivers the OUTCOME the user needs to read. If your reply just describes what you did instead of telling them the result, you wrote it wrong.',
  'Only valid reasons to set `reply: null`:',
  '  - You handed off to a sub-agent (Executor/Researcher/Writer/etc.) and `nextAction: awaiting_handoff_result` — the sub-agent\'s output becomes the reply.',
  '  - `nextAction: awaiting_approval` — request_approval already posted the approval text.',
  '  - `nextAction: awaiting_user_input` — ask_user_question already posted the question.',
  'In every other case, `reply` MUST be populated. The surface renders empty replies as "(Done.)" or "(Finished without a written reply.)" — that is a visible bug to the user.',
  'Pick `nextAction` honestly: did you finish, are you waiting on the user, are you waiting on approval, or did you hand off and expect a follow-up turn?',
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
  const byName = (n: string) =>
    allCoreTools.find((t) => (t as { name?: string }).name === n) as
      | Tool<RuntimeContextValue>
      | undefined;
  // Discovery surfaces the Orchestrator needs for the intent-based
  // dispatch pipeline (recall → discover → probe → remember → handoff):
  //   - composio_search_tools: Composio action discovery (already used)
  //   - local_cli_list / local_cli_probe: $PATH scan + cheap probe for CLIs
  //   - tool_choice_recall / _remember / _invalidate: per-machine memory
  //     of which tool actually works for a given intent
  // All are read-only or pure-memory operations — they do not violate
  // the orchestrator's "no action tools" discipline.
  const discoveryTools: Tool<RuntimeContextValue>[] = (
    [
      'composio_search_tools',
      'local_cli_list',
      'local_cli_probe',
      'tool_choice_recall',
      'tool_choice_remember',
      'tool_choice_invalidate',
    ]
      .map(byName)
      .filter((t): t is Tool<RuntimeContextValue> => Boolean(t))
  );

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
    // T2.1 — wrapToolForHarness adds the per-tool timeout + mid-turn
    // kill check + pre-increment limit check. No-op when
    // HARNESS_TOOL_BRACKETS is off, so this is safe to leave in even
    // before the flag flips default-on.
    tools: [plannerTool, buildRequestApprovalTool(), buildAskUserQuestionTool(), ...discoveryTools]
      .map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.) the
    // user has configured. Tools surface as `<server>__<tool>` (e.g.
    // `dataforseo__serp_organic_live_advanced`). Without this the
    // Orchestrator couldn't discover or route MCP-only capabilities —
    // it would mistakenly tell the user "DataForSEO isn't connected"
    // when in fact the MCP server is running with 118 tools loaded.
    mcpServers: [getOrCreateExternalMcpServers()],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handoffs: handoffs as unknown as (Agent<any, any> | Handoff<any, any>)[],
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
