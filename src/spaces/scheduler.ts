/**
 * Workspaces daily/periodic refresh — a tiny scheduler tick that fires each
 * data source's declared cron SERVER-SIDE with NO LLM (the token-free pulse).
 * Reuses the workflow scheduler's wall-clock + catch-up primitives so a laptop
 * that slept through the fire-minute still refreshes once on wake.
 *
 * Deliberately SILENT: a scheduled refresh just updates data.json (the user
 * sees fresh data when they open the workspace). If a refresh should PING the
 * user, Clem's runner script can POST to /api/console/spaces/<slug>/reengage
 * with trigger:'threshold' when something notable crosses — no special
 * framework needed; the re-engage path already wakes her with context.
 *
 * Mirrors processWorkflowSchedules (dedupe-by-minute, 24h catch-up, prune).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { cronMatches, scheduleCatchupWindow } from '../execution/workflow-scheduler.js';
import { spaceStore } from './store.js';
import { refreshSpaceData } from './runner.js';

const STATE_FILE = path.join(BASE_DIR, 'state', 'space-schedule-state.json');
const PRUNE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

interface SpaceScheduleState {
  lastEvaluatedAtMs?: number;
  lastRunByMinute: Record<string, string>;
}

function loadState(): SpaceScheduleState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      return {
        lastEvaluatedAtMs: typeof parsed.lastEvaluatedAtMs === 'number' ? parsed.lastEvaluatedAtMs : undefined,
        lastRunByMinute: (parsed.lastRunByMinute && typeof parsed.lastRunByMinute === 'object') ? parsed.lastRunByMinute : {},
      };
    }
  } catch { /* fresh */ }
  return { lastRunByMinute: {} };
}

function saveState(state: SpaceScheduleState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
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

export interface SpaceFireResult { evaluated: number; fired: number; errors: number }

/**
 * Evaluate every active Workspace's scheduled data sources against the wall
 * clock (with catch-up) and refresh any that are due. Idempotent per minute.
 */
export async function processSpaceSchedules(now: Date = new Date()): Promise<SpaceFireResult> {
  const state = loadState();
  const minutes = scheduleCatchupWindow(state.lastEvaluatedAtMs, now.getTime());
  const lastRun = state.lastRunByMinute;
  let evaluated = 0;
  let fired = 0;
  let errors = 0;

  for (const space of spaceStore.list()) {
    if (space.status !== 'active') continue;
    for (const ds of space.dataSources) {
      if (!ds.schedule) continue;
      evaluated += 1;
      const key = `${space.id}:${ds.id}`;
      for (const minute of minutes) {
        if (!cronMatches(ds.schedule, minute, ds.timezone)) continue;
        const mk = minuteKey(minute);
        if (lastRun[key] === mk) continue; // already fired this minute
        lastRun[key] = mk;
        try {
          const results = await refreshSpaceData(space.id, ds.id);
          if (results.some((r) => !r.ok)) errors += 1; else fired += 1;
        } catch {
          errors += 1;
        }
      }
    }
  }

  state.lastEvaluatedAtMs = now.getTime();
  state.lastRunByMinute = prune(lastRun, now.getTime());
  saveState(state);
  return { evaluated, fired, errors };
}
