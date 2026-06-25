/**
 * respondViaHarness — the CANON-ONE-LOOP convergence bridge.
 *
 * The legacy `assistant.respond()` → CodexNativeRuntime loop carries NONE of
 * the harness write gates (grounding judge, duplicate-target bump,
 * confirm-first, runaway-loop guardrail, execution-wrap) because those live
 * in `wrapToolForHarness` and read the harness event log. Surfaces still on
 * the legacy loop — webhook gateway, cron jobs, background tasks (mobile),
 * legacy CLI — are exactly the unattended lanes where an ungated wrong write
 * hurts most (2026-06-11 wrong-city + double-send incident class).
 *
 * This bridge lets those callers run the HARNESS loop while preserving the
 * legacy synchronous contract (`AssistantResponse` in, one awaited reply
 * out). Routing rules, in order:
 *
 *   1. Per-surface kill-switch (`CLEMMY_HARNESS_<SURFACE>`, default ON) —
 *      flips a surface back to legacy instantly.
 *   2. `excludeToolNames` the harness CANNOT enforce (a non-local/external MCP
 *      tool) → legacy. buildOrchestratorAgent now filters HARNESS-surface tools,
 *      so callers excluding only local tools (architect: workflow_*; autonomy:
 *      composio_execute_tool + workflow_*) ride the gated loop. A non-filterable
 *      exclude still routes legacy — never silently WIDEN a caller's surface.
 *   3. Harness runtime auth unavailable → legacy. This check happens BEFORE
 *      any model call or tool dispatch, so falling back can never
 *      double-execute side effects.
 *   4. Once the harness run STARTS, errors propagate — there is deliberately
 *      no run-failed→legacy retry (a retry after a partial run is the
 *      double-send class the gates exist to prevent).
 *
 * Known, accepted contract differences from the legacy loop (same trade the
 * workflow runner accepted when it converged):
 *   - `request.model` is ignored — the harness uses its configured model.
 *   - `runId` run-event streaming is not bridged; the harness writes its own
 *     richer event log instead. `onToolActivity` / `onReasoning` are relayed
 *     best-effort from harness events for legacy progress surfaces.
 */
import { runConversation } from './loop.js';
import { buildOrchestratorAgent } from '../../agents/orchestrator.js';
import { configureHarnessRuntime } from './codex-client.js';
import { clearKill, createSession, getSession, listEvents, requestKill, type EventRow } from './eventlog.js';
import { listPending } from './approval-registry.js';
import { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain } from './claude-agent-brain.js';
import { ClaudeSdkProviderOverloadError } from './claude-agent-sdk.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import { getRuntimeEnv } from '../../config.js';
import pino from 'pino';
import { LOCAL_MCP_TOOL_NAMES } from '../../tools/catalog.js';
import { actionBus } from '../action-bus.js';
import type { AssistantRequest, AssistantResponse, ToolActivity } from '../../types.js';

export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli' | 'dashboard' | 'home' | 'workflow';

/** Surfaces that are STAGED, not yet validated live: default OFF (legacy stays
 *  byte-identical) so a new conversion lands reversibly and Nathan flips the
 *  switch to live-verify, after which it bakes in and leaves this set. The
 *  already-validated surfaces (webhook/cron/background/cli) default ON. These
 *  flags are TEMPORARY — they collapse to zero (legacy core deleted, conversions
 *  baked in) once validated, so the net is a flag REDUCTION, not sprawl.
 *
 *  2026-06-13 (audit #7 / FORK-collapse): dashboard, home, and workflow have
 *  been validated live (the dev daemon ran all three on the gated loop all
 *  session — architect draft, home chat, and workflow step-chaining smokes
 *  green every run). They now default ON like the other surfaces — the gated
 *  harness loop is the ONE path for every surface. Per-surface kill-switches
 *  (CLEMMY_HARNESS_DASHBOARD/HOME/WORKFLOW=off) remain for instant reversibility
 *  until the legacy core is deleted (Phase 2). Set is now empty (flag REDUCTION
 *  realized). */
const STAGING_SURFACES: ReadonlySet<HarnessSurface> = new Set<HarnessSurface>();

/** The harness can only ENFORCE an exclusion for tools on its own local surface
 *  (buildOrchestratorAgent filters those by name). External MCP-server tools are
 *  resolved dynamically and can't be filtered here, so if a caller excludes one
 *  we must stay on the legacy core — routing through the harness would silently
 *  WIDEN the caller's requested tool surface (the autonomy no-external-writes
 *  gate is the case that matters). The real callers only ever exclude harness
 *  tools (workflow_*, composio_execute_tool), so they convert cleanly. */
const HARNESS_FILTERABLE_TOOLS: ReadonlySet<string> = new Set(LOCAL_MCP_TOOL_NAMES as readonly string[]);
function harnessCanEnforceExcludes(names: string[] | undefined): boolean {
  if (!names || names.length === 0) return true;
  return names.every((n) => HARNESS_FILTERABLE_TOOLS.has(n));
}

const REUSE_USER_INPUT_TERMINALS = new Set<string>([
  'conversation_completed',
  'conversation_limit_exceeded',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'run_paused',
  'awaiting_user_input',
  'approval_requested',
]);

function hasReusableRecordedUserInput(sessionId: string, text: string): boolean {
  try {
    const expected = text.trim();
    if (!expected) return false;
    const recent = listEvents(sessionId).slice(-12);
    let matchSeq = -1;
    for (const event of recent) {
      if (event.type !== 'user_input_received') continue;
      const got = typeof (event.data as { text?: unknown })?.text === 'string'
        ? ((event.data as { text?: string }).text ?? '').trim()
        : '';
      if (got === expected) matchSeq = event.seq;
    }
    if (matchSeq < 0) return false;
    return !recent.some((event) => event.seq > matchSeq && REUSE_USER_INPUT_TERMINALS.has(event.type));
  } catch {
    return false;
  }
}

/** Interactive chat lanes get the objective-completion judge (parity with
 *  desktop/Discord). Unattended lanes leave it off: their callers already own
 *  report-back honesty via verifyDelivered, and an in-loop judge with no
 *  human present only burns budget arguing with itself. */
const SURFACE_CONFIG: Record<HarnessSurface, { kind: 'chat' | 'execution'; judgeCompletion: boolean; honorModel?: boolean }> = {
  webhook: { kind: 'chat', judgeCompletion: true },
  cli: { kind: 'chat', judgeCompletion: true },
  cron: { kind: 'execution', judgeCompletion: false },
  background: { kind: 'execution', judgeCompletion: false },
  // Workflow steps: execution lane (no judge — the step contract owns
  // completion). honorModel passes step.model through so forEach fan-out keeps
  // its cheaper worker model. Contained: only THIS surface honors request.model
  // (cron/gateway/etc. keep ignoring it — byte-identical).
  workflow: { kind: 'execution', judgeCompletion: false, honorModel: true },
  // One-shot console drafting endpoint (workflow architect): chat kind, but NO
  // objective judge — a single drafting reply is not a multi-step action to
  // validate, and the judge would only add latency/loops.
  dashboard: { kind: 'chat', judgeCompletion: false },
  // Interactive console home chat: full chat parity with desktop/Discord, so
  // the objective-completion judge is ON (same as the cli/webhook lanes).
  home: { kind: 'chat', judgeCompletion: true },
};

export function harnessSurfaceEnabled(surface: HarnessSurface): boolean {
  const dflt = STAGING_SURFACES.has(surface) ? 'off' : 'on';
  const raw = (getRuntimeEnv(`CLEMMY_HARNESS_${surface.toUpperCase()}`, dflt) ?? dflt).trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

// Test seams — same pattern as the grounding judge's _setGroundingJudgeForTests.
type RunConversationFn = typeof runConversation;
type BuildAgentFn = typeof buildOrchestratorAgent;
type ConfigureFn = typeof configureHarnessRuntime;
type ClaudeAgentBrainFn = typeof respondViaClaudeAgentSdkBrain;
let runConversationImpl: RunConversationFn = runConversation;
let buildAgentImpl: BuildAgentFn = buildOrchestratorAgent;
let configureImpl: ConfigureFn = configureHarnessRuntime;
let claudeAgentBrainImpl: ClaudeAgentBrainFn = respondViaClaudeAgentSdkBrain;
export function _setBridgeImplsForTests(impls: {
  runConversation?: RunConversationFn | null;
  buildAgent?: BuildAgentFn | null;
  configure?: ConfigureFn | null;
  claudeAgentBrain?: ClaudeAgentBrainFn | null;
}): void {
  runConversationImpl = impls.runConversation ?? runConversation;
  buildAgentImpl = impls.buildAgent ?? buildOrchestratorAgent;
  configureImpl = impls.configure ?? configureHarnessRuntime;
  claudeAgentBrainImpl = impls.claudeAgentBrain ?? respondViaClaudeAgentSdkBrain;
}

/** Poll cadence for mapping the legacy `shouldCancel` callback onto the
 *  harness kill switch — matches the legacy runtime's own 2s cancel poll. */
const CANCEL_POLL_MS = 2_000;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolActivityInput(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { value };
    } catch {
      return { value };
    }
  }
  return objectRecord(value);
}

function toolActivityFromHarnessEvent(event: EventRow): ToolActivity | null {
  if (event.type !== 'tool_called') return null;
  const data = objectRecord(event.data);
  const rawName = data.tool ?? data.toolName;
  const toolName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'unknown_tool';
  const rawArgs = data.arguments ?? data.args ?? data.input;
  return { toolName, input: toolActivityInput(rawArgs) };
}

function reasoningProgressFromHarnessEvent(event: EventRow): string | null {
  switch (event.type) {
    case 'turn_started':
      return 'Clementine is planning the next step.';
    case 'conversation_step':
      return 'Clementine is continuing the task.';
    case 'stall_retry_attempted':
      return 'Clementine is recovering from a stalled step.';
    case 'budget_elevated':
      return 'Clementine raised the run budget for a longer task.';
    default:
      return null;
  }
}

function attachLegacyProgressRelay(request: AssistantRequest): () => void {
  if (!request.onToolActivity && !request.onReasoning) return () => {};
  return actionBus.subscribe((event) => {
    if (event.kind !== 'harness.event') return;
    if (event.sessionId !== request.sessionId) return;
    if (request.onToolActivity) {
      const activity = toolActivityFromHarnessEvent(event.event);
      if (activity) {
        void Promise.resolve(request.onToolActivity(activity)).catch(() => {
          // Legacy progress callbacks are observability only; never break a run.
        });
      }
    }
    if (request.onReasoning) {
      const progress = reasoningProgressFromHarnessEvent(event.event);
      if (progress) {
        void Promise.resolve(request.onReasoning(progress)).catch(() => {
          // Legacy progress callbacks are observability only; never break a run.
        });
      }
    }
  });
}

export async function respondViaHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  opts: { reuseRecordedUserInput?: boolean } = {},
): Promise<AssistantResponse> {
  const config = SURFACE_CONFIG[surface];
  const sessionId = request.sessionId;

  if (!getSession(sessionId)) {
    const titleSeed = request.message.trim().replace(/\s+/g, ' ');
    createSession({
      id: sessionId,
      kind: config.kind,
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `bridge:${surface}` },
    });
  }

  // A kill latched by a previous request on this session id must not abort
  // this fresh run before it starts.
  try { clearKill(sessionId); } catch { /* best effort */ }

  let cancelledByCaller = false;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  if (request.shouldCancel) {
    const shouldCancel = request.shouldCancel;
    cancelPoll = setInterval(() => {
      void (async () => {
        try {
          if (await shouldCancel()) {
            cancelledByCaller = true;
            requestKill(sessionId, 'cancelled by caller (shouldCancel)');
            if (cancelPoll) clearInterval(cancelPoll);
          }
        } catch { /* a broken predicate must not kill the run */ }
      })();
    }, CANCEL_POLL_MS);
  }

  const detachProgressRelay = attachLegacyProgressRelay(request);
  try {
    const agent = await buildAgentImpl({
      userInput: request.message,
      sessionId,
      excludeToolNames: request.excludeToolNames,
      // Only surfaces flagged honorModel forward request.model (workflow steps);
      // every other surface keeps the harness's configured model (byte-identical).
      ...(config.honorModel && request.model ? { model: request.model } : {}),
      // Phase 1 Tool-RAG: JIT tool loading is allowed ONLY on interactive chat
      // lanes (a user is present turn-by-turn). Execution surfaces (cron /
      // background / workflow) have no user and can't recover a dropped built-in
      // tool, so they keep the full surface. Still default-off via CLEMMY_TOOL_JIT.
      allowToolJit: config.kind === 'chat',
    });
    const result = await runConversationImpl({
      agent,
      sessionId,
      input: request.message,
      maxWallClockMs: request.maxWallClockMs,
      judgeCompletion: config.judgeCompletion,
      onChunk: request.onChunk,
      reuseRecordedUserInput: opts.reuseRecordedUserInput,
    });

    const replyText =
      (result.lastDecision?.reply && result.lastDecision.reply.trim())
        ? result.lastDecision.reply
        : (result.lastDecision?.summary ?? '');

    switch (result.status) {
      case 'completed':
        return {
          text: replyText || '(no reply produced)',
          sessionId,
          stoppedReason: 'success',
          turnsUsed: result.lastTurn,
        };
      case 'awaiting_user_input':
        // The run asked the user a clarifying question (ask_user_question). It is
        // NOT done — surface a DISTINCT stop reason so a BACKGROUND run parks for
        // the answer instead of being marked done with the question swallowed
        // (the root cause of "tasks get lost" + "she can't pause for validation").
        // Foreground/chat callers treat any non-success reason as a normal reply,
        // so this is forward-only for them — only the background drain branches on it.
        return {
          text: replyText || '(no reply produced)',
          sessionId,
          stoppedReason: 'awaiting-input',
          turnsUsed: result.lastTurn,
        };
      case 'awaiting_approval': {
        const pending = listPending({ sessionId, status: 'pending' });
        const first = pending[0];
        return {
          text: replyText
            || (first
              ? `Paused for approval \`${first.approvalId}\`: ${first.subject}. Approve or reject it and I'll continue.`
              : 'Paused for an approval. Approve or reject it and I\'ll continue.'),
          sessionId,
          pendingApprovalId: first?.approvalId,
          stoppedReason: 'pending-approval',
          turnsUsed: result.lastTurn,
        };
      }
      case 'limit_exceeded':
        return {
          text: replyText || 'I hit the run budget before finishing — say "continue" to keep going.',
          sessionId,
          stoppedReason: 'max-turns-with-grace',
          turnsUsed: result.lastTurn,
        };
      case 'killed':
        // Preserve the legacy cancellation contract: callers (background
        // tasks) classify aborts via this error type.
        if (cancelledByCaller) throw new AgentRuntimeCancelledError('Run cancelled by caller.');
        return {
          text: replyText || 'Run was cancelled.',
          sessionId,
          stoppedReason: 'cancelled',
          turnsUsed: result.lastTurn,
        };
      case 'failed':
      default:
        throw new Error(result.error || `harness run ${result.status}`);
    }
  } finally {
    detachProgressRelay();
    if (cancelPoll) clearInterval(cancelPoll);
  }
}

/**
 * Drop-in router for legacy call sites:
 *   `assistant.respond(req)` → `respondPreferHarness('cron', req, (r) => assistant.respond(r))`
 * Falls back to legacy ONLY pre-run (flag off, per-call tool excludes, auth
 * unavailable) — never after the harness run has started.
 */
export async function respondPreferHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
): Promise<AssistantResponse> {
  if (!harnessSurfaceEnabled(surface)) return legacyRespond(request);
  // Per-call tool-exclusion: route through the harness ONLY when it can ENFORCE
  // every excluded name (harness-surface tool). A non-filterable exclude (an
  // external MCP tool) falls back to legacy so we never silently widen the
  // caller's tool surface. buildOrchestratorAgent does the actual filtering.
  if (!harnessCanEnforceExcludes(request.excludeToolNames)) return legacyRespond(request);
  let auth: { ok: boolean };
  try {
    auth = await configureImpl();
  } catch {
    auth = { ok: false };
  }
  if (!auth.ok) return legacyRespond(request);
  if (claudeAgentSdkBrainEnabled(surface)) {
    const detachProgressRelay = attachLegacyProgressRelay(request);
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      detachProgressRelay();
    };
    try {
      return await claudeAgentBrainImpl(surface, request);
    } catch (err) {
      // Claude SDK brain gave up on a provider overload BEFORE committing
      // anything this turn (no tool ran, nothing streamed) → fall the WHOLE turn
      // over to the standard harness brain (Codex→GLM via RouterModelProvider,
      // which has its own first-byte fallover). committed=true → surface it (a
      // re-run could double-act / duplicate the partial reply). This brings the
      // Claude SDK chat lane to parity with how the Codex/GLM brains already
      // fall over. Kill-switch: CLEMMY_BRAIN_FALLOVER=off.
      if (chatBrainFalloverEnabled() && err instanceof ClaudeSdkProviderOverloadError && !err.committed) {
        bridgeLogger.warn({ surface }, 'Claude brain overloaded at turn start — falling the turn over to the harness brain (Codex→GLM)');
        detach();
        return respondViaHarness(surface, request, {
          reuseRecordedUserInput: hasReusableRecordedUserInput(request.sessionId, request.message),
        });
      }
      throw err;
    } finally {
      detach();
    }
  }
  return respondViaHarness(surface, request);
}

const bridgeLogger = pino({ name: 'clementine.respond-bridge' });

function chatBrainFalloverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').toLowerCase() !== 'off';
}
