import path from 'node:path';
import { existsSync } from 'node:fs';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  McpServerConfig,
  Options as ClaudeAgentOptions,
  PermissionResult,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { BASE_DIR, PKG_DIR, getRuntimeEnv } from '../../config.js';
import { cliBinaryFromCommand } from '../../memory/authoritative-sources.js';
import { scheduleReflection } from '../../memory/reflection.js';
import { mergedSpawnEnv } from '../spawn-env.js';
import { buildClaudeHeadlessEnv, claudeCliModelArg, resolveClaudeCliPath } from './claude-headless-model.js';
import { buildGatedToolPermission } from './claude-agent-approval.js';
import { renderTranscriptTurns } from './session-transcript.js';
import { recordModelUsage } from '../usage-log.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { AgentRuntimeCancelledError } from '../provider.js';

type QueryFn = typeof claudeQuery;
let queryImpl: QueryFn = claudeQuery;

export function setClaudeAgentSdkQueryForTest(fn: QueryFn | null): void {
  queryImpl = fn ?? claudeQuery;
}

// Test seam for the learning-OUT bridge (see runClaudeAgentSdk). Lets a test
// assert which tool returns get reflected without running the real extractor.
type ReflectFn = typeof scheduleReflection;
let reflectImpl: ReflectFn = scheduleReflection;
export function setClaudeAgentSdkReflectionForTest(fn: ReflectFn | null): void {
  reflectImpl = fn ?? scheduleReflection;
}

// -------- In-lane provider-overload retry (first-byte-safe) --------
// The Claude Code SDK has no retry/fallover of its own: a 529 Overloaded / 5xx
// from `query()` throws "Claude Code returned an error result: API Error: …"
// terminally. This made an Anthropic overload dead-end EVERY raw-SDK caller
// (workflow steps, chat brain, run_worker) — none of which pass through
// RouterModelProvider's withModelFallback. We retry the WHOLE query with backoff,
// but ONLY when it's safe: no tool executed and nothing streamed to the user yet,
// so a re-run can't double-act or duplicate visible output. A mid-run overload
// (after tools) is left to the CALLER's step/turn-boundary cross-provider switch.

/**
 * Thrown when the Claude SDK lane gives up on a provider overload/5xx (after
 * the first-byte retries). `committed` tells a caller whether anything was
 * already done this turn (a tool ran OR text streamed to the user) — when it's
 * FALSE the turn never progressed, so a caller that can run on another provider
 * may safely re-dispatch the WHOLE turn/step without double-acting. When TRUE,
 * the caller must surface the error (re-running could double-send / duplicate).
 * `.message` is the SDK's verbatim message, so existing message-based checks
 * (isTransientStepError) keep working unchanged.
 */
export class ClaudeSdkProviderOverloadError extends Error {
  readonly overloaded = true;
  constructor(message: string, readonly committed: boolean) {
    super(message);
    this.name = 'ClaudeSdkProviderOverloadError';
  }
}

export class ClaudeAgentSdkToolSurfaceError extends Error {
  readonly missingTools: string[];
  readonly availableTools: string[];

  constructor(missingTools: string[], availableTools: string[]) {
    super(
      `Claude Agent SDK local MCP surface is missing required tool${missingTools.length === 1 ? '' : 's'}: `
      + `${missingTools.join(', ')}. Available tools: ${availableTools.length ? availableTools.join(', ') : '(none)'}`,
    );
    this.name = 'ClaudeAgentSdkToolSurfaceError';
    this.missingTools = missingTools;
    this.availableTools = availableTools;
  }
}

/** Anthropic/Codex SDK overloads embed the status in the message text. */
export function isProviderOverloadMessage(msg: string): boolean {
  if (!msg) return false;
  return /\boverloaded\b/i.test(msg)
    || /internal server error/i.test(msg)
    || /service unavailable|bad gateway|gateway timeout|temporarily unavailable/i.test(msg)
    || /\b(?:api error|http|status)\s*[:#]?\s*(?:429|500|502|503|504|529)\b/i.test(msg);
}

function overloadRetryEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_OVERLOAD_RETRY', 'on') ?? 'on').toLowerCase() !== 'off';
}
function maxOverloadRetries(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_OVERLOAD_RETRIES', '2') || '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}
/** Bounded exponential backoff with jitter: ~1.5s, ~3.5s. Base tunable
 *  (CLEMMY_CLAUDE_SDK_OVERLOAD_BACKOFF_MS) so tests don't pay real seconds. */
function overloadBackoffMs(attempt: number): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_OVERLOAD_BACKOFF_MS', '') || '', 10);
  const baseUnit = Number.isFinite(raw) && raw >= 0 ? raw : 1500;
  const base = baseUnit * Math.pow(2, attempt);
  return Math.min(15_000, base) + Math.floor(Math.random() * 500);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -------- Phase 2: bound the SDK lane (anti-thrash) --------
// The Claude Agent SDK chat lane has NO per-turn tool-call ceiling — its MCP-side
// ToolCallsCounter is reconstructed at 1000 every call (gated-mutating-tools.ts)
// so it never accumulates — and NO wall-clock backstop; only maxTurns. A runaway
// (the 33-shell-call thrash that looked frozen and DOUBLE-SENT 3 emails,
// 2026-06-29) therefore ran unbounded. The ceiling below counts calls in the
// host-side `canUseTool` (which the SDK awaits before EVERY tool and which
// persists across the whole turn) and, once a thrash crosses the bound, returns
// `interrupt:true` to actually STOP the turn — the one place that can. All bounds
// are kill-switchable and default generous (a backstop, never a limiter on real
// deep work).
function sdkToolCeilingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SDK_TOOL_CEILING', 'on') ?? 'on').toLowerCase() !== 'off';
}
function sdkMutatingCallCeiling(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_SDK_MUTATING_CALL_CEILING', '50') || '50', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}
function sdkTotalCallCeiling(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_SDK_TOTAL_CALL_CEILING', '300') || '300', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}
/** 0 / "off" disables. Default 15 min: well beyond any normal turn — a backstop
 *  against a genuinely stuck stream, not a limiter on legitimate long work. */
function sdkWallClockMs(): number {
  const raw = (getRuntimeEnv('CLEMMY_SDK_WALL_CLOCK_MS', '') ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

/** Mutable per-turn bookkeeping shared between the ceiling `canUseTool` wrapper
 *  and the run loop, so a self-imposed stop surfaces as a graceful limitHit
 *  (partial answer + "say continue") instead of a raw error. */
// pausedMs accumulates time spent INSIDE the base canUseTool — for a gated tool
// that is dominated by the HUMAN approval wait (canUseTool does no model/tool
// work, only the permission decision). It is subtracted from the wall clock so a
// long confirm-first approval can't self-abort the turn the moment the user
// approves — honoring "approve once, then run to completion".
interface ToolCeilingState { total: number; mutating: number; stopped: string | null; pausedMs: number }

/** Wrap a base `canUseTool` to (1) ALWAYS meter approval-wait time into
 *  state.pausedMs (so the wall clock excludes it), and (2) when `countCeiling`,
 *  enforce a session-scoped call ceiling: mutating (non-fast-allow) calls get a
 *  LOW ceiling, reads a HIGH one. Crossing either bound denies WITH
 *  `interrupt:true` (stops the turn) and latches `stopped` so every subsequent
 *  call keeps denying — belt-and-suspenders if the SDK doesn't honor the
 *  interrupt immediately. */
function withToolCeiling(base: CanUseTool, fastAllowTools: string[], state: ToolCeilingState, opts: { countCeiling: boolean }): CanUseTool {
  const fastAllow = new Set(fastAllowTools.map(normalizeToolName).filter(Boolean));
  const mutCeiling = sdkMutatingCallCeiling();
  const totalCeiling = sdkTotalCallCeiling();
  return (async (toolName, input, options) => {
    if (opts.countCeiling) {
      if (state.stopped !== null) {
        return { behavior: 'deny', message: state.stopped, interrupt: true } as PermissionResult;
      }
      const tail = toolName.split('__').at(-1) ?? toolName;
      const isRead = fastAllow.has(normalizeToolName(toolName)) || fastAllow.has(normalizeToolName(tail));
      state.total += 1;
      if (!isRead) state.mutating += 1;
      if (state.mutating > mutCeiling || state.total > totalCeiling) {
        const why = state.mutating > mutCeiling ? `${state.mutating} actions` : `${state.total} tool calls`;
        state.stopped = `I stopped myself after ${why} without finishing — that looked like a loop, so I held off rather than keep going and risk repeating an action. Tell me how you'd like to proceed and I'll pick it back up.`;
        return { behavior: 'deny', message: state.stopped, interrupt: true } as PermissionResult;
      }
    }
    const t0 = Date.now();
    try {
      return await base(toolName, input, options);
    } finally {
      state.pausedMs += Date.now() - t0;
    }
  }) as CanUseTool;
}

export const CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS = [
  'ping',
  // Converse-first: the Claude brain's rubric says to ask ONE clarifying question
  // up front for an ambiguous / multi-step request — but it had NO tool to do it, so
  // it fell through to execution (2026-07-01: it proceeded where the Codex brain asked).
  // In READ_ONLY so it flows into every profile (a read-only brain can still ask).
  // It is a terminal-after-tool (below): calling it stops the turn + surfaces the
  // question, and the user's next message answers it.
  'ask_user_question',
  'memory_search',
  'memory_read',
  'memory_recall',
  'memory_list_facts',
  'memory_search_facts',
  // Local-only memory writes are safe in the "read-only" Claude brain profile:
  // they do not touch external systems, but they preserve core chat semantics
  // for explicit "remember this" requests across model backends.
  'memory_remember',
  'task_list',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  // Read a Workspace (interactive surface) + list them — a dock chat runs under
  // session "space-<slug>" and must be able to read the workspace it edits.
  // space_get_view returns the actual line-numbered view HTML (space_get does not),
  // so the model can craft a verbatim space_edit_view find string instead of
  // shelling out to read_file/grep the view.
  'space_get',
  'space_get_view',
  'space_get_runner',
  'space_list',
  'list_files',
  'read_file',
  'git_status',
  'mcp_status',
  'composio_status',
  'user_profile_read',
  'session_history',
  'agent_runs_recent',
  'agent_run_get',
  'background_tasks_recent',
  'background_task_status',
  'dispatch_background_task',
  'hold_task_for_later',
  'resume_held_task',
  'skill_list',
  'skill_read',
  'tool_choice_recall',
  // Recall the verbatim / sliced payload of a clipped tool result (read-only).
  'recall_tool_result',
  'tool_output_query',
] as const;

export const CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS = [
  ...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  // Local Clementine memory / planning state. These never touch external
  // systems, but they let Claude act like a real selected brain instead of a
  // read-only analyst.
  'memory_remember',
  'source_map_upsert',
  'working_memory',
  'note_create',
  'note_take',
  'task_add',
  'task_update',
  'goal_create',
  'goal_update',
  'create_plan',
  'update_plan_step',
  // Role routing is local env state and is the chat surface for "use Claude for
  // design" / "make Opus the judge".
  'set_model_role',
  'clear_model_role',
  // Workflow authoring and queueing are local Clementine state. The workflow
  // runner still owns execution-time write/send gates.
  'workflow_list',
  'workflow_get',
  'workflow_create',
  'workflow_from_session',
  'workflow_update',
  'workflow_edit_step',
  'workflow_set_enabled',
  'workflow_run',
  'workflow_run_status',
  'workflow_rerun_failed_items',
  'workflow_schedule',
  'workflow_unschedule',
  // Editing a Workspace is LOCAL Clementine state (the view + its data runners),
  // like workflow authoring above. space_edit_view/space_save change the local
  // view; space_refresh re-pulls its data. Without these in the surface, a Claude
  // dock turn can't persist a workspace edit and wrongly writes a scratch file.
  'space_edit_view',
  'space_edit_runner',
  'space_revert_runner',
  'space_save',
  'space_refresh',
  // space_try_runner dry-runs a candidate data runner (no persist) so the model
  // iterates inside the surface instead of `node data/x.mjs` in the shell;
  // space_set_data commits a known inline dataset (the one-row-fix path).
  'space_try_runner',
  'space_set_data',
] as const;

// Mutating tools exposed through the harness gate chain (gated-mutating-tools.ts)
// + the async approval gate (claude-agent-approval.ts). Shared by the brain
// (full) and worker (scoped) agentic profiles.
const AGENTIC_EXECUTION_TOOLS = [
  'run_shell_command',
  'write_file',
  'composio_search_tools',
  'composio_list_tools',
  'composio_execute_tool',
  'local_cli_list',
  'local_cli_probe',
  // Surface-to-user channel. A workflow "notify"/report step (and agentic
  // workers) need this to actually deliver — it's registered on the MCP server
  // (registerAutonomyActionTools) but was absent from the allowlist, so a Claude
  // notify step blocked with no tool to call.
  'notify_user',
] as const;

/** Full agentic surface for the Claude BRAIN: local-authoring + execution tools
 *  + the gated mutating surface. Execution lanes let the execution-wrap gate be
 *  satisfied and batch fan-out wrap. */
export const CLAUDE_AGENT_SDK_FULL_TOOLS = [
  ...CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  ...AGENTIC_EXECUTION_TOOLS,
  'execution_create',
  'execution_list',
  'execution_get',
  'execution_update_step',
  'execution_mark_blocked',
  'execution_complete',
  // Fan-out primitive — BRAIN ONLY (deliberately NOT in AGENTIC_EXECUTION_TOOLS, so a
  // WORKER never gets run_worker → no worker-spawns-worker recursion). Lets a Claude
  // brain parallelize N independent items instead of processing them sequentially and
  // blowing its per-query turn budget.
  'run_worker',
] as const;

/** Scoped agentic surface for a Claude WORKER (one parent-planned item). The
 *  PARENT owns the execution lane + batch approval, so a worker gets the gated
 *  mutating tools but NOT execution_create / workflow authoring. The shared
 *  parent session means the parent's execution lane + plan-scope cover the
 *  worker's gated writes. */
export const CLAUDE_AGENT_SDK_WORKER_TOOLS = [
  ...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  ...AGENTIC_EXECUTION_TOOLS,
] as const;

export type ClaudeAgentSdkToolProfile = 'read_only' | 'local_authoring' | 'full' | 'worker';

export function defaultClaudeAgentSdkAllowedLocalTools(profile: ClaudeAgentSdkToolProfile = 'read_only'): string[] {
  const raw = process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS?.trim();
  if (!raw && profile === 'full') return [...new Set(CLAUDE_AGENT_SDK_FULL_TOOLS)];
  if (!raw && profile === 'worker') return [...new Set(CLAUDE_AGENT_SDK_WORKER_TOOLS)];
  if (!raw && profile === 'local_authoring') return [...new Set(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS)];
  if (!raw) return [...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS];
  return raw
    .split(',')
    .map((toolName) => toolName.trim())
    .filter(Boolean);
}

function localNodeCommand(): string {
  return process.execPath || 'node';
}

export function buildClaudeAgentSdkLocalMcpServers(
  sessionId?: string,
  gatedMutations = false,
  mcpToolAllowlist?: string[],
): Record<string, McpServerConfig> {
  const distEntry = path.join(PKG_DIR, 'dist', 'tools', 'mcp-server.js');
  const srcEntry = path.join(PKG_DIR, 'src', 'tools', 'mcp-server.ts');
  // gatedMutations=on exposes the mutating tools (shell/composio/write) on the
  // MCP surface, each run through the full harness gate chain (see
  // gated-mutating-tools.ts). Set only for the agentic brain/worker profiles —
  // a read-only run leaves it off so those tools never appear.
  // mcpToolAllowlist (JIT tool-RAG): when non-empty, the server advertises ONLY
  // those tools — fewer schemas sent to the model = fewer input tokens. Absent →
  // every tool registers (byte-identical to before).
  const allowlist = (mcpToolAllowlist ?? []).map((t) => t.trim()).filter(Boolean);
  const env = mergedSpawnEnv({
    CLEMENTINE_HOME: BASE_DIR,
    ...(sessionId?.trim() ? { CLEMENTINE_MCP_SESSION_ID: sessionId.trim() } : {}),
    ...(gatedMutations ? { CLEMENTINE_MCP_GATED_MUTATIONS: 'on' } : {}),
    ...(allowlist.length > 0 ? { CLEMENTINE_MCP_ALLOWED_TOOLS: allowlist.join(',') } : {}),
  });
  if (existsSync(distEntry)) {
    return {
      'clementine-local': {
        type: 'stdio',
        command: localNodeCommand(),
        args: [distEntry],
        env,
        timeout: 10 * 60 * 1000,
        alwaysLoad: true,
      },
    };
  }
  return {
    'clementine-local': {
      type: 'stdio',
      command: 'npx',
      args: ['tsx', srcEntry],
      env,
      timeout: 10 * 60 * 1000,
      alwaysLoad: true,
    },
  };
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function buildAllowOnlyToolsPermission(allowedTools: string[]): CanUseTool {
  const allowed = new Set(allowedTools.map(normalizeToolName).filter(Boolean));
  return async (toolName) => {
    const normalized = normalizeToolName(toolName);
    const tail = toolName.split('__').at(-1) ?? toolName;
    if (allowed.has(normalized) || allowed.has(normalizeToolName(tail))) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message: `Clementine did not allow Claude Agent SDK tool ${toolName} in this run.`,
      interrupt: false,
    };
  };
}

/** Emit a canonical operational tool-call event for the Claude SDK lane (chat +
 *  workflow step). Derives the workflow run/node from a "workflow:<runId>:<stepId>"
 *  session id so workflow-step tool calls link to their run. Fail-open. */
function emitSdkToolCallEvent(
  sessionId: string | undefined,
  type: 'tool_call_started' | 'tool_call_completed' | 'tool_call_failed',
  callId: string,
  toolName: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  try {
    const wf = sessionId && sessionId.startsWith('workflow:') ? sessionId.split(':') : null;
    recordOperationalEvent({
      source: 'tool',
      type,
      severity: type === 'tool_call_failed' ? 'error' : 'info',
      sessionId,
      workflowRunId: wf ? wf[1] : undefined,
      workflowNodeRunId: wf && wf.length > 2 ? wf.slice(2).join(':') : undefined,
      toolCallId: callId,
      actor: 'claude-agent-sdk',
      payload: { tool: toolName ? mcpToolTail(toolName) : undefined, ...extra },
    });
  } catch { /* observability must never break the SDK run */ }
}

function mcpToolTail(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName;
}

function sdkToolNamesForLocalMcp(tools: string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) {
    const t = tool.trim();
    if (!t) continue;
    out.add(t);
    out.add(`mcp__clementine-local__${t}`);
    out.add(`mcp__clementine_local__${t}`);
  }
  return [...out];
}

function missingRequiredLocalMcpTools(requiredTools: string[] | undefined, advertisedTools: string[]): string[] {
  const required = [...new Set((requiredTools ?? []).map((t) => t.trim()).filter(Boolean))];
  if (required.length === 0) return [];
  const advertised = new Set<string>();
  for (const tool of advertisedTools) {
    advertised.add(normalizeToolName(tool));
    advertised.add(normalizeToolName(mcpToolTail(tool)));
  }
  return required.filter((tool) => !advertised.has(normalizeToolName(tool)));
}

function assertRequiredLocalMcpTools(requiredTools: string[] | undefined, advertisedTools: string[]): void {
  const missing = missingRequiredLocalMcpTools(requiredTools, advertisedTools);
  if (missing.length > 0) throw new ClaudeAgentSdkToolSurfaceError(missing, advertisedTools);
}

export interface ClaudeAgentSdkRunOptions {
  prompt: string;
  sessionId?: string;
  modelId?: string;
  systemAppend?: string;
  allowedLocalMcpTools?: string[];
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
  /**
   * Agentic lane: expose the gated mutating tools on MCP, run the async
   * approval gate (buildGatedToolPermission) instead of deny-only allowlisting,
   * and use permissionMode 'default' so non-allowlisted tools reach our gate.
   * Requires a sessionId (the gates + approval read/write the session's event
   * log); silently falls back to the read-only allowlist without one.
   */
  agentic?: boolean;
  /**
   * JIT tool-RAG (Claude-brain port). When set, the in-process MCP server is
   * spawned advertising ONLY these tools, so the model receives only their schemas
   * (fewer input tokens). The brain computes it per turn via selectToolsForTurn;
   * absent → the server advertises every tool (byte-identical). Should be a SUPERSET
   * of whatever the model is permitted to call (allowedLocalMcpTools).
   */
  mcpToolAllowlist?: string[];
  /**
   * Concrete tools this run is about to depend on. The SDK init message is the
   * authoritative advertised MCP surface; if any required tool is missing there,
   * fail before the model starts trying to work around a tool that does not exist.
   */
  requiredLocalMcpTools?: string[];
  /**
   * CHAT-only multi-turn history. When set, the prior user/assistant turns of
   * this session are prepended to the prompt as an authoritative transcript block
   * so the Claude brain has conversation context (the Codex lane gets this from
   * its persisted AgentInputItem snapshot; the SDK lane is stateless —
   * persistSession:false). Worker/workflow callers omit it → byte-identical.
   */
  priorTurns?: Array<{ who: 'user' | 'assistant'; text: string }>;
  /**
   * CHAT-only VOLATILE per-turn context (current time, query recall, live
   * focus/goals, this-session actions). Injected into the USER turn — NOT the
   * system append — so the stable system prefix stays cacheable across turns
   * (Phase 3 #1). Absent → nothing added (worker/workflow + split-off path).
   */
  turnContext?: string;
  /**
   * CHAT-only streaming. When set, assistant text deltas are forwarded as they
   * arrive (this also flips includePartialMessages on). ONLY text_delta is
   * forwarded — thinking/tool-arg deltas are filtered out. Worker/workflow
   * callers omit it → no partial messages, byte-identical result assembly.
   */
  onDelta?: (text: string) => void | Promise<void>;
  /**
   * Wall-clock backstop (ms) for the whole turn. The stream loop breaks if the
   * turn outruns it, returning the graceful `limitHit` shape (partial answer +
   * "say continue") rather than hanging. Absent → the lane default
   * (sdkWallClockMs, 15 min, kill-switchable); 0 disables.
   */
  maxWallClockMs?: number;
  /** Caller-driven cancellation hook (background task cancel/deadline). */
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface ClaudeAgentSdkRunResult {
  text: string;
  structuredOutput?: unknown;
  sessionId?: string;
  model?: string;
  toolUses: string[];
  usage?: unknown;
  modelUsage?: unknown;
  /** True when the run stopped because it hit the turn budget (error_max_turns)
   *  rather than finishing. The caller surfaces a graceful "say continue" instead
   *  of a hard error — parity with the harness loop's auto-continue-on-limit. */
  limitHit?: boolean;
}

function extractAssistantToolUses(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown };
    if (b.type === 'tool_use' && typeof b.name === 'string') out.push(b.name);
  }
  return out;
}

/** Pair tool_use ids → names from an assistant message (the MCP tool name is
 *  namespaced, e.g. `mcp__clementine-local__run_shell_command`). Used to label
 *  the reflection so the source-trust classifier can see the producing tool. */
function extractToolUseIds(message: SDKMessage): Array<{ id: string; name: string; input: unknown }> {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  return out;
}

function bareMcpToolName(rawName: string): string {
  return rawName.split('__').at(-1) ?? rawName;
}

const TERMINAL_AFTER_TOOL_NAMES = new Set(['dispatch_background_task', 'ask_user_question']);

function isTerminalAfterTool(rawName: string | null | undefined): boolean {
  return typeof rawName === 'string' && TERMINAL_AFTER_TOOL_NAMES.has(bareMcpToolName(rawName));
}

function renderTerminalToolReply(rawName: string, input: unknown, output: string): string {
  const bare = bareMcpToolName(rawName);
  if (bare === 'dispatch_background_task') {
    const match = output.match(/Dispatched "([^"]+)" to the background \(task ([^)]+)\)/i);
    const inputObjective = (input as { objective?: unknown } | null | undefined)?.objective;
    const title = match?.[1] || (typeof inputObjective === 'string' && inputObjective.trim() ? inputObjective.trim() : 'the task');
    const taskId = match?.[2];
    return `On it - I started "${title}" as a background task${taskId ? ` (${taskId})` : ''}. It will keep running in the daemon and report back here when it finishes or gets stuck.`;
  }
  if (bare === 'ask_user_question') {
    // Surface the QUESTION inline (from the tool input) so the turn ends on a clean
    // clarifying question the user answers in their next message — the conversational
    // beat. Render from the input, not the tool output (which is a check-in receipt),
    // so the question shows even if the check-in record write hiccuped.
    const q = (input as { question?: unknown } | null | undefined)?.question;
    return typeof q === 'string' && q.trim() ? q.trim() : (output.trim() || 'I have a quick question before I proceed.');
  }
  return output.trim() || `${bare} completed.`;
}

function reflectionToolName(rawName: string | null, input: unknown): string | null {
  if (!rawName) return null;
  const bare = bareMcpToolName(rawName);
  if (bare === 'composio_execute_tool') {
    const slug = (input as { tool_slug?: unknown } | null | undefined)?.tool_slug;
    return typeof slug === 'string' && slug.trim() ? slug.trim() : bare;
  }
  if (bare === 'run_shell_command') {
    const command = (input as { command?: unknown } | null | undefined)?.command;
    return typeof command === 'string' ? (cliBinaryFromCommand(command) ?? bare) : bare;
  }
  return bare;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cc = c as { type?: unknown; text?: unknown };
        return cc.type === 'text' && typeof cc.text === 'string' ? cc.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** Pull tool_result blocks (callId + flattened text) from a user message — the
 *  Agent SDK feeds MCP tool results back as a user turn carrying
 *  `{ type: 'tool_result', tool_use_id, content }` blocks. */
function extractToolResults(message: SDKMessage): Array<{ callId: string; output: string; isError: boolean }> {
  if (message.type !== 'user') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ callId: string; output: string; isError: boolean }> = [];
  for (const block of content) {
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ callId: b.tool_use_id, output: normalizeToolResultContent(b.content), isError: b.is_error === true });
    }
  }
  return out;
}

/** Kill-switch for the Agent SDK learning-OUT bridge (default ON). Off ⇒ Claude
 *  brain/worker turns no longer write facts back (legacy behaviour). The global
 *  reflection disable flag still applies inside scheduleReflection regardless. */
export function claudeSdkReflectionEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_REFLECTION', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Flatten an assistant message's text blocks — used to keep the latest partial
 *  answer so a turn-limit stop can surface it gracefully (error results carry no
 *  `result` text). */
function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('');
}

/** Pull a streaming TEXT delta from a partial-message stream_event. Filters
 *  STRICTLY to text_delta — thinking_delta (chain-of-thought) and input_json_delta
 *  (raw tool-call args) are skipped so they never stream into the chat bubble. */
function extractTextDelta(message: SDKMessage): string {
  const m = message as { type?: unknown; event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } };
  if (m.type !== 'stream_event') return '';
  const ev = m.event;
  if (!ev || ev.type !== 'content_block_delta') return '';
  const delta = ev.delta;
  if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string') return '';
  return delta.text;
}

function extractResult(message: SDKMessage): SDKResultMessage | null {
  return message.type === 'result' ? (message as SDKResultMessage) : null;
}

function extractInit(message: SDKMessage): SDKSystemMessage | null {
  return message.type === 'system' && (message as { subtype?: unknown }).subtype === 'init'
    ? (message as SDKSystemMessage)
    : null;
}

function numeric(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readUsageField(obj: Record<string, unknown> | undefined, snake: string, camel: string): number {
  if (!obj) return 0;
  return numeric(obj[snake]) || numeric(obj[camel]);
}

function usageTotalsFromResult(result: SDKResultMessage | null): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (!result) return null;
  const usage = result.usage as Record<string, unknown> | undefined;
  let inputTokens =
    readUsageField(usage, 'input_tokens', 'inputTokens')
    + readUsageField(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens')
    + readUsageField(usage, 'cache_read_input_tokens', 'cacheReadInputTokens');
  let cachedInputTokens = readUsageField(usage, 'cache_read_input_tokens', 'cacheReadInputTokens');
  let outputTokens = readUsageField(usage, 'output_tokens', 'outputTokens');

  // Some SDK versions emphasize modelUsage; keep it as a fallback when the
  // aggregate usage is absent/zero.
  if (inputTokens === 0 && outputTokens === 0 && result.modelUsage && typeof result.modelUsage === 'object') {
    for (const raw of Object.values(result.modelUsage as Record<string, unknown>)) {
      const m = raw as Record<string, unknown>;
      inputTokens += numeric(m.inputTokens) + numeric(m.cacheCreationInputTokens) + numeric(m.cacheReadInputTokens);
      cachedInputTokens += numeric(m.cacheReadInputTokens);
      outputTokens += numeric(m.outputTokens);
    }
  }
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function recordClaudeAgentSdkUsage(
  options: ClaudeAgentSdkRunOptions,
  result: SDKResultMessage | null,
  init: SDKSystemMessage | null,
): void {
  try {
    const totals = usageTotalsFromResult(result);
    if (!totals) return;
    const responseId = (result as { uuid?: unknown } | null)?.uuid;
    recordModelUsage({
      sessionId: options.sessionId?.trim() || result?.session_id || init?.session_id || 'unknown',
      model: init?.model || options.modelId || 'claude-agent-sdk',
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      durationMs: numeric((result as { duration_ms?: unknown } | null)?.duration_ms),
      responseId: typeof responseId === 'string' ? responseId : undefined,
    });
  } catch { /* observability must never break the SDK lane */ }
}

function bestLimitHitText(lastAssistantText: string, streamedText: string): string {
  const assistant = lastAssistantText.trim();
  const streamed = streamedText.trim();
  if (streamed && (!assistant || streamed.length >= assistant.length)) return streamed;
  return assistant || streamed || 'I reached the turn budget before finishing. Say "continue" and I\'ll pick up where I left off.';
}

function bestSuccessText(resultText: string | undefined, lastAssistantText: string, streamedText: string): string {
  const result = resultText?.trim();
  if (result) return resultText as string;
  const assistant = lastAssistantText.trim();
  const streamed = streamedText.trim();
  if (streamed && (!assistant || streamed.length >= assistant.length)) return streamed;
  return assistant || streamed || '';
}

export async function runClaudeAgentSdk(options: ClaudeAgentSdkRunOptions): Promise<ClaudeAgentSdkRunResult> {
  const env = await buildClaudeHeadlessEnv();
  const allowed = options.allowedLocalMcpTools ?? defaultClaudeAgentSdkAllowedLocalTools();
  // Agentic lane requires a session id (the gate chain + approval read/write the
  // session's event log). Without one, fall back to the read-only allowlist.
  const agentic = Boolean(options.agentic && options.sessionId?.trim());
  // Point the SDK at the user's installed `claude` CLI. The npm package ships the
  // native CLI as an OPTIONAL per-arch dep (@anthropic-ai/claude-agent-sdk-<plat>);
  // when packaged with --omit=optional (and/or when the daemon's arch differs from
  // the only bundled arch) the SDK's auto-resolve throws "Native CLI binary for
  // <plat>-<arch> not found". Resolving the user's own subscription-authed,
  // auto-updating `claude` here removes that dependency entirely (and the SDK
  // spawns it the same way it would the bundled native binary).
  const pathToClaudeCodeExecutable = resolveClaudeCliPath() ?? undefined;
  // Anti-thrash bounding (Phase 2): a per-turn call ceiling that INTERRUPTS the
  // SDK turn, shared with the run loop so a self-stop reads as a graceful limit.
  const ceilingState: ToolCeilingState = { total: 0, mutating: 0, stopped: null, pausedMs: 0 };
  // Agentic: the async approval gate (read/local fast-allow, everything else
  // → decideToolApproval → register/surface/await). permissionMode 'default'
  // so non-allowlisted tools reach canUseTool. Non-agentic: deny-only allowlist.
  const baseCanUseTool = agentic
    ? buildGatedToolPermission(options.sessionId as string, allowed)
    : buildAllowOnlyToolsPermission(allowed);
  // ALWAYS wrap (even with the ceiling off) so approval-wait time is metered into
  // pausedMs for the wall-clock; the ceiling COUNTING is what the flag gates.
  const canUseTool = withToolCeiling(baseCanUseTool, allowed, ceilingState, { countCeiling: sdkToolCeilingEnabled() });
  const wallClockMs = options.maxWallClockMs ?? sdkWallClockMs();
  const sdkOptions: ClaudeAgentOptions = {
    env,
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    model: options.modelId ? claudeCliModelArg(options.modelId) : undefined,
    cwd: PKG_DIR,
    persistSession: false,
    settingSources: [],
    skills: [],
    tools: [],
    mcpServers: buildClaudeAgentSdkLocalMcpServers(options.sessionId, agentic, options.mcpToolAllowlist),
    allowedTools: sdkToolNamesForLocalMcp(allowed),
    canUseTool,
    permissionMode: agentic ? 'default' : 'dontAsk',
    maxTurns: options.maxTurns ?? 3,
    // Flip ON only when a delta sink is provided (chat surfaces). Worker/workflow
    // callers omit onDelta → no partial-message traffic → result assembly +
    // error_max_turns handling stay byte-identical.
    includePartialMessages: Boolean(options.onDelta),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.systemAppend,
      excludeDynamicSections: true,
    },
    ...(options.outputSchema ? { outputFormat: { type: 'json_schema', schema: options.outputSchema } } : {}),
  };

  // CHAT multi-turn history: prepend the prior session turns as an authoritative
  // transcript so the stateless SDK lane (persistSession:false) has context. Empty
  // / absent priorTurns → byte-identical bare prompt (worker/workflow path).
  // Volatile per-turn context (Phase 3 #1) rides the USER turn so the stable
  // system append stays cacheable. With neither priorTurns nor turnContext the
  // prompt is byte-identical to the bare worker/workflow path.
  const turnCtx = options.turnContext?.trim();
  let effectivePrompt: string;
  if ((options.priorTurns?.length ?? 0) === 0 && !turnCtx) {
    effectivePrompt = options.prompt;
  } else {
    const parts: string[] = [];
    if (options.priorTurns && options.priorTurns.length > 0) {
      parts.push(`[CONVERSATION SO FAR — prior turns in THIS session; treat as authoritative, do NOT re-ask decisions already made]\n${renderTranscriptTurns(options.priorTurns)}`);
    }
    if (turnCtx) {
      parts.push(`[CURRENT STATE — refreshed THIS turn from your memory and this session's actions; authoritative and newer than anything above]\n${turnCtx}`);
    }
    parts.push(`[Latest message]\n${options.prompt}`);
    effectivePrompt = parts.join('\n\n');
  }

  let result: SDKResultMessage | null = null;
  let init: SDKSystemMessage | null = null;
  let toolUses: string[] = [];
  // Learning OUT (brain continuity). The Agent SDK runs its tool loop OUTSIDE
  // the @openai/agents RunHooks, so the onToolEnd → scheduleReflection path the
  // Codex loop uses (hooks.ts) never fires here. Without this, a Claude
  // brain/worker turn READS memory but never writes facts back — Clementine
  // would stop learning from Claude turns. Re-source the same per-tool-return
  // reflection from the SDK message stream, in-process (where the extractor +
  // memory store live). scheduleReflection dedupes on sessionId::callId and
  // applies the same importance / self-tool / length gates, so this is parity
  // with Codex, not a second pipeline.
  const reflectSessionId = options.sessionId?.trim();
  const reflectLearning = Boolean(reflectSessionId) && claudeSdkReflectionEnabled();
  // Keep the latest assistant text so a turn-budget stop can surface the partial
  // answer (error results carry no `result` field).
  let lastAssistantText = '';
  // The SDK may stream text_delta events and then throw a max-turns error before
  // a full assistant message arrives. Keep those deltas so the durable
  // conversation_completed reply can preserve the partial work. `streamedAny`
  // below still tracks only user-visible chunks (onDelta delivered), because
  // first-byte overload retry is unsafe only after visible output or tool work.
  let streamedText = '';
  // Some Claude Code SDK versions surface a turn-budget stop NOT as a clean
  // `result` message (subtype error_max_turns) but as a THROWN stream error
  // ("Claude Code returned an error result: Reached maximum number of turns (N)").
  // That bypasses the clean-result grace below, so a workflow step hard-failed.
  // Catch it here and fall through to the same limitHit handling.
  let threwTurnLimit = false;
  // Some tools are explicit handoffs. Once Claude has queued background work,
  // continuing the same foreground turn can duplicate the task or answer from
  // an empty foreground context. Stop at the tool boundary and let the outcome
  // report-back re-enter the origin conversation when the daemon finishes.
  let terminalToolReply: string | null = null;
  // FIRST-BYTE-SAFE overload retry: re-run the whole query on an Anthropic
  // overload/5xx ONLY while nothing has been committed yet (no tool executed,
  // nothing streamed to the user) — so a retry can't double-act or duplicate
  // visible output. Once tools run or deltas stream, the error propagates and
  // the caller decides (workflow step re-dispatch / chat turn-boundary switch).
  let streamedAny = false;
  for (let attempt = 0; ; attempt++) {
    result = null;
    init = null;
    toolUses = [];
    lastAssistantText = '';
    streamedText = '';
    streamedAny = false;
    threwTurnLimit = false;
    terminalToolReply = null;
    // Fresh per attempt: an overload retry re-runs the turn from scratch (and only
    // happens pre-commit, so these are ~0 anyway), but reset for correctness.
    ceilingState.total = 0;
    ceilingState.mutating = 0;
    ceilingState.stopped = null;
    ceilingState.pausedMs = 0;
    const startedAt = Date.now();
    const toolById = new Map<string, { name: string; input: unknown }>();
    let stream: Query | undefined;
    try {
      if (options.shouldCancel && await options.shouldCancel()) {
        throw new AgentRuntimeCancelledError('Run cancelled by caller.');
      }
      stream = queryImpl({ prompt: effectivePrompt, options: sdkOptions }) as Query;
      for await (const message of stream) {
        if (options.shouldCancel && await options.shouldCancel()) {
          try { await stream?.interrupt?.(); } catch { /* best-effort */ }
          throw new AgentRuntimeCancelledError('Run cancelled by caller.');
        }
        // Wall-clock backstop: a genuinely stuck stream never hangs the turn. EXCLUDE
        // approval-wait (pausedMs) so a long confirm-first approval — the user may
        // take many minutes — never self-aborts the turn the instant they approve.
        if (wallClockMs > 0 && ceilingState.stopped === null && Date.now() - startedAt - ceilingState.pausedMs > wallClockMs) {
          ceilingState.stopped = 'I hit my time budget for this turn before finishing. Say "continue" and I\'ll pick up where I left off.';
          try { await stream?.interrupt?.(); } catch { /* best-effort; finally closes */ }
          break;
        }
        const nextInit = extractInit(message);
        if (nextInit && !init) {
          init = nextInit;
          assertRequiredLocalMcpTools(options.requiredLocalMcpTools, init.tools ?? []);
        }
        const delta = extractTextDelta(message);
        if (delta) {
          streamedText += delta;
          if (options.onDelta) {
            streamedAny = true;
            try { await options.onDelta(delta); } catch { /* a delta-sink error must never break the run */ }
          }
        }
        const atext = extractAssistantText(message);
        if (atext) lastAssistantText = atext;
        // Tool-call OBSERVABILITY (ungated from reflection): the Claude SDK runs
        // its tool loop OUTSIDE the harness gate chain, so local/authoring tools
        // (goal_create, task_add, memory_remember, …) called on this lane never
        // produced a tool event — a real action (e.g. goal_create writing a goal)
        // was INVISIBLE in the operator view, indistinguishable from a fabricated
        // claim (observed 2026-06-30). Emit a canonical operational event for every
        // tool use/result so the Observability panel shows what Clem actually does,
        // on BOTH lanes (chat brain + workflow step share this runner). Fail-open.
        for (const use of extractToolUseIds(message)) {
          toolById.set(use.id, { name: use.name, input: use.input });
          emitSdkToolCallEvent(options.sessionId, 'tool_call_started', use.id, use.name);
        }
        toolUses.push(...extractAssistantToolUses(message));
        for (const tr of extractToolResults(message)) {
          const source = toolById.get(tr.callId);
          emitSdkToolCallEvent(options.sessionId, tr.isError ? 'tool_call_failed' : 'tool_call_completed', tr.callId, source?.name);
          if (reflectLearning && tr.output) {
            const tool = source ? reflectionToolName(source.name, source.input) : null;
            reflectImpl({ sessionId: reflectSessionId as string, callId: tr.callId, tool, output: tr.output });
          }
          if (!tr.isError && source && isTerminalAfterTool(source.name)) {
            terminalToolReply = renderTerminalToolReply(source.name, source.input, tr.output);
            try { await stream?.interrupt?.(); } catch { /* best-effort */ }
            break;
          }
        }
        if (terminalToolReply) break;
        result = extractResult(message) ?? result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Our OWN interrupt (tool ceiling / wall-clock) may surface as a thrown
      // stream error rather than a clean result — it's a graceful self-stop, not
      // a crash. Route it to the limitHit path below (handled after finally).
      if (ceilingState.stopped !== null) {
        threwTurnLimit = true;
      } else if (/maximum number of turns|error_max_turns|max[_ ]turns/i.test(msg) && result?.subtype !== 'success') {
        threwTurnLimit = true;
      } else if (isProviderOverloadMessage(msg)) {
        const committed = toolUses.length > 0 || streamedAny;
        // Safe first-byte retry: nothing committed yet and budget remains.
        if (overloadRetryEnabled() && !committed && attempt < maxOverloadRetries()) {
          try { stream?.close?.(); } catch { /* ignore */ }
          await sleep(overloadBackoffMs(attempt));
          continue;
        }
        // Give up — surface a TYPED error so a caller that can switch providers
        // re-dispatches when it's safe (committed=false), else surfaces it.
        throw new ClaudeSdkProviderOverloadError(msg, committed);
      } else {
        throw err;
      }
    } finally {
      try { stream?.close?.(); } catch { /* ignore */ }
    }
    // A self-imposed stop (ceiling/wall-clock) that ended the stream WITHOUT a
    // throw (e.g. the SDK honored the interrupt cleanly) still routes to limitHit.
    if (ceilingState.stopped !== null) threwTurnLimit = true;
    break; // success (or a turn-limit / self stop) → leave the retry loop
  }
  // Prefer the self-stop reason (ceiling/wall-clock) over the generic turn-budget
  // copy so the user sees WHY Clem held off.
  const partialLimitText = (): string => ceilingState.stopped ?? bestLimitHitText(lastAssistantText, streamedText);

  if (!init && (options.requiredLocalMcpTools?.length ?? 0) > 0) {
    throw new ClaudeAgentSdkToolSurfaceError(options.requiredLocalMcpTools ?? [], []);
  }

  if (terminalToolReply) {
    recordClaudeAgentSdkUsage(options, result, init);
    return {
      text: terminalToolReply,
      sessionId: result?.session_id ?? init?.session_id,
      model: init?.model,
      toolUses,
      usage: result?.usage,
      modelUsage: result?.modelUsage,
      limitHit: false,
    };
  }

  if (threwTurnLimit) {
    recordClaudeAgentSdkUsage(options, result, init);
    return {
      text: partialLimitText(),
      sessionId: result?.session_id ?? init?.session_id,
      model: init?.model,
      toolUses,
      usage: result?.usage,
      modelUsage: result?.modelUsage,
      limitHit: true,
    };
  }

  if (!result) throw new Error('Claude Agent SDK finished without a result message.');
  if (result.subtype !== 'success') {
    // Long-running parity: a turn-budget stop is NOT a failure. Surface the
    // partial answer + a limitHit flag so the brain can offer "say continue"
    // (mirrors the harness loop's max-turns-with-grace) instead of throwing a
    // raw "Claude Agent SDK failed" error that the caller reports as run_failed.
    if (result.subtype === 'error_max_turns') {
      recordClaudeAgentSdkUsage(options, result, init);
      return {
        text: partialLimitText(),
        sessionId: result.session_id,
        model: init?.model,
        toolUses,
        usage: result.usage,
        modelUsage: result.modelUsage,
        limitHit: true,
      };
    }
    recordClaudeAgentSdkUsage(options, result, init);
    throw new Error(`Claude Agent SDK failed: ${JSON.stringify(result).slice(0, 800)}`);
  }
  recordClaudeAgentSdkUsage(options, result, init);
  return {
    text: bestSuccessText(result.result, lastAssistantText, streamedText),
    structuredOutput: result.structured_output,
    sessionId: result.session_id,
    model: init?.model,
    toolUses,
    usage: result.usage,
    modelUsage: result.modelUsage,
  };
}
