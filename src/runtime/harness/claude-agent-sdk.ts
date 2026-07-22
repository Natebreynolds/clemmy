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
import { deriveSdkProfile } from '../../tools/tool-registry.js';
import { cliBinaryFromCommand } from '../../memory/authoritative-sources.js';
import { scheduleReflection } from '../../memory/reflection.js';
import { mergedSpawnEnv } from '../spawn-env.js';
import { discoverMcpServers } from '../mcp-config.js';
import { resolveMcpToolScope } from '../mcp-tool-scope.js';
import { pinnedCalendarRuleLabels } from './constraint-guard.js';
import type { ManagedMcpServer } from '../../types.js';
import { buildClaudeHeadlessEnv, claudeCliModelArg, resolveClaudeCliPath } from './claude-headless-model.js';
import {
  buildGatedToolPermission,
  type ClaudeAgentApprovalBoundary,
} from './claude-agent-approval.js';
import { renderTranscriptTurns } from './session-transcript.js';
import { recordModelUsage } from '../usage-log.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { appendEvent, listEvents, writeToolOutput } from './eventlog.js';
import { isAuthRecoverableError } from '../../execution/transient-error.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import {
  killGateVerdict,
  grindGateVerdict,
  composeKillAwareShouldCancel,
} from './turn-control.js';
import { classifyRuntimeToolEffect, runtimeToolAccountingMetadata } from './tool-effect.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { extractDuplicateIdentityKeys } from './grounding-gate.js';
import {
  evaluateToolEconomy,
  type ToolEconomyState,
} from './tool-economy.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import type { RunStoppedReason } from '../../types.js';
import { createClementineMcpServer, listClementineMcpToolNames } from '../../tools/mcp-server.js';
import {
  isTerminalToolName,
  terminalToolShouldHalt,
} from './terminal-tool.js';
import { completionEvidenceToolName, toolOutputLooksSuccessful } from './tool-evidence.js';
import { externalMcpScopeFromResolvedTools } from '../../agents/external-mcp-scope-lock.js';
import { recordHarnessCapabilityHealth } from './capability-health.js';
import { resolveToolSurface } from './tool-surface.js';
import { ContentChantDetector, contentChantDetectionEnabled } from './content-chant-detector.js';
import {
  artifactIntentForTool,
  artifactObjectiveForRunScope,
  artifactOutputProvesNoDispatch,
  artifactReuseMessage,
  artifactVerificationIntentForTool,
  bindClaimedArtifact,
  claimArtifactSlot,
  extractArtifactResource,
  markClaimedArtifactUncertain,
  releaseClaimedArtifact,
  resolveArtifactRunScopeId,
  scopeArtifactIntentForObjective,
  verifyArtifactBindingFromToolResult,
  type ArtifactIntent,
  type ArtifactVerificationIntent,
} from './artifact-ledger.js';

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

/** The SDK child ran out of context window (prompt-too-long / context-length
 *  error). No distinct SDK subtype exists — it arrives as a generic
 *  error_during_execution result or a thrown stream error, which previously hit
 *  the raw `throw` and killed the run unsalvaged. `committed` mirrors
 *  ClaudeSdkProviderOverloadError: true ⇒ side effects landed, callers must
 *  salvage (never re-run); false ⇒ one reduced-context retry is safe. */
export class ClaudeSdkContextOverflowError extends Error {
  readonly contextOverflow = true;
  constructor(message: string, readonly committed: boolean) {
    super(message);
    this.name = 'ClaudeSdkContextOverflowError';
  }
}

/** The SDK child's Claude credential is EXPIRED/invalid (401/403, OAuth lapse).
 *  The raw SDK throws this as a generic Error, which no fallover branch would act
 *  on — so an expired token hard-failed the turn/step even with other brains
 *  connected. Typed + committed-aware (mirrors ClaudeSdkProviderOverloadError) so
 *  every lane routes around it: `name` is matched by the shared
 *  isAuthRecoverableError, and `committed=false` (auth fails before any tool runs)
 *  tells a caller it is safe to re-dispatch the WHOLE turn/step on another brain. */
export class ClaudeSdkAuthExpiredError extends Error {
  readonly authExpired = true;
  constructor(message: string, readonly committed: boolean) {
    super(message);
    this.name = 'ClaudeSdkAuthExpiredError';
  }
}

/** Workflow-only control boundary. The SDK query has already been interrupted
 * and closed; the workflow runner converts `pending` into ParkRunSignal, while
 * rejected/expired/cancelled decisions fail the step loudly. */
export class ClaudeAgentSdkApprovalBoundaryError extends Error {
  constructor(readonly boundary: ClaudeAgentApprovalBoundary) {
    const action = boundary.state === 'pending' ? 'is pending' : `was ${boundary.state}`;
    super(`Approval ${boundary.approvalId} ${action} for exact tool payload ${boundary.tool}.`);
    this.name = 'ClaudeAgentSdkApprovalBoundaryError';
  }
}

const CONTEXT_OVERFLOW_RE = /prompt is too long|context (window|length|limit)|input.{0,40}exceeds|exceeds.{0,40}context|too many total (text )?bytes/i;

export function isContextOverflowMessage(msg: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(msg);
}

export class ClaudeAgentSdkToolSurfaceError extends Error {
  readonly missingTools: string[];
  readonly availableTools: string[];
  readonly reason?: string;
  readonly startupTimeoutMs?: number;

  constructor(missingTools: string[], availableTools: string[], opts: { reason?: string; startupTimeoutMs?: number } = {}) {
    super(
      `Claude Agent SDK local MCP surface is missing required tool${missingTools.length === 1 ? '' : 's'}: `
      + `${missingTools.join(', ')}. Available tools: ${availableTools.length ? availableTools.join(', ') : '(none)'}`
      + `${opts.reason ? `. ${opts.reason}` : ''}`,
    );
    this.name = 'ClaudeAgentSdkToolSurfaceError';
    this.missingTools = missingTools;
    this.availableTools = availableTools;
    this.reason = opts.reason;
    this.startupTimeoutMs = opts.startupTimeoutMs;
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
interface ToolCeilingState {
  total: number;
  mutating: number;
  stopped: string | null;
  stoppedKind: 'loop' | 'wallclock' | null;
  /** Completed permission-wait intervals (union, not a sum of overlaps). */
  pausedMs: number;
  activePermissionWaits: number;
  permissionPauseStartedAt: number | null;
}

function effectivePermissionPausedMs(state: ToolCeilingState, now: number): number {
  return state.pausedMs + (
    state.activePermissionWaits > 0 && state.permissionPauseStartedAt !== null
      ? Math.max(0, now - state.permissionPauseStartedAt)
      : 0
  );
}

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
      const effect = classifyRuntimeToolEffect(toolName, input);
      // Concrete behavior wins over name/allowlist membership. The allowlist is
      // retained only as a compatibility fallback for genuinely unknown tools.
      const isRead = effect.effect === 'read' || effect.effect === 'compute'
        || (effect.effect === 'unknown'
          && (fastAllow.has(normalizeToolName(toolName)) || fastAllow.has(normalizeToolName(tail))));
      state.total += 1;
      if (!isRead) state.mutating += 1;
      if (state.mutating > mutCeiling || state.total > totalCeiling) {
        const why = state.mutating > mutCeiling ? `${state.mutating} actions` : `${state.total} tool calls`;
        state.stopped = `I stopped myself after ${why} without finishing — that looked like a loop, so I held off rather than keep going and risk repeating an action. Tell me how you'd like to proceed and I'll pick it back up.`;
        state.stoppedKind = 'loop'; // anti-thrash: auto-continue must NOT re-run this (it just loops again)
        return { behavior: 'deny', message: state.stopped, interrupt: true } as PermissionResult;
      }
    }
    const t0 = Date.now();
    if (state.activePermissionWaits === 0) state.permissionPauseStartedAt = t0;
    state.activePermissionWaits += 1;
    try {
      return await base(toolName, input, options);
    } finally {
      state.activePermissionWaits = Math.max(0, state.activePermissionWaits - 1);
      if (state.activePermissionWaits === 0 && state.permissionPauseStartedAt !== null) {
        state.pausedMs += Math.max(0, Date.now() - state.permissionPauseStartedAt);
        state.permissionPauseStartedAt = null;
      }
    }
  }) as CanUseTool;
}

/** Mount the deterministic read-fanout block on the SDK's canUseTool gate. Native
 *  external MCP tools dispatch INSIDE the SDK — they never reach wrapToolForHarness
 *  (brackets) nor the namespace shim WITH a live harness AsyncLocalStorage context,
 *  so this permission callback is the one harness-controlled point that sees them
 *  (as `mcp__<server>__<tool>`, per the split at line ~220). We register ONLY those
 *  native-external names (local/clementine + composio are already covered by
 *  brackets — evaluating them here would double-count), stripping the SDK's `mcp__`
 *  prefix so the fanout key + the run_tool_program recovery skeleton name the tool
 *  exactly as code mode dispatches it. On a fanout refusal we DENY (interrupt:false)
 *  with the recovery message so the model reads the "write ONE program" steer. */
export function withReadFanoutGuard(base: CanUseTool, sessionId: string | undefined): CanUseTool {
  return (async (toolName, input, options) => {
    if (sessionId && typeof toolName === 'string') {
      // SDK native external MCP name: mcp__<server>__<tool>. Strip the leading
      // mcp__, then require a remaining <server>__<tool> shape that is NOT the
      // in-process clementine-local server (whose tools ride brackets).
      const stripped = toolName.replace(/^mcp__/, '');
      const isNativeExternalMcp = stripped.includes('__') && !/clement/i.test(stripped);
      if (isNativeExternalMcp) {
        try {
          const decision = applyMode(evaluateToolCall(sessionId, stripped, input));
          if (decision.fanoutBlock) {
            try {
              appendEvent({
                sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                data: { kind: 'fanout_block', toolName: decision.toolName, count: decision.count, reason: decision.fanoutBlock, sdk: true },
              });
            } catch { /* telemetry never blocks */ }
            return { behavior: 'deny', message: decision.fanoutBlock, interrupt: false } as PermissionResult;
          }
        } catch { /* the guardrail must never itself break a tool call */ }
      }
    }
    return base(toolName, input, options);
  }) as CanUseTool;
}

// ── SDK tool profiles — DERIVED from the single tool registry ──────────────────
// The hand-maintained profile arrays were deleted; membership + nesting now come
// from deriveSdkProfile(...) over the
// registry's `sdkLayer` field. The per-tool rationale that used to live in these
// comments is now on each registry row. Frozen at module load — tool-registry.ts
// imports nothing (a leaf), so no import cycle forms; a conformance test still pins
// each profile's known-critical members. Names + `readonly string[]` shape are
// preserved so every importer is untouched.
//
// Profiles NEST exactly as the source lists spread into one another:
//   read-only ⊂ authoring;  agentic = the shared execution bundle;
//   worker = read-only ∪ agentic;  full = read-only ∪ authoring ∪ agentic ∪ full-extra.

/** Read-only brain surface (flows into every profile). */
export const CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS: readonly string[] = Object.freeze([...deriveSdkProfile('read-only')]);

/** Local-authoring surface (read-only + local memory/planning/workflow/space authoring). */
export const CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS: readonly string[] = Object.freeze([...deriveSdkProfile('authoring')]);

// The shared mutating execution bundle (formerly AGENTIC_EXECUTION_TOOLS) is no
// longer a standalone constant — FULL and WORKER derive it directly via
// deriveSdkProfile('full') / ('worker'). deriveSdkProfile('agentic') still returns
// the bundle if a future caller needs it.

/** Full agentic surface for the Claude BRAIN: authoring + execution + the gated
 *  mutating surface + brain-only fan-out (run_worker/run_batch) and execution lanes. */
export const CLAUDE_AGENT_SDK_FULL_TOOLS: readonly string[] = Object.freeze([...deriveSdkProfile('full')]);

/** Scoped agentic surface for a Claude WORKER (read-only + the shared execution
 *  bundle; the parent owns the execution lane + batch approval). */
export const CLAUDE_AGENT_SDK_WORKER_TOOLS: readonly string[] = Object.freeze([...deriveSdkProfile('worker')]);

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

/** The authoritative in-process MCP capability surface for a full agentic turn.
 * Kept separate from defaultClaudeAgentSdkAllowedLocalTools(), which is only the
 * permission fast-allow profile. */
const ADVERTISABLE_LOCAL_TOOLS_TTL_MS = 5_000;
let advertisableLocalToolsCache: { at: number; names: string[] } | null = null;
export function claudeAgentSdkAdvertisableLocalTools(): string[] {
  const now = Date.now();
  if (!advertisableLocalToolsCache || now - advertisableLocalToolsCache.at >= ADVERTISABLE_LOCAL_TOOLS_TTL_MS) {
    advertisableLocalToolsCache = {
      at: now,
      names: listClementineMcpToolNames({ gatedMutations: true }),
    };
  }
  return [...advertisableLocalToolsCache.names];
}

export function _resetClaudeAgentSdkAdvertisableLocalToolsForTest(): void {
  advertisableLocalToolsCache = null;
}

function localNodeCommand(): string {
  return process.execPath || 'node';
}

function claudeSdkInProcessMcpEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_SDK_INPROCESS_MCP', 'on') ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

export function buildClaudeAgentSdkLocalMcpServers(
  sessionId?: string,
  gatedMutations = false,
  mcpToolAllowlist?: string[],
  attribution?: { workflowRunId?: string; workflowName?: string; stepId?: string; runScopeId?: string; sourceUserSeq?: number },
  loading?: { alwaysLoadTools?: string[]; deferUnlistedTools?: boolean },
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
  if (claudeSdkInProcessMcpEnabled()) {
    return {
      'clementine-local': {
        type: 'sdk',
        name: 'clementine-local',
        instance: createClementineMcpServer({
          sessionId,
          runScopeId: attribution?.runScopeId,
          sourceUserSeq: attribution?.sourceUserSeq,
          gatedMutations,
          allowedTools: allowlist,
          alwaysLoadTools: loading?.alwaysLoadTools,
          workflowRunId: attribution?.workflowRunId,
          workflowName: attribution?.workflowName,
          stepId: attribution?.stepId,
        }),
      },
    };
  }
  const env = mergedSpawnEnv({
    CLEMENTINE_HOME: BASE_DIR,
    ...(sessionId?.trim() ? { CLEMENTINE_MCP_SESSION_ID: sessionId.trim() } : {}),
    ...(attribution?.runScopeId?.trim() ? { CLEMENTINE_MCP_RUN_SCOPE_ID: attribution.runScopeId.trim() } : {}),
    ...(Number.isSafeInteger(attribution?.sourceUserSeq) && (attribution?.sourceUserSeq ?? 0) > 0
      ? { CLEMENTINE_MCP_SOURCE_USER_SEQ: String(attribution?.sourceUserSeq) }
      : {}),
    ...(gatedMutations ? { CLEMENTINE_MCP_GATED_MUTATIONS: 'on' } : {}),
    ...(allowlist.length > 0 ? { CLEMENTINE_MCP_ALLOWED_TOOLS: allowlist.join(',') } : {}),
    ...((loading?.alwaysLoadTools?.length ?? 0) > 0
      ? { CLEMENTINE_MCP_ALWAYS_LOAD_TOOLS: loading!.alwaysLoadTools!.join(',') }
      : {}),
    ...(attribution?.workflowRunId?.trim() ? { CLEMENTINE_MCP_WORKFLOW_RUN_ID: attribution.workflowRunId.trim() } : {}),
    ...(attribution?.workflowName?.trim() ? { CLEMENTINE_MCP_WORKFLOW_NAME: attribution.workflowName.trim() } : {}),
    ...(attribution?.stepId?.trim() ? { CLEMENTINE_MCP_STEP_ID: attribution.stepId.trim() } : {}),
  });
  if (existsSync(distEntry)) {
    return {
      'clementine-local': {
        type: 'stdio',
        command: localNodeCommand(),
        args: [distEntry],
        env,
        timeout: 10 * 60 * 1000,
        alwaysLoad: loading?.deferUnlistedTools ? false : true,
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
      alwaysLoad: loading?.deferUnlistedTools ? false : true,
    },
  };
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** DEFAULT ON. Attach the user's NATIVE external MCP servers (dataforseo, browsermcp,
 *  supabase, …) to the Claude SDK brain in agentic mode, so it has parity with the
 *  Codex lane instead of being blind to them (a skill saying "use the dataforseo MCP"
 *  used to dead-end on Claude). Off ⇒ prior behavior (local server only). */
function claudeSdkNativeMcpEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CLAUDE_SDK_NATIVE_MCP', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * ToolSearch adoption (SOTA 2026, [[project_2026_harness_sota_gap]]). DEFAULT OFF —
 * model-facing, needs a live smoke before default-on. When ON, the user's EXTERNAL
 * native MCP servers (dataforseo, browsermcp, …) are marked `alwaysLoad: false` so
 * the SDK DEFERS their tool schemas — the model sees them by name and loads the
 * full schema on demand via tool search. Two wins at once: (1) token — those large
 * schemas leave the per-turn prompt; (2) cold-start — a deferred server does NOT
 * block the `claude` child's startup on connect (alwaysLoad servers "must be present
 * when the turn-1 prompt is built"). The LOCAL `clementine-local` core stays
 * alwaysLoad:true (memory/recall/composio_search/notify — the acquisition hatches
 * must never defer), so the brain never loses tool reachability.
 */
export function claudeToolSearchEnabled(): boolean {
  // DEFAULT ON (v1.0): live-validated with ZERO tool-calling regressions — local core
  // tools (memory/recall/composio_search/sf CLI/notify) are alwaysLoad and never
  // defer, and external MCP tools (dataforseo, …) are reachable on demand via tool
  // search in BOTH the chat and workflow lanes. Cuts the per-turn cold-start (deferred
  // servers don't block the claude child's startup) + trims the prompt. =off reverts.
  return (getRuntimeEnv('CLEMMY_CLAUDE_TOOL_SEARCH', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Match a server name against the scope's allowed slugs (mirrors mcp-servers.ts
 *  serverMatchesAllowedSlugs). Empty/undefined slugs ⇒ match all. */
function nativeServerMatchesScope(serverName: string, allowedServerSlugs?: string[]): boolean {
  if (!allowedServerSlugs || allowedServerSlugs.length === 0) return true;
  const name = normalizeToolName(serverName);
  return allowedServerSlugs.some((slug) => {
    const n = normalizeToolName(slug);
    return n.length > 0 && (name === n || name.includes(n) || n.includes(name));
  });
}

function toClaudeSdkMcpConfig(s: ManagedMcpServer): McpServerConfig | null {
  if (s.type === 'stdio' && s.command) {
    return { type: 'stdio', command: s.command, args: s.args ?? [], env: mergedSpawnEnv(s.env ?? {}), timeout: 10 * 60 * 1000 } as McpServerConfig;
  }
  if ((s.type === 'http' || s.type === 'sse') && s.url) {
    return { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) } as McpServerConfig;
  }
  return null;
}

/**
 * The user's NATIVE external MCP servers, SCOPED by the turn's intent (reuses
 * resolveMcpToolScope so an SEO turn attaches dataforseo, a browser turn attaches
 * browsermcp/playwright, etc. — never all of them at once = no bloat). Only used in
 * agentic mode: the SDK's canUseTool gate (buildGatedToolPermission) then covers every
 * native call — dataforseo__* etc. classify as READ (auto-allow) and any native
 * write/unknown classifies as write (approval), so no gate is bypassed. Fail-open → {}.
 */
export function buildScopedNativeMcpServers(
  scopeInput?: string,
  opts: { mode?: 'prompt' | 'resolved_tools' } = {},
): Record<string, McpServerConfig> {
  if (!claudeSdkNativeMcpEnabled()) return {};
  // Empty/absent scope ⇒ we don't know what THIS query needs. For the SDK native
  // lane attach ZERO external servers rather than inheriting resolveMcpToolScope's
  // allowAll default — allowAll cold-starts EVERY external MCP child per query and
  // injects all their tool schemas into the input context (the run_worker /
  // workflow-step over-attach). Callers that need servers pass a concrete scope
  // (brain: request.message; worker: objective+tools; step: prompt). Scoped to
  // this function only — the shared resolveMcpToolScope default is untouched, and
  // the LOCAL in-process clementine server is spread separately (unaffected).
  if (!scopeInput || !scopeInput.trim()) return {};
  try {
    const all = discoverMcpServers().filter((s) => s.enabled);
    if (all.length === 0) return {};
    const scope = opts.mode === 'resolved_tools'
      ? externalMcpScopeFromResolvedTools(scopeInput, all.map((server) => server.name))
      : resolveMcpToolScope({ userInput: scopeInput, pinnedCalendarLabels: pinnedCalendarRuleLabels() });
    if (!scope) return {};
    if (scope.allowAll === false && (scope.allowedServerSlugs ?? []).length === 0) return {};
    const deferExternal = claudeToolSearchEnabled();
    const out: Record<string, McpServerConfig> = {};
    for (const s of all) {
      if (!scope.allowAll && !nativeServerMatchesScope(s.name, scope.allowedServerSlugs)) continue;
      const cfg = toClaudeSdkMcpConfig(s);
      if (!cfg) continue;
      // ToolSearch: defer external server schemas (surface by name, load on demand)
      // → smaller prompt + the server doesn't block the child's startup. The local
      // clementine-local core (built separately) stays alwaysLoad, so acquisition
      // hatches are always present. Default off until live-smoked.
      out[s.name] = deferExternal ? { ...cfg, alwaysLoad: false } as McpServerConfig : cfg;
    }
    return out;
  } catch {
    return {};
  }
}

export function buildAllowOnlyToolsPermission(allowedTools: string[]): CanUseTool {
  const allowed = new Set(allowedTools.map(normalizeToolName).filter(Boolean));
  return async (toolName, input) => {
    const normalized = normalizeToolName(toolName);
    const tail = toolName.split('__').at(-1) ?? toolName;
    if (allowed.has(normalized) || allowed.has(normalizeToolName(tail))) {
      // The CLI's control protocol requires `updatedInput` on allow — a bare
      // allow fails its Zod parse and kills the tool call (see
      // claude-agent-approval.ts, 2026-07-02 task_hygiene incident).
      return { behavior: 'allow', updatedInput: (input ?? {}) as Record<string, unknown> };
    }
    return {
      behavior: 'deny',
      message: `Clementine did not allow Claude Agent SDK tool ${toolName} in this run.`,
      interrupt: false,
    };
  };
}

/** Coarse, cheap bucket for a tool error string so tool_call_failed rows are
 *  groupable in telemetry (auth / timeout / rate-limit / not-found / other). */
function coarseToolErrorClass(msg: string): string {
  const m = msg.toLowerCase();
  if (/\b(401|403|unauthor|invalid_grant|expired|reauth|not authenticat|forbidden)\b/.test(m)) return 'auth';
  if (/\b(timeout|timed out|etimedout|deadline)\b/.test(m)) return 'timeout';
  if (/\b(429|rate.?limit|overloaded|quota)\b/.test(m)) return 'rate_limited';
  if (/\b(404|not found|no such|missing|does not exist)\b/.test(m)) return 'not_found';
  if (/\b(econnreset|econnrefused|network|socket|fetch failed|transport)\b/.test(m)) return 'network';
  if (/\b(400|invalid|validation|schema|bad request|malformed)\b/.test(m)) return 'validation';
  return 'other';
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
      payload: {
        tool: toolName ? mcpToolTail(toolName) : undefined,
        canonicalCallId: callId,
        accounting: 'top_level',
        ...extra,
      },
    });
  } catch { /* observability must never break the SDK run */ }
}

/** Context-compaction signals the SDK's child process relays as stream messages.
 *  The wrapper previously dropped these — a long run could compact (or fail to)
 *  with ZERO harness-visible trace, so "is context holding the model back?" was
 *  unanswerable. Shape per @anthropic-ai/claude-agent-sdk: SDKCompactBoundaryMessage
 *  (subtype 'compact_boundary') and SDKStatusMessage (subtype 'status',
 *  compact_result/'compact_error' on completion). */
function extractCompactionSignal(message: unknown):
  | { kind: 'boundary'; trigger: string; preTokens: number; postTokens: number | null; durationMs: number | null }
  | { kind: 'failed'; error: string }
  | null {
  const m = message as { type?: string; subtype?: string; compact_metadata?: Record<string, unknown>; compact_result?: string; compact_error?: string };
  if (m?.type !== 'system') return null;
  if (m.subtype === 'compact_boundary') {
    const meta = m.compact_metadata ?? {};
    return {
      kind: 'boundary',
      trigger: typeof meta.trigger === 'string' ? meta.trigger : 'auto',
      preTokens: numeric(meta.pre_tokens),
      postTokens: meta.post_tokens === undefined ? null : numeric(meta.post_tokens),
      durationMs: meta.duration_ms === undefined ? null : numeric(meta.duration_ms),
    };
  }
  if (m.subtype === 'status' && m.compact_result === 'failed') {
    return { kind: 'failed', error: m.compact_error ?? 'unknown' };
  }
  return null;
}

/** Log a compaction signal to the session eventlog (mirror of the Codex lane's
 *  condenser_applied) so the operator view can see the SDK managed its context. */
function emitSdkCompactionEvent(sessionId: string | undefined, signal: NonNullable<ReturnType<typeof extractCompactionSignal>>): void {
  if (!sessionId) return;
  try {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: signal.kind === 'boundary' ? 'sdk_compact_boundary' : 'sdk_compact_failed',
      data: signal.kind === 'boundary'
        ? { trigger: signal.trigger, preTokens: signal.preTokens, postTokens: signal.postTokens, durationMs: signal.durationMs, transport: 'claude_agent_sdk' }
        : { error: signal.error, transport: 'claude_agent_sdk' },
    });
  } catch { /* observability must never break the SDK run */ }
}

/** Largest advertised context window across the models this result used —
 *  utilization against it is the "how close to the cliff" health signal. */
function contextWindowFromResult(result: SDKResultMessage | null): number | null {
  const modelUsage = (result as { modelUsage?: Record<string, unknown> } | null)?.modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let max = 0;
  for (const raw of Object.values(modelUsage)) {
    max = Math.max(max, numeric((raw as Record<string, unknown>).contextWindow));
  }
  return max > 0 ? max : null;
}

function mcpToolTail(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName;
}

function sdkToolArgumentsPreview(input: unknown): string {
  try { return JSON.stringify(input ?? {}).slice(0, 8_000); } catch { return String(input ?? '').slice(0, 8_000); }
}

function sdkToolResultPreview(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 400);
  try { return JSON.stringify(output ?? '').slice(0, 400); } catch { return String(output ?? '').slice(0, 400); }
}

function appendSdkTopLevelToolEvent(
  sessionId: string | undefined,
  type: 'tool_called' | 'tool_returned',
  callId: string,
  source: { name: string; input: unknown } | undefined,
  result?: { isError: boolean; output?: unknown },
): void {
  if (!sessionId) return;
  try {
    const name = source?.name ?? '';
    const metadata = runtimeToolAccountingMetadata(name, source?.input);
    appendEvent({
      sessionId,
      turn: 0,
      role: type === 'tool_called' ? 'Clem' : 'tool',
      type,
      data: {
        tool: name ? mcpToolTail(name) : undefined,
        callId,
        canonicalCallId: callId,
        accounting: 'top_level',
        ...(type === 'tool_called' ? {
          correlationFingerprint: toolCallCorrelationFingerprint(name ? mcpToolTail(name) : '', source?.input),
        } : {}),
        effect: metadata.effect,
        ...(metadata.toolSlug ? { toolSlug: metadata.toolSlug } : {}),
        ...(type === 'tool_called' ? { arguments: sdkToolArgumentsPreview(source?.input) } : {}),
        ...(type === 'tool_returned' ? {
          ok: !result?.isError,
          // Keep the canonical row independently useful to semantic readers.
          // The full payload still lives in tool_outputs; this matches the
          // existing bounded transport preview without duplicating the body.
          ...(result?.output !== undefined ? { preview: sdkToolResultPreview(result.output) } : {}),
        } : {}),
      },
    });
  } catch { /* progress/accounting must never break the stream */ }
}

interface NativeExternalWriteAttempt {
  callId: string;
  toolName: string;
  shapeKey: string;
  targets: string[];
}

function nativeExternalWriteAttempt(toolName: string, input: unknown, callId: string): NativeExternalWriteAttempt | null {
  const effect = classifyRuntimeToolEffect(toolName, input);
  if (effect.source !== 'native_mcp' || effect.effect !== 'external_write') return null;
  const shape = classifyExternalWrite(toolName, input);
  return {
    callId,
    toolName,
    shapeKey: shape.shapeKey ?? toolName.replace(/^mcp__/, ''),
    targets: extractDuplicateIdentityKeys(input).slice(0, 8),
  };
}

function appendNativeExternalWriteEvent(
  sessionId: string | undefined,
  attempt: NativeExternalWriteAttempt,
  type: 'external_write' | 'external_write_failed' | 'external_write_orphaned',
  extra: Record<string, unknown> = {},
): void {
  if (!sessionId) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type,
      data: {
        shapeKey: attempt.shapeKey,
        toolName: attempt.toolName,
        targets: attempt.targets,
        callId: attempt.callId,
        canonicalCallId: attempt.callId,
        nativeMcp: true,
        ...extra,
      },
    });
  } catch { /* durable safety telemetry fails conservative via artifact claim */ }
}

function sdkPreapprovedToolsForMode(tools: string[], agentic: boolean): string[] {
  void tools;
  void agentic;
  // Do not put local MCP tools in `allowedTools` while `canUseTool` is installed:
  // the Claude SDK treats bare allowedTools entries as pre-approved and skips
  // canUseTool for those calls. Clementine's callback is the single permission
  // authority; non-agentic runs shrink the advertised schema surface with the
  // local MCP server allowlist instead of SDK preapproval.
  return [];
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

const BASELINE_LOCAL_MCP_TOOLS = new Set(['ping', 'memory_recall_all', 'memory_search', 'memory_read', 'workspace_roots', 'list_files', 'read_file', 'workspace_artifact_query']);

function localMcpSurfaceInitialized(advertisedTools: string[]): boolean {
  return advertisedTools.some((toolName) => BASELINE_LOCAL_MCP_TOOLS.has(mcpToolTail(toolName)));
}

const CLAUDE_SDK_LOCAL_MCP_SURFACE_CAPABILITY = 'claude_sdk_local_mcp_surface';

function recordClaudeSdkLocalMcpSurfaceHealth(
  options: ClaudeAgentSdkRunOptions,
  state: 'healthy' | 'degraded' | 'unavailable',
  input: {
    advertisedTools: string[];
    missingTools?: string[];
    reason?: string | null;
    startupTimeoutMs?: number;
  },
): void {
  const requiredTools = requiredLocalMcpTools(options);
  if (requiredTools.length === 0) return;
  try {
    const missingTools = input.missingTools ?? [];
    recordHarnessCapabilityHealth({
      id: CLAUDE_SDK_LOCAL_MCP_SURFACE_CAPABILITY,
      state,
      summary: state === 'healthy'
        ? 'Claude SDK local MCP surface advertised the required local tools.'
        : 'Claude SDK local MCP surface did not advertise tools the harness depends on.',
      reason: input.reason
        ?? (missingTools.length ? `missing required local MCP tool${missingTools.length === 1 ? '' : 's'}: ${missingTools.join(', ')}` : null),
      sessionId: options.sessionId,
      details: {
        modelId: options.modelId ?? null,
        agentic: Boolean(options.agentic),
        requiredTools,
        missingTools,
        availableToolCount: input.advertisedTools.length,
        availableTools: input.advertisedTools.slice(0, 120),
        ...(input.startupTimeoutMs !== undefined ? { startupTimeoutMs: input.startupTimeoutMs } : {}),
      },
    });
  } catch {
    // Health recording must never affect model execution or fallover.
  }
}

function recordClaudeSdkToolSurfaceError(options: ClaudeAgentSdkRunOptions, err: ClaudeAgentSdkToolSurfaceError): void {
  const state = localMcpSurfaceInitialized(err.availableTools) ? 'degraded' : 'unavailable';
  recordClaudeSdkLocalMcpSurfaceHealth(options, state, {
    advertisedTools: err.availableTools,
    missingTools: err.missingTools,
    reason: err.reason,
    startupTimeoutMs: err.startupTimeoutMs,
  });
}

function maxToolSurfaceRetries(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_TOOL_SURFACE_RETRIES', '3') || '3', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

function maxToolSurfaceStartupRetries(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_TOOL_SURFACE_STARTUP_RETRIES', '1') || '1', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

function toolSurfaceBackoffMs(attempt: number): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_CLAUDE_SDK_TOOL_SURFACE_BACKOFF_MS', '') || '', 10);
  const base = Number.isFinite(raw) && raw >= 0 ? raw : 750;
  return Math.min(5000, base * Math.max(1, attempt + 1));
}

function toolSurfaceFirstMessageMs(): number {
  const raw = (getRuntimeEnv('CLEMMY_CLAUDE_SDK_TOOL_SURFACE_FIRST_MESSAGE_MS', '') ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
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
  /** Workflow-step attribution: when set, a fan-out (run_worker) spawned inside this
   *  run is recorded under the workflow RUN in the subagent-runs store (else session). */
  workflowRunId?: string;
  workflowName?: string;
  stepId?: string;
  /**
   * The user's message/intent for THIS turn, used to SCOPE which native external MCP
   * servers (dataforseo, browsermcp, …) attach — so the Claude brain reaches those
   * capabilities like the Codex lane instead of being blind to them. Only honored in
   * agentic mode (the canUseTool gate covers native calls). Absent ⇒ no native attach.
   */
  nativeMcpScopeInput?: string;
  /** Interpret nativeMcpScopeInput as exact worker-packet resolvedTools instead
   *  of a free-form prompt. This disables fail-open for "none needed" workers. */
  nativeMcpScopeMode?: 'prompt' | 'resolved_tools';
  /** Mount the deterministic read-fanout block on this run's canUseTool gate —
   *  native external MCP tools dispatch INSIDE the SDK (outside wrapToolForHarness
   *  and outside the harness AsyncLocalStorage), so canUseTool is the only harness
   *  chokepoint that sees them. Set ONLY for the orchestrator brain lane, where
   *  run_tool_program (the recovery the refusal steers to) exists; workers/steps
   *  leave it off so a refusal never strands a run with no recovery. */
  readFanoutGuard?: boolean;
  /** Stable, isolated loop-guard identity for this logical run/attempt. The
   *  real sessionId remains approval/kill/event authority. Workers pass a
   *  packet-derived scope; workflow steps derive run+step; chat derives the
   *  durable user-input event. */
  trackerScopeId?: string;
  /** Exact accepted user event owned by this run attempt. Turn preflight uses
   * this instead of session-global latest-user state. */
  sourceUserSeq?: number;
  /** Durable artifact root. Unlike trackerScopeId, this may intentionally span
   * a manual continue/restart/fallback while guardrail counters start fresh. */
  artifactRunScopeId?: string;
  /** Original user objective used only to distinguish an explicitly requested
   * multi-document/site deliverable from a renamed retry. */
  artifactObjective?: string;
  /** Enforcement mode for the bounded post-create repair query. When present,
   * canUseTool permits only exact-id read-backs for these resources. */
  artifactVerificationOnly?: Array<Pick<ArtifactVerificationIntent, 'kind' | 'resourceId'>>;
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
  /** Workflow-only. Interrupt and return control to the durable workflow park
   * machinery instead of keeping query()/the MCP child alive while a human waits. */
  approvalMode?: 'wait' | 'park';
  /** Caller-driven cancellation hook (background task cancel/deadline). */
  shouldCancel?: () => boolean | Promise<boolean>;
  /** Optional logical-run economy shared by every corrective/limit
   * continuation of an interactive brain turn. Provider toolUseID values make
   * permission replays free; background/workflow callers intentionally omit it. */
  toolEconomyState?: ToolEconomyState;
  /** Test/embedding override; production defaults to one visible tick/minute. */
  livenessHeartbeatMs?: number;
}

export interface ClaudeAgentSdkRunResult {
  text: string;
  structuredOutput?: unknown;
  sessionId?: string;
  model?: string;
  toolUses: string[];
  successfulToolUses?: string[];
  usage?: unknown;
  modelUsage?: unknown;
  /** Present only after a create/exact-id verification caused durable artifact
   * lineage to exist. Ordinary SDK turns leave this absent. */
  artifactRunScopeId?: string;
  /** True when the run stopped because it hit the turn budget (error_max_turns)
   *  rather than finishing. The caller surfaces a graceful "say continue" instead
   *  of a hard error — parity with the harness loop's auto-continue-on-limit. */
  limitHit?: boolean;
  /** True ONLY for the anti-thrash tool-ceiling self-stop (looked-like-a-loop).
   *  Distinct from a benign wall-clock/max-turns limitHit so auto-continue loops
   *  can EXCLUDE it — re-running a loop-stop just loops again (the 33-shell-call /
   *  3-duplicate-email incident the ceiling exists to stop). */
  selfStopped?: boolean;
  /** Typed stop reason for non-successful-but-non-error terminal states. */
  stoppedReason?: RunStoppedReason;
  /** A3 recall ledger: every tool call this run with its callId, so an
   *  auto-continue (fresh context — tool RESULTS are lost) can pull earlier
   *  results via tool_output_query(callId) instead of re-fetching. */
  toolCallLedger?: Array<{ callId: string; name: string; argsPreview: string }>;
}

/**
 * Stable guardrail identity for one logical SDK run. Unlike the former
 * Date.now()+Math.random scope, this survives safe retries and daemon resume:
 * workflow work keys by durable run+step, workers provide a packet key, and a
 * chat turn keys by its durable user_input_received event.
 */
export function resolveClaudeAgentSdkTrackerScope(
  options: Pick<ClaudeAgentSdkRunOptions, 'sessionId' | 'trackerScopeId' | 'workflowRunId' | 'stepId'>,
): string | undefined {
  const explicit = options.trackerScopeId?.trim();
  if (explicit) return explicit;
  const sessionId = options.sessionId?.trim();
  if (!sessionId) return undefined;
  if (options.workflowRunId?.trim()) {
    return `${sessionId}::workflow:${options.workflowRunId.trim()}:${options.stepId?.trim() || 'step'}`;
  }
  try {
    const inputEvent = listEvents(sessionId, { types: ['user_input_received'], limit: 1, desc: true })[0];
    if (inputEvent?.id) return `${sessionId}::claude:${inputEvent.id}`;
  } catch { /* a missing eventlog must not prevent a run */ }
  // Stable fallback for out-of-band SDK callers/tests. It deliberately favors
  // surviving restart over silently resetting a runaway counter.
  return `${sessionId}::claude`;
}

function extractAssistantToolUses(message: SDKMessage, seenCallIds?: Set<string>): string[] {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; id?: unknown; name?: unknown };
    if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    if (typeof b.id === 'string' && seenCallIds) {
      if (seenCallIds.has(b.id)) continue;
      seenCallIds.add(b.id);
    }
    out.push(b.name);
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

function isTerminalAfterTool(rawName: string | null | undefined): boolean {
  return isTerminalToolName(rawName);
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

function terminalToolStoppedReason(rawName: string): RunStoppedReason | undefined {
  return bareMcpToolName(rawName) === 'ask_user_question' ? 'awaiting-input' : undefined;
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
  timing?: { firstByteMs: number | null },
): void {
  try {
    const totals = usageTotalsFromResult(result);
    if (!totals) return;
    const responseId = (result as { uuid?: unknown } | null)?.uuid;
    const providerApiDurationMs = (result as { duration_api_ms?: unknown } | null)?.duration_api_ms;
    const contextWindowTokens = contextWindowFromResult(result);
    recordModelUsage({
      sessionId: options.sessionId?.trim() || result?.session_id || init?.session_id || 'unknown',
      model: init?.model || options.modelId || 'claude-agent-sdk',
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      durationMs: numeric((result as { duration_ms?: unknown } | null)?.duration_ms),
      ...(typeof providerApiDurationMs === 'number' && Number.isFinite(providerApiDurationMs) ? { providerApiDurationMs } : {}),
      responseId: typeof responseId === 'string' ? responseId : undefined,
      ...(timing && timing.firstByteMs !== null ? { firstByteMs: timing.firstByteMs } : {}),
      ...(contextWindowTokens
        ? {
            contextWindowTokens,
            windowUtilization: Math.round((totals.inputTokens / contextWindowTokens) * 1000) / 1000,
          }
        : {}),
    });
    // Eventlog copy of the prompt-prefix cache-hit ratio so it's scoreable PER
    // SESSION on the default brain lane (mirrors the sdk_first_byte TTFT copy).
    // The usage-log carries the raw cache tokens, but the freeze-stable-prefix
    // lever is invisible without a per-turn hit-rate to watch move (2026-07-09).
    if (options.sessionId?.trim() && totals.inputTokens > 0) {
      appendEvent({
        sessionId: options.sessionId.trim(),
        turn: 0,
        role: 'system',
        type: 'sdk_cache',
        data: {
          cacheHitRatio: Math.round((totals.cachedInputTokens / totals.inputTokens) * 1000) / 1000,
          cachedInputTokens: totals.cachedInputTokens,
          inputTokens: totals.inputTokens,
        },
      });
    }
  } catch { /* observability must never break the SDK lane */ }
}

function requiredLocalMcpTools(options: ClaudeAgentSdkRunOptions): string[] {
  return [...new Set((options.requiredLocalMcpTools ?? []).map((t) => t.trim()).filter(Boolean))];
}

function emitToolSurfaceRetryEvent(
  options: ClaudeAgentSdkRunOptions,
  err: ClaudeAgentSdkToolSurfaceError,
  attempt: number,
  maxRetries: number,
): void {
  if (!options.sessionId) return;
  try {
    appendEvent({
      sessionId: options.sessionId,
      turn: 0,
      role: 'system',
      type: 'sdk_tool_surface_retry',
      data: {
        attempt: attempt + 1,
        maxRetries,
        missingTools: err.missingTools,
        availableToolCount: err.availableTools.length,
        startupTimeoutMs: err.startupTimeoutMs ?? null,
        reason: err.reason ?? 'missing_required_tools',
      },
    });
  } catch { /* retry telemetry must never break the SDK lane */ }
}

async function nextSdkMessageWithRuntimeTicks(
  iterator: AsyncIterator<SDKMessage>,
  options: ClaudeAgentSdkRunOptions,
  startupTimeoutMs: number,
  tickMs: number,
  onTick: () => Promise<'continue' | 'stop'>,
): Promise<IteratorResult<SDKMessage>> {
  const pending = iterator.next();
  const required = requiredLocalMcpTools(options);
  const startedAt = Date.now();
  while (true) {
    const startupRemaining = startupTimeoutMs > 0 && required.length > 0
      ? Math.max(0, startupTimeoutMs - (Date.now() - startedAt))
      : Number.POSITIVE_INFINITY;
    if (startupRemaining === 0) {
      throw new ClaudeAgentSdkToolSurfaceError(required, [], {
        startupTimeoutMs,
        reason: `No SDK init message arrived within ${startupTimeoutMs}ms; local MCP startup did not advertise tools in time.`,
      });
    }
    const waitMs = Math.min(
      tickMs > 0 ? tickMs : Number.POSITIVE_INFINITY,
      startupRemaining,
    );
    if (!Number.isFinite(waitMs)) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await new Promise<
      | { kind: 'message'; value: IteratorResult<SDKMessage> }
      | { kind: 'tick' }
    >((resolve, reject) => {
      timer = setTimeout(() => resolve({ kind: 'tick' }), Math.max(1, waitMs));
      pending.then(
        (value) => resolve({ kind: 'message', value }),
        reject,
      );
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (winner.kind === 'message') return winner.value;
    if (startupRemaining <= waitMs && startupTimeoutMs > 0 && required.length > 0) {
      throw new ClaudeAgentSdkToolSurfaceError(required, [], {
        startupTimeoutMs,
        reason: `No SDK init message arrived within ${startupTimeoutMs}ms; local MCP startup did not advertise tools in time.`,
      });
    }
    if (await onTick() === 'stop') return { done: true, value: undefined };
  }
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
  // The local MCP server imports the whole harness (~13s cold boot measured on
  // the packaged app; worse under load) — the CLI's default MCP startup window
  // is ~30s, and missing it silently strips ALL local tools from the turn (the
  // live 2026-07-01 'only SEO tools' incidents). Give startup a real budget;
  // per-call timeouts still come from the server config's own `timeout`.
  if (!env.MCP_TIMEOUT) env.MCP_TIMEOUT = '120000';
  const allowed = options.allowedLocalMcpTools ?? defaultClaudeAgentSdkAllowedLocalTools();
  // Agentic lane requires a session id (the gate chain + approval read/write the
  // session's event log). Without one, fall back to the read-only allowlist.
  const agentic = Boolean(options.agentic && options.sessionId?.trim());
  const trackerScopeId = resolveClaudeAgentSdkTrackerScope(options);
  // Artifact lineage is intentionally LAZY. Ordinary reads/chats must not mint
  // artifact_source_roots/run_scopes merely because the SDK lane initialized.
  // `options.artifactRunScopeId` is an attempt/candidate scope until the first
  // create or exact-id verification proves artifact work exists.
  let resolvedArtifactRunScopeId: string | undefined;
  const ensureArtifactRunScopeId = (): string | undefined => {
    if (!options.sessionId) return undefined;
    if (!resolvedArtifactRunScopeId) {
      resolvedArtifactRunScopeId = resolveArtifactRunScopeId(
        options.sessionId,
        options.artifactRunScopeId?.trim() || trackerScopeId || options.sessionId,
        options.sourceUserSeq,
      );
    }
    return resolvedArtifactRunScopeId;
  };
  const artifactObjective = (runScopeId: string): string => options.artifactObjective?.trim()
    || (options.sessionId ? artifactObjectiveForRunScope(options.sessionId, runScopeId) : '')
    || options.prompt;
  const nativeArtifactClaims = new Map<string, { artifactId: string; intent: ArtifactIntent }>();
  const nativeExternalWrites = new Map<string, NativeExternalWriteAttempt>();
  const nativePermissionResults = new Map<string, { signature: string; result: PermissionResult | null }>();
  const nativePermissionInFlight = new Map<string, {
    signature: string;
    promise: Promise<PermissionResult | null>;
  }>();
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
  const ceilingState: ToolCeilingState = {
    total: 0,
    mutating: 0,
    stopped: null,
    stoppedKind: null,
    pausedMs: 0,
    activePermissionWaits: 0,
    permissionPauseStartedAt: null,
  };
  // TURN-CONTROL SPINE: the SDK polls shouldCancel before start and after
  // EVERY stream message — OR-ing the kill switch in gives the whole query
  // message-boundary kill coverage (the incident's 33-min run was unkillable
  // because nothing on this lane ever read the kill row).
  const effectiveShouldCancel = options.sessionId
    ? composeKillAwareShouldCancel(
        options.sessionId as string,
        options.shouldCancel,
        options.sourceUserSeq ? { sourceUserSeq: options.sourceUserSeq } : undefined,
      )
    : options.shouldCancel;
  let approvalBoundary: ClaudeAgentApprovalBoundary | null = null;
  // Agentic: the async approval gate (read/local fast-allow, everything else
  // → decideToolApproval → register/surface/await). permissionMode 'default'
  // so non-allowlisted tools reach canUseTool. Non-agentic: deny-only allowlist.
  const baseCanUseTool = agentic
    ? buildGatedToolPermission(options.sessionId as string, allowed, {
        approvalMode: options.approvalMode,
        onApprovalBoundary: (boundary) => { approvalBoundary = boundary; },
      })
    : buildAllowOnlyToolsPermission(allowed);
  // ALWAYS wrap (even with the ceiling off) so approval-wait time is metered into
  // pausedMs for the wall-clock; the ceiling COUNTING is what the flag gates.
  const ceilingGated = withToolCeiling(baseCanUseTool, allowed, ceilingState, { countCeiling: sdkToolCeilingEnabled() });
  // TURN-CONTROL SPINE (2026-07-16 unkillable-run incident): canUseTool is the
  // one gate EVERY tool tier passes through and the only reliable in-loop stop.
  //  - Kill switch: checked for ALL tools (desktop/Discord stop finally works
  //    on the default brain lane).
  //  - Grind ladder for NATIVE-EXTERNAL tools: block/halt/escalate were being
  //    evaluated (by withReadFanoutGuard) then silently DISCARDED — now
  //    enforced. This wrapper REPLACES withReadFanoutGuard so each call is
  //    evaluated exactly once (stacking both would halve every threshold);
  //    the fanout refuse-and-steer verdict is honored only when the caller
  //    opted in (its recovery skeleton needs run_tool_program — workers/steps
  //    lack it). Local gated tools already ride the full ladder via
  //    wrapToolForHarness; local reads ride the ambient counter. No double-count.
  const canUseTool: CanUseTool = (async (toolName, input, opts) => {
    const kill = killGateVerdict(
      options.sessionId,
      options.sourceUserSeq ? { sourceUserSeq: options.sourceUserSeq } : undefined,
    );
    if (kill) return kill as PermissionResult;
    const providerCallId = typeof opts.toolUseID === 'string' && opts.toolUseID.trim()
      ? opts.toolUseID.trim()
      : '';
    let permissionSignature = '';
    try { permissionSignature = `${toolName}\0${JSON.stringify(input ?? {})}`; } catch { permissionSignature = `${toolName}\0${String(input)}`; }
    if (providerCallId) {
      const cached = nativePermissionResults.get(providerCallId);
      if (cached) {
        if (cached.signature === permissionSignature) return cached.result;
        return {
          behavior: 'deny',
          interrupt: true,
          message: `Provider call id ${providerCallId} was reused for a different tool action. The turn was stopped rather than mis-correlate a mutation.`,
        } as PermissionResult;
      }
      const inFlight = nativePermissionInFlight.get(providerCallId);
      if (inFlight) {
        if (inFlight.signature === permissionSignature) return inFlight.promise;
        return {
          behavior: 'deny',
          interrupt: true,
          message: `Provider call id ${providerCallId} was reused for a different tool action. The turn was stopped rather than mis-correlate an in-flight mutation.`,
        } as PermissionResult;
      }
    }
    const evaluatePermission = async (): Promise<PermissionResult | null> => {
      if (options.artifactVerificationOnly) {
        const verification = artifactVerificationIntentForTool(toolName, input);
        const exactAllowed = Boolean(verification && options.artifactVerificationOnly.some(
          (allowed) => allowed.kind === verification.kind && allowed.resourceId === verification.resourceId,
        ));
        if (!exactAllowed) {
          return {
            behavior: 'deny',
            interrupt: false,
            message: 'This bounded repair phase permits only an exact provider read-back of the already-bound document/site id. Create, update, list, search, shell exploration, and unrelated tools are blocked.',
          } as PermissionResult;
        }
      }

      let nativeExternal = false;
      let strippedToolName = typeof toolName === 'string' ? toolName.replace(/^mcp__/, '') : '';
      if (typeof toolName === 'string' && options.sessionId) {
        strippedToolName = toolName.replace(/^mcp__/, '');
        nativeExternal = strippedToolName.includes('__') && !/clement/i.test(strippedToolName);
      }

      // A durable artifact slot is admission authority, not an attempted tool
      // call. Claim it before economy/grind/ceiling/approval so an existing
      // document/site returns its reuse pointer without consuming budgets,
      // mutating loop state, or surfacing an approval for work we will refuse.
      let artifactAdmission: { artifactId: string; intent: ArtifactIntent } | undefined;
      if (nativeExternal && options.sessionId) {
        const rawIntent = artifactIntentForTool(strippedToolName, input);
        const artifactRunScopeId = rawIntent ? ensureArtifactRunScopeId() : undefined;
        if (rawIntent && artifactRunScopeId) {
          const intent = scopeArtifactIntentForObjective(rawIntent, artifactObjective(artifactRunScopeId), input);
          const claim = claimArtifactSlot(options.sessionId, intent, providerCallId || undefined, artifactRunScopeId);
          if (!claim.acquired) {
            return { behavior: 'deny', message: artifactReuseMessage(claim.artifact), interrupt: false } as PermissionResult;
          }
          artifactAdmission = { artifactId: claim.artifact.id, intent };
        }
      }

      let admittedForDispatch = false;
      try {
        if (options.toolEconomyState) {
          const economy = evaluateToolEconomy({
            state: options.toolEconomyState,
            toolName,
            args: input,
            callId: opts.toolUseID,
          });
          if (economy) {
            if (!economy.replayed) {
              try {
                appendEvent({
                  sessionId: options.sessionId as string,
                  turn: 0,
                  role: 'system',
                  type: 'guardrail_tripped',
                  data: {
                    kind: economy.kind === 'hard_stop' ? 'tool_economy_hard_stop' : 'tool_economy_finish_phase',
                    reason: economy.message,
                    attempt: economy.attempt,
                    policy: economy.policy.kind,
                    softLimit: economy.policy.softLimit,
                    hardLimit: economy.policy.hardLimit,
                    toolName,
                    canonicalCallId: opts.toolUseID,
                  },
                });
              } catch { /* economy enforcement must not depend on telemetry */ }
            }
            if (economy.interrupt) {
              // `stopped` becomes the user-visible reply when the turn ends
              // (partialLimitText). The economy's message is a MODEL-facing
              // directive ("do not make another exploratory call") — leaking
              // it verbatim into the chat reads as broken internal steering
              // (live 2026-07-21). Latch first-person user text instead; the
              // model still receives the directive via the deny message below.
              ceilingState.stopped =
                'I stopped myself after using up my tool budget for this reply while still exploring — '
                + 'rather than keep burning calls, I held on to what I\'ve already gathered. '
                + 'Say "continue" and I\'ll finish from that evidence, or hand this to a background task for the rest.';
              ceilingState.stoppedKind = 'loop';
            }
            return {
              behavior: 'deny',
              message: economy.message,
              interrupt: economy.interrupt,
            } as PermissionResult;
          }
        }

        if (nativeExternal && options.sessionId) {
          const grind = grindGateVerdict(options.sessionId, strippedToolName, input, {
            trackerScopeId,
            honorFanout: Boolean(options.readFanoutGuard),
          });
          if (grind) {
            return { behavior: 'deny', message: grind.message, interrupt: grind.interrupt } as PermissionResult;
          }
        }

        const permission = await ceilingGated(toolName, input, opts);
        if (permission?.behavior !== 'allow') return permission;

        if (artifactAdmission) {
          if (providerCallId) nativeArtifactClaims.set(providerCallId, artifactAdmission);
          else markClaimedArtifactUncertain(artifactAdmission.artifactId);
        }
        if (nativeExternal && options.sessionId && providerCallId) {
          const write = nativeExternalWriteAttempt(toolName, input, providerCallId);
          if (write && !nativeExternalWrites.has(providerCallId)) {
            nativeExternalWrites.set(providerCallId, write);
            appendNativeExternalWriteEvent(options.sessionId, write, 'external_write', {
              irreversible: classifyExternalWrite(toolName, input).irreversible,
            });
          }
        }
        admittedForDispatch = true;
        return permission;
      } finally {
        // Every post-admission deny/throw is provably pre-dispatch: canUseTool
        // has not returned allow yet. Release only the exact call-owned pending
        // row. Ledger failure keeps it pending (the conservative direction).
        if (!admittedForDispatch && artifactAdmission) {
          if (providerCallId) nativeArtifactClaims.delete(providerCallId);
          try { releaseClaimedArtifact(artifactAdmission.artifactId, providerCallId || undefined); } catch { /* pending claim remains fail-closed */ }
        }
      }
    };

    const permissionPromise = evaluatePermission();
    if (providerCallId) {
      nativePermissionInFlight.set(providerCallId, { signature: permissionSignature, promise: permissionPromise });
    }
    try {
      const permission = await permissionPromise;
      if (providerCallId) nativePermissionResults.set(providerCallId, { signature: permissionSignature, result: permission });
      return permission;
    } finally {
      if (providerCallId && nativePermissionInFlight.get(providerCallId)?.promise === permissionPromise) {
        nativePermissionInFlight.delete(providerCallId);
      }
    }
  }) as CanUseTool;
  const wallClockMs = options.maxWallClockMs ?? sdkWallClockMs();
  // When Claude's native ToolSearch is active, a reduced JIT surface should not
  // make every other local capability disappear. Register the full agentic MCP
  // surface, mark the exact former JIT subset first-class, and leave the rest
  // registered-but-deferred for same-turn acquisition. If JIT did not reduce the
  // surface (or this is a deny-only worker/read lane), preserve prior behavior.
  const useLocalDeferredAcquisition = Boolean(
    agentic
    && claudeToolSearchEnabled()
    && options.mcpToolAllowlist
    && options.mcpToolAllowlist.length > 0,
  );
  let localMcpToolAllowlist = options.mcpToolAllowlist ?? (agentic ? undefined : allowed);
  let localMcpLoading: { alwaysLoadTools?: string[]; deferUnlistedTools?: boolean } | undefined;
  if (useLocalDeferredAcquisition) {
    const localSurface = resolveToolSurface({
      surface: 'claude_agent_sdk_local_mcp',
      lane: 'brain',
      availableNames: claudeAgentSdkAdvertisableLocalTools(),
      alwaysLoadedNames: [
        ...(options.mcpToolAllowlist ?? []),
        ...(options.requiredLocalMcpTools ?? []),
      ],
      deferralEnabled: true,
      reason: 'Claude native local ToolSearch acquisition',
    });
    localMcpToolAllowlist = undefined;
    localMcpLoading = {
      alwaysLoadTools: localSurface.firstClass,
      deferUnlistedTools: true,
    };
  }
  const runScopeId = trackerScopeId;
  const sdkOptions: ClaudeAgentOptions = {
    env,
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    model: options.modelId ? claudeCliModelArg(options.modelId) : undefined,
    cwd: PKG_DIR,
    persistSession: false,
    settingSources: [],
    skills: [],
    tools: [],
    mcpServers: {
      ...buildClaudeAgentSdkLocalMcpServers(options.sessionId, agentic, localMcpToolAllowlist, {
        workflowRunId: options.workflowRunId,
        workflowName: options.workflowName,
        stepId: options.stepId,
        runScopeId,
        sourceUserSeq: options.sourceUserSeq,
      }, localMcpLoading),
      // Native external MCP servers (scoped by intent), ONLY in agentic mode — the
      // canUseTool gate then covers every native call. Gives the Claude brain parity
      // with the Codex lane instead of being blind to native MCPs.
      ...(agentic ? buildScopedNativeMcpServers(options.nativeMcpScopeInput, { mode: options.nativeMcpScopeMode }) : {}),
    },
    // Keep SDK preapproval empty for both modes. Non-agentic runs use the local
    // MCP allowlist above to advertise only read/local schemas, then the same
    // canUseTool path enforces the deny-only allowlist and loop ceilings.
    allowedTools: sdkPreapprovedToolsForMode(allowed, agentic),
    canUseTool,
    permissionMode: 'default',
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
    // With settingSources:[] no user/project settings load, so auto-compaction
    // was default-dependent. Pin it ON explicitly via the plain `settings`
    // tier (equivalent to --settings): long agentic runs must compact rather
    // than die at the context cliff. NOT managedSettings — that policy tier is
    // filtered restrictive-only and silently DROPS non-restrictive keys like
    // autoCompactEnabled (review finding: the pin never took effect there).
    settings: { autoCompactEnabled: true },
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
  let successfulToolUses: string[] = [];
  const toolCallLedger: Array<{ callId: string; name: string; argsPreview: string }> = [];
  // WS5-L2: child-process spawn → first stream message. THE cold-start metric —
  // the SDK spawns a fresh `claude` process per query(), and this is the only
  // place that latency is observable. Latest attempt wins (that one produced the result).
  let firstByteMs: number | null = null;
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
  // Content-chanting advisory (2026-07-20): one detector per query run.
  const chantDetector = contentChantDetectionEnabled() ? new ContentChantDetector() : null;
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
  let terminalToolReason: RunStoppedReason | undefined;
  // FIRST-BYTE-SAFE overload retry: re-run the whole query on an Anthropic
  // overload/5xx ONLY while nothing has been committed yet (no tool executed,
  // nothing streamed to the user) — so a retry can't double-act or duplicate
  // visible output. Once tools run or deltas stream, the error propagates and
  // the caller decides (workflow step re-dispatch / chat turn-boundary switch).
  let streamedAny = false;
  // The SDK may replay a full assistant/user message around stream boundaries.
  // Canonical accounting is keyed by the provider's tool_use id, not message
  // count, so every logical call has exactly one start and one completion row.
  const seenTopLevelToolCallIds = new Set<string>();
  const seenTopLevelToolReturnIds = new Set<string>();
  const seenReturnedToolCallIds = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    result = null;
    init = null;
    toolUses = [];
    successfulToolUses = [];
    toolCallLedger.length = 0;
    firstByteMs = null;
    lastAssistantText = '';
    streamedText = '';
    streamedAny = false;
    threwTurnLimit = false;
    terminalToolReply = null;
    terminalToolReason = undefined;
    approvalBoundary = null;
    // Fresh per attempt: an overload retry re-runs the turn from scratch (and only
    // happens pre-commit, so these are ~0 anyway), but reset for correctness.
    ceilingState.total = 0;
    ceilingState.mutating = 0;
    ceilingState.stopped = null;
    ceilingState.stoppedKind = null;
    ceilingState.pausedMs = 0;
    ceilingState.activePermissionWaits = 0;
    ceilingState.permissionPauseStartedAt = null;
    const startedAt = Date.now();
    let lastHeartbeatAt = startedAt;
    const toolById = new Map<string, { name: string; input: unknown }>();
    let stream: Query | undefined;
    try {
      if (effectiveShouldCancel && await effectiveShouldCancel()) {
        throw new AgentRuntimeCancelledError('Run cancelled by caller.');
      }
      stream = queryImpl({ prompt: effectivePrompt, options: sdkOptions }) as Query;
      const iterator = (stream as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
      while (true) {
        const heartbeatIntervalMs = Math.max(1, options.livenessHeartbeatMs ?? 60_000);
        const next = await nextSdkMessageWithRuntimeTicks(
          iterator,
          options,
          firstByteMs === null ? toolSurfaceFirstMessageMs() : 0,
          heartbeatIntervalMs,
          async () => {
            if (effectiveShouldCancel && await effectiveShouldCancel()) {
              try { await stream?.interrupt?.(); } catch { /* best-effort */ }
              throw new AgentRuntimeCancelledError('Run cancelled by caller.');
            }
            const now = Date.now();
            if (options.sessionId && now - lastHeartbeatAt >= heartbeatIntervalMs) {
              lastHeartbeatAt = now;
              try {
                appendEvent({
                  sessionId: options.sessionId,
                  turn: 0,
                  role: 'system',
                  type: 'heartbeat',
                  data: {
                    kind: 'progress_check_in',
                    toolCalls: toolCallLedger.length,
                    elapsedMs: now - startedAt,
                    message: `Still working (${toolCallLedger.length} tool call${toolCallLedger.length === 1 ? '' : 's'} so far).`,
                    transport: 'claude_agent_sdk',
                  },
                });
              } catch { /* liveness must never break the stream */ }
            }
            if (
              wallClockMs > 0
              && ceilingState.stopped === null
              && now - startedAt - effectivePermissionPausedMs(ceilingState, now) > wallClockMs
            ) {
              ceilingState.stopped = 'I hit my time budget for this turn before finishing. Say "continue" and I\'ll pick up where I left off.';
              ceilingState.stoppedKind = 'wallclock';
              try { await stream?.interrupt?.(); } catch { /* best-effort */ }
              return 'stop';
            }
            return 'continue';
          },
        );
        if (next.done) break;
        const message = next.value;
        if (firstByteMs === null) {
          firstByteMs = Date.now() - startedAt;
          // Eventlog copy of the usage-log timing so TTFT is scoreable per
          // session (proof harness; speculative-routing acceptance telemetry).
          if (options.sessionId) {
            try {
              appendEvent({ sessionId: options.sessionId, turn: 0, role: 'system', type: 'sdk_first_byte', data: { firstByteMs } });
            } catch { /* telemetry must never break the stream */ }
          }
        }
        if (effectiveShouldCancel && await effectiveShouldCancel()) {
          try { await stream?.interrupt?.(); } catch { /* best-effort */ }
          throw new AgentRuntimeCancelledError('Run cancelled by caller.');
        }
        // TURN-CONTROL SPINE: liveness heartbeats. The harness loop emits
        // progress_check_in ticks between steps; this lane emitted none, so a
        // long SDK run looked dead in the operator view (the 2026-07-16
        // 33-minute incident's eventlog had zero liveness rows). Same event
        // shape, message-boundary cadence.
        if (options.sessionId && Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
          lastHeartbeatAt = Date.now();
          try {
            appendEvent({
              sessionId: options.sessionId,
              turn: 0,
              role: 'system',
              type: 'heartbeat',
              data: {
                kind: 'progress_check_in',
                toolCalls: toolCallLedger.length,
                elapsedMs: Date.now() - startedAt,
                message: `Still working (${toolCallLedger.length} tool call${toolCallLedger.length === 1 ? '' : 's'} so far).`,
                transport: 'claude_agent_sdk',
              },
            });
          } catch { /* telemetry must never break the stream */ }
        }
        // Wall-clock backstop: a genuinely stuck stream never hangs the turn. EXCLUDE
        // approval-wait (pausedMs) so a long confirm-first approval — the user may
        // take many minutes — never self-aborts the turn the instant they approve.
        const boundaryNow = Date.now();
        if (
          wallClockMs > 0
          && ceilingState.stopped === null
          && boundaryNow - startedAt - effectivePermissionPausedMs(ceilingState, boundaryNow) > wallClockMs
        ) {
          ceilingState.stopped = 'I hit my time budget for this turn before finishing. Say "continue" and I\'ll pick up where I left off.';
          ceilingState.stoppedKind = 'wallclock';
          try { await stream?.interrupt?.(); } catch { /* best-effort; finally closes */ }
          break;
        }
        const nextInit = extractInit(message);
        if (nextInit && !init) {
          init = nextInit;
          const advertisedTools = init.tools ?? [];
          const missingTools = missingRequiredLocalMcpTools(options.requiredLocalMcpTools, advertisedTools);
          if (missingTools.length > 0) throw new ClaudeAgentSdkToolSurfaceError(missingTools, advertisedTools);
          recordClaudeSdkLocalMcpSurfaceHealth(options, 'healthy', { advertisedTools });
        }
        const delta = extractTextDelta(message);
        if (delta) {
          streamedText += delta;
          // Content-chanting advisory (2026-07-20) — same detector as the
          // harness lane; a trip emits telemetry once, never halts the stream.
          const chantTrip = chantDetector?.feed(delta);
          if (chantTrip && options.sessionId) {
            try {
              appendEvent({
                sessionId: options.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: { kind: 'content_chanting', action: 'advisory', repeats: chantTrip.repeats, chunkPreview: chantTrip.chunk.slice(0, 50) },
              });
            } catch { /* advisory telemetry must never break the stream */ }
          }
          if (options.onDelta) {
            streamedAny = true;
            try { await options.onDelta(delta); } catch { /* a delta-sink error must never break the run */ }
          }
        }
        const atext = extractAssistantText(message);
        if (atext) lastAssistantText = atext;
        const compaction = extractCompactionSignal(message);
        if (compaction) emitSdkCompactionEvent(options.sessionId, compaction);
        // Tool-call OBSERVABILITY (ungated from reflection): the Claude SDK runs
        // its tool loop OUTSIDE the harness gate chain, so local/authoring tools
        // (goal_create, task_add, memory_remember, …) called on this lane never
        // produced a tool event — a real action (e.g. goal_create writing a goal)
        // was INVISIBLE in the operator view, indistinguishable from a fabricated
        // claim (observed 2026-06-30). Emit a canonical operational event for every
        // tool use/result so the Observability panel shows what Clem actually does,
        // on BOTH lanes (chat brain + workflow step share this runner). Fail-open.
        for (const use of extractToolUseIds(message)) {
          if (seenTopLevelToolCallIds.has(use.id)) continue;
          seenTopLevelToolCallIds.add(use.id);
          // The first provider frame owns this canonical id. A replay must not
          // overwrite the source name/input later used to interpret its result.
          toolById.set(use.id, { name: use.name, input: use.input });
          try {
            toolCallLedger.push({
              callId: use.id,
              name: mcpToolTail(use.name),
              argsPreview: JSON.stringify(use.input ?? {}).slice(0, 120),
            });
          } catch { /* ledger is best-effort */ }
          appendSdkTopLevelToolEvent(options.sessionId, 'tool_called', use.id, { name: use.name, input: use.input });
          emitSdkToolCallEvent(options.sessionId, 'tool_call_started', use.id, use.name);
        }
        // The SDK can replay a complete assistant frame around stream/compact
        // boundaries. Return one logical tool use per provider id, matching the
        // canonical event accounting above. Legacy/id-less blocks remain
        // visible because there is no safe identity with which to coalesce them.
        toolUses.push(...extractAssistantToolUses(message, seenReturnedToolCallIds));
        for (const tr of extractToolResults(message)) {
          const source = toolById.get(tr.callId);
          if (seenTopLevelToolReturnIds.has(tr.callId)) continue;
          seenTopLevelToolReturnIds.add(tr.callId);
          if (options.sessionId && source) {
            // Native external MCP reads never enter wrapToolForHarness. Observe
            // exact-id provider getters here so a Google Doc/site binding can
            // be independently verified without coupling it to the create-only
            // nativeArtifactClaims set. A mismatch/error is a durable no-op.
            const verificationIntent = artifactVerificationIntentForTool(source.name, source.input);
            if (verificationIntent) {
              try {
                const artifactRunScopeId = ensureArtifactRunScopeId();
                if (artifactRunScopeId) {
                  verifyArtifactBindingFromToolResult(
                    options.sessionId,
                    artifactRunScopeId,
                    source.name,
                    source.input,
                    tr.output,
                    tr.callId,
                    !tr.isError,
                  );
                }
              } catch { /* the artifact remains unverified; never break the tool stream */ }
            }
            const artifactClaim = nativeArtifactClaims.get(tr.callId);
            if (artifactClaim) {
              try {
                if (artifactOutputProvesNoDispatch(tr.output)) {
                  releaseClaimedArtifact(artifactClaim.artifactId, tr.callId);
                } else {
                  const resource = !tr.isError ? extractArtifactResource(artifactClaim.intent, tr.output) : null;
                  if (resource) {
                    bindClaimedArtifact(artifactClaim.artifactId, tr.callId, resource);
                  } else {
                    markClaimedArtifactUncertain(artifactClaim.artifactId, tr.callId);
                  }
                }
              } catch {
                try { markClaimedArtifactUncertain(artifactClaim.artifactId, tr.callId); } catch { /* pending claim blocks blind retries */ }
              }
              nativeArtifactClaims.delete(tr.callId);
            }
            const nativeWrite = nativeExternalWrites.get(tr.callId);
            if (nativeWrite) {
              if (tr.isError || artifactOutputProvesNoDispatch(tr.output)) {
                appendNativeExternalWriteEvent(options.sessionId, nativeWrite, 'external_write_failed', {
                  providerError: tr.isError,
                  dispatchProvenAbsent: artifactOutputProvesNoDispatch(tr.output),
                });
              }
              nativeExternalWrites.delete(tr.callId);
            }
          }
          // On failure, carry the cause into telemetry — SDK-lane failures were
          // emitted with no error detail (151/172 tool_call_failed rows had no
          // cause), making the reliability signal unusable.
          const failExtra = tr.isError
            ? (() => {
                const msg = String(typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? '')).slice(0, 600);
                return { error: msg, error_class: coarseToolErrorClass(msg) };
              })()
            : {};
          emitSdkToolCallEvent(options.sessionId, tr.isError ? 'tool_call_failed' : 'tool_call_completed', tr.callId, source?.name, failExtra);
          if (source?.name && !tr.isError && toolOutputLooksSuccessful(tr.output)) {
            successfulToolUses.push(completionEvidenceToolName(source.name, source.input));
          }
          appendSdkTopLevelToolEvent(options.sessionId, 'tool_returned', tr.callId, source, { isError: tr.isError, output: tr.output });
          // A3 recall contract: park every result under the SDK's OWN tool_use id
          // (toolu_…) — the id the continuation ledger hands out. Without this,
          // outputs live only under harness-generated mcp-<uuid> ids (and only
          // when clipped), so every tool_output_query(toolu_…) would miss.
          if (options.sessionId && tr.output && !tr.isError) {
            try {
              writeToolOutput({ sessionId: options.sessionId, callId: tr.callId, tool: source ? mcpToolTail(source.name) : null, output: tr.output });
            } catch { /* recall parking must never break the run */ }
          }
          if (reflectLearning && tr.output) {
            const tool = source ? reflectionToolName(source.name, source.input) : null;
            reflectImpl({ sessionId: reflectSessionId as string, callId: tr.callId, tool, output: tr.output });
          }
          if (!tr.isError && source && isTerminalAfterTool(source.name)) {
            if (!terminalToolShouldHalt(source.name, tr.output)) continue;
            terminalToolReply = renderTerminalToolReply(source.name, source.input, tr.output);
            terminalToolReason = terminalToolStoppedReason(source.name);
            try { await stream?.interrupt?.(); } catch { /* best-effort */ }
            break;
          }
        }
        if (terminalToolReply) break;
        result = extractResult(message) ?? result;
      }
      const required = requiredLocalMcpTools(options);
      if (options.sessionId && nativeArtifactClaims.size > 0) {
        for (const [callId, claim] of nativeArtifactClaims) {
          try { markClaimedArtifactUncertain(claim.artifactId, callId); } catch { /* pending claim remains fail-closed */ }
        }
        nativeArtifactClaims.clear();
      }
      if (options.sessionId && nativeExternalWrites.size > 0) {
        for (const write of nativeExternalWrites.values()) {
          appendNativeExternalWriteEvent(options.sessionId, write, 'external_write_orphaned', {
            reason: 'sdk_stream_ended_without_tool_result',
          });
        }
        nativeExternalWrites.clear();
      }
      if (!init && required.length > 0) {
        throw new ClaudeAgentSdkToolSurfaceError(required, [], {
          reason: 'SDK stream ended before emitting an init message.',
        });
      }
    } catch (err) {
      if (options.sessionId && nativeArtifactClaims.size > 0) {
        for (const [callId, claim] of nativeArtifactClaims) {
          try { markClaimedArtifactUncertain(claim.artifactId, callId); } catch { /* pending claim remains fail-closed */ }
        }
        nativeArtifactClaims.clear();
      }
      if (options.sessionId && nativeExternalWrites.size > 0) {
        for (const write of nativeExternalWrites.values()) {
          appendNativeExternalWriteEvent(options.sessionId, write, 'external_write_orphaned', {
            reason: 'sdk_stream_failed_without_tool_result',
          });
        }
        nativeExternalWrites.clear();
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Our OWN interrupt (tool ceiling / wall-clock) may surface as a thrown
      // stream error rather than a clean result — it's a graceful self-stop, not
      // a crash. Route it to the limitHit path below (handled after finally).
      if (approvalBoundary !== null) {
        // Expected workflow park/rejection interrupt. The typed boundary is
        // thrown after the stream closes below, so provider retries/fallover
        // can never replay an approval-bearing action.
      } else if (ceilingState.stopped !== null) {
        threwTurnLimit = true;
      } else if (/maximum number of turns|error_max_turns|max[_ ]turns/i.test(msg) && result?.subtype !== 'success') {
        threwTurnLimit = true;
      } else if (err instanceof ClaudeAgentSdkToolSurfaceError) {
        recordClaudeSdkToolSurfaceError(options, err);
        const committed = toolUses.length > 0 || streamedAny;
        const maxRetries = err.startupTimeoutMs !== undefined
          ? maxToolSurfaceStartupRetries()
          : maxToolSurfaceRetries();
        if (
          !committed
          && !localMcpSurfaceInitialized(err.availableTools)
          && attempt < maxRetries
        ) {
          try { stream?.close?.(); } catch { /* ignore */ }
          emitToolSurfaceRetryEvent(options, err, attempt, maxRetries);
          await sleep(toolSurfaceBackoffMs(attempt));
          continue;
        }
        throw err;
      } else if (isProviderOverloadMessage(msg)) {
        const committed = toolUses.length > 0 || streamedAny;
        // Safe first-byte retry: nothing committed yet and budget remains.
        if (!committed && attempt < maxOverloadRetries()) {
          try { stream?.close?.(); } catch { /* ignore */ }
          await sleep(overloadBackoffMs(attempt));
          continue;
        }
        // Give up — surface a TYPED error so a caller that can switch providers
        // re-dispatches when it's safe (committed=false), else surfaces it.
        throw new ClaudeSdkProviderOverloadError(msg, committed);
      } else if (isAuthRecoverableError(msg)) {
        // Expired/invalid Claude credential. Retrying the SAME dead token is
        // pointless, so throw immediately (no in-lane retry) — TYPED so the
        // caller's cross-brain fallover routes to a brain whose auth is valid,
        // instead of hard-failing the turn/step with other brains connected.
        throw new ClaudeSdkAuthExpiredError(msg, toolUses.length > 0 || streamedAny);
      } else if (isContextOverflowMessage(msg)) {
        // Context-window overflow surfaced as a thrown stream error. TYPED so the
        // brain can salvage (committed) or retry once with reduced context.
        throw new ClaudeSdkContextOverflowError(msg, toolUses.length > 0 || streamedAny);
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

  const exactApprovalBoundary = approvalBoundary as ClaudeAgentApprovalBoundary | null;
  if (exactApprovalBoundary) {
    throw new ClaudeAgentSdkApprovalBoundaryError(exactApprovalBoundary);
  }

  if (terminalToolReply) {
    recordClaudeAgentSdkUsage(options, result, init, { firstByteMs });
    return {
      text: terminalToolReply,
      sessionId: result?.session_id ?? init?.session_id,
      model: init?.model,
      toolUses,
      successfulToolUses,
      toolCallLedger,
      usage: result?.usage,
      modelUsage: result?.modelUsage,
      limitHit: false,
      stoppedReason: terminalToolReason,
      ...(resolvedArtifactRunScopeId ? { artifactRunScopeId: resolvedArtifactRunScopeId } : {}),
    };
  }

  if (threwTurnLimit) {
    recordClaudeAgentSdkUsage(options, result, init, { firstByteMs });
    return {
      text: partialLimitText(),
      sessionId: result?.session_id ?? init?.session_id,
      model: init?.model,
      toolUses,
      successfulToolUses,
      toolCallLedger,
      usage: result?.usage,
      modelUsage: result?.modelUsage,
      limitHit: true,
      selfStopped: String(ceilingState.stoppedKind) === 'loop', // cast: the 'loop' set-site is a closure alias TS can't flow-narrow
      ...(resolvedArtifactRunScopeId ? { artifactRunScopeId: resolvedArtifactRunScopeId } : {}),
    };
  }

  if (!result) throw new Error('Claude Agent SDK finished without a result message.');
  if (result.subtype !== 'success') {
    // Long-running parity: a turn-budget stop is NOT a failure. Surface the
    // partial answer + a limitHit flag so the brain can offer "say continue"
    // (mirrors the harness loop's max-turns-with-grace) instead of throwing a
    // raw "Claude Agent SDK failed" error that the caller reports as run_failed.
    if (result.subtype === 'error_max_turns') {
      recordClaudeAgentSdkUsage(options, result, init, { firstByteMs });
      return {
        text: partialLimitText(),
        sessionId: result.session_id,
        model: init?.model,
        toolUses,
        successfulToolUses,
        toolCallLedger,
        usage: result.usage,
        modelUsage: result.modelUsage,
        limitHit: true,
        ...(resolvedArtifactRunScopeId ? { artifactRunScopeId: resolvedArtifactRunScopeId } : {}),
      };
    }
    recordClaudeAgentSdkUsage(options, result, init, { firstByteMs });
    const resultText = JSON.stringify(result);
    // Overflow arrives as a generic error_during_execution result (no distinct
    // SDK subtype). Classify from the ERROR fields ONLY — never the full
    // serialized result: the model's own partial text mentioning "context
    // limit" must not misclassify an unrelated failure as overflow (review
    // finding: false 'partial success' salvage).
    // ERROR fields only — deliberately NOT `result` (it can carry the model's
    // partial ANSWER, which mentioning "context limit" must not trigger this).
    const errorFields = result as { errors?: unknown[]; error?: unknown };
    const errorText = [
      ...(Array.isArray(errorFields.errors) ? errorFields.errors : []),
      errorFields.error,
    ].filter((v) => v !== undefined && v !== null).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
    if (isContextOverflowMessage(errorText)) {
      // TYPED so the brain's salvage/reduced-retry path runs.
      throw new ClaudeSdkContextOverflowError(errorText.slice(0, 800), toolUses.length > 0 || streamedAny);
    }
    throw new Error(`Claude Agent SDK failed: ${resultText.slice(0, 800)}`);
  }
  recordClaudeAgentSdkUsage(options, result, init, { firstByteMs });
  return {
    text: bestSuccessText(result.result, lastAssistantText, streamedText),
    structuredOutput: result.structured_output,
    sessionId: result.session_id,
    model: init?.model,
    toolUses,
    successfulToolUses,
    toolCallLedger,
    usage: result.usage,
    modelUsage: result.modelUsage,
    ...(resolvedArtifactRunScopeId ? { artifactRunScopeId: resolvedArtifactRunScopeId } : {}),
  };
}
