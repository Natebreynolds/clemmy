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
 * - the model named is the one that served the call (a stand-in says so);
 *   for a governed job that has not run yet, the one it would ask for.
 *
 * `undoMemoryWork()` turns off what a run learned, or brings back what it
 * faded, through the same soft forget / restore every Memory door uses.
 */
import type Database from 'better-sqlite3';
import { getRuntimeEnv } from '../config.js';
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
import { describeMemoryModel, resolveMemoryModelRoute } from './memory-model-route.js';
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

/** Learning runs unless the operator kill-switch says off (the same key and
 *  reader the nightly recursive reflection uses). */
export function memoryLearningTurnedOn(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_REFLECTION', '') ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** The snapshot both apps poll. Never throws: an unreadable journal is `unknown`. */
export function readMemoryWork(now: Date = new Date()): MemoryWorkSnapshot {
  try {
    return buildSnapshot(now, openOperationalTelemetryDb());
  } catch {
    return unknownMemoryWorkSnapshot(now);
  }
}

function buildSnapshot(now: Date, db: Database.Database): MemoryWorkSnapshot {
  const nowMs = now.getTime();
  const detailSince = new Date(nowMs - MEMORY_WORK_RETENTION.detailDays * DAY_MS).toISOString();
  const summarySince = localDayKey(new Date(nowMs - MEMORY_WORK_RETENTION.summaryDays * DAY_MS));
  const dayRows = db.prepare('SELECT * FROM memory_work_daily WHERE day >= ?').all(summarySince) as DailyRow[];
  const since = journalSince(db);
  const hourRows = readHourRows(db, now);
  const eventRows = readRecentRows(db, detailSince);

  const running = safe(() => listRunningMemoryJobs(), [] as MemoryWorkRunning[]);
  const learningOn = memoryLearningTurnedOn();
  const waiting = learningOn ? safe(() => readMemoryLearningWaiting(now), null) : null;
  const state: MemoryWorkSnapshot['state'] = !learningOn ? 'off'
    : running.length > 0 ? 'working'
    : waiting ? 'waiting'
    : 'resting';

  const todayKey = localDayKey(now);
  const todayRows = dayRows.filter((row) => row.day === todayKey && isMemoryJobId(row.job));
  const model = memoryModel(dayRows);
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
      now, learningOn, waiting, running, dayRows, todayRows,
    })),
    today: todayTotals(todayRows),
    hourly: hourly(now, hourRows),
    daily: daily(now, dayRows, since),
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
function memoryModel(dayRows: DailyRow[]): MemoryWorkModel {
  const described = safe(() => describeMemoryModel(), null);
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
    modelId: jobModelId(id, rows),
    lastRun: lastRun(id, rows),
    next: off ? null : { trigger: spec.trigger, ...(clock ? { at: nextClockAt(clock, ctx.now) } : {}) },
    today: totalsOf(ctx.todayRows.filter((row) => row.job === id)),
  };
}

function jobModelId(id: MemoryJobId, rows: DailyRow[]): string | null {
  const owner = MEMORY_JOBS[id].modelOwner;
  if (owner === 'none') return null;
  if (owner === 'local') return safe(() => activeEmbeddingModel(), null);
  let newest: DailyRow | null = null;
  for (const row of rows) {
    if (row.last_model_id && row.last_model_at && (!newest || row.last_model_at > (newest.last_model_at ?? ''))) newest = row;
  }
  if (newest?.last_model_id) return newest.last_model_id;
  // A governed job that has not run yet: the model it would ask for.
  if (owner === 'memory') return safe(() => resolveMemoryModelRoute(id)?.modelId ?? null, null);
  return null;
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

interface HourRow { hour: string; runs: number; calls: number | null; learned: number | null }

function readHourRows(db: Database.Database, now: Date): HourRow[] {
  const first = new Date(hourFloor(now.getTime()) - (HOURLY_HOURS - 1) * HOUR_MS).toISOString();
  return db.prepare(`
    SELECT substr(ts, 1, 13) AS hour,
           COUNT(*) AS runs,
           SUM(COALESCE(json_extract(payload_json, '$.usage.calls'), 0)) AS calls,
           SUM(COALESCE(json_extract(payload_json, '$.produced.learned'), 0)) AS learned
      FROM operational_events
     WHERE source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed') AND ts >= ?
     GROUP BY hour
  `).all(first) as HourRow[];
}

/** 24 one-hour buckets ending with the current hour, oldest first. */
function hourly(now: Date, rows: HourRow[]): MemoryWorkHour[] {
  const byHour = new Map(rows.map((row) => [row.hour, row]));
  const current = hourFloor(now.getTime());
  const out: MemoryWorkHour[] = [];
  for (let i = HOURLY_HOURS - 1; i >= 0; i -= 1) {
    const start = new Date(current - i * HOUR_MS).toISOString();
    const row = byHour.get(start.slice(0, 13));
    out.push({ hourStart: start, runs: num(row?.runs), modelCalls: num(row?.calls), learned: num(row?.learned) });
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

function journalSince(db: Database.Database): string | null {
  try {
    const row = db.prepare(`SELECT value FROM memory_work_meta WHERE key = 'journal_since'`).get() as { value: string } | undefined;
    const ms = row ? Date.parse(row.value) : Number.NaN;
    return Number.isFinite(ms) ? localDayKey(new Date(ms)) : null;
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

function recentEvents(rows: EventRow[], titles: Map<string, string>): MemoryWorkEvent[] {
  const parsed = rows.map((row) => ({ row, payload: parsePayload(row.payload_json) }));
  const ids = new Set<number>();
  for (const { payload } of parsed) {
    for (const change of FACT_CHANGES) for (const id of payload.facts?.[change] ?? []) {
      const n = factNumber(id);
      if (n !== null) ids.add(n);
    }
  }
  const facts = readFacts([...ids]);
  return parsed.map(({ row, payload }) => toEvent(row, payload, facts, titles));
}

function toEvent(
  row: EventRow,
  payload: Partial<MemoryWorkEventPayload>,
  facts: Map<number, FactState> | null,
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
  const failure = payload.failure && PROBLEMS.has(payload.failure.problem)
    ? { problem: payload.failure.problem }
    : outcome === 'failed' ? { problem: 'error' as const } : null;
  const listed: MemoryWorkFact[] = [];
  if (facts) {
    for (const change of FACT_CHANGES) for (const id of payload.facts?.[change] ?? []) {
      if (listed.length >= FACTS_PER_EVENT) break;
      const n = factNumber(id);
      const fact = n === null ? undefined : facts.get(n);
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
    undo: facts ? undoOffer(job, payload.facts ?? null, facts) : null,
    failure,
    expiresAt,
  };
}

/** Forget what a run learned that is still active; bring back what it faded
 *  that is still faded. Recomputed from fact state on every read. */
function undoOffer(job: MemoryJobId, ids: MemoryJobFacts | null, facts: Map<number, FactState>): MemoryWorkEvent['undo'] {
  if (FORGETTABLE_JOBS.has(job)) {
    const count = (ids?.learned ?? []).filter((id) => facts.get(factNumber(id) ?? -1)?.active === true).length;
    return count > 0 ? { kind: 'forget', count } : null;
  }
  if (RESTORABLE_JOBS.has(job)) {
    const count = (ids?.faded ?? []).filter((id) => facts.get(factNumber(id) ?? -1)?.active === false).length;
    return count > 0 ? { kind: 'restore', count } : null;
  }
  return null;
}

/** Current text and active flag for each id, or null when memory.db cannot
 *  be read (then no facts and no undo are offered, rather than wrong ones). */
function readFacts(ids: number[]): Map<number, FactState> | null {
  const out = new Map<number, FactState>();
  if (ids.length === 0) return out;
  try {
    const db = openMemoryDb();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db.prepare(`
        SELECT id, active, substr(content, 1, ${FACT_TEXT_MAX * 2}) AS content
          FROM consolidated_facts
         WHERE id IN (${chunk.map(() => '?').join(',')})
      `).all(...chunk) as Array<{ id: number; active: number; content: string }>;
      for (const row of rows) out.set(row.id, { active: row.active === 1, text: clip(row.content, FACT_TEXT_MAX) });
    }
    return out;
  } catch {
    return null;
  }
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
 * active, or bring back each memory it faded that is still faded. The same
 * forget / restore the Memory tab's buttons use, so every door keeps one
 * safety story. Undo is a direct action, not a job: the next snapshot
 * recomputes what is left to undo from fact state.
 */
export function undoMemoryWork(eventId: string, now: Date = new Date()): MemoryWorkUndoResult {
  try {
    const row = openOperationalTelemetryDb().prepare(`
      SELECT event_id, ts, type, actor, session_id, payload_json
        FROM operational_events
       WHERE event_id = ? AND source = 'memory' AND type IN ('memory_work_completed', 'memory_work_failed')
    `).get(eventId) as EventRow | undefined;
    if (!row || !isMemoryJobId(row.actor)) return { ok: false, reason: 'not_found' };
    if (Date.parse(row.ts) < now.getTime() - MEMORY_WORK_RETENTION.detailDays * DAY_MS) return { ok: false, reason: 'expired' };
    const job = row.actor;
    const ids = parsePayload(row.payload_json).facts ?? null;
    const forget = FORGETTABLE_JOBS.has(job);
    if (!forget && !RESTORABLE_JOBS.has(job)) return { ok: false, reason: 'nothing_to_undo' };
    const targets = [...new Set((forget ? ids?.learned : ids?.faded) ?? [])]
      .map(factNumber)
      .filter((n): n is number => n !== null);
    if (targets.length === 0) return { ok: false, reason: 'nothing_to_undo' };
    const db = openMemoryDb();
    const changed = db.transaction(() => {
      let count = 0;
      const activeOf = db.prepare('SELECT active FROM consolidated_facts WHERE id = ?');
      for (const id of targets) {
        const fact = activeOf.get(id) as { active: number } | undefined;
        if (!fact) continue;
        if (forget && fact.active === 1 && forgetFact(id)) count += 1;
        if (!forget && fact.active === 0 && reactivateFact(id)) count += 1;
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

const PRODUCED_KEYS: readonly (keyof MemoryWorkProduced)[] = [
  'claims', 'learned', 'updated', 'reinforced', 'leftOut', 'setAside', 'faded',
  'restored', 'patterns', 'skills', 'proposals', 'embedded', 'entities',
];

function produced(value: MemoryWorkProduced | undefined): MemoryWorkProduced {
  const out: MemoryWorkProduced = {};
  for (const key of PRODUCED_KEYS) {
    const n = value?.[key];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function factNumber(id: unknown): number | null {
  const n = typeof id === 'number' ? id : Number.parseInt(String(id ?? ''), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
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
