import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import {
  cancelBackgroundTask,
  createBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  renderBackgroundTask,
  renderBackgroundTaskList,
  resumeBackgroundTask,
} from '../execution/background-tasks.js';
import { MODELS } from '../config.js';
import { addRunEvent, finishRun, getRun, listRuns, startRun, type RunRecord } from '../runtime/run-events.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import type { ToolActivity } from '../types.js';

const logger = pino({ name: 'clementine-next.gateway' });

export interface GatewayRequest {
  message: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  model?: string;
  source?: 'discord' | 'webhook' | 'cli' | 'gateway';
  runId?: string;
  /** Streaming-text delta callback. Forwarded to assistant.respond,
   *  which forwards it to the runtime. Only fires when the underlying
   *  runtime supports streaming (OpenAI Agents SDK path). */
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
}

type GatewayCommand =
  | { type: 'list_tasks' }
  | { type: 'task_status'; id: string }
  | { type: 'cancel_task'; id: string }
  | { type: 'resume_task'; id: string }
  | { type: 'list_runs' }
  | { type: 'stop_active' }
  | { type: 'run_status'; id: string };

function clean(value: string, maxChars = 200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function deriveTitle(message: string): string {
  return clean(message
    .replace(/^\/?(background|bg|run|start|queue|plan)\b/i, '')
    .replace(/^(please|can you|could you|let'?s|i need you to|help me)\s+/i, '')
    .trim(), 120) || 'Background task';
}

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

  return null;
}

function hasDurableExecutionIntent(message: string): boolean {
  const lower = message.toLowerCase();
  if (/^\/?(background|bg)\b/.test(lower)) return true;
  if (/\b(run|queue|start).{0,40}\b(background|overnight|as a job)\b/.test(lower)) return true;
  if (/\b(keep working|don't stop|do not stop|long-running|longer running|overnight|take your time)\b/.test(lower)) return true;
  if (/\b(from start to finish|end to end|get it done|finish this|finish it all)\b/.test(lower)) {
    return /\b(build|implement|migrate|refactor|wire|ship|deploy|fix|create|set up|setup|finish)\b/.test(lower);
  }
  return false;
}

function stripBackgroundPrefix(message: string): string {
  return message.trim()
    .replace(/^\/?(background|bg)\s*[:\-]?\s*/i, '')
    .trim();
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
    const command = parseCommand(request.message);
    if (command) {
      const response = this.handleCommand(command, request);
      finishRun(run.id, {
        status: 'completed',
        message: 'Control command handled.',
        outputPreview: response.text,
      });
      return { ...response, runId: run.id };
    }

    if (hasDurableExecutionIntent(request.message)) {
      const prompt = stripBackgroundPrefix(request.message) || request.message;
      addRunEvent(run.id, {
        type: 'queued_background',
        status: 'queued',
        message: 'Request promoted to a durable background task.',
      });
      const task = createBackgroundTask({
        title: deriveTitle(prompt),
        prompt,
        originSessionId: request.sessionId,
        userId: request.userId,
        channel: request.channel,
        model: request.model ?? MODELS.deep,
        maxMinutes: loadProactivityPolicy().defaultLongTaskMinutes,
        source: request.source ?? 'gateway',
      });
      logger.info({ taskId: task.id, sessionId: request.sessionId, channel: request.channel }, 'Gateway queued background task');
      finishRun(run.id, {
        status: 'queued',
        message: `Queued background task ${task.id}.`,
        queuedTaskId: task.id,
        outputPreview: renderTaskQueued(task.id),
      });
      return {
        text: renderTaskQueued(task.id),
        sessionId: request.sessionId,
        queuedTaskId: task.id,
        runId: run.id,
      };
    }

    try {
      addRunEvent(run.id, {
        type: 'model_started',
        message: 'Assistant run started.',
      });
      const response = await this.assistant.respond({
        message: request.message,
        sessionId: request.sessionId,
        userId: request.userId,
        channel: request.channel,
        model: request.model,
        runId: run.id,
        onChunk: request.onChunk,
        onReasoning: request.onReasoning,
        onToolActivity: request.onToolActivity,
      });
      finishRun(run.id, {
        status: response.pendingApprovalId ? 'awaiting_approval' : 'completed',
        message: response.pendingApprovalId
          ? `Approval required: ${response.pendingApprovalId}.`
          : 'Assistant run completed.',
        outputPreview: response.text,
        pendingApprovalId: response.pendingApprovalId,
      });
      return {
        text: response.text,
        sessionId: response.sessionId,
        pendingApprovalId: response.pendingApprovalId,
        runId: run.id,
        stoppedReason: response.stoppedReason,
        turnsUsed: response.turnsUsed,
      };
    } catch (error) {
      finishRun(run.id, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
