/**
 * Workspaces daily/periodic refresh — a tiny scheduler tick that fires each
 * data source's declared cron SERVER-SIDE with NO LLM (the token-free pulse).
 * Reuses the workflow scheduler's wall-clock + catch-up primitives so a laptop
 * that slept through the fire-minute still refreshes once on wake.
 *
 * A scheduled refresh just updates data.json (the user sees fresh data when
 * they open the workspace). If a refresh should PING the user, Clem's runner
 * script can POST to /api/console/spaces/<slug>/reengage with
 * trigger:'threshold' when something notable crosses — no special framework
 * needed; the re-engage path already wakes her with context. The one other
 * thing a scheduled refresh says is that a source keeps failing: once per
 * failure code, after which it backs off (source-refresh-backoff.ts).
 *
 * Mirrors processWorkflowSchedules (dedupe-by-minute, 24h catch-up, prune).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { cronMatches, scheduleCatchupWindow } from '../execution/workflow-scheduler.js';
import { peekConnectedToolkits } from '../integrations/composio/client.js';
import { addNotification } from '../runtime/notifications.js';
import { withFileLock } from '../runtime/atomic-json.js';
import { spaceStore, type SpaceDataSource, type SpaceRecord } from './store.js';
import { refreshSpaceData, type RefreshResult } from './runner.js';
import { readData } from './data-store.js';
import { reengageSpace } from './reengage.js';
import { getCurrentWorkspaceDatasetObservation } from './workspace-db.js';
import {
  passOverDueOccurrence,
  readSourceRefreshStreaks,
  recordSourceRefreshFailure,
  restartAfterChange,
  sourceIdentity,
  sourceIdentityChanged,
  sourceStreakGroupNotice,
  SPACE_SOURCE_NOTICE_SOURCE,
  type SourceStreakNotice,
  type SourceStreakNoticeInput,
  type SourceRefreshStreak,
  type SourceStreakCode,
} from './source-refresh-backoff.js';

const STATE_FILE = path.join(BASE_DIR, 'state', 'space-schedule-state.json');
const PRUNE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

interface SpaceScheduleState {
  lastEvaluatedAtMs?: number;
  lastRunByMinute: Record<string, string>;
  /** E2 dedup: per "space:source" → last fired re-engage condition key, so a
   *  persistent threshold pings ONCE (not every scheduled refresh). */
  lastReengageByKey: Record<string, string>;
  /** Paused-build auto-retry bookkeeping: slug → attempts + last attempt ms.
   *  Durable so daemon restarts don't reset the retry budget. */
  pausedRetryBySlug: Record<string, { attempts: number; lastAtMs: number }>;
  /** "space:source" → its current run of failed scheduled refreshes. */
  sourceStreakByKey: Record<string, SourceRefreshStreak>;
  /** Durable notification outbox: admission may fail after a streak is saved. */
  pendingSourceNotices: Record<string, SourceStreakNotice & { createdAt: string }>;
}

/** Admit only failure-report metadata. Restoring an outbox cannot invent a
 * delivery target, approval action or exact-origin authority from extra fields. */
function readPendingSourceNotices(raw: unknown): SpaceScheduleState['pendingSourceNotices'] {
  const out: SpaceScheduleState['pendingSourceNotices'] = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const meta = row.metadata as Record<string, unknown> | undefined;
    if ((!id.startsWith('space-source-') && !id.startsWith('space-sources-'))
      || row.id !== id || typeof row.title !== 'string' || typeof row.body !== 'string'
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || !meta || meta.source !== SPACE_SOURCE_NOTICE_SOURCE || meta.status !== 'failed'
      || typeof meta.workspaceId !== 'string' || typeof meta.spaceTitle !== 'string') continue;
    const metadata: Record<string, unknown> = {
      source: SPACE_SOURCE_NOTICE_SOURCE, status: 'failed', workspaceId: meta.workspaceId, spaceTitle: meta.spaceTitle,
    };
    for (const field of ['sourceId', 'failureCode', 'firstFailedAt', 'lastFailedAt']) {
      if (typeof meta[field] === 'string') metadata[field] = meta[field];
    }
    for (const field of ['consecutiveFailures', 'failedSourceCount']) {
      if (Number.isSafeInteger(meta[field]) && (meta[field] as number) > 0) metadata[field] = meta[field];
    }
    if (Array.isArray(meta.sourceIds)) metadata.sourceIds = meta.sourceIds.filter(id => typeof id === 'string');
    if (Array.isArray(meta.failures)) metadata.failures = meta.failures.map(value => {
      const failure = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return Object.fromEntries(['noticeId', 'sourceId', 'failureCode', 'firstFailedAt', 'lastFailedAt', 'consecutiveFailures']
        .filter(key => typeof failure[key] === 'string' || (key === 'consecutiveFailures' && Number.isSafeInteger(failure[key])))
        .map(key => [key, failure[key]]));
    });
    out[id] = { id, title: row.title, body: row.body, createdAt: row.createdAt, metadata };
  }
  return out;
}

// Both entrypoints own the same persisted state. Reuse the existing process-
// and cross-process lock through awaited work, so retries cannot overwrite a
// pending notification generation or execute one due tick concurrently.
function withScheduleStateOwner<T>(work: () => Promise<T>): Promise<T> {
  return withFileLock(STATE_FILE, work);
}

function loadState(): SpaceScheduleState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      return {
        lastEvaluatedAtMs: typeof parsed.lastEvaluatedAtMs === 'number' ? parsed.lastEvaluatedAtMs : undefined,
        lastRunByMinute: (parsed.lastRunByMinute && typeof parsed.lastRunByMinute === 'object') ? parsed.lastRunByMinute : {},
        lastReengageByKey: (parsed.lastReengageByKey && typeof parsed.lastReengageByKey === 'object') ? parsed.lastReengageByKey : {},
        pausedRetryBySlug: (parsed.pausedRetryBySlug && typeof parsed.pausedRetryBySlug === 'object') ? parsed.pausedRetryBySlug : {},
        sourceStreakByKey: readSourceRefreshStreaks(parsed.sourceStreakByKey),
        pendingSourceNotices: readPendingSourceNotices(parsed.pendingSourceNotices),
      };
    }
  } catch { /* fresh */ }
  return { lastRunByMinute: {}, lastReengageByKey: {}, pausedRetryBySlug: {}, sourceStreakByKey: {}, pendingSourceNotices: {} };
}

/**
 * E2 — a scheduled runner may emit a reserved `_reengage` signal in its JSON
 * output ({ fire:true, message?, key? }) to proactively wake Clem. A sandboxed
 * runner can't authenticate to the /reengage route itself, so the scheduler
 * (in-process) harvests it after a successful refresh and fires the canonical
 * re-engage. Returns the firing condition's dedup key, or null when the source
 * isn't asking to wake.
 */
function reengageSignalFor(slug: string, sourceId: string): { message: string; key: string } | null {
  const data = readData(slug);
  const src = (data && typeof data === 'object') ? (data as Record<string, unknown>)[sourceId] : undefined;
  const sig = (src && typeof src === 'object') ? (src as Record<string, unknown>)._reengage : undefined;
  if (!sig || typeof sig !== 'object') return null;
  const s = sig as Record<string, unknown>;
  if (s.fire !== true) return null;
  const message = typeof s.message === 'string' ? s.message : '';
  const key = (typeof s.key === 'string' && s.key.trim()) ? s.key.trim() : (message || 'fire');
  return { message, key };
}

function saveState(state: SpaceScheduleState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, JSON.stringify(state, null, 2), 'utf-8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, STATE_FILE);
    if (process.platform !== 'win32') {
      const directory = openSync(dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already renamed or never opened */ }
    throw error;
  }
}

/** Stable per-minute dedup key (UTC, minute precision). */
function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}

function prune(map: Record<string, string>, nowMs: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && nowMs - t < PRUNE_AFTER_MS) out[k] = v;
  }
  return out;
}

export interface SpaceFireResult {
  evaluated: number;
  fired: number;
  errors: number;
  /** Due legacy sources held for a pinned-entrypoint decision, not runtime errors. */
  awaitingApproval: number;
  /** Due occurrences passed over because the source keeps failing. */
  heldBack: number;
  /** Failing-source notices written this tick. */
  told: number;
}

/** The source's current successful observation, or null when it has none. */
function currentOkObservationId(spaceId: string, sourceId: string): string | null {
  try {
    return getCurrentWorkspaceDatasetObservation(spaceId, sourceId)?.id ?? null;
  } catch {
    return null;
  }
}

/** A refresh from any path succeeded after the streak's last failure. */
function succeededSince(spaceId: string, sourceId: string, streak: SourceRefreshStreak): boolean {
  const current = currentOkObservationId(spaceId, sourceId);
  return current !== null && current !== streak.okObservationId;
}

function connectionSnapshot() {
  try {
    return peekConnectedToolkits();
  } catch {
    return [];
  }
}

/**
 * Evaluate every active Workspace's scheduled data sources against the wall
 * clock (with catch-up) and refresh any that are due. Idempotent per minute.
 */
export function processSpaceSchedules(now: Date = new Date()): Promise<SpaceFireResult> {
  return withScheduleStateOwner(() => processSpaceSchedulesOwned(now));
}

async function processSpaceSchedulesOwned(now: Date): Promise<SpaceFireResult> {
  const state = loadState();
  const minutes = scheduleCatchupWindow(state.lastEvaluatedAtMs, now.getTime());
  const lastRun = state.lastRunByMinute;
  const reengageKeys = state.lastReengageByKey;
  const streaks = state.sourceStreakByKey;
  const scheduledKeys = new Set<string>();
  const connections = connectionSnapshot();
  let evaluated = 0;
  let fired = 0;
  let errors = 0;
  let awaitingApproval = 0;
  let heldBack = 0;
  let told = 0;
  const newlyToldBySpace = new Map<string, SourceStreakNoticeInput[]>();

  const recordFailure = (
    space: SpaceRecord,
    ds: SpaceDataSource,
    key: string,
    failure: { code: SourceStreakCode; error: string },
  ): void => {
    const recorded = recordSourceRefreshFailure(streaks[key], {
      ...failure,
      at: now,
      identity: sourceIdentity(ds, connections),
      okObservationId: currentOkObservationId(space.id, ds.id),
    });
    streaks[key] = recorded.streak;
    if (!recorded.tell) return;
    const group = newlyToldBySpace.get(space.id) ?? [];
    group.push({ spaceId: space.id, spaceTitle: space.title, source: ds, streak: recorded.streak });
    newlyToldBySpace.set(space.id, group);
  };

  for (const space of spaceStore.list()) {
    if (space.status !== 'active') continue;
    for (const ds of space.dataSources) {
      if (!ds.schedule) continue;
      evaluated += 1;
      const key = `${space.id}:${ds.id}`;
      scheduledKeys.add(key);
      // Collapse a long absence into ONE refresh (v3.0.1 incident, sibling of
      // the workflow-scheduler stampede). This loop used to refresh once per
      // MATCHED MINUTE: an hourly source missed for a day fired 24 sequential
      // provider refreshes in a single tick, and a daily one missed for a week
      // fired 7 — repeated identical work, real provider spend, and a tick that
      // blocks for minutes. Only the most recent occurrence carries information;
      // the earlier ones are superseded by definition.
      const matched: Date[] = [];
      for (const minute of minutes) {
        if (!cronMatches(ds.schedule, minute, ds.timezone)) continue;
        if (lastRun[key] === minuteKey(minute)) continue; // already fired
        matched.push(minute);
      }
      const latest = matched[matched.length - 1];

      // A failing source: a success from any path ends the streak; a changed
      // declaration or connection ends the wait and is tried at once.
      let streak: SourceRefreshStreak | undefined = streaks[key];
      let changed = false;
      if (streak && succeededSince(space.id, ds.id, streak)) {
        delete streaks[key];
        streak = undefined;
      }
      if (streak) {
        const identity = sourceIdentity(ds, connections);
        if (sourceIdentityChanged(streak, identity)) {
          streak = restartAfterChange(streak, identity);
          changed = true;
        } else if (streak.connectionDigest === null && identity.connectionDigest !== null) {
          streak = { ...streak, connectionDigest: identity.connectionDigest };
        }
        streaks[key] = streak;
      }

      let refreshId: string;
      let batchId: string;
      let mk: string;
      if (latest) {
        mk = minuteKey(latest);
        lastRun[key] = mk;
        if (streak && !changed) {
          const decision = passOverDueOccurrence(streak, { now, occurrences: matched.length });
          streaks[key] = decision.streak;
          if (decision.hold) {
            heldBack += 1;
            continue;
          }
        }
        // The scheduler's existing authority is one source per UTC minute.
        // Reuse that same identity in the temporal store so a daemon restart
        // cannot append a second observation for the occurrence.
        refreshId = `scheduled:${mk}`;
        batchId = `scheduled:${space.id}:${ds.id}:${mk}`;
      } else if (changed) {
        mk = minuteKey(now);
        refreshId = `scheduled:changed:${mk}`;
        batchId = `scheduled:changed:${space.id}:${ds.id}:${mk}`;
      } else {
        continue;
      }

      let results: RefreshResult[];
      try {
        results = await refreshSpaceData(space.id, ds.id, { cause: 'scheduled', refreshId, batchId });
      } catch (error) {
        errors += 1;
        recordFailure(space, ds, key, {
          code: 'unclassified',
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const failed = results.find((r) => !r.ok && !r.pendingApprovalId);
      if (failed) {
        errors += 1;
        recordFailure(space, ds, key, {
          code: failed.failureCode ?? 'unclassified',
          error: failed.error ?? '',
        });
      } else if (results.some((r) => !r.ok)) {
        // Waiting on the owner's decision is not a failure of the source.
        awaitingApproval += 1;
      } else {
        fired += 1;
        delete streaks[key];
        // E2: harvest a proactive re-engage signal, deduped by condition key
        // (reusing `key` = "space:source") so a persistent threshold pings once.
        const sig = reengageSignalFor(space.id, ds.id);
        if (sig) {
          if (reengageKeys[key] !== sig.key) {
            reengageKeys[key] = sig.key;
            try {
              await reengageSpace(space.id, {
                trigger: 'threshold', message: sig.message,
                // include the firing minute so a condition that CLEARS and
                // returns wakes again (deliverOutcome is idempotent by sourceId).
                actionId: `${ds.id}:${sig.key}:${mk}`, meta: { source: ds.id },
              });
            } catch { /* best-effort; a wake must never break the tick */ }
          }
        } else if (reengageKeys[key]) {
          delete reengageKeys[key]; // condition cleared → a recurrence can re-fire
        }
      }
    }
  }

  // A source that is gone, unscheduled, or in a Space that is not active has
  // no streak to keep.
  for (const key of Object.keys(streaks)) {
    if (!scheduledKeys.has(key)) delete streaks[key];
  }
  state.lastEvaluatedAtMs = now.getTime();
  state.lastRunByMinute = prune(lastRun, now.getTime());
  for (const group of newlyToldBySpace.values()) {
    const notice = sourceStreakGroupNotice(group);
    state.pendingSourceNotices[notice.id] ??= { ...notice, createdAt: now.toISOString() };
  }
  // Freeze membership and the original timestamp with the streak before
  // notification admission. A failed write is retried next tick, even if no
  // source is due or its backoff is holding it. Stable ids also repair a crash
  // after notifications.json was written but before its delivery queue was.
  saveState(state);
  for (const notice of Object.values(state.pendingSourceNotices)) {
    try {
      addNotification({ ...notice, kind: 'system', read: false });
      delete state.pendingSourceNotices[notice.id];
      told += 1;
    } catch { /* Keep the durable outbox entry; never equate failure with delivery. */ }
  }
  if (told > 0) saveState(state);
  return { evaluated, fired, errors, awaitingApproval, heldBack, told };
}

// ── Paused-build auto-retry ───────────────────────────────────────────────────
//
// The creation smoke parks a Workspace 'paused' when a data source ERRORS at
// build time — correct for real bugs, but a transient blip (rate limit, API
// hiccup, cold auth) used to STRAND the workspace until the user noticed the
// banner. This tick retries a paused workspace's sources up to MAX_PAUSE_RETRIES
// times with spacing: all sources pull clean → reactivate + re-engage Clem so
// she tells the user; still failing → stays paused (a human decision, as
// designed). Budget is durable in the schedule state, and cleared when a save
// reactivates the space through the normal path. Only a build-check pause is
// retried: a Space the owner paused stays paused until the owner resumes it.

const MAX_PAUSE_RETRIES = 2;
const PAUSE_RETRY_MIN_AGE_MS = 5 * 60 * 1000;      // don't race the authoring turn
const PAUSE_RETRY_SPACING_MS = 15 * 60 * 1000;     // between attempts

export interface PausedRetryResult { examined: number; reactivated: number; stillPaused: number }

export function retryPausedSpaces(now: Date = new Date()): Promise<PausedRetryResult> {
  return withScheduleStateOwner(() => retryPausedSpacesOwned(now));
}

async function retryPausedSpacesOwned(now: Date): Promise<PausedRetryResult> {
  const state = loadState();
  const retries = state.pausedRetryBySlug;
  const out: PausedRetryResult = { examined: 0, reactivated: 0, stillPaused: 0 };
  const nowMs = now.getTime();

  for (const space of spaceStore.list()) {
    if (space.status !== 'paused' || space.pausedBy !== 'build_check' || space.dataSources.length === 0) {
      if (space.status === 'active' && retries[space.id]) delete retries[space.id]; // fixed via re-save → reset budget
      continue;
    }
    const pausedAtMs = Date.parse(space.updatedAt);
    if (Number.isFinite(pausedAtMs) && nowMs - pausedAtMs < PAUSE_RETRY_MIN_AGE_MS) continue;
    const budget = retries[space.id] ?? { attempts: 0, lastAtMs: 0 };
    if (budget.attempts >= MAX_PAUSE_RETRIES) continue;
    if (nowMs - budget.lastAtMs < PAUSE_RETRY_SPACING_MS) continue;

    out.examined += 1;
    budget.attempts += 1;
    budget.lastAtMs = nowMs;
    retries[space.id] = budget;

    let allOk = false;
    try {
      const results = await refreshSpaceData(space.id, undefined, {
        allowPaused: true,
        cause: 'retry',
        refreshId: `retry:${space.updatedAt}:${budget.attempts}`,
        batchId: `retry:${space.id}:${space.updatedAt}:${budget.attempts}`,
      });
      allOk = results.length > 0 && results.every((r) => r.ok);
    } catch { allOk = false; }

    if (allOk) {
      spaceStore.update(space.id, { status: 'active' });
      delete retries[space.id];
      out.reactivated += 1;
      try {
        await reengageSpace(space.id, {
          trigger: 'threshold',
          message: `Auto-retry succeeded: the data source${space.dataSources.length === 1 ? '' : 's'} that failed when "${space.title}" was built ${space.dataSources.length === 1 ? 'is' : 'are'} pulling cleanly now (attempt ${budget.attempts}) — the workspace is reactivated. Tell the user it's live.`,
          actionId: `pause-retry-ok:${space.id}:${minuteKey(now)}`,
          meta: { source: 'pause-retry' },
        });
      } catch { /* a wake must never break the tick */ }
    } else {
      out.stillPaused += 1;
    }
  }

  state.pausedRetryBySlug = retries;
  saveState(state);
  return out;
}
