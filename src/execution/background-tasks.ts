import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, MODELS } from '../config.js';
import { addNotification } from '../runtime/notifications.js';
import { deliverOutcome } from '../runtime/outcome.js';
import { getGoalPinForDelegation } from '../agents/plan-proposals.js';
import { ExecutionStore } from './store.js';
import type { AssistantResponse, RunStoppedReason } from '../types.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { addRunEvent, finishRun, startRun } from '../runtime/run-events.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { getBackgroundCheckInMs, loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { openPlanScope } from '../agents/plan-scope.js';
import { fanoutLedgerEnabled, summarizeLedger, clearLedger } from '../runtime/harness/fanout-ledger.js';
import { BLOCKED_TEXT_PATTERNS, classifyBlocker, verifyDelivered } from '../runtime/harness/verify-delivered.js';
import type { ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { renderSessionHistoryForModel } from '../runtime/harness/session-transcript.js';
import { getSession as getHarnessSessionRow, createSession as createHarnessSession } from '../runtime/harness/eventlog.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';

const logger = pino({ name: 'clementine-next.background-tasks' });

let backgroundDeliveryJudgeForTests: ObjectiveJudgeFn | null = null;
export function _setBackgroundDeliveryJudgeForTests(fn: ObjectiveJudgeFn | null): void {
  backgroundDeliveryJudgeForTests = fn;
}

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'awaiting_approval'
  | 'done'
  // 'blocked' = the run stopped because it could NOT finish the objective
  // (missing data, missing access, an unmet prerequisite) — distinct from
  // 'done' (succeeded), 'failed' (errored), and 'awaiting_approval'
  // (paused on a decision it can resume from). A blocked task must report
  // honestly and wait for the user; it is NEVER reported as done and is
  // NOT auto-resumed. Added 2026-05-30 after a task shipped an empty
  // Google Sheet because the Salesforce pull came back empty yet the run
  // still marked itself 'done'.
  | 'blocked'
  // 'awaiting_continue' = the worker hit an INTERNAL run/turn budget after
  // bounded automatic continuations. This is not a true external blocker and
  // not a completed result; the same task can be resumed with a continuation
  // prompt from the board or originating chat.
  | 'awaiting_continue'
  // 'awaiting_input' = the run paused to ask the user a CLARIFYING QUESTION
  // (ask_user_question, e.g. a judge/gate decided it needs validation) — it can
  // RESUME from the answer, like 'awaiting_approval' but carrying freeform text
  // instead of approve/reject. Distinct so a needed question is never swallowed
  // as 'done' (the 2026-06-21 "tasks get lost" root cause). Not terminal; not
  // auto-resumed until the user answers.
  | 'awaiting_input'
  | 'failed'
  | 'aborted'
  | 'interrupted';

export interface BackgroundTaskRecord {
  id: string;
  title: string;
  prompt: string;
  status: BackgroundTaskStatus;
  originSessionId?: string;
  runSessionId: string;
  userId?: string;
  channel?: string;
  /** Requested model at enqueue/drain time. `model` is the legacy requested slot;
   *  these explicit fields make fallback/fallover diagnostics legible. */
  requestedModel?: string;
  model?: string;
  effectiveModel?: string;
  modelProvider?: string;
  modelRouteKind?: string;
  modelTransport?: string;
  modelRouteFalloverFrom?: string;
  maxMinutes: number;
  source: 'discord' | 'slack' | 'webhook' | 'cli' | 'gateway' | 'daemon' | 'mobile' | 'workflow' | 'desktop';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  resultPath?: string;
  error?: string;
  pendingApprovalId?: string;
  approvalResolution?: {
    approvalId: string;
    approved: boolean;
    queuedAt: string;
  };
  /** Parked clarifying question (status 'awaiting_input'), twin of
   *  pendingApprovalId/approvalResolution but carrying freeform Q&A. */
  pendingQuestionId?: string;
  pendingQuestion?: string;
  inputResolution?: {
    questionId: string;
    answer: string;
    queuedAt: string;
  };
  continueResolution?: {
    queuedAt: string;
    reason?: string;
    auto?: boolean;
  };
  resumedFromTaskId?: string;
  resumeCount?: number;
  /** Set on a resumed-from task once a resume has been spawned, so the
   *  boot-time auto-resumer never re-spawns the same interrupted task on
   *  every restart. */
  resumedIntoTaskId?: string;
  lastCheckInAt?: string;
  lastCheckInMessage?: string;
  progressCheckIns?: number;
  cancellationRequestedAt?: string;
  cancellationReason?: string;
  /** Soft-delete: an archived task drops off the active board and out of every
   *  active sweep (drain/resume/watchdog) but its record is KEPT and restorable.
   *  Recoverable by design — a misclick or a wrong heartbeat call never loses a
   *  task. Set by archiveBackgroundTask, cleared by restoreBackgroundTask. */
  archived?: boolean;
  archivedAt?: string;
}

export interface CreateBackgroundTaskInput {
  title: string;
  prompt: string;
  /**
   * The CHAT session that spawned this task, if any. On completion the task's
   * result is fed back into THIS session's transcript (see
   * enqueueBackgroundTaskResultTurn) so Clementine resumes from it. Pass it
   * whenever a task is kicked off from an interactive session. Leave undefined
   * for autonomous/cron spawns (meeting analysis, maintenance) that have no
   * session to wake — those report back only via notification.
   */
  originSessionId?: string;
  userId?: string;
  channel?: string;
  model?: string;
  maxMinutes?: number;
  source?: BackgroundTaskRecord['source'];
  resumedFromTaskId?: string;
  resumeCount?: number;
}

const BACKGROUND_TASK_DIR = path.join(BASE_DIR, 'state', 'background-tasks');
const RESULT_TRUNCATE_CHARS = 4000;
const PROGRESS_CHECKIN_TOOL_INTERVAL = 5;

// P0-B — per-call wall-clock for a background worker turn. Without this the
// worker inherits the 120s chat default and a legitimate >2-min synthesis turn
// is guillotined (the 2026-06-04 email-audit abort). Env-tunable, floored 60s.
const BACKGROUND_STEP_WALL_CLOCK_MS = (() => {
  const raw = parseInt(process.env.CLEMENTINE_BACKGROUND_STEP_WALL_MS || '', 10);
  return Number.isNaN(raw) ? 10 * 60_000 : Math.max(60_000, raw);
})();
const BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP = (() => {
  const raw = parseInt(process.env.CLEMENTINE_BACKGROUND_TURN_AUTO_CONTINUES || '', 10);
  if (Number.isNaN(raw)) return 4;
  return Math.max(0, Math.min(24, raw));
})();
const DAEMON_RESTART_INTERRUPT_REASON = 'Daemon restarted while task was running.';
let backgroundProcessorInFlight = false;

// ── Immediate drain kick ──────────────────────────────────────────────────────
// A newly enqueued background task used to fire ONLY on the daemon's 15s tick (or
// never, if the daemon loop isn't running in-process), so "run in the background"
// left a `pending` record that never executed, never turned RUNNING on the board,
// and had no harness session to expand (2026-06-30 live). The daemon owns the
// `assistant` handle, so it registers a kick here on boot; the enqueue choke point
// (enqueueDurableChatTask) requests an immediate drain. Best-effort: if no daemon
// loop registered a kick (e.g. a dashboard-only process), the task still drains on
// the next tick / restart — never worse than before. Kill-switch CLEMMY_BG_DRAIN_KICK.
let backgroundDrainKick: ((limit?: number) => void) | null = null;

/** Called once by the daemon runner (which owns `assistant`) to wire the immediate
 *  drain path. */
export function registerBackgroundDrainKick(fn: (limit?: number) => void): void {
  backgroundDrainKick = fn;
}

/** Request an immediate single-task drain right after enqueue, instead of waiting
 *  for the daemon's 15s tick. No-op when no kick is registered. */
export function requestBackgroundDrain(limit = 1): void {
  if ((process.env.CLEMMY_BG_DRAIN_KICK ?? 'on').toLowerCase() === 'off') return;
  const fn = backgroundDrainKick;
  if (!fn) return;
  try {
    fn(limit);
  } catch {
    /* the 15s tick remains the backstop */
  }
}

function ensureTaskDir(): void {
  mkdirSync(BACKGROUND_TASK_DIR, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTaskId(now = new Date()): string {
  return `bg-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function clean(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function taskFilePath(id: string): string {
  return path.join(BACKGROUND_TASK_DIR, `${id}.json`);
}

function writeTask(task: BackgroundTaskRecord): void {
  ensureTaskDir();
  const filePath = taskFilePath(task.id);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(task, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

function loadTaskFile(filePath: string): BackgroundTaskRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as BackgroundTaskRecord;
  } catch {
    return null;
  }
}

function parseTaskChannelForNotification(channel?: string): {
  discordChannelId?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
} {
  const parts = channel?.split(':') ?? [];
  if (parts[0] === 'discord') {
    return { discordChannelId: parts.length >= 2 ? parts[parts.length - 1] : undefined };
  }
  if (parts[0] === 'slack') {
    return {
      slackChannelId: parts[1],
      slackThreadTs: parts.length >= 3 ? parts.slice(2).join(':') : undefined,
    };
  }
  return {};
}

function taskNotificationMetadata(task: BackgroundTaskRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const channel = parseTaskChannelForNotification(task.channel);
  const allowDiscordCheckIns = loadProactivityPolicy().allowDiscordCheckIns;
  return {
    backgroundTaskId: task.id,
    sessionId: task.originSessionId,
    runSessionId: task.runSessionId,
    userId: task.userId,
    channel: task.channel,
    discordUserId: allowDiscordCheckIns && task.channel?.startsWith('discord:') ? task.userId : undefined,
    discordChannelId: allowDiscordCheckIns ? channel.discordChannelId : undefined,
    slackChannelId: channel.slackChannelId,
    slackThreadTs: channel.slackThreadTs,
    ...extra,
  };
}

function emitBackgroundTaskCheckIn(
  task: BackgroundTaskRecord,
  input: {
    title: string;
    body: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  },
): BackgroundTaskRecord {
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    lastCheckInAt: now,
    lastCheckInMessage: clean(input.body, 700),
    progressCheckIns: (task.progressCheckIns ?? 0) + 1,
  }) ?? task;

  // All check-ins — task started, tool-progress heartbeats, cancellation
  // pings — are dashboard-only. The completed notification (which carries
  // the actual analysis result) is dispatched separately and stays loud
  // so Discord/email get the actually-useful signal without the burst
  // of lifecycle pings for every tool call along the way.
  addNotification({
    id: `${Date.now()}-background-${task.id}-checkin-${updated.progressCheckIns ?? 1}`,
    kind: 'execution',
    title: input.title,
    body: input.body,
    createdAt: now,
    read: false,
    silent: true,
    metadata: taskNotificationMetadata(updated, {
      runId: input.runId,
      ...(input.metadata ?? {}),
    }),
  });

  return updated;
}

function writeFullResultFile(task: BackgroundTaskRecord, result: string): string | undefined {
  if (result.length <= RESULT_TRUNCATE_CHARS) return undefined;
  const filePath = path.join(BACKGROUND_TASK_DIR, `${task.id}.result.md`);
  writeFileSync(filePath, result, 'utf-8');
  return filePath;
}

function renderOriginLineageBlock(originSessionId: string | undefined): string {
  if (!originSessionId) return '';
  let history = '';
  try { history = renderSessionHistoryForModel(originSessionId, 8, 6_000); } catch { history = ''; }
  return [
    '## Origin Session Lineage',
    `This task was spawned from session "${originSessionId}". Treat the origin history as authoritative for user decisions, constraints, resource ids, and already-completed external actions.`,
    'Do not redo completed external writes unless the user explicitly asked to do them again. If you need more than the bounded history below, call session_history with the origin session id before acting.',
    history,
  ].filter(Boolean).join('\n');
}

function buildWorkerPrompt(task: BackgroundTaskRecord): string {
  const policy = loadProactivityPolicy();
  // Carry the spawning chat session's parked GOAL into this delegated worker
  // (goal-contract P3 — replaced the Active Task pin) so it works toward the
  // EXACT objective the user blessed instead of re-deriving it. Keyed by the
  // ORIGIN session id only — never a global — so no other session's goal can
  // leak in. Empty (byte-identical prompt) for spawns with no origin/goal.
  const pinned = task.originSessionId ? getGoalPinForDelegation(task.originSessionId) : undefined;
  return [
    'You are running a durable Clementine background task.',
    `Autonomy mode: ${policy.mode}.`,
    'Work autonomously through the request. Use available tools when useful.',
    'For independent batch enrichment, resolve shared tools/credentials once, then use run_worker fan-out in bounded waves instead of doing every item serially in this context.',
    'For batch external writes, gather and verify source data first, then request one batch approval before writing; never ship placeholder or partial records as complete.',
    'If you are blocked by missing credentials, missing approvals, or ambiguity that could cause damage, stop and explain the blocker.',
    policy.allowComputerActions ? '' : 'Policy: do not modify local files, run shell commands, or operate the computer unless the user explicitly re-enables computer actions.',
    policy.allowComposioActions ? '' : 'Policy: do not use connected-app or Composio actions unless the user explicitly re-enables connected-app actions.',
    'Keep a concise task ledger in your reasoning and finish with these sections:',
    '## Completed',
    '## Evidence / Verification',
    '## Remaining Risks',
    '## Next Step',
    '',
    `Task ID: ${task.id}`,
    task.originSessionId ? `Origin session: ${task.originSessionId}` : '',
    `Soft max runtime: ${task.maxMinutes} minutes`,
    '',
    renderOriginLineageBlock(task.originSessionId),
    '',
    pinned
      ? `## Pinned Constraint (from the session that started this task — act on EXACTLY this target; do NOT re-discover or substitute a different list)\n${pinned}\n`
      : '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

function buildWorkerContinuePrompt(task: BackgroundTaskRecord, previousText?: string): string {
  return [
    `Continue background task ${task.id}.`,
    'The previous worker turn hit an internal run/turn budget before the objective was complete.',
    'Pick up from the prior session state and finish the original request. Do not restart from scratch unless the prior state is unusable.',
    renderOriginLineageBlock(task.originSessionId),
    previousText ? `Previous partial result / continuation note:\n${previousText.slice(0, RESULT_TRUNCATE_CHARS)}` : '',
    '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

function buildWorkerInputResumePrompt(task: BackgroundTaskRecord, answer: string): string {
  return [
    `The user answered your question: "${answer}". Continue the task with this answer.`,
    'Use the prior run session state, but preserve the origin session facts below if the continuation is picked up by a different model/backend.',
    renderOriginLineageBlock(task.originSessionId),
    '',
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
}

function recordBackgroundTaskRoute(
  task: BackgroundTaskRecord,
  runId: string | undefined,
  response: AssistantResponse,
  requestedModel: string,
): BackgroundTaskRecord {
  const route = routeDiagnosticsFromResponse(response);
  const patch: Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>> = {
    requestedModel: route?.requestedModel ?? requestedModel,
    effectiveModel: route?.effectiveModel,
    modelProvider: route?.provider,
    modelRouteKind: route?.routeKind,
    modelTransport: route?.transport,
    modelRouteFalloverFrom: route?.falloverFrom,
  };
  const updated = updateBackgroundTask(task.id, patch) ?? task;
  if (route) {
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
  }
  return updated;
}

export function createBackgroundTask(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const createdAt = nowIso();
  const id = makeTaskId(new Date(createdAt));
  const task: BackgroundTaskRecord = {
    id,
    title: clean(input.title || input.prompt, 120) || 'Background task',
    prompt: input.prompt.trim(),
    status: 'pending',
    originSessionId: input.originSessionId,
    runSessionId: `background:${id}`,
    userId: input.userId,
    channel: input.channel,
    requestedModel: input.model,
    model: input.model,
    maxMinutes: Math.max(1, Math.min(240, Math.floor(input.maxMinutes ?? 60))),
    source: input.source ?? 'gateway',
    createdAt,
    updatedAt: createdAt,
    resumedFromTaskId: input.resumedFromTaskId,
    resumeCount: input.resumeCount,
  };
  writeTask(task);
  // Dashboard-only — the queued ping is useful in the Activity panel
  // but pushes pure noise to Discord since the task hasn't done
  // anything yet. The "completed" notification (which has the actual
  // result) is the one external destinations should see.
  addNotification({
    id: `${Date.now()}-background-${task.id}-queued`,
    kind: 'execution',
    title: `Background task queued: ${task.title}`,
    body: `Task ${task.id} is queued and will run in the daemon loop.`,
    createdAt,
    read: false,
    silent: true,
    metadata: taskNotificationMetadata(task),
  });
  return task;
}

export function getBackgroundTask(id: string): BackgroundTaskRecord | null {
  const filePath = taskFilePath(id);
  if (!existsSync(filePath)) return null;
  return loadTaskFile(filePath);
}

export function listBackgroundTasks(filter: { status?: BackgroundTaskStatus; userId?: string; channel?: string; includeArchived?: boolean } = {}): BackgroundTaskRecord[] {
  ensureTaskDir();
  return readdirSync(BACKGROUND_TASK_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskFile(path.join(BACKGROUND_TASK_DIR, entry)))
    .filter((task): task is BackgroundTaskRecord => Boolean(task))
    // Archived tasks are soft-removed from ALL active consideration (board,
    // drain, resume, watchdog) unless a caller explicitly asks for them.
    .filter((task) => filter.includeArchived || !task.archived)
    .filter((task) => !filter.status || task.status === filter.status)
    .filter((task) => !filter.userId || task.userId === filter.userId)
    .filter((task) => !filter.channel || task.channel === filter.channel)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Age threshold past which an idle finished/parked task is flagged STALE and the
 *  heartbeat offers to archive it. 7 days = a week of no activity. */
export const STALE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STALE_FINISHED_STATUSES: readonly BackgroundTaskStatus[] = ['done', 'failed', 'aborted', 'blocked', 'interrupted'];
const STALE_PARKED_STATUSES: readonly BackgroundTaskStatus[] = ['awaiting_input', 'awaiting_approval', 'awaiting_continue'];

/** 'finished' = a terminal task lingering on the board; 'parked' = a task that
 *  has waited on the user (input/approval) and gone unanswered. */
export type StaleTaskKind = 'finished' | 'parked';

/** Classify a task's staleness, or null when it is NOT stale. Age is measured
 *  from updatedAt (last activity), so a live task that keeps moving never trips
 *  this. Archived tasks are never stale (already cleared). Active states
 *  (pending/running/cancelling) are never stale — only finished clutter and
 *  forgotten-parked tasks. Shared by the board flag AND the heartbeat so "stale"
 *  has exactly ONE definition. */
export function staleTaskKind(task: BackgroundTaskRecord, now: number = Date.now(), thresholdMs: number = STALE_TASK_AGE_MS): StaleTaskKind | null {
  if (task.archived) return null;
  const ageMs = now - Date.parse(task.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < thresholdMs) return null;
  if (STALE_FINISHED_STATUSES.includes(task.status)) return 'finished';
  if (STALE_PARKED_STATUSES.includes(task.status)) return 'parked';
  return null;
}

/** Every stale (non-archived) task with its kind, newest first. Powers both the
 *  board's STALE flag and the heartbeat's "archive these?" prompt. */
export function findStaleBackgroundTasks(now: number = Date.now(), thresholdMs: number = STALE_TASK_AGE_MS): Array<{ task: BackgroundTaskRecord; kind: StaleTaskKind }> {
  return listBackgroundTasks()
    .map((task) => { const kind = staleTaskKind(task, now, thresholdMs); return kind ? { task, kind } : null; })
    .filter((entry): entry is { task: BackgroundTaskRecord; kind: StaleTaskKind } => entry !== null);
}

/** Soft-delete a task: drop it off the active board + every sweep, keep the
 *  record (restorable). The single irreversible-feeling action made reversible. */
export function archiveBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.archived) return task; // idempotent — re-archiving is a no-op
  return updateBackgroundTask(id, { archived: true, archivedAt: nowIso() });
}

/** Restore an archived task back onto the board. Its updatedAt is bumped (by
 *  updateBackgroundTask) so it does not immediately re-flag as stale. */
export function restoreBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  if (!task.archived) return task;
  return updateBackgroundTask(id, { archived: false, archivedAt: undefined });
}

export function getBackgroundTaskByApprovalId(approvalId: string): BackgroundTaskRecord | null {
  if (!approvalId) return null;
  return listBackgroundTasks().find((task) => task.pendingApprovalId === approvalId) ?? null;
}

export function getBackgroundTaskByQuestionId(questionId: string): BackgroundTaskRecord | null {
  if (!questionId) return null;
  return listBackgroundTasks().find((task) => task.pendingQuestionId === questionId) ?? null;
}

/** The single background task awaiting input on this origin chat session, if
 *  exactly one is parked there (so a freeform chat reply can be routed to it
 *  without an explicit questionId). Returns null when zero or >1 are parked —
 *  the caller must then disambiguate by questionId. */
export function findSoleAwaitingInputTaskForOrigin(originSessionId: string): BackgroundTaskRecord | null {
  if (!originSessionId) return null;
  const parked = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => task.originSessionId === originSessionId);
  return parked.length === 1 ? parked[0] : null;
}

export function findSoleAwaitingContinueTaskForOrigin(originSessionId: string): BackgroundTaskRecord | null {
  if (!originSessionId) return null;
  const parked = listBackgroundTasks({ status: 'awaiting_continue' })
    .filter((task) => task.originSessionId === originSessionId);
  return parked.length === 1 ? parked[0] : null;
}

export function updateBackgroundTask(id: string, patch: Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>>): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  const updated: BackgroundTaskRecord = {
    ...task,
    ...patch,
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: nowIso(),
  };
  writeTask(updated);
  return updated;
}

function clearParkedBackgroundState(): Partial<Omit<BackgroundTaskRecord, 'id' | 'createdAt'>> {
  return {
    pendingApprovalId: undefined,
    approvalResolution: undefined,
    pendingQuestionId: undefined,
    pendingQuestion: undefined,
    inputResolution: undefined,
    continueResolution: undefined,
  };
}

export function markBackgroundTaskRunning(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.status !== 'pending') return null;
  const updated = updateBackgroundTask(id, {
    status: 'running',
    startedAt: nowIso(),
    error: undefined,
    pendingApprovalId: undefined,
    // Clear the parked-question MARKER but preserve inputResolution — the drain
    // reads inputResolution to resume with the answer (mirrors how
    // approvalResolution survives markBackgroundTaskRunning).
    pendingQuestionId: undefined,
    pendingQuestion: undefined,
  });
  // Pre-register the trace session the instant the card flips to RUNNING, so the board's
  // live-trace SSE (GET /api/sessions/background:<id>/events) never 404s during the startup
  // window. The worker otherwise creates background:<id> lazily on its FIRST
  // respondPreferHarness call — after markRunning/startRun/buildWorkerPrompt — and the
  // browser's EventSource does not recover from that 404. Both harness lanes use
  // get-or-create (if (!getSession) createSession), so this is safe; they see it and skip.
  try {
    const runSessionId = updated?.runSessionId ?? `background:${id}`;
    if (!getHarnessSessionRow(runSessionId)) {
      createHarnessSession({ id: runSessionId, kind: 'execution', title: updated?.title ?? task.title ?? 'Background task' });
    }
  } catch { /* trace pre-registration is best-effort; the worker creates it anyway */ }
  return updated;
}

/**
 * Async report-back. When a background task finishes, feed its result back
 * into the ORIGINATING session's transcript so Clementine re-enters that
 * context on her next turn and can keep working — instead of the result
 * dead-ending in a notification that never reaches her reasoning loop.
 *
 * No new MCP tool is needed: re-entry is via turn history (the model already
 * reads `recentTranscript`), and the embedded `background_task_status('<id>')`
 * hint lets her pull the FULL payload on demand if the inline preview is
 * clipped. The existing read tools are how she self-serves; this just makes
 * sure the completion is IN her context.
 *
 * Best-effort + idempotent: a completion must never fail on a session write,
 * and `markBackgroundTaskDone` is called from both the normal drain and the
 * post-approval path, so a retried/double completion must not append twice
 * (guarded by a content-marker scan — ConversationTurn has no id to dedup on).
 * Tasks with no `originSessionId` (cron / autonomous spawns with no session to
 * wake) are a no-op, by design.
 */
type BackgroundTaskOutcome = 'done' | 'failed' | 'blocked' | 'needs_input';

function enqueueBackgroundTaskOutcomeTurn(
  task: BackgroundTaskRecord,
  outcome: BackgroundTaskOutcome,
  detail: string,
): void {
  // Unified report-back (Move 4): one mechanism for every lane. Preserves the
  // `[background task <id> …]` prefix (idempotency + UI detect); the body is the
  // shared Outcome card. See src/runtime/outcome.ts.
  deliverOutcome(
    { status: outcome, detail },
    {
      originSessionId: task.originSessionId,
      sourceLabel: 'background task',
      sourceId: task.id,
      title: task.title,
      statusHint: `background_task_status('${task.id}')`,
      maxDetailChars: RESULT_TRUNCATE_CHARS,
      // A clarifying question must surface in the chat NOW (not wait for the
      // user's next unrelated message) so they can answer it.
      proactiveTurn: outcome === 'needs_input',
    },
  );
}

export function markBackgroundTaskDone(id: string, result: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  const resultPath = writeFullResultFile(task, result);
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status: 'done',
    completedAt: nowIso(),
    result: resultPath ? `${result.slice(0, RESULT_TRUNCATE_CHARS)}\n...[full result saved to ${resultPath}]` : result,
    resultPath,
    error: undefined,
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-done`,
      kind: 'execution',
      title: `Background task completed: ${updated.title}`,
      body: result.slice(0, 2000),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated),
    });
    // Async report-back: also feed the result into the origin session's
    // context so Clementine resumes from it, not just a notification.
    enqueueBackgroundTaskOutcomeTurn(updated, 'done', result);
  }
  return updated;
}

/**
 * Park a background task that asked the user a CLARIFYING QUESTION (the
 * judge-gated check-in). Twin of markBackgroundTaskAwaitingApproval, but the
 * question is surfaced TWO ways: a needs-you notification (kind 'approval' so it
 * rides the loud delivery path) AND a synthetic turn in the ORIGIN chat via
 * deliverOutcome(needs_input) — so the user sees the question where they're
 * talking, and can just answer there (the answer is routed back to resume).
 */
export function markBackgroundTaskAwaitingInput(id: string, questionId: string, question: string): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_input',
    pendingQuestionId: questionId,
    pendingQuestion: question.slice(0, RESULT_TRUNCATE_CHARS),
    result: question.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-needs-input`,
      kind: 'approval',
      title: `Background task needs your input: ${updated.title}`,
      body: question.slice(0, 2000),
      createdAt: nowIso(),
      read: false,
      metadata: {
        ...taskNotificationMetadata(updated, { status: 'awaiting_input' }),
        questionId,
        needsInput: true,
      },
    });
    // Surface the question into the origin chat too, so the user can answer in
    // the conversation (the answer is routed back via queueBackgroundTaskInputResolution).
    enqueueBackgroundTaskOutcomeTurn(updated, 'needs_input', question);
  }
  return updated;
}

export function markBackgroundTaskAwaitingApproval(id: string, approvalId: string, resultText: string): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_approval',
    pendingApprovalId: approvalId,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-approval`,
      kind: 'approval',
      title: `Background task awaiting approval: ${updated.title}`,
      body: `Task ${updated.id} is paused on approval ${approvalId}.`,
      createdAt: nowIso(),
      read: false,
      metadata: {
        ...taskNotificationMetadata(updated),
        approvalId,
      },
    });
  }
  return updated;
}

export function markBackgroundTaskAwaitingContinue(id: string, reason: string, resultText: string): BackgroundTaskRecord | null {
  const reasonText = clean(reason || 'The task reached its internal run budget before finishing.', 1000);
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status: 'awaiting_continue',
    completedAt: undefined,
    error: reasonText,
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-awaiting-continue`,
      kind: 'approval',
      title: `Background task needs continue: ${updated.title}`,
      body: [
        `Task ${updated.id} reached its internal run budget before finishing.`,
        ``,
        `Reason: ${reasonText}`,
        ``,
        `Resume it from the Tasks board, or reply \`continue\` in the originating chat if this is the only parked background task there.`,
      ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'awaiting_continue' }),
    });
    enqueueBackgroundTaskOutcomeTurn(
      updated,
      'needs_input',
      `Task ${updated.id} reached its internal run budget before finishing. Reply \`continue\` to queue the next background turn, or resume it from the Tasks board.`,
    );
  }
  return updated;
}

/**
 * Mark a task BLOCKED: it could not complete the objective because a
 * prerequisite was missing (no data, no access, an unmet dependency).
 * This is the honest terminal state for "I tried, I can't finish this
 * without X" — never silently a 'done'. The notification is `approval`
 * kind so it surfaces with attention; the body carries the concrete
 * blocker + what the user can do. The task is NOT auto-resumed (resume
 * would just re-block); the user re-runs once the blocker is cleared.
 */
export function markBackgroundTaskBlocked(id: string, reason: string, resultText: string): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status: 'blocked',
    completedAt: nowIso(),
    error: clean(reason, 1000),
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
  });
  if (updated) {
    // Tag the blocker by KIND (deterministic, zero-token) so the dashboard /
    // proactive brief / future routing can act on the class, not just the prose.
    const blockerType = classifyBlocker(reason);
    addNotification({
      id: `${Date.now()}-background-${updated.id}-blocked`,
      kind: 'approval',
      title: `Background task blocked: ${updated.title}`,
      body: [
        `I couldn't finish this — I'm blocked, so I did NOT ship a partial/empty result.`,
        ``,
        `Blocker (${blockerType}): ${clean(reason, 600)}`,
        ``,
        `Re-run once that's resolved and I'll continue.`,
      ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'blocked', blockerType }),
    });
    // Report-back without fail: a BLOCKED task must reach Clementine's context,
    // not just a notification — so she can surface the blocker or resolve it.
    enqueueBackgroundTaskOutcomeTurn(updated, 'blocked', reason);
  }
  return updated;
}

export function markBackgroundTaskFailed(id: string, error: string, status: Extract<BackgroundTaskStatus, 'failed' | 'aborted' | 'interrupted'> = 'failed'): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    ...clearParkedBackgroundState(),
    status,
    completedAt: nowIso(),
    error: clean(error, 1000),
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-${status}`,
      kind: 'execution',
      title: `Background task ${status}: ${updated.title}`,
      body: updated.error ?? status,
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated),
    });
    // Report-back without fail: a genuine FAILURE re-enters the origin session
    // so Clementine can retry/adjust or tell the user. Skip 'interrupted'
    // (a daemon-restart transient that is auto-resumed) and 'aborted' (the
    // user cancelled it — they already know).
    if (status === 'failed') {
      enqueueBackgroundTaskOutcomeTurn(updated, 'failed', updated.error ?? error);
    }
  }
  return updated;
}

/**
 * Decide the HONEST terminal state of a finished worker turn before we
 * stamp it 'done'. The runtime can return normally (no pending approval,
 * no thrown error) while the task did NOT actually achieve its objective
 * — it left a blocked execution, or its own final text says it's blocked
 * / waiting on input / produced nothing usable. Reporting that as 'done'
 * is the failure the owner hit: an empty Google Sheet shipped because the
 * Salesforce pull came back empty yet the run still "completed".
 *
 * Signals (any one ⇒ blocked):
 *  - the worker left an execution in `blocked` status for this session
 *    (it called execution_mark_blocked), or
 *  - its final text matches a blocked/needs-input/approval-pending shape.
 *
 * Deliberately conservative: we only divert to `blocked` on a positive
 * signal. A genuinely-complete run with no blocked markers stays 'done'.
 */
// BLOCKED_TEXT_PATTERNS now lives in runtime/harness/verify-delivered.ts so
// the cron/gateway/autonomy honesty chokepoint and this richer background-task
// classifier share one blocked-text vocabulary.

export function classifyBackgroundTaskOutcome(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
  opts: { ignoreFanoutCoverage?: boolean } = {},
): { outcome: 'done' | 'blocked'; reason?: string } {
  // 1) Structured signal: did the worker explicitly mark an execution
  //    blocked in its own session? This is the strongest signal — it's
  //    the agent telling us, in code, that it could not proceed.
  try {
    const blockedExecution = new ExecutionStore()
      .list(40)
      .find((e) => e.sessionId === task.runSessionId && e.status === 'blocked');
    if (blockedExecution) {
      return { outcome: 'blocked', reason: blockedExecution.blocker || 'Execution marked blocked by the agent.' };
    }
  } catch {
    // store read is best-effort; fall through to text heuristics
  }

  // 2) The runtime stopped while still pending an approval but the caller
  //    didn't catch it (defense-in-depth; the explicit pendingApprovalId
  //    branch normally handles this first).
  if (stoppedReason === 'pending-approval') {
    return { outcome: 'blocked', reason: 'Stopped awaiting an approval that was not surfaced.' };
  }

  // 2.5) P0-C — the runtime threw mid-turn and `respond()` converted it to a
  //      typed error result (a wall-clock abort that survived the P0-A in-loop
  //      retries, a 5xx burst, a transport timeout). That is NOT a finished
  //      deliverable; surface it as a non-completion so report-back is honest
  //      and the watchdog re-spawn isn't the only backstop.
  if (stoppedReason === 'error') {
    const text = (finalText || '').trim();
    return {
      outcome: 'blocked',
      reason: (text || 'The run hit a runtime error before finishing.').slice(0, 400),
    };
  }
  if (stoppedReason === 'max-turns-with-grace') {
    const text = (finalText || '').trim();
    return {
      outcome: 'blocked',
      reason: (text || 'The run hit its turn budget before finishing; continue is required.').slice(0, 400),
    };
  }

  // 3) Text heuristic: the agent's own final words say it's blocked.
  const text = (finalText || '').trim();
  if (text) {
    for (const pattern of BLOCKED_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        return { outcome: 'blocked', reason: text.slice(0, 400) };
      }
    }
  }

  // 4) FIX 7 — fan-out coverage: if this run fanned out workers and any item
  //    FAILED (worker returned ERROR:), report partial coverage honestly
  //    instead of a hollow "done". Flag-gated (CLEMMY_FANOUT_LEDGER).
  if (!opts.ignoreFanoutCoverage) {
    const coverageBlock = fanoutCoverageBlock(task.runSessionId);
    if (coverageBlock) return coverageBlock;
  }

  return { outcome: 'done' };
}

async function verifyBackgroundTaskDelivery(
  task: Pick<BackgroundTaskRecord, 'runSessionId' | 'prompt' | 'title'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
): Promise<{ outcome: 'done' | 'blocked'; reason?: string }> {
  const classified = classifyBackgroundTaskOutcome(task, finalText, stoppedReason, { ignoreFanoutCoverage: true });
  if (classified.outcome === 'blocked') return classified;

  const coverageBlock = fanoutCoverageBlock(task.runSessionId);
  try {
    const verdict = await verifyDelivered(task.prompt || task.title, finalText, {
      stoppedReason,
      ...(backgroundDeliveryJudgeForTests ? { judgeFn: backgroundDeliveryJudgeForTests } : {}),
    });
    if (!verdict.delivered) {
      return coverageBlock ?? { outcome: 'blocked', reason: verdict.reason ?? 'Run did not produce a verifiable deliverable.' };
    }
  } catch {
    if (coverageBlock) return coverageBlock;
    return { outcome: 'done' };
  }

  return { outcome: 'done' };
}

/**
 * FIX 7 — derive a partial-coverage "blocked" verdict from the per-run fan-out
 * ledger, or null when coverage is complete / the flag is off / nothing fanned
 * out. Shared by both the post-approval and main drain completion paths so a
 * partial batch never reports a hollow "done" on either. Best-effort.
 */
function fanoutCoverageBlock(runSessionId: string): { outcome: 'blocked'; reason: string } | null {
  if (!fanoutLedgerEnabled()) return null;
  try {
    const cov = summarizeLedger(runSessionId);
    if (cov.total > 0 && cov.failed > 0) {
      const shown = cov.failedItems.slice(0, 8).join(', ');
      const more = cov.failedItems.length > 8 ? `, +${cov.failedItems.length - 8} more` : '';
      return {
        outcome: 'blocked',
        reason: `Partial coverage: ${cov.done}/${cov.total} items done, ${cov.failed} failed (${shown}${more}).`,
      };
    }
  } catch {
    // best-effort
  }
  return null;
}

export function cancelBackgroundTask(id: string, reason = 'Cancelled by user.'): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  if (task.status === 'done' || task.status === 'failed' || task.status === 'aborted') {
    return task;
  }
  if (task.status === 'running') {
    const now = nowIso();
    const updated = updateBackgroundTask(id, {
      status: 'cancelling',
      cancellationRequestedAt: now,
      cancellationReason: reason,
      lastCheckInAt: now,
      lastCheckInMessage: `Cancellation requested. ${reason}`,
    });
    if (updated) {
      addNotification({
        id: `${Date.now()}-background-${updated.id}-cancelling`,
        kind: 'execution',
        title: `Background task cancelling: ${updated.title}`,
        body: `Cancellation was requested for task ${updated.id}. It will stop at the next safe checkpoint.`,
        createdAt: now,
        read: false,
        metadata: taskNotificationMetadata(updated, { status: 'cancelling' }),
      });
    }
    return updated;
  }
  return markBackgroundTaskFailed(id, reason, 'aborted');
}

export function resumeBackgroundTask(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  if (task.status === 'awaiting_continue') {
    return queueBackgroundTaskContinue(id);
  }
  if (task.status !== 'interrupted' && task.status !== 'failed' && task.status !== 'aborted') {
    return null;
  }
  const resumed = createBackgroundTask({
    title: `Resume ${task.title}`,
    prompt: [
      `Resume background task ${task.id}.`,
      task.result ? `Previous partial result:\n${task.result}` : '',
      task.error ? `Previous error/blocker:\n${task.error}` : '',
      '',
      'Original request:',
      task.prompt,
    ].filter(Boolean).join('\n\n'),
    originSessionId: task.originSessionId,
    userId: task.userId,
    channel: task.channel,
    model: task.model,
    maxMinutes: task.maxMinutes,
    source: task.source,
    resumedFromTaskId: task.id,
    resumeCount: (task.resumeCount ?? 0) + 1,
  });
  // Stamp the original so the boot-time auto-resumer (and the UI) can tell
  // it's already been carried forward and won't re-spawn it.
  updateBackgroundTask(task.id, { resumedIntoTaskId: resumed.id });
  return resumed;
}

/**
 * Boot-time recovery: re-queue background tasks that were marked
 * `interrupted` by interruptStaleRunningBackgroundTasks (a daemon
 * restart/crash mid-run) so the work resumes instead of stranding.
 *
 * Bounded two ways so a task that reliably crashes the daemon can't loop
 * forever: we skip tasks already carried forward (`resumedIntoTaskId`) and
 * tasks whose `resumeCount` has reached `cap`. Returns the number resumed.
 */
export function resumeInterruptedBackgroundTasks(opts: { cap?: number } = {}): number {
  const cap = Math.max(1, opts.cap ?? 2);
  let resumedCount = 0;
  for (const task of listBackgroundTasks({ status: 'interrupted' })) {
    if (task.error !== DAEMON_RESTART_INTERRUPT_REASON) continue;
    if (task.resumedIntoTaskId) continue;          // already carried forward
    if ((task.resumeCount ?? 0) >= cap) continue;  // give up after cap retries
    if (resumeBackgroundTask(task.id)) resumedCount += 1;
  }
  return resumedCount;
}

export function queueBackgroundTaskApprovalResolution(approvalId: string, approved: boolean): BackgroundTaskRecord | null {
  const task = getBackgroundTaskByApprovalId(approvalId);
  if (!task || task.status !== 'awaiting_approval') return null;
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    status: 'pending',
    pendingApprovalId: approvalId,
    approvalResolution: {
      approvalId,
      approved,
      queuedAt: now,
    },
    lastCheckInAt: now,
    lastCheckInMessage: `${approved ? 'Approval granted' : 'Approval rejected'} for ${approvalId}; queued daemon continuation.`,
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-approval-resolution-queued`,
      kind: 'execution',
      title: `Background task ${approved ? 'approved' : 'rejected'}: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon to process approval ${approvalId}.`,
      createdAt: now,
      read: false,
      metadata: taskNotificationMetadata(updated, { approvalId, approved, status: 'pending' }),
    });
  }
  return updated;
}

/**
 * Re-queue a task parked on a clarifying question, carrying the user's FREEFORM
 * answer. Twin of queueBackgroundTaskApprovalResolution, but the next drain
 * resumes via an ordinary background turn (respondPreferHarness) that injects
 * the answer — NOT resolveApproval (an ask_user_question turn completed
 * normally, so there is no serialized SDK state to replay; the run session holds
 * the full history and re-enters cleanly with the answer).
 */
export function queueBackgroundTaskInputResolution(questionId: string, answer: string): BackgroundTaskRecord | null {
  const task = getBackgroundTaskByQuestionId(questionId);
  if (!task || task.status !== 'awaiting_input') return null;
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    status: 'pending',
    pendingQuestionId: questionId,
    inputResolution: { questionId, answer: clean(answer, RESULT_TRUNCATE_CHARS), queuedAt: now },
    lastCheckInAt: now,
    lastCheckInMessage: `Answer received for ${questionId}; queued daemon continuation.`,
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-input-resolution-queued`,
      kind: 'execution',
      title: `Background task resuming: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon with your answer.`,
      createdAt: now,
      read: false,
      metadata: taskNotificationMetadata(updated, { questionId, status: 'pending' }),
    });
  }
  return updated;
}

export function queueBackgroundTaskContinue(id: string, opts: { auto?: boolean; reason?: string } = {}): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.status !== 'awaiting_continue') return null;
  const now = nowIso();
  const updated = updateBackgroundTask(task.id, {
    status: 'pending',
    continueResolution: {
      queuedAt: now,
      reason: clean(opts.reason ?? task.error ?? 'Continue requested.', 700),
      auto: opts.auto,
    },
    lastCheckInAt: now,
    lastCheckInMessage: opts.auto
      ? 'Internal run budget reached; queued automatic continuation.'
      : 'Continue requested; queued daemon continuation.',
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-continue-queued`,
      kind: 'execution',
      title: `Background task continuing: ${updated.title}`,
      body: `Task ${updated.id} will resume in the daemon from its previous partial progress.`,
      createdAt: nowIso(),
      read: false,
      silent: Boolean(opts.auto),
      metadata: taskNotificationMetadata(updated, { status: 'pending', continuing: true, auto: opts.auto }),
    });
  }
  return updated;
}

export function interruptStaleRunningBackgroundTasks(): number {
  let interrupted = 0;
  for (const task of listBackgroundTasks()) {
    if (task.status === 'running' || task.status === 'cancelling') {
      markBackgroundTaskFailed(task.id, DAEMON_RESTART_INTERRUPT_REASON, 'interrupted');
      interrupted += 1;
    }
  }
  return interrupted;
}

/**
 * Classify + record a finished worker turn. Shared by the fresh-run path AND the
 * input-resume path (both produce an AssistantResponse from respondPreferHarness),
 * so the pendingApproval / awaiting-input / coverage / classify / done sequence
 * lives in ONE place. Order matters: the awaiting-input park MUST come before the
 * coverage/classify checks so a clarifying question is never misread as
 * blocked/done.
 */
async function finishWorkerRun(
  task: BackgroundTaskRecord,
  run: { id: string },
  response: { text: string; pendingApprovalId?: string; stoppedReason?: RunStoppedReason },
): Promise<void> {
  if (response.pendingApprovalId) {
    markBackgroundTaskAwaitingApproval(task.id, response.pendingApprovalId, response.text);
    finishRun(run.id, {
      status: 'awaiting_approval',
      message: `Background task paused for approval ${response.pendingApprovalId}.`,
      pendingApprovalId: response.pendingApprovalId,
      outputPreview: response.text,
    });
    logger.info({ taskId: task.id, approvalId: response.pendingApprovalId }, 'Background task paused for approval');
    return;
  }
  if (response.stoppedReason === 'awaiting-input') {
    // Judge-gated check-in: the run asked the user a clarifying question. Park as
    // needs_input (surfaced to origin chat + needs-you card) and resume on the
    // answer. The question text IS response.text. MUST precede coverage/classify.
    const questionId = `bgq-${task.id}-${Date.now().toString(36)}`;
    markBackgroundTaskAwaitingInput(task.id, questionId, response.text || 'I need your input to continue.');
    finishRun(run.id, {
      status: 'awaiting_approval', // run-record paused state (the task status is 'awaiting_input')
      message: 'Background task paused for your input.',
      outputPreview: response.text,
    });
    logger.info({ taskId: task.id, questionId }, 'Background task paused for clarifying input');
    return;
  }
  if (response.stoppedReason === 'max-turns-with-grace') {
    const reason = (response.text || 'The run hit its turn budget before finishing; continue is required.').trim().slice(0, 400);
    clearLedger(task.runSessionId);
    markBackgroundTaskAwaitingContinue(task.id, reason, response.text);
    finishRun(run.id, {
      status: 'awaiting_approval',
      message: `Background task ${task.id} paused at its internal run budget and can be continued.`,
      outputPreview: response.text,
    });
    logger.warn({ taskId: task.id, reason }, 'Background task paused awaiting continue (not done)');
    return;
  }
  const outcome = await verifyBackgroundTaskDelivery(task, response.text, response.stoppedReason);
  if (outcome.outcome === 'blocked') {
    markBackgroundTaskBlocked(task.id, outcome.reason ?? 'Run did not finish cleanly.', response.text);
    finishRun(run.id, {
      status: 'failed',
      message: `Background task ${task.id} did not complete: ${outcome.reason ?? 'run did not finish cleanly'}`,
      outputPreview: response.text,
    });
    clearLedger(task.runSessionId);
    logger.warn({ taskId: task.id, reason: outcome.reason, stoppedReason: response.stoppedReason }, 'Background task did not complete cleanly (blocked, not done)');
    return;
  }
  markBackgroundTaskDone(task.id, response.text);
  finishRun(run.id, { status: 'completed', message: `Background task ${task.id} completed.`, outputPreview: response.text });
  clearLedger(task.runSessionId);
  logger.info({ taskId: task.id }, 'Background task completed');
}

export async function processBackgroundTasks(assistant: ClementineAssistant, limit?: number): Promise<number> {
  if (backgroundProcessorInFlight) return 0;
  backgroundProcessorInFlight = true;
  try {
    const policy = loadProactivityPolicy();
    const requestedLimit = typeof limit === 'number' ? limit : policy.maxConcurrentBackgroundTasks;
    const effectiveLimit = Math.max(1, Math.min(requestedLimit, policy.maxConcurrentBackgroundTasks));
    const progressCheckInMinMs = getBackgroundCheckInMs(policy);
    const pending = listBackgroundTasks({ status: 'pending' }).slice(0, effectiveLimit);
    let processed = 0;

	  for (const queued of pending) {
	    const runningTask = markBackgroundTaskRunning(queued.id);
	    if (!runningTask) continue;
	    let task: BackgroundTaskRecord = runningTask;
	    processed += 1;
	    logger.info({ taskId: task.id, title: task.title }, 'Background task started');

	    // Sticky approval: launching a background task IS the user's approval
	    // for the work it does. A background run is autonomous-by-default —
	    // the user already consented when they kicked it off, so internal
	    // mutating tools must NOT re-pause mid-run ("approve once, runs to
	    // completion"). We reuse the canonical plan-scope mechanism (the same
	    // one request_approval and plan-first approval open) keyed on this
	    // task's run session. allowedTools `*` covers every non-read tool that
	    // survives the taxonomy safety floor — admin tools and destructive-hint
	    // invocations are still gated BEFORE evaluateAutoApprove is consulted
	    // (decideToolApproval), so the parking sites below remain a real
	    // fallback for a genuinely un-coverable approval. Scoped strictly to
	    // this worker run's session; interactive chat/Discord/console turns are
	    // untouched.
	    try {
	      openPlanScope({
	        sessionId: task.runSessionId,
	        planProposalId: `background-task:${task.id}`,
	        approvedPlanObjective: task.title,
	        ttlMs: task.maxMinutes * 60_000,
	        allowedTools: ['*'],
	      });
	    } catch (scopeErr) {
	      // Opening the scope is best-effort plumbing; a failure here must
	      // never block the task. Without it, the parking fallback still
	      // protects the user — they just see the legacy per-tool prompts.
	      logger.warn({ err: scopeErr, taskId: task.id }, 'Failed to open background-task plan scope; falling back to per-tool approval');
	    }
	    const run = startRun({
      id: `run-${task.id}`,
      sessionId: task.runSessionId,
      userId: task.userId,
      channel: task.channel ?? 'background',
      source: task.source,
      title: task.title,
      message: task.prompt,
    });
	    addRunEvent(run.id, {
	      type: 'model_started',
	      message: `Background task ${task.id} started.`,
	    });
	    task = emitBackgroundTaskCheckIn(task, {
	      title: `Background task started: ${task.title}`,
	      body: [
	        `Task ${task.id} is now running.`,
	        `Run: ${run.id}`,
	        `Soft max runtime: ${task.maxMinutes} minutes`,
	        'I will send progress check-ins when tool activity shows meaningful movement.',
	      ].join('\n'),
	      runId: run.id,
	      metadata: { status: 'running' },
	    });

	    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	    try {
	      let toolCount = 0;
	      let lastProgressCheckInAt = Date.now();
	      heartbeatTimer = setInterval(() => {
	        const latestTask = getBackgroundTask(task.id);
	        if (!latestTask || (latestTask.status !== 'running' && latestTask.status !== 'cancelling')) return;
	        const now = Date.now();
	        if (now - lastProgressCheckInAt < progressCheckInMinMs) return;
	        lastProgressCheckInAt = now;
	        task = emitBackgroundTaskCheckIn(latestTask, {
	          title: latestTask.status === 'cancelling'
	            ? `Background task still cancelling: ${latestTask.title}`
	            : `Background task heartbeat: ${latestTask.title}`,
	          body: [
	            `Task ${latestTask.id} is ${latestTask.status}.`,
	            `Run: ${run.id}`,
	            latestTask.status === 'cancelling'
	              ? 'Cancellation has been requested. I am waiting for the runtime to reach a safe checkpoint.'
	              : 'The run is still active. No new tool event has landed since the previous check-in.',
	            `Observed tool calls: ${toolCount}`,
	          ].join('\n'),
	          runId: run.id,
	          metadata: {
	            status: latestTask.status,
	            heartbeat: true,
	            toolCount,
	          },
	        });
	      }, progressCheckInMinMs);
	      heartbeatTimer.unref?.();
      if (task.approvalResolution) {
        const resolution = task.approvalResolution;
        addRunEvent(run.id, {
          type: 'status',
          message: `${resolution.approved ? 'Approving' : 'Rejecting'} pending approval ${resolution.approvalId} and resuming from serialized SDK state.`,
          data: { approvalId: resolution.approvalId, approved: resolution.approved },
        });
        const result = await assistant.getRuntime().resolveApproval(resolution.approvalId, resolution.approved);
        if (heartbeatTimer) clearInterval(heartbeatTimer);

        if (!resolution.approved) {
          markBackgroundTaskFailed(task.id, result.text || `Approval ${resolution.approvalId} rejected.`, 'aborted');
          finishRun(run.id, {
            status: 'cancelled',
            message: `Background task stopped after approval ${resolution.approvalId} was rejected.`,
            outputPreview: result.text,
          });
          logger.info({ taskId: task.id, approvalId: resolution.approvalId }, 'Background task stopped after rejected approval');
          continue;
        }

        if (result.nextApprovalId) {
          markBackgroundTaskAwaitingApproval(task.id, result.nextApprovalId, result.text);
          finishRun(run.id, {
            status: 'awaiting_approval',
            message: `Background task paused for follow-up approval ${result.nextApprovalId}.`,
            pendingApprovalId: result.nextApprovalId,
            outputPreview: result.text,
          });
          logger.info({ taskId: task.id, approvalId: result.nextApprovalId }, 'Background task paused for follow-up approval');
          continue;
        }

        const postApprovalOutcome = await verifyBackgroundTaskDelivery(task, result.text);
        if (postApprovalOutcome.outcome === 'blocked') {
          markBackgroundTaskBlocked(task.id, postApprovalOutcome.reason ?? 'Task could not be completed.', result.text);
          finishRun(run.id, {
            status: 'failed',
            message: `Background task ${task.id} blocked after approval ${resolution.approvalId}: ${postApprovalOutcome.reason ?? 'could not complete'}`,
            outputPreview: result.text,
          });
          clearLedger(task.runSessionId);
          logger.warn({ taskId: task.id, approvalId: resolution.approvalId, reason: postApprovalOutcome.reason }, 'Background task blocked after approval continuation (not marked done)');
          continue;
        }
        markBackgroundTaskDone(task.id, result.text);
        finishRun(run.id, {
          status: 'completed',
          message: `Background task ${task.id} completed after approval ${resolution.approvalId}.`,
          outputPreview: result.text,
        });
        clearLedger(task.runSessionId);
        logger.info({ taskId: task.id, approvalId: resolution.approvalId }, 'Background task completed after approval continuation');
        continue;
      }

	      // Hard wall-clock cap. Previously `maxMinutes` was only embedded
	      // in the worker prompt as a soft hint — a model that ignored
	      // it (or a runtime stall) would have the task run for hours.
	      // The 2s shouldCancel poll inside the runtime turns this into
	      // an at-most-2s grace period past the deadline before we
	      // unwind via AgentRuntimeCancelledError. The catch handler
	      // reads cancellationReason and marks the task aborted with a
	      // user-readable message.
	      // Resume-with-answer / resume-with-continue vs fresh run: if this task
	      // was re-queued with a user's answer or a continuation request, inject
	      // that context instead of the original prompt. The run session holds the
	      // full history, so it re-enters cleanly. Consume the resolution once.
	      const resume = task.inputResolution;
	      const continuation = task.continueResolution;
	      let workerMessage = resume
	        ? buildWorkerInputResumePrompt(task, resume.answer)
	        : continuation
	          ? buildWorkerContinuePrompt(task, task.result ?? continuation.reason)
	          : buildWorkerPrompt(task);
	      if (resume || continuation) {
	        task = updateBackgroundTask(task.id, {
	          inputResolution: resume ? undefined : task.inputResolution,
	          continueResolution: continuation ? undefined : task.continueResolution,
	        }) ?? task;
	      }
	      const wallClockDeadlineMs = Date.now() + task.maxMinutes * 60_000;
	      let autoContinueAttempts = 0;
	      let response: AssistantResponse;
	      while (true) {
	        // CANON-ONE-LOOP: background tasks (incl. the mobile chat lane) run the
	        // gated harness loop; legacy fallback only pre-run. The shouldCancel
	        // deadline contract is preserved — the bridge maps it onto the harness
	        // kill switch and re-throws AgentRuntimeCancelledError on caller-driven
	        // aborts. Kill-switch CLEMMY_HARNESS_BACKGROUND=off.
	        const remainingWallMs = Math.max(1, wallClockDeadlineMs - Date.now());
	        const requestedModel = task.model ?? MODELS.deep;
	        response = await respondPreferHarness('background', {
	          sessionId: task.runSessionId,
	          channel: task.channel ?? 'background',
	          userId: task.userId,
	          model: requestedModel,
	          // P0-B — give a heavy worker turn real headroom, but never more than
	          // half the task's soft cap so one overlong call aborts-and-recovers
	          // (P0-A) well before the whole-task deadline cancels everything.
	          maxWallClockMs: Math.min(
	            BACKGROUND_STEP_WALL_CLOCK_MS,
	            Math.floor((task.maxMinutes * 60_000) / 2),
	            remainingWallMs,
	          ),
	          message: workerMessage,
	          runId: run.id,
	          shouldCancel: () => {
	            if (Date.now() > wallClockDeadlineMs) {
	              const latest = getBackgroundTask(task.id);
	              if (latest && latest.status !== 'cancelling' && latest.status !== 'aborted') {
	                updateBackgroundTask(task.id, {
	                  status: 'cancelling',
	                  cancellationRequestedAt: new Date().toISOString(),
	                  cancellationReason: `Exceeded soft max runtime of ${task.maxMinutes} minutes. Re-queue with a higher cap to continue.`,
	                });
	              }
	              return true;
	            }
	            const latest = getBackgroundTask(task.id);
	            return latest?.status === 'cancelling' || latest?.status === 'aborted';
	          },
	          onToolActivity: (activity) => {
	            toolCount += 1;
	            const now = Date.now();
	            const shouldCheckIn = toolCount === 1 ||
	              toolCount % PROGRESS_CHECKIN_TOOL_INTERVAL === 0 ||
	              now - lastProgressCheckInAt >= progressCheckInMinMs;
	            if (!shouldCheckIn) return;
	            lastProgressCheckInAt = now;
	            const latestTask = getBackgroundTask(task.id) ?? task;
	            task = emitBackgroundTaskCheckIn(latestTask, {
	              title: `Background task progress: ${latestTask.title}`,
	              body: [
	                `Task ${latestTask.id} is still running.`,
	                `Run: ${run.id}`,
	                `Latest tool: ${activity.toolName}`,
	                `Tool calls observed: ${toolCount}`,
	              ].join('\n'),
	              runId: run.id,
	              metadata: {
	                status: 'running',
	                toolName: activity.toolName,
	                toolCount,
	              },
	            });
	          },
	        }, (req) => assistant.respond(req));
	        task = recordBackgroundTaskRoute(task, run.id, response, requestedModel);

	        if (response.stoppedReason !== 'max-turns-with-grace') break;
	        if (autoContinueAttempts >= BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP) break;
	        clearLedger(task.runSessionId);
	        autoContinueAttempts += 1;
	        addRunEvent(run.id, {
	          type: 'status',
	          message: `Background task hit an internal run budget; continuing automatically (${autoContinueAttempts}/${BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP}).`,
	          data: { stoppedReason: response.stoppedReason, autoContinueAttempts },
	        });
	        const latestTask = getBackgroundTask(task.id) ?? task;
	        lastProgressCheckInAt = Date.now();
	        task = emitBackgroundTaskCheckIn(latestTask, {
	          title: `Background task continuing: ${latestTask.title}`,
	          body: [
	            `Task ${latestTask.id} hit an internal run budget before finishing.`,
	            `Run: ${run.id}`,
	            `Automatic continuation: ${autoContinueAttempts}/${BACKGROUND_TURN_BUDGET_AUTO_CONTINUE_CAP}`,
	          ].join('\n'),
	          runId: run.id,
	          metadata: {
	            status: 'running',
	            autoContinue: true,
	            autoContinueAttempts,
	          },
	        });
	        workerMessage = buildWorkerContinuePrompt(task, response.text);
	      }
	      if (heartbeatTimer) clearInterval(heartbeatTimer);

	      // Classify + record the result: pending-approval / awaiting-input (the
	      // judge-gated check-in) / partial-coverage / blocked / done — all in the
	      // shared helper so the fresh-run and input-resume paths agree.
	      await finishWorkerRun(task, run, response);
	    } catch (error) {
	      if (heartbeatTimer) clearInterval(heartbeatTimer);
	      const message = error instanceof Error ? error.message : String(error);
	      const latestTask = getBackgroundTask(task.id);
	      const cancelled = error instanceof AgentRuntimeCancelledError || latestTask?.status === 'cancelling';
	      markBackgroundTaskFailed(
	        task.id,
	        cancelled ? latestTask?.cancellationReason ?? 'Cancelled by user.' : message,
	        cancelled ? 'aborted' : 'failed',
	      );
	      finishRun(run.id, {
	        status: cancelled ? 'cancelled' : 'failed',
	        message: cancelled ? 'Background task cancelled at a safe checkpoint.' : message,
	        error: cancelled ? undefined : message,
	      });
	      if (cancelled) {
	        logger.info({ taskId: task.id }, 'Background task cancelled');
	      } else {
	        logger.error({ err: error, taskId: task.id }, 'Background task failed');
	      }
	    }
  }

    return processed;
  } finally {
    backgroundProcessorInFlight = false;
  }
}

export function renderBackgroundTask(task: BackgroundTaskRecord): string {
  const lines = [
    `Task ${task.id}`,
    `Status: ${task.status}`,
    `Title: ${task.title}`,
	    task.effectiveModel || task.modelProvider || task.modelRouteKind
	      ? `Model route: ${task.modelRouteKind ?? 'unknown'}${task.modelProvider ? `/${task.modelProvider}` : ''}${task.effectiveModel ? ` ${task.effectiveModel}` : ''}${task.modelRouteFalloverFrom ? ` (fallover from ${task.modelRouteFalloverFrom})` : ''}`
	      : '',
	    task.pendingApprovalId ? `Approval: ${task.pendingApprovalId}` : '',
	    task.startedAt ? `Started: ${task.startedAt}` : '',
	    task.lastCheckInAt ? `Last check-in: ${task.lastCheckInAt}` : '',
	    task.completedAt ? `Completed: ${task.completedAt}` : '',
	    task.error ? `Error: ${task.error}` : '',
	    task.lastCheckInMessage ? `Latest check-in:\n${task.lastCheckInMessage}` : '',
	    task.result ? `Result:\n${task.result.slice(0, 1600)}` : '',
	  ].filter(Boolean);
  return lines.join('\n');
}

export function renderBackgroundTaskList(tasks: BackgroundTask[], emptyText = 'No background tasks found.'): string {
  if (tasks.length === 0) return emptyText;
  return tasks
    .slice(0, 10)
    .map((task) => `- ${task.id} | ${task.status} | ${task.title}`)
    .join('\n');
}

type BackgroundTask = BackgroundTaskRecord;
