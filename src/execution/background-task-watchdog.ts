import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { listBackgroundTasks, markBackgroundTaskFailed, staleTaskKind, STALE_TASK_AGE_MS, type BackgroundTaskRecord, type StaleTaskKind } from './background-tasks.js';
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
 * is the minimal mirror: it OBSERVES the task store and emits ONE deduped
 * notification per stuck task. Delivery-aware, exactly like the workflow
 * watchdog: a task with a delivered terminal notification is never flagged.
 *
 * One deliberate exception to observe-only (2026-07-08): a running task silent
 * past the ESCALATION window is closed as `interrupted` — observing forever
 * left zombies "running" on the board for days while this warn churned every
 * tick. See escalateAfterMs().
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

/** Escalation window (2026-07-08): a running task silent past THIS long is
 *  closed as interrupted instead of warned forever — two live zombies were
 *  warned "silent" 185 and 169 consecutive ticks while the board showed them
 *  "running" for days. Override CLEMMY_BGTASK_ESCALATE_MS; CLEMMY_BGTASK_ESCALATE=off
 *  restores observe-only. */
const DEFAULT_ESCALATE_AFTER_MS = 6 * 60 * 60_000;
function escalationEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BGTASK_ESCALATE', 'on') ?? 'on').toLowerCase() !== 'off';
}
function escalateAfterMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BGTASK_ESCALATE_MS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ESCALATE_AFTER_MS;
}

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
  const escalated: string[] = [];
  for (const task of stalled) {
    const minutes = Math.max(1, Math.round(task.ageMs / 60_000));
    // ESCALATE, don't observe forever (2026-07-08): a task silent past the
    // escalation window is dead — close it as interrupted so the board stops
    // showing it "running" for days and this warn stops churning every tick.
    // 'interrupted' keeps the boot-time auto-resume path available if the work
    // is genuinely resumable. Exception intentionally narrow: running_stalled
    // only — terminal/orphaned reasons have their own resolution paths.
    if (escalationEnabled() && task.reason === 'running_stalled' && task.ageMs >= escalateAfterMs()) {
      try {
        markBackgroundTaskFailed(
          task.id,
          `Watchdog: silent for ${minutes} min with no progress — closed as interrupted so the board reflects reality. Re-run it if the work is still needed.`,
          'interrupted',
        );
        escalated.push(task.id);
        addNotification({
          id: `bgtask-escalated-${task.id}`,
          kind: 'execution',
          title: `Closed a dead background task: ${task.title}`,
          body: `Task \`${task.id}\` ("${task.title}") was silent for ${minutes} min — it was closed as interrupted. Re-run it if the work is still needed.`,
          createdAt: new Date(now).toISOString(),
          read: false,
          metadata: { backgroundTaskId: task.id, escalated: true, ageMs: task.ageMs },
        });
        continue; // closed — no per-tick stalled alert for it anymore
      } catch { /* store write failed — fall through to the plain alert */ }
    }
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
    logger.warn({ stalled: stalled.length, escalated, ids: stalled.map((s) => s.id) }, 'Background tasks went silent');
  }
  // Proactive housekeeping: surface finished/parked tasks idle past the stale
  // threshold so the user is asked to archive them (reuses the snapshot above —
  // no extra store read).
  runStaleTaskHeartbeat(tasks, now);
  return { stalled: stalled.length };
}

/** Independent kill-switch for the stale-task nudge (distinct from the watchdog
 *  itself, though it only runs while the watchdog is enabled). */
function staleHeartbeatEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_STALE_TASK_HEARTBEAT', 'on') ?? 'on').toLowerCase() !== 'off';
}

/**
 * The heartbeat half of the auto-expire spin: surface ONE nudge listing
 * finished/parked tasks idle past the stale threshold, so the user is proactively
 * asked to archive them instead of the board silently reaping. The notification
 * id is bucketed into 7-day windows, so it re-asks at most ~once a week (not a
 * daily nag) and naturally re-asks next week if still ignored — dismissing it
 * ("keep") snoozes until the next window. Archiving from the board clears the
 * staleness. Pure but for the addNotification side effect; operates on a task
 * snapshot the caller already loaded. Exported for tests.
 */
export function runStaleTaskHeartbeat(tasks: BackgroundTaskRecord[], now: number = Date.now()): { stale: number } {
  if (!staleHeartbeatEnabled()) return { stale: 0 };
  const stale = tasks
    .map((task) => ({ task, kind: staleTaskKind(task, now) }))
    .filter((entry): entry is { task: BackgroundTaskRecord; kind: StaleTaskKind } => entry.kind !== null);
  if (stale.length === 0) return { stale: 0 };
  const parked = stale.filter((s) => s.kind === 'parked').length;
  const finished = stale.length - parked;
  const weekIndex = Math.floor(now / STALE_TASK_AGE_MS); // 7-day buckets → at most one nudge per window
  const notificationId = `bgtask-stale-prompt-${weekIndex}`;
  let alreadyNotified = false;
  try {
    alreadyNotified = loadNotifications().some((n) => n.id === notificationId);
  } catch {
    // addNotification is still authoritative; this only suppresses duplicate logs.
  }
  const preview = stale.slice(0, 5).map((s) => `• ${s.task.title}`).join('\n');
  const more = stale.length > 5 ? `\n…and ${stale.length - 5} more` : '';
  addNotification({
    id: notificationId,
    kind: 'execution',
    title: `${stale.length} old background task${stale.length > 1 ? 's' : ''} — archive them?`,
    body:
      `${stale.length} background task${stale.length > 1 ? 's have' : ' has'} been idle over a week`
      + (parked > 0 ? ` (${parked} still waiting on you, ${finished} finished)` : '')
      + `. Review & archive them on the Tasks board.\n${preview}${more}`,
    createdAt: new Date(now).toISOString(),
    read: false,
    metadata: { staleTaskPrompt: true, staleCount: stale.length, finished, parked, staleTaskIds: stale.map((s) => s.task.id) },
  });
  if (!alreadyNotified) logger.info({ stale: stale.length, finished, parked }, 'Stale background tasks surfaced for review');
  return { stale: stale.length };
}
