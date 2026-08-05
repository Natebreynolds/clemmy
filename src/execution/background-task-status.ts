import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { redactSensitiveValue } from '../runtime/security.js';
import { listEvents, type EventRow } from '../runtime/harness/eventlog.js';
import { projectCanonicalTopLevelToolEvents } from '../runtime/harness/tool-effect.js';
import { listPending, type PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import { listNotifications, type NotificationRecord } from '../runtime/notifications.js';
import { summarizeWorkManifests, type WorkManifestSummary } from '../runtime/harness/work-manifest.js';
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
  workManifests: WorkManifestSummary[];
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
  // The bare task record is a FALLBACK, not activity: any record write bumps
  // updatedAt, so seeding it as a candidate made "Latest activity" collapse to
  // the literal "Task status is running." whenever real events were sparse —
  // exactly the useless answer a user asking "how's it going?" already has.
  if (!candidates.length && task.updatedAt) {
    candidates.push({ at: task.updatedAt, summary: `Task status is ${task.status}; no run activity recorded yet.` });
  }
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
    workManifests: summarizeWorkManifests(task.runSessionId),
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

function elapsedLabel(startedAt: string): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 'unknown';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - startedMs) / 60_000));
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
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
    task.startedAt && !task.completedAt ? `Elapsed: ${elapsedLabel(task.startedAt)}` : '',
    // The truthful total (housekeeping included) — the humanized feed below is
    // filtered, so without this line the model reads 12 rows and reports "a
    // dozen calls" for a 200-call run.
    details.toolCallCount > 0 ? `Tool calls so far: ${details.toolCallCount}` : '',
    task.completedAt ? `Completed: ${task.completedAt}` : '',
    task.error ? `Error: ${task.error}` : '',
    `Contract: v${task.contractVersion ?? 1}${task.pendingContractRevision ? ` (v${task.pendingContractRevision.version} queued for the next model boundary)` : ''}`,
    details.latestActivityAt ? `Latest activity: ${details.latestActivityAt} — ${details.latestActivitySummary ?? ''}` : '',
    task.lastCheckInMessage ? `Latest check-in: ${task.lastCheckInMessage}` : '',
  ].filter(Boolean);

  if (details.pendingApprovals.length > 0) {
    lines.push('', 'Pending approvals:', ...details.pendingApprovals.map(renderApproval));
  }

  if (details.workManifests.length > 0) {
    lines.push('', 'Logical work progress:');
    for (const manifest of details.workManifests) {
      lines.push(`- ${manifest.manifestId} contract ${manifest.contractVersion}: ${manifest.completed}/${manifest.total} items completed every phase; ${manifest.remaining} remaining; ${manifest.evidenceCount} evidence refs.`);
      for (const phase of manifest.phases) {
        lines.push(`  - ${phase.label}: ${phase.succeeded}/${phase.total} complete${phase.running ? `, ${phase.running} running` : ''}${phase.failed ? `, ${phase.failed} failed` : ''}${phase.needsValidation ? `, ${phase.needsValidation} need validation` : ''}${phase.invalidated ? `, ${phase.invalidated} invalidated` : ''}`);
      }
      if (manifest.untrackedCheckpoints) lines.push(`  - ${manifest.untrackedCheckpoints} untracked attempts excluded from logical totals.`);
      if (manifest.staleCheckpoints) lines.push(`  - ${manifest.staleCheckpoints} stale-contract checkpoints preserved but not counted.`);
    }
  }

  // Progress-shaped run events (fan-out counters, heartbeats, step starts) —
  // previously fetched and silently dropped, leaving the model nothing
  // quantitative for runs without a work manifest (any single-loop run).
  const progressEvents = details.harnessEvents
    .filter((event) => event.type === 'batch_progress' || event.type === 'step_started'
      || (event.type === 'heartbeat' && (event.data as { kind?: unknown } | undefined)?.kind === 'progress_check_in'))
    .slice(0, 5)
    .reverse();
  if (progressEvents.length > 0) {
    lines.push('', 'Run progress:', ...progressEvents.map((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === 'batch_progress') {
        const failed = typeof data.failed === 'number' && data.failed > 0 ? ` (${data.failed} failed)` : '';
        return `- ${timeOnly(event.createdAt)} items: ${data.done ?? '?'}/${data.total ?? '?'} done${failed}`;
      }
      if (event.type === 'step_started') {
        return `- ${timeOnly(event.createdAt)} step: ${typeof data.title === 'string' ? data.title : 'next step'}`;
      }
      const message = typeof data.message === 'string' ? data.message : `${data.steps ?? '?'} steps completed`;
      return `- ${timeOnly(event.createdAt)} ${message}`;
    }));
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

/**
 * One-glance snapshot of active background work for the CHAT prompt. Until now
 * the only per-turn signal that spawned work existed was an optional focus
 * "Linked actions" line that frequently was not written (no pin, stale focus,
 * different surface) — so the model answered "are you working on this?" with
 * no evidence a task even existed (live 2026-08-04). This block gives every
 * chat turn the running work's title, elapsed time, and item counts, and the
 * BACKGROUND STATUS rubric line points at `background_task_status` for depth.
 * Empty string when nothing is active — casual chats carry zero overhead.
 */
export function renderActiveBackgroundWorkForInstructions(): string {
  let tasks: BackgroundTaskRecord[];
  try {
    tasks = listBackgroundTasks().filter((task) => task.status === 'pending'
      || task.status === 'running'
      || task.status === 'awaiting_approval'
      || task.status === 'awaiting_input'
      || task.status === 'awaiting_continue');
  } catch {
    return '';
  }
  if (tasks.length === 0) return '';
  const lines = tasks.slice(0, 3).map((task) => {
    const parts: string[] = [`- [${task.status.replace(/_/g, ' ')}] ${task.title}`];
    if (task.startedAt && !task.completedAt) parts.push(`${elapsedLabel(task.startedAt)} in`);
    try {
      const manifest = summarizeWorkManifests(task.runSessionId)[0];
      if (manifest && manifest.total > 0) {
        const phase = manifest.phases.find((p) => p.running > 0 || p.succeeded < p.total);
        parts.push(`${manifest.completed}/${manifest.total} items through every phase${phase ? `; now: ${phase.label} ${phase.succeeded}/${phase.total}` : ''}`);
      }
    } catch { /* manifest read is best-effort */ }
    if (task.status === 'awaiting_approval') parts.push('waiting on an approval from the user');
    if (task.status === 'awaiting_input') parts.push('waiting on an answer from the user');
    return parts.join(' — ');
  });
  const overflow = tasks.length > 3 ? `\n(${tasks.length - 3} more — \`background_tasks_recent\` lists them.)` : '';
  return [
    'Background work you already have in flight (when asked how it is going, answer from THIS and `background_task_status` — never guess):',
    ...lines,
  ].join('\n') + overflow;
}
