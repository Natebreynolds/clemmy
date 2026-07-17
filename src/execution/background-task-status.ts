import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { redactSensitiveValue } from '../runtime/security.js';
import { listEvents, type EventRow } from '../runtime/harness/eventlog.js';
import { projectCanonicalTopLevelToolEvents } from '../runtime/harness/tool-effect.js';
import { listPending, type PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import { listNotifications, type NotificationRecord } from '../runtime/notifications.js';
import {
  getBackgroundTask,
  listBackgroundTasks,
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
} from './background-tasks.js';

const TOOL_EVENTS_DIR = path.join(BASE_DIR, 'state', 'tool-events');
const MAX_RESULT_PREVIEW_CHARS = 20_000;

export interface BackgroundToolEvent {
  at: string;
  sessionId?: string;
  toolName: string;
  kind?: string;
  phase?: string;
  durationMs?: number;
  approvalReason?: string;
  argsSummary?: string;
  outcome?: string;
  errorMessage?: string;
  mcp?: boolean;
}

export interface BackgroundTaskStatusDetails {
  task: BackgroundTaskRecord & { resultFull?: string };
  runId: string;
  pendingApprovals: PendingApprovalRow[];
  harnessEvents: EventRow[];
  toolEvents: BackgroundToolEvent[];
  /** Authoritative live logical tool-call tally for the run session — matches
   *  the "N tool calls" the check-ins report without counting MCP mirrors,
   *  independent of the (housekeeping-filtered) toolEvents feed above. */
  toolCallCount: number;
  notifications: NotificationRecord[];
  latestActivityAt?: string;
  latestActivitySummary?: string;
}

function normalizeTaskId(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('background:')) return trimmed.slice('background:'.length);
  if (trimmed.startsWith('run-bg-')) return trimmed.slice('run-'.length);
  return trimmed;
}

export function resolveBackgroundTask(input?: string): BackgroundTaskRecord | null {
  if (input && input.trim()) {
    const normalized = normalizeTaskId(input);
    const direct = getBackgroundTask(normalized);
    if (direct) return direct;
    const bySession = listBackgroundTasks().find((task) => (
      task.runSessionId === input ||
      task.runSessionId === normalized ||
      `run-${task.id}` === input ||
      task.id === normalized
    ));
    if (bySession) return bySession;
  }

  return listBackgroundTasks()
    .find((task) => task.status === 'running' || task.status === 'awaiting_approval' || task.status === 'awaiting_input' || task.status === 'awaiting_continue' || task.status === 'pending')
    ?? listBackgroundTasks()[0]
    ?? null;
}

function readResultFull(task: BackgroundTaskRecord): string | undefined {
  if (task.resultPath && existsSync(task.resultPath)) {
    try {
      const full = readFileSync(task.resultPath, 'utf-8');
      return full.length > MAX_RESULT_PREVIEW_CHARS
        ? `${full.slice(0, MAX_RESULT_PREVIEW_CHARS)}\n\n...[truncated for status preview]`
        : full;
    } catch {
      return task.result;
    }
  }
  return task.result;
}

function safeHarnessEvents(sessionId: string): EventRow[] {
  try {
    return listEvents(sessionId, { desc: true, limit: 40 });
  } catch {
    return [];
  }
}

function safePendingApprovals(sessionId: string): PendingApprovalRow[] {
  try {
    return listPending({ sessionId, status: 'pending' });
  } catch {
    return [];
  }
}

function isToolEvent(value: unknown): value is BackgroundToolEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.at === 'string' && typeof event.toolName === 'string';
}

function readToolEventsForSession(sessionId: string, limit = 60): BackgroundToolEvent[] {
  if (!existsSync(TOOL_EVENTS_DIR)) return [];
  const events: BackgroundToolEvent[] = [];
  const files = readdirSync(TOOL_EVENTS_DIR)
    .filter((entry) => entry.endsWith('.ndjson'))
    .sort()
    .reverse()
    .slice(0, 10);

  for (const fileName of files) {
    if (events.length >= limit) break;
    const filePath = path.join(TOOL_EVENTS_DIR, fileName);
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    } catch {
      continue;
    }

    for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as unknown;
        if (isToolEvent(parsed) && parsed.sessionId === sessionId) {
          events.push(redactSensitiveValue(parsed));
        }
      } catch {
        // Skip malformed lines; observability is best-effort.
      }
    }
  }

  return events.sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Reflection + internal bookkeeping tool names — execution plumbing, not
 * user-meaningful actions. Filtered OUT of the cockpit's human-facing Tools feed
 * (they made it read as rows of "reflection end success/cancelled" noise while
 * the real calls were buried). The truthful TOTAL tool-call count is reported
 * separately (toolCallCount, from the run session's tool_called events), so
 * hiding these from the feed never hides them from the tally. Same spirit as the
 * chat activity strip's milestone filter (activity-format.ts).
 */
const HOUSEKEEPING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'reflection',
  'focus_get', 'focus_set',
  'pending_action_get',
  'session_history',
  'memory_review_instructions',
  'recall_tool_result',
  'tool_choice_recall',
  'background_task_status',
  'execution_list', 'execution_get',
]);

export function isHousekeepingToolName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (HOUSEKEEPING_TOOL_NAMES.has(n)) return true;
  if (n.endsWith('_status')) return true; // *_status polling (composio_status, job_status, …)
  return false;
}

/**
 * Real tool calls for a run session, derived from the harness event log
 * (`tool_called` carries the REAL tool name; the NDJSON tool-observability feed
 * only captured `reflection` rows for background runs, which is why the cockpit
 * showed noise and a 0 count). Each call is paired with its `tool_returned` by
 * callId so the row is outcome-aware, newest events capped for the drawer.
 */
function harnessToolEventsForSession(sessionId: string, limit = 200): BackgroundToolEvent[] {
  let rows: EventRow[];
  try {
    rows = projectCanonicalTopLevelToolEvents(
      // Native calls can occupy four raw rows (canonical + mirror call/return).
      // Fetch enough bounded audit tail to still render `limit` logical calls.
      listEvents(sessionId, { types: ['tool_called', 'tool_returned'], limit: limit * 4, desc: true }),
    );
  } catch {
    return [];
  }
  const returnsByCallId = new Map<string, EventRow>();
  for (const row of rows) {
    if (row.type !== 'tool_returned') continue;
    const callId = String((row.data as { callId?: unknown } | undefined)?.callId ?? '');
    if (callId) returnsByCallId.set(callId, row);
  }
  const events: BackgroundToolEvent[] = [];
  for (const row of rows) {
    if (row.type !== 'tool_called') continue;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const toolName = String(data.tool || data.name || 'tool');
    const callId = String(data.callId ?? '');
    const ret = callId ? returnsByCallId.get(callId) : undefined;
    const returnData = (ret?.data ?? {}) as Record<string, unknown>;
    const resultText = ([returnData.result, returnData.error, returnData.preview]
      .find((value) => typeof value === 'string' && value.trim().length > 0) as string | undefined) ?? '';
    const erroredOut = returnData.ok === false || /^\s*(error|failed|exception)\b/i.test(resultText);
    events.push({
      at: row.createdAt,
      sessionId,
      toolName,
      kind: typeof data.kind === 'string' ? data.kind : undefined,
      phase: ret ? 'end' : 'start',
      ...(ret ? { outcome: erroredOut ? 'error' : 'success' } : {}),
      ...(erroredOut ? { errorMessage: resultText.slice(0, 200) } : {}),
    });
  }
  return events.slice(-limit);
}

/**
 * The cockpit's human-facing Tools feed: real tool calls (harness-derived,
 * authoritative names) merged with any non-harness NDJSON tool events, with
 * reflection/housekeeping filtered out. Sorted chronologically.
 */
function buildHumanizedToolFeed(sessionId: string): BackgroundToolEvent[] {
  const harness = harnessToolEventsForSession(sessionId);
  const seen = new Set(harness.map((event) => `${event.toolName}|${event.at.slice(0, 19)}`));
  const merged = [...harness];
  for (const event of readToolEventsForSession(sessionId)) {
    const key = `${event.toolName}|${event.at.slice(0, 19)}`;
    if (seen.has(key)) continue; // already represented by the harness-derived row
    seen.add(key);
    merged.push(event);
  }
  return merged
    .filter((event) => !isHousekeepingToolName(event.toolName))
    .sort((left, right) => left.at.localeCompare(right.at));
}

function notificationsForTask(task: BackgroundTaskRecord): NotificationRecord[] {
  return listNotifications(200)
    .filter((item) => {
      const metadata = item.metadata ?? {};
      return metadata.backgroundTaskId === task.id || metadata.runSessionId === task.runSessionId;
    })
    .map((item) => redactSensitiveValue(item))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function latestActivity(details: Omit<BackgroundTaskStatusDetails, 'latestActivityAt' | 'latestActivitySummary'>): {
  latestActivityAt?: string;
  latestActivitySummary?: string;
} {
  const candidates: Array<{ at: string; summary: string }> = [];
  const task = details.task;
  if (task.updatedAt) candidates.push({ at: task.updatedAt, summary: `Task status is ${task.status}.` });
  if (task.lastCheckInAt && task.lastCheckInMessage) {
    candidates.push({ at: task.lastCheckInAt, summary: task.lastCheckInMessage });
  }
  for (const event of details.toolEvents) {
    candidates.push({
      at: event.at,
      summary: `${event.toolName} ${event.phase ?? 'event'}${event.outcome ? ` (${event.outcome})` : ''}`,
    });
  }
  for (const event of details.harnessEvents) {
    const message = typeof event.data?.message === 'string'
      ? event.data.message
      : event.type;
    candidates.push({ at: event.createdAt, summary: message });
  }
  for (const notification of details.notifications) {
    candidates.push({ at: notification.createdAt, summary: notification.title });
  }
  candidates.sort((left, right) => right.at.localeCompare(left.at));
  return {
    latestActivityAt: candidates[0]?.at,
    latestActivitySummary: candidates[0]?.summary,
  };
}

export function getBackgroundTaskStatus(input?: string): BackgroundTaskStatusDetails | null {
  const task = resolveBackgroundTask(input);
  if (!task) return null;
  const detailsBase = {
    task: { ...task, resultFull: readResultFull(task) },
    runId: `run-${task.id}`,
    pendingApprovals: safePendingApprovals(task.runSessionId),
    harnessEvents: safeHarnessEvents(task.runSessionId),
    // Human-facing feed: real tool calls with their names, reflection/housekeeping
    // filtered out (P4). The truthful total is toolCallCount below (P3).
    toolEvents: buildHumanizedToolFeed(task.runSessionId),
    toolCallCount: projectCanonicalTopLevelToolEvents(
      listEvents(task.runSessionId, { types: ['tool_called'] }),
      'tool_called',
    ).length,
    notifications: notificationsForTask(task),
  };
  return {
    ...detailsBase,
    ...latestActivity(detailsBase),
  };
}

export function listBackgroundTaskStatusSummaries(input: {
  status?: BackgroundTaskStatus | 'active' | 'all';
  limit?: number;
} = {}): BackgroundTaskStatusDetails[] {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const tasks = listBackgroundTasks()
    .filter((task) => {
      if (!input.status || input.status === 'all') return true;
      if (input.status === 'active') {
        return task.status === 'pending'
          || task.status === 'running'
          || task.status === 'awaiting_approval'
          || task.status === 'awaiting_input'
          || task.status === 'awaiting_continue'
          || task.status === 'cancelling';
      }
      return task.status === input.status;
    })
    .slice(0, limit);
  return tasks
    .map((task) => getBackgroundTaskStatus(task.id))
    .filter((details): details is BackgroundTaskStatusDetails => Boolean(details));
}

function timeOnly(value?: string): string {
  return value ? value.slice(11, 19) : '--:--:--';
}

function renderApproval(approval: PendingApprovalRow): string {
  const tool = approval.tool ? ` via ${approval.tool}` : '';
  return `- ${approval.approvalId}${tool}: ${approval.subject}`;
}

function renderToolEvent(event: BackgroundToolEvent): string {
  const duration = typeof event.durationMs === 'number' ? ` ${event.durationMs}ms` : '';
  const outcome = event.outcome ? ` ${event.outcome}` : '';
  const args = event.argsSummary ? ` | ${event.argsSummary}` : '';
  const error = event.errorMessage ? ` | error: ${event.errorMessage}` : '';
  return `- ${timeOnly(event.at)} ${event.toolName} ${event.phase ?? 'event'}${outcome}${duration}${args}${error}`;
}

export function renderBackgroundTaskStatus(details: BackgroundTaskStatusDetails): string {
  const task = details.task;
  const lines = [
    `Background task ${task.id}`,
    `Status: ${task.status}`,
    `Title: ${task.title}`,
    `Source: ${task.source}`,
    `Run: ${details.runId}`,
    `Session: ${task.runSessionId}`,
    task.startedAt ? `Started: ${task.startedAt}` : '',
    task.completedAt ? `Completed: ${task.completedAt}` : '',
    task.error ? `Error: ${task.error}` : '',
    details.latestActivityAt ? `Latest activity: ${details.latestActivityAt} — ${details.latestActivitySummary ?? ''}` : '',
    task.lastCheckInMessage ? `Latest check-in: ${task.lastCheckInMessage}` : '',
  ].filter(Boolean);

  if (details.pendingApprovals.length > 0) {
    lines.push('', 'Pending approvals:', ...details.pendingApprovals.map(renderApproval));
  }

  const recentTools = details.toolEvents.slice(-12);
  if (recentTools.length > 0) {
    lines.push('', 'Recent tool activity:', ...recentTools.map(renderToolEvent));
  }

  const recentNotifications = details.notifications.slice(-5);
  if (recentNotifications.length > 0) {
    lines.push(
      '',
      'Recent notifications:',
      ...recentNotifications.map((notification) => `- ${timeOnly(notification.createdAt)} ${notification.title}${notification.silent ? ' (dashboard-only)' : ''}`),
    );
  }

  const result = task.resultFull ?? task.result;
  if (result) {
    lines.push('', 'Result:', result);
  }

  return lines.join('\n');
}
