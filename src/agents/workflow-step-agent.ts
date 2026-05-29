import { Agent } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { MODELS } from '../config.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { RuntimeContextValue } from '../types.js';
import { wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { harnessInstructions } from './harness-context.js';
import { harnessInputGuardrails, harnessOutputGuardrails } from '../runtime/harness/guardrails.js';
import { OrchestratorDecisionSchema } from './orchestrator.js';

/**
 * Workflow-step agent — a CONSTRAINED unit of work, not a full
 * conversational orchestrator. This is the structural fix for the
 * 2026-05-28 run-explosion: running each step as the full orchestrator
 * (a) captured chat prose as the step output (starving downstream steps)
 * and (b) handed the step `workflow_run`, so a starved step re-queued its
 * own workflow recursively.
 *
 * A step here:
 *   - has a TASK-SCOPED tool surface (reads + the action tools a step
 *     legitimately needs + composio/shell) and CANNOT trigger workflows,
 *     schedule, fan out workers, or ask the user questions — the
 *     recursion/meta vectors are removed by construction;
 *   - emits its result via `workflow_step_result(data)` as structured
 *     data (the explicit output channel), which the runner captures as
 *     stepOutputs[stepId].
 *
 * It keeps the OrchestratorDecisionSchema outputType + harness guardrails
 * so the existing runConversation / resume / approval-pause machinery in
 * runStepViaHarness works unchanged.
 */

// Task-scoped whitelist. Deliberately EXCLUDES: workflow_run /
// workflow_create / workflow_schedule / workflow_unschedule (recursion +
// meta), run_worker (unbounded fan-out), notify_user / ask_user_question
// / request_approval / surface_plan (a step doesn't drive the
// conversation — mutating tools still pause via the taxonomy SDK-interrupt
// path, which runStepViaHarness handles). filterToolsByNames intersects
// with the real tool pool, so listing a name that doesn't exist is a
// harmless no-op.
export const WORKFLOW_STEP_TOOL_NAMES = new Set<string>([
  // the explicit structured-output channel (the whole point)
  'workflow_step_result',
  // reads / memory / context
  'memory_recall',
  'memory_search',
  'memory_read',
  'memory_list_facts',
  'memory_remember',
  'recall_tool_result',
  'user_profile_read',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'git_status',
  'local_cli_list',
  'local_cli_probe',
  'skill_list',
  'skill_read',
  // action tools a step legitimately needs
  'write_file',
  'run_shell_command',
  'execution_update_step',
  'task_add',
  // external service execution (discovery → execute)
  'composio_list_tools',
  'composio_search_tools',
  'composio_execute_tool',
]);

function filterToolsByNames<T extends { name?: string }>(tools: T[], allowed: Set<string>): T[] {
  return tools.filter((tool) => typeof tool?.name === 'string' && allowed.has(tool.name));
}

const STEP_INSTRUCTIONS = [
  'You are executing ONE step of a workflow — a deterministic pipeline, not a chat.',
  'Do exactly the work the step prompt describes, using the smallest set of tool calls. Do not branch into other tasks, do not re-plan, do not ask the user questions.',
  'If a "=== STEP CONTEXT ===" block appears below, it is your bound inputs as authoritative structured DATA — trust it over the prose, and use those values directly. If a value you need is empty or absent there, call `workflow_step_result({"blocked":true,"reason":"<what is missing>"})` rather than guessing or inventing one.',
  'When you have the result, you MUST call `workflow_step_result(data)` EXACTLY ONCE as your final action, passing the COMPLETE structured payload the next step needs (e.g. the full array of records as JSON) — not a summary. The next step reads exactly what you pass here; a prose summary will starve it.',
  'If you genuinely cannot produce the result (missing required input, a tool failed), call `workflow_step_result(data)` with `{ "blocked": true, "reason": "<concrete blocker>" }` and stop. Do NOT try to re-run the workflow or work around it — blocking cleanly is correct.',
  'You cannot start or schedule workflows, spawn workers, or message the user. Just produce this step\'s structured result.',
].join('\n\n');

export interface BuildWorkflowStepAgentOptions {
  userInput?: string | null;
  sessionId?: string | null;
  mcpToolScope?: McpToolScope;
}

export async function buildWorkflowStepAgent(
  options: BuildWorkflowStepAgentOptions = {},
): Promise<Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsByNames(all, WORKFLOW_STEP_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>({
    name: 'WorkflowStep',
    instructions: harnessInstructions(STEP_INSTRUCTIONS),
    model: MODELS.primary,
    outputType: normalizeZodForCodexStrict(OrchestratorDecisionSchema) as typeof OrchestratorDecisionSchema,
    tools: tools.map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    mcpServers: [getOrCreateExternalMcpServers(options.mcpToolScope)],
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
}
