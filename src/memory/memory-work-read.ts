/**
 * Memory at work — the one read model both apps poll.
 *
 * `readMemoryWork()` builds the `MemoryWorkSnapshot` served at
 * `GET /api/console/memory/work` and `GET /m/api/memory/work`. It is
 * synchronous and cheap (polled every few seconds): a handful of bounded,
 * index-backed queries over the journal (operational-telemetry.db), the
 * learning queue (memory.db) and the in-process running list.
 *
 * Honesty rules it keeps:
 * - "working" only while a job runs in this process right now;
 * - a count it could not read is null, never 0; when the journal itself
 *   cannot be read the whole snapshot says `unknown`;
 * - a run names the model that served its calls (a stand-in says so); a
 *   job names the model it asks for now, as the chip and Settings do.
 *
 * `undoMemoryWork()` turns off what a run learned, or brings back what it
 * faded, through the same soft forget / restore every Memory door uses.
 */
import type Database from 'better-sqlite3';
import { withRuntimeConfigSnapshot } from '../config.js';
import { openOperationalTelemetryDb } from '../runtime/operational-telemetry.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { bumpStableContextGeneration } from '../runtime/stable-context-generation.js';
import { openMemoryDb } from './db.js';
import { activeEmbeddingModel, activeEmbeddingProviderName } from './embeddings.js';
import { forgetFact, reactivateFact } from './facts.js';
import { humanizeReportBackTitle } from './derive-title.js';
import {
  MEMORY_JOBS,
  MEMORY_JOB_IDS,
  isMemoryJobId,
  memoryJobClock,
  memoryJobUsesMemoryModel,
  type MemoryJobClock,
  type MemoryJobId,
} from './memory-jobs.js';
import { describeMemoryModel, memoryJobModelId, type MemoryModelDescription } from './memory-model-route.js';
import { resolveBoundaryJudge } from '../runtime/harness/debate-model.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { reflectionTurnedOff } from './reflection.js';
import {
  MEMORY_WORK_EVENT_TYPES,
  MEMORY_WORK_RETENTION,
  lastCheckedByJob,
  listRunningMemoryJobs,
  localDayKey,
  readMemoryLearningWaiting,
  type MemoryJobFacts,
  type MemoryWorkEventPayload,
} from './memory-work-journal.js';
import type {
  MemoryJobStatus,
  MemoryModelProblem,
  MemoryWorkDay,
  MemoryWorkEvent,
  MemoryWorkFact,
  MemoryWorkHour,
  MemoryWorkModel,
  MemoryWorkOutcome,
  MemoryWorkProduced,
  MemoryWorkQueue,
  MemoryWorkRunning,
  MemoryWorkSnapshot,
  MemoryWorkSource,
  MemoryWorkToday,
  MemoryWorkTotals,
  MemoryWorkUndoResult,
  MemoryWorkWaiting,
} from './memory-work-types.js';
import { MEMORY_WORK_PRODUCED_KEYS } from './memory-work-types.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Newest events in the timeline. */
export const MEMORY_WORK_RECENT_LIMIT = 40;
/** Facts shown per event; undo counts still consider every id. */
const FACTS_PER_EVENT = 8;
const FACT_TEXT_MAX = 240;
const TITLE_MAX = 80;
const DAILY_DAYS = 30;
const HOURLY_HOURS = 24;
/** Jobs whose runs "Forget" can undo, and the one whose runs "Bring back" can. */
const FORGETTABLE_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'reconcile', 'import']);
const RESTORABLE_JOBS: ReadonlySet<MemoryJobId> = new Set(['tidy']);
/** Jobs the reflection kill-switch stops (the extractor and the nightly
 *  recursive reflection both read CLEMMY_REFLECTION). */
const LEARNING_SWITCH_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'patterns']);
const PROBLEMS: ReadonlySet<MemoryModelProblem> = new Set(['quota', 'credit', 'not_connected', 'timeout', 'error']);
const OUTCOMES: ReadonlySet<MemoryWorkOutcome> = new Set(['ok', 'nothing_new', 'failed', 'waiting']);
const SOURCE_KINDS: ReadonlySet<MemoryWorkSource['kind']> = new Set(['conversation', 'workflow', 'owner', 'schedule', 'tool']);
const FACT_CHANGES: readonly (keyof MemoryJobFacts & MemoryWorkFact['change'])[] = ['learned', 'updated', 'reinforced', 'faded', 'restored'];

interface DailyRow {
  day: string;
  job: string;
  runs: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  learned: number;
  updated: number;
  faded: number;
  claims: number;
  left_out: number;
  set_aside: number;
  conversations: number;
  last_at: string | null;
  last_outcome: string | null;
  last_duration_ms: number | null;
  last_model_id: string | null;
  last_model_at: string | null;
  last_model_stand_in: number | null;
}

interface EventRow {
  event_id: string;
  ts: string;
  type: string;
  actor: string | null;
  session_id: string | null;
  payload_json: string | null;
}

/** Learning runs unless the operator kill-switch says off. The very reader
 *  the extractor and the nightly patterns run obey, so the tab can never say
 *  "off" while learning carries on (or the reverse). */
export function memoryLearningTurnedOn(): boolean {
  return !reflectionTurnedOff();
}

/**
 * The snapshot both apps poll. Never throws: an unreadable journal is
 * `unknown`. One read of the env file and the vault serves the whole
 * snapshot: naming the memory model resolves roles many times, and each
 * unscoped read would parse the env file again, every few seconds.
 */
export function readMemoryWork(now: Date = new Date()): MemoryWorkSnapshot {
  return withRuntimeConfigSnapshot(() => {
    try {
      return buildSnapshot(now, openOperationalTelemetryDb());
    } catch {
      return unknownMemoryWorkSnapshot(now);
    }
  });
}

function buildSnapshot(now: Date, db: Database.Database): MemoryWorkSnapshot {
  const nowMs = now.getTime();
  const detailSince = new Date(nowMs - MEMORY_WORK_RETENTION.detailDays * DAY_MS).toISOString();
  const summarySince = localDayKey(new Date(nowMs - MEMORY_WORK_RETENTION.summaryDays * DAY_MS));
  const dayRows = db.prepare('SELECT * FROM memory_work_daily WHERE day >= ?').all(summarySince) as DailyRow[];
  const since = journalSince(db);
  const firstHourMs = localHourStart(now) - (HOURLY_HOURS - 1) * HOUR_MS;
  const hourRows = readHourRows(db, firstHourMs);
  const eventRows = readRecentRows(db, detailSince);
  // One description serves the model chip and every governed job's name.
  const described = safe(() => describeMemoryModel(), null);

  const running = safe(() => listRunningMemoryJobs(), [] as MemoryWorkRunning[]);
  const learningOn = memoryLearningTurnedOn();
  const waiting = learningOn ? safe(() => readMemoryLearningWaiting(now), null) : null;
  const state: MemoryWorkSnapshot['state'] = !learningOn ? 'off'
    : running.length > 0 ? 'working'
    : waiting ? 'waiting'
    : 'resting';

  const todayKey = localDayKey(now);
  const todayRows = dayRows.filter((row) => row.day === todayKey && isMemoryJobId(row.job));
  const model = memoryModel(dayRows, described);
  const titles = sessionTitles([
    ...running.map((r) => r.source?.sessionId),
    ...eventRows.map((r) => r.session_id ?? undefined),
  ]);
  const lastWorkAt = dayRows.reduce<string | null>((newest, row) => (
    row.last_at && (!newest || row.last_at > newest) ? row.last_at : newest
  ), null);

  return {
    generatedAt: now.toISOString(),
    state,
    running: running.map((r) => ({ ...r, ...(r.source ? { source: withTitle(r.source, titles) } : {}) })),
    waiting: waiting as MemoryWorkWaiting | null,
    lastWorkAt,
    queue: readQueue(),
    model,
    embedder: readEmbedder(),
    jobs: MEMORY_JOB_IDS.map((id) => jobStatus(id, {
      now, learningOn, waiting, running, dayRows, todayRows, described,
    })),
    today: todayTotals(todayRows),
    hourly: hourly(firstHourMs, hourRows, since?.ms ?? null),
    daily: daily(now, dayRows, since?.day ?? null),
    measuredSince: since && since.ms > nowMs - DAILY_DAYS * DAY_MS ? new Date(since.ms).toISOString() : null,
    recent: recentEvents(eventRows, titles),
    retention: { ...MEMORY_WORK_RETENTION },
  };
}

/**
 * What the apps get when the journal cannot be read: `unknown`, with every
 * count it could not read left out (lists empty, queue null). The contract's
 * day totals are plain numbers, so they are zeros here; the apps read
 * `state === 'unknown'` first and show "—".
 */
export function unknownMemoryWorkSnapshot(now: Date = new Date()): MemoryWorkSnapshot {
  const running = safe(() => listRunningMemoryJobs(), [] as MemoryWorkRunning[]);
  const described = safe(() => describeMemoryModel(), null);
  return {
    generatedAt: now.toISOString(),
    state: 'unknown',
    running,
    waiting: null,
    lastWorkAt: null,
    queue: { toLearn: null, setAside: null, failed: null },
    model: {
      source: described?.source ?? 'automatic',
      modelId: described?.modelId ?? null,
      follows: described?.follows ?? null,
      lastServed: null,
      unavailable: described?.unavailable ?? null,
    },
    embedder: null,
    jobs: MEMORY_JOB_IDS.map((id) => ({
      id,
      modelOwner: MEMORY_JOBS[id].modelOwner,
      state: running.some((r) => r.job === id) ? 'running' : 'idle',
      modelId: null,
      lastRun: null,
      next: { trigger: MEMORY_JOBS[id].trigger },
      today: zeroTotals(),
    })),
    today: { ...zeroTotals(), conversationsRead: 0, claimsFound: 0, leftOut: 0, setAside: 0, costUsd: null },
    hourly: [],
    daily: [],
    measuredSince: null,
    recent: [],
    retention: { ...MEMORY_WORK_RETENTION },
  };
}

// ───────────────────────────── sections ─────────────────────────────

function readQueue(): MemoryWorkQueue {
  const count = (sql: string): number | null => {
    try {
      const row = openMemoryDb().prepare(sql).get() as { n: number } | undefined;
      return typeof row?.n === 'number' ? row.n : null;
    } catch {
      return null;
    }
  };
  return {
    // Pending covers retries (a failed part waits for its next attempt);
    // processing is a part being read now or one whose lease will lapse.
    toLearn: count(`SELECT COUNT(*) AS n FROM memory_learning_shards WHERE status IN ('pending', 'processing')`),
    setAside: count(`SELECT COUNT(*) AS n FROM memory_reflection_candidates WHERE source_type = 'tool_reflection' AND status = 'pending'`),
    failed: count(`SELECT COUNT(*) AS n FROM memory_learning_shards WHERE status = 'dead_letter'`),
  };
}

function readEmbedder(): MemoryWorkSnapshot['embedder'] {
  try {
    const provider = activeEmbeddingProviderName();
    return { modelId: activeEmbeddingModel(), local: provider === 'local' };
  } catch {
    return null;
  }
}

/** The memory model: what the next governed job asks for (the memory route's
 *  own resolution) and what last answered a governed job. */
function memoryModel(dayRows: DailyRow[], described: MemoryModelDescription | null): MemoryWorkModel {
  let lastServed: MemoryWorkModel['lastServed'] = null;
  for (const row of dayRows) {
    if (!isMemoryJobId(row.job) || !memoryJobUsesMemoryModel(row.job)) continue;
    if (!row.last_model_id || !row.last_model_at) continue;
    if (!lastServed || row.last_model_at > lastServed.at) {
      lastServed = { modelId: row.last_model_id, at: row.last_model_at, standIn: row.last_model_stand_in === 1 };
    }
  }
  return {
    source: described?.source ?? 'automatic',
    modelId: described?.modelId ?? null,
    follows: described?.follows ?? null,
    lastServed,
    unavailable: described?.unavailable ?? null,
  };
}

function jobStatus(id: MemoryJobId, ctx: {
  now: Date;
  learningOn: boolean;
  waiting: MemoryWorkWaiting | null;
  running: MemoryWorkRunning[];
  dayRows: DailyRow[];
  todayRows: DailyRow[];
  described: MemoryModelDescription | null;
}): MemoryJobStatus {
  const spec = MEMORY_JOBS[id];
  const rows = ctx.dayRows.filter((row) => row.job === id);
  const off = !ctx.learningOn && LEARNING_SWITCH_JOBS.has(id);
  const state: MemoryJobStatus['state'] = ctx.running.some((r) => r.job === id) ? 'running'
    : off ? 'off'
    : id === 'learn' && ctx.waiting ? 'waiting'
    : 'idle';
  const clock = memoryJobClock(id);
  return {
    id,
    modelOwner: spec.modelOwner,
    state,
    modelId: jobModelId(id, ctx.described),
    lastRun: lastRun(id, rows),
    next: off ? null : { trigger: spec.trigger, ...(clock ? { at: nextClockAt(clock, ctx.now) } : {}) },
    today: totalsOf(ctx.todayRows.filter((row) => row.job === id)),
  };
}

/**
 * The model a job asks for now, so a row agrees with the chip and Settings
 * after the owner changes a model (a job that runs once a night would
 * otherwise name last week's). What answered each run is on its event.
 */
function jobModelId(id: MemoryJobId, described: MemoryModelDescription | null): string | null {
  const owner = MEMORY_JOBS[id].modelOwner;
  if (owner === 'none') return null;
  if (owner === 'local') return safe(() => activeEmbeddingModel(), null);
  // Named from the one description: no model is built per job on a poll.
  if (owner === 'memory') return described ? memoryJobModelId(id, described) : null;
  return checkerJobModelId(id);
}

/** The checker's model for a checker job: the boundary checker for the
 *  standing-instruction check, the checker role for memory repairs. Null
 *  when the checker cannot be named (its pick is unavailable). */
function checkerJobModelId(id: MemoryJobId): string | null {
  return safe(() => {
    if (id === 'standing') return resolveBoundaryJudge().modelId || null;
    const checker = resolveRoleModel('judge');
    return checker.inactiveBinding ? null : checker.modelId || null;
  }, null);
}

function lastRun(id: MemoryJobId, rows: DailyRow[]): MemoryJobStatus['lastRun'] {
  let newest: DailyRow | null = null;
  for (const row of rows) {
    if (row.last_at && (!newest || row.last_at > (newest.last_at ?? ''))) newest = row;
  }
  const checked = lastCheckedByJob()[id];
  if (checked && (!newest?.last_at || checked > newest.last_at)) return { at: checked, outcome: 'nothing_new' };
  if (!newest?.last_at) return null;
  const outcome = OUTCOMES.has(newest.last_outcome as MemoryWorkOutcome) ? newest.last_outcome as MemoryWorkOutcome : 'ok';
  return {
    at: newest.last_at,
    outcome,
    ...(typeof newest.last_duration_ms === 'number' ? { durationMs: newest.last_duration_ms } : {}),
  };
}

/** The next local time at or after `now` a clock job fires. A job that
 *  already ran today fires tomorrow; one whose time has not come, today. */
function nextClockAt(clock: MemoryJobClock, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hour, clock.minute);
  if (now.getTime() < today.getTime()) return today.toISOString();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, clock.hour, clock.minute).toISOString();
}

function todayTotals(rows: DailyRow[]): MemoryWorkToday {
  const sum = (key: keyof DailyRow) => rows.reduce((total, row) => total + num(row[key]), 0);
  return {
    ...totalsOf(rows),
    conversationsRead: sum('conversations'),
    claimsFound: sum('claims'),
    leftOut: sum('left_out'),
    setAside: sum('set_aside'),
    // No price table exists for these models; an invented price is worse
    // than none.
    costUsd: null,
  };
}

function totalsOf(rows: DailyRow[]): MemoryWorkTotals {
  const totals = zeroTotals();
  for (const row of rows) {
    totals.runs += num(row.runs);
    totals.modelCalls += num(row.model_calls);
    totals.inputTokens += num(row.input_tokens);
    totals.outputTokens += num(row.output_tokens);
    totals.learned += num(row.learned);
    totals.updated += num(row.updated);
    totals.faded += num(row.faded);
  }
  return totals;
}

function zeroTotals(): MemoryWorkTotals {
  return { runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, learned: 0, updated: 0, faded: 0 };
}

interface HourRow { bucket: number; runs: number; calls: number | null; learned: number | null }

/**
 * Start of the local hour holding `now`, as an instant. Local, not UTC: in a
 * zone with a half-hour offset the hour starts at :30 UTC. Measured back from
 * `now`'s own minutes, so it is unambiguous across a daylight-saving change.
 */
function localHourStart(now: Date): number {
  return now.getTime() - (now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds());
}

/** Runs, calls and learned per hour since `firstMs` (bucket 0 = the first
 *  hour). What a nested run changed is counted by the run around it. */
function readHourRows(db: Database.Database, firstMs: number): HourRow[] {
  return db.prepare(`
    SELECT (CAST(strftime('%s', ts) AS INTEGER) - CAST(@first AS INTEGER)) / 3600 AS bucket,
           COUNT(*) AS runs,
           SUM(COALESCE(json_extract(payload_json, '$.usage.calls'), 0)) AS calls,
           SUM(CASE WHEN json_extract(payload_json, '$.nestedIn') IS NULL
                    THEN COALESCE(json_extract(payload_json, '$.produced.learned'), 0) ELSE 0 END) AS learned
      FROM operational_events
     WHERE source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed') AND ts >= @since
     GROUP BY bucket
  `).all({ first: Math.floor(firstMs / 1000), since: new Date(firstMs).toISOString() }) as HourRow[];
}

/**
 * The last 24 local hours ending with the current one, oldest first. An hour
 * with runs shows them; an hour since the journal began with none is a
 * genuine zero; an hour that ended before the journal began was never
 * measured and is left out (as the 30-day strip leaves out earlier days).
 */
function hourly(firstMs: number, rows: HourRow[], sinceMs: number | null): MemoryWorkHour[] {
  const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));
  const out: MemoryWorkHour[] = [];
  for (let i = 0; i < HOURLY_HOURS; i += 1) {
    const start = firstMs + i * HOUR_MS;
    const row = byBucket.get(i);
    if (!row && (sinceMs === null || start + HOUR_MS <= sinceMs)) continue;
    out.push({ hourStart: new Date(start).toISOString(), runs: num(row?.runs), modelCalls: num(row?.calls), learned: num(row?.learned) });
  }
  return out;
}

/**
 * The last 30 local days, oldest first. A day with counters shows them; a
 * day since the journal began with none is a genuine zero; a day before the
 * journal existed is left out rather than shown as zero.
 */
function daily(now: Date, rows: DailyRow[], sinceDay: string | null): MemoryWorkDay[] {
  const byDay = new Map<string, MemoryWorkDay>();
  for (const row of rows) {
    if (!isMemoryJobId(row.job)) continue;
    const day = byDay.get(row.day) ?? { day: row.day, runs: 0, modelCalls: 0, learned: 0, inputTokens: 0, outputTokens: 0 };
    day.runs += num(row.runs);
    day.modelCalls += num(row.model_calls);
    day.learned += num(row.learned);
    day.inputTokens += num(row.input_tokens);
    day.outputTokens += num(row.output_tokens);
    byDay.set(row.day, day);
  }
  const out: MemoryWorkDay[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i -= 1) {
    const key = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    const day = byDay.get(key);
    if (day) out.push(day);
    else if (sinceDay && key >= sinceDay) out.push({ day: key, runs: 0, modelCalls: 0, learned: 0, inputTokens: 0, outputTokens: 0 });
  }
  return out;
}

/** When the journal began, as an instant and as its local day. */
function journalSince(db: Database.Database): { ms: number; day: string } | null {
  try {
    const row = db.prepare(`SELECT value FROM memory_work_meta WHERE key = 'journal_since'`).get() as { value: string } | undefined;
    const ms = row ? Date.parse(row.value) : Number.NaN;
    return Number.isFinite(ms) ? { ms, day: localDayKey(new Date(ms)) } : null;
  } catch {
    return null;
  }
}

/** The newest events: one index-ordered read per type, merged. */
function readRecentRows(db: Database.Database, since: string): EventRow[] {
  const statement = db.prepare(`
    SELECT event_id, ts, type, actor, session_id, payload_json
      FROM operational_events
     WHERE source = 'memory' AND type = ? AND ts >= ?
     ORDER BY ts DESC
     LIMIT ?
  `);
  const rows: EventRow[] = [];
  for (const type of MEMORY_WORK_EVENT_TYPES) {
    rows.push(...(statement.all(type, since, MEMORY_WORK_RECENT_LIMIT) as EventRow[]));
  }
  return rows
    .filter((row) => isMemoryJobId(row.actor))
    .sort((a, b) => (a.ts === b.ts ? b.event_id.localeCompare(a.event_id) : b.ts.localeCompare(a.ts)))
    .slice(0, MEMORY_WORK_RECENT_LIMIT);
}

interface FactState { active: boolean; text: string }

type UndoKind = 'forget' | 'restore';

/**
 * Which of a run's ids undo may still change: ONE rule for the offer and for
 * the undo itself, so the button never promises what undo would not do.
 * - forget: still active, and not pinned since the run (a pin after the run
 *   is the owner keeping it on purpose).
 * - restore: still faded exactly as this run left it. Fading stamps
 *   `updated_at` before the run's event is written; an owner restore, a later
 *   forget or a supersede each stamp it again after (a supersede also names
 *   its replacement), so bringing those back would undo someone else's
 *   decision, or leave a fact and its replacement both active.
 * `@at` is the run's event time; `@ids` a JSON array of fact ids.
 */
const UNDO_TARGETS_WHERE: Record<UndoKind, string> = {
  forget: `active = 1 AND NOT (pinned = 1 AND COALESCE(updated_at, '') > @at)`,
  restore: `active = 0 AND superseded_by_fact_id IS NULL AND updated_at <= @at`,
};

function undoKindOf(job: unknown): UndoKind | null {
  if (!isMemoryJobId(job)) return null;
  if (FORGETTABLE_JOBS.has(job)) return 'forget';
  if (RESTORABLE_JOBS.has(job)) return 'restore';
  return null;
}

/** The ids a run's undo would act on: what it learned (forget) or faded (restore). */
function undoIdsOf(kind: UndoKind, facts: MemoryJobFacts | null | undefined): number[] {
  const list = kind === 'forget' ? facts?.learned : facts?.faded;
  return [...new Set((Array.isArray(list) ? list : []).map(factNumber).filter((n): n is number => n !== null))];
}

/**
 * A run nested in another run whose undo is of the same kind leaves the ids
 * the enclosing run lists to that run: one "Forget" per memory, on the run
 * the owner recognises (the conversation that was read), not twice. When the
 * enclosing run lists nothing (it failed, or is still running), the nested
 * run keeps its own undo.
 */
function withoutEnclosingIds(
  kind: UndoKind,
  ids: number[],
  nestedIn: MemoryWorkEventPayload['nestedIn'] | undefined,
  enclosing: (runId: string) => Partial<MemoryWorkEventPayload> | undefined,
): number[] {
  if (!nestedIn || typeof nestedIn.runId !== 'string' || undoKindOf(nestedIn.job) !== kind || ids.length === 0) return ids;
  const parent = enclosing(nestedIn.runId);
  if (!parent) return ids;
  const theirs = new Set(undoIdsOf(kind, parent.facts));
  return ids.filter((id) => !theirs.has(id));
}

/** Counts (or lists) a run's ids that undo would still change, in memory.db. */
function undoTargetReader(memory: Database.Database) {
  const statements = new Map<string, Database.Statement>();
  const statement = (kind: UndoKind, select: 'count' | 'ids') => {
    const key = `${kind}:${select}`;
    let stmt = statements.get(key);
    if (!stmt) {
      stmt = memory.prepare(`
        SELECT ${select === 'count' ? 'COUNT(*) AS n' : 'id'} FROM consolidated_facts
         WHERE id IN (SELECT value FROM json_each(@ids)) AND ${UNDO_TARGETS_WHERE[kind]}
      `);
      statements.set(key, stmt);
    }
    return stmt;
  };
  return {
    count(kind: UndoKind, ids: number[], at: string): number {
      if (ids.length === 0) return 0;
      const row = statement(kind, 'count').get({ ids: JSON.stringify(ids), at }) as { n: number } | undefined;
      return typeof row?.n === 'number' ? row.n : 0;
    },
    ids(kind: UndoKind, ids: number[], at: string): number[] {
      if (ids.length === 0) return [];
      return (statement(kind, 'ids').all({ ids: JSON.stringify(ids), at }) as Array<{ id: number }>).map((row) => row.id);
    },
  };
}

/** The first ids an event shows, in change order (at most FACTS_PER_EVENT). */
function shownFactIds(facts: MemoryJobFacts | null | undefined): Array<{ n: number; change: MemoryWorkFact['change'] }> {
  const out: Array<{ n: number; change: MemoryWorkFact['change'] }> = [];
  for (const change of FACT_CHANGES) {
    const list = facts?.[change];
    for (const id of Array.isArray(list) ? list : []) {
      if (out.length >= FACTS_PER_EVENT) return out;
      const n = factNumber(id);
      if (n !== null) out.push({ n, change });
    }
  }
  return out;
}

/**
 * Bounded by what is shown, not by how much a run touched: text is read only
 * for the few facts each event lists, and undo is counted inside memory.db
 * (one counting query per event, primary-key lookups only), so an import of
 * thousands of memories never loads thousands of texts on every poll.
 */
function recentEvents(rows: EventRow[], titles: Map<string, string>): MemoryWorkEvent[] {
  const parsed = rows.map((row) => ({ row, payload: parsePayload(row.payload_json) }));
  const byRun = new Map<string, Partial<MemoryWorkEventPayload>>();
  for (const { payload } of parsed) if (typeof payload.runId === 'string') byRun.set(payload.runId, payload);
  const shown = parsed.map(({ payload }) => shownFactIds(payload.facts));
  let memory: Database.Database | null = null;
  let facts: Map<number, FactState> | null = null;
  try {
    memory = openMemoryDb();
    facts = readFactTexts(memory, [...new Set(shown.flat().map((s) => s.n))]);
  } catch {
    memory = null; // no facts and no undo, rather than wrong ones
  }
  const targets = memory ? undoTargetReader(memory) : null;
  return foldNestedRuns(parsed.map(({ row, payload }, i) => {
    let undo: MemoryWorkEvent['undo'] = null;
    if (targets) {
      try {
        undo = undoOffer(row, payload, targets, (runId) => byRun.get(runId));
      } catch {
        undo = null;
      }
    }
    return { payload, event: toEvent(row, payload, shown[i], facts, undo, titles) };
  }));
}

/**
 * One row per run the owner recognises. A run nested in a run this list also
 * shows (a reconcile inside the conversation read that saved the memory) is
 * folded into it: its calls and tokens join that row, and what it changed is
 * already that row's. Decided from what the two runs recorded, never from
 * fact state, so a row the owner just acted on (an undo, a forget elsewhere)
 * stays where it was. A nested run keeps its row when it failed (its problem
 * is its own), when it lists memories its enclosing run does not (a reconcile
 * inside the nightly pattern run, whose undo is not a forget), or when its
 * enclosing run is not listed (still running, or older than the list).
 */
function foldNestedRuns(rows: Array<{ payload: Partial<MemoryWorkEventPayload>; event: MemoryWorkEvent }>): MemoryWorkEvent[] {
  const byRun = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (typeof row.payload.runId === 'string') byRun.set(row.payload.runId, row);
  const parentOf = (row: (typeof rows)[number]) => {
    const runId = row.payload.nestedIn?.runId;
    return typeof runId === 'string' ? byRun.get(runId) : undefined;
  };
  const standsAlone = (row: (typeof rows)[number]): boolean => {
    if (row.event.outcome === 'failed') return true;
    const kind = undoKindOf(row.event.job);
    if (!kind) return false;
    return withoutEnclosingIds(kind, undoIdsOf(kind, row.payload.facts), row.payload.nestedIn, (runId) => byRun.get(runId)?.payload).length > 0;
  };
  const folded = new Set<(typeof rows)[number]>();
  for (const row of rows) if (parentOf(row) && !standsAlone(row)) folded.add(row);
  for (const row of rows) {
    if (!folded.has(row)) continue;
    // The nearest enclosing run that keeps its own row takes the usage.
    let into = parentOf(row);
    for (let depth = 0; into && folded.has(into) && depth < 8; depth += 1) into = parentOf(into);
    if (!into || folded.has(into)) continue;
    const usage = into.event.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    const extra = row.event.usage;
    if (extra) {
      const cached = num(usage.cachedInputTokens) + num(extra.cachedInputTokens);
      into.event.usage = {
        ...usage,
        calls: num(usage.calls) + num(extra.calls),
        inputTokens: num(usage.inputTokens) + num(extra.inputTokens),
        outputTokens: num(usage.outputTokens) + num(extra.outputTokens),
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      };
    }
    if (!into.event.model && row.event.model) into.event.model = row.event.model;
  }
  return rows.filter((row) => !folded.has(row)).map((row) => row.event);
}

/** Forget what a run learned that is still active; bring back what it faded
 *  that is still faded as it left it. Recomputed from fact state on every read. */
function undoOffer(
  row: EventRow,
  payload: Partial<MemoryWorkEventPayload>,
  targets: ReturnType<typeof undoTargetReader>,
  enclosing: (runId: string) => Partial<MemoryWorkEventPayload> | undefined,
): MemoryWorkEvent['undo'] {
  const kind = undoKindOf(row.actor);
  if (!kind) return null;
  const ids = withoutEnclosingIds(kind, undoIdsOf(kind, payload.facts), payload.nestedIn, enclosing);
  const count = targets.count(kind, ids, row.ts);
  return count > 0 ? { kind, count } : null;
}

function toEvent(
  row: EventRow,
  payload: Partial<MemoryWorkEventPayload>,
  shown: Array<{ n: number; change: MemoryWorkFact['change'] }>,
  facts: Map<number, FactState> | null,
  undo: MemoryWorkEvent['undo'],
  titles: Map<string, string>,
): MemoryWorkEvent {
  const job = row.actor as MemoryJobId;
  const outcome: MemoryWorkOutcome = OUTCOMES.has(payload.outcome as MemoryWorkOutcome)
    ? payload.outcome as MemoryWorkOutcome
    : row.type === 'memory_work_failed' ? 'failed' : 'ok';
  const source = eventSource(payload.source, row.session_id, titles);
  const model = payload.model && typeof payload.model.modelId === 'string' && payload.model.modelId
    ? { modelId: payload.model.modelId, standIn: payload.model.standIn === true }
    : null;
  // A problem is named only when it was the model's; a run that failed for
  // another reason simply did not finish.
  const failure = payload.failure && PROBLEMS.has(payload.failure.problem)
    ? { problem: payload.failure.problem }
    : null;
  const listed: MemoryWorkFact[] = [];
  if (facts) {
    for (const { n, change } of shown) {
      const fact = facts.get(n);
      if (fact) listed.push({ id: String(n), text: fact.text, change, active: fact.active });
    }
  }
  const expiresAt = new Date(Date.parse(row.ts) + MEMORY_WORK_RETENTION.detailDays * DAY_MS).toISOString();
  return {
    id: row.event_id,
    job,
    at: row.ts,
    ...(typeof payload.startedAt === 'string' ? { startedAt: payload.startedAt } : {}),
    outcome,
    model,
    usage: {
      calls: num(payload.usage?.calls),
      inputTokens: num(payload.inputTokens),
      outputTokens: num(payload.outputTokens),
      ...(typeof payload.cachedInputTokens === 'number' ? { cachedInputTokens: payload.cachedInputTokens } : {}),
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
    },
    source,
    produced: produced(payload.produced),
    ...(listed.length > 0 ? { facts: listed } : {}),
    undo,
    failure,
    expiresAt,
  };
}

/** Current text and active flag for the facts the timeline shows (a few per
 *  event). Throws when memory.db cannot be read; the caller then offers no
 *  facts and no undo rather than wrong ones. */
function readFactTexts(memory: Database.Database, ids: number[]): Map<number, FactState> {
  const out = new Map<number, FactState>();
  if (ids.length === 0) return out;
  const rows = memory.prepare(`
    SELECT id, active, substr(content, 1, ${FACT_TEXT_MAX * 2}) AS content
      FROM consolidated_facts
     WHERE id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(ids)) as Array<{ id: number; active: number; content: string }>;
  for (const row of rows) out.set(row.id, { active: row.active === 1, text: clip(row.content ?? '', FACT_TEXT_MAX) });
  return out;
}

/** Conversation and workflow titles from the harness session rows (read
 *  only). A missing title is left out, never guessed. */
function sessionTitles(ids: Array<string | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return out;
  try {
    const rows = openEventLog().prepare(`
      SELECT id, kind, title, metadata_json FROM sessions WHERE id IN (${wanted.map(() => '?').join(',')})
    `).all(...wanted) as Array<{ id: string; kind: string; title: string | null; metadata_json: string | null }>;
    for (const row of rows) {
      const title = sessionTitle(row);
      if (title) out.set(row.id, title);
    }
  } catch { /* titles are a courtesy */ }
  return out;
}

function sessionTitle(row: { kind: string; title: string | null; metadata_json: string | null }): string | null {
  if (row.kind === 'workflow') {
    try {
      const meta = JSON.parse(row.metadata_json ?? '{}') as { workflowName?: unknown };
      if (typeof meta.workflowName === 'string' && meta.workflowName.trim()) return clip(meta.workflowName, TITLE_MAX);
    } catch { /* fall through to the stored title */ }
  }
  const stored = (row.title ?? '').trim();
  if (!stored) return null;
  const healed = humanizeReportBackTitle(stored) ?? stored;
  // Per-step workflow sessions are titled `name::stepId`.
  return clip(row.kind === 'workflow' ? healed.split('::')[0] : healed, TITLE_MAX) || null;
}

function eventSource(
  source: MemoryWorkEventPayload['source'] | undefined,
  sessionId: string | null,
  titles: Map<string, string>,
): MemoryWorkSource | null {
  if (!source || !SOURCE_KINDS.has(source.kind)) return null;
  const id = typeof source.sessionId === 'string' && source.sessionId ? source.sessionId : sessionId ?? undefined;
  return withTitle({ kind: source.kind, ...(id ? { sessionId: id } : {}) }, titles);
}

function withTitle(source: MemoryWorkSource, titles: Map<string, string>): MemoryWorkSource {
  const title = source.sessionId ? titles.get(source.sessionId) : undefined;
  return { ...source, ...(title ? { title } : {}) };
}

// ───────────────────────────── undo ─────────────────────────────

/**
 * Undo one recorded run: forget (soft) each memory it learned that is still
 * active, or bring back each memory it faded that is still faded as the run
 * left it — exactly the ids the timeline's offer counted (one rule,
 * `UNDO_TARGETS_WHERE`, checked again inside the transaction). The same
 * forget / restore the Memory tab's buttons use, so every door keeps one
 * safety story. Undo is a direct action, not a job: the next snapshot
 * recomputes what is left to undo from fact state.
 */
export function undoMemoryWork(eventId: string, now: Date = new Date()): MemoryWorkUndoResult {
  try {
    const telemetry = openOperationalTelemetryDb();
    const row = telemetry.prepare(`
      SELECT event_id, ts, type, actor, session_id, payload_json
        FROM operational_events
       WHERE event_id = ? AND source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed')
    `).get(eventId) as EventRow | undefined;
    if (!row || !isMemoryJobId(row.actor)) return { ok: false, reason: 'not_found' };
    if (Date.parse(row.ts) < now.getTime() - MEMORY_WORK_RETENTION.detailDays * DAY_MS) return { ok: false, reason: 'expired' };
    const kind = undoKindOf(row.actor);
    if (!kind) return { ok: false, reason: 'nothing_to_undo' };
    const payload = parsePayload(row.payload_json);
    const ids = withoutEnclosingIds(kind, undoIdsOf(kind, payload.facts), payload.nestedIn, (runId) => {
      const parent = telemetry.prepare(`
        SELECT payload_json FROM operational_events
         WHERE source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed')
           AND ts >= ? AND actor = ? AND json_extract(payload_json, '$.runId') = ?
         LIMIT 1
      `).get(row.ts, payload.nestedIn?.job ?? '', runId) as { payload_json: string | null } | undefined;
      return parent ? parsePayload(parent.payload_json) : undefined;
    });
    if (ids.length === 0) return { ok: false, reason: 'nothing_to_undo' };
    const db = openMemoryDb();
    const targets = undoTargetReader(db);
    const changed = db.transaction(() => {
      let count = 0;
      for (const id of targets.ids(kind, ids, row.ts)) {
        if (kind === 'forget' ? forgetFact(id) : reactivateFact(id)) count += 1;
      }
      return count;
    })();
    if (changed === 0) return { ok: false, reason: 'nothing_to_undo' };
    // The running agent's prompt cache must stop serving what changed.
    try { bumpStableContextGeneration(); } catch { /* the facts changed either way */ }
    return { ok: true, changed };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** An event id as the routes accept it (the journal mints UUIDs). */
export function isMemoryWorkEventId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

// ───────────────────────────── helpers ─────────────────────────────

function parsePayload(json: string | null): Partial<MemoryWorkEventPayload> {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<MemoryWorkEventPayload> : {};
  } catch {
    return {};
  }
}

function produced(value: MemoryWorkProduced | undefined): MemoryWorkProduced {
  const out: MemoryWorkProduced = {};
  for (const key of MEMORY_WORK_PRODUCED_KEYS) {
    const n = value?.[key];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function factNumber(id: unknown): number | null {
  const n = typeof id === 'number' ? id : Number.parseInt(String(id ?? ''), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Shorten at a word boundary with an ellipsis. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
