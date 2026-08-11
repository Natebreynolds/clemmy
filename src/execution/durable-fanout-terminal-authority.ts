/**
 * Read-only terminal authority for durable fan-out.
 *
 * Keep this module below the scheduler/runtime layer. Importing the full
 * durable-fanout module from the terminal committer would pull background task
 * delivery back into the committer and create a cycle at the exact boundary
 * that must fail closed. This reader knows only the durable schema and returns
 * typed state; it never schedules, repairs, or mutates work.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

const FANOUT_PLAN_STATUSES = new Set(['active', 'reduced', 'failed', 'superseded']);

export interface ExactSourceFanoutPlanTruth {
  planId: string;
  status: 'active' | 'reduced' | 'failed' | 'superseded';
  reducerState: 'ready' | 'leased' | 'admitted' | 'running' | 'completed' | 'failed' | null;
  activationCount: number;
  incompleteActivationCount: number;
  windowCount: number;
  openWindowCount: number;
}

export type ExactSourceFanoutTruth =
  | { status: 'ok'; plans: ExactSourceFanoutPlanTruth[] }
  | { status: 'unreadable'; reason: string }
  | { status: 'ambiguous'; reason: string };

function fanoutDatabasePath(): string {
  return path.join(BASE_DIR, 'state', 'durable-fanout', getMachineId(), 'fanout.db');
}

/**
 * Read every plan owned by one accepted source without silently dropping a
 * corrupt row. A reduced plan is accepted only when its reducer completed and
 * every item×phase activation is durably done.
 */
export function exactSourceFanoutTruth(
  sessionId: string,
  sourceUserSeq: number,
): ExactSourceFanoutTruth {
  const file = fanoutDatabasePath();
  if (!existsSync(file)) return { status: 'ok', plans: [] };

  let database: Database.Database;
  try {
    database = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    return { status: 'unreadable', reason: String(error) };
  }
  try {
    database.pragma('busy_timeout = 5000');
    const havePlans = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
    ).get();
    if (!havePlans) return { status: 'ok', plans: [] };
    const haveActivations = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activations'",
    ).get();
    const haveWindows = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'windows'",
    ).get();
    if (!haveActivations || !haveWindows) {
      return { status: 'unreadable', reason: 'fan-out plans exist without a complete activation/window journal' };
    }

    const rows = database.prepare(`
      SELECT
        p.plan_id,
        p.status,
        p.reducer_state,
        (SELECT COUNT(*) FROM activations a WHERE a.plan_id = p.plan_id) AS activation_count,
        (SELECT COUNT(*) FROM activations a
          WHERE a.plan_id = p.plan_id AND a.status != 'done') AS incomplete_count,
        (SELECT COUNT(*) FROM windows w WHERE w.plan_id = p.plan_id) AS window_count,
        (SELECT COUNT(*) FROM windows w
          WHERE w.plan_id = p.plan_id AND w.status != 'done') AS open_window_count
      FROM plans p
      WHERE p.origin_session_id = ? AND p.source_user_seq = ?
      ORDER BY p.plan_id
    `).all(sessionId, sourceUserSeq) as Array<Record<string, unknown>>;

    const plans: ExactSourceFanoutPlanTruth[] = [];
    for (const row of rows) {
      const planId = typeof row.plan_id === 'string' ? row.plan_id : '';
      const status = typeof row.status === 'string' ? row.status : '';
      const reducerState = row.reducer_state === null || typeof row.reducer_state === 'string'
        ? row.reducer_state
        : undefined;
      const activationCount = Number(row.activation_count);
      const incompleteActivationCount = Number(row.incomplete_count ?? 0);
      const windowCount = Number(row.window_count);
      const openWindowCount = Number(row.open_window_count ?? 0);
      if (!planId || !FANOUT_PLAN_STATUSES.has(status)
        || reducerState === undefined
        || !Number.isSafeInteger(activationCount) || activationCount < 1
        || !Number.isSafeInteger(incompleteActivationCount) || incompleteActivationCount < 0
        || !Number.isSafeInteger(windowCount) || windowCount < 1
        || !Number.isSafeInteger(openWindowCount) || openWindowCount < 0) {
        return { status: 'ambiguous', reason: `fan-out plan '${planId || '<unknown>'}' has an invalid durable shape` };
      }
      if (status === 'reduced'
        && (reducerState !== 'completed'
          || incompleteActivationCount !== 0
          || openWindowCount !== 0)) {
        return {
          status: 'ambiguous',
          reason: `fan-out plan '${planId}' claims reduction without a completed reducer and closed activation/window journal`,
        };
      }
      plans.push({
        planId,
        status: status as ExactSourceFanoutPlanTruth['status'],
        reducerState: reducerState as ExactSourceFanoutPlanTruth['reducerState'],
        activationCount,
        incompleteActivationCount,
        windowCount,
        openWindowCount,
      });
    }
    return { status: 'ok', plans };
  } catch (error) {
    return { status: 'unreadable', reason: String(error) };
  } finally {
    try { database.close(); } catch { /* read-only handle */ }
  }
}
