/** Real JIT selection with synthetic providers only: no model, network or live home. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { EmbeddingProvider } from '../memory/embeddings.js';
import type { EmbeddingWorkOptions, EmbeddingWorkUpdate } from '../memory/embedding-worker.js';
import type { JitTool, ToolJitSelection } from './tool-jit.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-jit-producing-space-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_EMBED_PROVIDER = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'false';
delete process.env.OPENAI_API_KEY;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Unexpected network in JIT synthetic control'); }) as typeof fetch;
const {
  _setEmbeddingProviderForTest, _setLocalProviderForTest,
  _setEmbeddingProviderHealthFileForTest, _resetEmbeddingHealthForTest, _resetEmbedDemotionForTest,
} = await import('../memory/embeddings.js');
const { selectToolsForTurn, TOOL_JIT_CORE, _resetToolJitCachesForTest } = await import('./tool-jit.js');
const { WORKSPACE_DOCK_TOOLS } = await import('../spaces/workspace-context.js');

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function reached(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Did not reach ${label}`)), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const core = [...TOOL_JIT_CORE].slice(0, 3);
const tools: JitTool[] = [...core.map(name => ({ name, description: `Core ${name}` })),
  { name: 'jit_alpha', description: 'Controlled first operation' },
  { name: 'jit_beta', description: 'Controlled second operation' },
  { name: 'jit_gamma', description: 'Controlled third operation' }];
const v = (values = [1, 0]) => new Float32Array(values);
const normalDocument = (text: string) => text.startsWith('jit_alpha\n') ? v() : v([0, 1]);
const full = (result: ToolJitSelection, surface = tools) => {
  assert.equal(result.reduced, false); assert.equal(result.droppedCount, 0);
  assert.deepEqual([...result.exposed].sort(), surface.map(tool => tool.name).sort());
};
const selected = (result: ToolJitSelection, name = 'jit_alpha') => {
  assert.equal(result.reduced, true); assert.ok(result.exposed.has(name), `${name} must be selected from compatible vectors`);
  for (const item of core) assert.ok(result.exposed.has(item), `core ${item} must survive`);
};
function fixture(model: string, options: {
  dim?: number;
  query?: (text: string, work: EmbeddingWorkOptions | undefined, count: number) => Promise<Float32Array[]>;
  documents?: (texts: string[], work: EmbeddingWorkOptions | undefined, count: number) => Promise<Float32Array[]>;
} = {}) {
  const calls = { queries: [] as string[], documents: [] as string[][] };
  const provider: EmbeddingProvider = { name: 'jit-fixture', model, dim: options.dim ?? 2,
    async embed(texts, work) {
      if (texts.every(text => text.includes('\n'))) {
        calls.documents.push([...texts]);
        return options.documents?.(texts, work, calls.documents.length) ?? texts.map(normalDocument);
      }
      assert.equal(texts.length, 1, 'only the actual query should take the one-query provider path');
      calls.queries.push(texts[0]!);
      return options.query?.(texts[0]!, work, calls.queries.length) ?? [v()];
    },
  };
  return { provider, calls };
}
beforeEach(() => {
  process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
  process.env.CLEMMY_TOOL_JIT_BUDGET_TOKENS = '1';
  process.env.CLEMMY_TOOL_JIT_MIN_SCORE = '0.5';
  process.env.CLEMMY_TOOL_JIT_TOPK = '1';
  _setEmbeddingProviderForTest(null); _setLocalProviderForTest(null);
  _setEmbeddingProviderHealthFileForTest(path.join(home, 'provider-health.json'));
  _resetEmbeddingHealthForTest(); _resetEmbedDemotionForTest(); _resetToolJitCachesForTest();
});
afterEach(() => {
  _resetToolJitCachesForTest(); _setEmbeddingProviderForTest(null); _setLocalProviderForTest(null);
  _resetEmbeddingHealthForTest(); _resetEmbedDemotionForTest();
});
after(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

for (const dim of [2, 3]) {
  test(`model switch refreshes same-query and description geometry (${dim}-dimension replacement)`, async () => {
    const a = fixture('space-a'); _setEmbeddingProviderForTest(a.provider);
    selected(await selectToolsForTurn({ userInput: 'controlled selection', tools }));
    const b = fixture(`space-b-${dim}`, { dim,
      query: async () => [dim === 2 ? v([0, 1]) : v([0, 0, 1])],
      documents: async texts => texts.map(text => text.startsWith('jit_beta\n')
        ? (dim === 2 ? v([0, 1]) : v([0, 0, 1])) : (dim === 2 ? v() : v([1, 0, 0]))),
    });
    _setEmbeddingProviderForTest(b.provider);
    const next = await selectToolsForTurn({ userInput: 'controlled selection', tools }); selected(next, 'jit_beta');
    assert.equal(next.exposed.has('jit_alpha'), false); assert.equal(b.calls.queries.length, 1); assert.equal(b.calls.documents.length, 1);
  });
}

test('a different producer instance with the same declared space cannot reuse old description geometry', async () => {
  const a = fixture('same-declared-space'); _setEmbeddingProviderForTest(a.provider);
  selected(await selectToolsForTurn({ userInput: 'same metadata request', tools }));
  const b = fixture('same-declared-space', { query: async () => [v([0, 1])],
    documents: async texts => texts.map(text => text.startsWith('jit_beta\n') ? v([0, 1]) : v()),
  });
  _setEmbeddingProviderForTest(b.provider);
  const next = await selectToolsForTurn({ userInput: 'same metadata request', tools }); selected(next, 'jit_beta');
  assert.equal(next.exposed.has('jit_alpha'), false);
  assert.equal(b.calls.queries.length, 1); assert.equal(b.calls.documents.length, 1);
});

test('same-call local rescue pins descriptions to the real producer without a second remote attempt', async () => {
  process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
  const remote = fixture('remote-space', { query: async () => { throw new Error('controlled transport unavailable'); },
    documents: async () => { throw new Error('remote documents must never be attempted'); } });
  const local = fixture('local-rescue'); local.provider = { ...local.provider, name: 'local' };
  _setEmbeddingProviderForTest({ ...remote.provider, name: 'openai' }); _setLocalProviderForTest(local.provider);
  selected(await selectToolsForTurn({ userInput: 'rescue controlled request', tools }));
  assert.equal(remote.calls.queries.length, 1); assert.equal(remote.calls.documents.length, 0);
  assert.equal(local.calls.queries.length, 1); assert.equal(local.calls.documents.length, 1);
});

for (const boundary of ['query', 'documents'] as const) {
  for (const change of ['provider', 'reset'] as const) {
    test(`${change} during held ${boundary} returns full surface and cannot poison a later selection`, async () => {
      const entered = deferred<void>(), release = deferred<Float32Array[]>();
      const a = fixture(`held-${boundary}-${change}`, {
        query: async (_text, _work, count) => {
          if (boundary === 'query' && count === 1) { entered.resolve(); return release.promise; }
          return [v()];
        },
        documents: async (texts, _work, count) => {
          if (boundary === 'documents' && count === 1) { entered.resolve(); return release.promise; }
          return texts.map(normalDocument);
        },
      });
      _setEmbeddingProviderForTest(a.provider);
      const old = selectToolsForTurn({ userInput: 'held controlled request', tools, deadlineAtMs: Date.now() + 5000 });
      await reached(entered.promise, boundary);
      const b = fixture('replacement-space', { query: async () => [v([0, 1])], documents: async texts => texts.map(text => text.startsWith('jit_beta\n') ? v([0, 1]) : v()) });
      if (change === 'provider') _setEmbeddingProviderForTest(b.provider); else _resetToolJitCachesForTest();
      // Deliberately wrong old description ranking must not populate the reset cache.
      release.resolve(boundary === 'query' ? [v()] : tools.filter(tool => !TOOL_JIT_CORE.has(tool.name)).map(tool => tool.name === 'jit_beta' ? v() : v([0, 1])));
      full(await old);
      const next = await selectToolsForTurn({ userInput: 'held controlled request', tools }); selected(next, change === 'provider' ? 'jit_beta' : 'jit_alpha');
      if (change === 'provider') { assert.equal(b.calls.queries.length, 1); assert.equal(b.calls.documents.length, 1); }
      else assert.equal(a.calls.documents.length, boundary === 'documents' ? 2 : 1, 'retired description batch was not reused after reset');
    });
  }
}

test('two cold same-query selections share one query and one complete description batch', async () => {
  const queryEntered = deferred<void>(), queryRelease = deferred<Float32Array[]>();
  const docsEntered = deferred<void>(), docsRelease = deferred<Float32Array[]>();
  const f = fixture('same-query-shared', { query: async () => { queryEntered.resolve(); return queryRelease.promise; },
    documents: async () => { docsEntered.resolve(); return docsRelease.promise; } });
  _setEmbeddingProviderForTest(f.provider);
  const opts = { userInput: 'same cold request', tools, deadlineAtMs: Date.now() + 5000 };
  const a = selectToolsForTurn(opts), b = selectToolsForTurn(opts);
  await reached(queryEntered.promise, 'shared query'); assert.equal(f.calls.queries.length, 1);
  queryRelease.resolve([v()]); await reached(docsEntered.promise, 'shared descriptions'); await turn();
  assert.equal(f.calls.documents.length, 1, 'in-flight exact descriptions must be reserved before awaiting the batch');
  docsRelease.resolve(f.calls.documents[0]!.map(normalDocument));
  for (const result of await Promise.all([a, b])) selected(result);
});

test('different queries with overlapping tools share each exact description without duplicating the overlap', async () => {
  const secondBatchEntered = deferred<void>();
  const batches: Array<{ texts: string[]; release: ReturnType<typeof deferred<Float32Array[]>> }> = [];
  const f = fixture('overlapping-documents', { documents: async texts => {
    const release = deferred<Float32Array[]>(); batches.push({ texts: [...texts], release });
    if (batches.length === 2) secondBatchEntered.resolve();
    return release.promise;
  } });
  _setEmbeddingProviderForTest(f.provider);
  const aTools = tools.filter(tool => tool.name !== 'jit_gamma');
  const bTools = tools.filter(tool => tool.name !== 'jit_alpha');
  const a = selectToolsForTurn({ userInput: 'first overlap request', tools: aTools, deadlineAtMs: Date.now() + 5000 });
  const b = selectToolsForTurn({ userInput: 'second overlap request', tools: bTools, deadlineAtMs: Date.now() + 5000 });
  await reached(secondBatchEntered.promise, 'second overlapping description batch');
  assert.equal(f.calls.queries.length, 2); assert.equal(batches.length, 2);
  const texts = batches.flatMap(batch => batch.texts);
  for (const name of ['jit_alpha', 'jit_beta', 'jit_gamma']) assert.equal(texts.filter(text => text.startsWith(`${name}\n`)).length, 1, `${name} exact bytes embedded once`);
  batches.forEach(batch => batch.release.resolve(batch.texts.map(normalDocument)));
  const [first, second] = await Promise.all([a, b]); selected(first); assert.equal(second.reduced, true);
});

test('changed description bytes re-embed only that description; unchanged neighbors remain shared', async () => {
  const f = fixture('changed-description'); _setEmbeddingProviderForTest(f.provider);
  selected(await selectToolsForTurn({ userInput: 'description request', tools }));
  const changed = tools.map(tool => tool.name === 'jit_alpha' ? { ...tool, description: 'Changed controlled first operation' } : tool);
  selected(await selectToolsForTurn({ userInput: 'description request', tools: changed }));
  assert.equal(f.calls.queries.length, 1); assert.equal(f.calls.documents.length, 2);
  assert.deepEqual(f.calls.documents[1], ['jit_alpha\nChanged controlled first operation']);
  assert.equal(f.calls.documents.flat().filter(text => text.startsWith('jit_beta\n')).length, 1);
});

test('an earlier deadline exposes full tools while a longer shared description subscriber survives', async () => {
  const entered = deferred<void>(), release = deferred<Float32Array[]>();
  const updates: EmbeddingWorkUpdate[] = []; let cancelled = 0; let physicalWork: EmbeddingWorkOptions | undefined;
  const f = fixture('shared-doc-deadline', { documents: async (_texts, work) => {
    physicalWork = work; work?.onQueued?.({ update: update => updates.push({ ...update }), cancel: () => { cancelled++; } });
    entered.resolve(); return release.promise;
  } });
  _setEmbeddingProviderForTest(f.provider);
  const short = selectToolsForTurn({ userInput: 'deadline shared request', tools, deadlineAtMs: Date.now() + 150 });
  await reached(entered.promise, 'held shared descriptions');
  const longDeadline = Date.now() + 5000;
  const long = selectToolsForTurn({ userInput: 'deadline shared request', tools, deadlineAtMs: longDeadline }); await turn();
  assert.equal(physicalWork?.deadlineAtMs, longDeadline); full(await short);
  assert.equal(cancelled, 0); assert.equal(f.calls.documents.length, 1);
  release.resolve(f.calls.documents[0]!.map(normalDocument)); selected(await long);
  selected(await selectToolsForTurn({ userInput: 'deadline shared request', tools }));
  assert.equal(f.calls.queries.length, 1); assert.equal(f.calls.documents.length, 1);
  assert.ok(updates.some(update => update.deadlineAtMs === longDeadline));
});

test('an expired budget starts no embedding and preserves the full tool surface', async () => {
  const f = fixture('expired-budget'); _setEmbeddingProviderForTest(f.provider);
  full(await selectToolsForTurn({ userInput: 'expired request', tools, deadlineAtMs: Date.now() - 1 }));
  assert.equal(f.calls.queries.length, 0); assert.equal(f.calls.documents.length, 0);
});

for (const malformed of ['failure', 'count', 'dimension', 'zero', 'nonfinite'] as const) {
  test(`a ${malformed} description batch exposes full tools and does not stick in the cache`, async () => {
    const f = fixture(`recover-${malformed}`, { documents: async (texts, _work, count) => {
      if (count > 1) return texts.map(normalDocument);
      if (malformed === 'failure') throw new Error('controlled document failure');
      if (malformed === 'count') return [v()];
      if (malformed === 'dimension') return texts.map(() => v([1, 0, 0]));
      if (malformed === 'zero') return texts.map(() => v([0, 0]));
      return texts.map(() => v([Number.NaN, 1]));
    } });
    _setEmbeddingProviderForTest(f.provider);
    full(await selectToolsForTurn({ userInput: 'recovery controlled request', tools }));
    selected(await selectToolsForTurn({ userInput: 'recovery controlled request', tools }));
    assert.equal(f.calls.queries.length, 1); assert.equal(f.calls.documents.length, 2);
  });
}

test('a failed query is not cached as a sticky no-signal result', async () => {
  const f = fixture('query-failure', { query: async (_text, _work, count) => { if (count === 1) throw new Error('controlled query failure'); return [v()]; } });
  _setEmbeddingProviderForTest(f.provider);
  full(await selectToolsForTurn({ userInput: 'query retry request', tools }));
  selected(await selectToolsForTurn({ userInput: 'query retry request', tools }));
  assert.equal(f.calls.queries.length, 2); assert.equal(f.calls.documents.length, 1);
});

for (const malformed of ['dimension', 'nonfinite'] as const) {
  test(`a ${malformed} query falls back safely and a later valid query can recover`, async () => {
    const f = fixture(`query-${malformed}`, { query: async (_text, _work, count) => count > 1 ? [v()]
      : [malformed === 'dimension' ? v([1, 0, 0]) : v([Number.NaN, 1])] });
    _setEmbeddingProviderForTest(f.provider);
    full(await selectToolsForTurn({ userInput: 'malformed query request', tools }));
    assert.equal(f.calls.documents.length, 0, 'unusable query must not admit a description batch');
    selected(await selectToolsForTurn({ userInput: 'malformed query request', tools }));
    assert.equal(f.calls.queries.length, 2); assert.equal(f.calls.documents.length, 1);
  });
}

test('legacy now input does not replace the real foreground wall deadline', async () => {
  const f = fixture('independent-wall-deadline'); _setEmbeddingProviderForTest(f.provider);
  selected(await selectToolsForTurn({ userInput: 'wall deadline request', tools, now: 1 }));
  assert.equal(f.calls.queries.length, 1); assert.equal(f.calls.documents.length, 1);
});

test('under-budget surfaces keep every tool without invoking either embedding path', async () => {
  delete process.env.CLEMMY_TOOL_JIT_BUDGET_TOKENS;
  const f = fixture('within-budget'); _setEmbeddingProviderForTest(f.provider);
  const result = await selectToolsForTurn({ userInput: 'ordinary request', tools }); full(result);
  assert.equal(result.reason, 'within-budget'); assert.equal(f.calls.queries.length, 0); assert.equal(f.calls.documents.length, 0);
});

test('valid orthogonal zero scores retain the existing pruning policy rather than becoming invalid signal', async () => {
  const f = fixture('valid-zero', { documents: async texts => texts.map(() => v([0, 1])) }); _setEmbeddingProviderForTest(f.provider);
  const result = await selectToolsForTurn({ userInput: 'ordinary request', tools });
  assert.equal(result.reduced, true); assert.deepEqual([...result.exposed].sort(), [...core].sort());
});

test('core, workspace, background, team, recall and literal pins survive real zero-score semantic selection', async () => {
  const pinned = ['dispatch_background_task', 'background_task_status', 'background_tasks_recent', 'team_list', 'delegate_task', 'jit_recalled', 'jit_literal'];
  const names = [...new Set([...TOOL_JIT_CORE, ...WORKSPACE_DOCK_TOOLS, ...pinned, 'jit_unpinned'])];
  const surface = names.map(name => ({ name, description: `Controlled ${name}` }));
  const f = fixture('all-pins', { documents: async texts => texts.map(() => v([0, 1])) }); _setEmbeddingProviderForTest(f.provider);
  const result = await selectToolsForTurn({ userInput: 'Build a workspace dashboard and dispatch a background task; create a specialist agent; use jit_literal.', tools: surface, recallPinned: ['jit_recalled'] });
  assert.equal(result.reduced, true); assert.equal(result.exposed.has('jit_unpinned'), false);
  for (const name of [...TOOL_JIT_CORE, ...WORKSPACE_DOCK_TOOLS, ...pinned]) assert.ok(result.exposed.has(name), `${name} retains its existing pin`);
});
