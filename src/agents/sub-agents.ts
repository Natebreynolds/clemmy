import { Agent } from '@openai/agents';
import type { Handoff, Tool } from '@openai/agents';
import { MODELS, getRuntimeEnv } from '../config.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { RuntimeContextValue } from '../types.js';
import { wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';

/**
 * Sub-agents.
 *
 * Phase 3 (2026-05-23): the Orchestrator (now display-name "Clem") is
 * a SINGLE agent that completes the user's request without delegating.
 * The five specialized sub-agents that used to live here —
 * Researcher / Writer / Reviewer / Executor / Deployer — were removed
 * on 2026-05-24 after telemetry confirmed they had been dormant since
 * the single-agent prompt landed (last handoff event: 2026-05-21).
 *
 * What survives:
 *
 *   - Worker — a STATELESS LEAF agent the Orchestrator calls as a
 *     tool (via Agent.asTool or run_worker) to fan out independent
 *     items in parallel. Each invocation runs in its own SDK context,
 *     so 50 workers in flight ≈ 50 isolated ~10K-token contexts
 *     instead of one balloon. Used by src/execution/background-tasks.ts
 *     for parallel writes (50 Salesforce tasks, 10 DataForSEO scrapes,
 *     etc.).
 *
 *   - defaultOrchestratorHandoffs — kept as an empty array so any
 *     caller still wiring handoffs (legacy openai runtime, autonomy-v2)
 *     keeps working without conditionals.
 *
 *   - isOrchestratorSlug — autonomy-v2 still asks "is this agent slug
 *     the orchestrator?" for configuration decisions. Unchanged.
 */

type SubAgent = Agent<RuntimeContextValue>;
// Open generic on the second slot so the same handoff array works
// for both structured-output and text-output parent agents. Kept for
// type-compat with the runtime caller signatures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrchestratorHandoff = SubAgent | Handoff<RuntimeContextValue, any>;

export interface OrchestratorHandoffOptions {
  requireWorkflowApprovalForExecution?: boolean;
}

/**
 * Wrap a sub-agent's tools so every execute fires through the harness
 * boundary (per-tool timeout + mid-turn kill check + pre-increment
 * limit check). No-op when HARNESS_TOOL_BRACKETS is off.
 */
function wrapTools(tools: Tool<RuntimeContextValue>[]): Tool<RuntimeContextValue>[] {
  return tools.map((t) =>
    wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>,
  );
}

function filterToolsByNames<T extends { name?: string }>(
  tools: T[],
  allowed: Set<string>,
): T[] {
  return tools.filter((tool) => {
    const name = tool?.name;
    if (typeof name !== 'string') return false;
    return allowed.has(name);
  });
}

// Worker = a stateless leaf agent the Orchestrator (or any parent) can
// invoke as a TOOL via Agent.asTool(). When the parent calls the worker
// tool N times in one turn, the SDK runs N workers in PARALLEL, each
// with its own conversation context. That's how "scrape 100 accounts"
// gets fan-out: the parent's model fires the worker tool in parallel
// batches, and each worker handles ONE item in isolation.
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

export async function buildWorkerAgent(options: { mcpToolScope?: McpToolScope } = {}): Promise<SubAgent> {
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
      '  - If the input contains a [WORKER JOB PACKET], treat its resolvedTools/context/instructions as authoritative. Use exact slugs/commands/schemas from resolvedTools; do NOT rediscover those same capabilities.',
      '  - Use the smallest set of tool calls needed. Discovery → execute when the action is external and not already resolved by the parent packet.',
      '  - If the parent named a specific skill or the item clearly needs installed skill rules, call `skill_read` for that skill. Otherwise do not spend worker context on skill discovery.',
      '  - Return a TIGHT, structured result on the last line: a single sentence, a JSON object, or a bullet list. The parent will aggregate hundreds of these — keep yours compact.',
      '  - If a tool call fails or returns a result missing the data you need, fix and retry that call ONCE: re-run discovery to get the exact slug/id, narrow the query, or adjust arguments from the error. A failing tool result is information, not a stop sign.',
      '  - Only after one genuine retry fails should you give up. Return a single line starting with "ERROR:" and the specific reason, including which tool failed and what data was missing. Never return a normal-looking result when the item did not actually complete.',
      '  - Fill per-item artifacts (email/Outlook draft, record, message) with the REAL identity values from your data. If your item is "draft an email to account X", the draft carries X\'s actual recipient address and a real first-name greeting from the data you were given or fetched — never a blank or "Hi there". If a required identity field (recipient email, contact first name) is genuinely missing for your item and one retry to fetch it fails, do NOT produce a hollow draft — return "ERROR: missing <field> for <item>" so the parent can decide.',
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
    mcpServers: [getOrCreateExternalMcpServers(options.mcpToolScope)],
  });
}

/**
 * Empty handoff array. Kept as an export for backward compat with
 * legacy callers (src/runtime/openai.ts, src/agents/autonomy-v2.ts)
 * that still pass `handoffs: await defaultOrchestratorHandoffs(...)`
 * into Agent constructors. With single-agent mode (Phase 3), the
 * Orchestrator never hands off — Worker is invoked as a TOOL via
 * `run_worker`, not as a handoff target.
 */
export async function defaultOrchestratorHandoffs(
  _options: OrchestratorHandoffOptions = {},
): Promise<OrchestratorHandoff[]> {
  return [];
}

/**
 * Slugs that, by default, get orchestrator-style configuration. Used
 * by autonomy-v2.getAgent to decide whether to wire the orchestrator
 * surface. The primary `clementine` agent is the orchestrator out of
 * the box; other agents can opt in via the env var.
 */
export function isOrchestratorSlug(slug: string): boolean {
  if (slug === 'clementine') return true;
  const extras = getRuntimeEnv('AUTONOMY_ORCHESTRATOR_SLUGS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extras.includes(slug);
}
