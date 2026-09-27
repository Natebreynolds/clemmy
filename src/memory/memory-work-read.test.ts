/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-work-read.test.ts
 *
 * The Memory-at-work read model: "working" only while a job runs here,
 * waiting passes through, unreadable is `unknown` (never zeros dressed as
 * facts), undo follows fact state, and the snapshot carries every key the
 * apps' contract names. Also: it stays cheap on a busy week of history.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.OPENAI_API_KEY;
delete process.env.CLEMMY_REFLECTION;

const telemetry = await import('../runtime/operational-telemetry.js');
const journal = await import('./memory-work-journal.js');
const read = await import('./memory-work-read.js');
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact, forgetFact, getFact, reactivateFact, setFactPinned, supersedeFact } = await import('./facts.js');
const { reflectOnToolReturn, REFLECTION_MIN_CONTENT_CHARS } = await import('./reflection.js');
const { BASE_DIR } = await import('../config.js');
const { createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { recordModelUsage } = await import('../runtime/usage-log.js');
const { resolveMemoryModelRoute } = await import('./memory-model-route.js');
const { MEMORY_JOB_IDS } = await import('./memory-jobs.js');

const { readMemoryWork, undoMemoryWork } = read;
const { runMemoryJob, setMemoryLearningWaiting, localDayKey } = journal;

const DAY = 86_400_000;

beforeEach(() => {
  telemetry.resetOperationalTelemetryForTest();
  journal._resetMemoryWorkJournalForTest();
  resetMemoryDb();
  resetEventLog();
  delete process.env.CLEMMY_REFLECTION;
});

function call(model: string, inputTokens = 100, outputTokens = 10): void {
  recordModelUsage({ sessionId: 'unknown', model, inputTokens, outputTokens, durationMs: 25 });
}

function fact(text: string): number {
  return rememberFact({ kind: 'project', content: text }).id;
}

// ───────────── contract keys, read from the apps' contract ─────────────

const CONTRACT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/chat-engine/src/memory-work.ts');

/** Required (non-optional) field names of a contract interface, following `extends`. */
function requiredFields(name: string): string[] {
  const text = readFileSync(CONTRACT, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const head = new RegExp(`export interface ${name}(?:\\s+extends\\s+(\\w+))?\\s*\\{`).exec(text);
  assert.ok(head, `contract interface ${name}`);
  const fields: string[] = head[1] ? requiredFields(head[1]) : [];
  let depth = 1;
  let token = '';
  for (let i = head.index + head[0].length; i < text.length && depth > 0; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 1 && c === ':' ) {
      const field = /(\w+)(\?)?\s*$/.exec(token);
      if (field && !field[2]) fields.push(field[1]);
      token = '';
      continue;
    } else if (depth === 1 && c === ';') { token = ''; continue; }
    if (depth === 1) token += c;
  }
  return fields;
}

function assertHasContractKeys(value: unknown, iface: string): void {
  assert.ok(value && typeof value === 'object', `${iface} is an object`);
  for (const key of requiredFields(iface)) assert.ok(key in (value as object), `${iface}.${key} is present`);
}

test('an empty home gives a resting snapshot with every contract key, zeros only where they are true', () => {
  const now = new Date();
  const snap = readMemoryWork(now);
  assertHasContractKeys(snap, 'MemoryWorkSnapshot');
  assertHasContractKeys(snap.queue, 'MemoryWorkQueue');
  assertHasContractKeys(snap.model, 'MemoryWorkModel');
  assertHasContractKeys(snap.today, 'MemoryWorkToday');
  for (const job of snap.jobs) {
    assertHasContractKeys(job, 'MemoryJobStatus');
    assertHasContractKeys(job.today, 'MemoryWorkTotals');
  }
  for (const hour of snap.hourly) assertHasContractKeys(hour, 'MemoryWorkHour');
  for (const day of snap.daily) assertHasContractKeys(day, 'MemoryWorkDay');

  assert.equal(snap.state, 'resting');
  assert.deepEqual(snap.running, []);
  assert.equal(snap.waiting, null);
  assert.equal(snap.lastWorkAt, null);
  assert.deepEqual(snap.queue, { toLearn: 0, setAside: 0, failed: 0 }, 'a readable empty queue is a real zero');
  assert.deepEqual(snap.jobs.map((j) => j.id), [...MEMORY_JOB_IDS]);
  assert.equal(snap.today.costUsd, null, 'no invented prices');
  assert.equal(snap.today.runs, 0);
  assert.deepEqual(snap.recent, []);
  assert.deepEqual(snap.retention, { detailDays: 7, summaryDays: 90 });
  assert.deepEqual(snap.embedder, { modelId: null, local: false }, 'embeddings are off in this home');

  // The journal began just now: only this local hour was measured; the
  // hours before it are absent, not zero.
  const thisHour = new Date(now.getTime() - (now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds())).toISOString();
  assert.deepEqual(snap.hourly, [{ hourStart: thisHour, runs: 0, modelCalls: 0, learned: 0 }]);
  // The journal began today: today is a genuine zero, earlier days are absent.
  assert.deepEqual(snap.daily, [{ day: localDayKey(now), runs: 0, modelCalls: 0, learned: 0, inputTokens: 0, outputTokens: 0 }]);

  const byId = new Map(snap.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get('learn')?.next?.trigger, 'after_conversation');
  assert.equal(byId.get('learn')?.next?.at, undefined);
  for (const [id, hour, minute] of [['patterns', 3, 0], ['tidy', 4, 0], ['verify', 4, 35]] as const) {
    const at = new Date(byId.get(id)?.next?.at ?? '');
    assert.equal(at.getHours(), hour, id);
    assert.equal(at.getMinutes(), minute, id);
    assert.ok(at.getTime() > now.getTime() && at.getTime() <= now.getTime() + DAY, `${id} fires within a day`);
  }
  assert.equal(byId.get('tidy')?.modelId, null, 'tidy has no model');
  assert.equal(byId.get('index')?.modelId, null, 'the index names the embedder, off here');
  assert.equal(byId.get('standing')?.modelId, null, 'a checker job with no history names none');
  assert.equal(byId.get('skills')?.modelId, resolveMemoryModelRoute('skills')?.modelId ?? null, 'a governed job that has not run names the model it would ask for');
});

test('working only while a job runs, with the conversation title', async () => {
  const session = createSession({ kind: 'chat', title: 'SEO prospect research' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = runMemoryJob('learn', { source: { kind: 'conversation', sessionId: session.id }, part: 1, parts: 2 }, async () => { await gate; }, () => ({ outcome: 'nothing_new' }));
  const during = readMemoryWork();
  assert.equal(during.state, 'working');
  assert.equal(during.running.length, 1);
  assert.deepEqual(during.running[0].source, { kind: 'conversation', sessionId: session.id, title: 'SEO prospect research' });
  assert.equal(during.jobs.find((j) => j.id === 'learn')?.state, 'running');
  release();
  await run;
  const after = readMemoryWork();
  assert.equal(after.state, 'resting');
  assert.deepEqual(after.running, []);
  const learn = after.jobs.find((j) => j.id === 'learn');
  assert.equal(learn?.state, 'idle');
  assert.equal(learn?.lastRun?.outcome, 'nothing_new', 'an unrecorded run still shows when it last checked');
});

test('waiting passes through while the drain keeps stating it', () => {
  setMemoryLearningWaiting({ reason: 'busy', blocker: { kind: 'workflow', startedAt: '2026-09-26T10:00:00.000Z' } });
  const snap = readMemoryWork();
  assert.equal(snap.state, 'waiting');
  assert.deepEqual(snap.waiting, { reason: 'busy', blocker: { kind: 'workflow', startedAt: '2026-09-26T10:00:00.000Z' } });
  assert.equal(snap.jobs.find((j) => j.id === 'learn')?.state, 'waiting');
  const later = readMemoryWork(new Date(Date.now() + journal.MEMORY_WORK_WAITING_FRESH_MS + 5_000));
  assert.equal(later.state, 'resting', 'a note the drain stopped re-stating is stale');
  assert.equal(later.waiting, null);
});

test('learning turned off says off, and the jobs it stops have no next run', () => {
  process.env.CLEMMY_REFLECTION = 'off';
  setMemoryLearningWaiting({ reason: 'model_paused', problem: 'quota' });
  const snap = readMemoryWork();
  assert.equal(snap.state, 'off');
  assert.equal(snap.waiting, null);
  const byId = new Map(snap.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get('learn')?.state, 'off');
  assert.equal(byId.get('learn')?.next, null);
  assert.equal(byId.get('patterns')?.state, 'off');
  assert.equal(byId.get('reconcile')?.state, 'idle');
});

test('an unreadable journal is unknown: no counts pretend to be facts', () => {
  telemetry.closeOperationalTelemetryDb();
  writeFileSync(telemetry.OPERATIONAL_TELEMETRY_DB_PATH, 'not a database, not even close '.repeat(200));
  try {
    const snap = readMemoryWork();
    assert.equal(snap.state, 'unknown');
    assert.deepEqual(snap.queue, { toLearn: null, setAside: null, failed: null });
    assert.deepEqual(snap.recent, []);
    assert.deepEqual(snap.hourly, []);
    assert.deepEqual(snap.daily, []);
    assert.equal(snap.lastWorkAt, null);
    assert.equal(snap.model.lastServed, null);
    assertHasContractKeys(snap, 'MemoryWorkSnapshot');
    assert.deepEqual(undoMemoryWork('some-id'), { ok: false, reason: 'failed' });
  } finally {
    telemetry.resetOperationalTelemetryForTest();
  }
});

test('the timeline joins current fact text, offers undo while it would change something, and says when a record ages out', async () => {
  const kept = fact('The owner prefers weekly summaries on Mondays');
  const alsoKept = fact('Prospect lists live in the shared drive folder');
  const session = createSession({ kind: 'workflow', title: 'Weekly digest::step-2', metadata: { workflowName: 'Weekly digest' } });
  await runMemoryJob('learn', { source: { kind: 'workflow', sessionId: session.id } }, async () => { call('memory-model', 300, 30); }, () => ({
    outcome: 'ok', produced: { claims: 2, learned: 2 }, facts: { learned: [String(kept), String(alsoKept)] },
  }));
  let [event] = readMemoryWork().recent;
  assert.equal(event.job, 'learn');
  assert.equal(event.outcome, 'ok');
  assert.deepEqual(event.model, { modelId: 'memory-model', standIn: false });
  assert.equal(event.usage?.calls, 1);
  assert.equal(event.usage?.inputTokens, 300);
  assert.equal(event.usage?.outputTokens, 30);
  assert.deepEqual(event.source, { kind: 'workflow', sessionId: session.id, title: 'Weekly digest' });
  assert.deepEqual(event.facts?.map((f) => [f.id, f.change, f.active]), [[String(kept), 'learned', true], [String(alsoKept), 'learned', true]]);
  assert.equal(event.facts?.[0].text, 'The owner prefers weekly summaries on Mondays');
  assert.deepEqual(event.undo, { kind: 'forget', count: 2 });
  assert.equal(event.expiresAt, new Date(Date.parse(event.at) + 7 * DAY).toISOString());
  assert.equal(event.failure, null);

  forgetFact(kept);
  [event] = readMemoryWork().recent;
  assert.deepEqual(event.undo, { kind: 'forget', count: 1 }, 'undo follows fact state');
  assert.equal(event.facts?.[0].active, false);

  assert.deepEqual(undoMemoryWork(event.id), { ok: true, changed: 1 });
  assert.equal(getFact(alsoKept)?.active, false);
  [event] = readMemoryWork().recent;
  assert.equal(event.undo, null);
  assert.deepEqual(undoMemoryWork(event.id), { ok: false, reason: 'nothing_to_undo' });
});

test('a tidy run can bring back what it faded, while it is still faded', async () => {
  const faded = fact('An old vendor contact nobody used');
  forgetFact(faded);
  await runMemoryJob('tidy', { source: { kind: 'schedule' } }, async () => 1, () => ({
    outcome: 'ok', produced: { faded: 1 }, facts: { faded: [String(faded)] }, record: true,
  }));
  const [event] = readMemoryWork().recent;
  assert.deepEqual(event.undo, { kind: 'restore', count: 1 });
  assert.equal(event.usage?.calls, 0);
  assert.equal(event.model, null);
  assert.deepEqual(undoMemoryWork(event.id), { ok: true, changed: 1 });
  assert.equal(getFact(faded)?.active, true);
  assert.equal(readMemoryWork().recent[0].undo, null);
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function tidyFaded(id: number) {
  forgetFact(id); // the nightly tidy lets it fade …
  await runMemoryJob('tidy', { source: { kind: 'schedule' } }, async () => 1, () => ({
    outcome: 'ok', produced: { faded: 1 }, facts: { faded: [String(id)] }, record: true,
  }));
  await tick(); // … and the owner acts later
  return readMemoryWork().recent[0];
}

test('bring back leaves alone a memory the owner restored and then forgot on purpose', async () => {
  const x = fact('An old vendor contact nobody used');
  const event = await tidyFaded(x);
  assert.deepEqual(event.undo, { kind: 'restore', count: 1 });
  reactivateFact(x); // the owner brings it back from the Memory tab
  assert.equal(readMemoryWork().recent[0].undo, null, 'nothing of this run is faded now');
  forgetFact(x); // then forgets it deliberately
  assert.equal(readMemoryWork().recent[0].undo, null, 'the owner\'s forget is not this run\'s fade');
  assert.deepEqual(undoMemoryWork(event.id), { ok: false, reason: 'nothing_to_undo' });
  assert.equal(getFact(x)?.active, false);
});

test('bring back never revives a memory a newer one replaced', async () => {
  const x = fact('The weekly sync is on Tuesday');
  const event = await tidyFaded(x);
  reactivateFact(x);
  const y = supersedeFact(x, { content: 'The weekly sync moved to Wednesday' });
  assert.ok(y && y.id !== x);
  assert.equal(readMemoryWork().recent[0].undo, null);
  assert.deepEqual(undoMemoryWork(event.id), { ok: false, reason: 'nothing_to_undo' });
  assert.equal(getFact(x)?.active, false, 'the replaced memory stays replaced');
  assert.equal(getFact(y.id)?.active, true, 'its replacement stays the one in use');
});

test('forget leaves a memory the owner pinned after the run, and still forgets one the run itself pinned', async () => {
  const plain = fact('Invoices go out on the first business day');
  const rule = rememberFact({ kind: 'constraint', content: 'Never email a prospect before 8am their time' }).id;
  assert.equal(getFact(rule)?.pinned, true, 'fixture: a constraint is pinned from birth');
  await runMemoryJob('learn', { source: { kind: 'conversation', sessionId: 'sess-p' } }, async () => { call('memory-model'); }, () => ({
    outcome: 'ok', produced: { learned: 2 }, facts: { learned: [String(plain), String(rule)] },
  }));
  await tick();
  setFactPinned(plain, true); // the owner keeps this one on purpose
  const [event] = readMemoryWork().recent;
  assert.deepEqual(event.undo, { kind: 'forget', count: 1 });
  assert.deepEqual(undoMemoryWork(event.id), { ok: true, changed: 1 });
  assert.equal(getFact(plain)?.active, true);
  assert.equal(getFact(rule)?.active, false);
});

test('a memory a nested reconcile added is undone once, from the run the owner recognises', async () => {
  const kept = fact('The owner reviews proposals on Fridays');
  const learnRun = () => runMemoryJob('learn', { source: { kind: 'conversation', sessionId: 'sess-r' } }, async () => {
    call('memory-model', 100, 10);
    await runMemoryJob('reconcile', {}, async () => { call('memory-model', 40, 4); },
      () => ({ outcome: 'ok', produced: { learned: 1 }, facts: { learned: [String(kept)] } }));
  }, () => ({ outcome: 'ok', produced: { claims: 1, learned: 1 }, facts: { learned: [String(kept)] } }));
  await learnRun();
  let snap = readMemoryWork();
  const byJob = new Map(snap.recent.map((e) => [e.job, e]));
  assert.deepEqual(byJob.get('learn')?.undo, { kind: 'forget', count: 1 });
  assert.equal(byJob.get('reconcile')?.undo, null, 'the learn run offers it; the reconcile inside it does not');
  assert.deepEqual(undoMemoryWork(byJob.get('reconcile')!.id), { ok: false, reason: 'nothing_to_undo' });
  assert.equal(getFact(kept)?.active, true);
  assert.equal(snap.today.learned, 1, 'kept once in today\'s numbers');
  assert.equal(snap.hourly.at(-1)?.learned, 1, 'and once in the hour');
  assert.equal(snap.today.runs, 2, 'both runs happened');
  assert.equal(snap.today.modelCalls, 2);

  // Inside a run that offers no undo of its own, the reconcile keeps its own.
  const pattern = fact('Proposals that open with a result close faster');
  await runMemoryJob('patterns', { source: { kind: 'schedule' } }, async () => {
    await runMemoryJob('reconcile', {}, async () => { call('memory-model'); },
      () => ({ outcome: 'ok', produced: { learned: 1 }, facts: { learned: [String(pattern)] } }));
  }, () => ({ outcome: 'ok', produced: { patterns: 1 } }));
  snap = readMemoryWork();
  const nested = snap.recent.find((e) => e.job === 'reconcile' && e.facts?.[0]?.id === String(pattern));
  assert.deepEqual(nested?.undo, { kind: 'forget', count: 1 });
  assert.deepEqual(undoMemoryWork(nested!.id), { ok: true, changed: 1 });
  assert.equal(getFact(pattern)?.active, false);
});

test('undo refuses what it cannot or should not change', async () => {
  assert.deepEqual(undoMemoryWork('no-such-event'), { ok: false, reason: 'not_found' });
  await runMemoryJob('patterns', {}, async () => { call('memory-model'); }, () => ({ outcome: 'ok', produced: { patterns: 1 } }));
  const [patterns] = readMemoryWork().recent;
  assert.equal(patterns.undo, null);
  assert.deepEqual(undoMemoryWork(patterns.id), { ok: false, reason: 'nothing_to_undo' });

  const old = fact('Learned long ago');
  const stale = telemetry.recordOperationalEvent({
    source: 'memory', type: 'memory_work_completed', actor: 'learn',
    payload: { job: 'learn', outcome: 'ok', facts: { learned: [String(old)] } },
    now: new Date(Date.now() - 8 * DAY),
  }, telemetry.openOperationalTelemetryDb());
  assert.deepEqual(undoMemoryWork(stale.eventId), { ok: false, reason: 'expired' });
  assert.equal(getFact(old)?.active, true);
  assert.equal(read.isMemoryWorkEventId('../etc'), false);
  assert.equal(read.isMemoryWorkEventId(stale.eventId), true);
});

test('a failed run shows its problem and no undo', async () => {
  await runMemoryJob('learn', {}, async () => null, () => ({ outcome: 'failed', failure: { problem: 'credit' } }));
  const [event] = readMemoryWork().recent;
  assert.equal(event.outcome, 'failed');
  assert.deepEqual(event.failure, { problem: 'credit' });
  assert.equal(event.undo, null);
  assert.equal(readMemoryWork().jobs.find((j) => j.id === 'learn')?.lastRun?.outcome, 'failed');
});

test('today, the jobs and the memory model come from the recorded runs', async () => {
  await runMemoryJob('learn', { source: { kind: 'conversation', sessionId: 'sess-1' } }, async () => { call('memory-model', 100, 10); call('memory-model', 50, 5); }, () => ({
    outcome: 'ok', produced: { claims: 4, learned: 1, updated: 1, leftOut: 1, setAside: 1 },
  }));
  await runMemoryJob('standing', {}, async () => { call('checker-model', 20, 2); }, () => ({ outcome: 'nothing_new' }));
  const snap = readMemoryWork();
  assert.equal(snap.today.runs, 2);
  assert.equal(snap.today.modelCalls, 3);
  assert.equal(snap.today.inputTokens, 170);
  assert.equal(snap.today.outputTokens, 17);
  assert.equal(snap.today.conversationsRead, 1);
  assert.equal(snap.today.claimsFound, 4);
  assert.equal(snap.today.learned, 1);
  assert.equal(snap.today.updated, 1);
  assert.equal(snap.today.leftOut, 1);
  assert.equal(snap.today.setAside, 1);
  const byId = new Map(snap.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get('learn')?.modelId, 'memory-model');
  assert.equal(byId.get('learn')?.today.modelCalls, 2);
  assert.equal(byId.get('learn')?.lastRun?.outcome, 'ok');
  assert.equal(typeof byId.get('learn')?.lastRun?.durationMs, 'number');
  assert.equal(byId.get('standing')?.modelId, 'checker-model');
  // The memory model's "last served" is a governed job's model, never the checker's.
  assert.equal(snap.model.lastServed?.modelId, 'memory-model');
  assert.equal(snap.model.lastServed?.standIn, false);
  assert.ok(snap.lastWorkAt);
  const hour = snap.hourly.at(-1)!;
  assert.equal(hour.runs, 2);
  assert.equal(hour.modelCalls, 3);
  assert.equal(hour.learned, 1);
  assert.deepEqual(snap.daily.at(-1), { day: localDayKey(new Date()), runs: 2, modelCalls: 3, learned: 1, inputTokens: 170, outputTokens: 17 });
});

test('the 30-day strip leaves out days before the journal began and zero-fills the rest', () => {
  const now = new Date();
  const db = telemetry.openOperationalTelemetryDb();
  const sinceMs = now.getTime() - 3 * DAY;
  db.prepare(`UPDATE memory_work_meta SET value = ? WHERE key = 'journal_since'`).run(new Date(sinceMs).toISOString());
  const dayOf = (daysAgo: number) => localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo));
  db.prepare('INSERT INTO memory_work_daily (day, job, runs, model_calls, learned) VALUES (?, ?, ?, ?, ?)').run(dayOf(5), 'learn', 3, 3, 2);
  const snap = readMemoryWork(now);
  assert.deepEqual(snap.daily.map((d) => d.day), [dayOf(5), dayOf(3), dayOf(2), dayOf(1), dayOf(0)]);
  assert.deepEqual(snap.daily[0], { day: dayOf(5), runs: 3, modelCalls: 3, learned: 2, inputTokens: 0, outputTokens: 0 });
  assert.equal(snap.daily[1].runs, 0);
});

function hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('a failure that was not the model\'s names no problem', async () => {
  await assert.rejects(runMemoryJob('learn', {}, async () => { throw new TypeError('x is not a function'); }, () => ({ outcome: 'ok' })));
  const [event] = readMemoryWork().recent;
  assert.equal(event.outcome, 'failed');
  assert.equal(event.failure, null, 'the timeline says it did not finish, without blaming the model');
});

test('learning switched off in the env file reads as off, and the extractor obeys the same switch', async () => {
  const envFile = path.join(BASE_DIR, '.env');
  writeFileSync(envFile, 'CLEMMY_REFLECTION=off\n');
  try {
    assert.equal(process.env.CLEMMY_REFLECTION, undefined, 'fixture: the switch is only in the env file');
    assert.equal(read.memoryLearningTurnedOn(), false);
    assert.equal(readMemoryWork().state, 'off');
    const result = await reflectOnToolReturn({
      sessionId: 'sess-envoff', callId: 'call-envoff', tool: 't', output: 'x'.repeat(REFLECTION_MIN_CONTENT_CHARS + 1),
    });
    assert.equal(result.skipped, 'disabled', 'the extractor stops too');
  } finally {
    rmSync(envFile, { force: true });
  }
  assert.equal(readMemoryWork().state, 'resting');
});

test('the hourly strip follows local hours, even in a half-hour time zone', () => {
  const savedTz = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata'; // UTC+5:30: local hours start at :30 UTC
  try {
    const now = new Date('2026-09-26T12:10:00.000Z'); // 17:40 local
    const db = telemetry.openOperationalTelemetryDb();
    db.prepare(`UPDATE memory_work_meta SET value = ? WHERE key = 'journal_since'`).run(new Date(now.getTime() - 3 * DAY).toISOString());
    const seed = (iso: string) => telemetry.recordOperationalEvent({
      source: 'memory', type: 'memory_work_completed', actor: 'learn',
      payload: { job: 'learn', outcome: 'ok', usage: { calls: 1 }, produced: { learned: 1 } }, now: new Date(iso),
    }, db);
    seed('2026-09-26T11:45:00.000Z'); // 17:15 local: this hour
    seed('2026-09-26T11:29:59.000Z'); // 16:59:59 local: the hour before
    seed('2026-09-26T11:30:00.000Z'); // 17:00 local sharp: this hour
    const snap = readMemoryWork(now);
    assert.equal(snap.hourly.length, 24);
    assert.equal(snap.hourly.at(-1)?.hourStart, '2026-09-26T11:30:00.000Z');
    assert.equal(snap.hourly.at(-1)?.runs, 2);
    assert.equal(snap.hourly.at(-2)?.hourStart, '2026-09-26T10:30:00.000Z');
    assert.equal(snap.hourly.at(-2)?.runs, 1);
    assert.equal(snap.hourly[0].hourStart, '2026-09-25T12:30:00.000Z');
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

test('the hourly strip leaves out hours before the journal began', () => {
  const now = new Date();
  const db = telemetry.openOperationalTelemetryDb();
  db.prepare(`UPDATE memory_work_meta SET value = ? WHERE key = 'journal_since'`).run(new Date(now.getTime() - 150 * 60_000).toISOString());
  const snap = readMemoryWork(now);
  // Began 2.5 hours ago: the hour it began in, the two after it, and this one.
  assert.ok(snap.hourly.length === 3 || snap.hourly.length === 4, `got ${snap.hourly.length}`);
  assert.ok(Date.parse(snap.hourly[0].hourStart) + 3_600_000 > now.getTime() - 150 * 60_000, 'the first hour ends after the journal began');
  assert.ok(snap.hourly.every((h) => h.runs === 0), 'a measured hour with no work is a real zero');
});

test('the queue counts parts to read, claims set aside and parts that failed every retry', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_learning_batches (batch_id, session_id, source_user_seq, accepted_task_id, terminal_event_id,
      terminal_event_rowid, terminal_digest, member_manifest_hash, member_count, shard_count, status, created_at, updated_at)
    VALUES ('b1', 'sess-q', 1, 'task-1', 'evt-1', 1, ?, ?, 1, 4, 'pending', ?, ?)
  `).run(hex('t'), hex('m'), now, now);
  const shard = db.prepare(`
    INSERT INTO memory_learning_shards (shard_id, batch_id, ordinal, manifest_json, manifest_hash, reflection_call_id,
      status, attempts, lease_token, lease_expires_at, next_attempt_at, created_at, updated_at)
    VALUES (?, 'b1', ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  shard.run('s1', 0, hex('s1'), 'call-1', 'pending', 0, null, null, now, now, now);
  shard.run('s2', 1, hex('s2'), 'call-2', 'pending', 2, null, null, now, now, now);
  shard.run('s3', 2, hex('s3'), 'call-3', 'processing', 1, 'lease', now, now, now, now);
  shard.run('s4', 3, hex('s4'), 'call-4', 'dead_letter', 4, null, null, now, now, now);
  const candidate = db.prepare(`
    INSERT INTO memory_reflection_candidates (session_id, call_id, candidate_hash, kind, text, importance, status, created_at, source_type)
    VALUES ('sess-q', ?, ?, 'project', 'held for a second look', 5, ?, ?, ?)
  `);
  candidate.run('c1', hex('c1'), 'pending', now, 'tool_reflection');
  candidate.run('c2', hex('c2'), 'pending', now, 'tool_reflection');
  candidate.run('c3', hex('c3'), 'promoted', now, 'tool_reflection');
  candidate.run('c4', hex('c4'), 'pending', now, 'manual');
  assert.deepEqual(readMemoryWork().queue, { toLearn: 3, setAside: 2, failed: 1 });
});

test('a busy week of history reads well under 50 ms', () => {
  const db = telemetry.openOperationalTelemetryDb();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO operational_events (event_id, ts, source, type, severity, session_id, actor, payload_json)
    VALUES (?, ?, 'memory', ?, 'info', ?, ?, ?)
  `);
  const daily = db.prepare(`
    INSERT INTO memory_work_daily (day, job, runs, model_calls, input_tokens, output_tokens, learned, last_at, last_outcome, last_model_id, last_model_at, last_model_stand_in)
    VALUES (?, ?, 10, 10, 1000, 100, 2, ?, 'ok', 'memory-model', ?, 0)
    ON CONFLICT(day, job) DO NOTHING
  `);
  const ids: number[] = [];
  for (let i = 0; i < 50; i += 1) ids.push(fact(`Synthetic memory number ${i} for the timeline`));
  db.transaction(() => {
    for (let i = 0; i < 20_000; i += 1) {
      const job = MEMORY_JOB_IDS[i % MEMORY_JOB_IDS.length];
      const at = new Date(now - Math.floor((i / 20_000) * 7 * DAY)).toISOString();
      insert.run(`evt-${i}`, at, i % 17 === 0 ? 'memory_work_failed' : 'memory_work_completed', `sess-${i % 300}`, job, JSON.stringify({
        job, outcome: 'ok', startedAt: at, durationMs: 1200, model: { modelId: 'memory-model', requestedModelId: 'memory-model', standIn: false },
        usage: { calls: 1 }, inputTokens: 900, outputTokens: 80, produced: { learned: 2, claims: 3 },
        facts: { learned: [String(ids[i % 50]), String(ids[(i + 1) % 50])] }, source: { kind: 'conversation', sessionId: `sess-${i % 300}` }, failure: null,
      }));
    }
    for (let d = 0; d < 90; d += 1) {
      const at = new Date(now - d * DAY);
      for (const job of MEMORY_JOB_IDS) daily.run(localDayKey(at), job, at.toISOString(), at.toISOString());
    }
  })();
  readMemoryWork(); // warm statement caches
  // CPU time, not wall time: the isolated runner runs files in parallel, and
  // a wall-clock budget would measure the neighbours instead of this read.
  const times: number[] = [];
  let snap = readMemoryWork();
  for (let i = 0; i < 7; i += 1) {
    const started = process.cpuUsage();
    snap = readMemoryWork();
    const used = process.cpuUsage(started);
    times.push((used.user + used.system) / 1000);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.equal(snap.recent.length, 40);
  assert.equal(snap.hourly.length, 24);
  assert.equal(snap.daily.length, 30);
  assert.ok(median < 50, `median read ${median.toFixed(1)} ms of CPU`);
  console.log(`# readMemoryWork median ${median.toFixed(1)} ms of CPU over 20k events`);
});

test('imports of thousands of memories still read well under 50 ms', () => {
  // Undo is counted inside memory.db and text is read only for the facts
  // each event shows, so what a run touched adds index lookups, not reads.
  const db = openMemoryDb();
  const base = fact('seed fact for the schema');
  const columns = Object.keys(db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(base) as object)
    .filter((c) => c !== 'id');
  const copy = db.prepare(`INSERT INTO consolidated_facts (${columns.join(',')})
    SELECT ${columns.map((c) => (c === 'content' || c === 'content_hash' ? '?' : c)).join(',')} FROM consolidated_facts WHERE id = ?`);
  const ids: string[] = [];
  const contentFirst = columns.indexOf('content') < columns.indexOf('content_hash');
  db.transaction(() => {
    for (let i = 0; i < 5000; i += 1) {
      const content = `Imported memory number ${i} `.repeat(12);
      const params = contentFirst ? [content, hex(`import-${i}`)] : [hex(`import-${i}`), content];
      ids.push(String(copy.run(...params, base).lastInsertRowid));
    }
  })();
  const cpu = () => {
    readMemoryWork();
    const times: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const started = process.cpuUsage();
      readMemoryWork();
      const used = process.cpuUsage(started);
      times.push((used.user + used.system) / 1000);
    }
    return times.sort((a, b) => a - b)[3];
  };
  const empty = cpu();
  const tdb = telemetry.openOperationalTelemetryDb();
  for (let e = 0; e < 3; e += 1) {
    telemetry.recordOperationalEvent({ source: 'memory', type: 'memory_work_completed', actor: 'import',
      payload: { job: 'import', outcome: 'ok', produced: { learned: 5000 }, facts: { learned: ids }, usage: { calls: 1 } } }, tdb);
  }
  const big = cpu();
  const [event] = readMemoryWork().recent;
  assert.deepEqual(event.undo, { kind: 'forget', count: 5000 });
  assert.equal(event.facts?.length, 8);
  console.log(`# readMemoryWork median ${empty.toFixed(1)} ms empty, ${big.toFixed(1)} ms with 3 imports of 5,000 memories`);
  // CPU time (as above); the budget is the poll's, like the busy week's.
  assert.ok(big < 50, `median read ${big.toFixed(1)} ms of CPU with 15,000 ids`);
});
