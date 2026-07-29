import { Agent, tool } from '@openai/agents';
import type { Tool, ToolUseBehavior } from '@openai/agents';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MODELS } from '../config.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { RuntimeContextValue } from '../types.js';
import { wrapToolForHarness, type WrappableTool } from '../runtime/harness/brackets.js';
import { harnessInstructions } from './harness-context.js';
import { renderToolChoicesForContext } from '../memory/tool-choice-store.js';
import { externalMcpScopeForAllowedToolLock } from './external-mcp-scope-lock.js';
import {
  allRegistryNames,
  buildCompactToolCatalog,
  codexToolSearchEnabled,
  resolveHotSet,
  TOOL_SEARCH_ALWAYS_LOADED,
} from './tool-catalog.js';
import { resolveToolSurface } from '../runtime/harness/tool-surface.js';
import { buildCallTool } from '../tools/call-tool.js';
import { buildScopedLocalToolSearch } from '../tools/local-runtime-tools.js';
import { peekStepResult } from '../tools/step-result-tool.js';
import { bindAgentMcpToolScope } from '../runtime/mcp-tool-authority.js';
import { runWorkspaceDir } from '../execution/workflow-run-workspace.js';
import { queryWorkspaceArtifact } from '../tools/workspace-artifact-tools.js';

import { harnessInputGuardrails, harnessOutputGuardrails } from '../runtime/harness/guardrails.js';

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
 * It deliberately does NOT require an SDK `outputType` by default. The
 * workflow's real structured channel is workflow_step_result(data); requiring a
 * second JSON decision envelope made step runs fail on harmless final prose
 * ("Invalid output type") before the runner could consume the captured result.
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
  // scheduling: authoring/mutation of a workflow's schedule — a step runs
  // work, it doesn't (re)schedule or unschedule workflows
  'workflow_schedule',
  'workflow_unschedule',
  // agent authoring / swarm topology: a step can use work tools, but it must
  // not create durable agents or fan out work through the team substrate
  'agent_propose',
  'create_agent',
  'update_agent',
  'delete_agent',
  'delegate_task',
  // Background-task lifecycle belongs to the origin conversation. A child
  // workflow step must not revise the contract of a sibling/parent run.
  'background_task_revise',
  // Conversational focus/workstate belongs to the main brain. Stateless
  // workers and workflow steps return evidence; they never steer the user's
  // active thread or rewrite its shared notebook directly.
  'focus_get',
  'focus_set',
  'focus_update',
  'focus_touch',
  'focus_park',
  'focus_activate',
  'focus_clear',
  // tool authoring
  'create_tool',
  // unbounded fan-out
  'run_worker',
  // planning surface: a deterministic step does work, it doesn't plan/re-plan
  'surface_plan',
  'propose_plan',
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
// gateway — the proven drift vector). External MCP attachment is derived from
// the same lock below: local/structural locks attach no external MCP servers,
// and MCP-looking locks attach only the named server family. A step with no/`*`
// allowedTools is unchanged.

/** Structural channels a step always needs, regardless of its bound work family
 *  — NEVER pruned away. Beyond the output channel (without which a step can't
 *  return at all), this keeps the REPORT channel (notify_user — a triage/brief
 *  step's job is to report) and the RECALL channel (recall_tool_result /
 *  tool_output_query — to read back a large tool output the harness clipped to
 *  the side-store) plus read_file/workspace_artifact_query for workflow
 *  workspace context artifacts.
 *  These are structural, not "work" tools, so keeping them
 *  doesn't reopen the composio drift vector the lock exists to close. */
export const STEP_STRUCTURAL_BASELINE_TOOLS = new Set<string>([
  'workflow_step_result',
  'notify_user',
  'read_file',
  'workspace_artifact_query',
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

/**
 * Translate a locked step's explicit allowedTools into its external MCP surface.
 *
 * Return values are intentional:
 *   undefined => preserve the caller's legacy/default MCP scope
 *   null      => attach no external MCP servers
 *   scope     => attach only the matched server family
 */
export function workflowStepExternalMcpScopeForLock(
  allowed?: string[] | null,
  fallback?: McpToolScope | null,
  serverNames?: string[],
): McpToolScope | null | undefined {
  return externalMcpScopeForAllowedToolLock({
    allowed,
    fallback,
    serverNames,
    reason: 'workflow step allowedTools lock',
  });
}

const STEP_INSTRUCTIONS = [
  'You are executing ONE step of a workflow — a deterministic pipeline, not a chat.',
  'Do exactly the work the step prompt describes, using the smallest set of tool calls. Do not branch into other tasks, do not re-plan, do not ask the user questions.',
  'If a "=== STEP CONTEXT ===" block appears below, it is your bound inputs as authoritative structured DATA — trust it over the prose, and use those values directly. If a value you need is empty or absent there, call `workflow_step_result({"blocked":true,"reason":"<what is missing>"})` rather than guessing or inventing one.',
  'When you have the result, you MUST call `workflow_step_result(data)` EXACTLY ONCE as your final action, passing the COMPLETE structured payload the next step needs (e.g. the full array of records as JSON) — not a summary. The next step reads exactly what you pass here; a prose summary will starve it.',
  'If you genuinely cannot produce the result (missing required input, a tool failed), call `workflow_step_result(data)` with `{ "blocked": true, "reason": "<concrete blocker>" }` and stop. Do NOT try to re-run the workflow or work around it — blocking cleanly is correct.',
  'You cannot start, author, or schedule workflows, spawn workers, or re-plan. You CAN use the work tools the step needs — read/shell/file tools, the composio_status + composio_execute_tool gateway (and named tools through it), and notify_user when the step prompt asks you to report or summarize. Always finish by calling `workflow_step_result(data)`.',
].join('\n\n');

const NOT_FINAL_TOOL_OUTPUT = {
  isFinalOutput: false as const,
  isInterrupted: undefined,
};

/**
 * End the SDK's inner tool/model cycle at the accepted structural result call.
 * runConversation can only observe captures after an SDK turn returns; without
 * this boundary, a model may call workflow_step_result repeatedly inside one
 * turn. A rejected contract submission is not in the capture store, so it
 * correctly returns to the model for repair.
 */
export function workflowStepToolUseBehavior(
  sessionId?: string | null,
): ToolUseBehavior {
  return (_context, toolResults) => {
    const structural = toolResults.find((result) =>
      result.tool?.name === 'workflow_step_result');
    if (
      !structural
      || structural.type !== 'function_output'
      || !sessionId
      || !peekStepResult(sessionId).found
    ) {
      return NOT_FINAL_TOOL_OUTPUT;
    }
    const finalOutput = typeof structural.output === 'string'
      ? structural.output
      : JSON.stringify(structural.output ?? null);
    return {
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput,
    };
  };
}

export interface BuildWorkflowStepAgentOptions {
  userInput?: string | null;
  sessionId?: string | null;
  mcpToolScope?: McpToolScope | null;
  /** The step's explicit allowedTools. When it locks the surface (non-wildcard),
   *  the agent's tool list is pruned to that family + the structural baseline,
   *  so a bound step can't drift onto composio. Omit / `['*']` → full surface. */
  lockTools?: string[] | null;
  /**
   * Runtime-added graph prompts are intentionally graph-restricted. This is
   * stronger than an empty allowedTools array (which means "inherit the full
   * surface") and stronger than the normal structural baseline: only the
   * result channel and optional run-confined artifact query are exposed.
   */
  resultOnlyTools?: boolean;
  /** Exact run workspace boundary and event-owned artifact allowlist for a
   * graph-added node's one read helper. */
  graphContext?: {
    workflowName: string;
    runId: string;
    allowedArtifactPaths: string[];
  };
  /** Per-step model override (the intent-routed worker model). Omit ⇒ the
   *  primary brain tier, byte-identical to before. The registered
   *  RouterModelProvider dispatches the id to its provider (Codex/Claude/BYO). */
  model?: string;
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * One narrowly-scoped reader for graph-added nodes. Large upstream values are
 * represented as run-workspace refs; this tool can page those exact JSON rows
 * without granting general filesystem, memory, notification, or MCP access.
 */
function buildGraphContextQueryTool(
  context: NonNullable<BuildWorkflowStepAgentOptions['graphContext']>,
): Tool<RuntimeContextValue> {
  const allowedRelativePaths = new Set(
    context.allowedArtifactPaths.map((entry) => path.normalize(entry)),
  );
  return tool({
    name: 'workspace_artifact_query',
    description: 'Query exact JSON/JSONL rows from this workflow run workspace only. Use the path supplied in STEP CONTEXT when an upstream value is offloaded.',
    parameters: z.object({
      path: z.string().min(1),
      json_path: z.string().optional(),
      fields: z.array(z.string()).optional(),
      filter_field: z.string().optional(),
      filter_contains: z.string().optional(),
      filter_equals: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      max_chars: z.number().int().min(100).max(50_000).optional(),
    }),
    execute: async (input) => {
      try {
        const root = realpathSync(runWorkspaceDir(context.workflowName, context.runId));
        const candidate = path.isAbsolute(input.path)
          ? input.path
          : path.join(root, input.path);
        const resolved = realpathSync(candidate);
        if (!pathIsInside(root, resolved)) {
          return `Refused: graph context reads are limited to this run workspace (${root}).`;
        }
        const workspaceRelative = path.normalize(path.relative(root, resolved));
        if (!allowedRelativePaths.has(workspaceRelative)) {
          return 'Refused: this artifact is not owned by a completed event in the active workflow run.';
        }
        const result = queryWorkspaceArtifact({ ...input, path: resolved });
        return result.length <= 50_000
          ? result
          : `${result.slice(0, 50_000)}\n...[clipped; narrow the query or increase offset]`;
      } catch (error) {
        return `Graph context query failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  }) as Tool<RuntimeContextValue>;
}

export async function buildWorkflowStepAgent(
  options: BuildWorkflowStepAgentOptions = {},
): Promise<Agent<RuntimeContextValue, any>> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  let lockedTools = lockToolsForStep(
    filterToolsForStep(all),
    options.lockTools,
  ) as Tool<RuntimeContextValue>[];
  if (options.resultOnlyTools) {
    const resultTool = lockedTools.find((toolRef) =>
      (toolRef as { name?: string }).name === 'workflow_step_result');
    lockedTools = [
      ...(resultTool ? [resultTool] : []),
      ...(options.graphContext ? [buildGraphContextQueryTool(options.graphContext)] : []),
    ];
  }
  const surfaceLocked = options.resultOnlyTools || stepAllowedToolsLock(options.lockTools);
  const externalMcpScope = options.resultOnlyTools
    ? null
    : workflowStepExternalMcpScopeForLock(options.lockTools, options.mcpToolScope);

  // Workflow steps now have the same schema-on-demand escape hatch as chat:
  // a tiny structural/acquisition kernel stays first-class; every other local
  // work tool remains callable this turn through tool_search -> call_tool.
  // This is capability-preserving, unlike semantic pruning: no guessed intent
  // can remove a tool. Explicit allowedTools locks stay exact and bypass this
  // layer entirely.
  const schemaOnDemand = !surfaceLocked && codexToolSearchEnabled();
  let tools = lockedTools;
  let catalogBlock = '';
  if (schemaOnDemand) {
    const availableNames = new Set(
      lockedTools
        .map((toolRef) => (toolRef as { name?: string }).name ?? '')
        .filter(Boolean),
    );
    const registryNames = allRegistryNames();
    const uncataloguedNames = [...availableNames].filter((name) => !registryNames.has(name));
    const promoted = resolveHotSet(options.sessionId, options.userInput, { allowedNames: availableNames });
    const surface = resolveToolSurface({
      surface: 'workflow-step',
      lane: 'workflow',
      availableNames,
      alwaysLoadedNames: [
        ...STEP_STRUCTURAL_BASELINE_TOOLS,
        ...TOOL_SEARCH_ALWAYS_LOADED,
        ...uncataloguedNames,
      ],
      promotedNames: promoted,
      deferralEnabled: true,
      reason: 'workflow-step schema-on-demand surface',
    });
    const firstClassNames = new Set(surface.firstClass);
    const deferredNames = new Set(surface.deferred);
    const firstClassTools = lockedTools
      .filter((toolRef) => firstClassNames.has((toolRef as { name?: string }).name ?? ''))
      .map((toolRef) => (toolRef as { name?: string }).name === 'tool_search'
        ? buildScopedLocalToolSearch(deferredNames)
        : toolRef);
    const dispatcher = buildCallTool({
      reachableBuiltinNames: deferredNames,
      firstClassNames,
      deniedNames: WORKFLOW_STEP_BLOCKED_TOOL_NAMES,
      mcpToolScope: externalMcpScope,
    }) as Tool<RuntimeContextValue>;
    tools = [...firstClassTools, dispatcher];
    const compactCatalog = buildCompactToolCatalog({ allowedNames: deferredNames });
    catalogBlock = [
      '[workflow-tool-catalog] You retain full workflow-step capability with schemas loaded on demand. '
        + 'Common structural tools are first-class. For any deferred local tool below, call `tool_search(query)` for its exact schema, then `call_tool(name, args_json)`. '
        + 'For a connected external MCP tool, discover its exact `<server>__<tool>` name with `mcp_list_tools`, then invoke it through `call_tool`. '
        + 'The inner tool keeps its normal safety/approval policy. Do not claim a listed capability is unavailable.',
      compactCatalog,
    ].filter(Boolean).join('\n');
  }
  // Recall the proven tool for this step's intent — but ONLY for an UNBOUND step.
  // A step whose allowedTools LOCK the surface already has its tool chosen, so the
  // recall block would be noise; an unbound / composio step is where the model picks
  // a tool and benefits from "for this intent, X worked before" (parity with chat).
  const learnedRecall = (!surfaceLocked && options.userInput)
    ? renderToolChoicesForContext(8, undefined, options.userInput)
    : '';
  const staticInstructions = [
    STEP_INSTRUCTIONS,
    ...(options.resultOnlyTools
      ? [
          'This is a graph-added read-only prompt node. You have no work tools, external MCP servers, general file access, notification authority, or wildcard authority. For an offloaded upstream value, workspace_artifact_query can page exact JSON rows from this run workspace only. Reason over the supplied prompt and step context, then return the result through workflow_step_result.',
        ]
      : []),
    catalogBlock,
  ].filter(Boolean).join('\n\n');
  const baseInstructions = harnessInstructions(staticInstructions, { includeRememberedToolChoices: false });
  const instructions = learnedRecall
    ? () => `${baseInstructions()}\n\n${learnedRecall}`
    : baseInstructions;
  // An unbound schema-on-demand step reaches external MCPs through
  // mcp_list_tools/call_tool, so attaching every configured server (and every
  // schema) up front is unnecessary. Explicit MCP allowedTools locks retain
  // their narrowed native attachment.
  const externalMcpServers = schemaOnDemand || externalMcpScope === null
    ? []
    : [getOrCreateExternalMcpServers(externalMcpScope)];
  const agent = new Agent<RuntimeContextValue, any>({
    name: 'WorkflowStep',
    instructions,
    // Step orchestration (OrchestratorDecisionSchema, multi-tool) stays on the
    // brain/primary tier unless the step carries an intent-routed model override
    // (see workflow-runner runStepViaHarness). The RouterModelProvider dispatches
    // the id to its provider.
    model: options.model ?? MODELS.primary,
    // No SDK structured outputType: workflow_step_result(data) is the one
    // structured channel. A second response_format envelope only gives the
    // model another way to fail after doing useful work.
    tools: tools.map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    toolUseBehavior: workflowStepToolUseBehavior(options.sessionId),
    ...(externalMcpServers.length > 0 ? { mcpServers: externalMcpServers } : {}),
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
  bindAgentMcpToolScope(agent, externalMcpScope);
  return agent;
}
