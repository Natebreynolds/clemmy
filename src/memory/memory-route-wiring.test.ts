/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-route-wiring.test.ts
 *
 * Every memory job asks the "Keeps your memory" route for its model: the
 * extractor, the conflict resolver, the nightly pattern finder, the profile
 * distiller and the import distiller. A chosen model is used exactly (no hedge
 * onto another family); a chosen model that cannot be served makes the job
 * wait or fall back to its model-free path — nothing stands in for it.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-route-wiring-'));
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
const { resolveMemoryModelRoute } = await import('./memory-model-route.js');
const reflection = await import('./reflection.js');
const { resetMemoryDb, closeMemoryDb } = await import('./db.js');
const { rememberFact, getFact, setFactPinned } = await import('./facts.js');
const identity = await import('./identity-evolution.js');
const { ingestMemorySource } = await import('./memory-import.js');
const { IDENTITY_FILE } = await import('./vault.js');
const eventlog = await import('../runtime/harness/eventlog.js');

type Reply = string | (() => never);
/** Models built by the mocked providers, by id: what each was asked. */
const asked = new Map<string, number>();

function textMessage(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}

let replies: Record<string, Reply> = {};

/** A provider model that records one usage row the way an adapter does and
 *  answers with the reply the test set for its id. */
function fixtureModel(modelId: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      asked.set(modelId, (asked.get(modelId) ?? 0) + 1);
      recordModelUsage({ sessionId: 'adapter-session', model: modelId, inputTokens: 30, outputTokens: 6 });
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

function rateLimited(): never {
  throw Object.assign(new Error('usage limit reached'), { status: 429 });
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
  asked.clear();
  replies = {};
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'claude-default'));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => fixtureModel(id ?? 'codex-default'));
});

after(() => {
  mock.restoreAll();
  closeMemoryDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** A connected codex model the owner can choose for memory. */
function codexPick(): string {
  return resolveRoleModel('worker').modelId;
}

test('the extractor reports the route it runs on: automatic keeps the checker route, a pick is named exactly', () => {
  const automatic = resolveMemoryModelRoute('learn');
  assert.ok(automatic);
  assert.deepEqual(reflection._testOnly_reflectorRoute(), {
    modelId: automatic.modelId,
    provider: automatic.provider,
    transport: automatic.boundary?.transport,
  });
  const pick = codexPick();
  chooseMemory(pick);
  assert.deepEqual(reflection._testOnly_reflectorRoute(), { modelId: pick, provider: 'codex', transport: 'codex_responses' });
  writeAuth({ codex: false });
  assert.equal(reflection._testOnly_reflectorRoute(), null, 'a pick that cannot be served names no route');
});

test('the extractor asks the chosen model, and a refused call pauses learning instead of hedging to another family', async () => {
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ facts: [{ kind: 'project', text: 'The launch review is on Thursdays', importance: 5 }], entities: [], pointers: [] });
  const extraction = await reflection._testOnly_runExtractor('Tool: calendar\nThe launch review is on Thursdays.');
  assert.equal(asked.get(pick), 1, 'the chosen model answered');
  assert.equal(extraction?.facts?.[0]?.text, 'The launch review is on Thursdays');

  asked.clear();
  replies[pick] = rateLimited;
  const refused = await reflection._testOnly_runExtractor('Tool: calendar\nAnother read.');
  assert.equal(refused, null);
  assert.deepEqual([...asked.keys()], [pick], 'no other family was asked: a chosen model is used exactly');
  assert.equal(reflection.reflectionExtractorPause()?.problem, 'quota', 'learning waits for the provider instead');
});

test('the extractor makes no call when the chosen model cannot be served', async () => {
  chooseMemory(codexPick());
  writeAuth({ codex: false });
  const extraction = await reflection._testOnly_runExtractor('Tool: calendar\nThe launch review is on Thursdays.');
  assert.equal(extraction, null);
  assert.equal(asked.size, 0);
});

test('the conflict resolver asks the chosen model, and records an unresolved ADD when it cannot be served', async () => {
  resetMemoryDb();
  const existing = rememberFact({ kind: 'project', content: 'The weekly report goes out on Fridays' });
  const similar = [getFact(existing.id)!];
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ decision: 'NOOP', target_id: existing.id, reason: 'same fact' });
  const decided = await reflection.resolveConflict({ kind: 'project', text: 'The weekly report is sent every Friday' }, similar);
  assert.equal(asked.get(pick), 1);
  assert.deepEqual({ decision: decided.decision, target: decided.target_id }, { decision: 'NOOP', target: existing.id });

  asked.clear();
  writeAuth({ codex: false });
  const waiting = await reflection.resolveConflict({ kind: 'project', text: 'The weekly report is sent every Friday' }, similar);
  assert.equal(asked.size, 0, 'no model stands in');
  assert.equal(waiting.decision, 'ADD');
  assert.equal(waiting.unresolved, true, 'the conflict stays queued for the nightly retry');
});

test('the nightly pattern finder asks the chosen model', async () => {
  resetMemoryDb();
  const pick = codexPick();
  chooseMemory(pick);
  replies[pick] = JSON.stringify({ patterns: [] });
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, content: `fact ${i}`, derivation_depth: 0, importance: 5,
  })) as unknown as Parameters<typeof reflection.runRecursivePatternExtractor>[1];
  const result = await reflection.runRecursivePatternExtractor('project', rows);
  assert.deepEqual(result, { patterns: [] });
  assert.equal(asked.get(pick), 1);
});

test('profile suggestions ask the chosen model, and wait when it cannot be served', async () => {
  resetMemoryDb();
  identity.setIdentityDistillerForTest(null);
  mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
  writeFileSync(IDENTITY_FILE, '# Identity\n\nI am Clementine.\n', 'utf-8');
  for (let i = 0; i < 6; i += 1) {
    const fact = rememberFact({ kind: 'user', content: `The owner runs a practice with ${i + 2} partners and reviews it weekly` });
    setFactPinned(fact.id, true); // a pinned fact is durable evidence
  }
  const pick = codexPick();
  chooseMemory(pick);
  writeAuth({ codex: false });
  const waiting = await identity.maybeProposeIdentityUpdate();
  assert.deepEqual(waiting, { proposed: false, reason: 'model-unavailable' });
  assert.equal(asked.size, 0);

  writeAuth();
  replies[pick] = JSON.stringify({ proposedText: '# Identity\n\nI am Clementine, working with a growing practice.', rationale: 'The practice grew.' });
  const drafted = await identity.maybeProposeIdentityUpdate();
  assert.equal(drafted.reason, 'drafted');
  assert.equal(asked.get(pick), 1, 'the chosen model drafted it');
});

test('an import asks the chosen model, and uses the model-free harvest when it cannot be served', async () => {
  resetMemoryDb();
  const src = path.join(TEST_HOME, 'import-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'notes.md'), [
    '# Notes',
    '- The production database runs on a managed Postgres cluster with nightly backups enabled.',
    '- Releases ship from the main branch through the continuous-delivery pipeline only.',
  ].join('\n'));
  const pick = codexPick();
  chooseMemory(pick);
  writeAuth({ codex: false });
  const harvested = await ingestMemorySource(src, { sourceLabel: 'wiring-test' });
  assert.equal(harvested.fallbackFiles, 1, 'the deterministic harvest ran');
  assert.equal(harvested.distilledFiles, 0);
  assert.equal(asked.size, 0);

  resetMemoryDb();
  writeAuth();
  replies[pick] = JSON.stringify({ facts: [{ kind: 'reference', content: 'Production data lives in a managed Postgres cluster', importance: 6 }] });
  const distilled = await ingestMemorySource(src, { sourceLabel: 'wiring-test' });
  assert.equal(distilled.distilledFiles, 1);
  assert.equal(asked.get(pick), 1, 'the chosen model distilled the file');
});
