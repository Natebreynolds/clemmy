/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-learning-gate.test.ts
 *
 * Learning waits for the memory model instead of throwing learning away.
 * While the extractor is paused or the memory model cannot be served, the
 * learn drain claims nothing, no part's try is spent, and the Memory tab is
 * told why and until when. A part that hits a used-up plan mid-read is handed
 * back with its try returned. When the model is back, the part is learned.
 * When the foreground is busy, the tab is told what learning waits behind.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-learning-gate-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('../runtime/harness/claude-model.js');
const { CodexModelProvider } = await import('../runtime/harness/codex-model.js');
const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');
const { _setDiscoveredModelsForTest } = await import('../runtime/harness/model-discovery.js');
const { recordModelUsage } = await import('../runtime/usage-log.js');
const telemetry = await import('../runtime/operational-telemetry.js');
const journal = await import('./memory-work-journal.js');
const reflection = await import('./reflection.js');
const memory = await import('./db.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const worker = await import('./semantic-learning-worker.js');
const { closedCanonicalJson } = await import('../shared/closed-canonical-json.js');

let reply: string | (() => never) = '{}';
let calls = 0;

function fixtureModel(modelId: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      calls += 1;
      recordModelUsage({ sessionId: 'adapter-session', model: modelId, inputTokens: 40, outputTokens: 8 });
      const text = typeof reply === 'function' ? reply() : reply;
      return {
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
        usage: new Usage(),
        responseId: `fixture-${modelId}`,
      } as ModelResponse;
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

const SOURCE = [
  'The Northwind renewal is due on the first of March and the owner leads the negotiation.',
  'x'.repeat(900),
].join('\n');

const EXTRACTION = JSON.stringify({
  facts: [{ kind: 'project', text: 'The Northwind renewal is due on the first of March', importance: 6 }],
  entities: [],
  pointers: [],
});

function insertShard(): void {
  const db = memory.openMemoryDb();
  const now = new Date(0).toISOString();
  const digest = 'a'.repeat(64);
  db.prepare(`
    INSERT INTO memory_learning_batches
      (batch_id, session_id, source_user_seq, accepted_task_id,
       terminal_event_id, terminal_event_rowid, terminal_digest,
       member_manifest_hash, member_count, shard_count, status,
       created_at, updated_at, completed_at, last_error)
    VALUES ('batch-1', 'sess-1', 1, 'task-1', 'terminal-1', 1, ?, ?, 1, 1,
            'pending', ?, ?, NULL, NULL)
  `).run(digest, digest, now, now);
  const manifestJson = closedCanonicalJson({
    version: 1,
    sources: [{ memberOrdinal: 0, start: 0, end: 900, sliceDigest: digest }],
  });
  db.prepare(`
    INSERT INTO memory_learning_shards
      (shard_id, batch_id, ordinal, manifest_json, manifest_hash,
       reflection_call_id, status, attempts, lease_token, lease_expires_at,
       next_attempt_at, last_error, created_at, updated_at, completed_at)
    VALUES ('shard-1', 'batch-1', 0, ?, ?, 'terminal-learning:shard-1',
            'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)
  `).run(manifestJson, createHash('sha256').update(manifestJson).digest('hex'), now, now, now);
}

function shardRow(): { status: string; attempts: number } {
  return memory.openMemoryDb().prepare(`
    SELECT status, attempts FROM memory_learning_shards WHERE shard_id = 'shard-1'
  `).get() as { status: string; attempts: number };
}

function chooseCodexMemoryModel(): string {
  const pick = resolveRoleModel('worker').modelId;
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'memory', modelId: pick, scope: 'durable', source: 'settings' }]);
  return pick;
}

beforeEach(() => {
  mock.restoreAll();
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_MODEL_ROLES: '[]',
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_MODEL_JUDGE_ID: '',
    BYO_PROVIDERS: '',
  });
  delete process.env.CLEMMY_REFLECTION;
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  reflection.setReflectionExtractorPauseForTest(null);
  reflection._testOnly_setReflectionExtractor(null);
  worker._testOnlySemanticLearningWorker.setShardInputRebuilder(() => SOURCE);
  telemetry.resetOperationalTelemetryForTest();
  journal._resetMemoryWorkJournalForTest();
  memory.resetMemoryDb();
  eventlog.resetEventLog();
  reply = EXTRACTION;
  calls = 0;
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'claude-default'));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'codex-default'));
  insertShard();
});

after(() => {
  mock.restoreAll();
  worker._testOnlySemanticLearningWorker.setShardInputRebuilder(null);
  memory.closeMemoryDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('while the extractor is paused, a drain claims nothing, spends no try, and says until when; afterwards the part is learned', async () => {
  const until = Date.now() + 10 * 60_000;
  reflection.setReflectionExtractorPauseForTest(until, 'quota');
  for (let pass = 0; pass < 5; pass += 1) {
    const waiting = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 2 });
    assert.equal(waiting.shardsClaimed, 0);
    assert.equal(waiting.modelWaiting, 'model_paused');
  }
  assert.deepEqual(shardRow(), { status: 'pending', attempts: 0 }, 'no try was spent; nothing dead-letters');
  assert.equal(calls, 0);
  const note = journal.readMemoryLearningWaiting();
  assert.equal(note?.reason, 'model_paused');
  assert.equal(note?.problem, 'quota');
  assert.equal(note?.until, new Date(until).toISOString());
  assert.ok(note?.since);

  reflection.setReflectionExtractorPauseForTest(null);
  const learned = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 2 });
  assert.equal(learned.shardsCompleted, 1);
  assert.equal(shardRow().status, 'completed');
  assert.equal(journal.readMemoryLearningWaiting(), null, 'a pass that proceeds clears the note');
  assert.equal(calls, 1);
});

test('a chosen memory model that cannot be served makes learning wait with the reason', async () => {
  chooseCodexMemoryModel();
  writeAuth({ codex: false });
  const waiting = await worker.drainTerminalSemanticLearning({ requireIdle: false });
  assert.equal(waiting.shardsClaimed, 0);
  assert.equal(waiting.modelWaiting, 'model_unavailable');
  assert.deepEqual(shardRow(), { status: 'pending', attempts: 0 });
  const note = journal.readMemoryLearningWaiting();
  assert.equal(note?.reason, 'model_unavailable');
  assert.equal(note?.problem, 'not_connected');
});

test('a part that hits a used-up plan mid-read is handed back with its try returned, and the next part waits', async () => {
  chooseCodexMemoryModel();
  reply = () => { throw Object.assign(new Error('usage limit reached'), { status: 429 }); };
  const first = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 2 });
  assert.equal(first.shardsClaimed, 1);
  assert.equal(first.shardsWaiting, 1);
  assert.equal(first.shardsRetried, 0);
  assert.equal(first.modelWaiting, 'model_paused');
  assert.deepEqual(shardRow(), { status: 'pending', attempts: 0 }, 'the try is returned');
  assert.equal(journal.readMemoryLearningWaiting()?.problem, 'quota');
  const [event] = telemetry.listOperationalEvents({ source: 'memory', type: 'memory_work_failed' });
  assert.deepEqual((event?.payload as { failure?: unknown }).failure, { problem: 'quota' }, 'the failed read says why');

  const held = await worker.drainTerminalSemanticLearning({ requireIdle: false });
  assert.equal(held.shardsClaimed, 0, 'the backoff holds the next pass');

  reflection.setReflectionExtractorPauseForTest(null);
  reply = EXTRACTION;
  const learned = await worker.drainTerminalSemanticLearning({ requireIdle: false });
  assert.equal(learned.shardsCompleted, 1);
});

test('a part the model answered with nothing usable still spends its try', async () => {
  chooseCodexMemoryModel();
  reply = 'not json at all';
  const pass = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 1 });
  assert.equal(pass.shardsRetried, 1);
  assert.equal(pass.shardsWaiting, 0);
  assert.equal(shardRow().attempts, 1);
});

test('when the foreground is busy, the tab is told what learning waits behind and since when', async () => {
  const session = eventlog.createSession({ id: 'workflow:run-1:step-1', kind: 'workflow', title: 'Weekly sync::step-1' });
  eventlog.beginRunAttempt(session.id, {});
  const first = await worker.drainTerminalSemanticLearning({ requireIdle: true });
  assert.equal(first.foregroundBusy, true);
  assert.equal(first.shardsClaimed, 0);
  const note = journal.readMemoryLearningWaiting();
  assert.equal(note?.reason, 'busy');
  assert.equal(note?.blocker?.kind, 'workflow');
  assert.ok(note?.blocker?.startedAt);
  const since = note?.since;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await worker.drainTerminalSemanticLearning({ requireIdle: true });
  assert.equal(journal.readMemoryLearningWaiting()?.since, since, 'still the same wait');
  assert.deepEqual(worker.interactiveForegroundBlocker(), { kind: 'workflow', startedAt: note?.blocker?.startedAt });
});

test('a chat run blocks learning as a conversation', async () => {
  const session = eventlog.createSession({ id: 'sess-chat', kind: 'chat' });
  eventlog.beginRunAttempt(session.id, {});
  assert.equal(worker.interactiveForegroundBlocker()?.kind, 'chat');
  assert.equal(worker.interactiveForegroundBusy(), true);
});
