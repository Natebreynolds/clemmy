import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import {
  cancelBackgroundTask,
  findSoleAwaitingContinueTaskForOrigin,
  findSoleAwaitingInputTaskForOrigin,
  getBackgroundTask,
  listBackgroundTasks,
  queueBackgroundTaskContinue,
  queueBackgroundTaskInputResolution,
  renderBackgroundTask,
  renderBackgroundTaskList,
  resumeBackgroundTask,
} from '../execution/background-tasks.js';
import { enqueueDurableChatTask, shouldPromoteToDurable } from '../execution/background-promote.js';
import { addRunEvent, finishRun, getRun, listRuns, startRun, type RunRecord } from '../runtime/run-events.js';
import { applyProposedFix, dismissProposedFix, listProposedFixes, loadProposedFix, revertWorkflowFix } from '../execution/workflow-diagnosis.js';
import { requeueWorkflowFromRun } from '../tools/workflow-run-queue.js';
import { verifyDelivered } from '../runtime/harness/verify-delivered.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import {
  beginRunAttempt,
  createSession as createHarnessSession,
  finishRunAttempt,
  getLatestRunAttemptByRunId,
  getSession as getHarnessSession,
  listEvents as listHarnessEvents,
  recordRunAttemptUserInput,
  type EventRow,
  type RunAttemptRef,
} from '../runtime/harness/eventlog.js';
import { commitTurnOutcome } from '../runtime/harness/delivery-committer.js';
import { clearRunInFlightAfterTerminal } from '../runtime/harness/restart-recovery.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  publicUserInputText,
} from '../runtime/harness/public-presentation.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
  type TurnIdentity,
  type TurnOutcome,
} from '../runtime/harness/turn-outcome.js';
import { deriveTitle } from '../memory/derive-title.js';
import type { AssistantResponse, AssistantRouteDiagnostics, ToolActivity } from '../types.js';

const logger = pino({ name: 'clementine-next.gateway' });

export interface GatewayRequest {
  message: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  model?: string;
  source?: 'discord' | 'webhook' | 'cli' | 'gateway' | 'mobile';
  runId?: string;
  /** Provider/client retries may arrive after the process died with an
   *  accepted source but before a public terminal.  Transport ingress uses
   *  this fail-closed policy so an uncertain prior write is never dispatched
   *  a second time merely because the HTTP/gateway delivery was retried. */
  failClosedOnUnsettledReplay?: boolean;
  /** Synchronous acceptance hook for channel control planes. It fires only
   *  after the durable source/run binding exists and before any command,
   *  mutation, model, or tool dispatch. */
  onAcceptedTurn?: (accepted: { source: EventRow; attempt: RunAttemptRef | null }) => void;
  /** Public-reply delta callback. Raw executor/model output is classified and
   *  committed inside the runtime before it may reach this boundary. */
  onChunk?: (delta: string) => Promise<void> | void;
  /** Reasoning-text callback for o-series-style models. Captured for
   *  run-timeline observability via assistant.respond. */
  onReasoning?: (text: string) => Promise<void> | void;
  /** Tool-call activity callback. Used by channel UIs to show live
   *  progress such as file reads, shell commands, and Composio calls. */
  onToolActivity?: (activity: ToolActivity) => Promise<void> | void;
}

export interface GatewayResponse {
  text: string;
  sessionId: string;
  queuedTaskId?: string;
  pendingApprovalId?: string;
  handledControl?: boolean;
  runId?: string;
  /** Why the underlying runtime stopped. When 'max-turns-with-grace',
   *  channel UIs should surface a [Continue] affordance so the user
   *  can resume without typing "continue" by hand. */
  stoppedReason?: string;
  /** How many turns were consumed before stopping. */
  turnsUsed?: number;
  /** Best-effort model route diagnostics for caller/debug parity. */
  route?: AssistantRouteDiagnostics;
}

type GatewayCommand =
  | { type: 'list_tasks' }
  | { type: 'task_status'; id: string }
  | { type: 'cancel_task'; id: string }
  | { type: 'resume_task'; id: string }
  | { type: 'list_runs' }
  | { type: 'stop_active' }
  | { type: 'run_status'; id: string }
  | { type: 'list_fixes' }
  | { type: 'apply_fix'; id: string }
  | { type: 'dismiss_fix'; id: string }
  | { type: 'revert_heal'; id: string };

function parseCommand(message: string): GatewayCommand | null {
  const normalized = message.trim();
  const withoutSlash = normalized.startsWith('/') ? normalized.slice(1).trim() : normalized;

  if (/^(tasks|background tasks|jobs|executions)$/i.test(withoutSlash)) {
    return { type: 'list_tasks' };
  }

  if (/^(runs|recent runs|run list|run history)$/i.test(withoutSlash)) {
    return { type: 'list_runs' };
  }

  const statusMatch = withoutSlash.match(/^(?:status|task|job)\s+(bg-[a-z0-9]+-[a-f0-9]+)$/i);
  if (statusMatch) {
    return { type: 'task_status', id: statusMatch[1] };
  }

  const runMatch = withoutSlash.match(/^(?:status|run|show run)\s+(run-[a-z0-9-]+)$/i);
  if (runMatch) {
    return { type: 'run_status', id: runMatch[1] };
  }

  const cancelMatch = withoutSlash.match(/^(?:stop|cancel|abort)\s+(bg-[a-z0-9]+-[a-f0-9]+)$/i);
  if (cancelMatch) {
    return { type: 'cancel_task', id: cancelMatch[1] };
  }

  // Bare "stop" (no id) — panic stop. Resolves to the most-recently-
  // active thing on this channel/session at dispatch time. Added
  // 2026-05-24 after the daily-prospect-outreach run kept advancing
  // and the user's bare "stop" did nothing because the gateway only
  // recognized the "stop <bg-task-id>" form.
  if (/^(stop|cancel|abort|halt)$/i.test(withoutSlash)) {
    return { type: 'stop_active' };
  }

  const resumeMatch = withoutSlash.match(/^(?:resume|continue)\s+(bg-[a-z0-9]+-[a-f0-9]+)$/i);
  if (resumeMatch) {
    return { type: 'resume_task', id: resumeMatch[1] };
  }

  // Self-heal: approve/skip a proposed workflow fix Clem diagnosed.
  if (/^(fixes|list fixes|proposed fixes)$/i.test(withoutSlash)) {
    return { type: 'list_fixes' };
  }
  const applyFixMatch = withoutSlash.match(/^(?:apply|approve|accept)\s+fix\s+(fix-[a-z0-9]+)$/i);
  if (applyFixMatch) {
    return { type: 'apply_fix', id: applyFixMatch[1].toLowerCase() };
  }
  const dismissFixMatch = withoutSlash.match(/^(?:dismiss|skip|reject|decline)\s+fix\s+(fix-[a-z0-9]+)$/i);
  if (dismissFixMatch) {
    return { type: 'dismiss_fix', id: dismissFixMatch[1].toLowerCase() };
  }
  // Reverse an applied auto-fix (self-improvement #7): `revert heal heal-xxxx`.
  const revertHealMatch = withoutSlash.match(/^(?:revert|undo)\s+(?:heal|fix)\s+(heal-[a-z0-9]+)$/i);
  if (revertHealMatch) {
    return { type: 'revert_heal', id: revertHealMatch[1].toLowerCase() };
  }

  return null;
}

function isBareContinue(message: string): boolean {
  const t = message.trim().toLowerCase();
  return t === '/continue' || t === 'continue' || t === 'keep going';
}

function isContinueCompletionReason(reason: unknown): boolean {
  return reason === 'awaiting_continue' || reason === 'limit_exceeded';
}

function buildContinueInput(lastSummary: string | undefined): string {
  return [
    'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
    'Pick up where you left off; do not restart the workflow from scratch.',
    lastSummary
      ? `Your last summary on the prior turn was: "${lastSummary.slice(0, 400)}".`
      : 'Use the conversation history above to figure out where you were.',
    'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
  ].join('\n\n');
}

function rewriteBareContinueForHarness(sessionId: string, message: string): string {
  if (!isBareContinue(message)) return message;
  try {
    const completion = listHarnessEvents(sessionId, { types: ['conversation_completed'], limit: 1, desc: true })[0];
    if (!completion || !isContinueCompletionReason(completion.data?.reason)) return message;
    const lastSummary = typeof completion.data?.lastDecisionSummary === 'string'
      ? completion.data.lastDecisionSummary
      : undefined;
    return buildContinueInput(lastSummary);
  } catch {
    return message;
  }
}

function renderExecutionList(sessionId: string): string {
  const executions = new ExecutionStore().list(5)
    .filter((execution) => execution.sessionId === sessionId || execution.status === 'active' || execution.status === 'blocked')
    .slice(0, 5);
  if (executions.length === 0) return 'No tracked executions.';
  return executions.map((execution) => `- ${execution.id} | ${renderExecutionSummary(execution)}`).join('\n');
}

function renderTaskQueued(taskId: string): string {
  return [
    `Queued background task ${taskId}.`,
    '',
    `Use \`status ${taskId}\` to check progress, \`stop ${taskId}\` to abort before it finishes, or \`tasks\` to list recent jobs.`,
  ].join('\n');
}

function recordGatewayRoute(
  runId: string | undefined,
  response: Pick<AssistantResponse, 'route' | 'raw'>,
  requestedModel: string | undefined,
): AssistantRouteDiagnostics | undefined {
  const route = routeDiagnosticsFromResponse(response);
  if (!route) return undefined;
  addRunEvent(runId, {
    type: 'status',
    message: `Model route: ${route.routeKind}${route.provider ? `/${route.provider}` : ''}${route.effectiveModel ? ` ${route.effectiveModel}` : ''}.`,
    data: {
      routeKind: route.routeKind,
      requestedModel: route.requestedModel ?? requestedModel,
      effectiveModel: route.effectiveModel,
      provider: route.provider,
      transport: route.transport,
      falloverFrom: route.falloverFrom,
    },
  });
  return route;
}

function ensureGatewayHarnessSession(request: GatewayRequest): void {
  if (!getHarnessSession(request.sessionId)) {
    createHarnessSession({
      id: request.sessionId,
      kind: 'chat',
      channel: request.channel,
      userId: request.userId,
      title: deriveTitle(request.message),
      metadata: {
        source: request.source ?? 'gateway',
        queuedBackgroundOrigin: true,
      },
    });
  }
}

interface AcceptedGatewayTurn {
  source: EventRow;
  attempt: RunAttemptRef | null;
  replayedSource: boolean;
}

/**
 * Accept a gateway request before any command, parked-task mutation, durable
 * promotion, or model dispatch. An explicit run id is also the gateway replay
 * key: a transport retry reuses the exact accepted source rather than creating
 * a second logical turn and repeating its side effect.
 */
function acceptGatewayTurn(request: GatewayRequest, runId: string): AcceptedGatewayTurn {
  ensureGatewayHarnessSession(request);
  const previous = getLatestRunAttemptByRunId(request.sessionId, runId);
  if (previous?.sourceUserSeq) {
    const source = listHarnessEvents(request.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === previous.sourceUserSeq);
    if (!source) throw new Error(`accepted gateway source ${previous.sourceUserSeq} is missing`);
    if (publicUserInputText(source.data) !== request.message.trim()) {
      throw new Error(`gateway run ${runId} is already bound to different input`);
    }
    if (!previous.finishedAt) {
      return {
        source,
        attempt: {
          sessionId: previous.sessionId,
          attemptId: previous.attemptId,
          runId: previous.runId,
          startedAt: previous.startedAt,
        },
        replayedSource: true,
      };
    }
    return { source, attempt: null, replayedSource: true };
  }

  const attempt = beginRunAttempt(request.sessionId, { runId });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: request.message,
      displayText: request.message,
      runId,
      attemptId: attempt.attemptId,
      source: `gateway:${request.source ?? 'gateway'}`,
    },
  }, { armRunInFlight: true });
  return { source, attempt, replayedSource: false };
}

function bindGatewayRetryAttempt(source: EventRow, runId: string): RunAttemptRef {
  const attempt = beginRunAttempt(source.sessionId, { runId });
  recordRunAttemptUserInput(attempt, {
    turn: source.turn,
    role: 'user',
    data: source.data,
  }, { existingEventSeq: source.seq, armRunInFlight: true });
  return attempt;
}

function settleGatewayAttempt(
  attempt: RunAttemptRef,
  status: 'completed' | 'cancelled' | 'failed',
): void {
  try { finishRunAttempt(attempt, status); } finally {
    // A late completion from superseded attempt A must never erase the
    // restart marker now owned by newer attempt B on this reusable session.
    clearRunInFlightAfterTerminal(attempt.sessionId, attempt.attemptId);
  }
}

function clearGatewayRunMarkerIfIdle(sessionId: string): void {
  clearRunInFlightAfterTerminal(sessionId);
}

function gatewayTurnIdentity(source: EventRow): TurnIdentity {
  return {
    sessionId: source.sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
  };
}

type GatewayTerminalStatus =
  | 'done'
  | 'needs_input'
  | 'needs_approval'
  | 'needs_continue'
  | 'blocked'
  | 'failed'
  | 'cancelled';

function commitGatewayTerminal(input: {
  source: EventRow;
  status: GatewayTerminalStatus;
  text: string;
  approvalId?: string;
  legacyReason: string;
  metadata?: Record<string, unknown>;
}): ReturnType<typeof commitTurnOutcome> {
  const identity = gatewayTurnIdentity(input.source);
  const common = {
    version: 2 as const,
    id: turnOutcomeId(identity),
    identity,
  };
  let outcome: TurnOutcome;
  switch (input.status) {
    case 'needs_input':
      outcome = {
        ...common,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'input' },
        presentation: { kind: 'question', text: input.text },
      };
      break;
    case 'needs_approval':
      if (!input.approvalId) throw new Error('approval terminal requires approvalId');
      outcome = {
        ...common,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'approval' },
        presentation: { kind: 'approval', text: input.text, approvalId: input.approvalId },
      };
      break;
    case 'needs_continue':
      outcome = {
        ...common,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'continue' },
        presentation: { kind: 'continue', text: input.text },
      };
      break;
    case 'blocked':
      outcome = {
        ...common,
        status: 'blocked',
        resumable: true,
        presentation: { kind: 'blocked', text: input.text },
      };
      break;
    case 'failed':
      outcome = {
        ...common,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: input.text },
      };
      break;
    case 'cancelled':
      outcome = {
        ...common,
        status: 'cancelled',
        resumable: false,
        presentation: { kind: 'stopped', text: input.text },
      };
      break;
    default:
      outcome = {
        ...common,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: input.text },
      };
      break;
  }
  return commitTurnOutcome(outcome, {
    legacyReason: input.legacyReason,
    metadata: input.metadata,
  });
}

function exactGatewayTerminal(source: EventRow): { event: EventRow; presentation: PresentationEvent } | null {
  const terminalKey = `turn:${source.seq}`;
  for (const event of listHarnessEvents(source.sessionId, {
    types: ['conversation_completed'],
    desc: true,
  })) {
    if (event.data.terminalKey !== terminalKey && event.data.sourceUserSeq !== source.seq) continue;
    try {
      const presentation = presentationEventFromCompletionData(event.data);
      if (presentation?.identity.sourceUserSeq === source.seq) return { event, presentation };
    } catch {
      // A contradictory typed row is not replayable public authority.
      return null;
    }
  }
  return null;
}

function gatewayResponseFromTerminal(
  terminal: { event: EventRow; presentation: PresentationEvent },
  runId: string,
): GatewayResponse {
  const { event, presentation } = terminal;
  const pendingApprovalId = presentation.kind === 'approval'
    ? presentation.approvalId
    : typeof event.data.pendingApprovalId === 'string'
      ? event.data.pendingApprovalId
      : undefined;
  const stoppedReason = presentation.status === 'cancelled'
    ? 'cancelled'
    : presentation.needs?.kind === 'continue'
      ? 'max-turns-with-grace'
      : presentation.status === 'failed' || presentation.status === 'blocked'
        ? 'error'
        : undefined;
  return {
    text: presentation.text,
    sessionId: event.sessionId,
    runId,
    ...(typeof event.data.queuedTaskId === 'string' ? { queuedTaskId: event.data.queuedTaskId } : {}),
    ...(pendingApprovalId ? { pendingApprovalId } : {}),
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(event.data.route && typeof event.data.route === 'object'
      ? { route: event.data.route as AssistantRouteDiagnostics }
      : {}),
  };
}

function terminalStatusForResponse(response: AssistantResponse): GatewayTerminalStatus {
  if (response.pendingApprovalId) return 'needs_approval';
  if (response.stoppedReason === 'max-turns-with-grace') return 'needs_continue';
  if (response.stoppedReason === 'cancelled') return 'cancelled';
  if (response.stoppedReason === 'error') return 'failed';
  return 'done';
}

// A pending "apply your last message to the parked task?" confirmation, keyed by origin
// session. In-memory + short TTL — a transient one-question handshake, safe to lose on
// restart. We CONFIRM before routing a freeform message to a parked background task instead
// of silently consuming it (the message the user typed might be unrelated to the task's
// question). Cleared on answer/decline.
interface PendingParkedApply {
  questionId: string;
  taskId: string;
  taskTitle: string;
  candidate: string;
  at: number;
}
const pendingParkedApply = new Map<string, PendingParkedApply>();
// Once the user declines to answer a specific parked question via chat, don't re-nag them
// for THAT question on every subsequent message — only re-offer when the question changes.
const declinedParkedQuestion = new Map<string, string>();
const PARKED_CONFIRM_TTL_MS = 30 * 60_000;
const PARKED_AFFIRM_RE = /^\/?(y|yes|yep|yeah|yup|sure|ok|okay|apply|apply it|send it|use (?:that|it)|do it|confirm|go ahead|please do)\b/i;

interface ParkedBackgroundRoute {
  response: GatewayResponse;
  terminalStatus: Extract<GatewayTerminalStatus, 'done' | 'needs_input'>;
}

function routeParkedBackgroundReply(request: GatewayRequest): ParkedBackgroundRoute | null {
  const answer = request.message.trim();

  // ── Step 2: a confirmation is already pending for this session ──────────────
  const pending = pendingParkedApply.get(request.sessionId);
  if (pending) {
    const fresh = Date.now() - pending.at <= PARKED_CONFIRM_TTL_MS;
    pendingParkedApply.delete(request.sessionId);
    if (fresh && PARKED_AFFIRM_RE.test(answer)) {
      // Confirmed → apply the ORIGINAL message (the candidate), not the "yes".
      const stillParked = findSoleAwaitingInputTaskForOrigin(request.sessionId);
      if (stillParked?.pendingQuestionId === pending.questionId) {
        const queued = queueBackgroundTaskInputResolution(pending.questionId, pending.candidate);
        declinedParkedQuestion.delete(request.sessionId);
        return {
          terminalStatus: 'done',
          response: {
            sessionId: request.sessionId,
            handledControl: true,
            queuedTaskId: queued?.id ?? pending.taskId,
            text: `Done — I sent "${pending.candidate}" to your background task "${pending.taskTitle}". It's resuming and will report back here when it's finished.`,
          },
        };
      }
      // The task moved on between the ask and the confirm — fall through to normal handling.
    } else if (fresh) {
      // Not a confirmation → the user meant something else. Leave the task parked, remember
      // they declined THIS question (so we don't re-ask every message), and handle their
      // message normally (return null → the brain answers it).
      declinedParkedQuestion.set(request.sessionId, pending.questionId);
      return null;
    }
  }

  // ── Step 1: a sole task is parked awaiting input → ASK before applying ───────
  const parkedTask = findSoleAwaitingInputTaskForOrigin(request.sessionId);
  if (
    parkedTask?.pendingQuestionId
    && declinedParkedQuestion.get(request.sessionId) !== parkedTask.pendingQuestionId
  ) {
    pendingParkedApply.set(request.sessionId, {
      questionId: parkedTask.pendingQuestionId,
      taskId: parkedTask.id,
      taskTitle: parkedTask.title,
      candidate: answer,
      at: Date.now(),
    });
    const asked = parkedTask.pendingQuestion ? ` It asked: "${parkedTask.pendingQuestion}"` : '';
    return {
      terminalStatus: 'needs_input',
      response: {
        sessionId: request.sessionId,
        handledControl: true,
        queuedTaskId: parkedTask.id,
        text: `Heads up — your background task "${parkedTask.title}" is paused waiting on you.${asked}\n\nWant me to send your message — "${answer}" — as the answer? Reply **yes** to apply it, or just tell me what you meant and I'll handle that instead (the task stays paused).`,
      },
    };
  }

  if (/^\/?(continue|resume|keep going)$/i.test(answer)) {
    const continueTask = findSoleAwaitingContinueTaskForOrigin(request.sessionId);
    if (continueTask) {
      const queued = queueBackgroundTaskContinue(continueTask.id);
      return {
        terminalStatus: 'done',
        response: {
          sessionId: request.sessionId,
          handledControl: true,
          queuedTaskId: queued?.id ?? continueTask.id,
          text: `Continuing background task "${continueTask.title}". It will report back here when it's done.`,
        },
      };
    }
  }

  return null;
}

function renderRunList(runs: RunRecord[]): string {
  if (runs.length === 0) return 'No runs recorded yet.';
  return runs.map((run) => {
    const latestEvent = run.events[run.events.length - 1];
    const latest = latestEvent ? ` | ${latestEvent.message}` : '';
    const queued = run.queuedTaskId ? ` | task ${run.queuedTaskId}` : '';
    const approval = run.pendingApprovalId ? ` | approval ${run.pendingApprovalId}` : '';
    return `- \`${run.id}\` | ${run.status} | ${run.title}${queued}${approval}${latest}`;
  }).join('\n');
}

function renderRunStatus(run: RunRecord): string {
  const events = run.events.map((event) => {
    const toolName = typeof event.data?.toolName === 'string' ? ` | ${event.data.toolName}` : '';
    return `- ${event.createdAt} | ${event.type}${toolName} | ${event.message}`;
  });
  return [
    `Run \`${run.id}\``,
    `Status: ${run.status}`,
    `Title: ${run.title}`,
    `Session: ${run.sessionId}`,
    `Source: ${run.source ?? 'unknown'}`,
    `Updated: ${run.updatedAt}`,
    run.queuedTaskId ? `Background task: ${run.queuedTaskId}` : '',
    run.pendingApprovalId ? `Approval: ${run.pendingApprovalId}` : '',
    run.error ? `Error: ${run.error}` : '',
    run.outputPreview ? `Output: ${run.outputPreview}` : '',
    '',
    'Timeline:',
    ...events,
  ].filter(Boolean).join('\n');
}

/**
 * Bare "stop" / "cancel" / "abort" handler — the panic-stop verb.
 *
 * Resolution order (most-recently-active wins):
 *   1. Pending approvals for this sessionId (most recent) — reject it,
 *      which unblocks the waiting workflow run so it cleans up.
 *   2. Active background tasks for this user (most recent) — cancel it.
 *   3. Nothing found — reply with what IS active (if anything) and
 *      how to stop each one explicitly. Never silently no-op.
 *
 * Scoped per-session/per-user so bare "stop" can never accidentally
 * kill a CRON-scheduled background task or work from a different
 * conversation. Multi-target situations get a list + ask, never a
 * silent best-guess. (Failure mode from 2026-05-24: user typed "stop"
 * during an in-flight workflow run, the gateway didn't recognize
 * bare "stop", message fell through as a chat prompt, the workflow
 * kept advancing.)
 */
function handleStopActive(request: GatewayRequest): GatewayResponse {
  // Lazy import to avoid pulling the eventlog into router boot when
  // no one types "stop". Harness eventlog opens a SQLite connection.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const approvalRegistry = require('../runtime/harness/approval-registry.js') as typeof import('../runtime/harness/approval-registry.js');

  const candidates: Array<{ kind: 'approval' | 'task'; label: string; stopFn: () => string }> = [];

  // 1) Pending approvals on this sessionId — sorted newest first
  // already by approval-registry's ORDER BY requested_at DESC.
  try {
    const pendingApprovals = approvalRegistry.listPending({ sessionId: request.sessionId, status: 'pending' });
    for (const row of pendingApprovals) {
      candidates.push({
        kind: 'approval',
        label: `approval ${row.approvalId} — ${row.subject ?? row.tool ?? 'pending action'}`,
        stopFn: () => {
          const result = approvalRegistry.resolve(row.approvalId, 'rejected', request.userId ?? 'panic-stop');
          return result.ok
            ? `Rejected approval ${row.approvalId} (${row.subject ?? row.tool ?? 'pending action'}). The waiting run will unwind.`
            : `Could not reject ${row.approvalId}: ${result.reason}.`;
        },
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'stop_active: approval-registry probe failed');
  }

  // 2) Active background tasks for this user — pending, running, awaiting_approval
  try {
    const tasks = listBackgroundTasks({ userId: request.userId })
      .filter((task) => task.status === 'pending' || task.status === 'running' || task.status === 'awaiting_approval')
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    for (const task of tasks) {
      candidates.push({
        kind: 'task',
        label: `background task ${task.id} — ${task.title}`,
        stopFn: () => {
          const cancelled = cancelBackgroundTask(task.id);
          return cancelled
            ? `Cancelled background task ${task.id} (${task.title}).`
            : `Could not cancel ${task.id} (already finished?).`;
        },
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'stop_active: background-task probe failed');
  }

  if (candidates.length === 0) {
    return {
      sessionId: request.sessionId,
      handledControl: true,
      text: 'Nothing active to stop in this session. Use `tasks` to see all background tasks or `runs` for recent runs.',
    };
  }

  if (candidates.length === 1) {
    return {
      sessionId: request.sessionId,
      handledControl: true,
      text: candidates[0].stopFn(),
    };
  }

  // 2+ candidates — don't pick blindly. List + ask for the specific id.
  const list = candidates.slice(0, 10).map((c) => `  • ${c.label}`).join('\n');
  return {
    sessionId: request.sessionId,
    handledControl: true,
    text: [
      `${candidates.length} active items on this session — which one?`,
      list,
      '',
      'Reply with `stop <id>` or `reject <approval-id>` to pick one. `stop all` is not implemented (yet) for safety.',
    ].join('\n'),
  };
}

export class ClementineGateway {
  constructor(private readonly assistant: ClementineAssistant) {}

  private handleCommand(command: GatewayCommand, request: GatewayRequest): GatewayResponse {
    if (command.type === 'list_tasks') {
      const tasks = listBackgroundTasks({ userId: request.userId }).slice(0, 10);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: [
          'Background tasks:',
          renderBackgroundTaskList(tasks),
          '',
          'Tracked executions:',
          renderExecutionList(request.sessionId),
        ].join('\n'),
      };
    }

    if (command.type === 'list_runs') {
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: [
          'Recent runs:',
          renderRunList(listRuns(10)),
          '',
          'Use `status <run_id>` to inspect a run timeline.',
        ].join('\n'),
      };
    }

    if (command.type === 'run_status') {
      const run = getRun(command.id);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: run ? renderRunStatus(run) : `I could not find run ${command.id}.`,
      };
    }

    if (command.type === 'task_status') {
      const task = getBackgroundTask(command.id);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: task ? renderBackgroundTask(task) : `I could not find background task ${command.id}.`,
      };
    }

    if (command.type === 'cancel_task') {
      const task = cancelBackgroundTask(command.id);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: task ? `Task ${task.id} is now ${task.status}.` : `I could not find background task ${command.id}.`,
      };
    }

    if (command.type === 'stop_active') {
      return handleStopActive(request);
    }

    // Self-heal: the user approves/skips a workflow fix Clem proposed.
    if (command.type === 'list_fixes') {
      const fixes = listProposedFixes().slice(0, 10);
      const text = fixes.length === 0
        ? 'No proposed workflow fixes right now.'
        : [
            'Proposed workflow fixes:',
            ...fixes.map((f) => `- \`${f.id}\` | ${f.workflow} · ${f.stepId} | ${f.diagnosis.fix.description}${f.diagnosis.fix.autoApplicable ? '' : ' (needs manual action)'}`),
            '',
            'Apply one with `apply fix <id>`, or skip with `dismiss fix <id>`.',
          ].join('\n');
      return { sessionId: request.sessionId, handledControl: true, text };
    }

    if (command.type === 'apply_fix') {
      const fix = loadProposedFix(command.id);
      if (!fix) {
        return { sessionId: request.sessionId, handledControl: true, text: `I couldn't find proposed fix ${command.id}. Use \`fixes\` to list current ones.` };
      }
      const result = applyProposedFix(command.id);
      let text = result.ok
        ? `✅ ${result.message}`
        : `I didn't apply ${command.id}: ${result.message}${result.errors?.length ? `\n${result.errors.join('\n')}` : ''}`;
      if (result.ok) {
        // Close the loop: re-run the workflow with the original inputs so the
        // approved fix is exercised immediately. Best-effort — the fix is
        // applied regardless of whether the re-queue succeeds.
        try {
          const requeue = requeueWorkflowFromRun(fix.runId);
          if (requeue.status === 'queued') text += `\n↻ Re-running "${fix.workflow}" now — ${requeue.message}`;
          else if (requeue.status === 'duplicate') text += `\n(An identical run is already queued; not duplicating.)`;
          else if (requeue.status === 'blocked_readiness') text += `\nI applied the fix, but could not re-run it yet: ${requeue.message}`;
          else text += `\nI applied the fix, but did not re-run the workflow: ${requeue.message}`;
        } catch { /* re-queue is best-effort */ }
      }
      return { sessionId: request.sessionId, handledControl: true, text };
    }

    if (command.type === 'dismiss_fix') {
      const dismissed = dismissProposedFix(command.id);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: dismissed ? `Dismissed proposed fix ${command.id}.` : `I couldn't find proposed fix ${command.id}.`,
      };
    }

    if (command.type === 'revert_heal') {
      const result = revertWorkflowFix(command.id);
      return {
        sessionId: request.sessionId,
        handledControl: true,
        text: result.ok ? `↩️ ${result.message}` : `I couldn't revert ${command.id}: ${result.message}`,
      };
    }

    const resumed = resumeBackgroundTask(command.id);
    return {
      sessionId: request.sessionId,
      handledControl: true,
      queuedTaskId: resumed?.id,
      text: resumed
        ? `Queued resumed background task ${resumed.id} from ${command.id}.`
        : `Task ${command.id} is not resumable or was not found.`,
    };
  }

  async handleMessage(request: GatewayRequest): Promise<GatewayResponse> {
    const run = startRun({
      id: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      channel: request.channel,
      source: request.source,
      title: deriveTitle(request.message),
      message: request.message,
    });
    let accepted: AcceptedGatewayTurn;
    try {
      accepted = acceptGatewayTurn(request, run.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error({ err: detail, sessionId: request.sessionId, runId: run.id }, 'gateway turn acceptance failed');
      finishRun(run.id, { status: 'failed', message: detail, error: detail });
      throw new Error(PUBLIC_RUN_FAILURE_TEXT);
    }

    const replay = exactGatewayTerminal(accepted.source);
    if (replay) {
      request.onAcceptedTurn?.({ source: accepted.source, attempt: accepted.attempt });
      if (accepted.attempt) {
        try { settleGatewayAttempt(accepted.attempt, 'completed'); } catch { /* replay stays authoritative */ }
      } else {
        clearGatewayRunMarkerIfIdle(request.sessionId);
      }
      const response = gatewayResponseFromTerminal(replay, run.id);
      finishRun(run.id, {
        status: replay.presentation.status === 'cancelled'
          ? 'cancelled'
          : replay.presentation.status === 'failed' || replay.presentation.status === 'blocked'
            ? 'failed'
            : replay.presentation.needs?.kind === 'approval'
              ? 'awaiting_approval'
              : 'completed',
        message: 'Replayed the durable gateway turn outcome.',
        outputPreview: response.text,
        queuedTaskId: response.queuedTaskId,
        pendingApprovalId: response.pendingApprovalId,
      });
      return response;
    }

    // A durable transport replay that finds an accepted source but no public
    // terminal is an uncertain prior execution.  Blindly starting a new
    // physical executor here can repeat an external write that landed just
    // before the daemon crashed.  Recovery gets first chance (a terminal above
    // would have won); otherwise fail closed with one typed terminal.
    if (accepted.replayedSource && request.failClosedOnUnsettledReplay) {
      request.onAcceptedTurn?.({ source: accepted.source, attempt: accepted.attempt });
      const committed = commitGatewayTerminal({
        source: accepted.source,
        status: 'failed',
        text: PUBLIC_RUN_FAILURE_TEXT,
        legacyReason: 'transport_replay_unsettled',
        metadata: { uncertainPriorExecution: true },
      });
      if (accepted.attempt) {
        try { settleGatewayAttempt(accepted.attempt, 'failed'); } catch { /* terminal is authoritative */ }
      } else {
        clearGatewayRunMarkerIfIdle(request.sessionId);
      }
      finishRun(run.id, {
        status: 'failed',
        message: 'Transport retry found an unsettled prior execution; refused duplicate dispatch.',
        error: 'uncertain prior execution',
        outputPreview: committed.presentation.text,
      });
      return gatewayResponseFromTerminal({ event: committed.event, presentation: committed.presentation }, run.id);
    }
    let activeAttempt: RunAttemptRef;
    try {
      activeAttempt = accepted.attempt ?? bindGatewayRetryAttempt(accepted.source, run.id);
      accepted.attempt = activeAttempt;
      request.onAcceptedTurn?.({ source: accepted.source, attempt: activeAttempt });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error({ err: detail, sessionId: request.sessionId, runId: run.id }, 'gateway replay attempt binding failed');
      finishRun(run.id, { status: 'failed', message: detail, error: detail });
      throw new Error(PUBLIC_RUN_FAILURE_TEXT);
    }

    try {
      const command = parseCommand(request.message);
      if (command) {
        const response = this.handleCommand(command, request);
        const committed = commitGatewayTerminal({
          source: accepted.source,
          status: 'done',
          text: response.text,
          legacyReason: 'gateway_command',
        });
        settleGatewayAttempt(activeAttempt, 'completed');
        finishRun(run.id, {
          status: 'completed',
          message: 'Control command handled.',
          outputPreview: committed.presentation.text,
        });
        return { ...response, text: committed.presentation.text, runId: run.id };
      }

      const parkedBackground = routeParkedBackgroundReply(request);
      if (parkedBackground) {
        const { response } = parkedBackground;
        addRunEvent(run.id, {
          type: 'queued_background',
          status: 'queued',
          message: 'Reply routed to parked background task.',
        });
        const committed = commitGatewayTerminal({
          source: accepted.source,
          status: parkedBackground.terminalStatus,
          text: response.text,
          legacyReason: parkedBackground.terminalStatus === 'needs_input'
            ? 'parked_task_confirmation'
            : 'parked_task_routed',
          metadata: { queuedTaskId: response.queuedTaskId },
        });
        settleGatewayAttempt(activeAttempt, 'completed');
        finishRun(run.id, {
          status: 'completed',
          message: 'Reply routed to parked background task.',
          queuedTaskId: response.queuedTaskId,
          outputPreview: committed.presentation.text,
        });
        return { ...response, text: committed.presentation.text, runId: run.id };
      }

      const effectiveMessage = rewriteBareContinueForHarness(request.sessionId, request.message);

      if (shouldPromoteToDurable(request.message)) {
        addRunEvent(run.id, {
          type: 'queued_background',
          status: 'queued',
          message: 'Request promoted to a durable background task.',
        });
        const task = enqueueDurableChatTask({
          message: request.message,
          sessionId: request.sessionId,
          userId: request.userId,
          channel: request.channel,
          model: request.model,
          source: request.source ?? 'gateway',
        });
        const queuedText = renderTaskQueued(task.id);
        const committed = commitGatewayTerminal({
          source: accepted.source,
          status: 'done',
          text: queuedText,
          legacyReason: 'queued_background',
          metadata: { queuedTaskId: task.id },
        });
        settleGatewayAttempt(activeAttempt, 'completed');
        logger.info({ taskId: task.id, sessionId: request.sessionId, channel: request.channel }, 'Gateway queued background task');
        finishRun(run.id, {
          status: 'queued',
          message: `Queued background task ${task.id}.`,
          queuedTaskId: task.id,
          outputPreview: committed.presentation.text,
        });
        return {
          text: committed.presentation.text,
          sessionId: request.sessionId,
          queuedTaskId: task.id,
          runId: run.id,
        };
      }

      addRunEvent(run.id, {
        type: 'model_started',
        message: 'Assistant run started.',
      });
      // CANON-ONE-LOOP: webhook chat runs the gated harness loop (grounding /
      // confirm-first / guardrail / approvals) with the legacy synchronous
      // contract preserved; kill-switch CLEMMY_HARNESS_WEBHOOK=off.
      const response = await respondPreferHarness('webhook', {
        message: effectiveMessage,
        displayMessage: request.message,
        sourceUserSeq: accepted.source.seq,
        sessionId: request.sessionId,
        userId: request.userId,
        channel: request.channel,
        model: request.model,
        runId: run.id,
        onChunk: request.onChunk,
        onReasoning: request.onReasoning,
        onToolActivity: request.onToolActivity,
      }, (req) => this.assistant.respond(req));
      const route = recordGatewayRoute(run.id, response, request.model);
      const committed = commitGatewayTerminal({
        source: accepted.source,
        status: terminalStatusForResponse(response),
        text: response.text,
        approvalId: response.pendingApprovalId,
        legacyReason: response.pendingApprovalId
          ? 'awaiting_approval'
          : response.stoppedReason === 'max-turns-with-grace'
            ? 'awaiting_continue'
            : response.stoppedReason ?? 'success',
        metadata: { ...(route ? { route } : {}) },
      });
      const runCancelled = response.stoppedReason === 'cancelled';
      // Report-back honesty: a non-pending, non-throwing respond() can still be
      // a blocked / promised / errored run. Fail-open + suspicious-only; the run
      // status enum has no 'blocked', so a not-delivered verdict maps to 'failed'
      // with the reason. The returned text is left as the agent wrote it.
      const verdict = response.pendingApprovalId || runCancelled
        ? null
        : await verifyDelivered(request.message, response.text, { stoppedReason: response.stoppedReason });
      const runFailedNotDelivered = verdict ? !verdict.delivered : false;
      finishRun(run.id, {
        status: runCancelled
          ? 'cancelled'
          : response.pendingApprovalId
          ? 'awaiting_approval'
          : runFailedNotDelivered
            ? 'failed'
            : 'completed',
        message: runCancelled
          ? 'Assistant run stopped by request.'
          : response.pendingApprovalId
          ? `Approval required: ${response.pendingApprovalId}.`
          : runFailedNotDelivered
            ? `Assistant run did not finish cleanly: ${verdict?.reason ?? 'no verifiable result'}`
            : 'Assistant run completed.',
        outputPreview: response.text,
        pendingApprovalId: response.pendingApprovalId,
        ...(runFailedNotDelivered ? { error: verdict?.reason ?? 'Run did not finish cleanly.' } : {}),
      });
      try {
        settleGatewayAttempt(
          activeAttempt,
          runCancelled ? 'cancelled' : committed.presentation.status === 'failed' ? 'failed' : 'completed',
        );
      } catch { /* bridge may already have settled the shared physical attempt */ }
      return {
        text: committed.presentation.text,
        sessionId: response.sessionId,
        pendingApprovalId: committed.presentation.kind === 'approval'
          ? committed.presentation.approvalId
          : response.pendingApprovalId,
        runId: run.id,
        stoppedReason: committed.presentation.needs?.kind === 'continue'
          ? 'max-turns-with-grace'
          : committed.presentation.status === 'cancelled'
            ? 'cancelled'
            : committed.presentation.status === 'failed' || committed.presentation.status === 'blocked'
              ? 'error'
              : response.stoppedReason,
        turnsUsed: response.turnsUsed,
        route,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error({ err: detail, sessionId: request.sessionId, runId: run.id }, 'accepted gateway turn failed');
      finishRun(run.id, {
        status: 'failed',
        message: detail,
        error: detail,
      });
      try {
        const failed = commitGatewayTerminal({
          source: accepted.source,
          status: 'failed',
          text: PUBLIC_RUN_FAILURE_TEXT,
          legacyReason: 'gateway_failed',
        });
        try { settleGatewayAttempt(activeAttempt, 'failed'); } catch { /* best effort */ }
        if (failed.presentation.status !== 'failed') {
          return gatewayResponseFromTerminal({ event: failed.event, presentation: failed.presentation }, run.id);
        }
      } catch (commitError) {
        logger.error({
          err: commitError instanceof Error ? commitError.message : String(commitError),
          sessionId: request.sessionId,
          runId: run.id,
        }, 'accepted gateway failure could not commit its terminal');
      }
      throw new Error(PUBLIC_RUN_FAILURE_TEXT);
    }
  }
}
