/**
 * Production durable fan-out (C-series, R2): an admitted WorkDisposition
 * becomes REAL work on the mature background scheduler, with an item×phase
 * journal, claimed worker windows, and a reducer lifecycle that outlive any
 * process.
 *
 * The authority boundaries, each one a review finding when it was soft:
 *
 *   - PLAN IDENTITY is the complete normalized admitted contract plus the
 *     accepted session/source/attempt. Two different manifests dispatched in
 *     one turn are two plans; a byte-identical replay rejoins.
 *   - LEDGER identity is encoded tuples end to end — no delimited string an
 *     adversarial id could forge.
 *   - PHASE DEPENDENCIES are enforced at settlement, durably. A dependent
 *     phase cannot settle for an item whose prerequisite has not.
 *   - WINDOWS are claimed atomically before task creation and carry a
 *     generation; the settle/list tools authenticate the CALLING worker and
 *     scope it to its own window — one worker cannot settle another's items.
 *   - REPORTING is plan-level: internal windows are silent; the user gets one
 *     kickoff, aggregate progress via the activity projection, and ONE
 *     reducer terminal on the originating delivery route, which is persisted
 *     on the plan.
 *   - The REDUCER has a lifecycle (ready→leased→admitted→running→
 *     completed/failed) with lease recovery and bounded retry. Enqueueing is
 *     admission, never completion.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { updateLinkedFocusAction } from '../memory/focus.js';
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
import {
  createBackgroundTask,
  requestBackgroundDrain,
  type BackgroundTaskRecord,
} from './background-tasks.js';
import { checkpointCapsuleForSession } from './continuation-capsule.js';

export type FanoutPlanStatus = 'active' | 'reduced' | 'failed' | 'superseded';
export type FanoutActivationStatus = 'pending' | 'running' | 'done' | 'failed';
export type FanoutReducerState = 'ready' | 'leased' | 'admitted' | 'running' | 'completed' | 'failed';
export type FanoutWindowStatus = 'unclaimed' | 'claimed' | 'done' | 'failed';

export interface FanoutDeliveryRoute {
  source?: BackgroundTaskRecord['source'];
  channel?: string;
  userId?: string;
}

export interface FanoutPlanRow {
  planId: string;
  objective: string;
  manifest: WorkDisposition;
  durable: DurableWorkPlan;
  /** The complete admitted contract as the dispatch supplied it (agreed plan
   *  text, criteria, context refs, ceiling, duration, route, …). */
  contract: Record<string, unknown>;
  originSessionId: string | null;
  sourceUserSeq: number | null;
  attemptId: string | null;
  route: FanoutDeliveryRoute;
  status: FanoutPlanStatus;
  reducerState: FanoutReducerState | null;
  reducerLeaseOwner: string | null;
  reducerLeasedAt: string | null;
  reducerAttempts: number;
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

export interface FanoutWindowRow {
  planId: string;
  windowIndex: number;
  generation: number;
  itemIds: string[];
  status: FanoutWindowStatus;
  workerTaskId: string | null;
  runSessionId: string | null;
  attempts: number;
  updatedAt: string;
}

/** A window that died this many times is not coming back on its own. */
const WINDOW_RETRY_CAP = 3;
const REDUCER_RETRY_CAP = 3;
/** A held-but-silent reducer lease older than this is recoverable. */
const REDUCER_LEASE_TTL_MS = 10 * 60_000;

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
  // Pre-release store: an earlier shape (no windows table / no contract
  // column) rebuilds in place — plans are re-admittable evidence.
  const havePlans = (handle.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
  ).get() as { n: number }).n > 0;
  if (havePlans) {
    const columns = (handle.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (!columns.includes('contract_json') || !columns.includes('reducer_state')) {
      handle.exec('DROP TABLE IF EXISTS plans; DROP TABLE IF EXISTS activations; DROP TABLE IF EXISTS windows;');
    }
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      plan_id             TEXT PRIMARY KEY,
      objective           TEXT NOT NULL,
      manifest_json       TEXT NOT NULL,
      durable_json        TEXT NOT NULL,
      contract_json       TEXT NOT NULL,
      origin_session_id   TEXT,
      source_user_seq     INTEGER,
      attempt_id          TEXT,
      route_json          TEXT NOT NULL DEFAULT '{}',
      status              TEXT NOT NULL CHECK (status IN ('active','reduced','failed','superseded')),
      reducer_state       TEXT CHECK (reducer_state IN ('ready','leased','admitted','running','completed','failed')),
      reducer_lease_owner TEXT,
      reducer_leased_at   TEXT,
      reducer_attempts    INTEGER NOT NULL DEFAULT 0,
      reducer_task_id     TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS windows (
      plan_id       TEXT NOT NULL,
      window_index  INTEGER NOT NULL,
      generation    INTEGER NOT NULL DEFAULT 0,
      items_json    TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('unclaimed','claimed','done','failed')),
      worker_task_id TEXT,
      run_session_id TEXT,
      attempts      INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (plan_id, window_index)
    );
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

/** Sorted-key canonical JSON, so identical contracts digest identically. */
function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(canonical(value));
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
      contract: JSON.parse(String(raw.contract_json)) as Record<string, unknown>,
      originSessionId: (raw.origin_session_id as string | null) ?? null,
      sourceUserSeq: (raw.source_user_seq as number | null) ?? null,
      attemptId: (raw.attempt_id as string | null) ?? null,
      route: JSON.parse(String(raw.route_json ?? '{}')) as FanoutDeliveryRoute,
      status: raw.status as FanoutPlanStatus,
      reducerState: (raw.reducer_state as FanoutReducerState | null) ?? null,
      reducerLeaseOwner: (raw.reducer_lease_owner as string | null) ?? null,
      reducerLeasedAt: (raw.reducer_leased_at as string | null) ?? null,
      reducerAttempts: Number(raw.reducer_attempts ?? 0),
      reducerTaskId: (raw.reducer_task_id as string | null) ?? null,
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
    };
  } catch {
    return null;
  }
}

function hydrateWindow(raw: Record<string, unknown>): FanoutWindowRow | null {
  try {
    return {
      planId: String(raw.plan_id),
      windowIndex: Number(raw.window_index),
      generation: Number(raw.generation ?? 0),
      itemIds: JSON.parse(String(raw.items_json)) as string[],
      status: raw.status as FanoutWindowStatus,
      workerTaskId: (raw.worker_task_id as string | null) ?? null,
      runSessionId: (raw.run_session_id as string | null) ?? null,
      attempts: Number(raw.attempts ?? 0),
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

export interface FanoutAdmissionInput {
  originSessionId?: string;
  sourceUserSeq?: number;
  attemptId?: string;
  controls?: DispositionControls;
  /** The originating delivery route — persisted on the plan and reused for
   *  reducer admission, restart recovery, and final delivery. */
  route?: FanoutDeliveryRoute;
  /** The rest of the agreed contract (plan text, context refs, duration…). */
  contract?: Record<string, unknown>;
}

/**
 * Admit a typed disposition into the durable journal: validation through the
 * shared admission (typed clarification and structural refusals pass through
 * verbatim), then ONE transaction writes the immutable plan contract, every
 * item×phase journal row, and every unclaimed window.
 */
export function admitDurableFanoutPlan(
  proposed: WorkDisposition,
  input: FanoutAdmissionInput = {},
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

  const contract = {
    disposition,
    ...(input.contract ?? {}),
    route: input.route ?? {},
  };
  // Identity = the COMPLETE normalized contract + the accepted activation. A
  // model-authored manifestId is not unique; the contract is. Same bytes,
  // same accepted turn → the same plan (a retried tool call rejoins).
  const planId = `fp_${sha256(JSON.stringify([
    canonicalJson(contract),
    input.originSessionId ?? '',
    input.sourceUserSeq ?? null,
    input.attemptId ?? '',
  ])).slice(0, 32)}`;
  const at = now();

  const database = db();
  const write = database.transaction((): FanoutPlanRow => {
    const existing = database.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId) as
      | Record<string, unknown> | undefined;
    if (existing) {
      const hydrated = hydratePlan(existing);
      if (hydrated) return hydrated;
      throw new Error(`plan ${planId} exists but does not hydrate`);
    }
    database.prepare(`
      INSERT INTO plans (
        plan_id, objective, manifest_json, durable_json, contract_json,
        origin_session_id, source_user_seq, attempt_id, route_json,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      planId, disposition.objective, JSON.stringify(disposition), JSON.stringify(durable),
      JSON.stringify(contract), input.originSessionId ?? null, input.sourceUserSeq ?? null,
      input.attemptId ?? null, JSON.stringify(input.route ?? {}), at, at,
    );
    const insertActivation = database.prepare(`
      INSERT INTO activations (plan_id, item_id, phase_id, status, attempt, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?)
    `);
    const insertWindow = database.prepare(`
      INSERT INTO windows (plan_id, window_index, generation, items_json, status, attempts, updated_at)
      VALUES (?, ?, 0, ?, 'unclaimed', 0, ?)
    `);
    for (const window of durable.windows) {
      insertWindow.run(planId, window.index, JSON.stringify(window.itemIds), at);
      for (const itemId of window.itemIds) {
        for (const phaseId of durable.requiredPhases) insertActivation.run(planId, itemId, phaseId, at);
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

export function listFanoutPlans(status?: FanoutPlanStatus): FanoutPlanRow[] {
  const raws = (status
    ? db().prepare('SELECT * FROM plans WHERE status = ?').all(status)
    : db().prepare('SELECT * FROM plans').all()) as Array<Record<string, unknown>>;
  return raws.map(hydratePlan).filter((p): p is FanoutPlanRow => p !== null);
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

export function listFanoutWindows(planId: string): FanoutWindowRow[] {
  const raws = db().prepare('SELECT * FROM windows WHERE plan_id = ? ORDER BY window_index').all(planId) as
    Array<Record<string, unknown>>;
  return raws.map(hydrateWindow).filter((w): w is FanoutWindowRow => w !== null);
}

/** The reducer's paged read over EVERY durable settlement — no cap that would
 *  quietly summarize a subset. */
export function listFanoutSettlements(
  planId: string,
  options: { offset?: number; limit?: number } = {},
): Array<{ itemId: string; phaseId: string; receiptRef: string | null; updatedAt: string }> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const raws = db().prepare(`
    SELECT item_id, phase_id, receipt_ref, updated_at FROM activations
    WHERE plan_id = ? AND status = 'done'
    ORDER BY item_id, phase_id LIMIT ? OFFSET ?
  `).all(planId, limit, offset) as Array<Record<string, unknown>>;
  return raws.map((raw) => ({
    itemId: String(raw.item_id),
    phaseId: String(raw.phase_id),
    receiptRef: (raw.receipt_ref as string | null) ?? null,
    updatedAt: String(raw.updated_at),
  }));
}

export type FanoutSettlement =
  | { settled: true; alreadySettled: boolean }
  | { settled: false; reason: string };

/**
 * Settle ONE item×phase. Idempotent CAS with durable dependency enforcement:
 * a terminal `done` never regresses, a retry observes `alreadySettled`, and a
 * phase whose prerequisites have not settled FOR THIS ITEM is refused — the
 * dependency lives in the journal, not in worker prose.
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
    // Durable dependency gate: every prerequisite phase must be done for
    // THIS item before a dependent phase may settle.
    const plan = loadFanoutPlan(input.planId);
    const phase = plan?.manifest.manifest?.phases.find((p) => p.id === input.phaseId);
    for (const dependency of phase?.dependsOn ?? []) {
      const prerequisite = database.prepare(
        'SELECT status FROM activations WHERE plan_id = ? AND item_id = ? AND phase_id = ?',
      ).get(input.planId, input.itemId, dependency) as { status: string } | undefined;
      if (prerequisite?.status !== 'done') {
        return {
          settled: false,
          reason: `phase "${input.phaseId}" depends on "${dependency}", which has not settled for this item`,
        };
      }
    }
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
    const settlement = run();
    // An item settling is a durable lifecycle boundary for the continuation
    // capsule too: a resume that still reads the pre-settlement capsule would
    // redo this item. Best-effort and strictly after the CAS commits — the
    // settlement is authoritative whether or not the capsule rewrite succeeds.
    if (settlement.settled && !settlement.alreadySettled) {
      try {
        const plan = loadFanoutPlan(input.planId);
        if (plan?.originSessionId) {
          checkpointCapsuleForSession(plan.originSessionId, plan.sourceUserSeq ?? undefined);
        }
      } catch { /* bookkeeping must never fail a committed settlement */ }
    }
    return settlement;
  } catch (error) {
    return { settled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The window (if any) the calling run session currently owns on this plan. */
export function windowAuthorityFor(planId: string, callerRunSessionId: string): FanoutWindowRow | null {
  if (!callerRunSessionId) return null;
  const raw = db().prepare(
    "SELECT * FROM windows WHERE plan_id = ? AND run_session_id = ? AND status = 'claimed'",
  ).get(planId, callerRunSessionId) as Record<string, unknown> | undefined;
  return raw ? hydrateWindow(raw) : null;
}

/**
 * Window-authenticated settlement — the form the worker TOOLS use. The caller
 * is identified by its run session; it may settle only items inside the
 * window its task currently owns, at the window's current generation.
 */
export function settleFanoutActivationAs(input: {
  planId: string;
  itemId: string;
  phaseId: string;
  status: 'done' | 'failed';
  receiptRef?: string;
  callerRunSessionId: string;
}): FanoutSettlement {
  const authority = windowAuthorityFor(input.planId, input.callerRunSessionId);
  if (!authority) {
    return { settled: false, reason: 'the calling worker owns no claimed window of this plan' };
  }
  if (!authority.itemIds.includes(input.itemId)) {
    return { settled: false, reason: 'the item belongs to another worker’s window' };
  }
  return settleFanoutActivation({
    planId: input.planId,
    itemId: input.itemId,
    phaseId: input.phaseId,
    status: input.status,
    ...(input.receiptRef ? { receiptRef: input.receiptRef } : {}),
    ...(authority.workerTaskId ? { workerTaskId: authority.workerTaskId } : {}),
  });
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
 * The once-only reducer lease, with expiry recovery: granted only when the
 * journal says every required settlement exists, only on an active plan, and
 * only when no LIVE lease is held. A lease whose holder went silent past the
 * TTL — or whose reduction FAILED — is recoverable for a bounded retry.
 */
export function acquireFanoutReducerLease(planId: string, owner: string): boolean {
  if (!fanoutReducerReady(planId).ready) return false;
  const staleBefore = new Date(Date.now() - REDUCER_LEASE_TTL_MS).toISOString();
  try {
    const result = db().prepare(`
      UPDATE plans SET reducer_lease_owner = ?, reducer_leased_at = ?, reducer_state = 'leased', updated_at = ?
      WHERE plan_id = ? AND status = 'active'
        AND reducer_attempts < ${REDUCER_RETRY_CAP}
        AND (
          reducer_lease_owner IS NULL
          OR reducer_state = 'failed'
          OR (reducer_state IN ('leased','admitted','running') AND reducer_leased_at < ?)
        )
    `).run(owner, now(), now(), planId, staleBefore);
    return result.changes > 0;
  } catch {
    return false;
  }
}

const WORKER_PROMPT_ITEM_CAP = 300;

function windowWorkerPrompt(plan: FanoutPlanRow, window: FanoutWindowRow, openItems: string[]): string {
  const phases = plan.durable.requiredPhases.join(', ');
  const shown = openItems.slice(0, WORKER_PROMPT_ITEM_CAP);
  return [
    `Objective: ${plan.objective}`,
    '',
    `You are the worker for window ${window.windowIndex + 1} of durable fan-out plan ${plan.planId}.`,
    `Process EVERY item below through phase(s) in order: ${phases}. For each item and phase you`,
    `finish, call fanout_settle_item with plan_id="${plan.planId}", the item_id, the phase_id, and`,
    'status "done" (or "failed" with a receipt note if the item genuinely cannot be processed).',
    'Settlement is bound to YOUR window — items outside it are other workers\' work and will refuse.',
    'An item already settled by a previous attempt returns alreadySettled — skip it, never redo it.',
    'The combined result is produced by the plan reducer after every window settles; do not report',
    'results to the user yourself.',
    '',
    `Your items (${openItems.length}):`,
    ...shown.map((id) => `- ${id}`),
    ...(openItems.length > shown.length
      ? [`…and ${openItems.length - shown.length} more — call fanout_list_open_items with plan_id="${plan.planId}" to page through the remainder.`]
      : []),
  ].join('\n');
}

export interface ScheduledFanout {
  planId: string;
  workerTasks: BackgroundTaskRecord[];
  skippedWindows: number[];
}

/**
 * Claim windows atomically and materialize one INTERNAL background task per
 * claimed window. Idempotent: a fully-settled window closes, a claimed window
 * is skipped, and only an unclaimed/failed window (below the retry cap) is
 * claimed — generation increments on every claim so a dead worker's stale
 * authority can never settle into a newer generation's window.
 */
export function scheduleDurableFanout(planId: string): ScheduledFanout | null {
  const plan = loadFanoutPlan(planId);
  if (!plan || plan.status !== 'active') return null;
  const database = db();
  const activations = listFanoutActivations(planId);
  const doneByItem = new Map<string, number>();
  for (const a of activations) {
    if (a.status === 'done') doneByItem.set(a.itemId, (doneByItem.get(a.itemId) ?? 0) + 1);
  }
  const phaseCount = plan.durable.requiredPhases.length;
  const workerTasks: BackgroundTaskRecord[] = [];
  const skippedWindows: number[] = [];

  for (const window of listFanoutWindows(planId)) {
    const open = window.itemIds.filter((itemId) => (doneByItem.get(itemId) ?? 0) < phaseCount);
    if (open.length === 0) {
      database.prepare("UPDATE windows SET status = 'done', updated_at = ? WHERE plan_id = ? AND window_index = ?")
        .run(now(), planId, window.windowIndex);
      skippedWindows.push(window.windowIndex);
      continue;
    }
    if (window.status === 'claimed') { skippedWindows.push(window.windowIndex); continue; }
    if (window.attempts >= WINDOW_RETRY_CAP) { skippedWindows.push(window.windowIndex); continue; }
    // Atomic claim BEFORE task creation: the generation bump plus the status
    // CAS means two schedulers cannot both own this window.
    const claimed = database.prepare(`
      UPDATE windows SET status = 'claimed', generation = generation + 1,
        attempts = attempts + 1, updated_at = ?
      WHERE plan_id = ? AND window_index = ? AND status IN ('unclaimed','failed')
    `).run(now(), planId, window.windowIndex);
    if (claimed.changes !== 1) { skippedWindows.push(window.windowIndex); continue; }

    const task = createBackgroundTask({
      title: `${plan.objective} — window ${window.windowIndex + 1}/${plan.durable.windows.length}`,
      prompt: windowWorkerPrompt(plan, window, open),
      // INTERNAL: no origin chat, no per-window report-back, no completion
      // notification. The plan owns every user-visible message.
      internal: true,
      source: plan.route.source ?? 'gateway',
    });
    database.prepare(`
      UPDATE windows SET worker_task_id = ?, run_session_id = ?, updated_at = ?
      WHERE plan_id = ? AND window_index = ?
    `).run(task.id, task.runSessionId, now(), planId, window.windowIndex);
    const bind = database.prepare(`
      UPDATE activations SET worker_task_id = ?, updated_at = ?
      WHERE plan_id = ? AND item_id = ? AND status != 'done'
    `);
    for (const itemId of open) bind.run(task.id, now(), planId, itemId);
    workerTasks.push(task);
  }
  if (workerTasks.length > 0) requestBackgroundDrain(workerTasks.length);
  return { planId, workerTasks, skippedWindows };
}

/**
 * Admit the plan's reducer as ONE durable background task on the plan's
 * PERSISTED delivery route. Admission is a lifecycle step, not completion:
 * the plan closes only when the reducer task actually completes
 * (recordFanoutReducerOutcome), and a failed reduction is retryable under
 * the same bounded lease.
 */
export function maybeAdmitFanoutReducer(
  planId: string,
  options: { owner?: string } = {},
): BackgroundTaskRecord | null {
  const owner = options.owner ?? `reducer-${getMachineId()}`;
  if (!acquireFanoutReducerLease(planId, owner)) return null;
  const plan = loadFanoutPlan(planId);
  if (!plan) return null;
  const settledCount = listFanoutActivations(planId).filter((a) => a.status === 'done').length;
  const task = createBackgroundTask({
    title: `Combine the results of "${plan.objective}"`,
    prompt: [
      `Objective: ${plan.objective}`,
      '',
      `Every item and phase of durable fan-out plan ${plan.planId} has settled `
      + `(${settledCount} settlement(s)). Produce the combined result the user asked for `
      + `(output contract: ${plan.manifest.manifest?.reducer.outputContract ?? 'report@1'}) and report it back.`,
      'Read the settlements with fanout_list_settlements (plan_id, offset, limit) — page through ALL of',
      'them; the journal is the complete record and no prompt excerpt is. Do not reprocess items.',
    ].join('\n'),
    ...(plan.originSessionId ? { originSessionId: plan.originSessionId } : {}),
    source: plan.route.source ?? 'gateway',
    ...(plan.route.channel ? { channel: plan.route.channel } : {}),
    ...(plan.route.userId ? { userId: plan.route.userId } : {}),
  });
  try {
    db().prepare(`
      UPDATE plans SET reducer_state = 'admitted', reducer_task_id = ?, updated_at = ?
      WHERE plan_id = ? AND reducer_lease_owner = ?
    `).run(task.id, now(), planId, owner);
  } catch { /* the lease holder records what it can; reconcile repairs */ }
  requestBackgroundDrain(1);
  return task;
}

/** The reducer task's real boundaries drive the lifecycle. */
export function recordFanoutReducerOutcome(
  planId: string,
  input: { taskId: string; outcome: 'running' | 'completed' | 'failed' },
): boolean {
  const database = db();
  try {
    if (input.outcome === 'running') {
      return database.prepare(`
        UPDATE plans SET reducer_state = 'running', updated_at = ?
        WHERE plan_id = ? AND reducer_task_id = ? AND reducer_state = 'admitted'
      `).run(now(), planId, input.taskId).changes > 0;
    }
    if (input.outcome === 'completed') {
      const changed = database.prepare(`
        UPDATE plans SET reducer_state = 'completed', status = 'reduced', updated_at = ?
        WHERE plan_id = ? AND reducer_task_id = ? AND status = 'active'
      `).run(now(), planId, input.taskId).changes > 0;
      if (changed) settleFanoutFocusAction(planId, 'done', 'Combined result delivered.');
      return changed;
    }
    const failed = database.prepare(`
      UPDATE plans SET reducer_state = 'failed', reducer_lease_owner = NULL,
        reducer_attempts = reducer_attempts + 1, updated_at = ?
      WHERE plan_id = ? AND reducer_task_id = ?
    `).run(now(), planId, input.taskId).changes > 0;
    if (failed) {
      const plan = loadFanoutPlan(planId);
      if (plan && plan.reducerAttempts >= REDUCER_RETRY_CAP) {
        database.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE plan_id = ?")
          .run(now(), planId);
        settleFanoutFocusAction(planId, 'blocked', 'The combining step failed repeatedly and needs attention.');
      }
    }
    return failed;
  } catch {
    return false;
  }
}

/** Settle the plan-level focus/project action from PLAN state — never from
 *  per-window task ids the focus row has never heard of. */
function settleFanoutFocusAction(planId: string, status: 'done' | 'blocked', note: string): void {
  try {
    updateLinkedFocusAction(planId, { status, note });
  } catch { /* focus settlement is best-effort */ }
}

/**
 * Reconciliation, for ORDINARY operation and boot alike: release windows
 * whose workers died (bounded retries, then an honest failed plan), map the
 * reducer task's real terminal onto the lifecycle, re-schedule what should
 * run, and admit the reducer when the journal is complete.
 */
export function reconcileDurableFanout(input: {
  /** Live scheduler truth for a task id. */
  taskState?: (taskId: string) => 'alive' | 'done' | 'failed' | 'missing';
  /** Back-compat boot signature: alive/dead only. */
  workerTaskAlive?: (taskId: string) => boolean;
  runReducer?: (plan: FanoutPlanRow) => void;
  reducerOwner?: string;
}): { rescheduled: string[]; reduced: string[]; failedPlans: string[] } {
  const state = input.taskState
    ?? ((taskId: string) => (input.workerTaskAlive?.(taskId) ? 'alive' : 'missing'));
  const database = db();
  const rescheduled: string[] = [];
  const reduced: string[] = [];
  const failedPlans: string[] = [];

  for (const plan of listFanoutPlans('active')) {
    // Dead windows release; a window past its retry cap fails the plan
    // honestly instead of retrying forever.
    let exhausted = false;
    for (const window of listFanoutWindows(plan.planId)) {
      if (window.status !== 'claimed' || !window.workerTaskId) continue;
      const verdict = state(window.workerTaskId);
      if (verdict === 'alive') continue;
      const open = listFanoutActivations(plan.planId)
        .filter((a) => a.status !== 'done' && window.itemIds.includes(a.itemId));
      if (open.length === 0) {
        database.prepare("UPDATE windows SET status = 'done', updated_at = ? WHERE plan_id = ? AND window_index = ?")
          .run(now(), plan.planId, window.windowIndex);
        continue;
      }
      database.prepare(`
        UPDATE windows SET status = 'failed', worker_task_id = NULL, run_session_id = NULL, updated_at = ?
        WHERE plan_id = ? AND window_index = ?
      `).run(now(), plan.planId, window.windowIndex);
      if (window.attempts >= WINDOW_RETRY_CAP) exhausted = true;
    }
    if (exhausted) {
      database.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE plan_id = ?")
        .run(now(), plan.planId);
      settleFanoutFocusAction(plan.planId, 'blocked',
        'A worker window kept failing and the plan needs attention.');
      failedPlans.push(plan.planId);
      continue;
    }

    const scheduled = scheduleDurableFanout(plan.planId);
    if (scheduled && scheduled.workerTasks.length > 0) rescheduled.push(plan.planId);

    // The reducer's own task terminal drives the lifecycle.
    const current = loadFanoutPlan(plan.planId)!;
    if (current.reducerTaskId && (current.reducerState === 'admitted' || current.reducerState === 'running')) {
      const verdict = state(current.reducerTaskId);
      if (verdict === 'done') {
        recordFanoutReducerOutcome(plan.planId, { taskId: current.reducerTaskId, outcome: 'completed' });
      } else if (verdict === 'failed' || verdict === 'missing') {
        recordFanoutReducerOutcome(plan.planId, { taskId: current.reducerTaskId, outcome: 'failed' });
      }
    }

    const after = loadFanoutPlan(plan.planId)!;
    if (after.status === 'active' && fanoutReducerReady(plan.planId).ready
      && (after.reducerState === null || after.reducerState === 'failed')) {
      const task = maybeAdmitFanoutReducer(plan.planId, {
        owner: input.reducerOwner ?? `reconcile-${getMachineId()}`,
      });
      if (task) {
        input.runReducer?.(loadFanoutPlan(plan.planId)!);
        reduced.push(plan.planId);
      }
    }
  }
  return { rescheduled, reduced, failedPlans };
}
