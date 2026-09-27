/**
 * Memory-work journal — the one recorder for background memory jobs.
 *
 * Every memory job (learn, reconcile, patterns, …; see memory-jobs.ts) runs
 * through `runMemoryJob`. While it runs it is listed as running (in this
 * process only: "working" is never inferred from a lease or a schedule). Its
 * model calls carry the job's usage channel (`memory:<job>`), and the ledger
 * hands them back to the job, so the event names the model that actually
 * served, the tokens and the time. When the run is worth recording (a model
 * call happened, something changed, it failed) ONE operational event is
 * written with ids only, never fact or conversation text, and the day's
 * per-job counters move in the same transaction.
 *
 * Retention is a cache: detailed events live 7 days, daily counters 90 days,
 * then both are deleted on a persisted hourly clock (`sweepMemoryWorkIfDue`).
 *
 * A job can run inside another (learning a conversation settles each new
 * memory through a reconcile run). The nested run's calls, tokens and time
 * are its own; what it changed is not counted again, because the enclosing
 * run reports the outcome of the whole run. Its event says `nestedIn`. A run
 * that finishes after the run it started in (detached work) is its own.
 *
 * Observability never breaks or slows a job: every write is guarded and
 * synchronous, nothing here awaits the network.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { memoryJobChannel, type MemoryJobId } from './memory-jobs.js';
import type {
  MemoryModelProblem,
  MemoryWorkOutcome,
  MemoryWorkProduced,
  MemoryWorkRunning,
  MemoryWorkSource,
  MemoryWorkWaiting,
} from './memory-work-types.js';
import { MEMORY_WORK_PRODUCED_KEYS } from './memory-work-types.js';
import {
  openOperationalTelemetryDb,
  recordOperationalEvent,
  type OperationalEventType,
} from '../runtime/operational-telemetry.js';
import {
  modelUsageAttributionStorage,
  usageRoleFromChannel,
  withModelUsageAttribution,
  withModelUsageObserver,
  type ModelUsageAttributionContext,
  type ObservedModelUsage,
} from '../runtime/usage-log.js';
import { readRouteStandIn, withModelRouteObserver, type ObservedModelRoute } from '../runtime/model-route-metrics.js';
import { classifyModelError } from '../runtime/harness/resilient-model.js';
import { BoundaryError } from '../runtime/boundary-error.js';
import { isAuthRecoverableError } from '../execution/transient-error.js';
import { isProviderCreditRefusal } from '../shared/provider-capacity.js';

/** Detail events age out after `detailDays`; daily counters after `summaryDays`. */
export const MEMORY_WORK_RETENTION = Object.freeze({ detailDays: 7, summaryDays: 90 });

export const MEMORY_WORK_EVENT_TYPES = ['memory_work_completed', 'memory_work_failed'] as const satisfies readonly OperationalEventType[];

/** A waiting note older than this is stale: the learn drain re-states it on
 *  every pass (about once a minute), so silence means it stopped applying. */
export const MEMORY_WORK_WAITING_FRESH_MS = 3 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const RETENTION_SWEEP_EVERY_MS = 60 * 60_000;
const RETENTION_STAMP_KEY = 'retention_swept_at';

export interface MemoryJobRunOptions {
  /** conversation/workflow/owner/schedule/tool + sessionId. */
  source?: MemoryWorkSource | null;
  part?: number;
  parts?: number;
  /** Requested model for this run (from resolveMemoryModelRoute), to tell a stand-in. */
  requestedModelId?: string | null;
}

export interface MemoryJobFacts {
  learned?: string[];
  updated?: string[];
  reinforced?: string[];
  faded?: string[];
  restored?: string[];
}

export interface MemoryJobOutcome {
  outcome: MemoryWorkOutcome;
  produced?: MemoryWorkProduced;
  facts?: MemoryJobFacts;
  failure?: { problem: MemoryModelProblem } | null;
  /** Record even when nothing changed and no model ran (default false: such a
   *  run only refreshes the job's in-memory "last checked"). */
  record?: boolean;
}

/** What one recorded event carries, as stored in `payload_json`. Token counts
 *  sit at the top level on purpose: the telemetry redactor keeps numeric
 *  `*Tokens` keys only there (a nested `inputTokens` reads as a secret name). */
export interface MemoryWorkEventPayload {
  job: MemoryJobId;
  /** This run's own id; a run nested in it names it in `nestedIn`. */
  runId?: string;
  /** Set when the run happened inside another memory job's run. Its produced
   *  counts are not added to the day's counters (the enclosing run reports
   *  them), and undo leaves the ids the enclosing run lists to that run. */
  nestedIn?: { job: MemoryJobId; runId: string };
  outcome: MemoryWorkOutcome;
  startedAt: string;
  durationMs: number;
  model: { modelId: string; requestedModelId: string | null; standIn: boolean } | null;
  usage: { calls: number; modelMs?: number };
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  produced: MemoryWorkProduced;
  facts: MemoryJobFacts | null;
  source: { kind: MemoryWorkSource['kind']; sessionId?: string } | null;
  part?: number;
  parts?: number;
  failure: { problem: MemoryModelProblem } | null;
}

interface RunContext {
  job: MemoryJobId;
  opts: MemoryJobRunOptions;
  calls: ObservedModelUsage[];
  /** The routes those calls took: the only evidence of a stand-in. */
  routes: ObservedModelRoute[];
  startedAtMs: number;
  runId?: string;
  nestedIn?: { job: MemoryJobId; runId: string } | null;
}

/** The memory job whose `work` is running in this async context, so a job
 *  started inside it knows it is nested. */
const enclosingRun = new AsyncLocalStorage<{ job: MemoryJobId; runId: string }>();

const runningJobs = new Map<string, MemoryWorkRunning>();
const lastChecked = new Map<MemoryJobId, string>();
let learningWaiting: { value: MemoryWorkWaiting; setAtMs: number } | null = null;
let nextRetentionSweepMs: number | null = null;

// ───────────────────────────── running ─────────────────────────────

/**
 * Run one memory job: listed as running while `work` runs, its model calls
 * attributed to `memory:<job>` (role `memory` for jobs the memory model
 * governs, `reviewer` for the checker's) and observed, then one event
 * recorded from `summarize`.
 *
 * Calls retain a causal parent for total task accounting, but the execution
 * scope names no session and no user turn, so no run budget accrues and no
 * turn-only state (a session's brain pin) is read or stamped; the originating
 * conversation lives in the event's source. A scope opened here replaces any
 * outer one, so the memory channel always wins. A job started inside another
 * job's work is recorded as nested in it (see the module note).
 * The value (or the error) of `work` passes through untouched.
 */
export async function runMemoryJob<T>(
  job: MemoryJobId,
  opts: MemoryJobRunOptions,
  work: () => Promise<T>,
  summarize: (value: T) => MemoryJobOutcome,
): Promise<T> {
  const token = randomUUID();
  const run: RunContext = {
    job, opts, calls: [], routes: [], startedAtMs: Date.now(), runId: token, nestedIn: enclosingRunOf(),
  };
  try {
    runningJobs.set(token, runningEntry(job, new Date(run.startedAtMs).toISOString(), opts));
  } catch { /* the job runs even if it cannot be listed */ }
  try {
    const value = await enclosingRun.run({ job, runId: token }, () =>
      withModelUsageObserver(run.calls, () =>
        withModelRouteObserver(run.routes, () =>
          withModelUsageAttribution(memoryJobAttribution(job, token), work))));
    settle(run, () => summarize(value));
    return value;
  } catch (error) {
    return recordMemoryJobFailure(job, opts, error, run);
  } finally {
    runningJobs.delete(token);
  }
}

/**
 * Record a run that threw, then rethrow the original error. `runMemoryJob`
 * calls this when its work throws; a caller that catches a job's error itself
 * can call it with the calls it observed.
 */
export function recordMemoryJobFailure(
  job: MemoryJobId,
  opts: MemoryJobRunOptions,
  error: unknown,
  observed: {
    calls?: ObservedModelUsage[];
    routes?: ObservedModelRoute[];
    startedAtMs?: number;
    runId?: string;
    nestedIn?: { job: MemoryJobId; runId: string } | null;
  } = {},
): never {
  try {
    const problem = memoryModelProblemFromError(error);
    record({
      job,
      opts,
      calls: observed.calls ?? [],
      routes: observed.routes ?? [],
      startedAtMs: observed.startedAtMs ?? Date.now(),
      runId: observed.runId ?? randomUUID(),
      nestedIn: observed.nestedIn !== undefined ? observed.nestedIn : enclosingRunOf(),
    }, { outcome: 'failed', failure: problem ? { problem } : null }, new Date());
  } catch { /* observability never replaces the job's own error */ }
  throw error;
}

/** Jobs running in THIS process right now, oldest first. */
export function listRunningMemoryJobs(): MemoryWorkRunning[] {
  return [...runningJobs.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((entry) => ({ ...entry, ...(entry.source ? { source: { ...entry.source } } : {}) }));
}

/** The learn drain states, on every pass, why learning is waiting (or null
 *  when it proceeds). */
export function setMemoryLearningWaiting(waiting: MemoryWorkWaiting | null): void {
  learningWaiting = waiting ? { value: { ...waiting }, setAtMs: Date.now() } : null;
}

/** Why learning waits right now, or null. A note the drain has not re-stated
 *  for `MEMORY_WORK_WAITING_FRESH_MS` no longer applies. */
export function readMemoryLearningWaiting(now: Date = new Date()): MemoryWorkWaiting | null {
  if (!learningWaiting) return null;
  if (now.getTime() - learningWaiting.setAtMs > MEMORY_WORK_WAITING_FRESH_MS) return null;
  return { ...learningWaiting.value };
}

/** When each job last ran without anything worth recording (this process). */
export function lastCheckedByJob(): Partial<Record<MemoryJobId, string>> {
  return Object.fromEntries(lastChecked) as Partial<Record<MemoryJobId, string>>;
}

/**
 * The model-error class memory work acts on: the shared classifier, plus a
 * missing or expired sign-in. The app's own sign-in errors carry no HTTP
 * status, so the shared classifier reads them as the job's own failure; for
 * memory they mean the model is out of reach (the extractor pauses, and a
 * part waits instead of spending its try). The canonical auth rule decides.
 */
export function classifyMemoryModelError(error: unknown): ReturnType<typeof classifyModelError> {
  const cls = classifyModelError(error);
  if (cls.kind === 'runtime.unknown' && isAuthRecoverableError(error)) {
    return { ...cls, retryable: true, kind: 'model.auth_expired', isAuth: true };
  }
  return cls;
}

/**
 * The problem class of a thrown model error, in the Memory tab's words. The
 * one classifier for memory work: the extractor's pause names its problem
 * with it too, so the waiting note and the failed event agree. Never a
 * provider name. Null when the error is not the model's: a failure in the
 * job's own code (a type or database error) must not read as "the model
 * returned an error".
 */
export function memoryModelProblemFromError(error: unknown): MemoryModelProblem | null {
  try {
    // The resilient model wrapper already names the model's failure class.
    // Any other boundary kind (a model adapter's own transport timeout, say)
    // goes through the classifier.
    if (error instanceof BoundaryError && error.kind.startsWith('model.')) return problemOfKind(error.kind, error);
    const cls = classifyMemoryModelError(error);
    // An error with no HTTP status that is not a transport failure did not
    // come from a model; one with a status is the provider answering.
    if (cls.kind === 'runtime.unknown') return typeof cls.status === 'number' ? 'error' : null;
    return problemOfKind(cls.kind, error, cls.status);
  } catch {
    return null; // unknown shape: not known to be the model's
  }
}

function problemOfKind(kind: string, error: unknown, status?: number): MemoryModelProblem | null {
  if (kind === 'model.rate_limited') return isProviderCreditRefusal(status, error) ? 'credit' : 'quota';
  if (kind === 'model.auth_expired') return 'not_connected';
  if (kind === 'model.transport_timeout') return 'timeout';
  return kind.startsWith('model.') ? 'error' : null;
}

function runningEntry(job: MemoryJobId, startedAt: string, opts: MemoryJobRunOptions): MemoryWorkRunning {
  const source = publicSource(opts.source);
  return {
    job,
    startedAt,
    ...(source ? { source } : {}),
    ...(positiveInt(opts.part) ? { part: opts.part } : {}),
    ...(positiveInt(opts.parts) ? { parts: opts.parts } : {}),
  };
}

/** No session and no user turn: background work that belongs to no
 *  conversation execution scope. Accounting retains the causal parent, if any,
 *  and always names this job run. The ledger books it by channel; nothing keyed by session
 *  (a run budget, a brain pin) can attach to it. The scope names the role of
 *  whoever does the job's thinking (the memory model's jobs `memory`, the
 *  checker's `reviewer`), so a call that reaches its model through a route
 *  recorded as the brain's (a check that asks for the checker by id) is
 *  still booked as the job's. */
function memoryJobAttribution(job: MemoryJobId, runId: string): ModelUsageAttributionContext {
  const enclosing = modelUsageAttributionStorage.getStore();
  const parent = enclosing && enclosing.sessionId && enclosing.sourceUserSeq > 0
    ? { sessionId: enclosing.sessionId, sourceUserSeq: enclosing.sourceUserSeq, attemptId: enclosing.attemptId }
    : enclosing?.usageParentTurn;
  const channel = memoryJobChannel(job);
  const role = usageRoleFromChannel(channel);
  return {
    sessionId: '',
    sourceUserSeq: 0,
    usageJobId: `memory:${job}:${runId}`,
    ...(parent ? { usageParentTurn: parent } : {}),
    channel,
    ...(role ? { role } : {}),
  };
}

function enclosingRunOf(): { job: MemoryJobId; runId: string } | null {
  const outer = enclosingRun.getStore();
  return outer ? { job: outer.job, runId: outer.runId } : null;
}

function settle(run: RunContext, summarize: () => MemoryJobOutcome): void {
  let outcome: MemoryJobOutcome;
  try {
    outcome = summarize();
  } catch {
    // The job succeeded; only its summary broke. Record what is known.
    outcome = { outcome: 'ok' };
  }
  try {
    record(run, outcome, new Date());
  } catch { /* observability never breaks the job */ }
}

// ───────────────────────────── recording ─────────────────────────────

function record(run: RunContext, result: MemoryJobOutcome, completedAt: Date): void {
  // Nested only if the enclosing run is still running: it can report what
  // finished inside it, never work that outlived it (a detached job).
  if (run.nestedIn && !runningJobs.has(run.nestedIn.runId)) run.nestedIn = null;
  const produced = cleanProduced(result.produced);
  const facts = cleanFacts(result.facts);
  const failed = result.outcome === 'failed';
  const changed = Object.values(produced).some((n) => typeof n === 'number' && n > 0) || facts !== null;
  if (!(run.calls.length > 0 || changed || failed || result.record === true)) {
    if (result.outcome !== 'waiting') lastChecked.set(run.job, completedAt.toISOString());
    return;
  }
  const db = openOperationalTelemetryDb();
  const payload = eventPayload(run, result, produced, facts, completedAt);
  const type: OperationalEventType = failed ? 'memory_work_failed' : 'memory_work_completed';
  db.transaction(() => {
    const conversations = countsAsNewConversation(db, run, result.outcome, completedAt) ? 1 : 0;
    recordOperationalEvent({
      source: 'memory',
      type,
      severity: failed ? 'warn' : 'info',
      actor: run.job,
      ...(payload.source?.sessionId ? { sessionId: payload.source.sessionId } : {}),
      payload: payload as unknown as Record<string, unknown>,
      now: completedAt,
    }, db);
    upsertDaily(db, payload, completedAt, conversations);
  })();
}

function eventPayload(
  run: RunContext,
  result: MemoryJobOutcome,
  produced: MemoryWorkProduced,
  facts: MemoryJobFacts | null,
  completedAt: Date,
): MemoryWorkEventPayload {
  const calls = run.calls;
  const served = [...calls].reverse().find((call) => call.ok) ?? calls.at(-1);
  const requestedModelId = typeof run.opts.requestedModelId === 'string' && run.opts.requestedModelId.trim()
    ? run.opts.requestedModelId.trim()
    : null;
  const modelMs = calls.reduce((sum, call) => sum + (typeof call.durationMs === 'number' ? call.durationMs : 0), 0);
  const cached = calls.reduce((sum, call) => sum + (typeof call.cachedInputTokens === 'number' ? call.cachedInputTokens : 0), 0);
  const source = publicSource(run.opts.source);
  return {
    job: run.job,
    ...(run.runId ? { runId: run.runId } : {}),
    ...(run.nestedIn ? { nestedIn: { job: run.nestedIn.job, runId: run.nestedIn.runId } } : {}),
    outcome: result.outcome,
    startedAt: new Date(run.startedAtMs).toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - run.startedAtMs),
    // The model that served is what the ledger recorded; whether it stood in
    // for another is the route's own evidence (a fallover, or a fallback
    // lane), never a comparison of spellings.
    model: served?.model
      ? { modelId: served.model, requestedModelId, standIn: readRouteStandIn(run.routes)?.standIn === true }
      : null,
    usage: { calls: calls.length, ...(modelMs > 0 ? { modelMs } : {}) },
    inputTokens: calls.reduce((sum, call) => sum + finite(call.inputTokens), 0),
    outputTokens: calls.reduce((sum, call) => sum + finite(call.outputTokens), 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    produced,
    facts,
    source: source ? { kind: source.kind, ...(source.sessionId ? { sessionId: source.sessionId } : {}) } : null,
    ...(positiveInt(run.opts.part) ? { part: run.opts.part } : {}),
    ...(positiveInt(run.opts.parts) ? { parts: run.opts.parts } : {}),
    // A failure names a problem only when it is the model's; otherwise the
    // run simply did not finish.
    failure: result.outcome === 'failed' && result.failure?.problem ? { problem: result.failure.problem } : null,
  };
}

/**
 * "Conversations read" counts a conversation once per local day: a learn run
 * that finished (ok or nothing new) for a session no earlier finished learn
 * run named today. Parts of one conversation, and later turns of it the same
 * day, do not count again. Runs without a session are not conversations, and
 * a nested run counts nothing (see upsertDaily).
 */
function countsAsNewConversation(db: Database.Database, run: RunContext, outcome: MemoryWorkOutcome, at: Date): boolean {
  if (run.job !== 'learn' || run.nestedIn || (outcome !== 'ok' && outcome !== 'nothing_new')) return false;
  const sessionId = run.opts.source?.sessionId?.trim();
  if (!sessionId) return false;
  const seen = db.prepare(`
    SELECT 1 FROM operational_events
     WHERE session_id = ? AND ts >= ? AND source = 'memory'
       AND type = 'memory_work_completed' AND actor = 'learn'
       AND json_extract(payload_json, '$.outcome') IN ('ok', 'nothing_new')
       AND json_extract(payload_json, '$.nestedIn') IS NULL
     LIMIT 1
  `).get(sessionId, localDayStart(at).toISOString());
  return !seen;
}

/**
 * Add one recorded run to its day's counters. Model calls and tokens always
 * count: a nested run's calls are its own (the enclosing run never sees
 * them). A nested run is part of the run around it, so it is not a run of
 * its own (the timeline shows it inside that run), and what it changed does
 * not count again: the enclosing run reports the outcome of the whole run,
 * including what its nested reconciles added or updated.
 */
function upsertDaily(db: Database.Database, payload: MemoryWorkEventPayload, at: Date, conversations: number): void {
  const nested = Boolean(payload.nestedIn);
  const p: MemoryWorkProduced = nested ? {} : payload.produced;
  const atIso = at.toISOString();
  db.prepare(`
    INSERT INTO memory_work_daily (
      day, job, runs, model_calls, input_tokens, output_tokens, learned, updated,
      faded, claims, left_out, set_aside, conversations, last_at, last_outcome,
      last_duration_ms, last_model_id, last_model_at, last_model_stand_in
    ) VALUES (
      @day, @job, @runs, @calls, @inputTokens, @outputTokens, @learned, @updated,
      @faded, @claims, @leftOut, @setAside, @conversations, @at, @outcome,
      @durationMs, @modelId, @modelAt, @standIn
    )
    ON CONFLICT(day, job) DO UPDATE SET
      runs = runs + excluded.runs,
      model_calls = model_calls + excluded.model_calls,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      learned = learned + excluded.learned,
      updated = updated + excluded.updated,
      faded = faded + excluded.faded,
      claims = claims + excluded.claims,
      left_out = left_out + excluded.left_out,
      set_aside = set_aside + excluded.set_aside,
      conversations = conversations + excluded.conversations,
      last_at = CASE WHEN last_at IS NULL OR excluded.last_at >= last_at THEN excluded.last_at ELSE last_at END,
      last_outcome = CASE WHEN last_at IS NULL OR excluded.last_at >= last_at THEN excluded.last_outcome ELSE last_outcome END,
      last_duration_ms = CASE WHEN last_at IS NULL OR excluded.last_at >= last_at THEN excluded.last_duration_ms ELSE last_duration_ms END,
      last_model_id = CASE WHEN excluded.last_model_id IS NOT NULL AND (last_model_at IS NULL OR excluded.last_model_at >= last_model_at)
        THEN excluded.last_model_id ELSE last_model_id END,
      last_model_stand_in = CASE WHEN excluded.last_model_id IS NOT NULL AND (last_model_at IS NULL OR excluded.last_model_at >= last_model_at)
        THEN excluded.last_model_stand_in ELSE last_model_stand_in END,
      last_model_at = CASE WHEN excluded.last_model_id IS NOT NULL AND (last_model_at IS NULL OR excluded.last_model_at >= last_model_at)
        THEN excluded.last_model_at ELSE last_model_at END
  `).run({
    day: localDayKey(at),
    job: payload.job,
    runs: nested ? 0 : 1,
    calls: payload.usage.calls,
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    learned: p.learned ?? 0,
    updated: p.updated ?? 0,
    faded: p.faded ?? 0,
    claims: p.claims ?? 0,
    leftOut: p.leftOut ?? 0,
    setAside: p.setAside ?? 0,
    conversations,
    at: atIso,
    outcome: payload.outcome,
    durationMs: payload.durationMs,
    modelId: payload.model?.modelId ?? null,
    modelAt: payload.model ? atIso : null,
    standIn: payload.model ? (payload.model.standIn ? 1 : 0) : null,
  });
}

// ───────────────────────────── retention ─────────────────────────────

/**
 * Delete memory-work detail older than `detailDays` and daily counters older
 * than `summaryDays` (local days). Other operational events keep their own
 * 30-day reaper.
 */
export function decayMemoryWork(
  now: Date = new Date(),
  db: Database.Database = openOperationalTelemetryDb(),
): { detailDeleted: number; dailyDeleted: number } {
  const detailCutoff = new Date(now.getTime() - MEMORY_WORK_RETENTION.detailDays * DAY_MS).toISOString();
  const dailyCutoff = localDayKey(new Date(now.getTime() - MEMORY_WORK_RETENTION.summaryDays * DAY_MS));
  const detailDeleted = Number(db.prepare(`
    DELETE FROM operational_events
     WHERE source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed') AND ts < ?
  `).run(detailCutoff).changes ?? 0);
  const dailyDeleted = Number(db.prepare('DELETE FROM memory_work_daily WHERE day < ?').run(dailyCutoff).changes ?? 0);
  return { detailDeleted, dailyDeleted };
}

/**
 * Run `decayMemoryWork` at most hourly on a clock persisted in the telemetry
 * DB, so a restart neither starves nor repeats it (a tick-count cadence
 * restarts from zero on every boot). Cheap to call on every daemon tick: an
 * in-process due time answers until the hour is up. Returns null when not due.
 */
export function sweepMemoryWorkIfDue(now: Date = new Date()): { detailDeleted: number; dailyDeleted: number } | null {
  const nowMs = now.getTime();
  // The in-process due time is never more than an hour ahead of now; one that
  // is (the clock moved back) is re-read from the stamp below.
  if (nextRetentionSweepMs !== null && nowMs < nextRetentionSweepMs
    && nextRetentionSweepMs - nowMs <= RETENTION_SWEEP_EVERY_MS) return null;
  const db = openOperationalTelemetryDb();
  const row = db.prepare('SELECT value FROM memory_work_meta WHERE key = ?').get(RETENTION_STAMP_KEY) as { value: string } | undefined;
  const lastMs = row ? Date.parse(row.value) : Number.NaN;
  // A stamp from the future (the clock moved back, or was briefly wrong) is
  // no evidence of a sweep: sweep now and stamp the real time, rather than
  // waiting for the wall clock to catch up with it.
  if (Number.isFinite(lastMs) && lastMs <= nowMs && nowMs - lastMs < RETENTION_SWEEP_EVERY_MS) {
    nextRetentionSweepMs = lastMs + RETENTION_SWEEP_EVERY_MS;
    return null;
  }
  const result = decayMemoryWork(now, db);
  db.prepare(`
    INSERT INTO memory_work_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(RETENTION_STAMP_KEY, now.toISOString());
  nextRetentionSweepMs = nowMs + RETENTION_SWEEP_EVERY_MS;
  return result;
}

// ───────────────────────────── helpers ─────────────────────────────

/** YYYY-MM-DD in the daemon's local time zone. */
export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function localDayStart(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

const SOURCE_KINDS: ReadonlySet<MemoryWorkSource['kind']> = new Set(['conversation', 'workflow', 'owner', 'schedule', 'tool']);

/** Only the kind and the session id are kept; a title is read at display time. */
function publicSource(source: MemoryWorkSource | null | undefined): MemoryWorkSource | null {
  if (!source || !SOURCE_KINDS.has(source.kind)) return null;
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : '';
  return { kind: source.kind, ...(sessionId ? { sessionId } : {}) };
}

function cleanProduced(produced: MemoryWorkProduced | undefined): MemoryWorkProduced {
  const out: MemoryWorkProduced = {};
  for (const key of MEMORY_WORK_PRODUCED_KEYS) {
    const value = produced?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = Math.floor(value);
  }
  return out;
}

const FACT_KEYS: readonly (keyof MemoryJobFacts)[] = ['learned', 'updated', 'reinforced', 'faded', 'restored'];

function cleanFacts(facts: MemoryJobFacts | undefined): MemoryJobFacts | null {
  const out: MemoryJobFacts = {};
  for (const key of FACT_KEYS) {
    const ids = [...new Set((facts?.[key] ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length > 0) out[key] = ids;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Test-only: forget running jobs, waiting, last-checked and the sweep clock. */
export function _resetMemoryWorkJournalForTest(): void {
  runningJobs.clear();
  lastChecked.clear();
  learningWaiting = null;
  nextRetentionSweepMs = null;
}
