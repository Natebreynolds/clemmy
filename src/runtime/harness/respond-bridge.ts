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
 *      blocks that surface. It never transfers the turn to another executor.
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
 * Known, accepted contract differences from the legacy loop (same trade the
 * workflow runner accepted when it converged):
 *   - `request.model` is ignored — the harness uses its configured model.
 *   - `runId` run-event streaming is not bridged; the harness writes its own
 *     richer event log instead. `onToolActivity` / `onReasoning` are relayed
 *     best-effort from harness events for legacy progress surfaces.
 */
import { runConversation, verifiedWorkflowRunDispatchReceipts, type RunConversationOptions } from './loop.js';
import { currentAcceptedReadAuthority } from '../read-path/accepted-read-authority.js';
import {
  resolveTurnCapabilityCandidates,
  type TurnCapabilityCandidates,
} from '../read-path/capability-candidates.js';
import {
  enrichAcceptedRequestWithTaskContinuity,
  inspectDurableMaterialSourceContinuation,
  mergeTurnCapabilityCandidates,
  prepareCheckedHostClarificationAnswer,
  prepareMaterialSourceVariantRecovery,
} from './task-continuity-runtime.js';
import {
  materiallyVariantSourceStrategyDecision,
  recordTurnPreflightDecision,
  sourceStrategyBindingsEqual,
  turnPreflightDecisionsEqual,
  validatedTurnSourceStrategyBinding,
  type TurnPreflightDecision,
  type TurnSourceStrategyBindingV1,
} from './turn-control.js';
import {
  confirmedSourceStrategyBindingForSource,
  exactSourceStrategyDecisionRowsForSource,
} from './source-strategy-admission.js';
import {
  PendingWorkflowChatDispatchOwnershipError,
  readPendingWorkflowChatDispatchOwnership,
  type PendingWorkflowChatDispatchOwnership,
} from '../../tools/workflow-run-queue.js';
import { buildOrchestratorAgent } from '../../agents/orchestrator.js';
import { executionLaneToolSearchEnabled } from '../../agents/tool-catalog.js';
import { configureHarnessRuntime } from './codex-client.js';
import {
  appendEvent,
  beginRunAttempt,
  clearKill,
  createSession,
  finishRunAttempt,
  getLatestRunAttempt,
  getLatestRunAttemptByRunId,
  getRunAttemptBySourceUserSeq,
  getSession,
  isKillRequested,
  listEvents,
  preserveCurrentKillAndClearStale,
  recordRunAttemptUserInput,
  requestKill,
  type EventRow,
} from './eventlog.js';
import { listPending, projectPendingApprovalUserDependency } from './approval-registry.js';
import { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain, isClaudeSdkUnparseableToolCall } from './claude-agent-brain.js';
import { buildContinueInput } from './continue-directive.js';
import { ClaudeSdkCapacityExhaustedError, ClaudeSdkProviderOverloadError } from './claude-agent-sdk.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import {
  getModelRoutingMode,
  getRuntimeEnv,
  withRuntimeConfigSnapshot,
} from '../../config.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import { falloverBrainModelIds, type BrainProviderClass } from './model-role-options.js';
import { resolveRoleModel } from './model-roles.js';
import { withRouteDiagnostics, routeDiagnosticsFromResponse } from './response-route.js';
import { resolveWriteEvidence, synthesizeTurnReport, synthesizeWorkReport } from './work-report.js';
import { nonFilterableToolExcludes } from './tool-policy.js';
import { recordHarnessCapabilityHealth } from './capability-health.js';
import pino from 'pino';
import { LOCAL_MCP_TOOL_NAMES } from '../../tools/catalog.js';
import { actionBus } from '../action-bus.js';
import type { AssistantRequest, AssistantResponse, AssistantRouteDiagnostics, ToolActivity } from '../../types.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  publicAsyncWorkDispatchedData,
  publicCompletionText,
  publicReplyText,
} from './public-presentation.js';
import { commitTurnOutcome } from './delivery-committer.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
  type TurnIdentity,
} from './turn-outcome.js';
import {
  exactTerminalForAcceptedSource,
  type AcceptedSourceTerminalOutcome,
} from './accepted-source-terminal.js';
import { clearRunInFlightAfterTerminal } from './restart-recovery.js';
import { recordAcceptedSourceGraph } from './record-accepted-source-graph.js';
import {
  InvalidFreshTurnEngineError,
  isHostTurnEngine,
  selectTurnEngine,
  type TurnEngineMode,
} from './turn-engine-selection.js';
import { semanticPortParticipated } from '../semantic-boundary/semantic-disposition.js';
import { typedClassificationFromLastInterpretation } from '../semantic-boundary/interpret-accepted-source.js';
import { warmReadToolPolicyDigest } from '../read-path/warm-read-policy.js';
import {
  assessCompletedAnswerReplay,
  isExplicitCompletedAnswerReplay,
  readCompletedAnswerReplayProtection,
  type CompletedAnswerReplayProtectionReader,
} from './completed-answer-replay.js';
export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli' | 'dashboard' | 'home' | 'workflow' | 'discord' | 'slack';

export interface RespondHarnessLimits {
  maxTurns?: number;
  maxSteps?: number;
}

const MATERIAL_SOURCE_AUTHORITY_BLOCKED_TEXT =
  'I stopped before contacting a source because the confirmed source choice could not be reconstructed exactly. No source provider call was started. Please confirm the source again.';

/** Persist/read back one exact consuming decision. The optional caller binding
 * may veto a forged disagreement, but can never supply authority: all bytes
 * written here come from the durable A/Q/B inspection. */
function persistVerifiedMaterialSourceDecision(input: {
  sessionId: string;
  sourceUserSeq: number;
  decision: TurnPreflightDecision;
  parentBinding: TurnSourceStrategyBindingV1;
  binding: TurnSourceStrategyBindingV1;
  callerBinding?: unknown;
}): boolean {
  if (input.callerBinding !== undefined) {
    const caller = validatedTurnSourceStrategyBinding(input.callerBinding);
    if (
      !caller
      || (
        !sourceStrategyBindingsEqual(caller, input.parentBinding)
        && !sourceStrategyBindingsEqual(caller, input.binding)
      )
    ) return false;
  }
  try {
    const before = exactSourceStrategyDecisionRowsForSource(input.sessionId, input.sourceUserSeq);
    if (before.length > 1) return false;
    if (before.length === 0) {
      recordTurnPreflightDecision(input.sessionId, input.decision, input.sourceUserSeq);
    } else if (
      !turnPreflightDecisionsEqual(
        before[0]!.data as unknown as TurnPreflightDecision,
        input.decision,
      )
    ) {
      return false;
    }
    const after = exactSourceStrategyDecisionRowsForSource(input.sessionId, input.sourceUserSeq);
    return after.length === 1
      && turnPreflightDecisionsEqual(
        after[0]!.data as unknown as TurnPreflightDecision,
        input.decision,
      )
      && sourceStrategyBindingsEqual(confirmedSourceStrategyBindingForSource(
        input.sessionId,
        input.sourceUserSeq,
      ), input.binding);
  } catch {
    return false;
  }
}

/** Persist/read back one non-authorizing replacement checkpoint. The exact
 * selector result is durable before runConversation is allowed to render Q2. */
function persistMaterialSourceVariantDecision(input: {
  sessionId: string;
  sourceUserSeq: number;
  decision: TurnPreflightDecision;
}): boolean {
  try {
    const before = exactSourceStrategyDecisionRowsForSource(input.sessionId, input.sourceUserSeq);
    if (before.length > 1) return false;
    if (before.length === 0) {
      recordTurnPreflightDecision(input.sessionId, input.decision, input.sourceUserSeq);
    } else if (!turnPreflightDecisionsEqual(
      before[0]!.data as unknown as TurnPreflightDecision,
      input.decision,
    )) {
      return false;
    }
    const after = exactSourceStrategyDecisionRowsForSource(input.sessionId, input.sourceUserSeq);
    return after.length === 1
      && after[0]!.role === 'system'
      && after[0]!.turn === 0
      && turnPreflightDecisionsEqual(
        after[0]!.data as unknown as TurnPreflightDecision,
        input.decision,
      )
      && input.decision.phase === 'align'
      && input.decision.sourceStrategyPosture === 'materially_variant'
      && confirmedSourceStrategyBindingForSource(input.sessionId, input.sourceUserSeq) === undefined;
  } catch {
    return false;
  }
}

function persistedMaterialSourceVariantDecision(input: {
  sessionId: string;
  sourceUserSeq: number;
  parentDecision: TurnPreflightDecision;
  parentBinding: TurnSourceStrategyBindingV1;
  acceptedAnswer: string;
}): { status: 'absent' } | { status: 'invalid' } | {
  status: 'ok';
  decision: TurnPreflightDecision;
  binding: TurnSourceStrategyBindingV1;
} {
  try {
    const rows = exactSourceStrategyDecisionRowsForSource(input.sessionId, input.sourceUserSeq);
    if (rows.length === 0) return { status: 'absent' };
    if (rows.length !== 1 || rows[0]!.role !== 'system' || rows[0]!.turn !== 0) {
      return { status: 'invalid' };
    }
    const decision = rows[0]!.data as unknown as TurnPreflightDecision;
    const binding = validatedTurnSourceStrategyBinding(decision.sourceStrategyBinding);
    if (!binding) return { status: 'invalid' };
    const expected = materiallyVariantSourceStrategyDecision({
      parentDecision: input.parentDecision,
      parentBinding: input.parentBinding,
      replacementBinding: binding,
      acceptedAnswer: input.acceptedAnswer,
    });
    return expected && turnPreflightDecisionsEqual(expected, decision)
      ? { status: 'ok', decision: expected, binding }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

async function observeAcceptedBridgeTurnGraph(
  surface: HarnessSurface,
  request: AssistantRequest,
  source: EventRow,
): Promise<void> {
  const acceptedText = typeof source.data.text === 'string'
    ? source.data.text
    : (request.displayMessage ?? request.message);
  await recordAcceptedSourceGraph({
    identity: {
      sessionId: request.sessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
    },
    surface,
    acceptedText,
    allowedToolNames: request.allowedToolNames,
    excludedToolNames: request.excludeToolNames,
    verifiedTaskContinuation: request.taskContinuation,
  });
}

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

/** Interactive chat lanes get the objective-completion judge (parity with
 *  desktop/Discord). Unattended lanes leave it off: their callers already own
 *  report-back honesty via verifyDelivered, and an in-loop judge with no
 *  human present only burns budget arguing with itself. */
const SURFACE_CONFIG: Record<HarnessSurface, { kind: 'chat' | 'execution'; judgeCompletion: boolean; honorModel?: boolean }> = {
  webhook: { kind: 'chat', judgeCompletion: true },
  cli: { kind: 'chat', judgeCompletion: true },
  cron: { kind: 'execution', judgeCompletion: false },
  // ONE LOOP, MANY BRAINS: the async lane honors the model the dispatcher
  // chose (createBackgroundTask({model}) was stored and then DISCARDED here —
  // every durable window ran on the global brain regardless of the master's
  // fleet plan). Same containment as workflow: only surfaces listed with
  // honorModel read request.model.
  background: { kind: 'execution', judgeCompletion: false, honorModel: true },
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

async function blockedPreRunResponse(
  surface: HarnessSurface,
  request: AssistantRequest,
  userText: string,
  details?: Record<string, unknown>,
): Promise<AssistantResponse> {
  const route = routeForHarness(surface, request);
  let committedText = PUBLIC_RUN_FAILURE_TEXT;
  let terminalCommitted = false;
  let preflightAttempt: ReturnType<typeof beginRunAttempt> | null = null;
  try {
    const code = typeof details?.reason === 'string' && details.reason.trim()
      ? details.reason.trim().replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()
      : 'preflight_block';
    recordHarnessCapabilityHealth({
      id: `respond_bridge_${code}`,
      state: 'unavailable',
      summary: 'Respond bridge preflight blocked a harness run before model or tool work started.',
      reason: `${surface}: ${code}`,
      sessionId: request.sessionId,
      details: {
        surface,
        route,
        requestedModel: request.model ?? null,
        runId: request.runId ?? null,
        ...details,
      },
    });

    if (!getSession(request.sessionId)) {
      const config = SURFACE_CONFIG[surface];
      const titleSeed = (request.displayMessage ?? request.message).trim().replace(/\s+/g, ' ');
      createSession({
        id: request.sessionId,
        kind: config.kind,
        channel: request.channel,
        userId: request.userId,
        title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
        metadata: { source: `bridge:${surface}` },
      });
    }
    preflightAttempt = beginRunAttempt(request.sessionId, { runId: request.runId });
    const sourceUserEvent = recordRunAttemptUserInput(preflightAttempt, {
      turn: 1,
      role: 'user',
      data: {
        text: request.displayMessage ?? request.message,
        ...(request.runId ? { runId: request.runId } : {}),
        ...(request.hostDirective === true ? { hostDirective: true } : {}),
        attemptId: preflightAttempt.attemptId,
        source: `bridge:${surface}`,
      },
    }, { existingEventSeq: request.sourceUserSeq, armRunInFlight: true });
    await observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
    // recordRunAttemptUserInput atomically accepted this source and armed
    // restart ownership. A failed terminal therefore cannot become live-only.
    const identity: TurnIdentity = {
      sessionId: request.sessionId,
      turn: sourceUserEvent.turn,
      sourceUserSeq: sourceUserEvent.seq,
    };
    committedText = commitTurnOutcomeImpl({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text: userText },
    }, {
      legacyReason: code,
      metadata: { transport: 'harness_preflight_block' },
    }).presentation.text;
    terminalCommitted = true;
  } catch {
    // Stable failure copy only. The proposed block text is not deliverable
    // without its durable terminal, and the in-flight marker remains armed.
  } finally {
    if (preflightAttempt) {
      try { finishRunAttempt(preflightAttempt, 'failed'); } catch { /* best effort */ }
    }
  }
  return withRouteDiagnostics({
    text: committedText,
    sessionId: request.sessionId,
    stoppedReason: terminalCommitted ? 'blocked' : 'error',
    raw: {
      blockedBy: 'harness_preflight',
      terminalCommitted,
      surface,
      ...details,
    },
  }, {
    ...route,
    transport: 'harness_preflight_block',
  });
}

function responseForWarmReadPolicyConflict(
  surface: HarnessSurface,
  request: AssistantRequest,
): AssistantResponse {
  return withRouteDiagnostics({
    text: 'This duplicate invocation had a different tool boundary, so I did not run it.',
    sessionId: request.sessionId,
    stoppedReason: 'error',
    raw: { readLane: { warm: false, policyConflict: true } },
  }, {
    ...routeForHarness(surface, request),
    transport: 'read_lane_policy_conflict',
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
    transport: 'host_harness',
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
type RecoveryListEventsFn = typeof listEvents;
type CommitTurnOutcomeFn = typeof commitTurnOutcome;
type ResolveTurnCandidatesFn = typeof resolveTurnCapabilityCandidates;
let runConversationImpl: RunConversationFn = runConversation;
let buildAgentImpl: BuildAgentFn = buildOrchestratorAgent;
let configureImpl: ConfigureFn = configureHarnessRuntime;
let claudeAgentBrainImpl: ClaudeAgentBrainFn = respondViaClaudeAgentSdkBrain;
// The standalone Claude brain is a retired execution owner. This test-only
// override keeps its rolling-upgrade failure reducer directly exercisable
// without reopening a production fork on chat, cron, or background. Injecting
// a transport stub never changes route policy.
let allowStandaloneClaudeInteractiveBrainForTests = false;
let recoveryListEventsImpl: RecoveryListEventsFn = listEvents;
let commitTurnOutcomeImpl: CommitTurnOutcomeFn = commitTurnOutcome;
let resolveTurnCandidatesImpl: ResolveTurnCandidatesFn = resolveTurnCapabilityCandidates;
let completedAnswerReplayProtectionImpl: CompletedAnswerReplayProtectionReader = readCompletedAnswerReplayProtection;
export function _setBridgeImplsForTests(impls: {
  runConversation?: RunConversationFn | null;
  buildAgent?: BuildAgentFn | null;
  configure?: ConfigureFn | null;
  claudeAgentBrain?: ClaudeAgentBrainFn | null;
  allowStandaloneClaudeInteractiveBrainForTests?: boolean;
  recoveryListEvents?: RecoveryListEventsFn | null;
  commitTurnOutcome?: CommitTurnOutcomeFn | null;
  completedAnswerReplayProtection?: CompletedAnswerReplayProtectionReader | null;
  resolveTurnCandidates?: ResolveTurnCandidatesFn | null;
}): void {
  runConversationImpl = impls.runConversation ?? runConversation;
  buildAgentImpl = impls.buildAgent ?? buildOrchestratorAgent;
  configureImpl = impls.configure ?? configureHarnessRuntime;
  claudeAgentBrainImpl = impls.claudeAgentBrain ?? respondViaClaudeAgentSdkBrain;
  allowStandaloneClaudeInteractiveBrainForTests = impls.allowStandaloneClaudeInteractiveBrainForTests ?? false;
  recoveryListEventsImpl = impls.recoveryListEvents ?? listEvents;
  commitTurnOutcomeImpl = impls.commitTurnOutcome ?? commitTurnOutcome;
  completedAnswerReplayProtectionImpl = impls.completedAnswerReplayProtection ?? readCompletedAnswerReplayProtection;
  resolveTurnCandidatesImpl = impls.resolveTurnCandidates ?? resolveTurnCapabilityCandidates;
}

/** Poll cadence for mapping the legacy `shouldCancel` callback onto the
 *  harness kill switch — matches the legacy runtime's own 2s cancel poll. */
const CANCEL_POLL_MS = 2_000;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolActivityFromHarnessEvent(event: EventRow): ToolActivity | null {
  // Native SDK calls also emit a transport-mirror row from the inner MCP
  // wrapper. That row remains durable audit evidence, but forwarding it would
  // double live progress counters/check-ins for one logical action.
  if (!isCanonicalTopLevelToolEvent(event, 'tool_called')) return null;
  const data = objectRecord(event.data);
  const rawName = data.tool ?? data.toolName;
  const toolName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'unknown_tool';
  // Activity is presentation, not execution replay. Commands, queries, paths,
  // URLs, and provider arguments remain on the private harness.event plane.
  return { toolName, input: {} };
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
    if (event.kind !== 'harness.public_event') return;
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
    const question = publicReplyText(data.question, '');
    if (!question) return null;
    const options = Array.isArray(data.options)
      ? (data.options as unknown[])
        .map((option) => publicReplyText(option, ''))
        .filter((option): option is string => option.length > 0)
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

function commitRecoveryCandidateTerminal(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
  steps: number;
  completedReason: 'no_structured_output' | 'sub_agent_stalled';
}): EventRow {
  const identity: TurnIdentity = {
    sessionId: input.sessionId,
    turn: Math.max(0, Math.trunc(input.sourceTurn)),
    sourceUserSeq: input.sourceUserSeq,
  };
  const completedWork = synthesizeCompletedWorkReport(input.sessionId, input.sourceUserSeq);
  if (completedWork) {
    return commitBridgeUnverifiedCompletionCandidate({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      sourceTurn: input.sourceTurn,
      text: completedWork.replace(
        /^I finished — here's what I did this turn:/,
        'Before the response stopped, the action ledger recorded:',
      ),
      reason: input.completedReason,
      metadata: { steps: input.steps },
      presentationAlreadyDiscloses: true,
    });
  }
  const text = input.completedReason === 'no_structured_output'
    ? 'I could not produce a safe final answer for that turn. The turn is closed; the activity log has the technical details.'
    : 'The run stopped before it produced a safe final answer. The run is closed; the activity log has the technical details.';
  const committed = commitTurnOutcomeImpl({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: false,
    presentation: { kind: 'blocked', text },
  }, {
    legacyReason: input.completedReason,
    metadata: { steps: input.steps },
  });
  return committed.event;
}

/** A recovery path observed completed work but could not produce its ordinary
 * final answer. Propose the work as a completion and name that gap; the shared
 * delivery rule is the only authority that may turn it into a human hold. */
function commitBridgeUnverifiedCompletionCandidate(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
  text: string;
  reason: string;
  metadata?: Record<string, unknown>;
  presentationAlreadyDiscloses?: boolean;
}): EventRow {
  const identity: TurnIdentity = {
    sessionId: input.sessionId,
    turn: Math.max(0, Math.trunc(input.sourceTurn)),
    sourceUserSeq: input.sourceUserSeq,
  };
  const committed = commitTurnOutcomeImpl({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: input.text },
  }, {
    legacyReason: input.reason,
    metadata: input.metadata,
    presentationAlreadyDiscloses: input.presentationAlreadyDiscloses,
    deliveryConcern: { reason: input.reason },
  });
  return committed.event;
}

interface AcceptedRecoveryTurn {
  attempt: {
    sessionId: string;
    attemptId: string;
    runId: string | null;
    startedAt: string;
  };
  sourceUserSeq: number;
  sourceTurn: number;
}

function logicalTurnIdentity(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
}): TurnIdentity {
  return {
    sessionId: input.sessionId,
    turn: Math.max(0, Math.trunc(input.sourceTurn)),
    sourceUserSeq: input.sourceUserSeq,
  };
}

/** Resolve the exact accepted event owned by the failed Claude request. In
 * production the SDK brain has already bound it atomically; the insert path is
 * the pre-dispatch-failure fallback and still binds before publication. */
async function ensureAcceptedRecoveryTurn(
  surface: HarnessSurface,
  request: AssistantRequest,
): Promise<AcceptedRecoveryTurn> {
  const displayMessage = request.displayMessage ?? request.message;
  if (!getSession(request.sessionId)) {
    const config = SURFACE_CONFIG[surface];
    const titleSeed = displayMessage.trim().replace(/\s+/g, ' ');
    createSession({
      id: request.sessionId,
      kind: config.kind,
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `bridge:recovery:${surface}` },
    });
  }
  const requestedSource = Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0
    ? listEvents(request.sessionId, {
        sinceSeq: Number(request.sourceUserSeq) - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === Number(request.sourceUserSeq))
    : undefined;
  if (request.sourceUserSeq !== undefined && !requestedSource) {
    throw new Error(`Accepted user event ${request.sourceUserSeq} is missing from session ${request.sessionId}.`);
  }
  const candidate = request.runId?.trim()
    ? getLatestRunAttemptByRunId(request.sessionId, request.runId.trim())
    : requestedSource
      ? getRunAttemptBySourceUserSeq(request.sessionId, requestedSource.seq)
      : getLatestRunAttempt(request.sessionId);
  const existing = candidate && (!requestedSource || candidate.sourceUserSeq === requestedSource.seq)
    ? candidate
    : null;
  const attempt = existing
    ? {
        sessionId: existing.sessionId,
        attemptId: existing.attemptId,
        runId: existing.runId,
        startedAt: existing.startedAt,
      }
    : beginRunAttempt(request.sessionId, { runId: requestedSource ? undefined : request.runId });
  const source = requestedSource ?? (existing?.sourceUserSeq
    ? listEvents(request.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === existing.sourceUserSeq)
    : null);
  const sourceUserEvent = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: displayMessage,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.hostDirective === true ? { hostDirective: true } : {}),
      attemptId: attempt.attemptId,
      source: 'bridge:recovery',
    },
  }, {
    existingEventSeq: source?.seq,
    // An existing physical attempt already armed its exact marker at accepted
    // source binding. Re-arming it here can overwrite a newer turn's owner when
    // this late wrapper is only replaying or reducing the older attempt.
    armRunInFlight: existing === null,
  });
  await observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
  return { attempt, sourceUserSeq: sourceUserEvent.seq, sourceTurn: sourceUserEvent.turn };
}

function exactTerminalForSource(
  sessionId: string,
  sourceUserSeq: number,
): AcceptedSourceTerminalOutcome | null {
  const source = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === sourceUserSeq);
  if (!source || source.role !== 'user' || source.data.synthetic === true) return null;
  return exactTerminalForAcceptedSource(source);
}

/** A source sequence is not a bearer token. Replay requires the literal
 * accepted input identity and, when supplied, the same external run/attempt
 * correlation that owned it. */
function durableSourceEventForRequest(request: AssistantRequest): EventRow | null {
  const sourceUserSeq = Number(request.sourceUserSeq);
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  return listEvents(request.sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === sourceUserSeq) ?? null;
}

function acceptedSourceIdentityForReplay(request: AssistantRequest): EventRow | null {
  const source = durableSourceEventForRequest(request);
  if (!source) return null;
  const sourceUserSeq = source.seq;
  const acceptedText = typeof source.data.text === 'string' ? source.data.text : null;
  if (acceptedText === null || acceptedText !== (request.displayMessage ?? request.message)) return null;
  const attempt = getRunAttemptBySourceUserSeq(request.sessionId, sourceUserSeq);
  if (!attempt) return null;
  const correlation = request.runId?.trim();
  if (correlation && attempt.runId !== correlation && attempt.attemptId !== correlation) return null;
  return source;
}

function exactTerminalReplayForRequest(request: AssistantRequest): AcceptedSourceTerminalOutcome | null {
  const source = acceptedSourceIdentityForReplay(request);
  return source ? exactTerminalForAcceptedSource(source) : null;
}

function settleExactTerminalReplayOwnership(
  request: AssistantRequest,
  terminal: AcceptedSourceTerminalOutcome,
): void {
  const source = acceptedSourceIdentityForReplay(request);
  if (!source) return;
  const row = getRunAttemptBySourceUserSeq(request.sessionId, source.seq);
  if (row && !row.finishedAt) {
    const attempt = {
      sessionId: row.sessionId,
      attemptId: row.attemptId,
      runId: row.runId,
      startedAt: row.startedAt,
    };
    const status = terminal.presentation.status === 'cancelled'
      ? 'cancelled'
      : terminal.presentation.status === 'failed'
          || terminal.presentation.status === 'blocked'
          || terminal.presentation.status === 'uncertain'
        ? 'failed'
        : 'completed';
    try { finishRunAttempt(attempt, status); } catch { /* terminal remains authoritative */ }
  }
  clearRunInFlightAfterTerminal(request.sessionId, row?.attemptId, source.seq);
}

/** Canonical warm tool lifecycle is also the durable paid-call no-retry
 * marker. It survives a Stop, supersession, or terminal-commit failure that
 * intentionally leaves no old-source public terminal. */
function exactWarmProviderSpentForRequest(request: AssistantRequest): EventRow | null {
  const source = acceptedSourceIdentityForReplay(request);
  if (!source) return null;
  return listEvents(request.sessionId, { types: ['tool_returned'], desc: true })
    .find((event) => event.seq > source.seq
      && event.data.warmRead === true
      && event.data.providerDispatched === true
      && event.data.sourceUserSeq === source.seq)
    ?? null;
}

function durableWarmReadPolicyMatches(request: AssistantRequest, event: EventRow): boolean {
  const transport = typeof event.data.transport === 'string' ? event.data.transport : '';
  const isWarm = event.data.warmRead === true
    || transport === 'read_lane_warm'
    || transport === 'read_lane_warm_spent';
  if (!isWarm) return true;
  return event.data.warmReadPolicyDigest === warmReadToolPolicyDigest(request);
}

function stoppedReasonForPresentation(
  presentation: PresentationEvent,
): NonNullable<AssistantResponse['stoppedReason']> {
  if (presentation.status === 'done') return 'success';
  if (presentation.status === 'cancelled') return 'cancelled';
  if (presentation.status === 'blocked' || presentation.status === 'uncertain') return 'blocked';
  if (presentation.status !== 'needs_input') return 'error';
  if (presentation.needs?.kind === 'approval') return 'pending-approval';
  if (presentation.needs?.kind === 'continue') return 'max-turns-with-grace';
  return 'awaiting-input';
}

function responseForCommittedTerminal(
  event: EventRow,
  extraRaw?: Record<string, unknown>,
): AssistantResponse {
  let presentation: PresentationEvent | null = null;
  try { presentation = presentationEventFromCompletionData(event.data); } catch { presentation = null; }
  const text = presentation?.text ?? publicCompletionText(event.data, PUBLIC_RUN_FAILURE_TEXT);
  return {
    text,
    sessionId: event.sessionId,
    stoppedReason: presentation ? stoppedReasonForPresentation(presentation) : 'error',
    turnsUsed: event.turn,
    ...(presentation?.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
    ...(extraRaw ? { raw: extraRaw } : {}),
  };
}

function responseForAcceptedSourceTerminal(
  terminal: AcceptedSourceTerminalOutcome,
  extraRaw?: Record<string, unknown>,
): AssistantResponse {
  const { event, presentation } = terminal;
  return {
    text: presentation.text,
    sessionId: event.sessionId,
    stoppedReason: stoppedReasonForPresentation(presentation),
    turnsUsed: event.turn,
    ...(presentation.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
    ...(extraRaw ? { raw: extraRaw } : {}),
  };
}

/** A transport retry for an already-published accepted source is a pure
 * durable replay. It must not create a new attempt, rebuild warm ports, or run
 * a brain merely to lose a second exactly-once commit race. */
function responseForExactTerminalReplay(
  surface: HarnessSurface,
  request: AssistantRequest,
  terminal: AcceptedSourceTerminalOutcome,
): AssistantResponse {
  const { event } = terminal;
  const response = responseForAcceptedSourceTerminal(terminal, {
    terminalReplay: true,
    sourceUserSeq: request.sourceUserSeq,
  });
  const priorTransport = readRawString(event.data, 'transport');
  if (priorTransport === 'read_lane_warm') {
    return withRouteDiagnostics(response, {
      routeKind: 'harness',
      surface,
      requestedModel: request.model,
      effectiveModel: 'read-lane-warm',
      provider: 'verified-procedure',
      transport: 'read_lane_warm',
      mode: getModelRoutingMode(),
    });
  }
  if (
    priorTransport === 'completed_answer_replay'
    || priorTransport === 'completed_continuation_replay'
  ) {
    return withRouteDiagnostics({ ...response, turnsUsed: 0 }, completedAnswerReplayRoute(surface));
  }
  return withRouteDiagnostics(response, {
    ...routeForHarness(surface, request),
    transport: priorTransport ?? 'committed_terminal_replay',
  });
}

function responseForExactTerminalReplayUnderPolicy(
  surface: HarnessSurface,
  request: AssistantRequest,
  terminal: AcceptedSourceTerminalOutcome,
): AssistantResponse {
  return durableWarmReadPolicyMatches(request, terminal.event)
    ? responseForExactTerminalReplay(surface, request, terminal)
    : responseForWarmReadPolicyConflict(surface, request);
}

function responseForUnverifiableTerminalLedger(
  surface: HarnessSurface,
  request: AssistantRequest,
): AssistantResponse {
  return withRouteDiagnostics({
    text: 'I could not verify the existing terminal state for this request, so I stopped before running it again.',
    sessionId: request.sessionId,
    stoppedReason: 'blocked',
    turnsUsed: 0,
    raw: { terminalReplay: true, ledger: 'unreadable' },
  }, routeForHarness(surface, request));
}

function responseForWarmProviderSpentReplay(
  surface: HarnessSurface,
  request: AssistantRequest,
): AssistantResponse {
  return withRouteDiagnostics({
    text: 'That read already contacted the provider but did not publish a safe result, so I did not run it again.',
    sessionId: request.sessionId,
    stoppedReason: 'cancelled',
    raw: { readLane: { warm: true, spent: true, durableReplayBlock: true } },
  }, {
    routeKind: 'harness',
    surface,
    requestedModel: request.model,
    effectiveModel: 'read-lane-warm',
    provider: 'verified-procedure',
    transport: 'read_lane_warm_spent_replay',
    mode: getModelRoutingMode(),
  });
}

function responseForAcceptedSourceIdentityMismatch(
  surface: HarnessSurface,
  request: AssistantRequest,
): AssistantResponse {
  return withRouteDiagnostics({
    text: 'This invocation did not match the accepted turn identity, so I did not run or replay it.',
    sessionId: request.sessionId,
    stoppedReason: 'error',
    raw: { blockedBy: 'accepted_source_identity_mismatch' },
  }, {
    ...routeForHarness(surface, request),
    transport: 'accepted_source_identity_mismatch',
  });
}

function completedAnswerReplayRoute(
  surface: HarnessSurface,
): AssistantRouteDiagnostics {
  return {
    routeKind: 'harness',
    surface,
    transport: 'completed_answer_replay',
  };
}

function responseForCompletedAnswerReplay(
  surface: HarnessSurface,
  event: EventRow,
  raw: Record<string, unknown>,
): AssistantResponse {
  return withRouteDiagnostics({
    ...responseForCommittedTerminal(event, raw),
    // This lane ran no model/tool turn. Event.turn is logical transcript
    // identity, not usage, so do not expose it as paid turns here.
    turnsUsed: 0,
  }, completedAnswerReplayRoute(surface));
}

/**
 * An explicit request to repeat the prior completed answer is a read of
 * durable presentation state, not a reason to invoke another brain. The
 * strict audit deliberately runs only for an already-accepted source and
 * before auth, capability retrieval, provider routing, or tool assembly.
 */
async function tryServeCompletedAnswerReplay(
  surface: HarnessSurface,
  request: AssistantRequest,
): Promise<AssistantResponse | null> {
  // Preserve the synchronous fall-through timing of every ordinary request.
  // The strict assessor repeats this check, but reaching its first await for a
  // cron/background prompt would otherwise add a microtask to unrelated work.
  const acceptedText = request.displayMessage ?? request.message;
  if (!isExplicitCompletedAnswerReplay(acceptedText)) return null;
  const authority = currentAcceptedReadAuthority(
    request.sessionId,
    request.sourceUserSeq,
    request.runId,
    acceptedText,
  );
  if (!authority) return null;
  const candidate = await assessCompletedAnswerReplay({
    authority,
    readProtection: completedAnswerReplayProtectionImpl,
  });
  if (!candidate) return null;

  try {
    // The cross-store protection read can await module/file state. Re-prove
    // exact active ownership immediately before publication.
    const current = currentAcceptedReadAuthority(
      request.sessionId,
      request.sourceUserSeq,
      request.runId,
      acceptedText,
    );
    if (!current || current.attempt.attemptId !== authority.attempt.attemptId) return null;
    const identity: TurnIdentity = {
      sessionId: request.sessionId,
      turn: current.source.turn,
      sourceUserSeq: current.source.seq,
      attemptId: current.attempt.attemptId,
      ...(current.attempt.runId ? { runId: current.attempt.runId } : {}),
    };
    const committed = commitTurnOutcomeImpl({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: candidate.text },
    }, {
      legacyReason: 'completed_answer_replay',
      metadata: {
        steps: 0,
        transport: 'completed_answer_replay',
        replayedFromSourceUserSeq: candidate.priorSource.seq,
        replayedFromTerminalId: candidate.priorTerminal.id,
        replayedFromPresentationId: candidate.priorPresentationId,
      },
    });
    if (!committed.inserted) {
      try { finishRunAttempt(current.attempt, 'superseded'); } catch { /* telemetry */ }
      clearRunInFlightAfterTerminal(
        request.sessionId,
        current.attempt.attemptId,
        current.source.seq,
      );
      return responseForExactTerminalReplayUnderPolicy(surface, request, {
        kind: 'terminal',
        event: committed.event,
        presentation: committed.presentation,
      });
    }
    await observeAcceptedBridgeTurnGraph(surface, request, current.source);
    try { finishRunAttempt(current.attempt, 'completed'); } catch { /* telemetry */ }
    clearRunInFlightAfterTerminal(
      request.sessionId,
      current.attempt.attemptId,
      current.source.seq,
    );
    return responseForCompletedAnswerReplay(surface, committed.event, {
      completedAnswerReplay: true,
      replayedFromSourceUserSeq: candidate.priorSource.seq,
      replayedFromTerminalId: candidate.priorTerminal.id,
    });
  } catch {
    // The committer may have won before a later bookkeeping error. Re-read the
    // current logical terminal before allowing ordinary work to proceed.
    try {
      const winner = exactTerminalReplayForRequest(request);
      if (winner) {
        try { finishRunAttempt(authority.attempt, 'completed'); } catch { /* telemetry */ }
        clearRunInFlightAfterTerminal(
          request.sessionId,
          authority.attempt.attemptId,
          authority.source.seq,
        );
        return responseForExactTerminalReplayUnderPolicy(surface, request, winner);
      }
    } catch {
      return responseForUnverifiableTerminalLedger(surface, request);
    }
    return null;
  }
}

/**
 * The model's own closing words for the turn that performed a dispatch.
 *
 * The dispatched reply used to be only the projection's canned line ("Started —
 * I'll post the result here when it's ready"), and the model's actual final
 * message for that turn was discarded. Observed 2026-08-25: the discarded
 * message read "this workflow has been blocking/cancelling repeatedly today…" —
 * exactly what the owner needed to hear, replaced by boilerplate. The owner's
 * standing rule is the model's voice, never a template.
 *
 * Composed from DURABLE turn_ended events only, so a restart replay derives the
 * identical text — which is also why the words must never ride on the
 * async_work_dispatched event itself: that event is deep-strict-equal-checked
 * against its replay winner, and free text minted at dispatch time would
 * conflict with the rebuilt copy.
 *
 * Falls back to the canned line when the turn recorded no words, so the ACK
 * floor never regresses.
 */
export function composeDispatchedReplyText(
  source: EventRow,
  fallback: string,
): string {
  try {
    let words = '';
    for (const event of listEvents(source.sessionId, { types: ['turn_ended'] })) {
      if (event.turn !== source.turn || event.seq <= source.seq) continue;
      const output = (event.data as { output?: unknown }).output;
      if (typeof output === 'string' && output.trim()) words = output.trim();
    }
    return words || fallback;
  } catch {
    return fallback;
  }
}

function exactAsyncDispatchForSource(source: EventRow): ReturnType<typeof publicAsyncWorkDispatchedData> {
  const verifiedEventIds = new Set(
    verifiedWorkflowRunDispatchReceipts(source.sessionId, source.turn, source.seq)
      .map((receipt) => receipt.eventId),
  );
  for (const event of listEvents(source.sessionId, { types: ['async_work_dispatched'], desc: true })) {
    const dispatch = publicAsyncWorkDispatchedData(event.data);
    if (
      dispatch
      && verifiedEventIds.has(event.id)
      && event.role === 'system'
      && event.seq > source.seq
      && event.turn === source.turn
      && dispatch.sourceUserSeq === source.seq
    ) return dispatch;
  }
  return null;
}

const RESTART_OWNED_WORKFLOW_DISPATCH_REPLY =
  'Background work was admitted for this request, but its dispatch still needs exact recovery before it can run. I preserved the original request and will resume that same work rather than creating a replacement.';

const TYPED_EXECUTION_HELD_REPLY =
  'This exact task is still owned by Clem\'s recovery system. I did not start a duplicate attempt; the existing work will continue from its durable checkpoint.';

type RestartOwnedWorkflowDispatchState =
  | { kind: 'pending'; ownership: PendingWorkflowChatDispatchOwnership }
  | { kind: 'unreadable' };

function restartOwnedWorkflowDispatchState(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RestartOwnedWorkflowDispatchState | null {
  try {
    const ownership = readPendingWorkflowChatDispatchOwnership(input);
    return ownership ? { kind: 'pending', ownership } : null;
  } catch {
    // The source-group store is part of the no-terminal proof. An unreadable
    // attributable state must retain restart ownership instead of falling
    // through to the bridge's ordinary failed-terminal reducer.
    return { kind: 'unreadable' };
  }
}

function restartOwnedWorkflowDispatchResponse(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
  state: RestartOwnedWorkflowDispatchState;
  transport: string;
}): AssistantResponse {
  appendEvent({
    sessionId: input.sessionId,
    turn: input.sourceTurn,
    role: 'system',
    type: 'run_paused',
    data: {
      reason: input.state.kind === 'pending'
        ? 'prepared_workflow_dispatch_restart_owned'
        : 'prepared_workflow_dispatch_ownership_unreadable',
      sourceUserSeq: input.sourceUserSeq,
      resumable: true,
      ...(input.state.kind === 'pending' ? {
        sourceGroupId: input.state.ownership.sourceGroupId,
        phase: input.state.ownership.phase,
        runIds: input.state.ownership.runIds,
      } : {}),
      guidance: RESTART_OWNED_WORKFLOW_DISPATCH_REPLY,
    },
  });
  return {
    text: RESTART_OWNED_WORKFLOW_DISPATCH_REPLY,
    sessionId: input.sessionId,
    stoppedReason: 'awaiting-input',
    raw: {
      transport: input.transport,
      asyncWork: {
        status: 'restart_owned',
        ...(input.state.kind === 'pending' ? {
          sourceGroupId: input.state.ownership.sourceGroupId,
          runIds: [...input.state.ownership.runIds],
        } : { evidence: 'unreadable' }),
      },
    },
  };
}

function commitBridgeBlockedTerminal(input: {
  request: AssistantRequest;
  turn: AcceptedRecoveryTurn;
  text: string;
  reason: string;
  metadata?: Record<string, unknown>;
  resumable?: boolean;
}): EventRow {
  const identity = logicalTurnIdentity({
    sessionId: input.request.sessionId,
    sourceUserSeq: input.turn.sourceUserSeq,
    sourceTurn: input.turn.sourceTurn,
  });
  const committed = commitTurnOutcomeImpl({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: input.resumable ?? true,
    presentation: { kind: 'blocked', text: input.text },
  }, {
    legacyReason: input.reason,
    metadata: input.metadata,
  });
  return committed.event;
}

function commitBridgeFailedTerminal(input: {
  request: AssistantRequest;
  turn: AcceptedRecoveryTurn;
  reason: string;
  transport: string;
}): EventRow {
  const identity = logicalTurnIdentity({
    sessionId: input.request.sessionId,
    sourceUserSeq: input.turn.sourceUserSeq,
    sourceTurn: input.turn.sourceTurn,
  });
  const committed = commitTurnOutcomeImpl({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'failed',
    resumable: false,
    presentation: { kind: 'error', text: PUBLIC_RUN_FAILURE_TEXT },
  }, {
    legacyReason: input.reason,
    metadata: { transport: input.transport },
  });
  return committed.event;
}

export async function respondViaHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  opts: {
    reuseRecordedUserInput?: boolean;
    sourceUserSeq?: number;
    modelOverride?: string;
    /** Frozen above eager resolution so one accepted source cannot change
     * engines after an env reload or a provider fallover. */
    turnEngine?: TurnEngineMode;
    /** Optional one-shot smoke/eval limits; ordinary surfaces omit these. */
    maxTurns?: number;
    maxSteps?: number;
  } = {},
): Promise<AssistantResponse> {
  const config = SURFACE_CONFIG[surface];
  const sessionId = request.sessionId;
  const acceptedSourceUserSeq = opts.sourceUserSeq ?? request.sourceUserSeq;
  const displayMessage = request.displayMessage ?? request.message;

  if (!getSession(sessionId)) {
    const titleSeed = displayMessage.trim().replace(/\s+/g, ' ');
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
      text: displayMessage,
      ...(displayMessage !== request.message ? { modelDirectiveApplied: true } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
      attemptId: requestAttempt.attemptId,
      source: `bridge:${surface}`,
    },
  }, { existingEventSeq: acceptedSourceUserSeq, armRunInFlight: true });
  // Rehydrate private continuation state only from the exact durable source
  // BEFORE its first graph is persisted. A clarification answer is semantically
  // the durable A/Q/B capsule, not the bare B bytes: persisting B first and then
  // asking runConversation to observe the verified continuation creates two
  // incompatible lineages for one accepted source and correctly fails closed.
  // Caller-supplied semantic context is stripped when no valid packet exists.
  const hostOwnsTurn = Boolean(opts.turnEngine && isHostTurnEngine(opts.turnEngine));
  const callerSourceStrategyBinding = request.turnCandidates?.sourceStrategyBinding;
  if (hostOwnsTurn) {
    await prepareCheckedHostClarificationAnswer({
      sessionId: request.sessionId,
      sourceUserSeq: sourceUserEvent.seq,
      turn: sourceUserEvent.turn,
      surface,
    });
  }
  const typedClassification = semanticPortParticipated(request.sessionId, sourceUserEvent.seq)
    ? (typedClassificationFromLastInterpretation(request.sessionId, sourceUserEvent.seq) ?? { keepOpen: true as const })
    : undefined;
  const requestBeforeContinuity = request;
  request = await enrichAcceptedRequestWithTaskContinuity(request, sourceUserEvent.seq, {
    ...(hostOwnsTurn ? { continuationOnly: true, resolveCandidates: false } : {}),
    typedClassification,
  });
  // Keep the literal Q/B user item byte-exact. The exact durable packet and
  // admitted visible option may mint one transient system steer; caller-
  // supplied semantic context was stripped/rebuilt at the boundary above.
  const verifiedMetaContinuationSteer = typedClassification
    && 'keepOpen' in typedClassification
    && typedClassification.metaAction
    && request.taskContinuationResolved === true
    && request.semanticTaskInput?.startsWith('[task-continuation-meta:v1]\n')
    ? request.semanticTaskInput
    : undefined;
  if (hostOwnsTurn) {
    const materialSource = inspectDurableMaterialSourceContinuation({
      sessionId,
      sourceUserSeq: sourceUserEvent.seq,
    });
    let materialSourceAuthorityValid = materialSource.status !== 'refused';
    if (materialSource.status === 'verified') {
      // The exact lineage and retained schema were proved before candidate
      // resolution. Resolution may now run as advisory context; it cannot
      // author or alter the consuming decision below.
      request = await enrichAcceptedRequestWithTaskContinuity(
        requestBeforeContinuity,
        sourceUserEvent.seq,
        { continuationOnly: true, typedClassification },
      );
      materialSourceAuthorityValid = persistVerifiedMaterialSourceDecision({
        sessionId,
        sourceUserSeq: sourceUserEvent.seq,
        decision: materialSource.decision,
        parentBinding: materialSource.parentBinding,
        binding: materialSource.binding,
        ...(callerSourceStrategyBinding !== undefined
          ? { callerBinding: callerSourceStrategyBinding }
          : {}),
      });
    } else if (materialSource.status === 'variant') {
      // A checked semantic slot answer can reject A and name B, but it cannot
      // approve B. Reuse a previously persisted Q2 checkpoint on replay;
      // otherwise run the existing fresh selector once and persist its exact
      // non-authorizing result before runConversation is entered.
      const persisted = persistedMaterialSourceVariantDecision({
        sessionId,
        sourceUserSeq: sourceUserEvent.seq,
        parentDecision: materialSource.parentDecision,
        parentBinding: materialSource.parentBinding,
        acceptedAnswer: materialSource.context.answer,
      });
      if (persisted.status === 'invalid') {
        materialSourceAuthorityValid = false;
      } else if (persisted.status === 'ok') {
        request = {
          ...request,
          semanticTaskInput: materialSource.context.retrievalQuery,
          taskContinuation: { ...materialSource.context, capabilities: [] },
          taskContinuationResolved: true,
          turnCandidates: {
            candidates: [],
            requirements: [],
            matches: [],
            pinnedTools: [],
            semanticApplied: false,
            sourceStrategyBinding: persisted.binding,
          },
        };
      } else {
        let resolved: TurnCapabilityCandidates = {
          candidates: [],
          requirements: [],
          matches: [],
          pinnedTools: [],
          semanticApplied: false,
        };
        try {
          resolved = await resolveTurnCandidatesImpl({
            userInput: materialSource.context.retrievalQuery,
          });
        } catch {
          // A selector failure cannot widen authority. The typed correction is
          // retained, but no Q2 or provider work starts without one unique live
          // replacement.
        }
        const prepared = prepareMaterialSourceVariantRecovery({
          inspection: materialSource,
          resolved,
        });
        if (prepared.status !== 'ready') {
          materialSourceAuthorityValid = false;
        } else {
          materialSourceAuthorityValid = persistMaterialSourceVariantDecision({
            sessionId,
            sourceUserSeq: sourceUserEvent.seq,
            decision: prepared.decision,
          });
          if (materialSourceAuthorityValid) {
            request = {
              ...request,
              semanticTaskInput: prepared.context.retrievalQuery,
              taskContinuation: prepared.context,
              taskContinuationResolved: true,
              turnCandidates: prepared.turnCandidates,
            };
          }
        }
      }
      // This source is intentionally still unconfirmed. The align decision is
      // consumed by runConversation's preflight publisher, which returns Q2
      // before the business model or host runner can run.
    } else if (materialSource.status === 'not_applicable' && request.taskContinuation) {
      // Ordinary clarification continuations retain their existing one-resolve
      // behavior, but only after the durable A/Q/B edge has been inspected.
      request = await enrichAcceptedRequestWithTaskContinuity(
        requestBeforeContinuity,
        sourceUserEvent.seq,
        { continuationOnly: true, typedClassification },
      );
    }
    if (!materialSourceAuthorityValid) {
      const terminal = commitBridgeBlockedTerminal({
        request,
        turn: {
          attempt: requestAttempt,
          sourceUserSeq: sourceUserEvent.seq,
          sourceTurn: sourceUserEvent.turn,
        },
        text: MATERIAL_SOURCE_AUTHORITY_BLOCKED_TEXT,
        reason: 'material_source_authority_invalid',
        metadata: { transport: 'host_harness' },
      });
      try { finishRunAttempt(requestAttempt, 'failed'); } catch { /* terminal is authoritative */ }
      clearRunInFlightAfterTerminal(sessionId, requestAttempt.attemptId, sourceUserEvent.seq);
      return withRouteDiagnostics(
        responseForCommittedTerminal(terminal, { failure: 'material_source_authority_invalid' }),
        routeForHarness(surface, request, opts.modelOverride),
      );
    }
  }
  // Fresh host turns deliberately skip the bridge's eager capability lookup:
  // accepted source -> context node -> capability_resolve node -> first model
  // step is the owned order. The old cutover left no replacement lookup at
  // capability_resolve, however, so learned candidates silently disappeared
  // from every ordinary host_v1 agent surface. Resolve exactly once, lazily,
  // from the accepted build callback and share that same promise with every
  // fallover rebuild. A retrieval failure remains advisory-only: existing
  // caller/continuation candidates survive, while no candidate ever grants
  // dispatch authority.
  const resolveFreshHostCandidates = hostOwnsTurn
    && request.taskContinuation === undefined
    && !(typedClassification && 'keepOpen' in typedClassification);
  if (resolveFreshHostCandidates && request.turnCandidates?.sourceStrategyBinding) {
    const { sourceStrategyBinding: _callerBinding, ...withoutCallerBinding } = request.turnCandidates;
    request = { ...request, turnCandidates: withoutCallerBinding };
  }
  let acceptedTurnCandidatesPromise: Promise<TurnCapabilityCandidates | undefined> | undefined;
  const candidatesForAcceptedBuild = (): Promise<TurnCapabilityCandidates | undefined> => {
    if (!resolveFreshHostCandidates) return Promise.resolve(request.turnCandidates);
    if (!acceptedTurnCandidatesPromise) {
      acceptedTurnCandidatesPromise = (async () => {
        const acceptedText = typeof sourceUserEvent.data.text === 'string'
          ? sourceUserEvent.data.text
          : '';
        let resolved: TurnCapabilityCandidates = {
          candidates: [],
          requirements: [],
          matches: [],
          pinnedTools: [],
          semanticApplied: false,
        };
        try {
          resolved = await resolveTurnCandidatesImpl({
            userInput: acceptedText,
          });
        } catch {
          // Candidate recall is context, never execution authority. A broken
          // advisory tier must not fail or broaden the accepted turn.
        }
        // Candidate recall is advisory context. Fresh turns cannot acquire a
        // durable source strategy (or historical arguments) from this tier;
        // exact call authority is minted later from the accepted task and its
        // current logical call. Explicit, verified A/Q/B continuations were
        // handled above and remain the only lane that carries a source binding.
        const { sourceStrategyBinding: _advisoryBinding, ...advisoryResolved } = resolved;
        const merged = request.turnCandidates
          ? mergeTurnCapabilityCandidates(request.turnCandidates, advisoryResolved)
          : advisoryResolved;
        request = { ...request, turnCandidates: merged };
        return merged;
      })();
    }
    return acceptedTurnCandidatesPromise;
  };
  if (!opts.turnEngine || !isHostTurnEngine(opts.turnEngine)) {
    await observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
  }
  // Advisory candidate resolution cannot commit source authority, so
  // failures while building the agent/tool surface remain restart-recoverable.
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
  let preserveRequestAttemptOwnership = false;
  try {
    const modelForRun = opts.modelOverride ?? (config.honorModel && request.model ? request.model : undefined);
    // A verified clarification continuation may carry a richer private query
    // for retrieval/tool ranking. The actual user turn remains request.message
    // all the way into runConversation and the provider prompt.
    // Capability interior (Clem 4): the agent is BUILT at the spine's
    // capability_resolve node, not before the turn — tool/capability assembly
    // is graph work with a real trace step. Same builder, same arguments,
    // moved in time; the fallover wiring keeps its own builder for rebuilds.
    let acceptedBuildIdentity: Parameters<NonNullable<RunConversationOptions['buildAgent']>>[0] | undefined;
    const buildAgent: NonNullable<RunConversationOptions['buildAgent']> = async (identity) => {
      acceptedBuildIdentity = identity;
      // The loop's closed-world proof has already sealed this accepted source
      // to a zero-tool conversation surface. Live capability recall cannot
      // affect that build, so do not read action-only learning/catalog stores.
      // Caller-supplied advisory context remains intact; every non-plain build
      // retains the existing one-resolution promise.
      const turnCandidates = identity.hostPlainConversation
        ? request.turnCandidates
        : await candidatesForAcceptedBuild();
      return buildAgentImpl({
        userInput: request.message,
        sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        ...(identity.route ? { acceptedRoute: identity.route } : {}),
        ...(identity.hostFreshPlanning ? { hostFreshPlanning: identity.hostFreshPlanning } : {}),
        ...(identity.hostPlainConversation ? { hostPlainConversation: true as const } : {}),
        allowedToolNames: request.allowedToolNames,
        excludeToolNames: request.excludeToolNames,
        // The turn's advisory capability candidates ride the request into the
        // agent build — the only delivery path, shared by both brains.
        ...(turnCandidates ? { turnCandidates } : {}),
        ...(request.taskContinuation ? { taskContinuation: request.taskContinuation } : {}),
        ...(request.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
        // Only surfaces flagged honorModel forward request.model (workflow steps);
        // every other surface keeps the harness's configured model (byte-identical).
        ...(modelForRun ? { model: modelForRun } : {}),
        // Schema-on-demand lane admission. Chat always qualifies. Execution
        // surfaces (cron / background / workflow) qualify only while the
        // deferred tool-search surface is globally ON — recovery there is the
        // model calling tool_search → call_tool, which needs no user in the
        // loop. When tool-search is off, execution lanes stay on the FULL
        // surface: the legacy JIT pruner has no catalog recovery and must
        // never run on an unattended lane. Kill-switch:
        // CLEMMY_EXECUTION_TOOL_SEARCH=off (execution lanes only).
        allowToolJit: config.kind === 'chat'
          || (config.kind === 'execution' && executionLaneToolSearchEnabled()),
      });
    };
    // W1a — chat step-boundary brain fallover. On a CHAT surface, hand
    // runConversation the ordered next-brain
    // model ids + a rebuild factory so a transient model/codex error mid-turn
    // re-dispatches to the next brain instead of immediately asking. Best-effort
    // + gated by CLEMMY_BRAIN_FALLOVER; absence = today's ask behavior.
    const fallover = config.kind === 'chat'
      ? buildChatFalloverWiring({
          userInput: request.message,
          sessionId,
          allowedToolNames: request.allowedToolNames,
          excludeToolNames: request.excludeToolNames,
          allowToolJit: true,
          ...(request.turnCandidates ? { turnCandidates: request.turnCandidates } : {}),
          ...(resolveFreshHostCandidates ? { turnCandidatesForBuild: candidatesForAcceptedBuild } : {}),
          ...(request.taskContinuation ? { taskContinuation: request.taskContinuation } : {}),
          ...(request.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
          acceptedIdentity: () => acceptedBuildIdentity,
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
          sourceUserSeq: sourceUserEvent.seq,
          attemptId: requestAttempt.attemptId,
        },
      });
    } catch { /* telemetry only */ }
    // Parse-exhaustion recovery uses the same fail-closed lifecycle ledger as
    // Claude whole-turn fallover. A count of legacy success rows is not enough:
    // succeeded/orphaned settlements and an unreadable ledger must also forbid
    // replay, while an exact proven-no-dispatch failure may compensate only its
    // own reservation.
    const parseRecoveryBaseline = captureRecoveryLedgerBaseline(sessionId);
    // Raw executor output is private regardless of its textual shape. In
    // particular, a model-authored {"reply":"..."} envelope is still only a
    // proposal: retries, judges, and effect verification can replace it. The
    // terminal TurnOutcome committer publishes the authoritative presentation.
    const result = await runConversationImpl({
      buildAgent,
      sessionId,
      input: request.message,
      ...(request.semanticTaskInput ? { semanticTaskInput: request.semanticTaskInput } : {}),
      ...(verifiedMetaContinuationSteer
        ? { continuationSteer: verifiedMetaContinuationSteer }
        : {}),
      ...(request.taskContinuation ? { taskContinuation: request.taskContinuation } : {}),
      ...(request.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
      sourceUserSeq: sourceUserEvent.seq,
      runAttemptId: requestAttempt.attemptId,
      turnEngine: opts.turnEngine,
      maxTurns: opts.maxTurns,
      maxSteps: opts.maxSteps,
      maxWallClockMs: request.maxWallClockMs,
      maxRunTokens: request.maxRunTokens,
      runTokenBaseline: request.runTokenBaseline,
      judgeCompletion: config.judgeCompletion,
      // A structured zero-tool result is meaningful only on an explicitly
      // decision-only surface. Never let a caller combine this opt-in with
      // undefined or non-empty tool authority and suppress effect evidence.
      acceptStructuredNoToolResult:
        request.acceptStructuredNoToolResult === true
        && Array.isArray(request.allowedToolNames)
        && request.allowedToolNames.length === 0,
      onConversationPreamble: request.onConversationPreamble,
      reuseRecordedUserInput: true,
      falloverModelIds: fallover.falloverModelIds,
      rebuildAgentForBrain: fallover.rebuildAgentForBrain,
    });
    requestAttemptStatus = result.status === 'killed'
      ? 'cancelled'
      : result.status === 'failed'
        ? 'failed'
        : 'completed';

    // The loop status says whether the executor itself returned; the committed
    // PresentationEvent says how the accepted user turn actually settled. A
    // normal executor return can still carry a blocked/failed/needs-input
    // terminal after the delivery reducer audits its evidence. Preserve that
    // typed terminal across this compatibility bridge instead of re-deriving a
    // green result from `status === "completed"` or from its prose. This is the
    // same authority used by exact-terminal replay below.
    if (result.publicPresentation) {
      const presentation = result.publicPresentation;
      if (
        presentation.identity.sessionId !== sessionId
        || presentation.identity.sourceUserSeq !== sourceUserEvent.seq
      ) {
        throw new Error('Harness returned a public terminal for a different accepted source.');
      }
      requestAttemptStatus = presentation.status === 'cancelled'
        ? 'cancelled'
        : presentation.status === 'done' || presentation.status === 'transferred'
          ? 'completed'
          : presentation.status === 'needs_input'
            ? 'completed'
            : 'failed';
      return withRouteDiagnostics({
        text: presentation.text,
        sessionId,
        stoppedReason: stoppedReasonForPresentation(presentation),
        turnsUsed: result.lastTurn,
        ...(presentation.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
      }, routeForHarness(surface, request, opts.modelOverride));
    }

    // The authoritative public presentation returned above. From this point
    // onward the result is necessarily presentation-less, so only the
    // executor's retained decision may supply compatibility prose.
    const replyText = publicReplyText(result.lastDecision?.reply, '');

    switch (result.status) {
      case 'held': {
        // No terminal exists: a peer activation or restart reconciler still
        // owns this exact accepted source. Preserve its attempt and return only
        // a nonterminal acknowledgement; never reinterpret it as done, failed,
        // blocked, or a question for the user.
        preserveRequestAttemptOwnership = true;
        return withRouteDiagnostics({
          text: TYPED_EXECUTION_HELD_REPLY,
          sessionId,
          stoppedReason: 'in-progress',
          turnsUsed: result.lastTurn,
          raw: { transport: 'host_harness', typedExecution: result.hold },
        }, routeForHarness(surface, request, opts.modelOverride));
      }
      case 'dispatched': {
        const dispatch = exactAsyncDispatchForSource(sourceUserEvent);
        if (!dispatch) {
          throw new Error('Harness returned dispatched without exact durable dispatch authority.');
        }
        return withRouteDiagnostics({
          text: composeDispatchedReplyText(sourceUserEvent, dispatch.text),
          sessionId,
          // This closes only the synchronous provider request. The durable
          // async_work_dispatched event remains the nonterminal logical edge.
          stoppedReason: 'success',
          turnsUsed: result.lastTurn,
          raw: {
            asyncWork: {
              status: dispatch.status,
              kind: dispatch.kind,
              runIds: [...dispatch.runIds],
              sourceGroupId: dispatch.sourceGroupId,
              sourceGroupDigest: dispatch.sourceGroupDigest,
              sourceUserSeq: dispatch.sourceUserSeq,
              dispatchKey: dispatch.dispatchKey,
            },
          },
        }, routeForHarness(surface, request, opts.modelOverride));
      }
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
          const recoveryCheck = checkRecoveryLedger(sessionId, parseRecoveryBaseline);
          if (!recoveryCheck.safeToRerun) {
            bridgeLogger.warn({ surface, recoverySkipped: recoveryCheck.reason },
              'parse-exhaustion recovery skipped because the attempt is not proven write-free');
            const recorded = recoveryCheck.reason === 'external_write'
              ? synthesizeWorkReport(recoveryCheck.evidence)?.replace(
                  /^I finished — here's what I did this turn:/,
                  'Before the brain stopped, the action ledger recorded:',
                )
              : null;
            const hasConfirmedWrite = recoveryCheck.reason === 'external_write'
              && recoveryCheck.evidence.some((event) => event.type === 'external_write_succeeded'
                || (event.type === 'external_write' && event.data.preDispatch !== true));
            const blockedText = recoveryCheck.reason === 'external_write'
              ? `${recorded ?? (hasConfirmedWrite
                  ? 'The action ledger recorded a successful external write before the brain stopped.'
                  : 'The action ledger recorded an external write attempt with an unresolved outcome.')}\n\nI did not rerun the task on another model because that could repeat or conflict with the external action.`
              : 'The first brain stopped before it produced a safe final answer. I could not verify the external-write ledger for that attempt, so I did not rerun the task on another model.';
            const reason = recoveryCheck.reason === 'external_write'
              ? 'parse_recovery_external_write'
              : 'parse_recovery_ledger_unreadable';
            const terminal = recoveryCheck.reason === 'external_write'
              ? commitBridgeUnverifiedCompletionCandidate({
                  sessionId: request.sessionId,
                  sourceUserSeq: sourceUserEvent.seq,
                  sourceTurn: sourceUserEvent.turn,
                  text: blockedText,
                  reason,
                  metadata: { steps: result.steps },
                  presentationAlreadyDiscloses: true,
                })
              : commitBridgeBlockedTerminal({
                  request,
                  turn: {
                    attempt: requestAttempt,
                    sourceUserSeq: sourceUserEvent.seq,
                    sourceTurn: sourceUserEvent.turn,
                  },
                  text: blockedText,
                  reason,
                  metadata: { steps: result.steps },
                });
            return withRouteDiagnostics(
              responseForCommittedTerminal(terminal, { recoverySkipped: recoveryCheck.reason }),
              routeForHarness(surface, request, opts.modelOverride),
            );
          } else try {
            const usedModel = modelForRun ?? resolveRoleModel('brain').modelId;
            const currentBrain = providerFor(usedModel) as BrainProviderClass | undefined;
            if (!currentBrain) throw new Error(`Could not resolve provider for ${usedModel}.`);
            const next = falloverBrainModelIds(currentBrain)[0];
            if (next) {
              bridgeLogger.warn({ surface, currentBrain, recoveryModel: next.modelId },
                'harness brain exhausted structured-decision retries — re-running the turn once on the next brain instead of shipping the apology');
              // A retry is a fresh physical attempt, never a reopened execution
              // receipt. Settle this dead attempt first, then bind the new one to
              // the same exact accepted user event.
              try { finishRunAttempt(requestAttempt, 'superseded'); } catch { /* the new begin still validates its source binding */ }
              const recovered = await respondViaHarness(surface, request, {
                reuseRecordedUserInput: true,
                sourceUserSeq: sourceUserEvent.seq,
                modelOverride: next.modelId,
                turnEngine: opts.turnEngine,
                maxTurns: opts.maxTurns,
                maxSteps: opts.maxSteps,
              });
              const route = routeDiagnosticsFromResponse(recovered);
              return route ? withRouteDiagnostics(recovered, { ...route, falloverFrom: 'harness_parse_exhaustion' }) : recovered;
            }
          } catch (falloverErr) {
            bridgeLogger.warn({ surface, err: falloverErr instanceof Error ? falloverErr.message : String(falloverErr) },
              'parse-exhaustion fallover failed — shipping the original completion');
          }
        }
        if (result.completedReason) {
          const terminal = commitRecoveryCandidateTerminal({
            sessionId,
            sourceUserSeq: sourceUserEvent.seq,
            sourceTurn: sourceUserEvent.turn,
            steps: result.steps,
            completedReason: result.completedReason,
          });
          return withRouteDiagnostics({
            ...responseForCommittedTerminal(terminal, {
              recoveryCandidate: result.completedReason,
            }),
            turnsUsed: result.lastTurn,
          }, routeForHarness(surface, request, opts.modelOverride));
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
        const dependency = first ? projectPendingApprovalUserDependency(first) : null;
        if (dependency?.kind === 'input') {
          return withRouteDiagnostics({
            text: dependency.question,
            sessionId,
            stoppedReason: 'awaiting-input',
            turnsUsed: result.lastTurn,
          }, routeForHarness(surface, request, opts.modelOverride));
        }
        return withRouteDiagnostics({
          text: replyText
            || (first
              ? `Paused for approval \`${first.approvalId}\`: ${first.subject}. Approve or reject it and I'll continue.`
              : 'Paused for an approval. Approve or reject it and I\'ll continue.'),
          sessionId,
          pendingApprovalId: dependency?.kind === 'approval' ? dependency.approvalId : undefined,
          stoppedReason: 'pending-approval',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      }
      case 'limit_exceeded': {
        // HOST TURN LOOP (2026-08-19): step ceilings continue IN-TURN via the
        // loop's logged next-step claims; a ceiling that reaches this case
        // chose to REST. The old fire-and-forget drain here synthesized a
        // user_input_received to fake re-entry — a stall wearing a banner
        // (live mszlpidc: "pass 1 of 200" with no logged next-step claim and
        // no continue dispatch). The park copy states progress is saved; it
        // never asks the user to type `continue` — any next user message
        // re-enters from the checkpoint.
        return withRouteDiagnostics({
          text: replyText || (result.limitKind === 'token_budget'
            ? 'I hit this run\'s token budget before finishing. Progress is checkpointed — I\'ll pick up from here.'
            : 'I hit the run budget before finishing. Progress is checkpointed — I\'ll pick up from here.'),
          sessionId,
          stoppedReason: result.limitKind === 'token_budget' ? 'token-budget' : 'max-turns-with-grace',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      }
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
      case 'blocked':
        return withRouteDiagnostics({
          text: result.error
            || 'I could not admit this turn, so I stopped before using any tools.',
          sessionId,
          stoppedReason: 'blocked',
          turnsUsed: result.lastTurn,
        }, routeForHarness(surface, request, opts.modelOverride));
      case 'failed':
      default:
        throw new Error(result.error || `harness run ${result.status}`);
    }
  } catch (err) {
    if (err instanceof AgentRuntimeCancelledError) throw err;
    const signaledOwnership = err instanceof PendingWorkflowChatDispatchOwnershipError
      && err.ownership.originSessionId === sourceUserEvent.sessionId
      && err.ownership.sourceUserSeq === sourceUserEvent.seq
      ? { kind: 'pending' as const, ownership: err.ownership }
      : null;
    const restartOwned = signaledOwnership ?? restartOwnedWorkflowDispatchState({
      sessionId: sourceUserEvent.sessionId,
      sourceUserSeq: sourceUserEvent.seq,
    });
    if (restartOwned) {
      // This is admitted-but-not-activated work, not a failed model turn. Keep
      // both the atomic in-flight marker and the active run_attempt row intact;
      // restart recovery will reuse this exact source and queue record.
      preserveRequestAttemptOwnership = true;
      const response = restartOwnedWorkflowDispatchResponse({
        sessionId: sourceUserEvent.sessionId,
        sourceUserSeq: sourceUserEvent.seq,
        sourceTurn: sourceUserEvent.turn,
        state: restartOwned,
        transport: 'host_harness',
      });
      return withRouteDiagnostics(response, routeForHarness(surface, request, opts.modelOverride));
    }
    requestAttemptStatus = 'failed';
    // A hard provider/runtime error is reduced at the same durable public
    // boundary as every other terminal. Raw exception text remains in private
    // logs; if an exact terminal already committed, idempotency returns that
    // authoritative winner rather than overwriting it with a failure.
    try {
      const terminal = commitBridgeFailedTerminal({
        request,
        turn: {
          attempt: requestAttempt,
          sourceUserSeq: sourceUserEvent.seq,
          sourceTurn: sourceUserEvent.turn,
        },
        reason: 'bridge_runtime_failed',
        transport: 'host_harness',
      });
      const response = responseForCommittedTerminal(terminal, {
        failure: 'bridge_runtime_failed',
      });
      if (response.stoppedReason !== 'error') {
        requestAttemptStatus = 'completed';
      }
      return withRouteDiagnostics(response, routeForHarness(surface, request, opts.modelOverride));
    } catch (commitErr) {
      bridgeLogger.error({
        surface,
        err: commitErr instanceof Error ? commitErr.message : String(commitErr),
      }, 'could not durably reduce harness runtime failure');
      // A corrupt or unavailable terminal ledger is a hard failure, but its
      // parser/DB detail is private. Do not reinterpret the malformed row as a
      // legacy reply and do not expose its contents through the transport.
      throw new Error(PUBLIC_RUN_FAILURE_TEXT);
    }
  } finally {
    detachProgressRelay();
    if (cancelPoll) clearInterval(cancelPoll);
    if (!preserveRequestAttemptOwnership) {
      try { finishRunAttempt(requestAttempt, requestAttemptStatus); } catch { /* attempt telemetry must not mask the response */ }
    }
    if (requestAttemptStatus === 'cancelled') {
      try { clearKill(sessionId, requestAttempt); } catch { /* best effort */ }
    }
  }
}

/**
 * Drop-in router for legacy call sites:
 *   `assistant.respond(req)` → `respondPreferHarness('cron', req, (r) => assistant.respond(r))`
 * The legacy callback remains in the public signature while callers migrate,
 * but it is never invoked. A disabled surface, unsupported tool boundary, or
 * missing model runtime produces one typed pre-run block under the same owner.
 */
async function respondPreferHarnessOnce(
  surface: HarnessSurface,
  request: AssistantRequest,
  _legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
  limits: RespondHarnessLimits = {},
): Promise<AssistantResponse> {
  // Idempotent transport replay is resolved before runtime availability or
  // tool-surface checks: the durable terminal is already the public winner.
  // Requiring model auth here would both waste work and make an already
  // delivered answer temporarily unreadable during an outage.
  if (Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0) {
    try {
      if (durableSourceEventForRequest(request) && !acceptedSourceIdentityForReplay(request)) {
        return responseForAcceptedSourceIdentityMismatch(surface, request);
      }
      const committed = exactTerminalReplayForRequest(request);
      if (committed) {
        settleExactTerminalReplayOwnership(request, committed);
        return responseForExactTerminalReplayUnderPolicy(surface, request, committed);
      }
      const warmSpent = exactWarmProviderSpentForRequest(request);
      if (warmSpent) {
        return durableWarmReadPolicyMatches(request, warmSpent)
          ? responseForWarmProviderSpentReplay(surface, request)
          : responseForWarmReadPolicyConflict(surface, request);
      }
    } catch {
      // A ledger read failure is not evidence that no terminal exists. Exact
      // replay callers have already named an accepted source, so retrying via
      // a brain here could duplicate an effect whose winner is merely unreadable.
      return responseForUnverifiableTerminalLedger(surface, request);
    }
  }
  // Do not introduce an async boundary into the established hot path merely
  // to discover that an ordinary request is not an answer-repeat request. Cron and
  // background admission rely on synchronous fall-through up to their chosen
  // runtime lane.
  if (isExplicitCompletedAnswerReplay(request.displayMessage ?? request.message)) {
    const completedAnswerReplay = await tryServeCompletedAnswerReplay(surface, request);
    if (completedAnswerReplay) return completedAnswerReplay;
  }
  if (!harnessSurfaceEnabled(surface)) {
    return await blockedPreRunResponse(
      surface,
      request,
      'That runtime lane is temporarily unavailable, so I did not start the turn. Check runtime settings or try again.',
      { reason: 'surface_disabled' },
    );
  }
  // Per-call tool-exclusion: route through the harness ONLY when it can ENFORCE
  // every excluded name (harness-surface tool). A non-filterable exclude (an
  // external MCP tool) blocks pre-run by default so we never silently widen the
  // caller's tool surface or bypass the harness. buildOrchestratorAgent does the
  // actual filtering for enforceable names.
  if (!harnessCanEnforceExcludes(request.excludeToolNames)) {
    const unsafe = nonFilterableToolExcludes(request.excludeToolNames, HARNESS_FILTERABLE_TOOLS);
    return await blockedPreRunResponse(
      surface,
      request,
      'I could not start this turn because its requested tool boundary is not supported. Please use a scoped tool surface or adjust the request.',
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
    return await blockedPreRunResponse(
      surface,
      request,
      'I could not start this turn because no model runtime is connected. Open Settings > Models, connect a model, and try again.',
      { reason: 'harness_auth_unavailable', authReason: auth.reason },
    );
  }
  // Freeze the fresh-turn owner before any eager resolver can consume the
  // accepted request. Every surface starts with the host-owned model loop;
  // memory and live catalog are context/capability ports inside it, not a
  // second executor in front of it.
  let turnEngine: TurnEngineMode;
  try {
    turnEngine = selectTurnEngine({
      sessionKind: SURFACE_CONFIG[surface].kind,
    });
  } catch (err) {
    if (!(err instanceof InvalidFreshTurnEngineError)) throw err;
    return await blockedPreRunResponse(
      surface,
      request,
      'This runtime is configured for an unsupported turn engine, so I did not start the turn. Use host_v1 or host_v1_read_only.',
      { reason: 'invalid_turn_engine' },
    );
  }
  // Deliberately no pre-brain provider read runs at this boundary. The typed
  // resolver components remain dormant until they can enter through the same
  // durable carrier and physical-authority kernel as every other provider I/O.
  const useStandaloneClaudeExecutionBrain = allowStandaloneClaudeInteractiveBrainForTests
    && claudeAgentSdkBrainEnabled(surface);
  if (useStandaloneClaudeExecutionBrain) {
    // Production never enters this branch. Tests can still exercise the
    // retired subscription-backed reducer in isolation; ordinary Claude turns
    // fall through to respondViaHarness and RouterModelProvider preserves the
    // OAuth Bearer billing envelope inside the shared host loop.
    if (Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0) {
      request = await enrichAcceptedRequestWithTaskContinuity(
        request,
        Number(request.sourceUserSeq),
        {
          continuationOnly: true,
          typedClassification: semanticPortParticipated(request.sessionId, Number(request.sourceUserSeq))
            ? { keepOpen: true }
            : undefined,
        },
      );
    }
    const detachProgressRelay = attachLegacyProgressRelay(request);
    // Whole-turn recovery may re-drive every tool call on another brain. Bind
    // its safety check to THIS Claude attempt so old writes in the same session
    // neither block a clean recovery nor hide a new write.
    const recoveryBaseline = captureRecoveryLedgerBaseline(request.sessionId);
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
        const owner = await ensureAcceptedRecoveryTurn(surface, request);
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
            sourceUserSeq: owner.sourceUserSeq,
            attemptId: owner.attempt.attemptId,
          },
        });
      } catch { /* telemetry only */ }
      // HOST TURN LOOP (2026-08-19): the Claude one-step transport's step
      // ceilings continue IN-TURN inside the brain — a logged next_step_claimed
      // per pipe re-entry, one terminal at the true end. The old drain here
      // faked re-entry with a synthetic user_input_received; a limitHit that
      // reaches this return is an honest resting park.
      return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
    } catch (err) {
      let restartOwnershipDetected = false;
      try {
        const turn = await ensureAcceptedRecoveryTurn(surface, request);
        const signaledOwnership = err instanceof PendingWorkflowChatDispatchOwnershipError
          && err.ownership.originSessionId === request.sessionId
          && err.ownership.sourceUserSeq === turn.sourceUserSeq
          ? { kind: 'pending' as const, ownership: err.ownership }
          : null;
        const restartOwned = signaledOwnership ?? restartOwnedWorkflowDispatchState({
          sessionId: request.sessionId,
          sourceUserSeq: turn.sourceUserSeq,
        });
        if (restartOwned) {
          restartOwnershipDetected = true;
          const response = restartOwnedWorkflowDispatchResponse({
            sessionId: request.sessionId,
            sourceUserSeq: turn.sourceUserSeq,
            sourceTurn: turn.sourceTurn,
            state: restartOwned,
            transport: 'claude_agent_sdk_brain',
          });
          return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
        }
      } catch (ownershipErr) {
        if (restartOwnershipDetected || err instanceof PendingWorkflowChatDispatchOwnershipError) {
          // Even the nonterminal pause audit could not be persisted. Never
          // reinterpret the typed ownership signal as permission to commit a
          // failed terminal; the brain's armed marker remains the retry owner.
          bridgeLogger.error({
            surface,
            err: ownershipErr instanceof Error ? ownershipErr.message : String(ownershipErr),
          }, 'could not persist restart-owned workflow dispatch pause');
          throw new Error(PUBLIC_RUN_FAILURE_TEXT);
        }
      }
      const recovered = await recoverChatBrainFailure(surface, request, err, detach, recoveryBaseline);
      if (recovered) return recovered;
      try {
        const turn = await ensureAcceptedRecoveryTurn(surface, request);
        if (err instanceof Error && (err as { narrationGiveUp?: boolean }).narrationGiveUp === true) {
          const completedWork = synthesizeCompletedWorkReport(request.sessionId, turn.sourceUserSeq);
          const terminal = completedWork
            ? commitBridgeUnverifiedCompletionCandidate({
                sessionId: request.sessionId,
                sourceUserSeq: turn.sourceUserSeq,
                sourceTurn: turn.sourceTurn,
                text: completedWork.replace(
                  /^I finished — here's what I did this turn:/,
                  'Before the response stopped, the action ledger recorded:',
                ),
                reason: 'narration_giveup',
                metadata: { transport: 'claude_agent_sdk_brain' },
                presentationAlreadyDiscloses: true,
              })
            : commitBridgeBlockedTerminal({
                request,
                turn,
                text: 'The turn stopped before it produced a safe final answer. The turn is closed; the activity log has the technical details.',
                reason: 'narration_giveup',
                metadata: { transport: 'claude_agent_sdk_brain' },
                resumable: false,
              });
          const response = responseForCommittedTerminal(terminal, {
            failure: 'narration_giveup',
            transport: 'claude_agent_sdk_brain',
          });
          return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
        }
        const terminal = commitBridgeFailedTerminal({
          request,
          turn,
          reason: 'claude_brain_failed',
          transport: 'claude_agent_sdk_brain',
        });
        const response = responseForCommittedTerminal(terminal, {
          failure: 'claude_brain_failed',
          transport: 'claude_agent_sdk_brain',
        });
        return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
      } catch (commitErr) {
        bridgeLogger.error({
          surface,
          err: commitErr instanceof Error ? commitErr.message : String(commitErr),
        }, 'could not durably reduce Claude brain failure');
        // Raw provider/DB detail must not become a second publication protocol.
        throw new Error(PUBLIC_RUN_FAILURE_TEXT);
      }
    } finally {
      detach();
    }
  }
  return respondViaHarness(surface, request, { turnEngine, ...limits });
}

/** Same-daemon admission for the entire accepted-source response, not merely
 * the warm branch. This prevents an authority-restricted duplicate from
 * starting a brain while its sibling is inside warm provider I/O (and the
 * reverse ordering). Durable/cross-process admission belongs to the graph
 * engine; this map is intentionally only the local race fence. */
interface AcceptedSourceInvocationInFlight {
  policyDigest: string;
  promise: Promise<AssistantResponse>;
}
const acceptedSourceInvocationsInFlight = new Map<string, AcceptedSourceInvocationInFlight>();

export async function respondPreferHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
  limits: RespondHarnessLimits = {},
): Promise<AssistantResponse> {
  return withRuntimeConfigSnapshot(() => respondPreferHarnessWithinRuntimeConfig(
    surface,
    request,
    legacyRespond,
    limits,
  ));
}

async function respondPreferHarnessWithinRuntimeConfig(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
  limits: RespondHarnessLimits,
): Promise<AssistantResponse> {
  let key: string | null = null;
  try {
    const source = acceptedSourceIdentityForReplay(request);
    // source.seq is the immutable logical-turn identity. The ordinary harness
    // may rotate its physical run attempt while this promise is in flight;
    // that must not split ownership and admit a warm sibling.
    if (source) key = `${request.sessionId}:${source.seq}`;
  } catch { key = null; }
  if (!key) return respondPreferHarnessOnce(surface, request, legacyRespond, limits);

  const policyDigest = warmReadToolPolicyDigest(request);
  const existing = acceptedSourceInvocationsInFlight.get(key);
  if (existing) {
    return existing.policyDigest === policyDigest
      ? existing.promise
      : responseForWarmReadPolicyConflict(surface, request);
  }

  const promise = respondPreferHarnessOnce(surface, request, legacyRespond, limits);
  const entry = { policyDigest, promise };
  acceptedSourceInvocationsInFlight.set(key, entry);
  try {
    return await promise;
  } finally {
    if (acceptedSourceInvocationsInFlight.get(key) === entry) {
      acceptedSourceInvocationsInFlight.delete(key);
    }
  }
}

const bridgeLogger = pino({ name: 'clementine.respond-bridge' });

export type RecoveryLedgerBaseline =
  | { readable: true; afterSeq: number }
  | { readable: false };

type RecoveryLedgerCheck =
  | { safeToRerun: true }
  | { safeToRerun: false; reason: 'external_write'; evidence: EventRow[] }
  | { safeToRerun: false; reason: 'ledger_unreadable'; evidence: [] };

export function captureRecoveryLedgerBaseline(sessionId: string): RecoveryLedgerBaseline {
  try {
    // One indexed tail row is enough to bind the recovery check to this
    // attempt; do not load a long session's full history into memory.
    const events = recoveryListEventsImpl(sessionId, { limit: 1, desc: true });
    return {
      readable: true,
      afterSeq: events[0]?.seq ?? 0,
    };
  } catch {
    return { readable: false };
  }
}

function checkRecoveryLedger(
  sessionId: string,
  baseline: RecoveryLedgerBaseline | undefined,
): RecoveryLedgerCheck {
  // Whole-turn recovery is destructive if its safety ledger is unavailable.
  // An absent baseline is therefore "do not rerun", never "assume clean".
  if (!baseline?.readable) {
    return { safeToRerun: false, reason: 'ledger_unreadable', evidence: [] };
  }
  try {
    const evidence = recoveryListEventsImpl(sessionId, {
      sinceSeq: baseline.afterSeq,
      types: ['external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
    });
    const resolved = resolveWriteEvidence(evidence);
    // A pre-dispatch reservation is compensated only by an exact matching
    // failure, which proves that invocation never reached the provider.
    // Successful and orphaned terminal rows remain unsafe even when their
    // reservation is absent or later contradicted: they are durable evidence
    // that the failed turn may have changed external state. A failure for a
    // sibling call cannot settle another invocation's reservation.
    const hasUnsafeTerminal = evidence.some((event) =>
      event.type === 'external_write_succeeded'
      || event.type === 'external_write_orphaned'
      // Legacy external_write rows were emitted only after confirmed success.
      // A later failure-shaped row must not retroactively make that historical
      // write safe to replay.
      || (event.type === 'external_write' && event.data.preDispatch !== true));
    return hasUnsafeTerminal || resolved.confirmed.length > 0 || resolved.uncertain.length > 0
      ? { safeToRerun: false, reason: 'external_write', evidence }
      : { safeToRerun: true };
  } catch {
    return { safeToRerun: false, reason: 'ledger_unreadable', evidence: [] };
  }
}

function blockedWholeTurnRecoveryResponse(
  surface: HarnessSurface,
  request: AssistantRequest,
  turn: AcceptedRecoveryTurn,
  check: Exclude<RecoveryLedgerCheck, { safeToRerun: true }>,
): AssistantResponse {
  // Deterministic FLOOR text (no model is available on this path — the brain
  // crashed mid-turn). Floors state facts in the harness's own voice and
  // never name a provider.
  const recorded = check.reason === 'external_write'
    ? synthesizeWorkReport(check.evidence)?.replace(
        /^I finished — here's what I did this turn:/,
        'Before that turn stopped, the action ledger recorded:',
      )
    : null;
  const text = check.reason === 'external_write'
    ? `${recorded ?? 'The action ledger recorded an external write attempt but did not confirm a completed change.'}\n\nThat turn stopped before it finished. I did not rerun it because that could repeat or conflict with the external action already recorded. Tell me how you'd like to proceed.`
    : 'That turn stopped before it finished. I could not verify the external-write ledger for the attempt, so I did not rerun it, and nothing further was changed. Tell me how you\'d like to proceed.';
  const reason = check.reason === 'external_write'
    ? 'claude_recovery_external_write'
    : 'claude_recovery_ledger_unreadable';
  const terminal = check.reason === 'external_write'
    ? commitBridgeUnverifiedCompletionCandidate({
        sessionId: request.sessionId,
        sourceUserSeq: turn.sourceUserSeq,
        sourceTurn: turn.sourceTurn,
        text,
        reason,
        metadata: { transport: 'claude_agent_sdk_brain' },
        presentationAlreadyDiscloses: true,
      })
    : commitBridgeBlockedTerminal({
        request,
        turn,
        text,
        reason,
        metadata: { transport: 'claude_agent_sdk_brain' },
      });
  const response = responseForCommittedTerminal(terminal, {
      recoverySkipped: check.reason,
      transport: 'claude_agent_sdk_brain',
      recordedExternalWrites: check.reason === 'external_write'
        ? check.evidence.filter((event) => event.type === 'external_write').length
        : undefined,
  });
  return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
}

function chatBrainFalloverEnabled(): boolean {
  // Default ON (kill-switch CLEMMY_BRAIN_FALLOVER=off) — parity with the router +
  // workflow lanes. A terminal Claude-brain failure (overload, hang, expired auth)
  // can re-run on a connected non-Claude brain only when the per-attempt write
  // ledger proves that no external action occurred.
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
 *    parse-failure is normally the uncommitted one).
 * Eligibility is only the first check: recoverChatBrainFailure separately
 * requires a readable per-attempt ledger with zero new external writes.
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
  if (err instanceof ClaudeSdkCapacityExhaustedError) return !err.committed;
  // Unparseable tool call — a flaky stumble a DIFFERENT brain usually doesn't reproduce.
  if (isClaudeSdkUnparseableToolCall(err)) return true;
  // GENERIC terminal Claude-brain failure (non-overload 4xx/5xx, usage-limit, tool-surface
  // error, SDK internal throw, runtime.unknown): a DIFFERENT brain often succeeds where this
  // one dead-ended. This marks the error as eligible only; recoverChatBrainFailure
  // still requires a readable, write-free per-attempt ledger before it reruns.
  // Broadened 2026-07-01 (brain-switching-when-needed): previously every
  // non-overload / non-parse Claude-brain error HARD-FAILED the turn with no fallover.
  return err instanceof Error;
}

export async function recoverChatBrainFailure(
  surface: HarnessSurface,
  request: AssistantRequest,
  err: unknown,
  detach?: () => void,
  recoveryBaseline?: RecoveryLedgerBaseline,
  options?: { via?: 'harness' | 'claude' },
): Promise<AssistantResponse | null> {
  // Pure terminal replay is read-only. Resolve it before the recovery helper can
  // create or bind an attempt, so a late A callback cannot re-arm A over a newer
  // active B marker on the same reusable chat session.
  let replay: AcceptedSourceTerminalOutcome | null;
  try {
    replay = exactTerminalReplayForRequest(request);
  } catch {
    return responseForUnverifiableTerminalLedger(surface, request);
  }
  if (replay) {
    const source = durableSourceEventForRequest(request);
    const owner = source
      ? getRunAttemptBySourceUserSeq(request.sessionId, source.seq)
      : null;
    if (source && owner) {
      clearRunInFlightAfterTerminal(request.sessionId, owner.attemptId, source.seq);
    }
    const response = responseForAcceptedSourceTerminal(replay, {
      recoverySkipped: 'terminal_already_committed',
      transport: 'claude_agent_sdk_brain',
    });
    return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
  }
  // Resolve logical ownership before checking retry eligibility. A provider can
  // throw after its terminal committed (for example, a learning hook or local
  // DB write). That exact terminal is already the answer and must short-circuit
  // every recovery path, including errors whose provider flags say "committed".
  let turn: AcceptedRecoveryTurn;
  try {
    turn = await ensureAcceptedRecoveryTurn(surface, request);
  } catch {
    // If exact ownership cannot be established, never authorize a rerun. The
    // caller's generic failure reducer will make one final fail-closed attempt.
    return null;
  }
  try {
    const committed = exactTerminalForSource(request.sessionId, turn.sourceUserSeq);
    if (committed) {
      clearRunInFlightAfterTerminal(
        request.sessionId,
        turn.attempt.attemptId,
        turn.sourceUserSeq,
      );
      const response = responseForAcceptedSourceTerminal(committed, {
        recoverySkipped: 'terminal_already_committed',
        transport: 'claude_agent_sdk_brain',
      });
      return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
    }
  } catch {
    return responseForUnverifiableTerminalLedger(surface, request);
  }
  if (!isChatBrainFalloverEligible(err)) return null;
  const kind = err instanceof ClaudeSdkCapacityExhaustedError ? 'capacity_exhausted'
    : err instanceof ClaudeSdkProviderOverloadError ? 'overload'
    : isClaudeSdkUnparseableToolCall(err) ? 'parse_failure'
    : 'terminal_error';
  const recoveryCheck = checkRecoveryLedger(request.sessionId, recoveryBaseline);
  if (!recoveryCheck.safeToRerun) {
    bridgeLogger.warn({
      surface,
      kind,
      recoverySkipped: recoveryCheck.reason,
      recordedExternalWrites: recoveryCheck.reason === 'external_write'
        ? recoveryCheck.evidence.filter((event) => event.type === 'external_write').length
        : undefined,
      err: err instanceof Error ? err.message : String(err),
    }, 'Claude brain terminal failure — whole-turn recovery skipped because the attempt is not proven write-free');
    detach?.();
    return blockedWholeTurnRecoveryResponse(surface, request, turn, recoveryCheck);
  }
  const recoveryModel = recoveryHarnessModelAfterClaudeFailure();
  bridgeLogger.warn({ surface, kind, recoveryModel, err: err instanceof Error ? err.message : String(err) },
    'Claude brain terminal failure — write-free attempt verified; switching the turn over to a non-Claude harness brain when available');
  detach?.();
  try {
    // The failed Claude receipt is historical. A recovery uses a new physical
    // attempt that is bound to the same accepted event and therefore shares the
    // logical terminal key without reopening the failed attempt.
    try { finishRunAttempt(turn.attempt, 'superseded'); } catch { /* begin validates the exact source below */ }
    const recovered = options?.via === 'claude'
      ? await respondViaClaudeAgentSdkBrain(
          surface === 'workflow' ? 'home' : surface,
          {
            ...request,
            sourceUserSeq: turn.sourceUserSeq,
          },
        )
      : await respondViaHarness(surface, request, {
          reuseRecordedUserInput: true,
          sourceUserSeq: turn.sourceUserSeq,
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
let falloverChainForTest: string[] | null = null;
/** Test hook: pin a fallover chain so the threading contract is provable
 *  without ambient model auth deciding whether a chain exists. */
export function _setFalloverChainForTest(modelIds: string[] | null): void {
  falloverChainForTest = modelIds;
}

export function buildChatFalloverWiring(opts: {
  userInput: string;
  sessionId: string;
  allowedToolNames?: string[];
  excludeToolNames?: string[];
  allowToolJit?: boolean;
  /** The turn's resolved candidates. A fallover rebuild serves the SAME
   *  accepted turn — the second brain must not pay rediscovery for state the
   *  first brain already had. */
  turnCandidates?: TurnCapabilityCandidates;
  /** Host-owned fresh turns resolve candidates only after the accepted
   *  capability node starts. The supplier is request-scoped and promise-
   *  memoized by the caller, so every rebuild observes the same resolution. */
  turnCandidatesForBuild?: () => Promise<TurnCapabilityCandidates | undefined>;
  taskContinuation?: import('../../types.js').TaskContinuationContext;
  taskContinuationResolved?: true;
  acceptedIdentity?: () => {
    sourceUserSeq: number;
    route?: 'direct_reply' | 'retrieve' | 'act';
    hostFreshPlanning?: NonNullable<Parameters<NonNullable<RunConversationOptions['buildAgent']>>[0]['hostFreshPlanning']>;
    hostPlainConversation?: true;
  } | undefined;
  buildAgent: (o: { userInput?: string; sessionId: string; sourceUserSeq?: number; acceptedRoute?: 'direct_reply' | 'retrieve' | 'act'; hostFreshPlanning?: NonNullable<Parameters<NonNullable<RunConversationOptions['buildAgent']>>[0]['hostFreshPlanning']>; hostPlainConversation?: true; allowedToolNames?: string[]; excludeToolNames?: string[]; model?: string; allowToolJit?: boolean; turnCandidates?: TurnCapabilityCandidates; taskContinuation?: import('../../types.js').TaskContinuationContext; taskContinuationResolved?: true }) => Promise<BuiltAgent>;
}): { falloverModelIds?: string[]; rebuildAgentForBrain?: (modelId: string) => Promise<BuiltAgent> } {
  if (!chatBrainFalloverEnabled()) return {};
  try {
    if (falloverChainForTest) {
      const modelIds = falloverChainForTest;
      return {
        falloverModelIds: modelIds,
        rebuildAgentForBrain: async (modelId: string) => {
          const identity = opts.acceptedIdentity?.();
          const turnCandidates = opts.turnCandidatesForBuild
            ? await opts.turnCandidatesForBuild()
            : opts.turnCandidates;
          return opts.buildAgent({
            userInput: opts.userInput,
            sessionId: opts.sessionId,
            ...(identity ? { sourceUserSeq: identity.sourceUserSeq } : {}),
            ...(identity?.route ? { acceptedRoute: identity.route } : {}),
            ...(identity?.hostFreshPlanning ? { hostFreshPlanning: identity.hostFreshPlanning } : {}),
            ...(identity?.hostPlainConversation ? { hostPlainConversation: true as const } : {}),
            ...(turnCandidates ? { turnCandidates } : {}),
            ...(opts.taskContinuation ? { taskContinuation: opts.taskContinuation } : {}),
            ...(opts.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
            allowedToolNames: opts.allowedToolNames,
            excludeToolNames: opts.excludeToolNames,
            model: modelId,
            allowToolJit: opts.allowToolJit,
          });
        },
      };
    }
    const currentProvider = providerFor(resolveRoleModel('brain').modelId) as BrainProviderClass | undefined;
    if (!currentProvider) return {};
    const nextBrains = falloverBrainModelIds(currentProvider);
    if (nextBrains.length === 0) return {};
    return {
      falloverModelIds: nextBrains.map((b) => b.modelId),
      rebuildAgentForBrain: async (modelId: string) => {
        const identity = opts.acceptedIdentity?.();
        const turnCandidates = opts.turnCandidatesForBuild
          ? await opts.turnCandidatesForBuild()
          : opts.turnCandidates;
        return opts.buildAgent({
          userInput: opts.userInput,
          sessionId: opts.sessionId,
          ...(identity ? { sourceUserSeq: identity.sourceUserSeq } : {}),
          ...(identity?.route ? { acceptedRoute: identity.route } : {}),
          ...(identity?.hostFreshPlanning ? { hostFreshPlanning: identity.hostFreshPlanning } : {}),
          ...(identity?.hostPlainConversation ? { hostPlainConversation: true as const } : {}),
          ...(turnCandidates ? { turnCandidates } : {}),
          ...(opts.taskContinuation ? { taskContinuation: opts.taskContinuation } : {}),
          ...(opts.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
          allowedToolNames: opts.allowedToolNames,
          excludeToolNames: opts.excludeToolNames,
          model: modelId,
          allowToolJit: opts.allowToolJit ?? true,
        });
      },
    };
  } catch {
    return {};
  }
}
