/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-job-wiring.test.ts
 *
 * Every background memory job runs through the memory-work journal at its
 * real call site: its model calls carry `memory:<job>`, and one event names
 * the model that served, what the run kept (fact ids only) and where the work
 * came from. Deterministic work (a save that needed no model, an index pass
 * with nothing new) only refreshes the job's "last checked".
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-job-wiring-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('../runtime/harness/claude-model.js');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const { resolveRoleModel, __sessionBrainPinTest__ } = await import('../runtime/harness/model-roles.js');
const { _setDiscoveredModelsForTest } = await import('../runtime/harness/model-discovery.js');
const { recordModelUsage, withModelUsageAttribution, modelUsageAttributionStorage } = await import('../runtime/usage-log.js');
const telemetry = await import('../runtime/operational-telemetry.js');
const journal = await import('./memory-work-journal.js');
const jobs = await import('./memory-job-context.js');
const reflection = await import('./reflection.js');
const memory = await import('./db.js');
const facts = await import('./facts.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const worker = await import('./semantic-learning-worker.js');
const { closedCanonicalJson } = await import('../shared/closed-canonical-json.js');
const identity = await import('./identity-evolution.js');
const { ingestMemorySource } = await import('./memory-import.js');
const distiller = await import('./skill-distiller.js');
const { evaluateLearningCandidate } = await import('./learning-receipt.js');
const { reviewStandingMemory } = await import('./standing-memory-review.js');
const { judgeMemoryFixCrossFamily } = await import('./self-heal.js');
const { judgeCorrectionCrossFamily } = await import('./correction-detector.js');
const conflictRetry = await import('./conflict-retry.js');
const { _setEmbeddingProviderForTest } = await import('./embeddings.js');
const { IDENTITY_FILE } = await import('./vault.js');

type Reply = string | (() => never);
const asked = new Map<string, number>();
let replies: Record<string, Reply> = {};

function textMessage(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}

/** A provider model that records one usage row the way an adapter does. */
function fixtureModel(modelId: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      asked.set(modelId, (asked.get(modelId) ?? 0) + 1);
      recordModelUsage({ sessionId: 'adapter-session', model: modelId, inputTokens: 40, outputTokens: 8 });
      const reply = replies[modelId] ?? '{}';
      const text = typeof reply === 'function' ? reply() : reply;
      return { output: [textMessage(text)], usage: new Usage(), responseId: `fixture-${modelId}` } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  } as Model;
}

function writeAuth(opts: { codex?: boolean } = {}): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify(opts.codex === false ? {} : {
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify(
    { accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 },
  ));
}

function chooseMemory(modelId: string): void {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'memory', modelId, scope: 'durable', source: 'settings' }]);
}

/** A connected codex model the owner can choose for memory. */
function codexPick(): string {
  return resolveRoleModel('worker').modelId;
}

type MemoryEvent = { actor?: string; sessionId?: string; type: string; payload: Record<string, any> };

function memoryEvents(job?: string): MemoryEvent[] {
  return (telemetry.listOperationalEvents({ source: 'memory' }) as MemoryEvent[])
    .filter((e) => e.type === 'memory_work_completed' || e.type === 'memory_work_failed')
    .filter((e) => !job || e.actor === job);
}

function callEvents(model: string): Array<Record<string, any>> {
  return (telemetry.listOperationalEvents({ source: 'model', type: 'model_call_completed' }) as Array<{ payload: Record<string, any> }>)
    .map((e) => e.payload)
    .filter((p) => p.model === model);
}

beforeEach(() => {
  mock.restoreAll();
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on',
    CLEMMY_MODEL_ROLES: '[]',
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_MODEL_JUDGE_ID: '',
    BYO_PROVIDERS: '',
  });
  delete process.env.CLEMMY_REFLECTION;
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  reflection.setReflectionExtractorPauseForTest(null);
  reflection._testOnly_setReflectionExtractor(null);
  worker._testOnlySemanticLearningWorker.setShardInputRebuilder(null);
  _setEmbeddingProviderForTest(undefined);
  telemetry.resetOperationalTelemetryForTest();
  journal._resetMemoryWorkJournalForTest();
  memory.resetMemoryDb();
  eventlog.resetEventLog();
  asked.clear();
  replies = {};
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'claude-default'));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'codex-default'));
});

after(() => {
  mock.restoreAll();
  memory.closeMemoryDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ───────────────────────────── learn ─────────────────────────────

const LEARN_SOURCE = [
  'Quarterly planning notes for the account team.',
  'The Northwind renewal is due on the first of March and the owner leads the negotiation.',
  'Budget approvals above ten thousand dollars go through the finance committee on Tuesdays.',
  'x'.repeat(900),
].join('\n');

/** One pending part (`ordinal` of `count`) of a finished conversation. */
function insertShard(sessionId: string, ordinal: number, count: number): void {
  const db = memory.openMemoryDb();
  const now = new Date(0).toISOString();
  const digest = 'a'.repeat(64);
  db.prepare(`
    INSERT OR IGNORE INTO memory_learning_batches
      (batch_id, session_id, source_user_seq, accepted_task_id,
       terminal_event_id, terminal_event_rowid, terminal_digest,
       member_manifest_hash, member_count, shard_count, status,
       created_at, updated_at, completed_at, last_error)
    VALUES ('batch-1', ?, 1, 'task-1', 'terminal-1', 1, ?, ?, 1, ?,
            'pending', ?, ?, NULL, NULL)
  `).run(sessionId, digest, digest, count, now, now);
  const manifestJson = closedCanonicalJson({
    version: 1,
    sources: [{ memberOrdinal: 0, start: 0, end: 900, sliceDigest: digest }],
  });
  db.prepare(`
    INSERT INTO memory_learning_shards
      (shard_id, batch_id, ordinal, manifest_json, manifest_hash,
       reflection_call_id, status, attempts, lease_token, lease_expires_at,
       next_attempt_at, last_error, created_at, updated_at, completed_at)
    VALUES (?, 'batch-1', ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)
  `).run(`shard-${ordinal}`, ordinal, manifestJson, createHash('sha256').update(manifestJson).digest('hex'),
    `terminal-learning:shard-${ordinal}`, now, now, now);
}

test('learning a part of a conversation records the part, what was kept by id, and the model that read it', async () => {
  eventlog.createSession({ id: 'sess-learn', kind: 'chat', title: 'Account planning' });
  insertShard('sess-learn', 1, 2);
  worker._testOnlySemanticLearningWorker.setShardInputRebuilder(() => LEARN_SOURCE);
  reflection._testOnly_setReflectionExtractor(async () => {
    recordModelUsage({ sessionId: 'adapter-session', model: 'memory-model', inputTokens: 900, outputTokens: 60 });
    return {
      facts: [
        { kind: 'project', text: 'The Northwind renewal is due on the first of March', importance: 6 },
        { kind: 'project', text: 'The owner plays golf on Sundays', importance: 3 },
      ],
      entities: [],
      pointers: [],
    } as never;
  });

  const summary = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 1 });
  assert.equal(summary.shardsCompleted, 1);
  const [event] = memoryEvents('learn');
  assert.ok(event, 'the part was recorded');
  const p = event.payload;
  assert.equal(p.outcome, 'ok');
  assert.deepEqual(p.source, { kind: 'conversation', sessionId: 'sess-learn' });
  assert.equal(event.sessionId, 'sess-learn');
  assert.deepEqual({ part: p.part, parts: p.parts }, { part: 2, parts: 2 });
  assert.equal(p.model?.modelId, 'memory-model');
  assert.equal(p.usage.calls, 1);
  assert.deepEqual(p.produced, { claims: 2, learned: 1, leftOut: 1 });
  const learnedId = Number(p.facts?.learned?.[0]);
  assert.match(facts.getFact(learnedId)?.content ?? '', /Northwind renewal/);
  const [call] = callEvents('memory-model');
  assert.equal(call.channel, 'memory:learn');
  assert.equal(call.role, 'memory');
});

test('a part whose extraction failed is recorded as not finished; nothing kept', async () => {
  eventlog.createSession({ id: 'sess-fail', kind: 'workflow', title: 'Weekly sync::step-1' });
  insertShard('sess-fail', 0, 1);
  worker._testOnlySemanticLearningWorker.setShardInputRebuilder(() => LEARN_SOURCE);
  reflection._testOnly_setReflectionExtractor(async () => null);
  const summary = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 1 });
  assert.equal(summary.shardsRetried, 1);
  const [event] = memoryEvents('learn');
  assert.equal(event.type, 'memory_work_failed');
  assert.equal(event.payload.outcome, 'failed');
  assert.deepEqual(event.payload.source, { kind: 'workflow', sessionId: 'sess-fail' });
  assert.equal(event.payload.failure, null, 'no model problem is claimed without one');
});

// ───────────────────────────── reconcile ─────────────────────────────

test('settling a new memory with the model records the decision against the resulting fact', async () => {
  const existing = facts.rememberFact({ kind: 'project', content: 'The weekly report goes out on Fridays' });
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ decision: 'NOOP', target_id: existing.id, reason: 'same fact' });
  eventlog.createSession({ id: 'sess-chat', kind: 'chat', title: 'Reporting' });
  const out = await withModelUsageAttribution({ sessionId: 'sess-chat', sourceUserSeq: 3, channel: 'chat' }, () =>
    reflection.consolidateFact(
      { kind: 'project', text: 'The weekly report goes out on Friday mornings', authority: 'user', trustLevel: 1 },
      { sessionId: 'sess-chat' },
    ));
  assert.equal(asked.get(pick), 1, 'the model was asked');
  assert.equal(out.factId, existing.id);
  const [event] = memoryEvents('reconcile');
  assert.ok(event);
  assert.equal(event.payload.outcome, 'ok');
  assert.deepEqual(event.payload.produced, { reinforced: 1 });
  assert.deepEqual(event.payload.facts, { reinforced: [String(existing.id)] });
  assert.deepEqual(event.payload.model, { modelId: pick, requestedModelId: pick, standIn: false });
  assert.deepEqual(event.payload.source, { kind: 'conversation', sessionId: 'sess-chat' });
  const [call] = callEvents(pick);
  assert.equal(call.channel, 'memory:reconcile', 'the call is memory work, not the chat turn');
  assert.equal(call.role, 'memory');
});

test('a save the model added is recorded as learned; the owner saving it is the source', async () => {
  facts.rememberFact({ kind: 'project', content: 'The weekly report goes out on Fridays' });
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ decision: 'ADD', reason: 'different report' });
  const out = await reflection.consolidateFact(
    { kind: 'project', text: 'The monthly report goes out on the first Friday', authority: 'user', trustLevel: 1 },
    { sessionId: 'console:context' },
  );
  assert.equal(out.action, 'add');
  const [event] = memoryEvents('reconcile');
  assert.deepEqual(event.payload.facts, { learned: [String(out.factId)] });
  assert.deepEqual(event.payload.source, { kind: 'owner' });
});

test('a save that needed no model only refreshes the job\'s last check', async () => {
  const out = await reflection.consolidateFact({ kind: 'user', text: 'The owner prefers morning meetings', authority: 'user', trustLevel: 1 });
  assert.equal(out.action, 'add');
  assert.equal(asked.size, 0);
  assert.deepEqual(memoryEvents('reconcile'), []);
  assert.ok(journal.lastCheckedByJob().reconcile, 'checked, nothing to settle');
});

test('the nightly conflict retry is one reconcile run naming the fact that now stands', async () => {
  const stale = facts.rememberFact({ kind: 'project', content: 'The launch is planned for June' });
  const correction = facts.rememberFact({ kind: 'project', content: 'The launch moved to September' });
  conflictRetry._resetPendingConflictsForTest();
  conflictRetry.recordUnresolvedConflict({ candidateFactId: correction.id, similarFactIds: [stale.id] });
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ decision: 'UPDATE', target_id: stale.id, reason: 'moved' });
  const result = await conflictRetry.retryPendingMemoryConflicts();
  assert.equal(result.resolved, 1);
  const [event] = memoryEvents('reconcile');
  assert.equal(event.payload.outcome, 'ok');
  assert.deepEqual(event.payload.source, { kind: 'schedule' });
  assert.deepEqual(event.payload.facts, { updated: [String(correction.id)] });
  assert.equal(event.payload.model?.modelId, pick);
});

// ───────────────────────────── patterns ─────────────────────────────

test('a nightly pattern run counts the patterns it kept, by id, with the model that found them', async () => {
  const sources = Array.from({ length: 5 }, (_, i) => facts.rememberFact({
    kind: 'project', content: `Client ${String.fromCharCode(65 + i)} asked for a shorter weekly status report`,
  }));
  const value = await jobs.runMemoryModelJob('patterns', { source: { kind: 'schedule' } }, () =>
    reflection.runRecursiveReflection({
      extractor: async (kind) => {
        if (kind !== 'project') return { patterns: [] };
        recordModelUsage({ sessionId: 'adapter-session', model: 'pattern-model', inputTokens: 500, outputTokens: 40 });
        return { patterns: [{ text: 'Clients keep asking for shorter weekly status reports', importance: 6, sourceFactIds: sources.map((f) => f.id) }] };
      },
    }), reflection.recursiveReflectionOutcome);
  assert.equal(value.patternsWritten, 1);
  const [event] = memoryEvents('patterns');
  assert.equal(event.payload.outcome, 'ok');
  assert.deepEqual(event.payload.produced, { patterns: 1, learned: 1 });
  assert.deepEqual(event.payload.facts, { learned: value.patternFactIds.learned.map(String) });
  assert.equal(event.payload.model?.modelId, 'pattern-model');
});

test('a pattern run whose model failed on every group did not finish', () => {
  const outcome = reflection.recursiveReflectionOutcome({
    patternsWritten: 0, patternsUpdated: 0, patternsNoop: 0, sourcesDemoted: 0,
    groupsProcessed: 0, groupsSkipped: 3, factsConsidered: 20, groupsFailed: 1,
    patternFactIds: { learned: [], updated: [] },
  }, { error: Object.assign(new Error('usage limit'), { status: 429 }) });
  assert.equal(outcome.outcome, 'failed');
  assert.deepEqual(outcome.failure, { problem: 'quota' });
});

// ───────────────────────────── skills ─────────────────────────────

function successReceipt(sourceId: string) {
  return evaluateLearningCandidate({
    target: 'skill',
    authority: 'independent_completion_judge',
    sessionId: `session:${sourceId}`,
    sourceId,
    terminalSuccess: true,
    independentValidation: true,
  }).receipt!;
}

const DRAFT = JSON.stringify({
  name: 'weekly-status-brief',
  description: 'Pull the week\'s tickets and write a short status brief.',
  requires: [],
  procedureMarkdown: '1. List the tickets closed this week.\n2. Group them by client.\n3. Write three bullet points per client.',
  provenTools: [],
  pitfalls: [],
});

test('distilling a skill records the skill written and the model that wrote it; an unavailable model says why', async () => {
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = DRAFT;
  const calls = [{ tool: 'composio_execute_tool', slug: 'TICKETS_LIST', args: '{"week":"current"}', callId: 'c1' }];
  const context = {
    objective: 'Write the weekly status brief', evidence: 'done',
    origin: { kind: 'chat' as const, sourceId: 'goal-1' }, learningReceipt: successReceipt('goal-1'),
  };
  const written = await distiller._testOnly_distillFromCalls(calls, context, { kind: 'conversation', sessionId: 'sess-skill' });
  assert.equal(written.status, 'written');
  const [event] = memoryEvents('skills');
  assert.deepEqual(event.payload.produced, { skills: 1 });
  assert.equal(event.payload.model?.modelId, pick);
  assert.deepEqual(event.payload.source, { kind: 'conversation', sessionId: 'sess-skill' });
  assert.equal(callEvents(pick)[0]?.channel, 'memory:skills');

  writeAuth({ codex: false });
  const waiting = await distiller._testOnly_distillFromCalls(calls, { ...context, objective: 'Write another brief' });
  assert.equal(waiting.status, 'failed');
  const failed = memoryEvents('skills').find((e) => e.type === 'memory_work_failed');
  assert.deepEqual(failed?.payload.failure, { problem: 'not_connected' });
  assert.equal(failed?.payload.model, null, 'no model stood in');
});

// ───────────────────────────── identity ─────────────────────────────

test('a profile suggestion records the proposal; a cycle without the memory model is recorded as waiting', async () => {
  identity.setIdentityDistillerForTest(null);
  mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
  writeFileSync(IDENTITY_FILE, '# Identity\n\nI am Clementine.\n', 'utf-8');
  for (let i = 0; i < 6; i += 1) {
    const fact = facts.rememberFact({ kind: 'user', content: `The owner coaches ${i + 3} founders and reviews their plans each week` });
    facts.setFactPinned(fact.id, true);
  }
  const pick = codexPick();
  chooseMemory(pick);
  writeAuth({ codex: false });
  assert.equal((await identity.maybeProposeIdentityUpdate()).reason, 'model-unavailable');
  const [waiting] = memoryEvents('identity');
  assert.equal(waiting.payload.outcome, 'waiting');
  assert.deepEqual(waiting.payload.source, { kind: 'schedule' });

  writeAuth();
  replies[pick] = JSON.stringify({ proposedText: '# Identity\n\nI am Clementine, working with a founder coach.', rationale: 'Coaching work.' });
  assert.equal((await identity.maybeProposeIdentityUpdate()).reason, 'drafted');
  const drafted = memoryEvents('identity').find((e) => e.payload.outcome === 'ok');
  assert.deepEqual(drafted?.payload.produced, { proposals: 1 });
  assert.equal(drafted?.payload.model?.modelId, pick);
});

// ───────────────────────────── import ─────────────────────────────

test('an import records the memories it added by id; its saves are not recorded again', async () => {
  const src = path.join(TEST_HOME, 'import-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'notes.md'), '# Notes\n\nThe production database runs on a managed Postgres cluster with nightly backups enabled and a read replica.\n');
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ facts: [{ kind: 'reference', content: 'Production data lives in a managed Postgres cluster', importance: 6 }] });
  const batch = await ingestMemorySource(src, { sourceLabel: 'wiring' });
  assert.equal(batch.newFactIds.length, 1);
  const events = memoryEvents();
  assert.deepEqual(events.map((e) => e.actor), ['import'], 'the nested saves needed no model and are not recorded');
  assert.deepEqual(events[0].payload.facts, { learned: batch.newFactIds.map(String) });
  assert.deepEqual(events[0].payload.source, { kind: 'owner' });
  assert.equal(events[0].payload.model?.modelId, pick);
});

// ───────────────────────────── checker jobs ─────────────────────────────

test('a standing-instruction check is recorded on the checker with its own lane', async () => {
  const clause = 'Every Monday, send the digest to my review list.';
  const checker = (await import('../runtime/harness/debate-model.js')).resolveBoundaryJudge();
  replies[checker.modelId] = JSON.stringify({ scope: 'standing', text: clause, reason: 'recurring request' });
  const review = await reviewStandingMemory(`Build the board now. ${clause}`, clause, 'inferred');
  assert.equal(review.scope, 'standing');
  const [event] = memoryEvents('standing');
  assert.equal(event.payload.outcome, 'ok');
  assert.deepEqual(event.payload.produced, { approved: 1 }, 'an approval is named, not "nothing new"');
  assert.deepEqual(event.payload.source, { kind: 'owner' });
  assert.equal(event.payload.model?.modelId, checker.modelId);
  const [call] = callEvents(checker.modelId);
  assert.equal(call.channel, 'memory:standing');
  assert.equal(call.role, 'reviewer', 'the checker keeps its own role');
});

test('a repair check asks the independent checker and is recorded on its own lane', async () => {
  const judge = resolveRoleModel('judge');
  replies[judge.modelId] = 'APPROVE: the two facts say the same thing';
  const fix = { id: 'fix-1', kind: 'merge_duplicate', targetIds: [1, 2], evidence: 'same text', payload: {} } as never;
  const verdict = await judgeMemoryFixCrossFamily(fix);
  assert.equal(verdict.verdict, 'approve');
  const [event] = memoryEvents('verify');
  assert.equal(event.payload.outcome, 'ok');
  assert.equal(event.payload.model?.modelId, judge.modelId);
  // The check's route is untouched (it asks for the checker by id through the
  // shared router); the job scope still puts its call on the verify lane and
  // books it as the checker's work, not the brain's.
  const [call] = callEvents(judge.modelId);
  assert.equal(call.channel, 'memory:verify');
  assert.equal(call.role, 'reviewer', 'the checker keeps its own role');

  // A correction check is the same job on the same checker.
  telemetry.resetOperationalTelemetryForTest();
  const correction = await judgeCorrectionCrossFamily({
    priorAnswer: 'The launch is in August.',
    correction: 'No, it moved to September.',
    targetFacts: [{ id: '7', content: 'The launch is in August' }],
  });
  assert.equal(correction.verdict, 'approve');
  const [correctionCall] = callEvents(judge.modelId);
  assert.equal(correctionCall.channel, 'memory:verify');
  assert.equal(correctionCall.role, 'reviewer');
  assert.equal(memoryEvents('verify').length, 1);

  // With no model independent of the fast tier bound, the check makes no call.
  telemetry.resetOperationalTelemetryForTest();
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: codexPick(), scope: 'durable', source: 'settings' }]);
  const unavailable = await judgeMemoryFixCrossFamily(fix);
  assert.equal(unavailable.verdict, 'unavailable');
  assert.deepEqual(memoryEvents('verify'), []);
  assert.ok(journal.lastCheckedByJob().verify, 'checked, nothing to ask');
});

test('verify, tidy and index outcomes say only what happened', () => {
  assert.deepEqual(jobs.memoryVerifyOutcome({ verdict: 'approve' }, {}), { outcome: 'ok', produced: { approved: 1 } });
  assert.deepEqual(jobs.memoryVerifyOutcome({ verdict: 'veto' }, {}), { outcome: 'ok', produced: { declined: 1 } });
  assert.deepEqual(jobs.memoryVerifyOutcome({ verdict: 'unavailable' }, {}), { outcome: 'nothing_new' });
  assert.deepEqual(jobs.memoryVerifyOutcome({ verdict: 'unavailable' }, { error: Object.assign(new Error('x'), { status: 401 }) }),
    { outcome: 'failed', failure: { problem: 'not_connected' } });
  assert.deepEqual(jobs.memoryTidyOutcome([4, 4, 9]), { outcome: 'ok', produced: { faded: 2 }, facts: { faded: ['4', '9'] }, record: true });
  assert.deepEqual(jobs.memoryTidyOutcome([], 3), { outcome: 'ok', produced: { faded: 3 }, record: true });
  assert.deepEqual(jobs.memoryTidyOutcome([]), { outcome: 'nothing_new' });
  assert.deepEqual(jobs.memoryIndexOutcome(5), { outcome: 'ok', produced: { embedded: 5 } });
  assert.deepEqual(jobs.memoryIndexOutcome(0), { outcome: 'nothing_new' });
});

test('indexing what was just saved is recorded when it indexed something', async () => {
  _setEmbeddingProviderForTest({
    name: 'test', model: 'test-embedder', dim: 4,
    async embed(texts: string[]) { return texts.map(() => new Float32Array([1, 0, 0, 0])); },
  });
  facts.rememberFact({ kind: 'user', content: 'The owner reads the digest on Monday mornings' });
  await reflection.triggerEmbedAtWrite();
  const [event] = memoryEvents('index');
  assert.ok(event, 'the pass was recorded');
  assert.equal(event.payload.produced.embedded, 1);
  assert.equal(event.payload.model, null, 'the local embedder is not a ledger model call');
  await reflection.triggerEmbedAtWrite();
  assert.equal(memoryEvents('index').length, 1, 'a pass with nothing new is not recorded');
});

// ───────────────────────────── sources ─────────────────────────────

test('work is attributed to the conversation or workflow it came from, never guessed', () => {
  eventlog.createSession({ id: 'sess-a', kind: 'chat' });
  eventlog.createSession({ id: 'wf-run', kind: 'workflow' });
  assert.deepEqual(jobs.memoryWorkSourceForSession('sess-a'), { kind: 'conversation', sessionId: 'sess-a' });
  assert.deepEqual(jobs.memoryWorkSourceForSession('wf-run'), { kind: 'workflow', sessionId: 'wf-run' });
  assert.deepEqual(jobs.memoryWorkSourceForSession('workflow:run-1:step-2'), { kind: 'workflow', sessionId: 'workflow:run-1:step-2' });
  assert.equal(jobs.memoryWorkSourceForSession('mobile:memory'), null, 'a Settings door is not a conversation');
  assert.deepEqual(jobs.memoryWorkSourceForSession('mobile:memory', { kind: 'owner' }), { kind: 'owner' });
  assert.deepEqual(jobs.memoryWorkSourceFromTurn({ kind: 'owner' }), { kind: 'owner' }, 'outside a turn: the fallback');
  assert.deepEqual(
    withModelUsageAttribution({ sessionId: 'sess-a', sourceUserSeq: 2 }, () => jobs.memoryWorkSourceFromTurn(null)),
    { kind: 'conversation', sessionId: 'sess-a' },
  );
  assert.deepEqual(
    withModelUsageAttribution({ sessionId: 'sess-a', sourceUserSeq: 0 }, () => jobs.memoryWorkSourceFromTurn(null)),
    null,
    'background work (no accepted turn) names no conversation',
  );
});

test('a job started in a turn picks its model as that turn would, while its calls stay the job\'s', async () => {
  // A session's pinned brain decides the automatic checker family; memory
  // work started in that session must not drift to the global brain just
  // because its calls are no longer charged to the turn.
  __sessionBrainPinTest__.reset();
  __sessionBrainPinTest__.setValidatorForTests(() => true);
  try {
    await withModelUsageAttribution({ sessionId: 'sess-pin', sourceUserSeq: 4 }, async () => {
      assert.equal(resolveRoleModel('brain').provider, 'codex', 'the session pins the brain it started on');
      process.env.AUTH_MODE = 'claude_oauth'; // the owner switches the global brain
      const seen = await jobs.runMemoryModelJob('reconcile', {}, async () => ({
        selected: jobs.inMemoryJobTurn(() => resolveRoleModel('brain').provider),
        global: resolveRoleModel('brain').provider,
        charged: modelUsageAttributionStorage.getStore()?.sessionId,
      }), () => ({ outcome: 'nothing_new' }));
      assert.deepEqual(seen, { selected: 'codex', global: 'claude', charged: '' });
      // A job nested in that job (a save inside an import) selects the same way.
      const nested = await jobs.runMemoryModelJob('import', {}, () => jobs.runMemoryModelJob('reconcile', {}, async () =>
        jobs.inMemoryJobTurn(() => resolveRoleModel('brain').provider), () => ({ outcome: 'nothing_new' })),
      () => ({ outcome: 'nothing_new' }));
      assert.equal(nested, 'codex');
    });
  } finally {
    __sessionBrainPinTest__.reset();
  }
});
