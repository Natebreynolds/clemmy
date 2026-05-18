import { Agent, handoff } from '@openai/agents';
import type { Handoff, Tool } from '@openai/agents';
import { MODELS, getRuntimeEnv } from '../config.js';
import { activeExecutionCount, activeExecutionCountForSession } from '../tools/execution-tools.js';
import { getCoreTools, getCoreToolsAsync } from '../tools/registry.js';
import type { RuntimeContextValue } from '../types.js';
import { harnessInstructions } from './harness-context.js';

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
  // External — first-class cx_* tools are added via prefix at build
  // time; the broker tools below remain as discovery helpers.
  'composio_status',
  'composio_list_tools',
  'composio_search_tools',
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
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'write_file',
  'run_shell_command',
  'git_status',
  // External — first-class cx_* tools are added via prefix at build
  // time. The broker `composio_execute_tool` is deliberately omitted:
  // the executor calls the real `cx_<toolkit>_<action>` tool directly
  // (the orchestrator already dropped the broker execute in this mode).
  'composio_list_tools',
  'composio_search_tools',
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
  // External — first-class cx_* tools added by prefix at build time.
  'composio_status',
  'composio_list_tools',
  'composio_search_tools',
]);

/**
 * Prefix patterns added on top of every sub-agent's explicit allowlist.
 * `cx_` is the first-class Composio per-action surface; every sub-agent
 * that has any Composio access gets the lot. The trust gradient still
 * gates each call per its taxonomy `ToolKind` (read vs send), so adding
 * the prefix here doesn't give Researcher a write path — it just lets
 * Researcher call `cx_googlesheets_batch_get` etc.
 *
 * Note: Researcher / Reviewer are read-only sub-agents, so the cx_*
 * prefix is intentionally *not* added to them — the orchestrator hands
 * them off for lookups, not mutations. Executor / Deployer / Writer
 * get the prefix because they may need to invoke external app actions.
 */
const COMPOSIO_FIRST_CLASS_PREFIX = 'cx_';

function filterToolsByNames<T extends { name?: string }>(
  tools: T[],
  allow: Set<string>,
  prefixes: string[] = [],
): T[] {
  return tools.filter((tool) => {
    const name = tool.name;
    if (!name) return false;
    if (allow.has(name)) return true;
    return prefixes.some((p) => name.startsWith(p));
  });
}

export async function buildResearcherAgent(): Promise<SubAgent> {
  // Researcher is read-only — no cx_* prefix needed; the few read-only
  // composio_* helpers are explicit in the allowlist.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  const tools = filterToolsByNames(all, RESEARCHER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Researcher',
    handoffDescription: 'Gathers information, reads files/notes/memory, and returns concise findings. Cannot mutate state.',
    instructions: harnessInstructions([
      'You are the Researcher sub-agent inside Clementine.',
      'Your single job is to gather information and return a concise, well-organized summary.',
      'You CANNOT change anything — no task creates, no file writes, no commits, no notifications. The orchestrator will act on your findings.',
      'Memory tools are your primary surface. You have ACCESS to the user\'s full persistent memory beyond the bounded context block in your system prompt: memory_recall (embedding search across notes, conversations, and consolidated facts), memory_search (lexical search), memory_read (read a specific note by id/path), session_history (prior conversations), workspace_info, list_files / read_file (vault + project files), git_status, goal_list. CALL these tools actively. If the orchestrator handed off because the user referenced past context, you must surface that context — do not ask the user to repeat themselves when their memory store already has the answer.',
      'Search pattern: form a focused query → call memory_recall (or memory_search if you have specific keywords) → read the top hits → return.',
      'TIME-BOX RULE: you have at most ~5 tool calls to find the target. If the first round of memory + a top-level workspace listing does not surface the specific thing the user asked for, STOP exploring. Do not exhaustively drill into nested directories or repeat similar searches with slight query variations — that pattern burns the per-turn budget without producing better answers. Instead, return what you searched, what you found (candidates that are close but not exact matches), and an explicit "could not locate <target>" line so the orchestrator can ask the user to clarify the path.',
      'Failure mode to avoid: "I will keep drilling deeper until I find it." If the target is missing from the obvious locations, the file likely lives somewhere you don\'t know about (vault, Drive, a different project root, a folder name you weren\'t told). Surface that gap; the orchestrator + user can resolve it in one cheap clarifying exchange.',
      'When done, return a short structured answer the orchestrator can use directly. Lead with the answer (or "not found"), then evidence. Do not pad.',
    ].join('\n\n')),
    model: MODELS.fast,
    tools,
  });
}

export async function buildExecutorAgent(): Promise<SubAgent> {
  // Executor needs first-class cx_* so it can call `cx_googlesheets_*`
  // and friends directly instead of going through the broker.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  const tools = filterToolsByNames(all, EXECUTOR_TOOL_NAMES, [COMPOSIO_FIRST_CLASS_PREFIX]) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Executor',
    handoffDescription: 'Does the work — tasks, executions, file writes, commands, external actions. Use when a decision has been made and there is concrete work to perform.',
    instructions: harnessInstructions([
      'You are the Executor sub-agent inside Clementine.',
      'Your single job is to take the work that has been decided and DO it. No deliberation, no re-planning.',
      'Available tools: tasks (task_add, task_update), executions (execution_update_step, execution_complete, execution_mark_blocked), files (write_file, read_file), commands (run_shell_command — approval may be required), goals (goal_update), notifications (notify_user), check-ins (ask_user_question when truly blocked on user info).',
      'Make small reversible changes, verify after each one when possible, and surface real errors via notify_user.',
      'When a tracked execution is involved, call execution_update_step every cycle you make progress, and execution_complete only when success criteria are met.',
      'Return a concise summary of what was done so the orchestrator knows the state.',
    ].join('\n\n')),
    model: MODELS.primary,
    tools,
  });
}

export async function buildWriterAgent(): Promise<SubAgent> {
  // Writer may need to call write/create cx_* tools (e.g. draft a doc
  // into Google Docs). The taxonomy still gates writes by scope.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  const tools = filterToolsByNames(all, WRITER_TOOL_NAMES, [COMPOSIO_FIRST_CLASS_PREFIX]) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Writer',
    handoffDescription: 'Drafts polished user-facing writing, docs, notes, email/message copy, and project summaries. Does not send messages or deploy.',
    instructions: harnessInstructions([
      'You are the Writer sub-agent inside Clementine.',
      'Your job is to turn gathered context into clear, useful written artifacts: drafts, docs, summaries, emails, reports, and handoff notes.',
      'Do not send external messages or deploy changes. If the user wants something sent, return the draft and let the orchestrator or an approved executor handle delivery.',
      'When writing files, keep changes scoped to the requested draft/document and avoid broad rewrites.',
      'Return the final draft location or text plus any assumptions that matter.',
    ].join('\n\n')),
    model: MODELS.primary,
    tools,
  });
}

export async function buildReviewerAgent(): Promise<SubAgent> {
  // Reviewer is read-only — only the explicit composio_* discovery
  // helpers in the allowlist.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: true });
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
      'Return findings first (ordered by severity), then the verdict (proceed / verified / blocked-on-issue). Keep it tight — bullet-list, not prose.',
    ].join('\n\n')),
    model: MODELS.fast,
    tools,
  });
}

export async function buildDeployerAgent(): Promise<SubAgent> {
  // Deployer may invoke external CI/CD / deploy actions via cx_*.
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  const tools = filterToolsByNames(all, DEPLOYER_TOOL_NAMES, [COMPOSIO_FIRST_CLASS_PREFIX]) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Deployer',
    handoffDescription: 'Handles release, deployment, CI, environment, and CLI-driven shipping work. Use only for tracked approved execution work.',
    instructions: harnessInstructions([
      'You are the Deployer sub-agent inside Clementine.',
      'Your job is to ship already-approved work: inspect status, run the needed release/deploy commands, verify, and report the result.',
      'Do not invent deployment targets. If the environment, branch, token, or approval is unclear, call ask_user_question or execution_mark_blocked.',
      'Use small, auditable commands. Capture verification evidence. Update the tracked execution every cycle you make progress.',
      'Return exactly what was deployed, where, verification results, and any follow-up needed.',
    ].join('\n\n')),
    model: MODELS.deep,
    tools,
  });
}

function executionGateEnabled(sessionId: string | undefined): boolean {
  return (sessionId ? activeExecutionCountForSession(sessionId) > 0 : false) || activeExecutionCount() > 0;
}

function maybeGateExecutionHandoff(agent: SubAgent, options: OrchestratorHandoffOptions = {}): OrchestratorHandoff {
  if (options.requireWorkflowApprovalForExecution === false) {
    return agent;
  }

  return handoff(agent, {
    toolDescriptionOverride: [
      `Handoff to the ${agent.name} agent to handle approved tracked execution work.`,
      agent.handoffDescription,
      'This handoff is only enabled when the current session has an active tracked execution, which acts as the workflow approval gate.',
    ].filter(Boolean).join(' '),
    isEnabled: ({ runContext }) => executionGateEnabled(runContext.context?.sessionId),
  }) as OrchestratorHandoff;
}

/**
 * Default sub-agents the orchestrator can hand off to. Add specialized
 * roles here as the system grows (writer, reviewer, deployer, etc.).
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
