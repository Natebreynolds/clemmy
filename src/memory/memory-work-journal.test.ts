/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-work-journal.test.ts
 *
 * The memory-work journal: a job is listed as running only while it runs,
 * its model calls carry the job's channel and come back to it, and one event
 * (ids only) plus the day's counters record what it did. Nothing-new runs
 * only refresh "last checked". History ages out on a persisted clock.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';

const journal = await import('./memory-work-journal.js');
const telemetry = await import('../runtime/operational-telemetry.js');
const { recordModelUsage, withModelUsageAttribution, modelUsageAttributionStorage } = await import('../runtime/usage-log.js');
const { withModelRouteMetrics } = await import('../runtime/model-route-metrics.js');
type Model = import('@openai/agents-core').Model;
type ModelRequest = import('@openai/agents-core').ModelRequest;

const {
  runMemoryJob,
  listRunningMemoryJobs,
  lastCheckedByJob,
  setMemoryLearningWaiting,
  readMemoryLearningWaiting,
  decayMemoryWork,
  sweepMemoryWorkIfDue,
  memoryModelProblemFromError,
  localDayKey,
  MEMORY_WORK_RETENTION,
  _resetMemoryWorkJournalForTest,
} = journal;

beforeEach(() => {
  telemetry.resetOperationalTelemetryForTest();
  _resetMemoryWorkJournalForTest();
});

function call(model: string, inputTokens = 100, outputTokens = 10, ok = true): void {
  recordModelUsage({ sessionId: 'unknown', model, inputTokens, outputTokens, durationMs: 40, ...(ok ? {} : { ok: false, failReason: 'boom' }) });
}

function memoryEvents(type?: 'memory_work_completed' | 'memory_work_failed') {
  return telemetry.listOperationalEvents({ source: 'memory', ...(type ? { type } : {}) })
    .filter((e) => e.type === 'memory_work_completed' || e.type === 'memory_work_failed');
}

function dailyRows(): Array<Record<string, unknown>> {
  return telemetry.openOperationalTelemetryDb().prepare('SELECT * FROM memory_work_daily ORDER BY day, job').all() as Array<Record<string, unknown>>;
}

test('a run records the model that served it, the tokens, and ids only', async () => {
  const value = await runMemoryJob('learn', {
    source: { kind: 'conversation', sessionId: 'sess-a', title: 'never stored' },
    part: 1,
    parts: 2,
    requestedModelId: 'memory-model',
  }, async () => {
    call('memory-model', 120, 12);
    call('memory-model', 80, 8);
    return { learned: ['11', '12'] };
  }, (v) => ({ outcome: 'ok', produced: { claims: 3, learned: 2, leftOut: 1 }, facts: { learned: v.learned } }));
  assert.deepEqual(value, { learned: ['11', '12'] }, 'the job value passes through untouched');

  const [event] = memoryEvents('memory_work_completed');
  assert.ok(event, 'one event recorded');
  assert.equal(event.actor, 'learn');
  assert.equal(event.sessionId, 'sess-a');
  const p = event.payload as Record<string, any>;
  assert.equal(p.job, 'learn');
  assert.equal(p.outcome, 'ok');
  assert.deepEqual(p.model, { modelId: 'memory-model', requestedModelId: 'memory-model', standIn: false });
  assert.equal(p.usage.calls, 2);
  // Token counts survive the telemetry redactor (top-level metric keys).
  assert.equal(p.inputTokens, 200);
  assert.equal(p.outputTokens, 20);
  assert.deepEqual(p.produced, { claims: 3, learned: 2, leftOut: 1 });
  assert.deepEqual(p.facts, { learned: ['11', '12'] });
  assert.deepEqual(p.source, { kind: 'conversation', sessionId: 'sess-a' }, 'no title or text is stored');
  assert.equal(p.part, 1);
  assert.equal(p.parts, 2);
  assert.equal(p.failure, null);
  assert.equal(typeof p.durationMs, 'number');
  assert.equal(typeof p.startedAt, 'string');

  const [row] = dailyRows();
  assert.equal(row.day, localDayKey(new Date()));
  assert.equal(row.job, 'learn');
  assert.equal(row.runs, 1);
  assert.equal(row.model_calls, 2);
  assert.equal(row.input_tokens, 200);
  assert.equal(row.output_tokens, 20);
  assert.equal(row.learned, 2);
  assert.equal(row.claims, 3);
  assert.equal(row.left_out, 1);
  assert.equal(row.conversations, 1);
  assert.equal(row.last_outcome, 'ok');
  assert.equal(row.last_model_id, 'memory-model');
  assert.equal(row.last_model_stand_in, 0);
});

test('model calls inside a job carry its channel and the memory role, even inside a chat scope', async () => {
  await withModelUsageAttribution({ sessionId: 'sess-chat', sourceUserSeq: 5, channel: 'chat' }, () =>
    runMemoryJob('learn', {}, async () => { call('memory-model'); }, () => ({ outcome: 'nothing_new' })));
  // A checker job's judge route opens a narrower scope that keeps the
  // inherited channel and names its own role (routeAttributionContext).
  await runMemoryJob('standing', {}, async () => withModelUsageAttribution(
    { ...modelUsageAttributionStorage.getStore()!, role: 'reviewer' },
    async () => { call('checker-model'); },
  ), () => ({ outcome: 'nothing_new' }));
  const calls = telemetry.listOperationalEvents({ source: 'model', type: 'model_call_completed' });
  const learn = calls.find((e) => (e.payload as { model?: string }).model === 'memory-model');
  const standing = calls.find((e) => (e.payload as { model?: string }).model === 'checker-model');
  assert.equal((learn?.payload as { channel?: string }).channel, 'memory:learn');
  assert.equal((learn?.payload as { role?: string }).role, 'memory');
  assert.notEqual(learn?.sessionId, 'sess-chat', 'memory tokens are never charged to the conversation');
  assert.equal((standing?.payload as { channel?: string }).channel, 'memory:standing');
  assert.equal((standing?.payload as { role?: string }).role, 'reviewer', 'the checker jobs keep their own role');
});

/** A routed call the way an adapter makes one: the route wrapper records the
 *  decision, the adapter records its usage. */
function routedCall(source: 'explicit' | 'fallback', model: string) {
  const inner = {
    getResponse: async () => {
      recordModelUsage({ sessionId: 'unknown', model, inputTokens: 10, outputTokens: 1 });
      return { output: [], usage: {}, providerData: {} };
    },
    getStreamedResponse: async function* () { /* unused */ },
  } as unknown as Model;
  return withModelRouteMetrics(inner, {
    role: 'memory', requestedModel: 'memory-model', resolvedModel: model, provider: 'unknown', source,
  }).getResponse({ input: 'x', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest);
}

test('a stand-in is named only when the route says it stood in, never by comparing names', async () => {
  await runMemoryJob('learn', { requestedModelId: 'memory-model' }, async () => { await routedCall('fallback', 'backup-model'); }, () => ({ outcome: 'nothing_new' }));
  await runMemoryJob('reconcile', { requestedModelId: 'memory-model' }, async () => { await routedCall('explicit', 'memory-model-2026'); }, () => ({ outcome: 'nothing_new' }));
  const byJob = new Map(memoryEvents().map((e) => [e.actor, e.payload as Record<string, any>]));
  assert.deepEqual(byJob.get('learn')?.model, { modelId: 'backup-model', requestedModelId: 'memory-model', standIn: true });
  assert.deepEqual(byJob.get('reconcile')?.model, { modelId: 'memory-model-2026', requestedModelId: 'memory-model', standIn: false },
    'a served id spelled differently is not a stand-in');
  const learnRow = dailyRows().find((r) => r.job === 'learn');
  assert.equal(learnRow?.last_model_stand_in, 1);
});

test('a nested job owns its own calls; the job around it never counts them twice', async () => {
  await runMemoryJob('patterns', { source: { kind: 'schedule' } }, async () => {
    call('outer-model', 50, 5);
    await runMemoryJob('reconcile', {}, async () => { call('inner-model', 30, 3); }, () => ({ outcome: 'ok', produced: { updated: 1 }, facts: { updated: ['7'] } }));
  }, () => ({ outcome: 'ok', produced: { patterns: 1 } }));
  const byJob = new Map(memoryEvents().map((e) => [e.actor, e.payload as Record<string, any>]));
  assert.equal(byJob.get('patterns')?.usage.calls, 1);
  assert.equal(byJob.get('patterns')?.model.modelId, 'outer-model');
  assert.equal(byJob.get('reconcile')?.usage.calls, 1);
  assert.equal(byJob.get('reconcile')?.model.modelId, 'inner-model');
  const calls = telemetry.listOperationalEvents({ source: 'model', type: 'model_call_completed' });
  assert.equal((calls.find((e) => (e.payload as { model?: string }).model === 'inner-model')?.payload as { channel?: string }).channel, 'memory:reconcile');
});

test('a job is listed as running only while it runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = runMemoryJob('learn', { source: { kind: 'workflow', sessionId: 'sess-w' }, part: 2, parts: 3 }, async () => { await gate; }, () => ({ outcome: 'nothing_new' }));
  const running = listRunningMemoryJobs();
  assert.equal(running.length, 1);
  assert.equal(running[0].job, 'learn');
  assert.deepEqual(running[0].source, { kind: 'workflow', sessionId: 'sess-w' });
  assert.equal(running[0].part, 2);
  assert.equal(running[0].parts, 3);
  release();
  await run;
  assert.deepEqual(listRunningMemoryJobs(), []);
});

test('a failed run rethrows the original error and records what served before it', async () => {
  const boom = new Error('parse failed');
  await assert.rejects(runMemoryJob('learn', { requestedModelId: 'memory-model' }, async () => {
    call('memory-model', 90, 0);
    throw boom;
  }, () => ({ outcome: 'ok' })), (err) => err === boom);
  assert.deepEqual(listRunningMemoryJobs(), []);
  const [event] = memoryEvents('memory_work_failed');
  assert.ok(event);
  assert.equal(event.severity, 'warn');
  const p = event.payload as Record<string, any>;
  assert.equal(p.outcome, 'failed');
  assert.deepEqual(p.failure, { problem: 'error' });
  assert.equal(p.model.modelId, 'memory-model');
  assert.equal(p.inputTokens, 90);
  assert.equal(dailyRows()[0].conversations, 0, 'a failed read is not a conversation read');
});

test('a thrown model error names its problem class, never a provider', () => {
  assert.equal(memoryModelProblemFromError(Object.assign(new Error('payment required'), { status: 402 })), 'credit');
  assert.equal(memoryModelProblemFromError(Object.assign(new Error('slow down'), { status: 429 })), 'quota');
  assert.equal(memoryModelProblemFromError(Object.assign(new Error('unauthorized'), { status: 401 })), 'not_connected');
  assert.equal(memoryModelProblemFromError(new Error('socket hang up')), 'timeout');
  assert.equal(memoryModelProblemFromError(new Error('something else')), 'error');
  assert.equal(memoryModelProblemFromError(null), 'error');
});

test('a summarize that says failed records the failure without a throw', async () => {
  await runMemoryJob('learn', {}, async () => null, () => ({ outcome: 'failed', failure: { problem: 'quota' } }));
  const [event] = memoryEvents('memory_work_failed');
  assert.deepEqual((event.payload as Record<string, any>).failure, { problem: 'quota' });
  assert.equal((event.payload as Record<string, any>).model, null, 'no call, no model named');
});

test('a run with no model call and no change only refreshes last checked', async () => {
  await runMemoryJob('index', {}, async () => ({ embedded: 0 }), () => ({ outcome: 'nothing_new', produced: { embedded: 0 } }));
  assert.equal(memoryEvents().length, 0);
  assert.deepEqual(dailyRows(), []);
  assert.ok(lastCheckedByJob().index, 'last checked is kept in memory');

  await runMemoryJob('tidy', {}, async () => 0, () => ({ outcome: 'nothing_new', record: true }));
  assert.equal(memoryEvents().length, 1, 'record: true writes the run anyway');

  await runMemoryJob('index', {}, async () => 3, () => ({ outcome: 'ok', produced: { embedded: 3 } }));
  assert.equal(memoryEvents().length, 2, 'a change is always recorded');
});

test('a summarize that throws still records the job as done', async () => {
  await runMemoryJob('skills', {}, async () => { call('memory-model'); return 1; }, () => { throw new Error('bad summary'); });
  const [event] = memoryEvents('memory_work_completed');
  assert.equal((event.payload as Record<string, any>).outcome, 'ok');
});

test('conversations read counts each conversation once a day, however many parts', async () => {
  const learn = (sessionId: string | undefined, part: number) => runMemoryJob('learn', {
    source: sessionId ? { kind: 'conversation', sessionId } : { kind: 'tool' },
    part,
    parts: 2,
  }, async () => { call('memory-model'); }, () => ({ outcome: 'ok' }));
  await learn('sess-a', 1);
  await learn('sess-a', 2);
  await learn('sess-b', 1);
  await learn(undefined, 1);
  const [row] = dailyRows();
  assert.equal(row.runs, 4);
  assert.equal(row.conversations, 2);
});

test('the learning waiting note passes through and goes stale when the drain stops re-stating it', () => {
  assert.equal(readMemoryLearningWaiting(), null);
  setMemoryLearningWaiting({ reason: 'model_paused', until: '2026-09-27T10:00:00.000Z', problem: 'quota' });
  assert.deepEqual(readMemoryLearningWaiting(), { reason: 'model_paused', until: '2026-09-27T10:00:00.000Z', problem: 'quota' });
  assert.equal(readMemoryLearningWaiting(new Date(Date.now() + journal.MEMORY_WORK_WAITING_FRESH_MS + 1_000)), null);
  setMemoryLearningWaiting(null);
  assert.equal(readMemoryLearningWaiting(), null);
});

function seedEvent(at: Date, type: 'memory_work_completed' | 'memory_work_failed' = 'memory_work_completed') {
  return telemetry.recordOperationalEvent({ source: 'memory', type, actor: 'learn', payload: { job: 'learn', outcome: 'ok' }, now: at }, telemetry.openOperationalTelemetryDb());
}

test('retention deletes detail after 7 days and daily totals after 90, nothing else', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const db = telemetry.openOperationalTelemetryDb();
  seedEvent(new Date(now.getTime() - 8 * 86_400_000));
  seedEvent(new Date(now.getTime() - 6 * 86_400_000), 'memory_work_failed');
  telemetry.recordOperationalEvent({ source: 'memory', type: 'semantic_fact_upserted', payload: {}, now: new Date(now.getTime() - 8 * 86_400_000) }, db);
  const insertDay = db.prepare('INSERT INTO memory_work_daily (day, job, runs) VALUES (?, ?, 1)');
  insertDay.run(localDayKey(new Date(now.getTime() - 91 * 86_400_000)), 'learn');
  insertDay.run(localDayKey(new Date(now.getTime() - 89 * 86_400_000)), 'learn');

  assert.deepEqual(decayMemoryWork(now), { detailDeleted: 1, dailyDeleted: 1 });
  assert.equal(memoryEvents().length, 1, 'the 6-day-old event stays');
  assert.equal(telemetry.listOperationalEvents({ source: 'memory', type: 'semantic_fact_upserted' }).length, 1, 'other memory events keep their own reaper');
  assert.equal(dailyRows().length, 1);
  assert.deepEqual(MEMORY_WORK_RETENTION, { detailDays: 7, summaryDays: 90 });
});

test('the retention sweep runs at most hourly on a clock that survives a restart', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  seedEvent(new Date(now.getTime() - 8 * 86_400_000));
  assert.deepEqual(sweepMemoryWorkIfDue(now), { detailDeleted: 1, dailyDeleted: 0 });
  seedEvent(new Date(now.getTime() - 8 * 86_400_000));
  assert.equal(sweepMemoryWorkIfDue(new Date(now.getTime() + 60_000)), null, 'not due within the hour');
  _resetMemoryWorkJournalForTest(); // a restart forgets the in-process due time …
  assert.equal(sweepMemoryWorkIfDue(new Date(now.getTime() + 30 * 60_000)), null, '… but the persisted stamp still holds');
  assert.deepEqual(sweepMemoryWorkIfDue(new Date(now.getTime() + 61 * 60_000)), { detailDeleted: 1, dailyDeleted: 0 });
  const stamp = telemetry.openOperationalTelemetryDb().prepare(`SELECT value FROM memory_work_meta WHERE key = 'retention_swept_at'`).get() as { value: string };
  assert.equal(stamp.value, new Date(now.getTime() + 61 * 60_000).toISOString());
});

test('the journal remembers when it began, so earlier days are absent rather than zero', () => {
  const row = telemetry.openOperationalTelemetryDb().prepare(`SELECT value FROM memory_work_meta WHERE key = 'journal_since'`).get() as { value: string } | undefined;
  assert.ok(row && Number.isFinite(Date.parse(row.value)));
});
