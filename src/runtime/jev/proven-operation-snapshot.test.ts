import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { RunStrategyRecord } from '../../memory/run-strategy-store.js';
import type { SystemOneRequestPayload } from './system-one.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-strategy-snapshot-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const STORE = path.join(HOME, 'state', 'run-strategies.json');
const {
  familiarRunStrategiesForRequest, routableOperationsForRequest,
  prepareProvenOperationForRequest, PROVEN_PICK_BUDGET_MS,
} = await import('./proven-operation.js');
const { recordRunStrategy } = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { installMemoryScopeBinding, withSessionMemoryScope } = await import('../../memory/memory-scope.js');
const { createSession, appendEvent } = await import('../harness/eventlog.js');
const { decideTurnStartWithJev } = await import('./control-plane.js');
const jev = await import('./client.js');
const { _setToolSchemaLoaderForTests } = await import('../../tools/composio-schema-cache.js');
// Heartbeat remains independent; even its schema misses are strictly local.
_setToolSchemaLoaderForTests(async () => null);
jev._setTypesafeKeyForTests('ts_fixture_snapshot');

after(() => {
  installMemoryScopeBinding(null);
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  _setToolSchemaLoaderForTests(null);
  fs.rmSync(HOME, { recursive: true, force: true });
});

function record(objective: string, tool: string, extra: {
  scope?: 'chat' | 'workflow_step'; projectId?: string;
} = {}): RunStrategyRecord {
  const receipt = evaluateLearningCandidate({
    target: 'strategy', authority: 'background_delivery_verifier',
    sessionId: 'background:snapshot-fixture', sourceId: tool + objective,
    terminalSuccess: true, controllerValidation: true,
  }).receipt;
  assert.ok(receipt);
  const row = recordRunStrategy({
    objective, toolsUsed: [tool], workerCount: 0, durationMs: 1,
    learningReceipt: receipt, scope: extra.scope ?? 'chat',
    keptFor: extra.projectId ? { projectId: extra.projectId, agentKey: null } : null,
  });
  assert.ok(row);
  return row;
}

function seed(): void {
  fs.rmSync(STORE, { force: true });
  record('Summarize xenon market observations', 'xenon__summarize_market');
  record('Audit cobalt delivery schedules', 'xenon__summarize_market');
  record('Inspect cobalt inventory status', 'cobalt__lookup_inventory', { projectId: 'project-b' });
  record('Compile amber warehouse digest', 'amber__summarize_inventory', { projectId: 'project-a' });
  record('Verify helium shift checklist', 'helium__inspect_workflow', { scope: 'workflow_step' });
  const file = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  file.strategies.push({ ...file.strategies[0], id: 'unverified-fixture', toolsUsed: ['xenon__unverified'], learningReceipt: undefined });
  fs.writeFileSync(STORE, JSON.stringify(file));
}

type ReadKind = 'verified' | 'matching' | 'heartbeat' | 'other';
async function observeReads<T>(run: () => T | Promise<T>): Promise<{ result: T; reads: ReadKind[] }> {
  const original = fs.readFileSync;
  const reads: ReadKind[] = [];
  fs.readFileSync = function (...args: unknown[]) {
    if (args[0] === STORE) {
      const stack = new Error().stack ?? '';
      reads.push(stack.includes('collectStrategyToolNames') ? 'heartbeat'
        : stack.includes('listMatchingRunStrategies') ? 'matching'
          : stack.includes('listVerifiedRunStrategies') ? 'verified' : 'other');
    }
    return Reflect.apply(original, fs, args);
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { return { result: await run(), reads }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

function answers(body: string, choice = 'none'): string {
  const request = JSON.parse(body) as SystemOneRequestPayload;
  return JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [id, question.type === 'choice'
      ? { type: 'choice', choice: id === 'which' ? choice : 'none', probabilities: { [id === 'which' ? choice : 'none']: 1 }, confidence: 1 }
      : { type: 'noul', noul: choice === 'none' ? 0 : 1 }]),
  ) });
}

const QUERY = 'Find a xenon summary and create a workflow named cobalt';

test('one request reuses its verified read and sends the exact separately loaded Jev question bytes', async () => {
  seed();
  const posts: string[] = [];
  jev._setSystemOneFetchForTests(async (_url, init) => {
    posts.push(init.body);
    return { status: 200, ok: true, text: async () => answers(init.body) };
  });
  const control = await observeReads(async () => {
    const familiar = familiarRunStrategiesForRequest(QUERY, 'chat');
    const operations = routableOperationsForRequest(QUERY, 'chat');
    assert.equal(familiar.filter((row) => row.toolsUsed.includes('xenon__summarize_market')).length, 1);
    assert.ok(!familiar.some((row) => row.id === 'unverified-fixture'));
    assert.ok(!operations.some((row) => row.id === 'xenon__unverified'));
    assert.ok(!familiar.some((row) => row.scope === 'workflow_step'));
    return decideTurnStartWithJev(QUERY, familiar, operations, { timeoutMs: PROVEN_PICK_BUDGET_MS });
  });
  assert.equal(control.reads.filter((kind) => kind === 'verified').length, 2, 'the independent direct readers each really open the store');
  const prepared = await observeReads(() => prepareProvenOperationForRequest({ query: QUERY }));
  assert.equal(prepared.reads.filter((kind) => kind === 'verified').length, 1, 'only the duplicated candidate read is removed');
  assert.equal(prepared.reads.filter((kind) => kind === 'matching').length, 1, 'request-identity lookup stays independent');
  assert.equal(prepared.reads.filter((kind) => kind === 'other').length, 0);
  assert.equal(posts.length, 2, 'both paths use the real decision client and one fake transport each');
  assert.equal(posts[1], posts[0], 'candidate ordering, question ordering, descriptions and complete request are byte-identical');
  assert.equal(control.result.strategy, null);
  assert.equal(prepared.result.strategyId, undefined);
  assert.equal(prepared.result.skipDiscoverySearch, false);
});

test('each new request reloads within its current scope, including workflow, unknown-session and no-binding behavior', async () => {
  seed();
  const a = createSession({ kind: 'chat', channel: 'desktop' });
  const b = createSession({ kind: 'chat', channel: 'desktop' });
  const workflow = createSession({ kind: 'workflow', channel: 'internal' });
  const posts: string[] = [];
  jev._setSystemOneFetchForTests(async (_url, init) => {
    posts.push(init.body);
    return { status: 200, ok: true, text: async () => answers(init.body) };
  });
  installMemoryScopeBinding({
    ambientSessionId: () => a.id,
    scopeOfSession: (sessionId) => sessionId === a.id || sessionId === workflow.id
      ? { projectId: 'project-a', agentKey: null }
      : sessionId === b.id ? { projectId: 'project-b', agentKey: null } : null,
  });
  try {
    const inspect = async (sessionId: string, scope: 'chat' | 'any') => {
      await withSessionMemoryScope(sessionId, () => decideTurnStartWithJev(QUERY,
        familiarRunStrategiesForRequest(QUERY, scope), routableOperationsForRequest(QUERY, scope),
        { sessionId, timeoutMs: PROVEN_PICK_BUDGET_MS }));
      const expected = posts.at(-1);
      const observed = await observeReads(() => prepareProvenOperationForRequest({ query: QUERY, sessionId }));
      assert.equal(observed.reads.filter((kind) => kind === 'verified').length, 1);
      assert.equal(posts.at(-1), expected, 'the current scope has the legacy candidate bytes');
      return posts.at(-1)!;
    };
    const first = await inspect(a.id, 'chat');
    assert.match(first, /amber__summarize_inventory/);
    assert.doesNotMatch(first, /cobalt__lookup_inventory|helium__inspect_workflow/);
    const second = await inspect(b.id, 'chat');
    assert.match(second, /cobalt__lookup_inventory/);
    assert.doesNotMatch(second, /amber__summarize_inventory/);
    record('Collect neon procurement balances', 'neon__collect_balances', { projectId: 'project-a' });
    assert.match(await inspect(a.id, 'chat'), /neon__collect_balances/, 'normal learning is visible on the next request');
    assert.match(await inspect(workflow.id, 'any'), /helium__inspect_workflow/);
    assert.doesNotMatch(await inspect('unknown-session', 'chat'), /amber__summarize_inventory|cobalt__lookup_inventory|neon__collect_balances/);
    installMemoryScopeBinding(null);
    const legacy = await inspect(a.id, 'chat');
    assert.match(legacy, /amber__summarize_inventory/);
    assert.match(legacy, /cobalt__lookup_inventory/, 'no installed scope binding retains the existing unrestricted behavior');
  } finally { installMemoryScopeBinding(null); }
});

test('malformed store, missing Jev and unrelated empty candidates retain discovery without a cached fallback', async () => {
  seed();
  let requests = 0;
  jev._setSystemOneFetchForTests(async (_url, init) => {
    requests += 1;
    return { status: 200, ok: true, text: async () => answers(init.body) };
  });
  await prepareProvenOperationForRequest({ query: QUERY });
  assert.equal(requests, 1);
  fs.writeFileSync(STORE, '{');
  const malformed = await prepareProvenOperationForRequest({ query: 'unrelated opaque salutation' });
  assert.equal(malformed.decisionWaitMs, undefined);
  assert.equal(malformed.strategyId, undefined);
  assert.equal(malformed.skipDiscoverySearch, false);
  assert.equal(requests, 1, 'the previous request supplies no retained candidates');
  seed();
  jev._setTypesafeKeyForTests(null);
  try {
    const missing = await observeReads(() => prepareProvenOperationForRequest({ query: QUERY }));
    assert.equal(missing.reads.filter((kind) => kind === 'verified').length, 0, 'no candidate snapshot is loaded for unavailable Jev');
    assert.equal(missing.result.decisionWaitMs, undefined);
    assert.equal(missing.result.skipDiscoverySearch, false);
    assert.equal(requests, 1);
  } finally { jev._setTypesafeKeyForTests('ts_fixture_snapshot'); }
});

test('malformed or unknown Jev selections and a late transport never bind a remembered operation', async () => {
  seed();
  const acquired: string[] = [];
  const a = createSession({ kind: 'chat', channel: 'desktop' });
  const accepted = appendEvent({ sessionId: a.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: QUERY } });
  for (const mode of ['malformed', 'unknown', 'timeout'] as const) {
    let requests = 0;
    let late: Promise<void> | undefined;
    jev._setSystemOneFetchForTests(async (_url, init) => {
      requests += 1;
      if (mode === 'timeout') {
        late = new Promise((resolve) => setTimeout(resolve, PROVEN_PICK_BUDGET_MS + 75));
        await late;
      }
      return { status: 200, ok: true, text: async () => mode === 'malformed' ? '{' : answers(init.body, 'never-recorded-strategy') };
    });
    const prepared = await prepareProvenOperationForRequest({ query: QUERY, sessionId: a.id, sourceUserSeq: accepted.seq }, {
      acquireLiveRead: async ({ operation }) => {
        acquired.push(operation);
        return { status: 'skipped', reason: 'fixture-unavailable' };
      },
    });
    assert.equal(requests, 1, mode);
    assert.equal(prepared.strategyId, undefined, mode);
    assert.equal(prepared.skipDiscoverySearch, false, mode);
    assert.equal(prepared.text, undefined, mode);
    if (mode === 'timeout') {
      assert.ok((prepared.decisionWaitMs ?? 0) >= PROVEN_PICK_BUDGET_MS - 50);
      await late;
      assert.equal(prepared.strategyId, undefined, 'late results cannot mutate the returned preparation');
    }
  }
  assert.deepEqual(acquired, []);
});

test('a selected strategy still acquires its live operation separately for each accepted source', async () => {
  seed();
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const row = familiarRunStrategiesForRequest(QUERY, 'chat').find((item) => item.toolsUsed.includes('xenon__summarize_market'))!;
  assert.ok(row);
  jev._setSystemOneFetchForTests(async (_url, init) => ({ status: 200, ok: true, text: async () => answers(init.body, row.id) }));
  const identities: Array<{ sessionId: string; sourceUserSeq: number }> = [];
  for (const turn of [1, 2]) {
    const accepted = appendEvent({ sessionId: session.id, turn, role: 'user', type: 'user_input_received', data: { text: QUERY } });
    const prepared = await prepareProvenOperationForRequest({ query: QUERY, sessionId: session.id, sourceUserSeq: accepted.seq }, {
      acquireLiveRead: async ({ identity, operation }) => {
        identities.push(identity);
        return turn === 1 ? { status: 'installed', kind: 'mcp', operation, accountId: 'fixture-current-a' }
          : { status: 'skipped', reason: 'fixture-no-current-binding' };
      },
    });
    assert.equal(prepared.pickedBy, 'jev');
    assert.equal(prepared.strategyId, row.id);
    assert.equal(prepared.skipDiscoverySearch, false, 'a relevance decision never manufactures callable catalog authority');
    assert.equal(prepared.liveReads.length, turn === 1 ? 1 : 0, 'a former account does not survive an unavailable current binding');
    if (turn === 1) assert.equal(prepared.liveReads[0]!.accountId, 'fixture-current-a');
    assert.deepEqual(identities.at(-1), { sessionId: session.id, sourceUserSeq: accepted.seq });
  }
  assert.equal(identities.length, 2);
  assert.notEqual(identities[0]!.sourceUserSeq, identities[1]!.sourceUserSeq);
});
