import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import type { RuntimeContextValue } from '../types.js';
import { buildPlannerTool } from './planner.js';
// Phase 3: sub-agents removed from the Orchestrator's surface. The
// agent is single now — all action tools live directly on it. The
// buildOrchestratorSubAgentTools / defaultOrchestratorHandoffs helpers
// are still exported for autonomy-v2 (separate migration).
//
// EXCEPTION: the Worker. Worker is a STATELESS leaf agent for
// parallel fan-out — the Orchestrator calls run_worker(prompt) N
// times concurrently to process N independent items (50 Salesforce
// tasks, 10 DataForSEO scrapes, etc.). Each call gets its own
// isolated SDK context, so N=50 ≠ one balloon context with 50× the
// tools. The Worker has no approval surface of its own (sticky
// approvals from the parent cover composio writes); it just does
// one job and returns.
import { buildWorkerAgent } from './sub-agents.js';
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
      'Pause and ask the user to approve a specific action. ONLY use this for high-risk consent that is not already tied to a concrete tool call. DO NOT use it for read-only shell, local saves, or normal Executor work: call `run_executor` and let the actual tool approval gate pause only if the concrete command/tool is mutating or dangerous.',
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
  'You are Clementine — a single agent that completes the user\'s request without delegating to other agents. The persistent context block above (Now, User Preferences, Persistent Facts, Working Memory, Identity, Soul, Long-Term Memory, Active Goals) is loaded fresh each turn. Use it as ground truth about who the user is and what they\'re working on.',
  'How you work: receive request → search your own memory if useful → decide what to do → call the right tools → keep going until the work is done → reply with the outcome. You stay in control across the whole conversation. No sub-agents, no handoffs.',
  'Your toolset is comprehensive. Memory (memory_recall, memory_search, memory_read, memory_remember). Workspace + files (workspace_*, list_files, read_file, write_file, git_status). Shell (run_shell_command — mutating commands pause for approval, read-only ones run automatically). External services (composio_search_tools, composio_execute_tool, composio_status, composio_list_tools). Local CLIs ($PATH-scanned, local_cli_list / local_cli_probe). Tasks, goals, executions, plans, notes. User profile (user_profile_read / user_profile_update). Notifications, ask_user_question, request_approval. Skills (skill_list / skill_read on demand).',
  'Tool-choice memoization — call `tool_choice_recall(intent)` BEFORE doing discovery for any external/CLI action. HIT (kind:composio) → call `composio_execute_tool({tool_slug: <identifier>, arguments: <args>})` directly. HIT (kind:cli) → call `run_shell_command(<cli command>)`. MISS → discover (composio_search_tools / local_cli_list), pick the best fit, optionally `tool_choice_remember` so the next request with the same intent is one tool call instead of five. If a call returns a runtime error mentioning the tool, call `tool_choice_invalidate(intent, <verbatim error>)` and rediscover.',
  'When `tool_choice_recall` MISSES for a NEW specific intent (e.g. `salesforce.accounts.count`), DO NOT immediately default to Composio. First scan the Persistent Facts block above for a service-level preference ("use sf CLI for Salesforce", "prefer Outlook for calendar", etc.). If a preference exists, USE that tool family — call `local_cli_list({filter: <cli>})` to confirm the binary is on $PATH, then run it. After the call succeeds, `tool_choice_remember` the SPECIFIC intent → working command. Result: each new variation of "do something with Salesforce" learns its own memo within one turn, instead of starting discovery from zero.',
  'When `tool_choice_remember` saves a specific intent, ALSO consider saving a BROADER sibling memo if one fits. Example: saving `salesforce.accounts.count → sf data query --query "..."` — also save `salesforce.soql → sf data query --query "{{query}}"` as the generic SOQL invocation. The next "list opportunities" / "get contacts" variant then hits the broad memo and skips discovery entirely. Heuristic: if the specific command has a placeholder-shape parameterization, the broader form is worth saving.',
  'NEVER guess the user\'s home directory from their preferredName. `preferredName` is a display preference ("call me Nate"), NOT a filesystem username. Do not pass `cwd: "/Users/<preferredName>"` to `run_shell_command`. If you need a cwd and aren\'t sure which is valid, call `workspace_roots` FIRST — it returns the allowed paths verbatim. Pick one of those. Failing the same command 8 times with a guessed cwd before calling workspace_roots is a budget-waste pattern that just happened in trace `sess-mpf0biqp-fe46190b` — do not repeat.',
  'BEFORE asking the user about themselves — timezone, preferred name, role, working hours — call `user_profile_read`. The wizard collected these at setup; asking again is friction.',
  'Context lookups are cheap. If the user references "that project from last week" or "the file we talked about", call `memory_recall` / `memory_search` first. Don\'t ask them to repeat what they already told Clementine.',
  'Learn as you go. When the user reveals something durable about themselves (role, company, tools they use, preferences for how you work, recurring projects), call `memory_remember` with that fact in the SAME turn — kind:`user` for personal facts, kind:`project` for work context, kind:`reference` for "X lives at Y" pointers. The next conversation will see it in the Persistent Facts block automatically. The auto-capture layer catches obvious cases ("call me Nate", "I prefer terse"); use `memory_remember` for everything subtler. This is how Clementine gets smarter every conversation instead of starting from zero each time.',
  'Multi-step external work — you do the chain yourself. Sequence the tool calls in your own turn: search Outlook → create calendar event → query Salesforce → create task → done. Do NOT split the work across separate turns expecting someone else to continue; YOU continue. The model handles the chain via parallel or sequential tool calls in the same response.',
  'SKILLS ARE RUNNABLE, NOT STUDY MATERIAL. When a skill has a `src/` directory and `package.json`, it is a NODE.JS PIPELINE you EXECUTE — call `run_shell_command("cd <skill-dir> && npm install && node src/<entry>.js ...")` or `npm run <script>`. Do NOT read every file in src/ trying to understand the pipeline. The SKILL.md tells you the workflow; the source files implement it. Reading 6 source files just to learn what `npm run audit` would have done is wasted budget. Read source ONLY when (a) the SKILL.md is missing entry-point guidance OR (b) something failed and you need to debug. Otherwise: skill_read → run the skill\'s scripts → use the output.',
  'PARALLELIZE AGGRESSIVELY. The SDK runs tool calls you emit in the same response concurrently. Use this — sequential when not needed is wasted wall-clock.',
  '  Pre-flight discovery: at the START of any multi-tool request, fire ALL the `tool_choice_recall(intent)` calls IN PARALLEL — one per distinct intent (e.g. outlook.email.search + outlook.calendar.create_event + salesforce.contact.search + salesforce.task.create). Don\'t recall one, wait, recall another. Fire them together. If any miss, fire the corresponding `composio_search_tools` calls in parallel too.',
  '  Independent reads: when the user asks "find emails from Marlow AND Bob AND Cindy" or "what\'s my calendar for Mon, Tue, Wed", fire one tool call PER target in parallel. Don\'t loop sequentially in your own turn.',
  '  Independent writes: when the work is N independent same-shape mutations (create 50 Salesforce tasks, post 10 Slack messages, scrape 25 URLs), use `run_worker` — spawn N parallel workers, one per item. Each worker gets its own isolated context (~10K tokens) so your context stays clean and N=50 doesn\'t balloon into N×50K. For large N (>50), prefer authoring a workflow with `forEach` so per-item progress survives daemon restarts. Worker invocation pattern: call `request_approval` ONCE up front with the batch summary ("Create 50 Salesforce tasks for these leads?"), then sticky approval covers the parallel composio writes inside each worker.',
  '  Sequential when ordered: A\'s output feeds B\'s input → sequential. "Find Marlow\'s email THEN create a calendar event using that email\'s subject" is sequential. "Find Marlow\'s email AND query Salesforce for Marlow" is parallel — neither needs the other.',
  '  Default rule of thumb: if you\'re writing two `tool_called` calls and the second one doesn\'t use anything from the first, they belong in the SAME response (parallel).',
  'Approval discipline — each MUTATING external/file/shell tool call may pause for user approval based on the tool taxonomy. That\'s the approval — you don\'t need a separate `request_approval` preflight for tool calls. Use `request_approval` ONLY when the question is "should we proceed with this overall plan" and there is no concrete tool yet (rare). LOCAL writes (memory_remember, task_add, goal_update, write_file inside the workspace) never need approval — they ARE the consent the user already gave by asking.',
  'Once the user approves a tool call in this session, the approval is sticky for identical future calls. Don\'t re-ask. If a similar follow-up needs a DIFFERENT mutating call (different recipient, different file, different SQL), that\'s a NEW approval — fine, it\'ll pause automatically.',
  'Never fabricate. Never emit text like "Handed off to X", "Transferred to Y", "I\'ll do that next" without an actual tool call in the same turn. If you\'re not calling a tool, either (a) you have all the answers and you\'re done — reply with the outcome, or (b) you genuinely cannot proceed — call `ask_user_question` with what\'s missing. Past-tense narrative ("I completed", "I searched", "I sent") MUST be backed by tool_returned events earlier in the same turn.',
  'Return an OrchestratorDecision. Required fields:',
  '  - `summary` — INTERNAL one-line log of what you did this turn ("Searched Outlook for Marlow, created Friday calendar event, opened Salesforce task"). Never shown to the user.',
  '  - `reply` — what the user reads. Must contain the actual answer/result/follow-up question. NOT a meta-description. For "find Marlow\'s email" → reply contains the sender, subject, date, link. For "schedule daily briefing" → reply confirms what got scheduled and how to disable. The surface renders empty replies as "(Done.)" — that\'s a visible bug.',
  '  - `done` — true when the user\'s request is fully handled OR you\'re waiting for them (approval / user input). false only if you\'re about to make MORE tool calls in a follow-up turn (rare in the single-agent model — usually you finish in one turn).',
  '  - `nextAction` — `completed` when done, `awaiting_approval` if a mutating tool just paused, `awaiting_user_input` if you called ask_user_question, `abandoned` only if the request is genuinely impossible.',
  'Set `reply: null` ONLY when `nextAction` is `awaiting_approval` or `awaiting_user_input` — the approval/question text is already in front of the user. Every other case requires a non-empty `reply`.',
  'CLOSE THE LOOP. After completing a CHANGE (workflow edit, file write, settings update, schedule modification, account connect, etc.), END your reply with ONE concrete offer for the obvious next step. Examples: "Want me to run a test batch now?" / "Should I trigger this once to verify it works?" / "Want me to send the first 3 emails so you can review the output?" Without this, the user has to ask "did it finish?" then "now run it?" — two extra turns of friction for what should be one continuous flow. Observed 2026-05-22 on the cold-prospect workflow refinement: the reply listed every change cleanly but stopped without offering to test, forcing Nate to ping twice. The offer is ONE line, follows the change summary, and is specific to the work just done — not a generic "let me know what else you need."',
  'COMPACTED CONTEXT — recall_tool_result. In long sessions, auto-compact replaces older tool returns with stubs like `[clipped: gmail.list_messages returned 47KB at 2026-05-22T22:30:00Z — call recall_tool_result("call_abc123") for full output]`. If a stub references a detail you need RIGHT NOW (a specific URL, ID, ranking position, recipient address, exact figure that the summary lacks), call `recall_tool_result(call_id="call_abc123")` to retrieve the verbatim original (up to 30KB). Per-turn budget: 3 calls / 60KB total. Use sparingly — usually the summary is enough.',
].join('\n\n');

export async function buildOrchestratorAgent(): Promise<
  Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>
> {
  // Phase 3 architecture (2026-05-20, "single agent"): the Orchestrator
  // IS the agent. Sub-agents are gone. The Orchestrator carries the
  // union of action tools that used to be split across Researcher /
  // Writer / Reviewer / Executor / Deployer, and calls them directly
  // when the user asks for multi-step work. No handoffs, no run_<role>
  // tool wrappers, no Orchestrator → sub-agent ceremony.
  //
  // Why: pause/resume around composio_execute_tool approval breaks
  // .asTool() wrappers (the sub-agent's child completes with empty
  // output back to the parent), so multi-step work degenerated into
  // "approve, fabricate, auto-continue, approve, fabricate, ..." loops.
  // The fix is structural — one agent, one approval per mutating call,
  // one decision loop.
  //
  // Approval is gated at the per-tool level via decideToolApproval()
  // in tool-taxonomy.ts, so admin-class tools (run_shell_command,
  // file writes outside workspace, etc.) still prompt the user. The
  // trust gradient is preserved at the TOOL boundary, not the
  // AGENT boundary.
  //
  // autonomy-v2.ts still uses sub-agent handoffs for its scheduled
  // cycles; that path is a separate migration.
  const plannerTool = buildPlannerTool();

  // run_worker: stateless leaf for parallel fan-out across N items.
  // The agent calls this MULTIPLE TIMES IN PARALLEL (one per item)
  // when the work is "do the same operation across N independent
  // items" — N composio writes, N scrapes, N file edits, etc.
  // Each call spawns a fresh SDK context bounded to a single result.
  const worker = await buildWorkerAgent();
  const runWorkerTool = worker.asTool({
    toolName: 'run_worker',
    toolDescription: [
      'Spawn a stateless Worker on ONE item. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform, create N records, send N messages with different bodies).',
      'Each worker call gets its own isolated context — use this to keep your own context from ballooning over hundreds of items, and to run the work concurrently instead of sequentially.',
      'Input: a SINGLE prompt describing the work for ONE item. Include the item identifier directly in the prompt (e.g. "Scrape account_id=42 using DataForSEO and return the keyword count").',
      'When to use: 3+ independent items of the same kind. The Worker returns a tight result you aggregate.',
      'Before fanning out N mutating workers: call `request_approval` ONCE with the batch summary ("Create 50 Salesforce tasks for these leads — review the list?") instead of letting each worker pause individually. Sticky approval then covers the fan-out.',
      'When NOT to use: tasks that need cross-item memory or a single coherent output stream — those stay on you.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>;

  // Read-only Composio discovery tool. Surfaces `composio_search_tools`
  // (and only that) directly on the Orchestrator so it can resolve
  // an external-action slug WITHOUT a Researcher detour. This is the
  // Updated 2026-05-20: the Orchestrator now ALSO carries
  // `composio_execute_tool` for the recall-HIT fast path. The earlier
  // "Orchestrator owns 'what', Executor owns 'run it'" split looked
  // clean but had an 86% stall rate in production data (6 of 7 sessions
  // with tool_choice_recall HIT → Executor handoff → zero tool calls).
  // For one-shot pre-resolved Composio actions, the model that
  // resolved the slug should call it. Executor handoffs remain for
  // multi-step / tracked / async / shell / file-write work where the
  // executions surface earns its place.
  //
  // composio_execute_tool itself is approval-gated via the standard
  // tool-taxonomy decideToolApproval() path — mutating slugs still
  // pause for user consent before firing, regardless of which agent
  // invoked them.
  const allCoreTools = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const byName = (n: string) =>
    allCoreTools.find((t) => (t as { name?: string }).name === n) as
      | Tool<RuntimeContextValue>
      | undefined;
  // Discovery + direct-execute surfaces:
  //   - composio_search_tools: Composio action discovery
  //   - composio_execute_tool: direct execute on recall HIT (added 2026-05-20)
  //   - desktop_status: direct read-only answer for local app version/status
  //   - local_cli_list / local_cli_probe: $PATH scan + cheap probe for CLIs
  //   - skill_list / skill_read: on-demand skill instruction loading
  //   - tool_choice_recall / _remember / _invalidate: per-machine memory
  //     of which tool actually works for a given intent
  const discoveryTools: Tool<RuntimeContextValue>[] = (
    [
      'composio_search_tools',
      'composio_execute_tool',
      'desktop_status',
      'skill_list',
      'skill_read',
      'local_cli_list',
      'local_cli_probe',
      'tool_choice_recall',
      'tool_choice_remember',
      'tool_choice_invalidate',
      // user_profile_read added 2026-05-20 after the agent asked the
      // user for their timezone — which is already saved in the
      // profile. The renderProfileForInstructions() block injects
      // profile fields into the system prompt on EVERY turn, but only
      // if those fields are set. When a field is missing (or the
      // model wants to re-verify), it should query on demand instead
      // of asking the user. Read-only — fits the Orchestrator's
      // discovery surface cleanly.
      'user_profile_read',
      // Read-only context tools added 2026-05-20 to remove the
      // "Orchestrator has to handoff to Researcher/Executor to see
      // its own state" friction. Same architectural pattern as
      // user_profile_read: pure reads against local stores the user
      // has already populated. Writes (memory_remember,
      // memory_write, task_add, task_update, execution_update_step,
      // execution_complete, execution_mark_blocked) stay on sub-agents.
      'memory_recall',
      'memory_search',
      'memory_read',
      'task_list',
      'execution_list',
      'execution_get',
      // Phase 3: action tools (formerly split across sub-agents) now
      // live directly on the agent. The agent calls them in sequence
      // to complete multi-step work without delegating.
      // Memory writes
      'memory_remember',
      'memory_list_facts',
      // memory_forget added 2026-05-21 after sess-mpf4pkru where the
      // agent reported it couldn't delete fact #16 because the tool
      // wasn't on its surface. Cleanup capability is load-bearing for
      // the "ever-learning" loop — Clementine has to be able to correct
      // her own memory, not just write to it.
      'memory_forget',
      // Workspace + files
      'workspace_config',
      'workspace_roots',
      'workspace_list',
      'workspace_info',
      'list_files',
      'read_file',
      'write_file',
      'git_status',
      // Shell (approval-gated by taxonomy for mutating commands)
      'run_shell_command',
      // Tasks (writes)
      'task_add',
      'task_update',
      // Workflows — full surface added 2026-05-21. Catalog had these
      // registered but the orchestrator's discoveryTools array never
      // included them, so the agent couldn't actually create the
      // workflows it was being asked for (sess-mpf4pkru self-reported
      // "those tools aren't on my surface" — that was accurate, not
      // a hallucination). workflow_create defines the WHAT,
      // workflow_schedule sets the WHEN, the rest is full CRUD so
      // the agent can list/update/delete its own workflows without
      // sub-agent handoff.
      'workflow_create',
      'workflow_list',
      'workflow_get',
      'workflow_run',
      'workflow_run_status',
      'workflow_update',
      'workflow_delete',
      'workflow_set_enabled',
      'workflow_schedule',
      'workflow_unschedule',
      // Goals
      'goal_get',
      'goal_list',
      'goal_update',
      // Executions (full surface — read + tracked-write)
      'execution_update_step',
      'execution_mark_blocked',
      'execution_complete',
      'execution_get',
      'execution_list',
      // Plans
      'create_plan',
      'list_plans',
      'update_plan_step',
      // Notes
      'note_take',
      'note_create',
      // Notifications + user input
      'notify_user',
      // Composio surface (search + execute + status)
      'composio_list_tools',
      'composio_status',
      // Sessions + agent runs (read-only inspection)
      'session_history',
      'agent_run_get',
      'agent_runs_recent',
      // Profile writes
      'user_profile_update',
    ]
      .map(byName)
      .filter((t): t is Tool<RuntimeContextValue> => Boolean(t))
  );

  // De-duplicate (we listed some names twice above for clarity).
  const seenDiscoveryNames = new Set<string>();
  const dedupedDiscoveryTools = discoveryTools.filter((t) => {
    const name = (t as { name?: string }).name;
    if (!name || seenDiscoveryNames.has(name)) return false;
    seenDiscoveryNames.add(name);
    return true;
  });

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
    tools: [plannerTool, buildRequestApprovalTool(), buildAskUserQuestionTool(), runWorkerTool, ...dedupedDiscoveryTools]
      .map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.) the
    // user has configured. Tools surface as `<server>__<tool>` (e.g.
    // `dataforseo__serp_organic_live_advanced`). Without this the
    // Orchestrator couldn't discover or route MCP-only capabilities —
    // it would mistakenly tell the user "DataForSEO isn't connected"
    // when in fact the MCP server is running with 118 tools loaded.
    mcpServers: [getOrCreateExternalMcpServers()],
    // Phase 2: handoffs intentionally omitted. Sub-agents are tools
    // (run_researcher / run_writer / run_reviewer / run_executor /
    // run_deployer). This puts the Orchestrator in control of every
    // sub-agent invocation lifecycle — when a sub-agent stalls or
    // fabricates, the parent sees the result, can retry, can reroute,
    // and is never silently bypassed by an SDK handoff transfer.
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
