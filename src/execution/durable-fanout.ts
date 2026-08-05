/**
 * Production durable fan-out (C-series): an admitted WorkDisposition becomes
 * REAL work on the mature background scheduler, with an item×phase journal
 * that outlives any process.
 *
 * The division of authority:
 *
 *   - `work-disposition.ts` validates the typed manifest (identities, phases,
 *     cycles, reducer contract) and slices windows. It stays pure.
 *   - THIS module owns durability: the immutable normalized plan contract,
 *     one journal row per item×phase, window→background-task compilation,
 *     settlement CAS, journal-derived reducer readiness, and the once-only
 *     reducer lease. Nothing here trusts a caller-authored completion array —
 *     readiness is a query over the journal, full stop.
 *   - `background-tasks.ts` remains the scheduler: each window is a real
 *     durable BackgroundTaskRecord with bounded concurrency, restart
 *     recovery, and report-back — the same machinery every other background
 *     run already trusts.
 *
 * Identities are digest tuples (plan, item, phase) so journal keys and
 * receipts stay unambiguous under any item id a manifest can carry.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import {
  admitWorkDisposition,
  dispositionToDurableWork,
  reducerReady,
  type DispositionAdmission,
  type DispositionControls,
  type DurableWorkPlan,
  type LedgerEntry,
  type WorkDisposition,
} from './work-disposition.js';
import { enqueueDurableChatTask } from './background-promote.js';
import type { BackgroundTaskRecord } from './background-tasks.js';

export type FanoutPlanStatus = 'active' | 'reduced' | 'failed' | 'superseded';
export type FanoutActivationStatus = 'pending' | 'running' | 'done' | 'failed';

export interface FanoutPlanRow {
  planId: string;
  objective: string;
  manifest: WorkDisposition;
  durable: DurableWorkPlan;
  originSessionId: string | null;
  sourceUserSeq: number | null;
  status: FanoutPlanStatus;
  reducerLeaseOwner: string | null;
  reducerTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FanoutActivationRow {
  planId: string;
  itemId: string;
  phaseId: string;
  status: FanoutActivationStatus;
  receiptRef: string | null;
  workerTaskId: string | null;
  attempt: number;
  updatedAt: string;
}

let handle: Database.Database | null = null;
let handlePath = '';

function db(): Database.Database {
  const dir = path.join(BASE_DIR, 'state', 'durable-fanout', getMachineId());
  const file = path.join(dir, 'fanout.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      plan_id            TEXT PRIMARY KEY,
      objective          TEXT NOT NULL,
      manifest_json      TEXT NOT NULL,
      durable_json       TEXT NOT NULL,
      origin_session_id  TEXT,
      source_user_seq    INTEGER,
      status             TEXT NOT NULL CHECK (status IN ('active','reduced','failed','superseded')),
      reducer_lease_owner TEXT,
      reducer_task_id    TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activations (
      plan_id     TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      phase_id    TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
      receipt_ref TEXT,
      worker_task_id TEXT,
      attempt     INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (plan_id, item_id, phase_id)
    );
    CREATE INDEX IF NOT EXISTS activations_by_plan ON activations (plan_id, status);
  `);
  return handle;
}

/** Test hook: drop the handle so a fresh CLEMENTINE_HOME opens its own file. */
export function closeDurableFanoutForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Unambiguous journal/receipt identity for one item×phase activation. */
export function activationDigest(planId: string, itemId: string, phaseId: string): string {
  return sha256(JSON.stringify([planId, itemId, phaseId])).slice(0, 32);
}

function now(): string {
  return new Date().toISOString();
}

function hydratePlan(raw: Record<string, unknown>): FanoutPlanRow | null {
  try {
    return {
      planId: String(raw.plan_id),
      objective: String(raw.objective),
      manifest: JSON.parse(String(raw.manifest_json)) as WorkDisposition,
      durable: JSON.parse(String(raw.durable_json)) as DurableWorkPlan,
      originSessionId: (raw.origin_session_id as string | null) ?? null,
      sourceUserSeq: (raw.source_user_seq as number | null) ?? null,
      status: raw.status as FanoutPlanStatus,
      reducerLeaseOwner: (raw.reducer_lease_owner as string | null) ?? null,
      reducerTaskId: (raw.reducer_task_id as string | null) ?? null,
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
    };
  } catch {
    return null;
  }
}

export type FanoutAdmission =
  | { ok: true; plan: FanoutPlanRow }
  | { ok: false; kind: 'needs_input'; missing: string[] }
  | { ok: false; kind: 'invalid'; errors: string[] };

/**
 * An explicit background request with nothing to fan out still deserves the
 * durable substrate. The canonical one-item manifest: one item (the objective
 * itself), one execute phase, a reducer that runs after it — so scheduling,
 * settlement, restart reuse, and report-back are the SAME machinery whether
 * the plan has one item or five hundred.
 */
export function canonicalSingleManifest(objective: string): WorkDisposition['manifest'] {
  return {
    manifestId: `single-${sha256(objective).slice(0, 16)}`,
    contractVersion: 'v1',
    canonicalItems: [{ id: `objective-${sha256(objective).slice(0, 12)}` }],
    phases: [{ id: 'execute', dependsOn: [], runnerClass: 'worker' }],
    reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
  };
}

/**
 * Admit a typed disposition into the durable journal: validation through the
 * shared admission (typed clarification and structural refusals pass through
 * verbatim), then ONE transaction writes the immutable plan contract and
 * every item×phase journal row.
 */
export function admitDurableFanoutPlan(
  proposed: WorkDisposition,
  input: {
    originSessionId?: string;
    sourceUserSeq?: number;
    controls?: DispositionControls;
  } = {},
): FanoutAdmission {
  const withManifest: WorkDisposition = proposed.manifest
    ? proposed
    : {
      ...proposed,
      kind: 'durable_manifest',
      manifest: canonicalSingleManifest(proposed.objective),
    };
  const admitted: DispositionAdmission = admitWorkDisposition(withManifest, input.controls ?? {});
  if (!admitted.ok) {
    return admitted.kind === 'needs_input'
      ? { ok: false, kind: 'needs_input', missing: admitted.missing }
      : { ok: false, kind: 'invalid', errors: admitted.errors };
  }
  const disposition = admitted.disposition.manifest
    ? admitted.disposition
    : { ...admitted.disposition, kind: 'durable_manifest' as const, manifest: canonicalSingleManifest(admitted.disposition.objective) };
  const durable = dispositionToDurableWork({ ...disposition, kind: 'durable_manifest' });
  if (!durable) return { ok: false, kind: 'invalid', errors: ['the admitted disposition compiled to no durable plan'] };

  const manifest = disposition.manifest!;
  const planId = `fp_${sha256(JSON.stringify({
    manifestId: manifest.manifestId,
    contractVersion: manifest.contractVersion,
    origin: input.originSessionId ?? '',
    source: input.sourceUserSeq ?? 0,
  })).slice(0, 24)}`;
  const at = now();

  const database = db();
  const write = database.transaction((): FanoutPlanRow => {
    const existing = database.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as
      | Record<string, unknown> | undefined;
    if (existing) {
      // Idempotent re-admission (a retried tool call, a restart replay): the
      // durable plan already exists; return it rather than forking work.
      const hydrated = hydratePlan(existing);
      if (hydrated) return hydrated;
      throw new Error(`plan ${planId} exists but does not hydrate`);
    }
    database.prepare(`
      INSERT INTO plans (
        plan_id, objective, manifest_json, durable_json, origin_session_id,
        source_user_seq, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      planId, disposition.objective, JSON.stringify(disposition), JSON.stringify(durable),
      input.originSessionId ?? null, input.sourceUserSeq ?? null, at, at,
    );
    const insert = database.prepare(`
      INSERT INTO activations (plan_id, item_id, phase_id, status, attempt, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?)
    `);
    for (const window of durable.windows) {
      for (const itemId of window.itemIds) {
        for (const phaseId of durable.requiredPhases) insert.run(planId, itemId, phaseId, at);
      }
    }
    return hydratePlan(
      database.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as Record<string, unknown>,
    )!;
  });
  try {
    return { ok: true, plan: write() };
  } catch (error) {
    return { ok: false, kind: 'invalid', errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function loadFanoutPlan(planId: string): FanoutPlanRow | null {
  const raw = db().prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as
    | Record<string, unknown> | undefined;
  return raw ? hydratePlan(raw) : null;
}

export function listFanoutActivations(planId: string): FanoutActivationRow[] {
  const raws = db().prepare('SELECT * FROM activations WHERE plan_id = ?').all(planId) as
    Array<Record<string, unknown>>;
  return raws.map((raw) => ({
    planId: String(raw.plan_id),
    itemId: String(raw.item_id),
    phaseId: String(raw.phase_id),
    status: raw.status as FanoutActivationStatus,
    receiptRef: (raw.receipt_ref as string | null) ?? null,
    workerTaskId: (raw.worker_task_id as string | null) ?? null,
    attempt: Number(raw.attempt ?? 0),
    updatedAt: String(raw.updated_at),
  }));
}

export type FanoutSettlement =
  | { settled: true; alreadySettled: boolean }
  | { settled: false; reason: string };

/**
 * Settle ONE item×phase. Idempotent CAS: a terminal 'done' can never regress
 * or double-settle — a worker retry, a restarted window, or a duplicated
 * frame observes `alreadySettled` and moves on.
 */
export function settleFanoutActivation(input: {
  planId: string;
  itemId: string;
  phaseId: string;
  status: 'done' | 'failed';
  receiptRef?: string;
  workerTaskId?: string;
}): FanoutSettlement {
  const database = db();
  const run = database.transaction((): FanoutSettlement => {
    const current = database.prepare(
      'SELECT status FROM activations WHERE plan_id = ? AND item_id = ? AND phase_id = ?',
    ).get(input.planId, input.itemId, input.phaseId) as { status: string } | undefined;
    if (!current) return { settled: false, reason: 'no such item×phase in the plan journal' };
    if (current.status === 'done') return { settled: true, alreadySettled: true };
    database.prepare(`
      UPDATE activations SET status = ?, receipt_ref = COALESCE(?, receipt_ref),
        worker_task_id = COALESCE(?, worker_task_id),
        attempt = attempt + 1, updated_at = ?
      WHERE plan_id = ? AND item_id = ? AND phase_id = ?
    `).run(
      input.status, input.receiptRef ?? null, input.workerTaskId ?? null, now(),
      input.planId, input.itemId, input.phaseId,
    );
    return { settled: true, alreadySettled: false };
  });
  try {
    return run();
  } catch (error) {
    return { settled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Reducer readiness derived from the JOURNAL — never from caller arrays. */
export function fanoutReducerReady(planId: string): { ready: boolean; missing: LedgerEntry[] } {
  const plan = loadFanoutPlan(planId);
  if (!plan) return { ready: false, missing: [] };
  const completed: LedgerEntry[] = listFanoutActivations(planId)
    .filter((a) => a.status === 'done')
    .map((a) => ({ itemId: a.itemId, phaseId: a.phaseId }));
  const verdict = reducerReady({ plan: plan.durable, completed });
  return { ready: verdict.ready, missing: verdict.missing };
}

/**
 * The once-only reducer lease: an atomic claim in SQLite, granted only when
 * the journal itself says every required settlement exists. Two drains, a
 * restart replay, and a concurrent scheduler tick can all ask; exactly one
 * caller ever holds it.
 */
export function acquireFanoutReducerLease(planId: string, owner: string): boolean {
  if (!fanoutReducerReady(planId).ready) return false;
  try {
    const result = db().prepare(`
      UPDATE plans SET reducer_lease_owner = ?, updated_at = ?
      WHERE plan_id = ? AND status = 'active' AND reducer_lease_owner IS NULL
    `).run(owner, now(), planId);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/** Terminal: the reducer ran and its output is committed. Exactly once. */
export function markFanoutReduced(planId: string, owner: string, reducerTaskId?: string): boolean {
  try {
    const result = db().prepare(`
      UPDATE plans SET status = 'reduced', reducer_task_id = COALESCE(?, reducer_task_id), updated_at = ?
      WHERE plan_id = ? AND status = 'active' AND reducer_lease_owner = ?
    `).run(reducerTaskId ?? null, now(), planId, owner);
    return result.changes > 0;
  } catch {
    return false;
  }
}

const WORKER_PROMPT_ITEM_CAP = 300;

function windowWorkerPrompt(plan: FanoutPlanRow, windowIndex: number, itemIds: string[]): string {
  const phases = plan.durable.requiredPhases.join(', ');
  const shown = itemIds.slice(0, WORKER_PROMPT_ITEM_CAP);
  return [
    `Objective: ${plan.objective}`,
    '',
    `You are worker window ${windowIndex + 1} of durable fan-out plan ${plan.planId}.`,
    `Process EVERY item below through phase(s): ${phases}. For each item you finish, call`,
    `fanout_settle_item with plan_id="${plan.planId}", the item_id, the phase_id, and status`,
    `"done" (or "failed" with a receipt note if the item genuinely cannot be processed).`,
    'An item already settled by a previous attempt returns alreadySettled — skip it and move on;',
    'never redo settled work. The reducer runs automatically once every item and phase has settled.',
    '',
    `Items (${itemIds.length}):`,
    ...shown.map((id) => `- ${id}`),
    ...(itemIds.length > shown.length
      ? [`…and ${itemIds.length - shown.length} more — call fanout_list_open_items with plan_id="${plan.planId}" to page through the remainder.`]
      : []),
  ].join('\n');
}

export interface ScheduledFanout {
  planId: string;
  workerTasks: BackgroundTaskRecord[];
  skippedWindows: number[];
}

/**
 * Compile the plan's windows into REAL durable background tasks on the mature
 * scheduler. Restart-safe and idempotent: a window whose items are already
 * fully settled is skipped, and a window that already owns a live worker task
 * is not forked. Bounded concurrency, retries, checkpointing, and report-back
 * belong to the scheduler that runs every other background task.
 */
export function scheduleDurableFanout(
  planId: string,
  options: { source?: BackgroundTaskRecord['source']; channel?: string; userId?: string } = {},
): ScheduledFanout | null {
  const plan = loadFanoutPlan(planId);
  if (!plan || plan.status !== 'active') return null;
  const activations = listFanoutActivations(planId);
  const byItem = new Map<string, FanoutActivationRow[]>();
  for (const activation of activations) {
    const rows = byItem.get(activation.itemId) ?? [];
    rows.push(activation);
    byItem.set(activation.itemId, rows);
  }
  const database = db();
  const workerTasks: BackgroundTaskRecord[] = [];
  const skippedWindows: number[] = [];
  for (const window of plan.durable.windows) {
    const open = window.itemIds.filter((itemId) => {
      const rows = byItem.get(itemId) ?? [];
      return rows.some((row) => row.status !== 'done');
    });
    if (open.length === 0) { skippedWindows.push(window.index); continue; }
    // One live worker per window: if any open activation in this window
    // already names a worker task, the window is owned (the scheduler's
    // restart recovery resumes that task; forking a second would double-run).
    const owned = window.itemIds.some((itemId) => (byItem.get(itemId) ?? [])
      .some((row) => row.status !== 'done' && row.workerTaskId));
    if (owned) { skippedWindows.push(window.index); continue; }
    const task = enqueueDurableChatTask({
      message: `${plan.objective} — window ${window.index + 1}/${plan.durable.windows.length}`,
      composedPrompt: windowWorkerPrompt(plan, window.index, open),
      // Report-back needs an origin chat; a plan admitted without one (a cron
      // sweep) still runs — its terminal is notification-only, same as every
      // other sessionless background task.
      sessionId: plan.originSessionId ?? `fanout:${plan.planId}`,
      source: options.source ?? 'desktop',
      channel: options.channel,
      userId: options.userId,
      goal: {
        objective: `Settle ${open.length} item(s) of plan ${plan.planId}, window ${window.index + 1}`,
      },
    });
    workerTasks.push(task);
    const bind = database.prepare(`
      UPDATE activations SET worker_task_id = ?, updated_at = ?
      WHERE plan_id = ? AND item_id = ? AND status != 'done'
    `);
    for (const itemId of open) bind.run(task.id, now(), planId, itemId);
  }
  return { planId, workerTasks, skippedWindows };
}

/**
 * Boot/idle reconciliation: windows whose worker died without settling are
 * re-scheduled (completed settlements are reused — the journal is the memory,
 * not the worker), and a plan whose journal is complete gets its reducer.
 * Idempotent by the same guards scheduling and the lease already enforce.
 */
export function reconcileDurableFanout(input: {
  /** Is this worker task id still alive (queued/running) on the scheduler? */
  workerTaskAlive: (taskId: string) => boolean;
  runReducer: (plan: FanoutPlanRow) => void;
  reducerOwner?: string;
}): { rescheduled: string[]; reduced: string[] } {
  const database = db();
  const rescheduled: string[] = [];
  const reduced: string[] = [];
  const plans = (database.prepare("SELECT * FROM plans WHERE status = 'active'").all() as
    Array<Record<string, unknown>>).map(hydratePlan).filter((p): p is FanoutPlanRow => p !== null);
  for (const plan of plans) {
    // A dead worker releases its window: clear the binding so scheduling can
    // re-enqueue exactly the unsettled remainder.
    const open = listFanoutActivations(plan.planId).filter((a) => a.status !== 'done');
    const deadWorkers = new Set(
      open.map((a) => a.workerTaskId).filter((id): id is string => Boolean(id))
        .filter((id) => !input.workerTaskAlive(id)),
    );
    if (deadWorkers.size > 0) {
      const clear = database.prepare(`
        UPDATE activations SET worker_task_id = NULL, updated_at = ?
        WHERE plan_id = ? AND worker_task_id = ? AND status != 'done'
      `);
      for (const dead of deadWorkers) clear.run(now(), plan.planId, dead);
      const scheduled = scheduleDurableFanout(plan.planId);
      if (scheduled && scheduled.workerTasks.length > 0) rescheduled.push(plan.planId);
    }
    const owner = input.reducerOwner ?? `reconcile-${getMachineId()}`;
    if (acquireFanoutReducerLease(plan.planId, owner)) {
      try {
        input.runReducer(loadFanoutPlan(plan.planId)!);
        markFanoutReduced(plan.planId, owner);
        reduced.push(plan.planId);
      } catch {
        // The lease stays held: a crashed reducer is visible (owner set,
        // status active) and is exactly what operator repair tooling reads.
      }
    }
  }
  return { rescheduled, reduced };
}

/**
 * Admit the plan's reducer as ONE durable background task — callable from any
 * settlement or reconciliation path, any number of times, on any process: the
 * journal-derived readiness check plus the atomic lease admit it exactly once.
 * The reducer task itself is durable (scheduler-recovered, report-back bound),
 * so `reduced` here means "reduction admitted and owned", with the task id on
 * the plan row as the durable pointer to its terminal.
 */
export function maybeAdmitFanoutReducer(
  planId: string,
  options: { owner?: string; source?: BackgroundTaskRecord['source']; channel?: string; userId?: string } = {},
): BackgroundTaskRecord | null {
  const owner = options.owner ?? `reducer-${getMachineId()}`;
  if (!acquireFanoutReducerLease(planId, owner)) return null;
  const plan = loadFanoutPlan(planId);
  if (!plan) return null;
  const settled = listFanoutActivations(planId).filter((a) => a.status === 'done');
  const receipts = settled.filter((a) => a.receiptRef).slice(0, 200)
    .map((a) => `- ${a.itemId} × ${a.phaseId}: ${a.receiptRef}`);
  const task = enqueueDurableChatTask({
    message: `Combine the results of "${plan.objective}"`,
    composedPrompt: [
      `Objective: ${plan.objective}`,
      '',
      `Every item and phase of durable fan-out plan ${plan.planId} has settled `
      + `(${settled.length} settlement(s)). Produce the combined result the user asked for `
      + `(output contract: ${plan.durable.reducerId} → ${plan.manifest.manifest?.reducer.outputContract ?? 'report@1'}) `
      + 'from the durable settlements below and report it back. Do not reprocess items.',
      '',
      'Settlement receipts:',
      ...(receipts.length > 0 ? receipts : ['(no per-item receipts were recorded — summarize from the plan objective and settled item ids)']),
    ].join('\n'),
    sessionId: plan.originSessionId ?? `fanout:${plan.planId}`,
    source: options.source ?? 'desktop',
    channel: options.channel,
    userId: options.userId,
    goal: { objective: `Reduce plan ${plan.planId} to its combined result` },
  });
  markFanoutReduced(planId, owner, task.id);
  return task;
}
