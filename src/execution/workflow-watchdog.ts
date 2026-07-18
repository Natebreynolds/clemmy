import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { latestEventAtForSessionPrefix } from '../runtime/harness/eventlog.js';
import {
  attemptWorkflowRunReportBack,
  workflowRunReportBackNeedsRetry,
  workflowRunReportBackRetryDue,
  type WorkflowRunReportBackEnvelope,
  type WorkflowRunReportBackRetryState,
} from './workflow-run-report-back.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';

/**
 * Workflow watchdog (north star: REPORTS BACK WITHOUT FAIL).
 *
 * The failure mode this exists for: a run sits at `status: queued` and
 * never starts because the daemon's serial loop is starved (a long step
 * or a parked approval upstream occupies the tick). The running-run
 * heartbeat can't help — it only fires AFTER a run is picked up. So a
 * queued-but-never-drained run is completely silent, and the user is
 * left "stuck" with no signal (observed 2026-05-28: five proposal-audit
 * runs queued, none drained, no notification).
 *
 * The watchdog scans the run queue independently of the main loop and
 * emits ONE deduped notification per stuck run, with a recovery action.
 * It only observes — it never mutates run state — so it can't regress
 * execution. Runs on its own daemon timer for the same reason the runs
 * get starved: it must fire even when the main loop is blocked.
 */

const logger = pino({ name: 'clementine-next.workflow-watchdog' });

/** A run created more than this long ago and still `queued` is stalled. */
const DEFAULT_QUEUED_STALL_MS = 5 * 60_000;
/**
 * A run `parked` on a human approval longer than this is surfaced. This is the
 * orphan safety net: if WORKFLOW_APPROVAL_PARKING is turned OFF while a run is
 * parked, that run is non-drainable, non-reaped, and non-resumable, so without
 * this it would sit silent forever. 1h is long enough not to nag during a
 * normal approval wait (the approval card already fired); dedup is per run id.
 */
const DEFAULT_PARKED_STALL_MS = 60 * 60_000;
/**
 * A run that reached a terminal status (completed/error) but never got its
 * `notifiedAt` marker is a silent report-back failure — the process crashed
 * between the status write and the notify, or addNotification threw. Surface
 * it once the marker has had time to land (terminal + notify happen in the
 * same synchronous tick, so a few minutes is ample).
 */
const DEFAULT_TERMINAL_UNNOTIFIED_STALL_MS = 3 * 60_000;
/**
 * Upper bound on the terminal-unnotified window. Runs that finished longer ago
 * than this are not flagged — this is purely to avoid alerting on the entire
 * historical backlog of pre-marker runs the first time this code ships (those
 * legacy records have no `notifiedAt` but were already reported back at the
 * time). Dedup makes each alert one-shot regardless.
 */
const DEFAULT_TERMINAL_UNNOTIFIED_MAX_MS = 12 * 60 * 60_000;

// 'cancelled' is terminal too: a cancelled run that lost its notification
// (crash window, or a run cancelled while still queued) would otherwise never
// be backstopped — the terminal_unnotified check only looks at this set. The
// 12h MAX window + report-back dedup keep this from alerting on the historical
// cancel backlog or on cancels that did notify.
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'failed', 'cancelled']);

export interface WatchdogRunView {
  id: string;
  workflow: string;
  status?: string;
  createdAt?: string;
  /** ISO time the run was checkpointed as parked (run.parked.parkedAt). */
  parkedAt?: string;
  /** ISO time the run reached a terminal status. */
  finishedAt?: string;
  /** ISO time the terminal user notification was delivered (report-back marker). */
  notifiedAt?: string;
  reportBack?: WorkflowRunReportBackEnvelope;
  reportBackRetry?: WorkflowRunReportBackRetryState;
  /** Caller-populated aggregate: a delivery failed or a late origin sidecar has
   * not reached the durable acknowledgement generation yet. */
  reportBackPending?: boolean;
  /** Newest harness event across the run's step sessions (caller-populated
   *  for status='running' runs). Drives silent-running detection. */
  lastActivityAt?: string;
}

export interface StalledRun {
  id: string;
  workflow: string;
  ageMs: number;
  reason: 'queued_not_draining' | 'parked_awaiting_approval' | 'terminal_unnotified' | 'running_silent';
  reportBackPending?: boolean;
}

export interface WorkflowRecommendedRecovery {
  action: 'open_tasks' | 'approve_or_reject' | 'cancel_and_resume' | 'open_result';
  label: string;
  detail: string;
  href: string;
}

/**
 * Pure: given the run records, find the ones stuck `queued` past the
 * threshold. Exported for tests — no I/O, no clock dependency (caller
 * passes `now`).
 */
const DEFAULT_RUNNING_SILENT_STALL_MS = 10 * 60_000; // 10 min with zero step events

export function findStalledRuns(
  runs: WatchdogRunView[],
  now: number,
  opts: { queuedStallMs: number; parkedStallMs?: number; terminalUnnotifiedStallMs?: number; terminalUnnotifiedMaxMs?: number; runningSilentStallMs?: number },
): StalledRun[] {
  const parkedStallMs = opts.parkedStallMs ?? DEFAULT_PARKED_STALL_MS;
  const terminalStallMs = opts.terminalUnnotifiedStallMs ?? DEFAULT_TERMINAL_UNNOTIFIED_STALL_MS;
  const terminalMaxMs = opts.terminalUnnotifiedMaxMs ?? DEFAULT_TERMINAL_UNNOTIFIED_MAX_MS;
  const out: StalledRun[] = [];
  for (const run of runs) {
    const status = run.status ?? 'queued';
    if (status === 'queued') {
      const created = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
      if (!Number.isFinite(created)) continue;
      const ageMs = now - created;
      if (ageMs >= opts.queuedStallMs) {
        out.push({ id: run.id, workflow: run.workflow, ageMs, reason: 'queued_not_draining' });
      }
    } else if (status === 'running') {
      // Silent-running detection (turn-stall fix layer 3, 2026-06-11): a
      // 'running' run whose step sessions have emitted NOTHING for a long
      // window is wedged, not working — two live incidents sat invisible
      // for hours. The stream-stall watchdog (loop.ts) should abort these
      // first; this is the user-facing net if anything else ever wedges.
      const silentMs = opts.runningSilentStallMs ?? DEFAULT_RUNNING_SILENT_STALL_MS;
      const ref = run.lastActivityAt ?? run.createdAt;
      const last = ref ? Date.parse(ref) : Number.NaN;
      if (!Number.isFinite(last)) continue;
      const ageMs = now - last;
      if (ageMs >= silentMs) {
        out.push({ id: run.id, workflow: run.workflow, ageMs, reason: 'running_silent' });
      }
    } else if (status === 'parked') {
      // Age from parkedAt (when it actually parked), not createdAt — a run that
      // parked recently shouldn't fire just because it was created long ago.
      // Falls back to createdAt for legacy records with no parkedAt.
      const ref = run.parkedAt ?? run.createdAt;
      const parkedAt = ref ? Date.parse(ref) : Number.NaN;
      if (!Number.isFinite(parkedAt)) continue;
      const ageMs = now - parkedAt;
      if (ageMs >= parkedStallMs) {
        out.push({ id: run.id, workflow: run.workflow, ageMs, reason: 'parked_awaiting_approval' });
      }
    } else if (TERMINAL_STATUSES.has(status) && (!run.notifiedAt || run.reportBackPending === true)) {
      // Reached terminal but the report-back marker never landed — the notify
      // crashed or was lost. Surface it inside a bounded window (see constants).
      const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
      if (!Number.isFinite(finished)) continue;
      const ageMs = now - finished;
      if (ageMs >= terminalStallMs && ageMs <= terminalMaxMs) {
        out.push({
          id: run.id,
          workflow: run.workflow,
          ageMs,
          reason: 'terminal_unnotified',
          ...(run.reportBackPending === true ? { reportBackPending: true } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Ground-truth report-back filter (pure).
 *
 * A `terminal_unnotified` candidate is only a real "lost result" if the run
 * genuinely never reported back. The `notifiedAt` marker on the run file is a
 * fast cache, but it can be ABSENT for a run that DID report back — e.g. a run
 * completed + notified under a prior code version that predates the marker, or
 * a daemon restart across the finish boundary. The durable source of truth is
 * the notification log: if any non-watchdog notification carries this run's
 * `runId`, the user already heard about it.
 *
 * So: given the set of runIds that have a delivered (non-watchdog) notification,
 * drop the `terminal_unnotified` candidates that are in it. The other two
 * reasons (queued_not_draining, parked_awaiting_approval) are about runs that
 * have NOT finished, so they pass through untouched.
 */
export function dropReportedBackTerminalRuns(
  stalled: StalledRun[],
  reportedBackRunIds: Set<string>,
): StalledRun[] {
  return stalled.filter(
    (run) => !(
      run.reason === 'terminal_unnotified'
      && run.reportBackPending !== true
      && reportedBackRunIds.has(run.id)
    ),
  );
}

export function recommendedRecoveryForStalledRun(
  run: Pick<StalledRun, 'id' | 'workflow' | 'reason'>,
): WorkflowRecommendedRecovery {
  switch (run.reason) {
    case 'parked_awaiting_approval':
      return {
        action: 'approve_or_reject',
        label: 'Review approval',
        detail: 'Approve or reject the parked step from Tasks; the workflow runner will resume from the approval checkpoint.',
        href: '/tasks',
      };
    case 'running_silent':
      return {
        action: 'cancel_and_resume',
        label: 'Cancel and resume safely',
        detail: 'Cancel the silent run, then continue it from Tasks; completed workflow items stay cached so Clementine avoids duplicating work.',
        href: '/tasks',
      };
    case 'terminal_unnotified':
      return {
        action: 'open_result',
        label: 'Open result',
        detail: 'Open Tasks to inspect the terminal run result and confirm the user-visible report-back state.',
        href: '/tasks',
      };
    case 'queued_not_draining':
    default:
      return {
        action: 'open_tasks',
        label: 'Open Tasks',
        detail: 'Open Tasks to start or reprioritize the queued run; restart the daemon if the queue still does not drain.',
        href: '/tasks',
      };
  }
}

/**
 * Read the notification log and collect every runId that has a DELIVERED
 * notification — i.e. one the user actually saw. We exclude the watchdog's own
 * `workflow-stalled-*` alerts (those reference a runId but are NOT the run
 * reporting back). Best-effort: a corrupt/missing log yields an empty set, so
 * the watchdog falls back to the marker alone (prior behavior).
 */
/** Pure: which runIds have a DELIVERED user notification in this log. Exported
 *  for tests. A notification counts ONLY if it was actually delivered
 *  (deliveredAt set or a non-empty deliveredDestinations) — a silent /
 *  dashboard-only / never-delivered record (e.g. the runner's silenced
 *  completion echo) must NOT mask a real report-back failure. Accepts BOTH
 *  metadata.runId (the runner echo) and metadata.workflowRunId (a step's own
 *  notify_user card), so a self-notifying run whose step delivered is correctly
 *  counted while a silenced-but-undelivered echo is not. */
export function reportedBackRunIdsFrom(
  notifications: Array<{ id?: string; deliveredAt?: string; deliveredDestinations?: string[]; metadata?: Record<string, unknown> }>,
): Set<string> {
  const out = new Set<string>();
  for (const n of notifications) {
    // Exclude LIFECYCLE / non-outcome records that reference a runId but are NOT
    // the run reporting its terminal result: the watchdog's own stalled alert,
    // the "still running" heartbeat, and the parked approval / recovery card.
    // Otherwise a delivered heartbeat or approval card would mask a genuinely
    // lost completion notification (the exact silent loss this backstop exists
    // to catch).
    if (typeof n.id === 'string' && (
      n.id.startsWith('workflow-stalled-') ||
      n.id.startsWith('workflow-heartbeat-') ||
      n.id.startsWith('approval-')
    )) continue;
    if (n.metadata?.heartbeat === true) continue;
    const delivered = Boolean(n.deliveredAt) || (Array.isArray(n.deliveredDestinations) && n.deliveredDestinations.length > 0);
    if (!delivered) continue;
    for (const key of ['runId', 'workflowRunId'] as const) {
      const id = n.metadata?.[key];
      if (typeof id === 'string' && id) out.add(id);
    }
  }
  return out;
}

/** Runs whose exact stable terminal card is already durable in the dashboard
 * notification store. This is deliberately separate from external-delivery
 * truth: a crash can occur after addNotification's atomic write but before the
 * run's `notifiedAt` marker, including for intentionally silent/dashboard-only
 * results. Lifecycle cards never qualify. */
export function terminalDashboardNotificationRunIdsFrom(
  notifications: Array<{ id?: string; metadata?: Record<string, unknown> }>,
): Set<string> {
  const terminalSuffixes = new Set([
    'not-found',
    'dryrun',
    'creationtest',
    'disabled',
    'preflight',
    'missing-inputs',
    'goalretry',
    'selfheal',
    'completed',
    'cancelled',
    'error',
  ]);
  const out = new Set<string>();
  for (const notification of notifications) {
    const runId = notification.metadata?.runId;
    if (typeof runId !== 'string' || !runId) continue;
    if (typeof notification.id !== 'string') continue;
    const prefix = `workflow-${runId}-`;
    if (!notification.id.startsWith(prefix)) continue;
    if (terminalSuffixes.has(notification.id.slice(prefix.length))) out.add(runId);
  }
  return out;
}

/** Stable watchdog ids already present in the durable notification store. The
 * notification writer dedupes these too, but checking up front avoids parsing
 * the same ~1 MB store again for every stalled run and avoids logging the same
 * already-surfaced warning once per minute forever. */
export function workflowWatchdogAlertIdsFrom(
  notifications: Array<{ id?: string }>,
): Set<string> {
  return new Set(
    notifications
      .map((notification) => notification.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('workflow-stalled-')),
  );
}

/**
 * Self-heal: stamp `notifiedAt` on a run file we've confirmed reported back via
 * the notification log, so subsequent scans skip it via the fast marker (no
 * re-read of the log) and it stays correct even if the log is later pruned.
 * Best-effort — never throws into the watchdog.
 */
function stampNotifiedAt(runId: string, now: number): void {
  try {
    const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!existsSync(file)) return;
    withWorkflowRunRecordLock(file, () => {
      const rec = readWorkflowRunRecordUnlocked<Record<string, unknown> & { notifiedAt?: string }>(file);
      if (!rec || rec.notifiedAt) return;
      writeWorkflowRunRecordDurablyUnlocked(file, { ...rec, notifiedAt: new Date(now).toISOString() });
    });
  } catch {
    // Best-effort — a write failure just means we re-check the log next tick.
  }
}

function isEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKFLOW_WATCHDOG', 'on') ?? 'on').toLowerCase() !== 'off';
}

function queuedStallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_WORKFLOW_QUEUED_STALL_MS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUEUED_STALL_MS;
}

function parkedStallMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_WORKFLOW_PARKED_STALL_MS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PARKED_STALL_MS;
}

/** Reason-specific alert copy for a stalled run. */
function watchdogAlert(run: StalledRun, minutes: number): { title: string; body: string } {
  if (run.reason === 'running_silent') {
    return {
      title: `Workflow looks wedged: ${run.workflow}`,
      body: `Run ${run.id} has been "running" with zero activity for ${minutes}m — no model output, no tool calls. It is almost certainly stuck, not working. Cancel and re-run it (completed steps resume from cache), or ask me to investigate.`,
    };
  }
  switch (run.reason) {
    case 'parked_awaiting_approval':
      return {
        title: `Workflow waiting on approval: ${run.workflow}`,
        body:
          `Run \`${run.id}\` for **${run.workflow}** has been parked on an approval for ${minutes} min. ` +
          `Approve or decline it in Console → Activity, or it will keep waiting.`,
      };
    case 'terminal_unnotified':
      return {
        title: `Workflow finished but its result wasn't delivered: ${run.workflow}`,
        body:
          `Run \`${run.id}\` for **${run.workflow}** reached a terminal state ${minutes} min ago but never reported back ` +
          `(the notification was lost — likely a restart mid-finish). Open Console → Activity to see the result.`,
      };
    case 'queued_not_draining':
    default:
      return {
        title: `Workflow stuck in queue: ${run.workflow}`,
        body:
          `Run \`${run.id}\` for **${run.workflow}** has been queued ${minutes} min without starting — the run queue isn't draining. ` +
          `Likely the workflow is disabled, or the daemon is busy/stuck on another run. ` +
          `Open Console → Activity to check, or restart Clementine to drain the queue.`,
      };
  }
}

/**
 * Scan the run queue and notify (once, deduped) for each run stuck
 * `queued`. Safe to call on a timer — `addNotification` dedupes by id,
 * so a still-stuck run produces exactly one alert. Never throws into the
 * caller; the daemon timer wraps it too.
 */
export function runWorkflowWatchdog(now: number = Date.now()): { stalled: number } {
  if (!isEnabled() || !existsSync(WORKFLOW_RUNS_DIR)) return { stalled: 0 };

  const runs: WatchdogRunView[] = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    try {
      let parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as WatchdogRunView;
      if (!parsed || typeof parsed.id !== 'string') continue;
      // Retry the exact durable terminal report independently of the main run
      // drain. This timer continues to make progress even when a long workflow
      // occupies the drain, and idempotent duplicates count as acknowledgements.
      if (
        parsed.reportBack
        && workflowRunReportBackNeedsRetry(parsed)
        && workflowRunReportBackRetryDue(parsed, now)
      ) {
        attemptWorkflowRunReportBack(filePath, now);
        parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as WatchdogRunView;
      }
      parsed.reportBackPending = parsed.reportBack
        ? workflowRunReportBackNeedsRetry(parsed)
        : false;
      runs.push(parsed);
    } catch {
      // A malformed run file is its own (separate) problem; skip it.
    }
  }

  // Populate lastActivityAt for running runs from the harness event log —
  // a run's step sessions are 'workflow:<runId>:<stepId>'.
  for (const run of runs) {
    if ((run.status ?? 'queued') !== 'running') continue;
    try {
      run.lastActivityAt = latestEventAtForSessionPrefix(`workflow:${run.id}:`) ?? run.lastActivityAt;
    } catch { /* watchdog must never throw on a read */ }
  }

  const candidates = findStalledRuns(runs, now, { queuedStallMs: queuedStallMs(), parkedStallMs: parkedStallMs() });

  let notifications: ReturnType<typeof loadNotifications> = [];
  try { notifications = loadNotifications(); } catch { /* empty state is safe */ }

  // Ground-truth report-back check: a terminal run that already has a delivered
  // notification DID report back — drop it (and self-heal the marker) so the
  // backstop never fires a false "result wasn't delivered" alarm for a run that
  // finished under a prior code version or across a restart boundary.
  const reportedBack = reportedBackRunIdsFrom(notifications);
  const dashboardNotified = terminalDashboardNotificationRunIdsFrom(notifications);
  const durablyNotified = new Set([...reportedBack, ...dashboardNotified]);
  const existingAlertIds = workflowWatchdogAlertIdsFrom(notifications);
  const stalled = dropReportedBackTerminalRuns(candidates, durablyNotified);
  for (const run of candidates) {
    if (run.reason === 'terminal_unnotified' && run.reportBackPending !== true && durablyNotified.has(run.id)) {
      stampNotifiedAt(run.id, now);
    }
  }

  const surfaced: string[] = [];
  for (const run of stalled) {
    const minutes = Math.max(1, Math.round(run.ageMs / 60_000));
    const alert = watchdogAlert(run, minutes);
    const alertId = run.reason === 'terminal_unnotified'
      ? `workflow-stalled-terminal-${run.id}`
      : `workflow-stalled-${run.id}`;
    if (existingAlertIds.has(alertId)) continue;
    addNotification({
      // Stable id → dedupes to one alert per stuck run. The two pre-existing
      // reasons (queued_not_draining, parked_awaiting_approval) keep the
      // original `workflow-stalled-<id>` key so this change does NOT re-fire
      // alerts already delivered to deployed users. Only the NEW
      // terminal_unnotified reason gets its own namespace (a run can be parked
      // and later finish unnotified — distinct, both worth surfacing).
      id: alertId,
      kind: 'workflow',
      title: alert.title,
      body: alert.body,
      createdAt: new Date(now).toISOString(),
      read: false,
      metadata: {
        workflow: run.workflow,
        runId: run.id,
        stalled: true,
        reason: run.reason,
        ageMs: run.ageMs,
        recommendedRecovery: recommendedRecoveryForStalledRun(run),
      },
    });
    existingAlertIds.add(alertId);
    surfaced.push(run.id);
  }

  if (surfaced.length > 0) {
    logger.warn({ stalled: surfaced.length, repeatSuppressed: stalled.length - surfaced.length, ids: surfaced }, 'Workflow runs stuck in queue');
  }
  return { stalled: stalled.length };
}
