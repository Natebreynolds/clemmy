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
import { SessionStore } from '../memory/session-store.js';
import { ExecutionStore } from './store.js';
import type { RunStoppedReason } from '../types.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { addRunEvent, finishRun, startRun } from '../runtime/run-events.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { getBackgroundCheckInMs, loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { openPlanScope } from '../agents/plan-scope.js';

const logger = pino({ name: 'clementine-next.background-tasks' });

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
  model?: string;
  maxMinutes: number;
  source: 'discord' | 'webhook' | 'cli' | 'gateway' | 'daemon' | 'mobile' | 'workflow';
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
const DAEMON_RESTART_INTERRUPT_REASON = 'Daemon restarted while task was running.';
let backgroundProcessorInFlight = false;

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

function taskNotificationMetadata(task: BackgroundTaskRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const channelParts = task.channel?.startsWith('discord:') ? task.channel.split(':') : [];
  const discordChannelId = channelParts.length >= 3 ? channelParts[channelParts.length - 1] : undefined;
  const allowDiscordCheckIns = loadProactivityPolicy().allowDiscordCheckIns;
  return {
    backgroundTaskId: task.id,
    sessionId: task.originSessionId,
    runSessionId: task.runSessionId,
    userId: task.userId,
    channel: task.channel,
    discordUserId: allowDiscordCheckIns && task.channel?.startsWith('discord:') ? task.userId : undefined,
    discordChannelId: allowDiscordCheckIns ? discordChannelId : undefined,
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

function buildWorkerPrompt(task: BackgroundTaskRecord): string {
  const policy = loadProactivityPolicy();
  return [
    'You are running a durable Clementine background task.',
    `Autonomy mode: ${policy.mode}.`,
    'Work autonomously through the request. Use available tools when useful.',
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
    'Original request:',
    task.prompt,
  ].filter(Boolean).join('\n');
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

export function listBackgroundTasks(filter: { status?: BackgroundTaskStatus; userId?: string; channel?: string } = {}): BackgroundTaskRecord[] {
  ensureTaskDir();
  return readdirSync(BACKGROUND_TASK_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskFile(path.join(BACKGROUND_TASK_DIR, entry)))
    .filter((task): task is BackgroundTaskRecord => Boolean(task))
    .filter((task) => !filter.status || task.status === filter.status)
    .filter((task) => !filter.userId || task.userId === filter.userId)
    .filter((task) => !filter.channel || task.channel === filter.channel)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getBackgroundTaskByApprovalId(approvalId: string): BackgroundTaskRecord | null {
  if (!approvalId) return null;
  return listBackgroundTasks().find((task) => task.pendingApprovalId === approvalId) ?? null;
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

export function markBackgroundTaskRunning(id: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task || task.status !== 'pending') return null;
  return updateBackgroundTask(id, {
    status: 'running',
    startedAt: nowIso(),
    error: undefined,
    pendingApprovalId: undefined,
  });
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
type BackgroundTaskOutcome = 'done' | 'failed' | 'blocked';

function enqueueBackgroundTaskOutcomeTurn(
  task: BackgroundTaskRecord,
  outcome: BackgroundTaskOutcome,
  detail: string,
): void {
  try {
    const sessionId = task.originSessionId;
    if (!sessionId) return;
    // State-agnostic id prefix: a task reaches exactly ONE terminal state, so
    // scanning for the id alone makes the report-back idempotent across retries
    // AND prevents a done+failed double-report for the same id.
    const idPrefix = `[background task ${task.id} `;
    const store = new SessionStore();
    const existing = store.get(sessionId);
    if (existing.turns.some((t) => typeof t.text === 'string' && t.text.startsWith(idPrefix))) {
      return; // already reported — idempotent
    }
    const head =
      outcome === 'done' ? `${idPrefix}completed]`
        : outcome === 'failed' ? `${idPrefix}FAILED]`
          : `${idPrefix}BLOCKED]`;
    const guidance =
      outcome === 'done'
        ? `This work ran in the background and just finished — continue from here. For the complete result call background_task_status('${task.id}').`
        : outcome === 'failed'
          ? `This background task FAILED — it did NOT complete. Decide whether to retry with an adjusted approach or tell the user; do not assume it succeeded. Details via background_task_status('${task.id}').`
          : `This background task is BLOCKED — it could not finish without a prerequisite. Surface the blocker to the user or resolve it, then re-run. Details via background_task_status('${task.id}').`;
    const preview =
      detail.length > RESULT_TRUNCATE_CHARS ? `${detail.slice(0, RESULT_TRUNCATE_CHARS)}\n…[truncated]` : detail;
    const text = `${head} ${task.title}\n\n${preview}\n\n(${guidance})`;
    store.appendTurn(sessionId, { role: 'user', text, createdAt: nowIso() });
    logger.info({ taskId: task.id, sessionId, outcome }, 'Background task outcome enqueued into origin session');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, taskId: task.id },
      'enqueueBackgroundTaskOutcomeTurn failed (best-effort; task state not blocked)',
    );
  }
}

export function markBackgroundTaskDone(id: string, result: string): BackgroundTaskRecord | null {
  const task = getBackgroundTask(id);
  if (!task) return null;
  const resultPath = writeFullResultFile(task, result);
  const updated = updateBackgroundTask(id, {
    status: 'done',
    completedAt: nowIso(),
    result: resultPath ? `${result.slice(0, RESULT_TRUNCATE_CHARS)}\n...[full result saved to ${resultPath}]` : result,
    resultPath,
    error: undefined,
    pendingApprovalId: undefined,
    approvalResolution: undefined,
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

export function markBackgroundTaskAwaitingApproval(id: string, approvalId: string, resultText: string): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    status: 'awaiting_approval',
    pendingApprovalId: approvalId,
    approvalResolution: undefined,
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
    status: 'blocked',
    completedAt: nowIso(),
    error: clean(reason, 1000),
    result: resultText.slice(0, RESULT_TRUNCATE_CHARS),
    pendingApprovalId: undefined,
    approvalResolution: undefined,
  });
  if (updated) {
    addNotification({
      id: `${Date.now()}-background-${updated.id}-blocked`,
      kind: 'approval',
      title: `Background task blocked: ${updated.title}`,
      body: [
        `I couldn't finish this — I'm blocked, so I did NOT ship a partial/empty result.`,
        ``,
        `Blocker: ${clean(reason, 600)}`,
        ``,
        `Re-run once that's resolved and I'll continue.`,
      ].join('\n'),
      createdAt: nowIso(),
      read: false,
      metadata: taskNotificationMetadata(updated, { status: 'blocked' }),
    });
    // Report-back without fail: a BLOCKED task must reach Clementine's context,
    // not just a notification — so she can surface the blocker or resolve it.
    enqueueBackgroundTaskOutcomeTurn(updated, 'blocked', reason);
  }
  return updated;
}

export function markBackgroundTaskFailed(id: string, error: string, status: Extract<BackgroundTaskStatus, 'failed' | 'aborted' | 'interrupted'> = 'failed'): BackgroundTaskRecord | null {
  const updated = updateBackgroundTask(id, {
    status,
    completedAt: nowIso(),
    error: clean(error, 1000),
    approvalResolution: undefined,
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
const BLOCKED_TEXT_PATTERNS: RegExp[] = [
  /\bapproval required\b/i,
  /\bpending approval id\b/i,
  /\bi('?m| am)\s+blocked\b/i,
  /\bi can('?t|not)\s+(complete|finish|proceed|continue)\b/i,
  /\bunable to (complete|finish|proceed|continue|access|retrieve|pull)\b/i,
  /\bcannot (complete|finish|proceed|continue) (this|the) (task|work|objective)\b/i,
  /\bneed (more|additional|your) (input|information|access|approval|credentials)\b/i,
  /\bwaiting (on|for) (your|user|the user)\b/i,
  /\bblocked (on|by)\b/i,
  /\bmissing (data|access|credentials|the required)\b/i,
];

export function classifyBackgroundTaskOutcome(
  task: Pick<BackgroundTaskRecord, 'runSessionId'>,
  finalText: string,
  stoppedReason?: RunStoppedReason,
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

  // 3) Text heuristic: the agent's own final words say it's blocked.
  const text = (finalText || '').trim();
  if (text) {
    for (const pattern of BLOCKED_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        return { outcome: 'blocked', reason: text.slice(0, 400) };
      }
    }
  }

  return { outcome: 'done' };
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

        const postApprovalOutcome = classifyBackgroundTaskOutcome(task, result.text);
        if (postApprovalOutcome.outcome === 'blocked') {
          markBackgroundTaskBlocked(task.id, postApprovalOutcome.reason ?? 'Task could not be completed.', result.text);
          finishRun(run.id, {
            status: 'failed',
            message: `Background task ${task.id} blocked after approval ${resolution.approvalId}: ${postApprovalOutcome.reason ?? 'could not complete'}`,
            outputPreview: result.text,
          });
          logger.warn({ taskId: task.id, approvalId: resolution.approvalId, reason: postApprovalOutcome.reason }, 'Background task blocked after approval continuation (not marked done)');
          continue;
        }
        markBackgroundTaskDone(task.id, result.text);
        finishRun(run.id, {
          status: 'completed',
          message: `Background task ${task.id} completed after approval ${resolution.approvalId}.`,
          outputPreview: result.text,
        });
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
	      const wallClockDeadlineMs = Date.now() + task.maxMinutes * 60_000;
	      const response = await assistant.respond({
	        sessionId: task.runSessionId,
	        channel: task.channel ?? 'background',
	        userId: task.userId,
	        model: task.model ?? MODELS.deep,
	        message: buildWorkerPrompt(task),
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
	      });
	      if (heartbeatTimer) clearInterval(heartbeatTimer);

      if (response.pendingApprovalId) {
        markBackgroundTaskAwaitingApproval(task.id, response.pendingApprovalId, response.text);
        finishRun(run.id, {
          status: 'awaiting_approval',
          message: `Background task paused for approval ${response.pendingApprovalId}.`,
          pendingApprovalId: response.pendingApprovalId,
          outputPreview: response.text,
        });
        logger.info({ taskId: task.id, approvalId: response.pendingApprovalId }, 'Background task paused for approval');
        continue;
      }

      markBackgroundTaskDone(task.id, response.text);
      finishRun(run.id, {
        status: 'completed',
        message: `Background task ${task.id} completed.`,
        outputPreview: response.text,
      });
      logger.info({ taskId: task.id }, 'Background task completed');
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
