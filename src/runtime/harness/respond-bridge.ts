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
import { runConversation, verifiedWorkflowRunDispatchReceipts, type RunConversationOptions } from './loop.js';
import { resolveAcceptedTurnRead, type AcceptedTurnReadPorts, type AcceptedTurnReadResult } from '../read-path/read-lane-chat.js';
import { buildProductionReadPortsForAcceptedTurn } from '../read-path/read-lane-adapters.js';
import { currentAcceptedReadAuthority } from '../read-path/accepted-read-authority.js';
import type { TurnCapabilityCandidates } from '../read-path/capability-candidates.js';
import { enrichAcceptedRequestWithTaskContinuity } from './task-continuity-runtime.js';
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
import { listPending } from './approval-registry.js';
import { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain, isClaudeSdkUnparseableToolCall } from './claude-agent-brain.js';
import { ClaudeSdkCapacityExhaustedError, ClaudeSdkProviderOverloadError } from './claude-agent-sdk.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import { getModelRoutingMode, getRuntimeEnv } from '../../config.js';
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
import { clearRunInFlightAfterTerminal, markRunInFlight } from './restart-recovery.js';
import { recordTurnGraphShadow } from '../graph/turn-graph-shadow.js';
import { recordWarmProcedureUse } from '../../memory/procedure-receipts.js';
import { warmReadToolPolicyDigest } from '../read-path/warm-read-policy.js';
import {
  assessCompletedAnswerReplay,
  isExplicitCompletedAnswerReplay,
  readCompletedAnswerReplayProtection,
  type CompletedAnswerReplayProtectionReader,
} from './completed-answer-replay.js';

export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli' | 'dashboard' | 'home' | 'workflow' | 'discord' | 'slack';

function observeAcceptedBridgeTurnGraph(
  surface: HarnessSurface,
  request: AssistantRequest,
  source: EventRow,
): void {
  recordTurnGraphShadow({
    identity: {
      sessionId: request.sessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
    },
    surface,
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

async function runLegacyBreakGlass(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
): Promise<AssistantResponse> {
  const {
    onChunk: _rawChunk,
    onReasoning: _rawReasoning,
    onToolActivity,
    ...baseRequest
  } = request;
  const safeRequest: AssistantRequest = {
    ...baseRequest,
    ...(onToolActivity
      ? {
          onToolActivity: (activity: ToolActivity) => onToolActivity({
            toolName: activity.toolName,
            input: {},
          }),
        }
      : {}),
  };
  const response = await legacyRespond(safeRequest);
  return withRouteDiagnostics({
    ...response,
    text: publicReplyText(
      response.text,
      'I could not produce a safe final answer for that turn. Please ask me to try again.',
    ),
  }, routeForLegacyFallback(surface, request));
}

function blockedPreRunResponse(
  surface: HarnessSurface,
  request: AssistantRequest,
  userText: string,
  details?: Record<string, unknown>,
): AssistantResponse {
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
        attemptId: preflightAttempt.attemptId,
        source: `bridge:${surface}`,
      },
    }, { existingEventSeq: request.sourceUserSeq, armRunInFlight: true });
    observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
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
    markRunInFlight(request.sessionId, false);
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
    stoppedReason: 'error',
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

/**
 * Serve a verified warm read as the whole turn (E4). Returns null on any
 * decline — the ordinary brain then runs unchanged with the same request.
 * The accepted source and the exactly-once TurnOutcome commit use the SAME
 * machinery as every other bridge terminal: nothing here is a second
 * committer.
 */
async function serveAcceptedTurnReadUnderAuthority(
  surface: HarnessSurface,
  request: AssistantRequest,
  authority: NonNullable<ReturnType<typeof currentAcceptedReadAuthority>>,
): Promise<AssistantResponse | null> {
  let ports: AcceptedTurnReadPorts | null = null;
  try {
    ports = await acceptedTurnReadPortsImpl(surface, request);
  } catch { ports = null; }
  if (!ports) return null; // fail closed: no derived authority, no lane
  if (await warmReadCancellationRequested(request, authority)) return null;
  let served: AcceptedTurnReadResult;
  try {
    served = await resolveAcceptedTurnRead(
      { sessionId: request.sessionId, message: request.message, seq: String(authority.source.seq) },
      ports,
    );
  } catch {
    return null; // typed resolver trouble never breaks an ordinary turn
  }
  if (served.kind === 'spent') {
    const stoppedResponse = (): AssistantResponse => withRouteDiagnostics({
      text: 'That read stopped after the provider was contacted, so I did not run it again.',
      sessionId: request.sessionId,
      stoppedReason: 'cancelled',
      raw: {
        readLane: {
          warm: true,
          spent: true,
          terminalCommitted: false,
          counters: served.counters,
        },
      },
    }, {
      routeKind: 'harness',
      surface,
      requestedModel: request.model,
      effectiveModel: 'read-lane-warm',
      provider: 'verified-procedure',
      transport: 'read_lane_warm_spent',
      mode: getModelRoutingMode(),
    });

    // A spent read must never fall through into another brain/provider. Only
    // the still-current, non-killed attempt may publish a durable blocked
    // terminal; a stale invocation returns a non-retrying stopped response and
    // leaves a newer attempt's terminal authority untouched.
    const current = currentAcceptedReadAuthority(
      request.sessionId,
      request.sourceUserSeq,
      request.runId,
      request.message,
    );
    if (!current || current.attempt.attemptId !== authority.attempt.attemptId
      || await warmReadCancellationRequested(request, authority)) {
      try { finishRunAttempt(authority.attempt, 'cancelled'); } catch { /* telemetry */ }
      return stoppedResponse();
    }
    try {
      const sourceUserEvent = authority.source;
      const identity: TurnIdentity = {
        sessionId: request.sessionId,
        turn: sourceUserEvent.turn,
        sourceUserSeq: sourceUserEvent.seq,
      };
      const committedCounters = {
        ...served.counters,
        public_terminals: served.counters.public_terminals + 1,
      };
      const committed = commitTurnOutcomeImpl({
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'blocked',
        resumable: false,
        presentation: {
          kind: 'blocked',
          text: 'The connected read ran, but its result could not be safely presented. I did not run it again.',
        },
      }, {
        legacyReason: 'warm_read_spent',
        metadata: {
          transport: 'read_lane_warm_spent',
          laneDigest: served.laneDigest,
          counters: committedCounters as unknown as Record<string, unknown>,
          warmReadPolicyDigest: warmReadToolPolicyDigest(request),
        },
      });
      if (!committed.inserted) {
        try { finishRunAttempt(authority.attempt, 'superseded'); } catch { /* telemetry */ }
        return responseForExactTerminalReplayUnderPolicy(surface, request, committed.event);
      }
      served.counters.public_terminals = committedCounters.public_terminals;
      observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
      try { finishRunAttempt(authority.attempt, 'failed'); } catch { /* telemetry */ }
      clearRunInFlightAfterTerminal(
        request.sessionId,
        authority.attempt.attemptId,
        authority.source.seq,
      );
      return withRouteDiagnostics({
        text: committed.presentation.text,
        sessionId: request.sessionId,
        stoppedReason: 'error',
        raw: {
          readLane: {
            warm: true,
            spent: true,
            terminalCommitted: true,
            counters: served.counters,
          },
        },
      }, {
        routeKind: 'harness',
        surface,
        requestedModel: request.model,
        effectiveModel: 'read-lane-warm',
        provider: 'verified-procedure',
        transport: 'read_lane_warm_spent',
        mode: getModelRoutingMode(),
      });
    } catch {
      return stoppedResponse();
    }
  }
  if (served.kind !== 'served') return null;
  const stoppedAfterSuccessfulDispatch = (): AssistantResponse => withRouteDiagnostics({
    text: 'That read stopped after the provider returned, so I did not run it again.',
    sessionId: request.sessionId,
    stoppedReason: 'cancelled',
    raw: {
      readLane: {
        warm: true,
        spent: true,
        terminalCommitted: false,
        artifactId: served.artifactId,
        counters: served.counters,
      },
    },
  }, {
    routeKind: 'harness',
    surface,
    requestedModel: request.model,
    effectiveModel: 'read-lane-warm',
    provider: 'verified-procedure',
    transport: 'read_lane_warm_stopped',
    mode: getModelRoutingMode(),
  });
  if (await warmReadCancellationRequested(request, authority)) {
    try { finishRunAttempt(authority.attempt, 'cancelled'); } catch { /* telemetry */ }
    return stoppedAfterSuccessfulDispatch();
  }
  try {
    // Provider work may have awaited account/schema state. Re-prove that the
    // exact same physical attempt still owns this accepted source before the
    // public terminal is committed.
    const current = currentAcceptedReadAuthority(
      request.sessionId,
      request.sourceUserSeq,
      request.runId,
      request.message,
    );
    if (!current || current.attempt.attemptId !== authority.attempt.attemptId) {
      try { finishRunAttempt(authority.attempt, 'cancelled'); } catch { /* telemetry */ }
      return stoppedAfterSuccessfulDispatch();
    }
    const sourceUserEvent = authority.source;
    const identity: TurnIdentity = {
      sessionId: request.sessionId,
      turn: sourceUserEvent.turn,
      sourceUserSeq: sourceUserEvent.seq,
    };
    const committedCounters = {
      ...served.counters,
      public_terminals: served.counters.public_terminals + 1,
    };
    const committed = commitTurnOutcomeImpl({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: served.draft },
    }, {
      metadata: {
        transport: 'read_lane_warm',
        artifactId: served.artifactId,
        laneDigest: served.laneDigest,
        counters: committedCounters as unknown as Record<string, unknown>,
        warmReadPolicyDigest: warmReadToolPolicyDigest(request),
      },
    });
    if (!committed.inserted) {
      try { finishRunAttempt(authority.attempt, 'superseded'); } catch { /* telemetry */ }
      return responseForExactTerminalReplayUnderPolicy(surface, request, committed.event);
    }
    served.counters.public_terminals = committedCounters.public_terminals;
    // A provider receipt is not a served answer. Credit the artifact only
    // after its exact public TurnOutcome has durably won publication.
    try { recordWarmProcedureUse(served.artifactId); } catch { /* telemetry */ }
    observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
    try { finishRunAttempt(authority.attempt, 'completed'); } catch { /* telemetry */ }
    clearRunInFlightAfterTerminal(
      request.sessionId,
      authority.attempt.attemptId,
      authority.source.seq,
    );
    return withRouteDiagnostics({
      text: committed.presentation.text,
      sessionId: request.sessionId,
      raw: {
        readLane: {
          warm: true,
          artifactId: served.artifactId,
          counters: served.counters,
        },
      },
    }, {
      routeKind: 'harness',
      surface,
      requestedModel: request.model,
      effectiveModel: 'read-lane-warm',
      provider: 'verified-procedure',
      transport: 'read_lane_warm',
      mode: getModelRoutingMode(),
    });
  } catch {
    // Provider work and a verified receipt already exist. A commit race may
    // replay its durable winner, but must never fall through to another brain.
    try {
      const winner = exactTerminalReplayForRequest(request);
      if (winner) return responseForExactTerminalReplayUnderPolicy(surface, request, winner);
    } catch { /* return the non-retrying stopped response below */ }
    return stoppedAfterSuccessfulDispatch();
  }
}

/**
 * One daemon owns one in-process warm activation per accepted attempt/source.
 * Followers await the exact same promise, so two concurrent transports cannot
 * both pass the preflight check and dispatch before terminal de-duplication.
 * Cross-process/durable admission remains graph-engine work; this deliberately
 * does not pretend to provide it.
 */
interface AcceptedWarmReadInFlight {
  policyDigest: string;
  promise: Promise<AssistantResponse | null>;
}
const acceptedWarmReadsInFlight = new Map<string, AcceptedWarmReadInFlight>();

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

async function warmReadCancellationRequested(
  request: AssistantRequest,
  authority: NonNullable<ReturnType<typeof currentAcceptedReadAuthority>>,
): Promise<boolean> {
  if (isKillRequested(request.sessionId, {
    attemptId: authority.attempt.attemptId,
    runId: authority.attempt.runId,
    sourceUserSeq: authority.source.seq,
  })) return true;
  const current = currentAcceptedReadAuthority(
    request.sessionId,
    request.sourceUserSeq,
    request.runId,
    request.message,
  );
  if (!current || current.attempt.attemptId !== authority.attempt.attemptId) return true;
  if (!request.shouldCancel) return false;
  try {
    if (!await request.shouldCancel()) return false;
    try {
      requestKill(request.sessionId, 'cancelled by caller before warm-read dispatch', authority.attempt);
    } catch { /* the exact attempt may have been superseded while polling */ }
    return true;
  } catch {
    // Match the ordinary bridge cancellation contract: a broken predicate is
    // observability trouble, not cancellation authority.
    return false;
  }
}

async function tryServeAcceptedTurnRead(
  surface: HarnessSurface,
  request: AssistantRequest,
): Promise<AssistantResponse | null> {
  // Warm execution never creates its own authority. Only an outer surface that
  // already accepted the user event and bound the current active attempt may
  // enter; every other request continues through the ordinary brain, whose
  // existing acceptance path remains unchanged.
  const authority = currentAcceptedReadAuthority(
    request.sessionId,
    request.sourceUserSeq,
    request.runId,
    request.message,
  );
  if (!authority) return null;
  if (Array.isArray(request.allowedToolNames)
    && !request.allowedToolNames.includes('composio_execute_tool')) return null;
  if (request.excludeToolNames?.includes('composio_execute_tool')) return null;
  if (await warmReadCancellationRequested(request, authority)) return null;

  const key = `${request.sessionId}:${authority.source.seq}:${authority.attempt.attemptId}`;
  const existing = acceptedWarmReadsInFlight.get(key);
  const policyDigest = warmReadToolPolicyDigest(request);
  if (existing) {
    if (existing.policyDigest === policyDigest) return existing.promise;
    // Same accepted source presented concurrently under different authority is
    // not coalescible and must not fall through to a second brain/provider.
    return responseForWarmReadPolicyConflict(surface, request);
  }

  const activation = serveAcceptedTurnReadUnderAuthority(surface, request, authority);
  const entry = { policyDigest, promise: activation };
  acceptedWarmReadsInFlight.set(key, entry);
  try {
    return await activation;
  } finally {
    if (acceptedWarmReadsInFlight.get(key) === entry) acceptedWarmReadsInFlight.delete(key);
  }
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
type RecoveryListEventsFn = typeof listEvents;
type CommitTurnOutcomeFn = typeof commitTurnOutcome;
/** The shared accepted-turn read resolver (E4). Production default builds
 *  fail-closed ports; tests inject deterministic ones. */
type AcceptedTurnReadPortsFactory = (
  surface: HarnessSurface,
  request: AssistantRequest,
) => AcceptedTurnReadPorts | null | Promise<AcceptedTurnReadPorts | null>;
let runConversationImpl: RunConversationFn = runConversation;
let buildAgentImpl: BuildAgentFn = buildOrchestratorAgent;
let configureImpl: ConfigureFn = configureHarnessRuntime;
let claudeAgentBrainImpl: ClaudeAgentBrainFn = respondViaClaudeAgentSdkBrain;
let recoveryListEventsImpl: RecoveryListEventsFn = listEvents;
let commitTurnOutcomeImpl: CommitTurnOutcomeFn = commitTurnOutcome;
let completedAnswerReplayProtectionImpl: CompletedAnswerReplayProtectionReader = readCompletedAnswerReplayProtection;
const productionAcceptedTurnReadPorts: AcceptedTurnReadPortsFactory = async (_surface, request) => {
  const authority = currentAcceptedReadAuthority(
    request.sessionId,
    request.sourceUserSeq,
    request.runId,
    request.message,
  );
  if (!authority) return null;
  return buildProductionReadPortsForAcceptedTurn({
    sessionId: request.sessionId,
    sourceUserSeq: authority.source.seq,
    sourceTurn: authority.source.turn,
    attemptId: authority.attempt.attemptId,
    runId: authority.attempt.runId,
    message: request.message,
    allowedToolNames: request.allowedToolNames,
    excludedToolNames: request.excludeToolNames,
    cancellationRequested: () => warmReadCancellationRequested(request, authority),
  });
};
let acceptedTurnReadPortsImpl: AcceptedTurnReadPortsFactory = productionAcceptedTurnReadPorts;
export function _setBridgeImplsForTests(impls: {
  runConversation?: RunConversationFn | null;
  buildAgent?: BuildAgentFn | null;
  configure?: ConfigureFn | null;
  claudeAgentBrain?: ClaudeAgentBrainFn | null;
  recoveryListEvents?: RecoveryListEventsFn | null;
  commitTurnOutcome?: CommitTurnOutcomeFn | null;
  completedAnswerReplayProtection?: CompletedAnswerReplayProtectionReader | null;
  acceptedTurnReadPorts?: AcceptedTurnReadPortsFactory | null;
}): void {
  runConversationImpl = impls.runConversation ?? runConversation;
  buildAgentImpl = impls.buildAgent ?? buildOrchestratorAgent;
  configureImpl = impls.configure ?? configureHarnessRuntime;
  claudeAgentBrainImpl = impls.claudeAgentBrain ?? respondViaClaudeAgentSdkBrain;
  recoveryListEventsImpl = impls.recoveryListEvents ?? listEvents;
  commitTurnOutcomeImpl = impls.commitTurnOutcome ?? commitTurnOutcome;
  completedAnswerReplayProtectionImpl = impls.completedAnswerReplayProtection ?? readCompletedAnswerReplayProtection;
  acceptedTurnReadPortsImpl = impls.acceptedTurnReadPorts ?? productionAcceptedTurnReadPorts;
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
}): string {
  const identity: TurnIdentity = {
    sessionId: input.sessionId,
    turn: Math.max(0, Math.trunc(input.sourceTurn)),
    sourceUserSeq: input.sourceUserSeq,
  };
  const completedWork = synthesizeCompletedWorkReport(input.sessionId, input.sourceUserSeq);
  const text = completedWork || (input.completedReason === 'no_structured_output'
    ? 'I could not produce a safe final answer for that turn. Please ask me to try again.'
    : 'I could not complete that run safely. Please ask me to continue from the recorded state.');
  const committed = commitTurnOutcomeImpl({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text },
  }, {
    legacyReason: input.completedReason,
    metadata: { steps: input.steps },
  });
  markRunInFlight(input.sessionId, false);
  return committed.presentation.text;
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
function ensureAcceptedRecoveryTurn(
  surface: HarnessSurface,
  request: AssistantRequest,
): AcceptedRecoveryTurn {
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
      attemptId: attempt.attemptId,
      source: 'bridge:recovery',
    },
  }, { existingEventSeq: source?.seq, armRunInFlight: true });
  observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
  return { attempt, sourceUserSeq: sourceUserEvent.seq, sourceTurn: sourceUserEvent.turn };
}

function exactTerminalForSource(sessionId: string, sourceUserSeq: number): EventRow | null {
  const logicalKey = `turn:${sourceUserSeq}`;
  return listEvents(sessionId, { types: ['conversation_completed'], desc: true })
    .find((event) => event.data.terminalKey === logicalKey
      || event.data.sourceUserSeq === sourceUserSeq
      || (event.data.presentation as { identity?: { sourceUserSeq?: unknown } } | undefined)
        ?.identity?.sourceUserSeq === sourceUserSeq)
    ?? null;
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

function exactTerminalReplayForRequest(request: AssistantRequest): EventRow | null {
  const source = acceptedSourceIdentityForReplay(request);
  return source ? exactTerminalForSource(request.sessionId, source.seq) : null;
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

/** A transport retry for an already-published accepted source is a pure
 * durable replay. It must not create a new attempt, rebuild warm ports, or run
 * a brain merely to lose a second exactly-once commit race. */
function responseForExactTerminalReplay(
  surface: HarnessSurface,
  request: AssistantRequest,
  event: EventRow,
): AssistantResponse {
  const response = responseForCommittedTerminal(event, {
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
  event: EventRow,
): AssistantResponse {
  return durableWarmReadPolicyMatches(request, event)
    ? responseForExactTerminalReplay(surface, request, event)
    : responseForWarmReadPolicyConflict(surface, request);
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
      return responseForExactTerminalReplayUnderPolicy(surface, request, committed.event);
    }
    observeAcceptedBridgeTurnGraph(surface, request, current.source);
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
    } catch { /* normal authority retains recovery ownership */ }
    return null;
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
    resumable: true,
    presentation: { kind: 'blocked', text: input.text },
  }, {
    legacyReason: input.reason,
    metadata: input.metadata,
  });
  markRunInFlight(input.request.sessionId, false);
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
  markRunInFlight(input.request.sessionId, false);
  return committed.event;
}

export async function respondViaHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  opts: { reuseRecordedUserInput?: boolean; sourceUserSeq?: number; modelOverride?: string } = {},
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
  // Rehydrate private continuation state only from the exact durable source.
  // Caller-supplied semantic context is stripped when no valid packet exists.
  request = await enrichAcceptedRequestWithTaskContinuity(request, sourceUserEvent.seq);
  observeAcceptedBridgeTurnGraph(surface, request, sourceUserEvent);
  // Source binding and the chat recovery marker committed atomically above, so
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
    const buildAgent: NonNullable<RunConversationOptions['buildAgent']> = (identity) => {
      acceptedBuildIdentity = identity;
      return buildAgentImpl({
        userInput: request.message,
        sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedRoute: identity.route,
        allowedToolNames: request.allowedToolNames,
        excludeToolNames: request.excludeToolNames,
        // The turn's advisory capability candidates ride the request into the
        // agent build — the only delivery path, shared by both brains.
        ...(request.turnCandidates ? { turnCandidates: request.turnCandidates } : {}),
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
      ...(request.taskContinuation ? { taskContinuation: request.taskContinuation } : {}),
      ...(request.taskContinuationResolved ? { taskContinuationResolved: true as const } : {}),
      sourceUserSeq: sourceUserEvent.seq,
      runAttemptId: requestAttempt.attemptId,
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
      reuseRecordedUserInput: true,
      falloverModelIds: fallover.falloverModelIds,
      rebuildAgentForBrain: fallover.rebuildAgentForBrain,
    });
    requestAttemptStatus = result.status === 'killed'
      ? 'cancelled'
      : result.status === 'failed'
        ? 'failed'
        : 'completed';

    const replyText = publicReplyText(result.publicPresentation?.text, '')
      || publicReplyText(result.lastDecision?.reply, '');

    switch (result.status) {
      case 'dispatched': {
        const dispatch = exactAsyncDispatchForSource(sourceUserEvent);
        if (!dispatch) {
          throw new Error('Harness returned dispatched without exact durable dispatch authority.');
        }
        return withRouteDiagnostics({
          text: dispatch.text,
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
            const terminal = commitBridgeBlockedTerminal({
              request,
              turn: {
                attempt: requestAttempt,
                sourceUserSeq: sourceUserEvent.seq,
                sourceTurn: sourceUserEvent.turn,
              },
              text: blockedText,
              reason: recoveryCheck.reason === 'external_write'
                ? 'parse_recovery_external_write'
                : 'parse_recovery_ledger_unreadable',
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
          const text = commitRecoveryCandidateTerminal({
            sessionId,
            sourceUserSeq: sourceUserEvent.seq,
            sourceTurn: sourceUserEvent.turn,
            steps: result.steps,
            completedReason: result.completedReason,
          });
          return withRouteDiagnostics({
            text,
            sessionId,
            stoppedReason: 'error',
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
        transport: 'openai_agents_harness',
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
        transport: 'openai_agents_harness',
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
 * Falls back to legacy ONLY pre-run (flag off, per-call tool excludes, auth
 * unavailable) — never after the harness run has started.
 */
async function respondPreferHarnessOnce(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
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
      if (committed) return responseForExactTerminalReplayUnderPolicy(surface, request, committed);
      const warmSpent = exactWarmProviderSpentForRequest(request);
      if (warmSpent) {
        return durableWarmReadPolicyMatches(request, warmSpent)
          ? responseForWarmProviderSpentReplay(surface, request)
          : responseForWarmReadPolicyConflict(surface, request);
      }
    } catch { /* no readable exact terminal: proceed through normal authority */ }
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
    if (legacyRespondFallbackEnabled() && request.allowedToolNames === undefined) {
      bridgeLogger.warn({ surface, reason: 'surface_disabled' }, 'explicit legacy respond fallback engaged');
      return runLegacyBreakGlass(surface, request, legacyRespond);
    }
    return blockedPreRunResponse(
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
    if (legacyRespondFallbackEnabled() && request.allowedToolNames === undefined) {
      bridgeLogger.warn({ surface, excludeToolNames: request.excludeToolNames, reason: 'non_filterable_excludes' }, 'explicit legacy respond fallback engaged');
      return runLegacyBreakGlass(surface, request, legacyRespond);
    }
    const unsafe = nonFilterableToolExcludes(request.excludeToolNames, HARNESS_FILTERABLE_TOOLS);
    return blockedPreRunResponse(
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
    if (legacyRespondFallbackEnabled() && request.allowedToolNames === undefined) {
      bridgeLogger.warn({ surface, reason: 'harness_auth_unavailable', authReason: auth.reason }, 'explicit legacy respond fallback engaged');
      return runLegacyBreakGlass(surface, request, legacyRespond);
    }
    return blockedPreRunResponse(
      surface,
      request,
      'I could not start this turn because no model runtime is connected. Open Settings > Models, connect a model, and try again.',
      { reason: 'harness_auth_unavailable', authReason: auth.reason },
    );
  }
  // E4: the shared accepted-turn READ resolver — ONE provider-neutral entry
  // both brains flow through with the same accepted source. A deterministic
  // decline costs ordinary chat nothing (no model call, no tool schema, no
  // discovery); a verified warm read commits ONE typed terminal through the
  // existing exactly-once committer and no brain runs at all.
  const readServed = await tryServeAcceptedTurnRead(surface, request);
  if (readServed) return readServed;

  if (claudeAgentSdkBrainEnabled(surface)) {
    // Claude diverges before respondViaHarness, so rehydrate only an actual
    // exact-source continuation here. Ordinary turns avoid a duplicate semantic
    // candidate-resolution pass; the Claude lane owns their normal routing.
    if (Number.isSafeInteger(request.sourceUserSeq) && Number(request.sourceUserSeq) > 0) {
      request = await enrichAcceptedRequestWithTaskContinuity(
        request,
        Number(request.sourceUserSeq),
        { continuationOnly: true },
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
        const owner = ensureAcceptedRecoveryTurn(surface, request);
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
      return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
    } catch (err) {
      let restartOwnershipDetected = false;
      try {
        const turn = ensureAcceptedRecoveryTurn(surface, request);
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
        const turn = ensureAcceptedRecoveryTurn(surface, request);
        if (err instanceof Error && (err as { narrationGiveUp?: boolean }).narrationGiveUp === true) {
          const terminal = commitBridgeBlockedTerminal({
            request,
            turn,
            text: publicReplyText(
              err.message,
              'I could not complete that turn safely. Please ask me to try again.',
            ),
            reason: 'narration_giveup',
            metadata: { transport: 'claude_agent_sdk_brain' },
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
  return respondViaHarness(surface, request);
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
): Promise<AssistantResponse> {
  let key: string | null = null;
  try {
    const source = acceptedSourceIdentityForReplay(request);
    // source.seq is the immutable logical-turn identity. The ordinary harness
    // may rotate its physical run attempt while this promise is in flight;
    // that must not split ownership and admit a warm sibling.
    if (source) key = `${request.sessionId}:${source.seq}`;
  } catch { key = null; }
  if (!key) return respondPreferHarnessOnce(surface, request, legacyRespond);

  const policyDigest = warmReadToolPolicyDigest(request);
  const existing = acceptedSourceInvocationsInFlight.get(key);
  if (existing) {
    return existing.policyDigest === policyDigest
      ? existing.promise
      : responseForWarmReadPolicyConflict(surface, request);
  }

  const promise = respondPreferHarnessOnce(surface, request, legacyRespond);
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

type RecoveryLedgerBaseline =
  | { readable: true; afterSeq: number }
  | { readable: false };

type RecoveryLedgerCheck =
  | { safeToRerun: true }
  | { safeToRerun: false; reason: 'external_write'; evidence: EventRow[] }
  | { safeToRerun: false; reason: 'ledger_unreadable'; evidence: [] };

function captureRecoveryLedgerBaseline(sessionId: string): RecoveryLedgerBaseline {
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
  const recorded = check.reason === 'external_write'
    ? synthesizeWorkReport(check.evidence)?.replace(
        /^I finished — here's what I did this turn:/,
        'Before Claude stopped, the action ledger recorded:',
      )
    : null;
  const text = check.reason === 'external_write'
    ? `${recorded ?? 'The action ledger recorded an external write attempt but did not confirm a completed change.'}\n\nClaude stopped before it finished the turn. I did not rerun the task on another model because that could repeat or conflict with the external action.`
    : 'Claude stopped before it finished the turn. I could not verify the external-write ledger for this attempt, so I did not rerun the task on another model. The recovery path made no additional changes.';
  const terminal = commitBridgeBlockedTerminal({
    request,
    turn,
    text,
    reason: check.reason === 'external_write'
      ? 'claude_recovery_external_write'
      : 'claude_recovery_ledger_unreadable',
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
): Promise<AssistantResponse | null> {
  // Resolve logical ownership before checking retry eligibility. A provider can
  // throw after its terminal committed (for example, a learning hook or local
  // DB write). That exact terminal is already the answer and must short-circuit
  // every recovery path, including errors whose provider flags say "committed".
  let turn: AcceptedRecoveryTurn;
  try {
    turn = ensureAcceptedRecoveryTurn(surface, request);
    const committed = exactTerminalForSource(request.sessionId, turn.sourceUserSeq);
    if (committed) {
      markRunInFlight(request.sessionId, false);
      const response = responseForCommittedTerminal(committed, {
        recoverySkipped: 'terminal_already_committed',
        transport: 'claude_agent_sdk_brain',
      });
      return withRouteDiagnostics(response, routeForClaudeSdkBrain(surface, request, response));
    }
  } catch {
    // If exact ownership cannot be established, never authorize a rerun. The
    // caller's generic failure reducer will make one final fail-closed attempt.
    return null;
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
    const recovered = await respondViaHarness(surface, request, {
      reuseRecordedUserInput: true,
      sourceUserSeq: turn.sourceUserSeq,
      modelOverride: recoveryModel,
    });
    if (exactTerminalForSource(request.sessionId, turn.sourceUserSeq)) {
      markRunInFlight(request.sessionId, false);
    }
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
  taskContinuation?: import('../../types.js').TaskContinuationContext;
  taskContinuationResolved?: true;
  acceptedIdentity?: () => {
    sourceUserSeq: number;
    route: 'direct_reply' | 'retrieve' | 'act';
  } | undefined;
  buildAgent: (o: { userInput?: string; sessionId: string; sourceUserSeq?: number; acceptedRoute?: 'direct_reply' | 'retrieve' | 'act'; allowedToolNames?: string[]; excludeToolNames?: string[]; model?: string; allowToolJit?: boolean; turnCandidates?: TurnCapabilityCandidates; taskContinuation?: import('../../types.js').TaskContinuationContext; taskContinuationResolved?: true }) => Promise<BuiltAgent>;
}): { falloverModelIds?: string[]; rebuildAgentForBrain?: (modelId: string) => Promise<BuiltAgent> } {
  if (!chatBrainFalloverEnabled()) return {};
  try {
    if (falloverChainForTest) {
      const modelIds = falloverChainForTest;
      return {
        falloverModelIds: modelIds,
        rebuildAgentForBrain: (modelId: string) => {
          const identity = opts.acceptedIdentity?.();
          return opts.buildAgent({
          userInput: opts.userInput,
          sessionId: opts.sessionId,
          ...(identity ? { sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route } : {}),
          ...(opts.turnCandidates ? { turnCandidates: opts.turnCandidates } : {}),
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
      rebuildAgentForBrain: (modelId: string) => {
        const identity = opts.acceptedIdentity?.();
        return opts.buildAgent({
        userInput: opts.userInput,
        sessionId: opts.sessionId,
        ...(identity ? { sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route } : {}),
        ...(opts.turnCandidates ? { turnCandidates: opts.turnCandidates } : {}),
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
