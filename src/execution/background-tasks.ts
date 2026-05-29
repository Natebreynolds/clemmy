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
import type { ClementineAssistant } from '../assistant/core.js';
import { addRunEvent, finishRun, startRun } from '../runtime/run-events.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { getBackgroundCheckInMs, loadProactivityPolicy } from '../agents/proactivity-policy.js';

const logger = pino({ name: 'clementine-next.background-tasks' });

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'awaiting_approval'
  | 'done'
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
  source: 'discord' | 'webhook' | 'cli' | 'gateway' | 'daemon' | 'mobile';
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
  }
  return updated;
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
