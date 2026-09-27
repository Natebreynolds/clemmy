/**
 * A made-up `MemoryWorkSnapshot` for tests and design previews. Nothing in the
 * app imports this file, so it never ships; the preview script serves it by
 * intercepting the route, never by a switch in the bundle.
 *
 * Model ids are neutral on purpose (no real model or provider names in source).
 */
import {
  MEMORY_JOB_ORDER,
  type MemoryJobId,
  type MemoryJobStatus,
  type MemoryWorkEvent,
  type MemoryWorkSnapshot,
  type MemoryWorkState,
} from '@clem/chat-engine';

export type MemoryWorkFixtureState = MemoryWorkState;

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;

const iso = (t: number) => new Date(t).toISOString();

function hourStart(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const OWNER: Record<MemoryJobId, MemoryJobStatus['modelOwner']> = {
  learn: 'memory', reconcile: 'memory', patterns: 'memory', skills: 'memory', identity: 'memory', import: 'memory',
  standing: 'checker', verify: 'checker', index: 'local', tidy: 'none',
};

const TRIGGER: Record<MemoryJobId, NonNullable<MemoryJobStatus['next']>['trigger']> = {
  learn: 'after_conversation', reconcile: 'on_save', patterns: 'nightly', skills: 'after_success', identity: 'daily',
  import: 'on_request', standing: 'after_message', verify: 'nightly', index: 'every_few_minutes', tidy: 'nightly',
};

function zeroTotals() {
  return { runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, learned: 0, updated: 0, faded: 0 };
}

/** A believable day of memory work, for the state asked. */
export function memoryWorkFixture(state: MemoryWorkFixtureState, now: number = Date.now()): MemoryWorkSnapshot {
  const memoryModel = 'memory-model-large';
  const checkerModel = 'checker-model-fast';
  const embedder = 'local-embedder-small';
  const expires = (t: number) => iso(t + 7 * DAY);

  const recent: MemoryWorkEvent[] = [
    {
      id: 'evt-9', job: 'learn', at: iso(now - 4 * MIN), startedAt: iso(now - 4 * MIN - 9_000), outcome: 'ok',
      model: { modelId: memoryModel, standIn: false },
      usage: { calls: 2, inputTokens: 9_800, outputTokens: 1_240, cachedInputTokens: 6_100, durationMs: 8_400 },
      source: { kind: 'conversation', sessionId: 'fixture-a', title: 'Prospect research for the west region' },
      produced: { claims: 7, learned: 3, reinforced: 1, leftOut: 3 },
      facts: [
        { id: '101', text: 'Prefers weekly pipeline summaries on Monday mornings', change: 'learned', active: true },
        { id: '102', text: 'The west region team meets on Thursdays at 10:00', change: 'learned', active: true },
        { id: '103', text: 'Wants prospect lists grouped by industry, then by size', change: 'learned', active: true },
        { id: '88', text: 'Works from the Denver office', change: 'reinforced', active: true },
      ],
      undo: { kind: 'forget', count: 3 },
      expiresAt: expires(now - 4 * MIN),
    },
    {
      id: 'evt-8', job: 'reconcile', at: iso(now - 38 * MIN), outcome: 'ok',
      model: { modelId: memoryModel, standIn: false },
      usage: { calls: 1, inputTokens: 2_100, outputTokens: 180, durationMs: 2_300 },
      source: { kind: 'owner' },
      produced: { updated: 1 },
      facts: [{ id: '77', text: 'Quarterly review moved to the second week of October', change: 'updated', active: true }],
      undo: null,
      expiresAt: expires(now - 38 * MIN),
    },
    {
      id: 'evt-7', job: 'learn', at: iso(now - 2 * HOUR - 12 * MIN), outcome: 'nothing_new',
      model: { modelId: memoryModel, standIn: false },
      usage: { calls: 1, inputTokens: 4_300, outputTokens: 90, durationMs: 3_900 },
      source: { kind: 'workflow', sessionId: 'fixture-b', title: 'Morning inbox sweep' },
      produced: { claims: 2, leftOut: 2 },
      facts: [],
      undo: null,
      expiresAt: expires(now - 2 * HOUR),
    },
    {
      id: 'evt-6', job: 'learn', at: iso(now - 3 * HOUR - 5 * MIN), outcome: 'failed',
      model: null,
      usage: null,
      source: { kind: 'conversation', sessionId: 'fixture-c', title: 'Draft the partner update' },
      produced: {},
      failure: { problem: 'timeout' },
      expiresAt: expires(now - 3 * HOUR),
    },
    {
      id: 'evt-5', job: 'index', at: iso(now - 3 * HOUR - 40 * MIN), outcome: 'ok',
      model: { modelId: embedder, standIn: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 640 },
      source: { kind: 'schedule' },
      produced: { embedded: 12 },
      expiresAt: expires(now - 3 * HOUR),
    },
    {
      id: 'evt-4', job: 'tidy', at: iso(now - 20 * HOUR), outcome: 'ok',
      model: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 1_200 },
      source: { kind: 'schedule' },
      produced: { faded: 4 },
      facts: [
        { id: '12', text: 'Was evaluating two note-taking apps', change: 'faded', active: false },
        { id: '19', text: 'Planned a trip in the spring', change: 'faded', active: false },
        { id: '23', text: 'Asked for daily summaries during the launch', change: 'faded', active: false },
        { id: '31', text: 'Used a temporary shared folder for the audit', change: 'faded', active: false },
      ],
      undo: { kind: 'restore', count: 4 },
      expiresAt: expires(now - 20 * HOUR),
    },
    {
      id: 'evt-3', job: 'patterns', at: iso(now - 21 * HOUR), outcome: 'ok',
      model: { modelId: 'memory-model-backup', standIn: true },
      usage: { calls: 3, inputTokens: 21_400, outputTokens: 2_050, durationMs: 31_000 },
      source: { kind: 'schedule' },
      produced: { patterns: 2 },
      expiresAt: expires(now - 21 * HOUR),
    },
    {
      id: 'evt-2', job: 'standing', at: iso(now - 26 * HOUR), outcome: 'ok',
      model: { modelId: checkerModel, standIn: false },
      usage: { calls: 1, inputTokens: 1_600, outputTokens: 60, durationMs: 1_700 },
      source: { kind: 'conversation', sessionId: 'fixture-d', title: 'Set up the weekly digest' },
      produced: { learned: 1 },
      expiresAt: expires(now - 26 * HOUR),
    },
  ];

  const hourly = Array.from({ length: 24 }, (_, i) => {
    const start = hourStart(now) - (23 - i) * HOUR;
    const h = new Date(start).getHours();
    const busy = h >= 8 && h <= 18;
    const calls = state === 'unknown' ? 0 : busy ? [3, 6, 2, 9, 4, 12, 5, 7, 1, 8, 6][h % 11] ?? 2 : h === 3 ? 4 : 0;
    return { hourStart: iso(start), runs: calls ? Math.max(1, Math.round(calls / 2)) : 0, modelCalls: calls, learned: busy && h % 3 === 0 ? 2 : 0 };
  });

  const daily = Array.from({ length: 24 }, (_, i) => {
    const t = now - (23 - i) * DAY;
    const calls = [120, 180, 96, 210, 0, 40, 160, 230, 190, 140, 88, 0, 20, 150, 170, 205, 220, 130, 90, 160, 180, 200, 175, 110][i] ?? 100;
    return { day: dayKey(t), runs: Math.round(calls / 3), modelCalls: calls, learned: Math.round(calls / 12), inputTokens: calls * 4_000, outputTokens: calls * 300 };
  });

  const running = state === 'working'
    ? [{ job: 'learn' as const, startedAt: iso(now - 12_000), source: { kind: 'conversation' as const, sessionId: 'fixture-e', title: 'Pricing questions from the Tuesday call' }, part: 2, parts: 4 }]
    : [];

  const jobs: MemoryJobStatus[] = MEMORY_JOB_ORDER.map((id) => {
    const lastEvent = recent.find((e) => e.job === id);
    const todayEvents = recent.filter((e) => e.job === id && dayKey(Date.parse(e.at)) === dayKey(now));
    const today = zeroTotals();
    for (const e of todayEvents) {
      today.runs += 1;
      today.modelCalls += e.usage?.calls ?? 0;
      today.inputTokens += e.usage?.inputTokens ?? 0;
      today.outputTokens += e.usage?.outputTokens ?? 0;
      today.learned += e.produced.learned ?? 0;
      today.updated += e.produced.updated ?? 0;
      today.faded += e.produced.faded ?? 0;
    }
    const owner = OWNER[id];
    const isRunning = running.some((r) => r.job === id);
    const jobState: MemoryJobStatus['state'] = isRunning
      ? 'running'
      : id === 'learn' && state === 'waiting' ? 'waiting'
      : id === 'learn' && state === 'off' ? 'off'
      : 'idle';
    const nightlyHour = id === 'patterns' ? 3 : id === 'tidy' ? 4 : id === 'verify' ? 4 : null;
    let nextAt: string | undefined;
    if (nightlyHour !== null) {
      const d = new Date(now);
      d.setHours(nightlyHour, id === 'verify' ? 35 : 0, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      nextAt = iso(d.getTime());
    }
    return {
      id,
      modelOwner: owner,
      state: jobState,
      modelId: owner === 'none' ? null : owner === 'local' ? embedder : owner === 'checker' ? checkerModel : lastEvent?.model?.modelId ?? memoryModel,
      lastRun: lastEvent ? { at: lastEvent.at, outcome: lastEvent.outcome, durationMs: lastEvent.usage?.durationMs } : null,
      next: { trigger: TRIGGER[id], ...(nextAt ? { at: nextAt } : {}) },
      today,
    };
  });

  const base: MemoryWorkSnapshot = {
    generatedAt: iso(now),
    state,
    running,
    waiting: state === 'waiting'
      ? { reason: 'model_paused', since: iso(now - 6 * MIN), until: iso(now + 22 * MIN), problem: 'quota' }
      : null,
    lastWorkAt: iso(now - 4 * MIN),
    queue: { toLearn: state === 'resting' ? 0 : 6, setAside: 14, failed: 1 },
    model: {
      source: 'automatic',
      modelId: memoryModel,
      follows: 'checker',
      lastServed: { modelId: memoryModel, at: iso(now - 4 * MIN), standIn: false },
      unavailable: state === 'waiting' ? { problem: 'quota', until: iso(now + 22 * MIN) } : null,
    },
    embedder: { modelId: embedder, local: true },
    jobs,
    today: {
      runs: 31, modelCalls: 58, inputTokens: 212_000, outputTokens: 18_400, learned: 9, updated: 2, faded: 0,
      conversationsRead: 11, claimsFound: 46, leftOut: 29, setAside: 6, costUsd: null,
    },
    hourly,
    daily,
    // The journal began 23 days ago: the first daily bar counts from then.
    measuredSince: iso(now - 23 * DAY),
    recent,
    retention: { detailDays: 7, summaryDays: 90 },
  };

  if (state === 'unknown') {
    // The daemon's own shape when the journal cannot be read: every job
    // listed with no model, no last run and a zero day (the contract types
    // those counts as numbers), the queue null, the lists empty. The model is
    // still described (that read is separate); the running list is read in
    // process, so it can still hold a job.
    return {
      ...base,
      running: [],
      waiting: null,
      lastWorkAt: null,
      queue: { toLearn: null, setAside: null, failed: null },
      model: { source: 'automatic', modelId: memoryModel, follows: 'checker', lastServed: null, unavailable: null },
      embedder: null,
      jobs: MEMORY_JOB_ORDER.map((id) => ({
        id,
        modelOwner: OWNER[id],
        state: 'idle' as const,
        modelId: null,
        lastRun: null,
        next: { trigger: TRIGGER[id] },
        today: zeroTotals(),
      })),
      today: { ...zeroTotals(), conversationsRead: 0, claimsFound: 0, leftOut: 0, setAside: 0, costUsd: null },
      hourly: [],
      daily: [],
      measuredSince: null,
      recent: [],
    };
  }
  return base;
}
