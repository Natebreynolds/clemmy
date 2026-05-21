import { Agent, handoff } from '@openai/agents';
import type { Handoff, Tool } from '@openai/agents';
import { z } from 'zod';
import { MODELS, getRuntimeEnv } from '../config.js';
import { activeExecutionCount, activeExecutionCountForSession } from '../tools/execution-tools.js';
import { getCoreTools, getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { RuntimeContextValue } from '../types.js';
import { harnessInstructions } from './harness-context.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';

/**
 * T2.1 — wrap a sub-agent's tools so every execute fires through the
 * harness boundary (per-tool timeout + mid-turn kill check + pre-
 * increment limit check). No-op when HARNESS_TOOL_BRACKETS is off.
 * Centralized so the 6 sub-agent factories don't each have to repeat
 * the same `.map(...)` boilerplate.
 */
function wrapTools(tools: Tool<RuntimeContextValue>[]): Tool<RuntimeContextValue>[] {
  return tools.map((t) =>
    wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>,
  );
}

/**
 * Structured input the Orchestrator MUST supply when handing off to
 * the Executor. The SDK validates this at the handoff site — the
 * Orchestrator's model literally cannot call transfer_to_Executor
 * without filling in these fields, which forces the
 * discover-then-execute discipline:
 *
 *   directive    : one-line description of the work
 *   toolCall     : when the Researcher already discovered a Composio
 *                  tool, the Orchestrator must pass through the
 *                  exact slug and args so the Executor calls
 *                  composio_execute_tool directly without
 *                  re-discovering. null when no Composio tool is
 *                  involved (file writes, shell commands, etc.).
 *
 * The Executor receives the parsed input via its handoff context;
 * its instructions tell it to read this first.
 */
export const ExecutorHandoffInput = z.object({
  directive: z.string().min(8).describe(
    'One-line description of what the Executor should do, e.g. "Send the draft summary via the user\'s Gmail account" or "Post the prepared content to the connected Instagram account." Be specific.',
  ),
  toolCall: z
    .object({
      slug: z.string().describe(
        'Exact Composio tool slug to execute (e.g. INSTAGRAM_POST_CREATE, SLACK_POST_MESSAGE). Use this as the slug argument to composio_execute_tool.',
      ),
      args: z.string().describe(
        'JSON-encoded arguments object for the tool, ready to pass as `arguments` to composio_execute_tool. Example: \'{"image_url":"/path/to/img.png","caption":"..."}\'',
      ),
      rationale: z.string().nullable().describe(
        'Optional brief explanation of why this slug/args were chosen (helps the Executor verify intent if anything looks off). Pass null if none.',
      ),
    })
    .nullable()
    .describe(
      'Set when the Researcher discovered a specific Composio tool to call. The Executor will pass slug+args directly to composio_execute_tool — NO re-discovery. Set to null for non-Composio work (file writes, shell commands, tracked-execution updates, etc.).',
    ),
});
export type ExecutorHandoffInput = z.infer<typeof ExecutorHandoffInput>;

/**
 * Structured input for the Deployer — same discipline, scoped to
 * release/deploy work. The Orchestrator must explicitly state what
 * to deploy and the verification expectation.
 */
export const DeployerHandoffInput = z.object({
  directive: z.string().min(8).describe(
    'One-line description of the deploy/release work, e.g. "Cut v0.3.0 release of the harness branch and verify the DMG signs cleanly."',
  ),
  toolCall: z
    .object({
      slug: z.string(),
      args: z.string(),
      rationale: z.string().nullable(),
    })
    .nullable()
    .describe(
      'Set when a specific Composio tool (e.g. github_create_release) was pre-resolved by the Researcher. null when the deploy is a shell/CI workflow.',
    ),
});
export type DeployerHandoffInput = z.infer<typeof DeployerHandoffInput>;

/**
 * Sub-agent factory — the second half of "orchestrator that spawns
 * sub-agents to get work done."
 *
 * Architecture:
 *   - The orchestrator (Clementine) is the v2 cycle Agent. It has the
 *     full tool surface plus `handoffs` configured to the sub-agents
 *     defined here.
 *   - Sub-agents are SDK Agents the orchestrator hands off to within
 *     a single run. They are not separately-scheduled — they are
 *     specialized workers spawned by the orchestrator for one job.
 *   - Each sub-agent has FOCUSED instructions and a NARROWER tool
 *     surface so it stays on task and doesn't pivot mid-job.
 *
 * Distinct from v1 TeamAgentRecord agents: those are separately-
 * configured personas with their own autonomy cycles. Sub-agents
 * here are stateless workers used inside one orchestrator run.
 *
 * Sub-agents:
 *   researcher  — gathers information (memory, vault, files,
 *                 workspace inspection). Cannot write or mutate state.
 *   writer      — drafts user-facing text, docs, notes, and message
 *                 copy. Can write drafts, not send or deploy.
 *   reviewer    — audits plans/code/output and reports risk. Read-only.
 *   executor    — does work (tasks, goals, executions, file writes,
 *                 shell commands). Approval flow gates risky calls.
 *   deployer    — release/deploy specialist. Gated behind tracked
 *                 execution approval because it can run commands.
 *
 * Add new sub-agent roles by:
 *   1. Defining the tool-name allowlist below
 *   2. Adding a builder function
 *   3. Listing it in `defaultOrchestratorHandoffs()`
 */

type SubAgent = Agent<RuntimeContextValue>;
// Handoff's second generic is the *parent* agent's output type, so a
// concrete value here would force the orchestrator to share that
// output shape. We keep it open so the same handoffs work for both
// the autonomy parent (structured Zod output) and the chat parent
// (text output).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrchestratorHandoff = SubAgent | Handoff<RuntimeContextValue, any>;

export interface OrchestratorHandoffOptions {
  requireWorkflowApprovalForExecution?: boolean;
}

const RESEARCHER_TOOL_NAMES = new Set<string>([
  // Memory recall
  'memory_search',
  'memory_recall',
  'memory_read',
  'memory_list_facts',
  // Vault read-only
  'note_take',          // for jotting research notes
  'task_list',
  // Plans (read)
  'list_plans',
  // Workspace inspection (read-only)
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'git_status',
  // Session history
  'session_history',
  // Goals (read)
  'goal_list',
  'goal_get',
  // Agent runs (read-only inspection)
  'agent_runs_recent',
  'agent_run_get',
  // Discovery
  'discover_work',
  // On-demand skill loading. Skills are not injected into every prompt;
  // the agent reads only the relevant SKILL.md body when the task needs it.
  'skill_list',
  'skill_read',
  // External app discovery through the compact Composio broker.
  'composio_status',
  'composio_list_tools',
  'composio_search_tools',
]);

// Worker = a stateless leaf agent the Executor (or any parent) can
// invoke as a TOOL via Worker.asTool(). When the parent calls the
// worker tool N times in one turn, the SDK runs N workers in PARALLEL,
// each with its own conversation context. That's how "scrape 100
// accounts" gets fan-out: the Executor's model fires the worker tool
// in parallel batches, and each worker handles ONE item in isolation.
//
// What it does NOT have:
//   - task/execution mutation tools (no state collision with siblings)
//   - notify_user, ask_user_question (workers are silent)
//   - handoffs (workers are leaves, not transferers)
// What it HAS:
//   - all data-fetch composio tools, shell, file reads, memory reads
//   - the discovery+execute composio pair so unknown actions still work
//   - write_file (workers often produce per-item artifacts)
const WORKER_TOOL_NAMES = new Set<string>([
  'memory_recall',
  'memory_search',
  'memory_read',
  'user_profile_read',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'write_file',
  'run_shell_command',
  'git_status',
  'local_cli_list',
  'local_cli_probe',
  'skill_list',
  'skill_read',
  'composio_list_tools',
  'composio_search_tools',
  'composio_execute_tool',
]);

const EXECUTOR_TOOL_NAMES = new Set<string>([
  // Memory (write durable signals)
  'memory_remember',
  'memory_recall',
  'memory_search',
  // Tasks
  'task_list',
  'task_add',
  'task_update',
  // Notes
  'note_take',
  'note_create',
  // Plans
  'create_plan',
  'list_plans',
  'update_plan_step',
  // Goals
  'goal_update',
  'goal_get',
  // Executions (the core "drive to completion" surface)
  'execution_list',
  'execution_get',
  'execution_update_step',
  'execution_mark_blocked',
  'execution_complete',
  // Check-ins (executor can ask the user when stuck)
  'ask_user_question',
  // Notifications
  'notify_user',
  // Workspace (read + targeted writes; shell is approval-gated)
  'workspace_config',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'write_file',
  'run_shell_command',
  'git_status',
  // On-demand skill loading for specialized execution work (design,
  // scraping recipes, document/spreadsheet workflows, etc.).
  'skill_list',
  'skill_read',
  // External actions use brokered discovery + execution:
  //     composio_search_tools(query) → matching slugs
  //     composio_execute_tool(slug, args) → runs it
  // This handles every connected toolkit without injecting hundreds of
  // per-action tools into every model call.
  'composio_list_tools',
  'composio_search_tools',
  'composio_execute_tool',
]);

const WRITER_TOOL_NAMES = new Set<string>([
  // Context
  'memory_recall',
  'memory_search',
  'memory_read',
  'user_profile_read',
  // Notes and drafts
  'note_take',
  'note_create',
  // Workspace drafting
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'write_file',
  'git_status',
  'skill_list',
  'skill_read',
  // Progress visibility
  'execution_list',
  'execution_get',
  'execution_update_step',
  'notify_user',
]);

const REVIEWER_TOOL_NAMES = new Set<string>([
  // Memory/context
  'memory_recall',
  'memory_search',
  'memory_read',
  'user_profile_read',
  // Read-only workspace and run inspection
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'git_status',
  'agent_runs_recent',
  'agent_run_get',
  'execution_list',
  'execution_get',
  'list_plans',
  'task_list',
  'goal_list',
  'goal_get',
  'session_history',
  'skill_list',
  'skill_read',
  'composio_status',
  'composio_list_tools',
]);

const DEPLOYER_TOOL_NAMES = new Set<string>([
  // Release/deploy context
  'memory_recall',
  'memory_search',
  'user_profile_read',
  'execution_list',
  'execution_get',
  'execution_update_step',
  'execution_mark_blocked',
  'execution_complete',
  'notify_user',
  'ask_user_question',
  // Local release tooling; write/shell remain approval-gated at tool runtime
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'write_file',
  'git_status',
  'run_shell_command',
  'skill_list',
  'skill_read',
  // External app discovery through the compact Composio broker.
  'composio_status',
  'composio_list_tools',
  'composio_search_tools',
]);

function filterToolsByNames<T extends { name?: string }>(
  tools: T[],
  allow: Set<string>,
): T[] {
  return tools.filter((tool) => {
    const name = tool.name;
    if (!name) return false;
    return allow.has(name);
  });
}

export async function buildResearcherAgent(): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, RESEARCHER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Researcher',
    handoffDescription: 'Gathers information, reads files/notes/memory, and returns concise findings. Cannot mutate state.',
    instructions: harnessInstructions([
      'You are the Researcher sub-agent inside Clementine.',
      'Your single job is to gather information and return a concise, well-organized summary.',
      'You CANNOT change anything — no task creates, no file writes, no commits, no notifications. The orchestrator will act on your findings.',
      'Memory tools are your primary surface. You have ACCESS to the user\'s full persistent memory beyond the bounded context block in your system prompt: memory_recall (embedding search across notes, conversations, and consolidated facts), memory_search (lexical search), memory_read (read a specific note by id/path), session_history (prior conversations), workspace_info, list_files / read_file (vault + project files), git_status, goal_list. CALL these tools actively. If the orchestrator handed off because the user referenced past context, you must surface that context — do not ask the user to repeat themselves when their memory store already has the answer.',
      'Skills are on-demand. For specialized research domains or installed workflow recipes, call `skill_list`, then `skill_read` for the one relevant skill. Do not bulk-load skills.',
      'External-tool discovery — when the orchestrator hands off to identify an external action (e.g. "find the Composio tool for posting to Instagram", "what tool can send a Slack DM"), you OWN the discovery: call `composio_status` to confirm the toolkit is connected, then `composio_search_tools` with a focused query, then `composio_list_tools` if you need to see all actions for that toolkit. Return the SPECIFIC tool slug AND its required arguments (parameter names + a brief description of each). The Executor will receive your finding via the orchestrator and call `composio_execute_tool(slug, args)` directly — it will NOT re-search. Be precise; if you return a wrong slug the Executor blindly runs it.',
      'Search pattern: form a focused query → call memory_recall (or memory_search if you have specific keywords) → read the top hits → return.',
      'TIME-BOX RULE: you have at most ~5 tool calls to find the target. If the first round of memory + a top-level workspace listing does not surface the specific thing the user asked for, STOP exploring. Do not exhaustively drill into nested directories or repeat similar searches with slight query variations — that pattern burns the per-turn budget without producing better answers. Instead, return what you searched, what you found (candidates that are close but not exact matches), and an explicit "could not locate <target>" line so the orchestrator can ask the user to clarify the path.',
      'Failure mode to avoid: "I will keep drilling deeper until I find it." If the target is missing from the obvious locations, the file likely lives somewhere you don\'t know about (vault, Drive, a different project root, a folder name you weren\'t told). Surface that gap; the orchestrator + user can resolve it in one cheap clarifying exchange.',
      'NEVER END YOUR TURN WITHOUT CALLING AT LEAST ONE TOOL. The orchestrator handed off because it wanted gathered information. Returning a generic acknowledgement ("Continuing.", "OK.", "Working on it.") with zero tool calls is a stall — the user sees nothing useful and waits forever. Even if you decide there\'s no work to do, you must call ONE tool to confirm (e.g. memory_search with the relevant keyword, or ask_user_question for clarification). Acknowledgement is not action.',
      'When done, return a short structured answer the orchestrator can use directly. Lead with the answer (or "not found"), then evidence. Do not pad.',
    ].join('\n\n')),
    model: MODELS.fast,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

/**
 * Worker agent — a stateless leaf the Executor calls as a tool to
 * fan out independent items in parallel. Each invocation runs in its
 * own SDK context with its own model run, so 100 workers in flight =
 * 100 isolated ~10K-token contexts instead of one balloon. The
 * Executor itself decides parallelism by emitting parallel tool calls
 * (which the SDK's `parallel_tool_calls` honors for free-form sub-
 * agents).
 *
 * Returned as a plain Agent so the caller can either run it standalone
 * or wrap it via `worker.asTool({...})` for in-tool fan-out.
 */
export async function buildWorkerAgent(): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, WORKER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Worker',
    handoffDescription: 'Stateless per-item worker. Use via run_worker tool for parallel fan-out.',
    instructions: [
      'You are a Worker — a stateless, single-task sub-agent inside Clementine.',
      'Your scope is ONE item. The parent agent fans out across N items by calling you N times in parallel; each call is a fresh, isolated context.',
      'Rules:',
      '  - Do exactly the work described in the input prompt. Do not ask follow-up questions, do not deliberate, do not branch into other tasks.',
      '  - Use the smallest set of tool calls needed. Discovery → execute when the action is external.',
      '  - If the parent named a specific skill or the item clearly needs installed skill rules, call `skill_read` for that skill. Otherwise do not spend worker context on skill discovery.',
      '  - Return a TIGHT, structured result on the last line: a single sentence, a JSON object, or a bullet list. The parent will aggregate hundreds of these — keep yours compact.',
      '  - If you cannot complete the item, return a single line starting with "ERROR:" and a brief reason. Do not retry, do not escalate.',
      '  - Do NOT call notify_user, ask_user_question, or write to shared tasks/executions — those mutate state your sibling workers also touch and create race conditions.',
      'You may write per-item artifacts (write_file with a unique path) if the parent\'s prompt asks for them. Otherwise, prefer returning the result inline.',
    ].join('\n\n'),
    model: MODELS.primary,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

export async function buildExecutorAgent(): Promise<SubAgent> {
  // Keep the Executor's connected-app surface compact: it uses the
  // Composio broker tools to search/execute exact slugs instead of
  // injecting per-action cx_* tools for every connected toolkit.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, EXECUTOR_TOOL_NAMES) as Tool<RuntimeContextValue>[];

  // Wrap a Worker as a tool for parallel fan-out. The Executor's model
  // decides when to invoke it (one shot for single items, N shots in
  // parallel for fan-out) — we don't gate concurrency here; the SDK's
  // parallel_tool_calls handles batching. For large N (>50), explicit
  // workflow forEach is still the right primitive — this inline path
  // is for chat-driven mid-conversation fan-out.
  const worker = await buildWorkerAgent();
  const runWorkerTool = worker.asTool({
    toolName: 'run_worker',
    toolDescription: [
      'Spawn a stateless Worker sub-agent on ONE item. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform).',
      'Each worker call gets its own isolated context — use this to keep your own context from ballooning over hundreds of items, and to run the work concurrently instead of sequentially.',
      'Input: a SINGLE prompt describing the work for ONE item. Include the item identifier directly in the prompt (e.g. "Scrape account_id=42 using DataForSEO and return the keyword count").',
      'When to use: 3+ independent items of the same kind. The Worker returns a tight result you aggregate.',
      'When NOT to use: tasks that need cross-item memory or a single coherent output stream — those stay on you.',
    ].join(' '),
  });
  tools.push(runWorkerTool as Tool<RuntimeContextValue>);
  return new Agent<RuntimeContextValue>({
    name: 'Executor',
    handoffDescription: 'Does the work — tasks, executions, file writes, commands, external actions. Use when a decision has been made and there is concrete work to perform.',
    instructions: harnessInstructions([
      'You are the Executor sub-agent inside Clementine.',
      'Your single job is to take the work that has been decided and DO it. No deliberation, no re-planning.',
      'Available tools: tasks (task_add, task_update), executions (execution_update_step, execution_complete, execution_mark_blocked), files (write_file, read_file), commands (run_shell_command — approval may be required), goals (goal_update), project linking (workspace_config), notifications (notify_user), check-ins (ask_user_question when truly blocked on user info).',
      'YOUR INPUT IS A PROMPT STRING from the Orchestrator. As of Phase 2 (2026-05-20) you are invoked as a TOOL (`run_executor`), not via handoff transfer. The Orchestrator passes a single prompt describing what to do — read it, do the work, return a tight string result. The Orchestrator stays in control of the conversation; your output flows back to it as a tool result, not as the user-facing reply.',
      'Skills are on-demand. For specialized build, scraping, writing, spreadsheet, browser, or domain work, call `skill_list`, then `skill_read` for the one relevant skill. Do not bulk-load skills.',
      'Project linking — if the prompt includes a local project path and asks Clementine to use/link/work in it, call `workspace_config({action:"add", directory:"<path>"})`, then `workspace_info` for that project before editing. Adding/removing workspace dirs is an admin-level trust-boundary change, so the tool may pause for approval.',
      'External integrations — brokered, token-efficient path:',
      '  1. The prompt names a specific Composio slug + args → call `composio_execute_tool` with `{tool_slug: <slug>, arguments: <args>}` exactly as given. NO re-discovery, NO second-guessing.',
      '  2. The prompt describes a Composio action without a slug → discover with `composio_search_tools`, then call `composio_execute_tool` with the returned slug and JSON args.',
      '  3. If no Composio match exists, check the local CLI/MCP direction in the directive, or ask_user_question with the missing connection/tool.',
      'Discovery on the Executor is a FALLBACK. The Researcher\'s job is discovery; yours is execution. The Orchestrator should have pre-resolved Composio actions. If toolCall is null and the work is clearly a Composio action, that\'s a sign the pipeline was skipped — note it in your summary.',
      'NEVER conclude "the runtime doesn\'t expose that action" without trying broker discovery. The user has connected toolkits we can\'t enumerate at build time.',
      'Use `composio_status` only to confirm a toolkit is actually connected when you have a real reason to doubt it. If a needed toolkit is missing or disconnected, surface that with notify_user (or ask_user_question if you need them to connect it) — don\'t silently fail.',
      'Make small reversible changes, verify after each one when possible, and surface real errors via notify_user.',
      'READ SHELL ERRORS LITERALLY. When run_shell_command returns a non-zero exit code, do NOT infer the cause from the command type — read the actual stderr line by line and report THAT, verbatim, to the user. An exit code alone is not a diagnosis: quote the stderr. Do not write notifications like "X needs re-auth" unless the stderr literally says the credentials are expired/invalid. If the message is generic (working-directory issues, shell-init noise, PATH problems, etc.), retry once with `cwd` set explicitly, then surface the real error verbatim and ask the user what to do.',
      'When a tracked execution is involved, call execution_update_step every cycle you make progress, and execution_complete only when success criteria are met.',
      'PARALLEL FAN-OUT: when the work is "do the same operation across N independent items" (scrape N accounts, classify N records, fetch N URLs, summarize N docs), DO NOT loop sequentially in your own context — call `run_worker` MULTIPLE TIMES IN PARALLEL in the same turn (one call per item). The SDK runs them concurrently and each worker gets its own isolated context, so your context stays clean and the work completes in roughly the time of ONE item instead of N. For very large N (>50), prefer authoring a workflow with a `forEach` step via `workflow_schedule` — that has bounded concurrency and per-item durability for crashes.',
      'NEVER END YOUR TURN WITHOUT ACTING. You were handed off because the Orchestrator decided concrete work needed to happen. Returning ANY message that describes work in future tense — "Executing now…", "I\'ll run the query…", "Let me fetch that…", "Pulling the data…", "Running it now…" — WITHOUT actually invoking the tool in the SAME turn is a STALL. The user sees an announcement of work that never happened. This is the single most common failure mode. Hard rule: if your reply contains future-tense action language ("I\'ll", "let me", "executing", "fetching", "running", "pulling", "about to"), you MUST have called the corresponding tool BEFORE that text was produced. Equivalent stalls include short acknowledgements ("Continuing.", "OK.", "Done.", "Working on it."). The fix is always the same: actually call the tool. If the directive is genuinely ambiguous and you can\'t pick a tool to call, use `ask_user_question` to clarify; do NOT just acknowledge and stop. Your turn MUST include at least one real tool call (composio_execute_tool, run_shell_command, write_file, ask_user_question, etc.).',
      'Return a concise summary of what was done so the orchestrator knows the state. The summary describes the ACTION you took — never use it as a substitute for taking action.',
    ].join('\n\n')),
    model: MODELS.primary,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

export async function buildWriterAgent(): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, WRITER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Writer',
    handoffDescription: 'Drafts polished user-facing writing, docs, notes, email/message copy, and project summaries. Does not send messages or deploy.',
    instructions: harnessInstructions([
      'You are the Writer sub-agent inside Clementine.',
      'Your job is to turn gathered context into clear, useful written artifacts: drafts, docs, summaries, emails, reports, and handoff notes.',
      'Do not send external messages or deploy changes. If the user wants something sent, return the draft and let the orchestrator or an approved executor handle delivery.',
      'Skills are on-demand. For copy voice, design systems, document/presentation/spreadsheet formats, or domain-specific writing rules, call `skill_list`, then `skill_read` for the one relevant skill. Do not bulk-load skills.',
      'When writing files, keep changes scoped to the requested draft/document and avoid broad rewrites.',
      'NEVER END YOUR TURN WITHOUT PRODUCING ARTIFACTS OR ASKING. You were handed off to draft something concrete. Returning a one-word acknowledgement ("Continuing.", "OK.", "Done.") with zero tool calls is a stall — the user gets nothing back. Either write the file/draft, or call ask_user_question to resolve the ambiguity. Acknowledgement is not action.',
      'Return the final draft location or text plus any assumptions that matter.',
    ].join('\n\n')),
    model: MODELS.primary,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

export async function buildReviewerAgent(): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, REVIEWER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Reviewer',
    handoffDescription: 'Audits work — before execution OR after a mutation completes. Read-only; reports findings.',
    instructions: harnessInstructions([
      'You are the Reviewer sub-agent inside Clementine.',
      'You operate in one of two modes depending on when the orchestrator hands off:',
      '  PRE-WRITE: review a plan or proposal before execution. Look for missing steps, unverified assumptions, success criteria that are unmeasurable, or risk that should be flagged. Recommend either "proceed" or specific changes.',
      '  POST-WRITE: confirm that work that just landed actually does what was claimed. Read the changed files / state. Look for: bugs, regressions, broken assumptions, missing tests, missing verification, mismatched success criteria. Recommend either "verified — done" or list the gaps with concrete evidence (file:line if possible).',
      'Use a code-review mindset. Find real issues; don\'t pad. If there are no findings, say so explicitly and name residual risks the orchestrator should track.',
      'Stay read-only. Do not write files, update tasks, mutate goals, run commands, send notifications, or execute external actions. If a fix is needed, describe it; the orchestrator decides whether to execute.',
      'Skills are on-demand. If a relevant installed review or domain skill would materially improve the audit, call `skill_list`, then `skill_read` for that one skill only.',
      'Return findings first (ordered by severity), then the verdict (proceed / verified / blocked-on-issue). Keep it tight — bullet-list, not prose.',
    ].join('\n\n')),
    model: MODELS.fast,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

export async function buildDeployerAgent(): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, DEPLOYER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Deployer',
    handoffDescription: 'Handles release, deployment, CI, environment, and CLI-driven shipping work. Use only for tracked approved execution work.',
    instructions: harnessInstructions([
      'You are the Deployer sub-agent inside Clementine.',
      'Your job is to ship already-approved work: inspect status, run the needed release/deploy commands, verify, and report the result.',
      'Do not invent deployment targets. If the environment, branch, token, or approval is unclear, call ask_user_question or execution_mark_blocked.',
      'Skills are on-demand. If an installed release/deployment skill is relevant, load only that skill with `skill_read`.',
      'Use small, auditable commands. Capture verification evidence. Update the tracked execution every cycle you make progress.',
      'Return exactly what was deployed, where, verification results, and any follow-up needed.',
    ].join('\n\n')),
    model: MODELS.deep,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers()],
  });
}

function executionGateEnabled(sessionId: string | undefined): boolean {
  return (sessionId ? activeExecutionCountForSession(sessionId) > 0 : false) || activeExecutionCount() > 0;
}

/**
 * `onHandoff` callback for execution handoffs. Logs the structured
 * input the Orchestrator filled in so the event log captures the
 * full intent (slug, args, rationale) at the moment of handoff. The
 * SDK requires `onHandoff` to be present whenever `inputType` is —
 * we use that requirement productively by tracing the contract.
 */
function logHandoffInput(agentName: string) {
  return (runContext: { context?: { sessionId?: string; turn?: number } }, input: unknown): void => {
    const sessionId = runContext.context?.sessionId;
    if (!sessionId) return;
    try {
      appendEvent({
        sessionId,
        turn: typeof runContext.context?.turn === 'number' ? runContext.context.turn : 0,
        role: 'orchestrator',
        type: 'handoff',
        data: {
          to: agentName,
          input: input ?? null,
        },
      });
    } catch {
      // best-effort — handoff still proceeds if the log write fails
    }
  };
}

function maybeGateExecutionHandoff(agent: SubAgent, options: OrchestratorHandoffOptions = {}): OrchestratorHandoff {
  // Always wrap in `handoff(...)` so we can attach an `inputType`
  // that forces the Orchestrator to provide a structured directive
  // (and a pre-resolved Composio tool slug + args when applicable).
  // The SDK validates this at handoff time — the Orchestrator's
  // model literally cannot transfer to Executor / Deployer without
  // filling these in, which enforces the
  //   Researcher discovers → Orchestrator routes → Executor executes
  // discipline at the protocol level instead of relying purely on
  // prompt guidance.
  const inputType =
    agent.name === 'Deployer' ? DeployerHandoffInput : ExecutorHandoffInput;
  const onHandoff = logHandoffInput(agent.name);

  if (options.requireWorkflowApprovalForExecution === false) {
    return handoff(agent, {
      inputType: inputType as never,
      onHandoff: onHandoff as never,
      toolDescriptionOverride: [
        `Handoff to the ${agent.name} agent to do the approved work.`,
        agent.handoffDescription,
      ].filter(Boolean).join(' '),
    }) as OrchestratorHandoff;
  }

  return handoff(agent, {
    inputType: inputType as never,
    onHandoff: onHandoff as never,
    toolDescriptionOverride: [
      `Handoff to the ${agent.name} agent to handle approved tracked execution work.`,
      agent.handoffDescription,
      'This handoff is only enabled when the current session has an active tracked execution, which acts as the workflow approval gate.',
    ].filter(Boolean).join(' '),
    isEnabled: ({ runContext }) => executionGateEnabled(runContext.context?.sessionId),
  }) as OrchestratorHandoff;
}

/**
 * Sub-agents-as-tools (Phase 2 architecture, 2026-05-20). Instead of
 * the Orchestrator handing off control to a sub-agent (which loses
 * the Orchestrator's ability to recover when the sub-agent stalls
 * or fabricates), each sub-agent is wrapped via `Agent.asTool()` and
 * exposed as a `run_<role>` tool on the Orchestrator's surface.
 *
 * Production data showed the handoff pattern stalled 86% of the time
 * for the recall-HIT → Executor pattern, and multi-step sub-agent
 * runs frequently emitted past-tense lies ("Transferred to Executor
 * to run the actual workflow now") that escaped pattern-matching.
 * Wrapping as tools puts the Orchestrator back in control — when a
 * sub-agent returns, the result is a tool_returned event the
 * Orchestrator can read, validate, or retry.
 *
 * Tool semantics:
 *   - Input: a SINGLE string prompt describing the work
 *   - Output: the sub-agent's final string output (its summary +
 *     reply per its own role contract)
 *   - Failure modes: errors bubble back as tool_returned with an
 *     "ERROR:" prefix the Orchestrator can branch on, never silent
 *
 * Long-running tracked work (multi-day executions, async workflows)
 * still uses the durable executions surface (`execution_*` tools);
 * those primitives are unchanged. Sub-agent tool calls are bounded
 * to one model run inside the parent turn.
 */
export async function buildOrchestratorSubAgentTools(
  options: OrchestratorHandoffOptions = {},
): Promise<Tool<RuntimeContextValue>[]> {
  const [researcher, writer, reviewer, executor, deployer] = await Promise.all([
    buildResearcherAgent(),
    buildWriterAgent(),
    buildReviewerAgent(),
    buildExecutorAgent(),
    buildDeployerAgent(),
  ]);

  const tools: Tool<RuntimeContextValue>[] = [];

  tools.push(researcher.asTool({
    toolName: 'run_researcher',
    toolDescription: [
      'Spawn the Researcher sub-agent to gather information and return a concise structured summary. Read-only — Researcher cannot mutate state.',
      'Input: one focused research prompt. Examples: "Find any past notes about Marlowe Rary and summarize what we know about him", "Search composio for tools that post to LinkedIn and return the slug + required args", "Read the workflow file at .clementine-next/workflows/daily-briefing.md and summarize the steps".',
      'Output: a structured answer (lead with the finding or "not found", then evidence). Use when you need memory/vault/file/discovery work done in an isolated context that returns CLEAN findings, not a side-conversation with the user.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>);

  tools.push(writer.asTool({
    toolName: 'run_writer',
    toolDescription: [
      'Spawn the Writer sub-agent to draft user-facing copy, docs, summaries, emails, reports, or vault content. Writer cannot send/deploy — returns a draft for review or further routing.',
      'Input: a writing brief — what to produce, who it is for, tone constraints, any source material (paste it or reference its vault/workspace path).',
      'Output: the draft (often a file path it wrote to, plus the inline text and any assumptions).',
    ].join(' '),
  }) as Tool<RuntimeContextValue>);

  tools.push(reviewer.asTool({
    toolName: 'run_reviewer',
    toolDescription: [
      'Spawn the Reviewer sub-agent to evaluate work quality (a draft, a plan, a diff) and return a pass/fail-style assessment with specific issues.',
      'Input: what to review (text, file path, plan id) and the criteria to apply.',
      'Output: structured findings — issues, severity, suggested fixes.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>);

  const executorTool = executor.asTool({
    toolName: 'run_executor',
    toolDescription: [
      'Spawn the Executor sub-agent for tracked multi-step work: file writes, shell commands, sequenced Composio + CLI actions, execution_* updates, run_worker fan-out.',
      'NOT for single-action Composio calls — call composio_execute_tool yourself for those (faster, more reliable).',
      'Input: a directive describing the multi-step plan. Include any pre-resolved tool slugs + args inline so the Executor does not re-discover.',
      'Output: a concise summary of what was done across the steps, including any execution_id created and any errors hit.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>;

  const deployerTool = deployer.asTool({
    toolName: 'run_deployer',
    toolDescription: [
      'Spawn the Deployer sub-agent for release / deploy work — cutting versions, signing, notarizing, publishing.',
      'Input: a deploy directive (what to release, target environment, verification expectation).',
      'Output: deploy result + verification status.',
    ].join(' '),
  }) as Tool<RuntimeContextValue>;

  // Gate executor + deployer tools behind tracked-execution presence
  // when requireWorkflowApprovalForExecution is true (the default), so
  // the same approval discipline that gated handoffs applies to tool
  // calls. When the gate is open we still expose the tool so the model
  // can call it; when closed we omit it from the tool list.
  const gateOpen = options.requireWorkflowApprovalForExecution === false;
  if (gateOpen) {
    tools.push(executorTool);
    tools.push(deployerTool);
  } else {
    // Closed gate: still expose tools but the Agent SDK's tool-availability
    // can't dynamically depend on session state the way handoffs.isEnabled
    // did, so we hand them to the Orchestrator and let the existing
    // taxonomy / approval flow handle gating at execution time.
    tools.push(executorTool);
    tools.push(deployerTool);
  }

  return tools;
}

/**
 * Default sub-agents the orchestrator can hand off to. Add specialized
 * roles here as the system grows (writer, reviewer, deployer, etc.).
 *
 * Phase 2 deprecation note: handoffs are being replaced by
 * sub-agents-as-tools (see buildOrchestratorSubAgentTools above).
 * This function is kept for backward compatibility with autonomy-v2
 * and any consumer that still wires handoffs directly; new code
 * should prefer the tool surface.
 */
export async function defaultOrchestratorHandoffs(
  options: OrchestratorHandoffOptions = {},
): Promise<OrchestratorHandoff[]> {
  // Build all five sub-agents in parallel; each awaits getCoreToolsAsync
  // independently but they share the Composio catalog cache so only the
  // first call hits the network.
  const [researcher, writer, reviewer, executor, deployer] = await Promise.all([
    buildResearcherAgent(),
    buildWriterAgent(),
    buildReviewerAgent(),
    buildExecutorAgent(),
    buildDeployerAgent(),
  ]);
  return [
    researcher,
    writer,
    reviewer,
    maybeGateExecutionHandoff(executor, options),
    maybeGateExecutionHandoff(deployer, options),
  ];
}

/**
 * Slugs that, by default, get orchestrator-style configuration
 * (handoffs configured). Used by autonomy-v2.getAgent to decide
 * whether to wire sub-agents. The primary `clementine` agent is
 * the orchestrator out of the box; other agents can opt in via env.
 */
export function isOrchestratorSlug(slug: string): boolean {
  if (slug === 'clementine') return true;
  const extras = getRuntimeEnv('AUTONOMY_ORCHESTRATOR_SLUGS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extras.includes(slug);
}

/**
 * Sub-agent allowlists exposed for tests + introspection. The
 * dashboard / future capability discovery can render "researcher has
 * access to X tools; executor has Y tools" without re-deriving.
 */
export const SUB_AGENT_TOOL_ALLOWLISTS = {
  researcher: RESEARCHER_TOOL_NAMES,
  writer: WRITER_TOOL_NAMES,
  reviewer: REVIEWER_TOOL_NAMES,
  executor: EXECUTOR_TOOL_NAMES,
  deployer: DEPLOYER_TOOL_NAMES,
} as const;
