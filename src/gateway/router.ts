import pino from 'pino';
import type { ClementineAssistant } from '../assistant/core.js';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import {
  cancelBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
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
import { listEvents as listHarnessEvents } from '../runtime/harness/eventlog.js';
import { deriveTitle } from '../memory/derive-title.js';
import type { ToolActivity } from '../types.js';

const logger = pino({ name: 'clementine-next.gateway' });

export interface GatewayRequest {
  message: string;
  sessionId: string;
  userId?: string;
  channel?: string;
  model?: string;
  source?: 'discord' | 'webhook' | 'cli' | 'gateway' | 'mobile';
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
      // CANON-ONE-LOOP: webhook chat runs the gated harness loop (grounding /
      // confirm-first / guardrail / approvals) with the legacy synchronous
      // contract preserved; kill-switch CLEMMY_HARNESS_WEBHOOK=off.
      const response = await respondPreferHarness('webhook', {
        message: effectiveMessage,
        sessionId: request.sessionId,
        userId: request.userId,
        channel: request.channel,
        model: request.model,
        runId: run.id,
        onChunk: request.onChunk,
        onReasoning: request.onReasoning,
        onToolActivity: request.onToolActivity,
      }, (req) => this.assistant.respond(req));
      // Report-back honesty: a non-pending, non-throwing respond() can still be
      // a blocked / promised / errored run. Fail-open + suspicious-only; the run
      // status enum has no 'blocked', so a not-delivered verdict maps to 'failed'
      // with the reason. The returned text is left as the agent wrote it.
      const verdict = response.pendingApprovalId
        ? null
        : await verifyDelivered(request.message, response.text, { stoppedReason: response.stoppedReason });
      const runFailedNotDelivered = verdict ? !verdict.delivered : false;
      finishRun(run.id, {
        status: response.pendingApprovalId
          ? 'awaiting_approval'
          : runFailedNotDelivered
            ? 'failed'
            : 'completed',
        message: response.pendingApprovalId
          ? `Approval required: ${response.pendingApprovalId}.`
          : runFailedNotDelivered
            ? `Assistant run did not finish cleanly: ${verdict?.reason ?? 'no verifiable result'}`
            : 'Assistant run completed.',
        outputPreview: response.text,
        pendingApprovalId: response.pendingApprovalId,
        ...(runFailedNotDelivered ? { error: verdict?.reason ?? 'Run did not finish cleanly.' } : {}),
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
