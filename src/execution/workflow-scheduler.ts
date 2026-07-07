import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR, ensureDir } from '../tools/shared.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { reapRunEventDir } from './workflow-events.js';
import { validateCronExpression } from '../shared/cron.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';

/**
 * Workflow scheduling tick.
 *
 * Today's reality before this module: the daemon polled CRON.md and
 * ran one-off prompts via `runCronJob`, but workflows had
 * `trigger.schedule` declared in their type and NOTHING actually
 * matched that schedule against the wall clock. Scheduled workflows
 * never fired on their own.
 *
 * What this module does (clean lane — does not touch workflow-runner.ts):
 *   - Loads every workflow (via existing workflow-store)
 *   - For each one with `enabled && trigger.schedule` matching the
 *     current minute, queues a run record through the shared workflow queue
 *   - Dedupes by per-workflow minute-key so a daemon that ticks twice
 *     in the same minute doesn't double-fire
 *   - The existing `processWorkflowRuns` picks the queued run up on the
 *     next tick and executes it through the normal workflow runner
 *
 * Coordination contract: this module ONLY queues workflow runs. It
 * does not read or mutate any in-flight run state. Any concurrent work
 * happening inside workflow-runner.ts is decoupled.
 */

const logger = pino({ name: 'clementine-next.workflow-scheduler' });

// Keep schedule state next to the cron daemon state so backup/clean-up
// happens uniformly. Format mirrors the cron path but with a `wf:`
// prefix to namespace the keys.
const SCHEDULE_STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');
const SCHEDULE_RETENTION_DAYS = 7;

interface ScheduleState {
  lastRunByMinute: Record<string, string>; // key = "wf:<name>", value = "YYYY-MM-DDTHH:MM"
  // Wall-clock minute (epoch ms, minute-floored) of the last scheduler tick.
  // Drives misfire CATCH-UP: a daemon asleep at a schedule's fire-minute (the
  // canonical laptop case) used to silently drop that run because cron was only
  // matched against `now`. We now backfill the missed window on the next tick.
  lastEvaluatedAtMs?: number;
}

function loadScheduleState(): ScheduleState {
  if (!existsSync(SCHEDULE_STATE_FILE)) return { lastRunByMinute: {} };
  try {
    return JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf-8')) as ScheduleState;
  } catch {
    return { lastRunByMinute: {} };
  }
}

function pruneScheduleState(state: ScheduleState): ScheduleState {
  const cutoff = new Date(Date.now() - SCHEDULE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.lastRunByMinute)) {
    if (v >= cutoff) next[k] = v;
  }
  return { lastRunByMinute: next, lastEvaluatedAtMs: state.lastEvaluatedAtMs };
}

function saveScheduleState(state: ScheduleState): void {
  ensureDir(path.dirname(SCHEDULE_STATE_FILE));
  const pruned = pruneScheduleState(state);
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(pruned, null, 2), 'utf-8');
  state.lastRunByMinute = pruned.lastRunByMinute;
}

/** Cap on how far back catch-up will scan (a daemon off for a week shouldn't
 *  replay 10k minutes — fire each missed schedule once within the last day). */
const MAX_CATCHUP_MINUTES = 24 * 60;

function minuteFloor(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * The wall-clock minutes to evaluate this tick: just `now` on a normal tick, or
 * the backfilled window [lastEval+1 … now] (capped) after the daemon was asleep.
 * Pure + exported for tests. First-ever tick (no lastEvaluatedAtMs) returns only
 * `now` — never a spurious backfill on first boot.
 */
export function scheduleCatchupWindow(lastEvaluatedAtMs: number | undefined, nowMs: number): Date[] {
  const nowMin = minuteFloor(nowMs);
  if (lastEvaluatedAtMs === undefined) return [new Date(nowMin)];
  let startMin = minuteFloor(lastEvaluatedAtMs) + 60_000; // minute AFTER the last evaluated one
  const earliest = nowMin - MAX_CATCHUP_MINUTES * 60_000;
  if (startMin < earliest) startMin = earliest;
  if (startMin > nowMin) return [new Date(nowMin)]; // same minute as last tick → just now
  const out: Date[] = [];
  for (let t = startMin; t <= nowMin; t += 60_000) out.push(new Date(t));
  return out;
}

// ── Cron matching (intentionally identical semantics to the daemon's
// cron path so users can move expressions between them without
// surprises). ─────────────────────────────────────────────────────────


function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

interface WallClock { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number; }

/** The wall-clock fields of `at` in an IANA timezone (default = host local, so
 *  a schedule with no timezone is byte-identical to before). Never throws — an
 *  invalid/unknown tz falls back to host local rather than breaking the tick. */
export function wallClockInZone(at: Date, tz?: string): WallClock {
  const local = (): WallClock => ({
    minute: at.getMinutes(), hour: at.getHours(), dayOfMonth: at.getDate(),
    month: at.getMonth() + 1, dayOfWeek: at.getDay(),
  });
  if (!tz) return local();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
    }).formatToParts(at);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let hour = Number.parseInt(get('hour'), 10);
    if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
    return {
      minute: Number.parseInt(get('minute'), 10),
      hour,
      dayOfMonth: Number.parseInt(get('day'), 10),
      month: Number.parseInt(get('month'), 10),
      dayOfWeek: wd[get('weekday')] ?? at.getDay(),
    };
  } catch {
    return local();
  }
}

export function cronMatches(expr: string, at: Date, tz?: string): boolean {
  if (!validateCronExpression(expr)) return false;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const wc = wallClockInZone(at, tz);
  return (
    fieldMatch(min, wc.minute) &&
    fieldMatch(hour, wc.hour) &&
    fieldMatch(dom, wc.dayOfMonth) &&
    fieldMatch(mon, wc.month) &&
    fieldMatch(dow, wc.dayOfWeek)
  );
}

function currentMinuteKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

interface ScheduledFireResult {
  /** Names of workflows that matched and got enqueued this tick. */
  fired: string[];
  /** Names that matched but were skipped because we already fired this minute. */
  deduped: string[];
}

/**
 * Daemon entry point. Idempotent within a minute. Safe to call every
 * 15s — only the first match per workflow per minute writes a run.
 */
export async function processWorkflowSchedules(): Promise<ScheduledFireResult> {
  const result: ScheduledFireResult = { fired: [], deduped: [] };
  const now = new Date();
  const minuteKey = currentMinuteKey(now);

  let workflows;
  try {
    workflows = listWorkflows();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'listWorkflows failed in scheduler');
    return result;
  }

  const state = loadScheduleState();

  // Minutes to evaluate this tick: [now] normally, or the backfilled window
  // after a sleep (misfire catch-up). On a normal 15s tick this is exactly
  // [now] → byte-identical to the prior behavior.
  const window = scheduleCatchupWindow(state.lastEvaluatedAtMs, now.getTime());

  for (const entry of workflows) {
    const wf = entry.data;
    if (!wf.enabled) continue;
    const schedule = wf.trigger?.schedule;
    if (!schedule || typeof schedule !== 'string') continue;

    const dedupeKey = `wf:${wf.name}`;
    // Cron matches in the window that we haven't already fired (dedupe by minute
    // key, in chronological order). Empty on most ticks.
    const matchedKeys: string[] = [];
    for (const m of window) {
      if (!cronMatches(schedule, m, wf.trigger?.timezone)) continue;
      const k = currentMinuteKey(m);
      if (state.lastRunByMinute[dedupeKey] !== k) matchedKeys.push(k);
    }
    if (matchedKeys.length === 0) {
      // Telemetry parity: if NOW matched but we already fired it this minute,
      // record the dedupe exactly as before.
      if (cronMatches(schedule, now, wf.trigger?.timezone) && state.lastRunByMinute[dedupeKey] === minuteKey) {
        result.deduped.push(wf.name);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'warn',
          actor: 'workflow-scheduler',
          payload: { workflowName: wf.name, schedule, reason: 'already_fired_this_minute' },
        });
      }
      continue;
    }
    const latestKey = matchedKeys[matchedKeys.length - 1];
    const missed = matchedKeys.length - 1; // earlier fires collapsed into one

    // Pending-queue cap. If the previous run hasn't finished yet and a
    // few more are already stacked, refuse to enqueue more — otherwise a
    // `*/1 * * * *` cron + a 30-min workflow would pile 60 runs/hour
    // forever and the daemon would re-read every file every tick. The
    // user gets one daily notification telling them their workflow is
    // running long and they should investigate.
    const pending = countPendingRunsFor(wf.name);
    if (pending >= MAX_PENDING_PER_WORKFLOW) {
      result.deduped.push(wf.name);
      emitQueueBackpressureNotice(wf.name, pending);
      recordOperationalEvent({
        source: 'workflow',
        type: 'workflow_trigger_deduped',
        severity: 'warn',
        actor: 'workflow-scheduler',
        payload: { workflowName: wf.name, schedule, reason: 'backpressure', pending },
      });
      // Mark the latest matched minute "seen" so we don't recheck it.
      state.lastRunByMinute[dedupeKey] = latestKey;
      continue;
    }

    try {
      // A long-missed window collapses to ONE catch-up run (not N), so a
      // daily 8am report fires once after a closed-overnight laptop reopens.
      const runId = enqueueScheduledRun(wf.name);
      state.lastRunByMinute[dedupeKey] = latestKey;
      result.fired.push(wf.name);
      recordOperationalEvent({
        source: 'workflow',
        type: 'workflow_trigger_fired',
        workflowRunId: runId,
        actor: 'workflow-scheduler',
        payload: { workflowName: wf.name, schedule, missed, source: 'schedule' },
      });
      logger.info({ workflow: wf.name, schedule, minuteKey: latestKey, missed }, 'Scheduled workflow run enqueued');
      if (missed > 0) {
        emitCatchupNotice(wf.name, missed, latestKey);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), workflow: wf.name },
        'Failed to enqueue scheduled workflow run',
      );
    }
  }

  // Always advance the evaluation pointer so the next tick's window is correct.
  state.lastEvaluatedAtMs = minuteFloor(now.getTime());
  saveScheduleState(state);
  return result;
}

/** Max queued+running run records per workflow before the scheduler
 *  backs off. Three feels right: it absorbs short bursts of slow runs
 *  without letting a single misbehaving cron carpet the disk. */
const MAX_PENDING_PER_WORKFLOW = 3;

/** Walk WORKFLOW_RUNS_DIR and count run records for `workflowName`
 *  whose status is non-terminal (queued/running/missing). Cheap because
 *  we early-out at the cap and don't parse files we don't need to. */
function countPendingRunsFor(workflowName: string): number {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return 0;
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let count = 0;
  for (const file of files) {
    if (count >= MAX_PENDING_PER_WORKFLOW + 1) return count; // we just need ">= cap"
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        workflow?: string;
        status?: string;
      };
      if (raw.workflow !== workflowName) continue;
      if (raw.status && raw.status !== 'queued' && raw.status !== 'running') continue;
      count += 1;
    } catch {
      // Unreadable record — ignore. The reaper will sweep it eventually.
    }
  }
  return count;
}

/** Daily-bucketed system notification so the user knows their schedule
 *  is firing faster than the workflow can finish. We import lazily to
 *  avoid a runtime cycle (notifications → maintenance → scheduler). */
function emitQueueBackpressureNotice(workflowName: string, pending: number): void {
  try {
    // Lazy require — avoids hoisting and any chance of a startup cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addNotification, getNotification } = require('../runtime/notifications.js') as {
      addNotification: (n: Record<string, unknown>) => void;
      getNotification: (id: string) => unknown;
    };
    const dayKey = new Date().toISOString().slice(0, 10);
    const id = `system-workflow-backpressure-${workflowName}-${dayKey}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'system',
      title: `Workflow "${workflowName}" can't keep up with its schedule`,
      body: `${pending} pending runs of this workflow are already queued; the schedule kept firing faster than the workflow finishes. The scheduler is now backing off — new fires will be skipped until the queue drains. Check workflow performance or lower the cron frequency.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'workflow_backpressure', workflow: workflowName, pending },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
      'Failed to emit backpressure notice (best-effort, ignored)',
    );
  }
}

/** Tell the user when a scheduled run fired LATE (daemon was asleep at the
 *  scheduled minute) and how many earlier fires were collapsed — so a missed
 *  schedule is never silent (reports-back). Daily-bucketed per workflow. */
function emitCatchupNotice(workflowName: string, missed: number, firedMinuteKey: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addNotification, getNotification } = require('../runtime/notifications.js') as {
      addNotification: (n: Record<string, unknown>) => void;
      getNotification: (id: string) => unknown;
    };
    const dayKey = new Date().toISOString().slice(0, 10);
    const id = `system-workflow-catchup-${workflowName}-${dayKey}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'system',
      title: `Caught up workflow "${workflowName}" after a missed schedule`,
      body: `The daemon was asleep when "${workflowName}" was scheduled to run. It ran once now (caught up)${missed > 0 ? `, skipping ${missed} earlier missed fire${missed === 1 ? '' : 's'}` : ''}. If this matters, keep the daemon running at the scheduled time.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'workflow_schedule_catchup', workflow: workflowName, missed, firedMinuteKey },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
      'Failed to emit schedule catch-up notice (best-effort, ignored)',
    );
  }
}

/** Queues the scheduled run record and returns its id (so the caller can correlate a
 *  workflow_trigger_fired telemetry event to the run it enqueued). */
function enqueueScheduledRun(workflowName: string): string {
  const queued = queueWorkflowRun(workflowName, {}, {
    source: 'schedule',
    idPrefix: 'sched',
    dedupe: false,
  });
  if (!queued.id) throw new Error(queued.message || `Scheduled workflow "${workflowName}" did not return a run id.`);
  return queued.id;
}

/**
 * Reaper for terminal workflow run records older than RETENTION days.
 * Called by the daemon on a slow tick (every ~hour) — prevents the
 * unbounded-growth scenario the audit flagged: a star-slash-1 cron over 24h would
 * leave 1440 completed run JSON files in WORKFLOW_RUNS_DIR, and
 * processWorkflowRuns re-reads every file every tick.
 *
 * Conservative: only deletes records with status in {completed, error,
 * cancelled} older than RETENTION days. Non-terminal records are never
 * touched.
 */
const RUN_RETENTION_DAYS = 7;
// creation_test / dry_run are one-shot validation runs — terminal once written, so
// they age out on the same retention window instead of lingering forever (the
// 2026-06-19 clem-smoke-flow creation_tests that piled up on the board).
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'cancelled', 'creation_test', 'dry_run']);

export function reapStaleWorkflowRuns(): { scanned: number; deleted: number } {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return { scanned: 0, deleted: 0 };
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { scanned: 0, deleted: 0 };
  }
  const cutoffMs = Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const file of files) {
    const full = path.join(WORKFLOW_RUNS_DIR, file);
    try {
      const raw = JSON.parse(readFileSync(full, 'utf-8')) as { status?: string; finishedAt?: string; workflow?: string };
      if (!raw.status || !TERMINAL_STATUSES.has(raw.status)) continue;
      // Prefer finishedAt; fall back to file mtime if absent (older records).
      const finishedMs = raw.finishedAt ? Date.parse(raw.finishedAt) : NaN;
      const ageRef = Number.isFinite(finishedMs) ? finishedMs : statSync(full).mtimeMs;
      if (ageRef >= cutoffMs) continue;
      unlinkSync(full);
      // P0-2: reap the run's events.jsonl dir together with the record so the
      // two sources of truth can't diverge (orphaned event logs that read as
      // phantom-pending / accumulate unbounded). Best-effort.
      if (raw.workflow) reapRunEventDir(raw.workflow, file.replace(/\.json$/, ''));
      deleted += 1;
    } catch {
      // Unreadable / disappeared — skip.
    }
  }
  if (deleted > 0) {
    logger.info({ deleted, scanned: files.length, retentionDays: RUN_RETENTION_DAYS }, 'Reaped stale workflow run records');
  }
  return { scanned: files.length, deleted };
}
