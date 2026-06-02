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

// BLOCKLIST, not a whitelist. A step gets the SAME open-ended work-tool
// surface the orchestrator has (reads, file/shell, composio_status +
// composio_execute_tool gateway, notify_user, the MCP servers, …) MINUS
// only the small, stable set of recursion / fan-out / authoring / planning
// vectors that caused the 2026-05-28 run-explosion. Curating an allow-list
// of WORK tools is the anti-pattern (it silently strips whatever a real
// workflow needs — e.g. it broke outlook-triage-hourly by removing
// composio_status + notify_user); the meta vectors to remove ARE a small
// stable set, so name those instead. (feedback_no_hardcoded_tool_lists)
//
// KEPT on purpose: notify_user (a step whose job is to report — triage,
// briefings — needs it), request_approval (legacy in-prompt gates still
// work; the declarative requires_approval gate is the forward path),
// composio_status + the composio_execute_tool gateway (named tools like
// OUTLOOK_LIST_MESSAGES are reached THROUGH the gateway / MCP, not
// preloaded), and workflow_list/get/run_status (harmless reads).
export const WORKFLOW_STEP_BLOCKED_TOOL_NAMES = new Set<string>([
  // recursion / re-entrancy: a step must never re-run a workflow
  'workflow_run',
  // workflow authoring / mutation: a step executes work, it doesn't
  // author, edit, delete, toggle, or import workflows
  'workflow_create',
  'workflow_update',
  'workflow_delete',
  'workflow_set_enabled',
  'workflow_import_framework',
  // scheduling / cron: a step doesn't schedule or trigger future work
  'add_cron_job',
  'trigger_cron_job',
  // tool authoring
  'create_tool',
  // unbounded fan-out
  'run_worker',
  // planning surface: a deterministic step does work, it doesn't plan/re-plan
  'surface_plan',
  'propose_plan',
  'create_plan',
  // conversational question: cannot be answered inside a background run
  // (would hang the run) — block cleanly via workflow_step_result instead
  'ask_user_question',
]);

/** Remove only the recursion/meta vectors; keep every work tool. */
export function filterToolsForStep<T extends { name?: string }>(tools: T[]): T[] {
  return tools.filter(
    (tool) => !(typeof tool?.name === 'string' && WORKFLOW_STEP_BLOCKED_TOOL_NAMES.has(tool.name)),
  );
}

// ── Tool-surface lock (tight authoring A4) ──────────────────────────
//
// When a step declares an EXPLICIT, non-wildcard `allowedTools` (the author or
// the auto-binder locked it to a proven family, e.g. ['run_shell_command']),
// physically PRUNE the step agent's visible tool list to that family — so a
// bound step can't see composio and re-decide its way onto a stale path
// (the live SF→Airtable drift). This is OPT-IN per step (the user's explicit
// allowedTools, not a global curated list — so it doesn't fight
// feedback_no_hardcoded_tool_lists) and always preserves the structural output
// channel so a step can never be starved of its ability to return.
//
// Note (scope): this prunes the CORE tool list (which carries the composio
// gateway — the proven drift vector). MCP servers are attached separately and
// are NOT scoped here, so an mcp-bound step keeps its MCP tools; tighter MCP
// scoping is a follow-up. A step with no/`*` allowedTools is unchanged.

/** Structural channels a step always needs, regardless of its bound work family
 *  — NEVER pruned away. Beyond the output channel (without which a step can't
 *  return at all), this keeps the REPORT channel (notify_user — a triage/brief
 *  step's job is to report) and the RECALL channel (recall_tool_result /
 *  tool_output_query — to read back a large tool output the harness clipped to
 *  the side-store). These are structural, not "work" tools, so keeping them
 *  doesn't reopen the composio drift vector the lock exists to close. */
export const STEP_STRUCTURAL_BASELINE_TOOLS = new Set<string>([
  'workflow_step_result',
  'notify_user',
  'recall_tool_result',
  'tool_output_query',
]);

/** A step's allowedTools "locks" its surface only when explicitly set and not a
 *  wildcard. Empty / undefined / contains '*' → no lock (today's full surface). */
export function stepAllowedToolsLock(allowed?: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return false;
  return !allowed.some((a) => typeof a === 'string' && (a === '*' || a === '**' || a.trim() === ''));
}

/** Build a name predicate from an explicit allowedTools list: an entry ending
 *  in '*' is a prefix family (e.g. 'composio_*'); otherwise an exact name. The
 *  structural baseline is always allowed. */
export function makeStepToolAllow(allowed: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const a of allowed) {
    const t = typeof a === 'string' ? a.trim() : '';
    if (!t || t === '*') continue;
    if (t.endsWith('*')) prefixes.push(t.slice(0, -1));
    else exact.add(t);
  }
  return (name: string) =>
    STEP_STRUCTURAL_BASELINE_TOOLS.has(name) ||
    exact.has(name) ||
    prefixes.some((p) => p.length > 0 && name.startsWith(p));
}

/** Prune the step's tool list to its explicit allowedTools family (+ baseline).
 *  No-op when allowedTools doesn't lock the surface. */
export function lockToolsForStep<T extends { name?: string }>(tools: T[], allowed?: string[] | null): T[] {
  if (!stepAllowedToolsLock(allowed)) return tools;
  const allow = makeStepToolAllow(allowed as string[]);
  return tools.filter((t) => allow(typeof t?.name === 'string' ? t.name : ''));
}

const STEP_INSTRUCTIONS = [
  'You are executing ONE step of a workflow — a deterministic pipeline, not a chat.',
  'Do exactly the work the step prompt describes, using the smallest set of tool calls. Do not branch into other tasks, do not re-plan, do not ask the user questions.',
  'If a "=== STEP CONTEXT ===" block appears below, it is your bound inputs as authoritative structured DATA — trust it over the prose, and use those values directly. If a value you need is empty or absent there, call `workflow_step_result({"blocked":true,"reason":"<what is missing>"})` rather than guessing or inventing one.',
  'When you have the result, you MUST call `workflow_step_result(data)` EXACTLY ONCE as your final action, passing the COMPLETE structured payload the next step needs (e.g. the full array of records as JSON) — not a summary. The next step reads exactly what you pass here; a prose summary will starve it.',
  'If you genuinely cannot produce the result (missing required input, a tool failed), call `workflow_step_result(data)` with `{ "blocked": true, "reason": "<concrete blocker>" }` and stop. Do NOT try to re-run the workflow or work around it — blocking cleanly is correct.',
  'You cannot start, author, or schedule workflows, spawn workers, or re-plan. You CAN use the work tools the step needs — read/shell/file tools, the composio_status + composio_execute_tool gateway (and named tools through it), and notify_user when the step prompt asks you to report or summarize. Always finish by calling `workflow_step_result(data)`.',
].join('\n\n');

export interface BuildWorkflowStepAgentOptions {
  userInput?: string | null;
  sessionId?: string | null;
  mcpToolScope?: McpToolScope;
  /** The step's explicit allowedTools. When it locks the surface (non-wildcard),
   *  the agent's tool list is pruned to that family + the structural baseline,
   *  so a bound step can't drift onto composio. Omit / `['*']` → full surface. */
  lockTools?: string[] | null;
}

export async function buildWorkflowStepAgent(
  options: BuildWorkflowStepAgentOptions = {},
): Promise<Agent<RuntimeContextValue, typeof OrchestratorDecisionSchema>> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = lockToolsForStep(
    filterToolsForStep(all),
    options.lockTools,
  ) as Tool<RuntimeContextValue>[];
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
