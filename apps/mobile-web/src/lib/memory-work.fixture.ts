/**
 * Memory-work snapshots for tests and visual previews. Nothing in the app
 * imports this file, so it never ships in the bundle.
 *
 * Neutral on purpose: model ids are placeholders the catalog fixture names,
 * and the conversation titles are invented.
 */
import type {
  MemoryJobId,
  MemoryJobStatus,
  MemoryWorkEvent,
  MemoryWorkSnapshot,
  MemoryWorkState,
} from '@clem/chat-engine';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const FIXTURE_MEMORY_MODEL = 'memory-model';
export const FIXTURE_STAND_IN_MODEL = 'stand-in-model';
export const FIXTURE_EMBEDDER = 'local-embedder';

const iso = (t: number) => new Date(t).toISOString();

function zeroTotals() {
  return { runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, learned: 0, updated: 0, faded: 0 };
}

function job(id: MemoryJobId, patch: Partial<MemoryJobStatus>): MemoryJobStatus {
  const owner: Record<MemoryJobId, MemoryJobStatus['modelOwner']> = {
    learn: 'memory', reconcile: 'memory', patterns: 'memory', skills: 'memory', identity: 'memory', import: 'memory',
    standing: 'checker', verify: 'checker', index: 'local', tidy: 'none',
  };
  return { id, modelOwner: owner[id], state: 'idle', today: zeroTotals(), ...patch };
}

/** The jobs as the daemon sends them. When it cannot read the journal, every
 *  job has no last run and zero-filled totals (the contract's totals are
 *  plain numbers), so only `state: 'unknown'` says none of it was counted. */
function jobsAsSent(unknown: boolean, jobs: MemoryJobStatus[]): MemoryJobStatus[] {
  if (!unknown) return jobs;
  return jobs.map((j) => ({ ...j, state: 'idle', modelId: null, lastRun: null, today: zeroTotals() }));
}

function events(now: number): MemoryWorkEvent[] {
  const at = (ago: number) => iso(now - ago);
  const expires = (ago: number) => iso(now - ago + 7 * DAY);
  return [
    {
      id: 'ev-learn-1', job: 'learn', at: at(4 * MINUTE), startedAt: at(4 * MINUTE + 38_000), outcome: 'ok',
      model: { modelId: FIXTURE_MEMORY_MODEL, standIn: false },
      usage: { calls: 3, inputTokens: 9_400, outputTokens: 1_250, durationMs: 38_000 },
      source: { kind: 'conversation', sessionId: 'sess-1', title: 'Quarterly planning notes' },
      produced: { claims: 6, learned: 3, updated: 1, leftOut: 2 },
      facts: [
        { id: '101', text: 'Prefers the weekly summary on Monday mornings.', change: 'learned', active: true },
        { id: '102', text: 'The planning review moved to the second Thursday of the month.', change: 'learned', active: true },
        { id: '103', text: 'Uses the shared drive folder “Planning 2026” for drafts.', change: 'learned', active: false },
        { id: '88', text: 'The regional team has five people, not four.', change: 'updated', active: true },
      ],
      undo: { kind: 'forget', count: 2 },
      expiresAt: expires(4 * MINUTE),
    },
    {
      id: 'ev-index-1', job: 'index', at: at(5 * MINUTE), outcome: 'ok', model: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 900 },
      produced: { embedded: 4 }, expiresAt: expires(5 * MINUTE),
    },
    {
      id: 'ev-learn-2', job: 'learn', at: at(52 * MINUTE), startedAt: at(52 * MINUTE + 21_000), outcome: 'nothing_new',
      model: { modelId: FIXTURE_MEMORY_MODEL, standIn: false },
      usage: { calls: 1, inputTokens: 3_100, outputTokens: 180, durationMs: 21_000 },
      source: { kind: 'workflow', sessionId: 'wf-1', title: 'Vendor comparison' },
      produced: { claims: 1, leftOut: 1 }, expiresAt: expires(52 * MINUTE),
    },
    {
      id: 'ev-reconcile-1', job: 'reconcile', at: at(3 * HOUR), outcome: 'ok',
      model: { modelId: FIXTURE_STAND_IN_MODEL, standIn: true },
      usage: { calls: 1, inputTokens: 2_200, outputTokens: 90, durationMs: 4_000 },
      source: { kind: 'owner' },
      produced: { updated: 1 },
      facts: [{ id: '77', text: 'The office closes early on Fridays.', change: 'updated', active: true }],
      expiresAt: expires(3 * HOUR),
    },
    {
      id: 'ev-learn-fail', job: 'learn', at: at(6 * HOUR), outcome: 'failed',
      model: null, usage: null, source: { kind: 'conversation', sessionId: 'sess-2' },
      produced: {}, failure: { problem: 'quota' }, expiresAt: expires(6 * HOUR),
    },
    {
      id: 'ev-tidy-1', job: 'tidy', at: at(DAY + 2 * HOUR), outcome: 'ok', model: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 1_400 },
      source: { kind: 'schedule' },
      produced: { faded: 3 },
      facts: [
        { id: '12', text: 'Was travelling to the coast in early spring.', change: 'faded', active: false },
        { id: '13', text: 'Asked for a reminder about the old parking permit.', change: 'faded', active: false },
        { id: '14', text: 'Tried the previous invoicing template.', change: 'faded', active: true },
      ],
      undo: { kind: 'restore', count: 2 },
      expiresAt: expires(DAY + 2 * HOUR),
    },
    {
      id: 'ev-patterns-1', job: 'patterns', at: at(DAY + 5 * HOUR), outcome: 'ok',
      model: { modelId: FIXTURE_MEMORY_MODEL, standIn: false },
      usage: { calls: 2, inputTokens: 14_000, outputTokens: 900, durationMs: 61_000 },
      source: { kind: 'schedule' }, produced: { patterns: 2 }, expiresAt: expires(DAY + 5 * HOUR),
    },
    {
      id: 'ev-skills-1', job: 'skills', at: at(3 * DAY), outcome: 'ok',
      model: { modelId: FIXTURE_MEMORY_MODEL, standIn: false },
      usage: { calls: 1, inputTokens: 5_000, outputTokens: 700, durationMs: 12_000 },
      source: { kind: 'conversation', sessionId: 'sess-3', title: 'Monthly report' },
      produced: { skills: 1 }, expiresAt: expires(3 * DAY),
    },
  ];
}

function hourly(now: number): MemoryWorkSnapshot['hourly'] {
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const calls = [0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 5, 3, 0, 1, 4, 6, 2, 0, 0, 3, 7, 4, 1, 3];
  const learned = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 1, 3, 0, 0, 0, 1, 2, 1, 0, 3];
  return calls.map((modelCalls, i) => ({
    hourStart: iso(currentHour - (23 - i) * HOUR),
    runs: modelCalls > 0 ? Math.ceil(modelCalls / 2) + 1 : (i % 5 === 0 ? 1 : 0),
    modelCalls,
    learned: learned[i] ?? 0,
  }));
}

function daily(now: number, days: number): MemoryWorkSnapshot['daily'] {
  const out: MemoryWorkSnapshot['daily'] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now - i * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const modelCalls = [12, 30, 22, 8, 0, 41, 26, 18, 35, 14, 9, 27][i % 12] ?? 0;
    out.push({ day: key, runs: Math.ceil(modelCalls / 2), modelCalls, learned: Math.floor(modelCalls / 4), inputTokens: modelCalls * 3_000, outputTokens: modelCalls * 250 });
  }
  return out;
}

/** A believable day in each state the headline knows. */
export function memoryWorkFixture(state: MemoryWorkState = 'resting', now = Date.now()): MemoryWorkSnapshot {
  const working = state === 'working';
  const waiting = state === 'waiting';
  const off = state === 'off';
  const unknown = state === 'unknown';
  const recent = unknown ? [] : events(now);
  return {
    generatedAt: iso(now),
    state,
    running: working
      ? [{ job: 'learn', startedAt: iso(now - 40_000), source: { kind: 'conversation', sessionId: 'sess-9', title: 'Supplier onboarding call' }, part: 2, parts: 3 }]
      : [],
    waiting: waiting ? { reason: 'model_paused', problem: 'quota', since: iso(now - 5 * MINUTE), until: iso(now + 25 * MINUTE) } : null,
    lastWorkAt: unknown ? null : iso(now - 4 * MINUTE),
    queue: unknown ? { toLearn: null, setAside: null, failed: null } : { toLearn: waiting ? 5 : 0, setAside: 3, failed: 1 },
    model: {
      source: 'automatic',
      modelId: unknown ? null : FIXTURE_MEMORY_MODEL,
      follows: 'checker',
      lastServed: unknown ? null : { modelId: FIXTURE_MEMORY_MODEL, at: iso(now - 4 * MINUTE), standIn: false },
      unavailable: waiting ? { problem: 'quota', until: iso(now + 25 * MINUTE) } : null,
    },
    embedder: unknown ? null : { modelId: FIXTURE_EMBEDDER, local: true },
    jobs: jobsAsSent(unknown, [
      job('learn', {
        state: working ? 'running' : waiting ? 'waiting' : off ? 'off' : 'idle',
        modelId: FIXTURE_MEMORY_MODEL,
        lastRun: { at: iso(now - 4 * MINUTE), outcome: 'ok', durationMs: 38_000 },
        next: { trigger: 'after_conversation' },
        today: { runs: 6, modelCalls: 14, inputTokens: 41_000, outputTokens: 5_200, learned: 7, updated: 2, faded: 0 },
      }),
      job('reconcile', {
        modelId: FIXTURE_STAND_IN_MODEL,
        lastRun: { at: iso(now - 3 * HOUR), outcome: 'ok' },
        next: { trigger: 'on_save' },
        today: { runs: 3, modelCalls: 3, inputTokens: 6_600, outputTokens: 270, learned: 1, updated: 1, faded: 0 },
      }),
      job('patterns', { modelId: FIXTURE_MEMORY_MODEL, lastRun: { at: iso(now - DAY - 5 * HOUR), outcome: 'ok' }, next: { trigger: 'nightly', at: iso(now + 9 * HOUR) } }),
      job('skills', { modelId: FIXTURE_MEMORY_MODEL, lastRun: { at: iso(now - 3 * DAY), outcome: 'ok' }, next: { trigger: 'after_success' } }),
      job('identity', { modelId: FIXTURE_MEMORY_MODEL, lastRun: null, next: { trigger: 'daily' } }),
      job('import', { modelId: FIXTURE_MEMORY_MODEL, lastRun: null, next: { trigger: 'on_request' } }),
      job('standing', { modelId: 'checker-model', lastRun: { at: iso(now - 2 * HOUR), outcome: 'nothing_new' }, next: { trigger: 'after_message' } }),
      job('verify', { modelId: 'checker-model', lastRun: null, next: { trigger: 'after_correction' } }),
      job('index', {
        modelId: FIXTURE_EMBEDDER,
        lastRun: { at: iso(now - 5 * MINUTE), outcome: 'ok' },
        next: { trigger: 'every_few_minutes' },
        today: { runs: 9, modelCalls: 0, inputTokens: 0, outputTokens: 0, learned: 0, updated: 0, faded: 0 },
      }),
      job('tidy', { modelId: null, lastRun: { at: iso(now - DAY - 2 * HOUR), outcome: 'ok' }, next: { trigger: 'nightly', at: iso(now + 10 * HOUR) } }),
    ]),
    today: unknown
      ? { ...zeroTotals(), conversationsRead: 0, claimsFound: 0, leftOut: 0, setAside: 0, costUsd: null }
      : {
          runs: 18, modelCalls: 17, inputTokens: 47_600, outputTokens: 5_470, learned: 8, updated: 3, faded: 3,
          conversationsRead: 5, claimsFound: 19, leftOut: 4, setAside: 3, costUsd: null,
        },
    hourly: unknown ? [] : hourly(now),
    daily: unknown ? [] : daily(now, 30),
    recent,
    retention: { detailDays: 7, summaryDays: 90 },
  };
}

/** Settings as the Models card loads them, naming the fixture models. */
export function memoryModelSettingsFixture() {
  const groups = [
    { provider: 'byo', providerId: 'provider-a', label: 'Provider A', models: [{ id: FIXTURE_MEMORY_MODEL, label: 'Quick model' }, { id: 'checker-model', label: 'Careful model' }] },
    { provider: 'byo', providerId: 'provider-b', label: 'Provider B', models: [{ id: FIXTURE_STAND_IN_MODEL, label: 'Backup model' }] },
  ];
  return {
    brain: { modelId: 'brain-model', provider: 'byo', source: 'default' },
    options: [{ id: 'provider-a', value: 'provider-a:brain-model', label: 'Provider A — Main model', available: true, modelId: 'brain-model' }],
    effectiveValue: 'provider-a:brain-model',
    activeBrain: 'provider-a',
    roles: {
      writer: { modelId: 'brain-model', provider: 'byo', source: 'default' },
      judge: { modelId: 'checker-model', provider: 'byo', source: 'default' },
      worker: { modelId: 'brain-model', provider: 'byo', source: 'default' },
      memory: { modelId: FIXTURE_MEMORY_MODEL, provider: 'byo', source: 'default', follows: 'checker' as const },
    },
    roleOptions: { writer: groups, judge: groups, worker: groups, memory: groups },
    judgeReviewsOwnFamily: false,
  };
}
