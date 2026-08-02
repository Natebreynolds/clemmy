import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR, ensureDir } from '../tools/shared.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { reapRunEventDir } from './workflow-events.js';
import {
  deleteWorkflowGraphSnapshotByRunId,
  loadWorkflowGraphSnapshotByRunId,
} from './workflow-graph-store.js';
import {
  isCompiledWorkflowRunDefinitionSnapshot,
  resolveWorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';
import { validateCronExpression } from '../shared/cron.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import {
  prospectiveIntentionId,
  recordProspectiveCue,
  recordProspectiveOutcome,
} from '../runtime/prospective-intentions.js';
// Static import (2026-07-20): the old lazy `require('../runtime/notifications.js')`
// was DEAD CODE in this "type":"module" package — require is undefined in ESM,
// so the backpressure, catch-up, and enqueue-failure notices silently fell into
// their catch blocks and NEVER reached the user. No cycle: notifications
// imports nothing from execution/.
import { addNotification, getNotification } from '../runtime/notifications.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';
import {
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
} from './workflow-run-record.js';
import {
  workflowRunReportBackNeedsRetry,
  type WorkflowRunReportBackRecord,
} from './workflow-run-report-back.js';
import { compiledProjectRootHasSettlementMarker } from './project-root-lifecycle.js';

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
  lastRunByMinute: Record<string, string>; // key = "wf:<stable-slug>", value = "YYYY-MM-DDTHH:MM"
  /** Canonical occurrence identity. Unlike local minute strings, epoch minutes
   *  remain strictly ordered across DST fall-back and host clock rollback. */
  lastRunAtMs: Record<string, number>;
  /** Frozen, durable work discovered before the rolling catch-up window moves
   *  on. Pending occurrences are intentionally not retention-pruned. */
  pendingByWorkflow: Record<string, PendingScheduleOccurrence>;
  // Wall-clock minute (epoch ms, minute-floored) of the last scheduler tick.
  // Drives misfire CATCH-UP: a daemon asleep at a schedule's fire-minute (the
  // canonical laptop case) used to silently drop that run because cron was only
  // matched against `now`. We now backfill the missed window on the next tick.
  lastEvaluatedAtMs?: number;
}

interface PendingScheduleOccurrence {
  /** Age used only for fair admission; unlike atMs it never advances while
   * newer missed occurrences collapse into this pending unit. */
  firstDueAtMs: number;
  atMs: number;
  minuteKey: string;
  scheduleKey: string;
  missed: number;
}

function emptyScheduleState(): ScheduleState {
  return { lastRunByMinute: {}, lastRunAtMs: {}, pendingByWorkflow: {} };
}

function loadScheduleState(): ScheduleState {
  if (!existsSync(SCHEDULE_STATE_FILE)) return emptyScheduleState();
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf-8')) as Partial<ScheduleState>;
    const lastRunByMinute: Record<string, string> =
      parsed.lastRunByMinute && typeof parsed.lastRunByMinute === 'object' && !Array.isArray(parsed.lastRunByMinute)
        ? Object.fromEntries(
          Object.entries(parsed.lastRunByMinute).filter((entry): entry is [string, string] =>
            typeof entry[1] === 'string'),
        )
        : {};
    const lastRunAtMs =
      parsed.lastRunAtMs && typeof parsed.lastRunAtMs === 'object' && !Array.isArray(parsed.lastRunAtMs)
        ? Object.fromEntries(
          Object.entries(parsed.lastRunAtMs).filter((entry): entry is [string, number] =>
            Number.isFinite(entry[1])),
        )
        : {};
    const pendingByWorkflow: Record<string, PendingScheduleOccurrence> = {};
    if (
      parsed.pendingByWorkflow
      && typeof parsed.pendingByWorkflow === 'object'
      && !Array.isArray(parsed.pendingByWorkflow)
    ) {
      for (const [key, value] of Object.entries(parsed.pendingByWorkflow)) {
        if (
          value
          && typeof value === 'object'
          && Number.isFinite(value.atMs)
          && typeof value.minuteKey === 'string'
          && typeof value.scheduleKey === 'string'
        ) {
          pendingByWorkflow[key] = {
            firstDueAtMs: Number.isFinite(value.firstDueAtMs)
              ? minuteFloor(value.firstDueAtMs)
              : minuteFloor(value.atMs),
            atMs: minuteFloor(value.atMs),
            minuteKey: value.minuteKey,
            scheduleKey: value.scheduleKey,
            missed: Number.isFinite(value.missed) && value.missed >= 0 ? Math.floor(value.missed) : 0,
          };
        }
      }
    }
    return {
      lastRunByMinute,
      lastRunAtMs,
      pendingByWorkflow,
      ...(Number.isFinite(parsed.lastEvaluatedAtMs)
        ? { lastEvaluatedAtMs: parsed.lastEvaluatedAtMs }
        : {}),
    };
  } catch (err) {
    const preserved = `${SCHEDULE_STATE_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(SCHEDULE_STATE_FILE, preserved);
      fsyncParentDirectory(SCHEDULE_STATE_FILE);
    } catch (preserveErr) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          preserveErr: preserveErr instanceof Error ? preserveErr.message : String(preserveErr),
        },
        'Workflow schedule state is corrupt and could not be preserved; scheduler is stopping fail-closed',
      );
      surfaceScheduleStateCorruption(err, undefined);
      throw preserveErr;
    }
    logger.error(
      { err: err instanceof Error ? err.message : String(err), preserved },
      'Workflow schedule state was corrupt; preserved the unreadable file and reset recovery state',
    );
    surfaceScheduleStateCorruption(err, preserved);
    return emptyScheduleState();
  }
}

function surfaceScheduleStateCorruption(err: unknown, preserved: string | undefined): void {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    addNotification({
      id: `system-workflow-schedule-state-corrupt-${dayKey}`,
      kind: 'system',
      title: 'Workflow schedule recovery state was unreadable',
      body:
        'Clementine preserved the corrupt scheduler state and restarted schedule tracking. '
        + 'A previously discovered but not-yet-queued occurrence may need review.'
        + (preserved ? ` Preserved file: ${preserved}` : ''),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        errorCategory: 'workflow_schedule_state_corrupt',
        error: err instanceof Error ? err.message : String(err),
        ...(preserved ? { preservedFile: preserved } : {}),
      },
    });
  } catch {
    // The error log remains the backstop if notification storage is unavailable.
  }
}

function fsyncParentDirectory(filePath: string): void {
  if (process.platform === 'win32') return;
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(path.dirname(filePath), 'r');
    fsyncSync(directoryFd);
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

function pruneScheduleState(state: ScheduleState): ScheduleState {
  const referenceMs = Number.isFinite(state.lastEvaluatedAtMs) ? state.lastEvaluatedAtMs! : Date.now();
  const cutoffMs = referenceMs - SCHEDULE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const legacyCutoff = new Date(cutoffMs).toISOString().slice(0, 16);
  const nextMinute: Record<string, string> = {};
  const nextEpoch: Record<string, number> = {};
  for (const [key, minuteKey] of Object.entries(state.lastRunByMinute)) {
    const epoch = state.lastRunAtMs[key];
    if ((Number.isFinite(epoch) && epoch >= cutoffMs) || (!Number.isFinite(epoch) && minuteKey >= legacyCutoff)) {
      nextMinute[key] = minuteKey;
      if (Number.isFinite(epoch)) nextEpoch[key] = epoch;
    }
  }
  return {
    lastRunByMinute: nextMinute,
    lastRunAtMs: nextEpoch,
    pendingByWorkflow: state.pendingByWorkflow,
    lastEvaluatedAtMs: state.lastEvaluatedAtMs,
  };
}

function saveScheduleState(state: ScheduleState): void {
  ensureDir(path.dirname(SCHEDULE_STATE_FILE));
  const pruned = pruneScheduleState(state);
  const tempFile = `${SCHEDULE_STATE_FILE}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let tempFd: number | undefined;
  try {
    tempFd = openSync(tempFile, 'wx', 0o600);
    writeFileSync(tempFd, JSON.stringify(pruned, null, 2), 'utf-8');
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    renameSync(tempFile, SCHEDULE_STATE_FILE);
    fsyncParentDirectory(SCHEDULE_STATE_FILE);
  } catch (err) {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch { /* best-effort descriptor cleanup */ }
    }
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch { /* best-effort temp cleanup */ }
    throw err;
  }
  state.lastRunByMinute = pruned.lastRunByMinute;
  state.lastRunAtMs = pruned.lastRunAtMs;
  state.pendingByWorkflow = pruned.pendingByWorkflow;
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
  /** Names of stale occurrences durably held before execution for a user
   *  Resume/Skip decision. A held occurrence has not run any workflow step. */
  held: string[];
  /** Stale decisions left durably pending because this tick reached the
   * bounded control-plane materialization budget. */
  deferred: string[];
  /** Names that matched but were skipped because we already fired this minute. */
  deduped: string[];
}

/**
 * Daemon entry point. Idempotent within a minute. Safe to call every
 * 15s — only the first match per workflow per minute writes a run.
 */
export async function processWorkflowSchedules(now: Date = new Date()): Promise<ScheduledFireResult> {
  const result: ScheduledFireResult = { fired: [], held: [], deferred: [], deduped: [] };
  const nowMinuteMs = minuteFloor(now.getTime());
  const minuteKey = currentMinuteKey(new Date(nowMinuteMs));

  let workflows;
  try {
    workflows = listWorkflows();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'listWorkflows failed in scheduler');
    return result;
  }

  const state = loadScheduleState();
  const window = scheduleCatchupWindow(state.lastEvaluatedAtMs, now.getTime());
  const configured = new Map<string, {
    workflowName: string;
    entryName: string;
    schedule: string;
    timezone?: string;
    scheduleKey: string;
  }>();

  // Discovery is a separate, checkpointed phase. Every due occurrence becomes
  // durable BEFORE any queue write or long-running work can interrupt the pass.
  // Advancing the rolling 24h watermark is therefore safe: held work no longer
  // depends on rewinding a scan window to remain discoverable.
  for (const entry of workflows) {
    const wf = entry.data;
    if (!wf.enabled) continue;
    const schedule = wf.trigger?.schedule;
    if (!schedule || typeof schedule !== 'string') continue;

    // The directory/entry slug is stable identity. Display names are mutable,
    // so migrate the pre-v3.0.2 display-name key before doing any discovery.
    const dedupeKey = `wf:${entry.name}`;
    migrateLegacyWorkflowScheduleKey(state, `wf:${wf.name}`, dedupeKey);
    const timezone = typeof wf.trigger?.timezone === 'string' ? wf.trigger.timezone : undefined;
    const scheduleKey = `${schedule}\u0000${timezone ?? ''}`;
    configured.set(dedupeKey, {
      workflowName: wf.name,
      entryName: entry.name,
      schedule,
      timezone,
      scheduleKey,
    });

    let pending: PendingScheduleOccurrence | undefined = state.pendingByWorkflow[dedupeKey];
    if (
      pending
      && (
        pending.scheduleKey !== scheduleKey
        || (Number.isFinite(state.lastRunAtMs[dedupeKey]) && pending.atMs <= state.lastRunAtMs[dedupeKey])
      )
    ) {
      delete state.pendingByWorkflow[dedupeKey];
      pending = undefined;
    }

    const lastFiredAtMs = state.lastRunAtMs[dedupeKey];
    const legacyLastKey = state.lastRunByMinute[dedupeKey];
    for (const m of window) {
      if (!cronMatches(schedule, m, timezone)) continue;
      const atMs = minuteFloor(m.getTime());
      const k = currentMinuteKey(m);
      // New-format records compare epoch minutes. Legacy records retain their
      // prior lexical rule until the first handled occurrence writes an epoch,
      // avoiding an upgrade-time replay while removing the rule thereafter.
      const handled = Number.isFinite(lastFiredAtMs)
        ? atMs <= lastFiredAtMs
        : legacyLastKey !== undefined && k <= legacyLastKey;
      if (handled || (pending && atMs <= pending.atMs)) continue;
      pending = {
        firstDueAtMs: pending?.firstDueAtMs ?? atMs,
        atMs,
        minuteKey: k,
        scheduleKey,
        missed: (pending?.missed ?? -1) + 1,
      };
      state.pendingByWorkflow[dedupeKey] = pending;
    }

    if (
      !pending
      && cronMatches(schedule, now, timezone)
      && (
        state.lastRunAtMs[dedupeKey] === nowMinuteMs
        || (!Number.isFinite(state.lastRunAtMs[dedupeKey]) && state.lastRunByMinute[dedupeKey] === minuteKey)
      )
    ) {
      result.deduped.push(wf.name);
      recordOperationalEvent({
        source: 'workflow',
        type: 'workflow_trigger_deduped',
        severity: 'warn',
        actor: 'workflow-scheduler',
        payload: { workflowName: wf.name, schedule, reason: 'already_fired_this_minute' },
      });
    }
  }

  // Deleted, disabled, or unscheduled workflows explicitly abandon their held
  // occurrence. A changed schedule gets a new scheduleKey and is reconciled in
  // the discovery loop above.
  for (const dedupeKey of Object.keys(state.pendingByWorkflow)) {
    if (!configured.has(dedupeKey)) delete state.pendingByWorkflow[dedupeKey];
  }
  state.lastEvaluatedAtMs = nowMinuteMs;
  saveScheduleState(state);

  const candidates = Array.from(configured.entries())
    .map(([dedupeKey, config]) => {
      const occurrence = state.pendingByWorkflow[dedupeKey];
      return occurrence ? { dedupeKey, config, occurrence } : undefined;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== undefined && candidate.occurrence.atMs <= nowMinuteMs);

  // A live-minute commitment always goes first. Stale recovery is oldest-first
  // so a recurring early config entry cannot continually starve older siblings.
  candidates.sort((a, b) => {
    const aLive = a.occurrence.atMs === nowMinuteMs ? 0 : 1;
    const bLive = b.occurrence.atMs === nowMinuteMs ? 0 : 1;
    return aLive - bLive
      || a.occurrence.firstDueAtMs - b.occurrence.firstDueAtMs
      || a.occurrence.atMs - b.occurrence.atMs
      || a.dedupeKey.localeCompare(b.dedupeKey);
  });

  let catchupHoldAttempts = 0;
  for (const { dedupeKey, config, occurrence } of candidates) {
    const { workflowName, entryName, schedule } = config;
    const latestKey = occurrence.minuteKey;
    const missed = occurrence.missed;
    const isCatchupFire = occurrence.atMs < nowMinuteMs;
    const prospectiveId = prospectiveIntentionId('workflow_schedule', workflowName);
    const prospectiveCueKey = `cron:${latestKey}`;
    try {
      recordProspectiveCue(
        prospectiveId,
        prospectiveCueKey,
        { workflowName, schedule, matchedMinute: latestKey, matchedAtMs: occurrence.atMs, missed },
        now,
      );
    } catch { /* the workflow schedule store remains authoritative */ }

    // Holding is zero model/execution work, but each durable run snapshot still
    // costs file creation + fsync. Bound that control-plane burst without
    // reviving the old one-executing-catch-up gate; the rest remain in
    // pendingByWorkflow and materialize on later ticks.
    if (isCatchupFire && catchupHoldAttempts >= MAX_CATCHUP_HOLDS_PER_TICK) {
      result.deferred.push(workflowName);
      logger.info(
        { workflow: workflowName, occurrenceAtMs: occurrence.atMs },
        'Deferred catch-up recovery-card materialization to a later scheduler tick',
      );
      continue;
    }
    if (isCatchupFire) catchupHoldAttempts += 1;

    // A stale occurrence is admitted only as zero-work held state, so existing
    // execution pressure must not hide or discard the user's Resume/Skip
    // decision. Parked/backpressure checks remain for live executable work.
    if (!isCatchupFire) {
      const activeRuns = countActiveRunsFor(workflowName);
      if (activeRuns.parked > 0) {
        result.deduped.push(workflowName);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'info',
          actor: 'workflow-scheduler',
          payload: { workflowName, schedule, reason: 'parked_awaiting_approval', parked: activeRuns.parked },
        });
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            { reason: 'parked_awaiting_approval', parked: activeRuns.parked, cueKey: prospectiveCueKey },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        continue;
      }

      // Pending-queue cap. A held stale occurrence never consumes it; resumed
      // work later enters through the ordinary bounded run lane.
      const pending = activeRuns.pending;
      if (pending >= MAX_PENDING_PER_WORKFLOW) {
        result.deduped.push(workflowName);
        emitQueueBackpressureNotice(workflowName, pending);
        recordOperationalEvent({
          source: 'workflow',
          type: 'workflow_trigger_deduped',
          severity: 'warn',
          actor: 'workflow-scheduler',
          payload: { workflowName, schedule, reason: 'backpressure', pending },
        });
        markWorkflowOccurrenceHandled(state, dedupeKey, occurrence);
        saveScheduleState(state);
        try {
          recordProspectiveOutcome(
            prospectiveId,
            'blocked',
            { reason: 'schedule_backpressure', pending, cueKey: prospectiveCueKey },
            now,
          );
        } catch { /* best-effort control-plane receipt */ }
        continue;
      }
    }

    try {
      const queued = enqueueScheduledRun(
        workflowName,
        entryName,
        occurrence.atMs,
        isCatchupFire,
        occurrence.firstDueAtMs,
        occurrence.missed + 1,
      );
      markWorkflowOccurrenceHandled(state, dedupeKey, occurrence);
      saveScheduleState(state);
      if (queued.status === 'duplicate') {
        result.deduped.push(workflowName);
      } else if (queued.status === 'held') {
        result.held.push(workflowName);
      } else {
        result.fired.push(workflowName);
      }
      recordOperationalEvent(queued.status === 'duplicate'
        ? {
            source: 'workflow',
            type: 'workflow_trigger_deduped',
            severity: 'info',
            workflowRunId: queued.id,
            actor: 'workflow-scheduler',
            payload: {
              workflowName,
              schedule,
              source: 'schedule',
              reason: 'trigger_receipt_replayed',
              occurrenceAtMs: occurrence.atMs,
              catchupFire: isCatchupFire,
            },
          }
        : isCatchupFire
          ? {
              source: 'workflow',
              type: 'workflow_catchup_held',
              workflowRunId: queued.id,
              actor: 'workflow-scheduler',
              payload: {
                workflowName,
                schedule,
                source: 'schedule',
                reason: 'awaiting_user_decision',
                firstDueAtMs: occurrence.firstDueAtMs,
                occurrenceAtMs: occurrence.atMs,
                missedCount: occurrence.missed + 1,
                queueStatus: queued.status,
              },
            }
          : {
              source: 'workflow',
              type: 'workflow_trigger_fired',
              workflowRunId: queued.id,
              actor: 'workflow-scheduler',
              payload: {
                workflowName,
                schedule,
                missed,
                source: 'schedule',
                occurrenceAtMs: occurrence.atMs,
                queueStatus: queued.status,
              },
            });
      try {
        recordProspectiveOutcome(
          prospectiveId,
          isCatchupFire ? 'blocked' : 'rearmed',
          {
            runId: queued.id,
            cueKey: prospectiveCueKey,
            missed,
            queueAccepted: true,
            ...(isCatchupFire ? { reason: 'awaiting_user_catchup_decision' } : {}),
          },
          now,
        );
      } catch { /* best-effort control-plane receipt */ }
      logger.info(
        {
          workflow: workflowName,
          schedule,
          minuteKey: latestKey,
          occurrenceAtMs: occurrence.atMs,
          missed,
          queueStatus: queued.status,
        },
        queued.status === 'duplicate'
          ? 'Scheduled workflow occurrence receipt replayed without creating another run'
          : isCatchupFire
          ? 'Scheduled workflow catch-up held for a user Resume/Skip decision'
          : 'Scheduled workflow occurrence accepted',
      );
      if (isCatchupFire && queued.status === 'held') {
        emitCatchupHeldNotice(workflowName, occurrence.missed + 1, latestKey, queued.id);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
        'Failed to enqueue scheduled workflow run',
      );
      // The durable pending occurrence stays intact and will be retried. The
      // notification remains useful, but it no longer truthfully says skipped.
      emitEnqueueFailureNotice(workflowName, err);
      try {
        recordProspectiveOutcome(
          prospectiveId,
          'blocked',
          {
            reason: 'schedule_enqueue_failed',
            cueKey: prospectiveCueKey,
            error: err instanceof Error ? err.message : String(err),
          },
          now,
        );
      } catch { /* best-effort control-plane receipt */ }
    }
  }
  return result;
}

function markWorkflowOccurrenceHandled(
  state: ScheduleState,
  dedupeKey: string,
  occurrence: PendingScheduleOccurrence,
): void {
  state.lastRunByMinute[dedupeKey] = occurrence.minuteKey;
  state.lastRunAtMs[dedupeKey] = occurrence.atMs;
  if (state.pendingByWorkflow[dedupeKey]?.atMs === occurrence.atMs) {
    delete state.pendingByWorkflow[dedupeKey];
  }
}

function migrateLegacyWorkflowScheduleKey(
  state: ScheduleState,
  legacyKey: string,
  stableKey: string,
): void {
  if (legacyKey === stableKey) return;
  if (!(stableKey in state.lastRunByMinute) && legacyKey in state.lastRunByMinute) {
    state.lastRunByMinute[stableKey] = state.lastRunByMinute[legacyKey];
  }
  if (!(stableKey in state.lastRunAtMs) && legacyKey in state.lastRunAtMs) {
    state.lastRunAtMs[stableKey] = state.lastRunAtMs[legacyKey];
  }
  if (!(stableKey in state.pendingByWorkflow) && legacyKey in state.pendingByWorkflow) {
    state.pendingByWorkflow[stableKey] = state.pendingByWorkflow[legacyKey];
  }
  delete state.lastRunByMinute[legacyKey];
  delete state.lastRunAtMs[legacyKey];
  delete state.pendingByWorkflow[legacyKey];
}

/** Max queued+running/finalizing run records per workflow before the scheduler
 *  backs off. Three feels right: it absorbs short bursts of slow runs
 *  without letting a single misbehaving cron carpet the disk. */
const MAX_PENDING_PER_WORKFLOW = 3;
/** Control-plane fsync budget, not an execution budget. Held records run zero
 * steps; the runner independently serializes only the ones users Resume. */
const MAX_CATCHUP_HOLDS_PER_TICK = 20;
export const _testOnly_maxCatchupHoldsPerTick = MAX_CATCHUP_HOLDS_PER_TICK;

/** Walk WORKFLOW_RUNS_DIR once and split active work into executable
 *  queued/running/finalizing records versus approval-parked records. A parked
 *  run is not part of the concurrency queue, but it IS schedule backpressure. */
function countActiveRunsFor(workflowName: string): { pending: number; parked: number } {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return { pending: 0, parked: 0 };
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { pending: 0, parked: 0 };
  }
  let pending = 0;
  let parked = 0;
  for (const file of files) {
    if (pending >= MAX_PENDING_PER_WORKFLOW + 1 && parked > 0) break;
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        workflow?: string;
        status?: string;
      };
      if (raw.workflow !== workflowName) continue;
      if (raw.status === 'parked') parked += 1;
      else if (
        !raw.status
        || raw.status === 'queued'
        || raw.status === 'running'
        || raw.status === 'finalizing'
      ) pending += 1;
    } catch {
      // Unreadable record — ignore. The reaper will sweep it eventually.
    }
  }
  return { pending, parked };
}

/** Daily-bucketed system notification so the user knows their schedule
 *  is firing faster than the workflow can finish. We import lazily to
 *  avoid a runtime cycle (notifications → maintenance → scheduler). */
/** Surface an occurrence whose durable retry is blocked at enqueue time
 *  (daily-bucketed per workflow). */
function emitEnqueueFailureNotice(workflowName: string, err: unknown): void {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    const id = `system-workflow-enqueue-failed-${workflowName}-${dayKey}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'workflow',
      title: `Scheduled run of "${workflowName}" could not start`,
      body: `The schedule fired but the run failed to enqueue: ${err instanceof Error ? err.message : String(err)}. This occurrence is saved and will retry after the cause is fixed — open the workflow in Console to check it.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { errorCategory: 'workflow_enqueue_failed', workflow: workflowName },
    });
  } catch (noticeErr) {
    logger.warn(
      { err: noticeErr instanceof Error ? noticeErr.message : String(noticeErr), workflow: workflowName },
      'Failed to emit enqueue-failure notice (best-effort, ignored)',
    );
  }
}

function emitQueueBackpressureNotice(workflowName: string, pending: number): void {
  try {
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

/** Tell the user a stale occurrence is waiting BEFORE any workflow step runs.
 * The run-id-stable notification survives restart without nagging every boot. */
function emitCatchupHeldNotice(
  workflowName: string,
  missedCount: number,
  scheduledMinuteKey: string,
  runId: string,
): void {
  try {
    const id = `system-workflow-catchup-held-${runId}`;
    if (getNotification(id)) return;
    addNotification({
      id,
      kind: 'system',
      title: `Missed workflow waiting: "${workflowName}"`,
      body:
        `"${workflowName}" missed ${missedCount} scheduled occurrence${missedCount === 1 ? '' : 's'} while Clementine was unavailable. `
        + 'No workflow steps have run. Open Tasks to review it, then Resume or Skip this missed run.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        errorCategory: 'workflow_schedule_catchup_held',
        workflow: workflowName,
        workflowRunId: runId,
        runId,
        catchupHeld: true,
        missedCount,
        scheduledMinuteKey,
        // Surfaces in the chat Needs-you strip + Inbox (2026-07-30 audit: three
        // held morning workflows sat SILENT 13h — the hold was correct, the
        // invisibility was the bug). The 24h auto-skip reaper is the backstop;
        // this gives the user their decision window.
        needsAttention: true,
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workflow: workflowName },
      'Failed to emit held catch-up notice (best-effort, ignored)',
    );
  }
}

/** Queue with an occurrence-stable receipt. If the process dies after queue
 *  acceptance but before scheduler state commits, replay resolves to the same
 *  run instead of creating a second execution. */
function enqueueScheduledRun(
  workflowName: string,
  workflowSlug: string,
  occurrenceAtMs: number,
  catchupFire = false,
  catchupAdmissionAtMs = occurrenceAtMs,
  catchupMissedCount = 1,
): { id: string; status: 'queued' | 'held' | 'duplicate' } {
  const queued = queueWorkflowRun(workflowName, {}, {
    source: 'schedule',
    idPrefix: 'sched',
    dedupe: false,
    triggerReceiptId: `workflow-schedule:v1:${workflowSlug}:${occurrenceAtMs}`,
    ...(catchupFire
      ? {
          catchupFire: true,
          catchupOccurrenceAtMs: catchupAdmissionAtMs,
          holdForCatchupDecision: true,
          workflowSlug,
          catchupFirstDueAtMs: catchupAdmissionAtMs,
          catchupMissedCount,
        }
      : {}),
  });
  if (!queued.id) throw new Error(queued.message || `Scheduled workflow "${workflowName}" did not return a run id.`);
  if (queued.status !== 'queued' && queued.status !== 'held' && queued.status !== 'duplicate') {
    throw new Error(queued.message || `Scheduled workflow "${workflowName}" was not accepted.`);
  }
  return { id: queued.id, status: queued.status };
}

/**
 * Reaper for terminal workflow run records older than RETENTION days.
 * Called by the daemon on a slow tick (every ~hour) — prevents the
 * unbounded-growth scenario the audit flagged: a star-slash-1 cron over 24h would
 * leave 1440 completed run JSON files in WORKFLOW_RUNS_DIR, and
 * processWorkflowRuns re-reads every file every tick.
 *
 * Conservative: only deletes canonical terminal records older than RETENTION
 * days after their report-back evidence is fully acknowledged. Non-terminal or
 * pending-report records are never touched.
 */
const RUN_RETENTION_DAYS = 7;
// creation_test / dry_run retain the same status from admission through finish,
// so finishedAt (checked below) is their terminal discriminator.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'completed_with_errors',
  'error',
  'failed',
  'cancelled',
]);

interface ReapableWorkflowRunRecord extends WorkflowRunReportBackRecord {
  status?: string;
  finishedAt?: string;
  workflow?: string;
  workflowDefinitionSnapshot?: unknown;
}

let beforeRunRecordReapLockForTests: ((filePath: string) => void) | undefined;

/** Deterministic race seam: runs after directory enumeration and immediately
 * before the authoritative per-record lock/read. */
export function _setWorkflowRunReaperBeforeLockForTests(
  hook?: (filePath: string) => void,
): void {
  beforeRunRecordReapLockForTests = hook;
}

function isTerminalWorkflowRunRecord(record: ReapableWorkflowRunRecord): boolean {
  if (record.status === 'dry_run' || record.status === 'creation_test') {
    return typeof record.finishedAt === 'string';
  }
  return typeof record.status === 'string' && TERMINAL_STATUSES.has(record.status);
}

function hasOutstandingWorkflowRunReportBack(record: ReapableWorkflowRunRecord): boolean {
  // A retry/quarantine marker is durable evidence that report-back did not
  // cleanly close. Preserve it even if the envelope is malformed or internally
  // inconsistent so retention never turns an evidence problem into data loss.
  if (record.reportBackRetry !== undefined) return true;
  if (record.reportBack === undefined) return false;
  try {
    return workflowRunReportBackNeedsRetry(record);
  } catch {
    return true;
  }
}

/** Resolve the storage owner before deleting any of the evidence that can tell
 * us that owner. New runs have both a graph owner and an immutable admitted
 * definition; the current workflow catalog is only a legacy fallback for
 * display-name run records. */
function canonicalWorkflowSlugForReap(
  record: ReapableWorkflowRunRecord,
  runId: string,
): string | null {
  const graphOwner = loadWorkflowGraphSnapshotByRunId(runId)?.workflowName.trim();
  if (graphOwner) return graphOwner;

  const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  if (admitted.status === 'valid') return admitted.snapshot.workflowSlug;
  if (admitted.status === 'invalid') return null;

  const reference = record.workflow?.trim();
  if (!reference) return null;
  const current = listWorkflows().find(
    (entry) => entry.name === reference || entry.data.name === reference,
  );
  return current?.name ?? reference;
}

const WORKFLOW_RUN_ORIGINS_DIR = path.join(WORKFLOW_RUNS_DIR, '.run-origins');
const WORKFLOW_RUN_CANCELLATIONS_DIR = path.join(WORKFLOW_RUNS_DIR, '.cancellations');

function workflowRunSidecarKey(runId: string): string {
  return createHash('sha256').update(runId).digest('hex');
}

/** Remove immutable observer/cancellation evidence only after the canonical
 * terminal record has passed the acknowledged-report-back retention gate.
 * Trigger acceptance receipts live under a different, deliberately untouched
 * root (`.trigger-receipts`). */
function reapWorkflowRunSidecars(runId: string): boolean {
  const key = workflowRunSidecarKey(runId);
  try {
    rmSync(path.join(WORKFLOW_RUN_ORIGINS_DIR, key), { recursive: true, force: true });
    rmSync(path.join(WORKFLOW_RUN_CANCELLATIONS_DIR, `${key}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

function workflowCatalogMarkerExists(workflowSlug: string): boolean {
  return existsSync(path.join(WORKFLOWS_DIR, workflowSlug, 'SKILL.md'))
    || existsSync(path.join(WORKFLOWS_DIR, `${workflowSlug}.md`))
    || existsSync(path.join(WORKFLOWS_DIR, `${workflowSlug}.md.bak`));
}

/** Remove one directory only when it is empty. A concurrent creator winning
 * the check/rmdir race is preservation, not a retention failure. */
function removeDirectoryIfEmpty(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return true;
    rmdirSync(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTEMPTY';
  }
}

/** Catalogless compiled workflows have no SKILL.md to own their run tree.
 * Once their last retention-bound run is gone, remove only empty `runs/` and
 * owner directories. A surviving run directory means reapRunEventDir retained
 * correctness-critical call-mutation receipts, so the owner must remain. */
function pruneEmptyCataloglessCompiledOwner(
  record: ReapableWorkflowRunRecord,
  workflowSlug: string,
  runId: string,
): boolean {
  const admitted = resolveWorkflowRunDefinitionSnapshot(record.workflowDefinitionSnapshot);
  if (
    admitted.status !== 'valid'
    || !isCompiledWorkflowRunDefinitionSnapshot(admitted.snapshot)
    || admitted.snapshot.workflowSlug !== workflowSlug
  ) return true;

  if (workflowCatalogMarkerExists(workflowSlug)) return true;

  const ownerDir = path.join(WORKFLOWS_DIR, workflowSlug);
  const runsDir = path.join(ownerDir, 'runs');
  const runDir = path.join(runsDir, runId);

  // `reapRunEventDir` leaves the run directory behind only to preserve the
  // call-mutations ledger. Never collapse its parents while it remains.
  if (existsSync(path.join(runDir, 'call-mutations'))) return true;
  if (existsSync(runDir) && !removeDirectoryIfEmpty(runDir)) return false;
  if (existsSync(runDir)) return true;

  if (!removeDirectoryIfEmpty(runsDir)) return false;
  // Recheck catalog evidence at the final owner-removal boundary. A catalog
  // file created concurrently always wins over hygiene.
  if (workflowCatalogMarkerExists(workflowSlug)) return true;
  return removeDirectoryIfEmpty(ownerDir);
}

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
      beforeRunRecordReapLockForTests?.(full);
      const reaped = withWorkflowRunRecordLock(full, () => {
        // Every deletion decision is made from a fresh snapshot after acquiring
        // the same lock used by terminal publication, cancellation, and report
        // acknowledgement. An optimistic scan can never delete their successor.
        const raw = readWorkflowRunRecordUnlocked<ReapableWorkflowRunRecord>(full);
        if (!raw || !isTerminalWorkflowRunRecord(raw)) return false;
        if (hasOutstandingWorkflowRunReportBack(raw)) return false;
        // A compiled root is the restart journal for a second durable ledger.
        // Never delete it until an exact marker proves ExecutionStore observed
        // the same immutable terminal digest.
        if (!compiledProjectRootHasSettlementMarker(full, raw as unknown as Record<string, unknown>)) return false;

        // Prefer finishedAt; fall back to file mtime for legacy terminal records.
        const finishedMs = raw.finishedAt ? Date.parse(raw.finishedAt) : Number.NaN;
        const ageRef = Number.isFinite(finishedMs) ? finishedMs : statSync(full).mtimeMs;
        if (ageRef >= cutoffMs) return false;

        const runId = file.replace(/\.json$/, '');
        const workflowSlug = canonicalWorkflowSlugForReap(raw, runId);
        if (!workflowSlug) return false;

        // Clean subordinate state before unlinking the sole run ownership
        // record. Any cleanup failure leaves that record reachable for a later
        // retry instead of stranding graph/events under a lost display name.
        if (!reapRunEventDir(workflowSlug, runId)) return false;
        if (!pruneEmptyCataloglessCompiledOwner(raw, workflowSlug, runId)) return false;
        deleteWorkflowGraphSnapshotByRunId(runId);
        if (!reapWorkflowRunSidecars(runId)) return false;
        unlinkSync(full);
        return true;
      });
      if (reaped) deleted += 1;
    } catch {
      // Unreadable / disappeared — skip.
    }
  }
  if (deleted > 0) {
    logger.info({ deleted, scanned: files.length, retentionDays: RUN_RETENTION_DAYS }, 'Reaped stale workflow run records');
  }
  return { scanned: files.length, deleted };
}

export const workflowSchedulerInternalsForTest = {
  countActiveRunsFor,
};
