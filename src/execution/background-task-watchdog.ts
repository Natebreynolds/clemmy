import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { listBackgroundTasks, type BackgroundTaskRecord } from './background-tasks.js';
import { ApprovalStore } from '../runtime/approval-store.js';

/**
 * Background-task watchdog (north star: REPORTS BACK WITHOUT FAIL).
 *
 * The owner's "silent desktop background task notification" report: a background
 * task can go silent in two ways the normal terminal markers don't cover —
 *
 *  1. It DIES mid-run (daemon crash/restart, an unhandled throw outside the
 *     markFailed path) and is left `running`/`pending` forever — no
 *     markBackgroundTaskDone/Failed/Blocked ever fires, so no notification.
 *  2. It reaches a terminal state but the terminal notification is never
 *     DELIVERED (delivery queue down, restart across the finish boundary) — the
 *     record says done, the user never heard.
 *
 * Background tasks had NO watchdog (workflows got `workflow-watchdog.ts`). This
 * is the minimal mirror: it OBSERVES the task store (never mutates task state,
 * so it can't regress execution) and emits ONE deduped notification per stuck
 * task. Delivery-aware, exactly like the workflow watchdog: a task with a
 * delivered terminal notification is never flagged.
 */

const logger = pino({ name: 'clementine-next.background-task-watchdog' });

/** Floor for "a running/pending task with no maxMinutes budget is stuck". */
const DEFAULT_RUNNING_STALL_MS = 30 * 60_000;
/** Grace added on top of a task's own maxMinutes budget before we call it dead. */
const RUNNING_GRACE_MS = 5 * 60_000;
/** A terminal task whose notification never landed is surfaced once the marker
 *  has had time to be delivered (terminal + notify are the same synchronous
 *  tick, so a few minutes is ample). */
const DEFAULT_TERMINAL_UNDELIVERED_STALL_MS = 3 * 60_000;
/** Upper bound — don't alert on the historical backlog of pre-watchdog tasks. */
const DEFAULT_TERMINAL_UNDELIVERED_MAX_MS = 12 * 60 * 60_000;

// Terminal states that should have reported back. 'aborted' (user cancelled —
// they know) and 'interrupted' (daemon-restart transient, auto-resumed) are
// deliberately excluded, matching markBackgroundTaskFailed's report-back gating.
const TERMINAL_REPORTING_STATUSES = new Set<BackgroundTaskStatusLike>(['done', 'blocked', 'failed']);

type BackgroundTaskStatusLike = BackgroundTaskRecord['status'];

export interface StalledBackgroundTask {
  id: string;
  title: string;
  ageMs: number;
  reason: 'running_stalled' | 'terminal_undelivered' | 'approval_orphaned';
}

export interface BackgroundTaskWatchdogView {
  id: string;
  title?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  maxMinutes?: number;
  pendingApprovalId?: string;
}

/**
 * Pure: find background tasks that have gone silent. No I/O, no clock dependency
 * (caller passes `now`). Exported for tests.
 *
 * - running_stalled: status running/pending and past its own deadline
 *   (maxMinutes budget, or a 30-min floor) + grace — i.e. it should have
 *   finished or failed by now but never did.
 * - terminal_undelivered: a done/blocked/failed task whose notification the
 *   `reportedBackTaskIds` set says never reached the user.
 */
export function findStalledBackgroundTasks(
  tasks: BackgroundTaskWatchdogView[],
  now: number,
  reportedBackTaskIds: Set<string>,
  opts: {
    runningStallFloorMs?: number;
    terminalUndeliveredStallMs?: number;
    terminalUndeliveredMaxMs?: number;
  } = {},
  // Approval ids the approval store has RESOLVED (any non-pending status). When
  // provided, a task stuck in awaiting_approval whose pendingApprovalId is in this
  // set is ORPHANED — the approval was decided but no path advanced the task (its
  // only exit, queueBackgroundTaskApprovalResolution, is interactive-only). An id
  // NOT in this set is left alone (still pending, or belongs to another store) so
  // a legitimately-waiting task is never false-flagged.
  resolvedApprovalIds?: Set<string>,
): StalledBackgroundTask[] {
  const floor = opts.runningStallFloorMs ?? DEFAULT_RUNNING_STALL_MS;
  const terminalStall = opts.terminalUndeliveredStallMs ?? DEFAULT_TERMINAL_UNDELIVERED_STALL_MS;
  const terminalMax = opts.terminalUndeliveredMaxMs ?? DEFAULT_TERMINAL_UNDELIVERED_MAX_MS;
  const out: StalledBackgroundTask[] = [];

  for (const task of tasks) {
    const status = task.status ?? 'pending';
    if (status === 'running' || status === 'pending') {
      // Measure from the MOST RECENT activity (updatedAt is bumped by every
      // check-in / update), so an actively-progressing task never false-positives;
      // fall back to started/created for a task that never updated.
      const ref = task.updatedAt ?? task.startedAt ?? task.createdAt;
      const refMs = ref ? Date.parse(ref) : Number.NaN;
      if (!Number.isFinite(refMs)) continue;
      const budgetMs = typeof task.maxMinutes === 'number' && task.maxMinutes > 0
        ? task.maxMinutes * 60_000
        : 0;
      const threshold = Math.max(floor, budgetMs) + RUNNING_GRACE_MS;
      const ageMs = now - refMs;
      if (ageMs >= threshold) {
        out.push({ id: task.id, title: task.title ?? task.id, ageMs, reason: 'running_stalled' });
      }
    } else if (TERMINAL_REPORTING_STATUSES.has(status as BackgroundTaskStatusLike) && !reportedBackTaskIds.has(task.id)) {
      const ref = task.completedAt ?? task.updatedAt;
      const refMs = ref ? Date.parse(ref) : Number.NaN;
      if (!Number.isFinite(refMs)) continue;
      const ageMs = now - refMs;
      if (ageMs >= terminalStall && ageMs <= terminalMax) {
        out.push({ id: task.id, title: task.title ?? task.id, ageMs, reason: 'terminal_undelivered' });
      }
    } else if (status === 'awaiting_approval' && resolvedApprovalIds && task.pendingApprovalId
      && resolvedApprovalIds.has(task.pendingApprovalId)) {
      // Orphaned: the approval was RESOLVED in the store but the task never left
      // awaiting_approval (the resolution→advance path didn't fire, or the approval
      // was swept). A small grace avoids racing an in-flight resolution.
      const ref = task.updatedAt ?? task.startedAt ?? task.createdAt;
      const refMs = ref ? Date.parse(ref) : Number.NaN;
      if (!Number.isFinite(refMs)) continue;
      const ageMs = now - refMs;
      if (ageMs >= terminalStall) {
        out.push({ id: task.id, title: task.title ?? task.id, ageMs, reason: 'approval_orphaned' });
      }
    }
  }
  return out;
}

/**
 * Pure: which background-task ids have a DELIVERED user notification in this log.
 * A notification counts only if it was actually delivered (deliveredAt set or a
 * non-empty deliveredDestinations) — a silent/dashboard-only record must not
 * mask a real report-back failure. Excludes the watchdog's own stall alerts.
 * Exported for tests.
 */
export function reportedBackTaskIdsFrom(
  notifications: Array<{ id?: string; deliveredAt?: string; deliveredDestinations?: string[]; metadata?: Record<string, unknown> }>,
): Set<string> {
  const out = new Set<string>();
  for (const n of notifications) {
    if (typeof n.id === 'string' && n.id.startsWith('bgtask-stalled-')) continue;
    const delivered = Boolean(n.deliveredAt) || (Array.isArray(n.deliveredDestinations) && n.deliveredDestinations.length > 0);
    if (!delivered) continue;
    const id = n.metadata?.backgroundTaskId;
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

function isEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BACKGROUND_TASK_WATCHDOG', 'on') ?? 'on').toLowerCase() !== 'off';
}

function alertFor(task: StalledBackgroundTask, minutes: number): { title: string; body: string } {
  if (task.reason === 'approval_orphaned') {
    return {
      title: `Background task stuck awaiting an approval that's already resolved: ${task.title}`,
      body:
        `Task \`${task.id}\` ("${task.title}") has been paused on approval for ${minutes} min, but that approval is no longer pending `
        + `(it was decided or expired without advancing the task). Re-run it, or re-issue the approval from Console → Activity.`,
    };
  }
  if (task.reason === 'terminal_undelivered') {
    return {
      title: `Background task finished but its result wasn't delivered: ${task.title}`,
      body:
        `Task \`${task.id}\` ("${task.title}") finished ${minutes} min ago but never reported back `
        + `(the notification was lost — likely a restart mid-finish). Open Console → Activity to see the result.`,
    };
  }
  return {
    title: `Background task may be stuck: ${task.title}`,
    body:
      `Task \`${task.id}\` ("${task.title}") has been running ${minutes} min with no progress and past its time budget — `
      + `it likely died (a restart or crash) without reporting back. Open Console → Activity, or re-run it.`,
  };
}

/**
 * Scan the background-task store and notify (once, deduped) for each silent
 * task. Safe to call on a timer — addNotification dedupes by id. Never throws
 * into the caller (the daemon timer wraps it too).
 */
export function runBackgroundTaskWatchdog(now: number = Date.now()): { stalled: number } {
  if (!isEnabled()) return { stalled: 0 };
  let tasks: BackgroundTaskRecord[];
  try {
    tasks = listBackgroundTasks();
  } catch {
    return { stalled: 0 };
  }
  let reportedBack: Set<string>;
  try {
    reportedBack = reportedBackTaskIdsFrom(loadNotifications());
  } catch {
    reportedBack = new Set<string>();
  }
  // Approval ids the store has RESOLVED (any non-pending status) — lets the
  // watchdog spot a background task orphaned on an already-decided approval.
  // Best-effort: a store read failure just disables the orphan check this tick.
  let resolvedApprovalIds: Set<string> | undefined;
  try {
    resolvedApprovalIds = new Set(
      new ApprovalStore().listAll().filter((a) => a.status !== 'pending').map((a) => a.id),
    );
  } catch {
    resolvedApprovalIds = undefined;
  }

  const stalled = findStalledBackgroundTasks(tasks, now, reportedBack, {}, resolvedApprovalIds);
  for (const task of stalled) {
    const minutes = Math.max(1, Math.round(task.ageMs / 60_000));
    const alert = alertFor(task, minutes);
    addNotification({
      // Stable id → exactly one alert per stuck task per reason.
      id: `bgtask-stalled-${task.reason}-${task.id}`,
      kind: 'execution',
      title: alert.title,
      body: alert.body,
      createdAt: new Date(now).toISOString(),
      read: false,
      metadata: { backgroundTaskId: task.id, stalled: true, reason: task.reason, ageMs: task.ageMs },
    });
  }
  if (stalled.length > 0) {
    logger.warn({ stalled: stalled.length, ids: stalled.map((s) => s.id) }, 'Background tasks went silent');
  }
  return { stalled: stalled.length };
}
