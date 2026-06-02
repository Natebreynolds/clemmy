import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR, ensureDir } from '../tools/shared.js';
import { listWorkflows } from '../memory/workflow-store.js';

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
 *     current minute, writes a queued run record into WORKFLOW_RUNS_DIR
 *   - Dedupes by per-workflow minute-key so a daemon that ticks twice
 *     in the same minute doesn't double-fire
 *   - The existing `processWorkflowRuns` picks the queued run up on the
 *     next tick and executes it through the normal workflow runner
 *
 * Coordination contract: this module ONLY appends queued-run files. It
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
  return { lastRunByMinute: next };
}

function saveScheduleState(state: ScheduleState): void {
  ensureDir(path.dirname(SCHEDULE_STATE_FILE));
  const pruned = pruneScheduleState(state);
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(pruned, null, 2), 'utf-8');
  state.lastRunByMinute = pruned.lastRunByMinute;
}

// ── Cron matching (intentionally identical semantics to the daemon's
// cron path so users can move expressions between them without
// surprises). ─────────────────────────────────────────────────────────

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

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
  let stateDirty = false;

  for (const entry of workflows) {
    const wf = entry.data;
    if (!wf.enabled) continue;
    const schedule = wf.trigger?.schedule;
    if (!schedule || typeof schedule !== 'string') continue;
    if (!cronMatches(schedule, now, wf.trigger?.timezone)) continue;

    const dedupeKey = `wf:${wf.name}`;
    if (state.lastRunByMinute[dedupeKey] === minuteKey) {
      result.deduped.push(wf.name);
      continue;
    }

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
      // Mark this minute "seen" so we don't recheck the same minute
      // on the next 15s tick.
      state.lastRunByMinute[dedupeKey] = minuteKey;
      stateDirty = true;
      continue;
    }

    try {
      enqueueScheduledRun(wf.name);
      state.lastRunByMinute[dedupeKey] = minuteKey;
      stateDirty = true;
      result.fired.push(wf.name);
      logger.info({ workflow: wf.name, schedule, minuteKey }, 'Scheduled workflow run enqueued');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), workflow: wf.name },
        'Failed to enqueue scheduled workflow run',
      );
    }
  }

  if (stateDirty) saveScheduleState(state);
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

function enqueueScheduledRun(workflowName: string): void {
  ensureDir(WORKFLOW_RUNS_DIR);
  const id = `sched-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  const record = {
    id,
    workflow: workflowName,
    status: 'queued',
    createdAt: new Date().toISOString(),
    source: 'schedule',
  };
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
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
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'cancelled']);

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
      const raw = JSON.parse(readFileSync(full, 'utf-8')) as { status?: string; finishedAt?: string };
      if (!raw.status || !TERMINAL_STATUSES.has(raw.status)) continue;
      // Prefer finishedAt; fall back to file mtime if absent (older records).
      const finishedMs = raw.finishedAt ? Date.parse(raw.finishedAt) : NaN;
      const ageRef = Number.isFinite(finishedMs) ? finishedMs : statSync(full).mtimeMs;
      if (ageRef >= cutoffMs) continue;
      unlinkSync(full);
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
