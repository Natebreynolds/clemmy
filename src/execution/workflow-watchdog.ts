import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { addNotification } from '../runtime/notifications.js';

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

const TERMINAL_STATUSES = new Set(['completed', 'error']);

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
}

export interface StalledRun {
  id: string;
  workflow: string;
  ageMs: number;
  reason: 'queued_not_draining' | 'parked_awaiting_approval' | 'terminal_unnotified';
}

/**
 * Pure: given the run records, find the ones stuck `queued` past the
 * threshold. Exported for tests — no I/O, no clock dependency (caller
 * passes `now`).
 */
export function findStalledRuns(
  runs: WatchdogRunView[],
  now: number,
  opts: { queuedStallMs: number; parkedStallMs?: number; terminalUnnotifiedStallMs?: number; terminalUnnotifiedMaxMs?: number },
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
    } else if (TERMINAL_STATUSES.has(status) && !run.notifiedAt) {
      // Reached terminal but the report-back marker never landed — the notify
      // crashed or was lost. Surface it inside a bounded window (see constants).
      const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
      if (!Number.isFinite(finished)) continue;
      const ageMs = now - finished;
      if (ageMs >= terminalStallMs && ageMs <= terminalMaxMs) {
        out.push({ id: run.id, workflow: run.workflow, ageMs, reason: 'terminal_unnotified' });
      }
    }
  }
  return out;
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
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as WatchdogRunView;
      if (parsed && typeof parsed.id === 'string') runs.push(parsed);
    } catch {
      // A malformed run file is its own (separate) problem; skip it.
    }
  }

  const stalled = findStalledRuns(runs, now, { queuedStallMs: queuedStallMs(), parkedStallMs: parkedStallMs() });
  for (const run of stalled) {
    const minutes = Math.max(1, Math.round(run.ageMs / 60_000));
    const alert = watchdogAlert(run, minutes);
    addNotification({
      // Stable id → dedupes to one alert per stuck run. The two pre-existing
      // reasons (queued_not_draining, parked_awaiting_approval) keep the
      // original `workflow-stalled-<id>` key so this change does NOT re-fire
      // alerts already delivered to deployed users. Only the NEW
      // terminal_unnotified reason gets its own namespace (a run can be parked
      // and later finish unnotified — distinct, both worth surfacing).
      id: run.reason === 'terminal_unnotified'
        ? `workflow-stalled-terminal-${run.id}`
        : `workflow-stalled-${run.id}`,
      kind: 'workflow',
      title: alert.title,
      body: alert.body,
      createdAt: new Date(now).toISOString(),
      read: false,
      metadata: { workflow: run.workflow, runId: run.id, stalled: true, reason: run.reason, ageMs: run.ageMs },
    });
  }

  if (stalled.length > 0) {
    logger.warn({ stalled: stalled.length, ids: stalled.map((s) => s.id) }, 'Workflow runs stuck in queue');
  }
  return { stalled: stalled.length };
}
