import { Agent } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { MODELS } from '../config.js';
import { getCoreTools } from '../tools/registry.js';
import type { RuntimeContextValue } from '../types.js';

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
 * Day-one sub-agents:
 *   researcher  — gathers information (memory, vault, files,
 *                 workspace inspection). Cannot write or mutate state.
 *   executor    — does work (tasks, goals, executions, file writes,
 *                 shell commands). Approval flow gates risky calls.
 *
 * Add new sub-agent roles by:
 *   1. Defining the tool-name allowlist below
 *   2. Adding a builder function
 *   3. Listing it in `defaultOrchestratorHandoffs()`
 */

type SubAgent = Agent<RuntimeContextValue>;

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
  // External (Composio read-only patterns — the agent decides)
  'composio_status',
  'composio_list_tools',
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
  // External
  'composio_execute_tool',
  'composio_list_tools',
]);

function filterToolsByNames<T extends { name?: string }>(tools: T[], allow: Set<string>): T[] {
  return tools.filter((tool) => Boolean(tool.name) && allow.has(tool.name as string));
}

export function buildResearcherAgent(): SubAgent {
  const tools = filterToolsByNames(getCoreTools(), RESEARCHER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Researcher',
    handoffDescription: 'Gathers information, reads files/notes/memory, and returns concise findings. Cannot mutate state.',
    instructions: [
      'You are the Researcher sub-agent inside Clementine.',
      'Your single job is to gather information and return a concise, well-organized summary.',
      'You CANNOT change anything — no task creates, no file writes, no commits, no notifications. The orchestrator will act on your findings.',
      'Use the read tools available: memory_recall, memory_read, list_files, read_file, git_status, workspace_info, session_history, goal_list, plan listings.',
      'When done, return a short structured answer the orchestrator can use directly. Lead with the answer, then evidence. Do not pad.',
    ].join('\n\n'),
    model: MODELS.fast,
    tools,
  });
}

export function buildExecutorAgent(): SubAgent {
  const tools = filterToolsByNames(getCoreTools(), EXECUTOR_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue>({
    name: 'Executor',
    handoffDescription: 'Does the work — tasks, executions, file writes, commands, external actions. Use when a decision has been made and there is concrete work to perform.',
    instructions: [
      'You are the Executor sub-agent inside Clementine.',
      'Your single job is to take the work that has been decided and DO it. No deliberation, no re-planning.',
      'Available tools: tasks (task_add, task_update), executions (execution_update_step, execution_complete, execution_mark_blocked), files (write_file, read_file), commands (run_shell_command — approval may be required), goals (goal_update), notifications (notify_user), check-ins (ask_user_question when truly blocked on user info).',
      'Make small reversible changes, verify after each one when possible, and surface real errors via notify_user.',
      'When a tracked execution is involved, call execution_update_step every cycle you make progress, and execution_complete only when success criteria are met.',
      'Return a concise summary of what was done so the orchestrator knows the state.',
    ].join('\n\n'),
    model: MODELS.primary,
    tools,
  });
}

/**
 * Default sub-agents the orchestrator can hand off to. Add specialized
 * roles here as the system grows (writer, reviewer, deployer, etc.).
 */
export function defaultOrchestratorHandoffs(): SubAgent[] {
  return [buildResearcherAgent(), buildExecutorAgent()];
}

/**
 * Slugs that, by default, get orchestrator-style configuration
 * (handoffs configured). Used by autonomy-v2.getAgent to decide
 * whether to wire sub-agents. The primary `clementine` agent is
 * the orchestrator out of the box; other agents can opt in via env.
 */
export function isOrchestratorSlug(slug: string): boolean {
  if (slug === 'clementine') return true;
  const extras = (process.env.AUTONOMY_ORCHESTRATOR_SLUGS ?? '')
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
  executor: EXECUTOR_TOOL_NAMES,
} as const;
