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
 *      blocks that surface unless the explicit legacy escape hatch is enabled.
 *   2. `excludeToolNames` the harness CANNOT enforce (a non-local/external MCP
 *      tool) → blocks pre-run. buildOrchestratorAgent filters HARNESS-surface
 *      tools, so callers excluding only local tools (architect: workflow_*;
 *      autonomy composio_execute_tool + workflow_*) ride the gated loop. A
 *      non-filterable exclude must not silently widen the surface or route
 *      through legacy.
 *   3. Harness runtime auth unavailable → blocks pre-run with an actionable
 *      model setup message.
 *   4. Once the harness run STARTS, errors propagate — there is deliberately
 *      no run-failed→legacy retry (a retry after a partial run is the
 *      double-send class the gates exist to prevent).
 *
 * Legacy fallback still exists as an explicit operator break-glass:
 * `CLEMMY_LEGACY_RESPOND_FALLBACK=on`. It is intentionally global and loud so
 * the old ApprovalStore / assistant.respond path cannot come back accidentally.
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
import {
  appendEvent,
  beginRunAttempt,
  clearKill,
  createSession,
  finishRunAttempt,
  getLatestRunAttemptByRunId,
  getSession,
  listEvents,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  requestKill,
  type EventRow,
} from './eventlog.js';
import { listPending } from './approval-registry.js';
import { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain, isClaudeSdkUnparseableToolCall } from './claude-agent-brain.js';
import { ClaudeSdkProviderOverloadError } from './claude-agent-sdk.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import { getModelRoutingMode, getRuntimeEnv } from '../../config.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import { falloverBrainModelIds, type BrainProviderClass } from './model-role-options.js';
import { resolveRoleModel } from './model-roles.js';
import { withRouteDiagnostics, routeDiagnosticsFromResponse } from './response-route.js';
import { synthesizeTurnReport } from './work-report.js';
import { nonFilterableToolExcludes } from './tool-policy.js';
import { recordHarnessCapabilityHealth } from './capability-health.js';
import pino from 'pino';
import { LOCAL_MCP_TOOL_NAMES } from '../../tools/catalog.js';
import { actionBus } from '../action-bus.js';
import type { AssistantRequest, AssistantResponse, AssistantRouteDiagnostics, ToolActivity } from '../../types.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';

export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli' | 'dashboard' | 'home' | 'workflow' | 'discord' | 'slack';

/** Every surface runs on the gated harness loop by default (the FORK is dead as
 *  of v1.4.0). Each keeps a per-surface kill-switch (CLEMMY_HARNESS_<SURFACE>=off)
 *  for instant reversibility until the legacy core is deleted (Phase 2). The old
 *  staged-surface default-OFF set collapsed to empty once every surface was
 *  validated live, and was removed in the 2026-07-09 subtraction pass. */

/** The harness can only ENFORCE an exclusion for tools on its own local surface
 *  (buildOrchestratorAgent filters those by name). External MCP-server tools are
 *  resolved dynamically and can't be filtered here, so if a caller excludes one
 *  we must stay on the legacy core — routing through the harness would silently
 *  WIDEN the caller's requested tool surface (the autonomy no-external-writes
 *  gate is the case that matters). The real callers only ever exclude harness
 *  tools (workflow_*, composio_execute_tool), so they convert cleanly. */
const HARNESS_FILTERABLE_TOOLS: ReadonlySet<string> = new Set(LOCAL_MCP_TOOL_NAMES as readonly string[]);
function harnessCanEnforceExcludes(names: string[] | undefined): boolean {
  return nonFilterableToolExcludes(names, HARNESS_FILTERABLE_TOOLS).length === 0;
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

export function hasReusableRecordedUserInput(sessionId: string, text: string, runId?: string): boolean {
  try {
    // The attempt binding is the durable identity of this accepted turn. It
    // remains valid when the runtime prompt is transformed (/goal,
    // attachments, continuation) and after the first brain writes a terminal
    // event before a safe provider fallover. Text is only a legacy fallback.
    const boundAttempt = runId?.trim()
      ? getLatestRunAttemptByRunId(sessionId, runId.trim())
      : null;
    if (boundAttempt?.sourceUserSeq) return true;

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
  // Interactive chat transports share the same bridge/fallover spine as home.
  discord: { kind: 'chat', judgeCompletion: true },
  slack: { kind: 'chat', judgeCompletion: true },
};

export function harnessSurfaceEnabled(surface: HarnessSurface): boolean {
  // Default ON for every surface; the per-surface kill-switch can force it off.
  const dflt = 'on';
  const raw = (getRuntimeEnv(`CLEMMY_HARNESS_${surface.toUpperCase()}`, dflt) ?? dflt).trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

function providerFor(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  try { return resolveEffectiveProviderForModel(modelId); } catch { return undefined; }
}

function readRawString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const got = (value as Record<string, unknown>)[key];
  return typeof got === 'string' && got.trim() ? got.trim() : undefined;
}

function routeForLegacyFallback(surface: HarnessSurface, request: AssistantRequest): AssistantRouteDiagnostics {
  return {
    routeKind: 'legacy',
    surface,
    requestedModel: request.model,
    effectiveModel: request.model,
    provider: providerFor(request.model),
    transport: 'legacy_assistant',
  };
}

function legacyRespondFallbackEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', 'off') ?? 'off').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

function blockedPreRunResponse(
  surface: HarnessSurface,
  request: AssistantRequest,
  reason: string,
  details?: Record<string, unknown>,
): AssistantResponse {
  const route = routeForHarness(surface, request);
  try {
    const code = typeof details?.reason === 'string' && details.reason.trim()
      ? details.reason.trim().replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()
      : 'preflight_block';
    recordHarnessCapabilityHealth({
      id: `respond_bridge_${code}`,
      state: 'unavailable',
      summary: 'Respond bridge preflight blocked a harness run before model or tool work started.',
      reason: `${surface}: ${reason}`,
      sessionId: request.sessionId,
      details: {
        surface,
        route,
        requestedModel: request.model ?? null,
        runId: request.runId ?? null,
        ...details,
      },
    });
  } catch {
    // Health telemetry is advisory; never change the preflight response.
  }
  return withRouteDiagnostics({
    text: reason,
    sessionId: request.sessionId,
    stoppedReason: 'error',
    raw: {
      blockedBy: 'harness_preflight',
      surface,
      ...details,
    },
  }, {
    ...route,
    transport: 'harness_preflight_block',
  });
}

function routeForHarness(surface: HarnessSurface, request: AssistantRequest, modelOverride?: string): AssistantRouteDiagnostics {
  const config = SURFACE_CONFIG[surface];
  const effectiveModel = modelOverride
    ?? (config.honorModel && request.model
      ? request.model
      : resolveRoleModel('brain').modelId);
  return {
    routeKind: 'harness',
    surface,
    requestedModel: request.model,
    effectiveModel,
    provider: providerFor(effectiveModel),
    transport: 'openai_agents_harness',
    mode: getModelRoutingMode(),
  };
}

function routeForClaudeSdkBrain(surface: HarnessSurface, request: AssistantRequest, response: AssistantResponse): AssistantRouteDiagnostics {
  const rawModel = readRawString(response.raw, 'model');
  const effectiveModel = rawModel
    ?? (request.model?.startsWith('claude-') ? request.model : undefined)
    ?? resolveRoleModel('brain').modelId;
  return {
    routeKind: 'claude_agent_sdk_brain',
    surface,
    requestedModel: request.model,
    effectiveModel,
    provider: 'claude',
    transport: readRawString(response.raw, 'transport') ?? 'claude_agent_sdk_brain',
    mode: readRawString(response.raw, 'mode'),
  };
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
  // Native SDK calls also emit a transport-mirror row from the inner MCP
  // wrapper. That row remains durable audit evidence, but forwarding it would
  // double live progress counters/check-ins for one logical action.
  if (!isCanonicalTopLevelToolEvent(event, 'tool_called')) return null;
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

/** The actual clarifying question (+ options, numbered) from the latest
 *  awaiting_user_input event — what the user must SEE to answer. Returns null
 *  when no such event exists (caller falls back to the decision text). */
function awaitingQuestionText(sessionId: string): string | null {
  try {
    const [ev] = listEvents(sessionId, { types: ['awaiting_user_input'], limit: 1, desc: true });
    if (!ev) return null;
    const data = ev.data as { question?: unknown; options?: unknown };
    const question = typeof data.question === 'string' ? data.question.trim() : '';
    if (!question) return null;
    const options = Array.isArray(data.options)
      ? (data.options as unknown[]).filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      : [];
    if (options.length === 0) return question;
    const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    return `${question}\n${numbered}\n(Reply with a number or in your own words.)`;
  } catch {
    return null;
  }
}

/**
 * ALWAYS REPORT BACK. When a turn did real work (writes, or at least meaningful tool
 * calls) but the model emitted no reply text, synthesize an honest report so the user
 * always learns what happened. Thin wrapper over the shared synthesizer (also used at
 * the loop's terminal-reply choke points). `afterSeq` scopes to this request's events.
 * Returns null only for a TOTAL non-response (no writes, no tools) — the caller then
 * shows the genuine "send that again" fallback.
 */
export function synthesizeCompletedWorkReport(sessionId: string, afterSeq?: number): string | null {
  return synthesizeTurnReport(sessionId, afterSeq);
}

export async function respondViaHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  opts: { reuseRecordedUserInput?: boolean; modelOverride?: string } = {},
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

  // Every standard-lane request owns a durable attempt too (Claude already did
  // this). Outer desktop/Discord callers pass the same run id, so begin is
  // idempotent; background/workflow/cron callers gain exact cancellation rather
  // than a session-global poll that can jump to a newer turn.
  const requestAttempt = beginRunAttempt(sessionId, { runId: request.runId });
  const sourceUserEvent = recordRunAttemptUserInput(requestAttempt, {
    turn: 1,
    role: 'user',
    data: {
      text: request.message,
      ...(request.runId ? { runId: request.runId } : {}),
      attemptId: requestAttempt.attemptId,
      source: `bridge:${surface}`,
    },
  });
  preserveCurrentKillAndClearStale(sessionId, requestAttempt);

  let cancelledByCaller = false;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  if (request.shouldCancel) {
    const shouldCancel = request.shouldCancel;
    cancelPoll = setInterval(() => {
      void (async () => {
        try {
          if (await shouldCancel()) {
            cancelledByCaller = true;
            requestKill(sessionId, 'cancelled by caller (shouldCancel)', requestAttempt);
            if (cancelPoll) clearInterval(cancelPoll);
          }
        } catch { /* a broken predicate must not kill the run */ }
      })();
    }, CANCEL_POLL_MS);
  }

  const detachProgressRelay = attachLegacyProgressRelay(request);
  let requestAttemptStatus: 'completed' | 'cancelled' | 'failed' = 'failed';
  try {
    const modelForRun = opts.modelOverride ?? (config.honorModel && request.model ? request.model : undefined);
    const agent = await buildAgentImpl({
      userInput: request.message,
      sessionId,
      excludeToolNames: request.excludeToolNames,
      // Only surfaces flagged honorModel forward request.model (workflow steps);
      // every other surface keeps the harness's configured model (byte-identical).
      ...(modelForRun ? { model: modelForRun } : {}),
      // Phase 1 Tool-RAG: JIT tool loading is allowed ONLY on interactive chat
      // lanes (a user is present turn-by-turn). Execution surfaces (cron /
      // background / workflow) have no user and can't recover a dropped built-in
      // tool, so they keep the full surface. Still default-off via CLEMMY_TOOL_JIT.
      allowToolJit: config.kind === 'chat',
    });
    // W1a — chat step-boundary brain fallover. On a CHAT surface, hand
    // runConversation the ordered next-brain
    // model ids + a rebuild factory so a transient model/codex error mid-turn
    // re-dispatches to the next brain instead of immediately asking. Best-effort
    // + gated by CLEMMY_BRAIN_FALLOVER; absence = today's ask behavior.
    const fallover = config.kind === 'chat'
      ? buildChatFalloverWiring({
          userInput: request.message,
          sessionId,
          excludeToolNames: request.excludeToolNames,
          allowToolJit: true,
          buildAgent: buildAgentImpl,
        })
      : {};

    // Durable "who served this turn" marker (harness lane): usage recording is
    // sparse on short turns and chat events carry no model identity — this one
    // event is the source of truth for brain-matrix assertions + route audit.
    try {
      const routed = routeForHarness(surface, request, opts.modelOverride);
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'turn_model_routed',
        data: {
          model: routed.effectiveModel,
          provider: routed.provider,
          transport: routed.transport,
          mode: routed.mode,
          routeKind: routed.routeKind,
          surface,
        },
      });
    } catch { /* telemetry only */ }
    // Baseline for the parse-exhaustion recovery gate below: a rerun on another
    // brain is only safe when THIS run committed no external write (the same
    // invariant as the step-boundary canSwitch guard in loop.ts). The
    // duplicate-send wall is a second line of defense, not the gate.
    let extWritesBeforeRun = 0;
    try { extWritesBeforeRun = listEvents(sessionId, { types: ['external_write'] }).length; } catch { /* fail-open to 0 */ }
    const result = await runConversationImpl({
      agent,
      sessionId,
      input: request.message,
      sourceUserSeq: sourceUserEvent.seq,
      maxWallClockMs: request.maxWallClockMs,
      maxRunTokens: request.maxRunTokens,
      runTokenBaseline: request.runTokenBaseline,
      judgeCompletion: config.judgeCompletion,
      onChunk: request.onChunk,
      reuseRecordedUserInput: true,
      falloverModelIds: fallover.falloverModelIds,
      rebuildAgentForBrain: fallover.rebuildAgentForBrain,
    });
    requestAttemptStatus = result.status === 'killed'
      ? 'cancelled'
      : result.status === 'failed'
        ? 'failed'
        : 'completed';

    const replyText =
      (result.lastDecision?.reply && result.lastDecision.reply.trim())
        ? result.lastDecision.reply
        : (result.lastDecision?.summary ?? '');

    switch (result.status) {
      case 'completed': {
        // Parse-exhaustion DEAD turn (retries burned, apology text, near-zero
        // tool work) → re-run ONCE on the next brain instead of shipping the
        // apology — the harness-lane mirror of the Claude-brain narration
        // give-up fallover. Guarded on !opts.modelOverride so the recovery hop
        // can never recurse. Kill-switch: CLEMMY_BRAIN_FALLOVER.
        //
        // External-write gate: if THIS run recorded any external_write, the
        // rerun is NOT safe — sent/updated/created side effects must never be
        // re-driven blindly (mirror of loop.ts canSwitch). In that case the
        // honest apology ships and the user decides; the duplicate-send wall
        // remains as defense-in-depth, not the primary gate.
        if (result.completedReason === 'no_structured_output' && !opts.modelOverride && chatBrainFalloverEnabled()) {
          let extWritesDuringRun = 0;
          try {
            extWritesDuringRun = Math.max(0, listEvents(sessionId, { types: ['external_write'] }).length - extWritesBeforeRun);
          } catch { /* fail-open to 0 — the send wall still protects the rerun */ }
          if (extWritesDuringRun > 0) {
            bridgeLogger.warn({ surface, extWritesDuringRun },
              'parse-exhaustion recovery SKIPPED — this run committed external write(s); not re-running another brain over side effects');
          } else try {
            const usedModel = modelForRun ?? resolveRoleModel('brain').modelId;
            const currentBrain = providerFor(usedModel) as BrainProviderClass | undefined;
            if (!currentBrain) throw new Error(`Could not resolve provider for ${usedModel}.`);
            const next = falloverBrainModelIds(currentBrain)[0];
            if (next) {
              bridgeLogger.warn({ surface, currentBrain, recoveryModel: next.modelId },
                'harness brain exhausted structured-decision retries — re-running the turn once on the next brain instead of shipping the apology');
              // Mark the parse-exhausted conversation_completed as superseded BEFORE the
              // re-run so the desktop transcript reconstruction can skip the internal
              // apology turn (the recovered reply is the ONE final answer the user sees).
              try {
                appendEvent({ sessionId, turn: 0, role: 'system', type: 'conversation_superseded', data: { reason: 'no_structured_output', recoveryModel: next.modelId, supersededAt: (replyText || '').slice(0, 240) } });
              } catch { /* transcript hygiene only — never block the recovery hop */ }
              const recovered = await respondViaHarness(surface, request, {
                reuseRecordedUserInput: hasReusableRecordedUserInput(request.sessionId, request.message, request.runId),
                modelOverride: next.modelId,
              });
              const route = routeDiagnosticsFromResponse(recovered);
              return route ? withRouteDiagnostics(recovered, { ...route, falloverFrom: 'harness_parse_exhaustion' }) : recovered;
            }
          } catch (falloverErr) {
            bridgeLogger.warn({ surface, err: falloverErr instanceof Error ? falloverErr.message : String(falloverErr) },
              'parse-exhaustion fallover failed — shipping the original completion');
          }
        }
        return withRouteDiagnostics({
          // ALWAYS REPORT BACK: if the model produced no reply text but the turn
          // committed real work, synthesize an honest report of what it did rather
          // than shipping "(no reply produced)".
          text: replyText || synthesizeCompletedWorkReport(sessionId, sourceUserEvent.seq) || '(no reply produced)',
          sessionId,
          stoppedReason: 'success',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      }
      case 'awaiting_user_input':
        // The run asked the user a clarifying question (ask_user_question). It is
        // NOT done — surface a DISTINCT stop reason so a BACKGROUND run parks for
        // the answer instead of being marked done with the question swallowed
        // (the root cause of "tasks get lost" + "she can't pause for validation").
        // Foreground/chat callers treat any non-success reason as a normal reply,
        // so this is forward-only for them — only the background drain branches on it.
        return withRouteDiagnostics({
          // THE QUESTION, not the summary: the decision's reply is often null on
          // an ask_user_question park and the summary reads "Asked a clarifying
          // question…" — every text surface (chat/webhook/Discord/Slack) then
          // shows the user a REPORT that a question exists instead of the
          // question itself (observed live 2026-07-03). Prefer a reply that
          // actually asks; else render the awaiting_user_input event's question
          // + options verbatim.
          text: (replyText && /\?/.test(replyText) ? replyText : awaitingQuestionText(sessionId))
            || replyText
            || '(no reply produced)',
          sessionId,
          stoppedReason: 'awaiting-input',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      case 'awaiting_approval': {
        const pending = listPending({ sessionId, status: 'pending' });
        const first = pending[0];
        return withRouteDiagnostics({
          text: replyText
            || (first
              ? `Paused for approval \`${first.approvalId}\`: ${first.subject}. Approve or reject it and I'll continue.`
              : 'Paused for an approval. Approve or reject it and I\'ll continue.'),
          sessionId,
          pendingApprovalId: first?.approvalId,
          stoppedReason: 'pending-approval',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      }
      case 'limit_exceeded':
        // Stage 4: a token-budget park is DISTINCT from turn/step budgets —
        // the drain must park it awaiting_continue instead of auto-continuing.
        return withRouteDiagnostics({
          text: replyText || (result.limitKind === 'token_budget'
            ? 'I hit this run\'s token budget before finishing — say "continue" to authorize another budget window.'
            : 'I hit the run budget before finishing — say "continue" to keep going.'),
          sessionId,
          stoppedReason: result.limitKind === 'token_budget' ? 'token-budget' : 'max-turns-with-grace',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      case 'killed':
        // Preserve the legacy cancellation contract: callers (background
        // tasks) classify aborts via this error type.
        if (cancelledByCaller) throw new AgentRuntimeCancelledError('Run cancelled by caller.');
        return withRouteDiagnostics({
          text: replyText || 'Run was cancelled.',
          sessionId,
          stoppedReason: 'cancelled',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      case 'failed':
      default:
        throw new Error(result.error || `harness run ${result.status}`);
    }
  } finally {
    detachProgressRelay();
    if (cancelPoll) clearInterval(cancelPoll);
    try { finishRunAttempt(requestAttempt, requestAttemptStatus); } catch { /* attempt telemetry must not mask the response */ }
    if (requestAttemptStatus === 'cancelled') {
      try { clearKill(sessionId, requestAttempt); } catch { /* best effort */ }
    }
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
  if (!harnessSurfaceEnabled(surface)) {
    if (legacyRespondFallbackEnabled()) {
      bridgeLogger.warn({ surface, reason: 'surface_disabled' }, 'explicit legacy respond fallback engaged');
      return withRouteDiagnostics(await legacyRespond(request), routeForLegacyFallback(surface, request));
    }
    return blockedPreRunResponse(
      surface,
      request,
      `The ${surface} harness lane is disabled by configuration, so I did not start the run. Re-enable CLEMMY_HARNESS_${surface.toUpperCase()} or set CLEMMY_LEGACY_RESPOND_FALLBACK=on only as a deliberate emergency rollback.`,
      { reason: 'surface_disabled' },
    );
  }
  // Per-call tool-exclusion: route through the harness ONLY when it can ENFORCE
  // every excluded name (harness-surface tool). A non-filterable exclude (an
  // external MCP tool) blocks pre-run by default so we never silently widen the
  // caller's tool surface or bypass the harness. buildOrchestratorAgent does the
  // actual filtering for enforceable names.
  if (!harnessCanEnforceExcludes(request.excludeToolNames)) {
    if (legacyRespondFallbackEnabled()) {
      bridgeLogger.warn({ surface, excludeToolNames: request.excludeToolNames, reason: 'non_filterable_excludes' }, 'explicit legacy respond fallback engaged');
      return withRouteDiagnostics(await legacyRespond(request), routeForLegacyFallback(surface, request));
    }
    const unsafe = nonFilterableToolExcludes(request.excludeToolNames, HARNESS_FILTERABLE_TOOLS);
    return blockedPreRunResponse(
      surface,
      request,
      `I did not start this run because the requested tool exclusions cannot be enforced by the harness: ${unsafe.join(', ')}. Remove those exclusions or route the task through a scoped harness tool surface.`,
      { reason: 'non_filterable_excludes', excludeToolNames: request.excludeToolNames, nonFilterableExcludes: unsafe },
    );
  }
  let auth: { ok: boolean; reason?: string };
  try {
    auth = await configureImpl();
  } catch (err) {
    auth = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!auth.ok) {
    if (legacyRespondFallbackEnabled()) {
      bridgeLogger.warn({ surface, reason: 'harness_auth_unavailable', authReason: auth.reason }, 'explicit legacy respond fallback engaged');
      return withRouteDiagnostics(await legacyRespond(request), routeForLegacyFallback(surface, request));
    }
    return blockedPreRunResponse(
      surface,
      request,
      `I could not start the harness because the model runtime is not configured: ${auth.reason ?? 'unknown auth/configuration error'}. Open Settings > Models and connect Codex, Claude, or a BYO model.`,
      { reason: 'harness_auth_unavailable', authReason: auth.reason },
    );
  }
  if (claudeAgentSdkBrainEnabled(surface)) {
    const detachProgressRelay = attachLegacyProgressRelay(request);
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      detachProgressRelay();
    };
    try {
      const response = await claudeAgentBrainImpl(surface, request);
      // Durable "who served this turn" marker (SDK brain lane) — mirror of the
      // harness-lane emit below; the route carries the model the SDK reported.
      try {
        const routed = routeForClaudeSdkBrain(surface, request, response);
        appendEvent({
          sessionId: request.sessionId,
          turn: 0,
          role: 'system',
          type: 'turn_model_routed',
          data: {
            model: routed.effectiveModel,
            provider: routed.provider,
            transport: routed.transport,
            mode: routed.mode,
            routeKind: routed.routeKind,
            surface,
          },
        });
      } catch { /* telemetry only */ }
      return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
    } catch (err) {
      const recovered = await recoverChatBrainFailure(surface, request, err, detach);
      if (recovered) return recovered;
      // Narration give-up with no fallover available: the error's message IS the
      // graceful user-facing copy — ship it as a normal reply, never a raw error
      // (zero tools ran; there is nothing to report as failed).
      if (err instanceof Error && (err as { narrationGiveUp?: boolean }).narrationGiveUp === true) {
        return { text: err.message } as AssistantResponse;
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
  // Default ON (kill-switch CLEMMY_BRAIN_FALLOVER=off) — parity with the router +
  // workflow lanes. A terminal Claude-brain failure (overload, hang, expired auth)
  // re-runs the turn on a connected non-Claude brain; the duplicate-send HARD WALL
  // protects any already-committed external write on the re-run.
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

function recoveryHarnessModelAfterClaudeFailure(): string | undefined {
  return falloverBrainModelIds('claude')[0]?.modelId;
}

/**
 * UNIFIED chat-brain fallover decision, shared by all chat surfaces through
 * respondPreferHarness.
 * On a FALLOVER-ELIGIBLE terminal Claude failure where nothing harmful committed,
 * re-run the WHOLE turn on the standard harness brain (Codex→GLM, which has its own
 * first-byte fallover) — ONE model switch instead of a dead turn or 6 same-model
 * re-runs. Returns the recovered response, or null (caller surfaces the error).
 *
 * Eligible classes:
 *  - provider overload (ClaudeSdkProviderOverloadError) when !committed.
 *  - unparseable-tool-call ("could not be parsed (retry also failed)") — a flaky
 *    model stumble a DIFFERENT brain usually doesn't reproduce. The SDK lane's
 *    salvage already returns a success for the COMMITTED case (so a propagated
 *    parse-failure is the uncommitted one), and the duplicate-send HARD WALL blocks
 *    any re-send on the re-run, so the switch is safe.
 * Kill-switch: CLEMMY_BRAIN_FALLOVER=off.
 */
export function isChatBrainFalloverEligible(err: unknown): boolean {
  if (!chatBrainFalloverEnabled()) return false;
  // NEVER fall over an INTENTIONAL stop (user cancel / kill / abort) — that's not a brain
  // failure, and re-running it on another brain would ignore the user's stop.
  if (err instanceof AgentRuntimeCancelledError) return false;
  const name = err instanceof Error ? err.name : '';
  if (/cancel|kill|abort/i.test(name)) return false;
  // A COMMITTED provider overload is already handled by the SDK lane's salvage (it returns a
  // success), so a propagated overload here is the uncommitted one.
  if (err instanceof ClaudeSdkProviderOverloadError) return !err.committed;
  // Unparseable tool call — a flaky stumble a DIFFERENT brain usually doesn't reproduce.
  if (isClaudeSdkUnparseableToolCall(err)) return true;
  // GENERIC terminal Claude-brain failure (non-overload 4xx/5xx, usage-limit, tool-surface
  // error, SDK internal throw, runtime.unknown): a DIFFERENT brain often succeeds where this
  // one dead-ended. Safe to re-run the whole turn — the duplicate-send HARD WALL blocks any
  // re-send of an already-committed external write on the re-run, so switching brains can't
  // double-act. Broadened 2026-07-01 (brain-switching-when-needed): previously every
  // non-overload / non-parse Claude-brain error HARD-FAILED the turn with no fallover.
  return err instanceof Error;
}

export async function recoverChatBrainFailure(
  surface: HarnessSurface,
  request: AssistantRequest,
  err: unknown,
  detach?: () => void,
): Promise<AssistantResponse | null> {
  if (!isChatBrainFalloverEligible(err)) return null;
  const kind = err instanceof ClaudeSdkProviderOverloadError ? 'overload'
    : isClaudeSdkUnparseableToolCall(err) ? 'parse_failure'
    : 'terminal_error';
  const recoveryModel = recoveryHarnessModelAfterClaudeFailure();
  bridgeLogger.warn({ surface, kind, recoveryModel, err: err instanceof Error ? err.message : String(err) },
    'Claude brain terminal failure — switching the turn over to a non-Claude harness brain when available; the duplicate-send wall protects any committed write');
  detach?.();
  try {
    const recovered = await respondViaHarness(surface, request, {
      reuseRecordedUserInput: hasReusableRecordedUserInput(request.sessionId, request.message, request.runId),
      modelOverride: recoveryModel,
    });
    const route = routeDiagnosticsFromResponse(recovered);
    return route ? withRouteDiagnostics(recovered, { ...route, falloverFrom: 'claude_agent_sdk_brain' }) : recovered;
  } catch (falloverErr) {
    // The fallover brain ALSO failed terminally — no worse than not falling over. Return
    // null so the caller surfaces the original error (best-effort switch).
    bridgeLogger.warn({ surface, err: falloverErr instanceof Error ? falloverErr.message : String(falloverErr) },
      'brain fallover to the harness brain also failed — surfacing the original error');
    return null;
  }
}

type BuiltAgent = Awaited<ReturnType<typeof buildOrchestratorAgent>>;

/**
 * W1a — compute the chat step-boundary brain-fallover wiring for runConversation,
 * shared by respondViaHarness AND the Discord/Slack runner so BOTH chat lanes get
 * the same parity. Returns the ordered next-brain model ids + a factory that
 * rebuilds the orchestrator agent on a given brain. Gated by CLEMMY_BRAIN_FALLOVER
 * and best-effort — any resolution failure (or no other brain available) returns
 * {} so the caller keeps today's ask behavior. `buildAgent` is injected so the
 * caller supplies its own agent builder (and tests can stub it).
 */
export function buildChatFalloverWiring(opts: {
  userInput: string;
  sessionId: string;
  excludeToolNames?: string[];
  allowToolJit?: boolean;
  buildAgent: (o: { userInput?: string; sessionId: string; excludeToolNames?: string[]; model?: string; allowToolJit?: boolean }) => Promise<BuiltAgent>;
}): { falloverModelIds?: string[]; rebuildAgentForBrain?: (modelId: string) => Promise<BuiltAgent> } {
  if (!chatBrainFalloverEnabled()) return {};
  try {
    const currentProvider = providerFor(resolveRoleModel('brain').modelId) as BrainProviderClass | undefined;
    if (!currentProvider) return {};
    const nextBrains = falloverBrainModelIds(currentProvider);
    if (nextBrains.length === 0) return {};
    return {
      falloverModelIds: nextBrains.map((b) => b.modelId),
      rebuildAgentForBrain: (modelId: string) => opts.buildAgent({
        userInput: opts.userInput,
        sessionId: opts.sessionId,
        excludeToolNames: opts.excludeToolNames,
        model: modelId,
        allowToolJit: opts.allowToolJit ?? true,
      }),
    };
  } catch {
    return {};
  }
}
