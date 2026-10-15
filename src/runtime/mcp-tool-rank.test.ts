/**
 * Run: npx tsx --test src/runtime/mcp-tool-rank.test.ts
 *
 * T1 semantic tool ranker — the GRACEFUL-FALLBACK contract (deterministic, no
 * network/model loads): disabled or unhealthy embeddings preserve keyword
 * ranking, and synthetic providers exercise the real producer/cache boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetEmbedDemotionForTest,
  _resetEmbeddingHealthForTest,
  _resetLocalProviderForTest,
  _setEmbeddingProviderForTest,
  _setLocalProviderForTest,
  type EmbeddingProvider,
} from '../memory/embeddings.js';

const { rankToolsBySemantic, semanticToolRankEnabled, _resetToolRankCachesForTest } =
  await import('./mcp-tool-rank.js');

const tool = (name: string, description = ''): any => ({ name, description, inputSchema: { type: 'object' } });

// isEmbeddingsEnabled() reads EMBEDDINGS_DISABLED per call. Confine every env
// mutation to the exact call window with try/finally so nothing leaks to other
// test files (the full suite shares process state). Restore the prior values.
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('semanticToolRankEnabled defaults on, off via kill-switch', async () => {
  await withEnv({ CLEMMY_MCP_SEMANTIC_RANK: undefined }, () => {
    assert.equal(semanticToolRankEnabled(), true);
  });
  await withEnv({ CLEMMY_MCP_SEMANTIC_RANK: 'off' }, () => {
    assert.equal(semanticToolRankEnabled(), false);
  });
  await withEnv({ CLEMMY_MCP_SEMANTIC_RANK: 'on' }, () => {
    assert.equal(semanticToolRankEnabled(), true);
  });
});

test('rankToolsBySemantic returns undefined when embeddings are disabled (graceful)', async () => {
  _resetToolRankCachesForTest();
  await withEnv({ EMBEDDINGS_DISABLED: 'true' }, async () => {
    const out = await rankToolsBySemantic('add a row to my airtable', [
      tool('airtable__list_records', 'List Airtable records'),
      tool('github__create_issue', 'Open a GitHub issue'),
    ]);
    assert.equal(out, undefined, 'no semantic signal when embeddings off → filter uses keyword/index order');
  });
});

test('rankToolsBySemantic returns undefined for empty query or empty tools', async () => {
  await withEnv({ EMBEDDINGS_DISABLED: 'true' }, async () => {
    assert.equal(await rankToolsBySemantic('', [tool('a__b', 'x')]), undefined);
    assert.equal(await rankToolsBySemantic('   ', [tool('a__b', 'x')]), undefined);
    assert.equal(await rankToolsBySemantic('do a thing', []), undefined);
    assert.equal(await rankToolsBySemantic(null, [tool('a__b', 'x')]), undefined);
  });
});

test('rankToolsBySemantic returns undefined when the kill-switch is off', async () => {
  await withEnv({ CLEMMY_MCP_SEMANTIC_RANK: 'off' }, async () => {
    const out = await rankToolsBySemantic('add a row to my airtable', [tool('airtable__list_records', 'List records')]);
    assert.equal(out, undefined);
  });
});

const rankTools = [tool('fixture__alpha', 'Alpha operation'), tool('fixture__beta', 'Beta operation')];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function providerFixture(
  name: string,
  model: string,
  queryAxis: 0 | 1,
  beforeEmbed?: (texts: string[], call: number) => Promise<void>,
) {
  const batches: string[][] = [];
  const provider: EmbeddingProvider = {
    name,
    model,
    dim: 2,
    async embed(texts) {
      batches.push([...texts]);
      await beforeEmbed?.(texts, batches.length);
      return texts.map((text) => new Float32Array(
        text.includes('fixture__alpha') ? [1, 0]
          : text.includes('fixture__beta') ? [0, 1]
            : queryAxis === 0 ? [1, 0] : [0, 1],
      ));
    },
  };
  return { provider, batches };
}

async function withSyntheticProviders(fn: () => Promise<void>): Promise<void> {
  _resetToolRankCachesForTest();
  _resetEmbeddingHealthForTest();
  _resetEmbedDemotionForTest();
  try {
    await withEnv({ EMBEDDINGS_DISABLED: 'false', CLEMMY_MCP_SEMANTIC_RANK: 'on' }, fn);
  } finally {
    _setEmbeddingProviderForTest(undefined);
    _resetLocalProviderForTest();
    _resetEmbeddingHealthForTest();
    _resetEmbedDemotionForTest();
    _resetToolRankCachesForTest();
  }
}

function assertBetaRanking(scores: Map<string, number> | undefined): void {
  assert.ok(scores, 'a stable, healthy producer supplies semantic scores');
  assert.equal(scores.get('fixture__alpha'), 0);
  assert.equal(scores.get('fixture__beta'), 1);
}

test('stable producer caches query and tool text, re-embedding changed descriptions only', async () => {
  await withSyntheticProviders(async () => {
    const fixture = providerFixture('fixture-stable', 'space-a', 1);
    _setEmbeddingProviderForTest(fixture.provider);
    assertBetaRanking(await rankToolsBySemantic('stable query', rankTools, 1_000));
    assert.deepEqual(fixture.batches.map((batch) => batch.length), [1, 2]);
    assertBetaRanking(await rankToolsBySemantic('stable query', rankTools, 1_001));
    assert.equal(fixture.batches.length, 2, 'same stable space reuses both caches');
    assertBetaRanking(await rankToolsBySemantic('stable query', [
      rankTools[0], tool('fixture__beta', 'Changed beta operation'),
    ], 1_002));
    assert.deepEqual(fixture.batches.map((batch) => batch.length), [1, 2, 1]);
  });
});

for (const change of ['provider', 'model'] as const) {
  test(`same-dimension ${change} changes do not reuse another space's query or tool vectors`, async () => {
    await withSyntheticProviders(async () => {
      const first = providerFixture('fixture-a', 'space-a', 0);
      const second = providerFixture(change === 'provider' ? 'fixture-b' : 'fixture-a', change === 'model' ? 'space-b' : 'space-a', 1);
      _setEmbeddingProviderForTest(first.provider);
      assert.equal((await rankToolsBySemantic('identical query', rankTools, 1_000))?.get('fixture__alpha'), 1);
      _setEmbeddingProviderForTest(second.provider);
      assertBetaRanking(await rankToolsBySemantic('identical query', rankTools, 1_001));
      assert.deepEqual(second.batches.map((batch) => batch.length), [1, 2], 'both vectors are produced in the replacement space');
    });
  });
}

test('provider swap during query await discards the old result before embedding tool text', async () => {
  await withSyntheticProviders(async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const first = providerFixture('fixture-slow-query', 'space-a', 0, async () => {
      started.resolve();
      await release.promise;
    });
    const second = providerFixture('fixture-query-next', 'space-b', 1);
    _setEmbeddingProviderForTest(first.provider);
    const pending = rankToolsBySemantic('query changes during await', rankTools, 1_000);
    await started.promise;
    _setEmbeddingProviderForTest(second.provider);
    release.resolve();
    assert.equal(await pending, undefined, 'an in-flight old selection never supplies the new run');
    assert.equal(first.batches.length, 1, 'the old request does not proceed to tool embeddings');
    assertBetaRanking(await rankToolsBySemantic('query changes during await', rankTools, 1_001));
    assert.deepEqual(second.batches.map((batch) => batch.length), [1, 2]);
  });
});

test('provider swap during tool await cannot overwrite a newer cache or return stale scores', async () => {
  await withSyntheticProviders(async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const first = providerFixture('fixture-slow-documents', 'space-a', 0, async (_texts, call) => {
      if (call === 2) {
        started.resolve();
        await release.promise;
      }
    });
    const second = providerFixture('fixture-documents-next', 'space-b', 1);
    _setEmbeddingProviderForTest(first.provider);
    const pending = rankToolsBySemantic('old query', rankTools, 1_000);
    await started.promise;
    _setEmbeddingProviderForTest(second.provider);
    assertBetaRanking(await rankToolsBySemantic('new query', rankTools, 1_001));
    release.resolve();
    assert.equal(await pending, undefined);
    assertBetaRanking(await rankToolsBySemantic('new query', rankTools, 1_002));
    assert.equal(second.batches.length, 2, 'newer producer cache stays usable after old completion');
  });
});

test('a selection that changes away and back while awaiting still invalidates the old request', async () => {
  await withSyntheticProviders(async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const first = providerFixture('fixture-restored', 'space-a', 0, async () => {
      started.resolve();
      await release.promise;
    });
    const second = providerFixture('fixture-intermediate', 'space-b', 1);
    _setEmbeddingProviderForTest(first.provider);
    const pending = rankToolsBySemantic('restored selection', rankTools, 1_000);
    await started.promise;
    _setEmbeddingProviderForTest(second.provider);
    _setEmbeddingProviderForTest(first.provider);
    release.resolve();
    assert.equal(await pending, undefined, 'equal final space keys cannot hide an intervening selection change');
    assert.equal(first.batches.length, 1);
  });
});

test('cache reset during tool await blocks stale re-admission and requires a fresh document batch', async () => {
  await withSyntheticProviders(async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = providerFixture('fixture-cache-reset', 'space-a', 1, async (_texts, call) => {
      if (call === 2) {
        started.resolve();
        await release.promise;
      }
    });
    _setEmbeddingProviderForTest(fixture.provider);
    const pending = rankToolsBySemantic('cache cleared during await', rankTools, 1_000);
    await started.promise;
    _resetToolRankCachesForTest();
    release.resolve();
    assert.equal(await pending, undefined);
    assertBetaRanking(await rankToolsBySemantic('cache cleared during await', rankTools, 1_001));
    assert.equal(fixture.batches.filter((batch) => batch.length === 2).length, 2, 'old in-flight document vectors were not cached after reset');
  });
});

test('same-call query failover pins tool embeddings to its actual producer without retrying the failed provider', async () => {
  await withSyntheticProviders(async () => {
    let remoteCalls = 0;
    const remote = providerFixture('openai', 'fixture-remote', 0, async () => {
      remoteCalls += 1;
      if (remoteCalls === 1) throw new Error('synthetic embedding network timeout');
    });
    const local = providerFixture('local', 'fixture-rescue', 1);
    _setLocalProviderForTest(local.provider);
    _setEmbeddingProviderForTest(remote.provider);
    assertBetaRanking(await rankToolsBySemantic('rescued query', rankTools, 1_000));
    assert.equal(remoteCalls, 1, 'document batch uses the successful query producer directly');
    assert.deepEqual(local.batches.map((batch) => batch.length), [1, 2]);
    assertBetaRanking(await rankToolsBySemantic('rescued query', rankTools, 1_001));
    assert.equal(remoteCalls, 1, 'provenance-preserving query cache retains the actual producer lease');
  });
});

test('tool embedding failure cannot silently compare a second producer with the successful query', async () => {
  await withSyntheticProviders(async () => {
    const remote = providerFixture('openai', 'fixture-document-refusal', 0, async (_texts, call) => {
      if (call === 2) throw new Error('synthetic document embedding network timeout');
    });
    const local = providerFixture('local', 'fixture-other-space', 1);
    _setLocalProviderForTest(local.provider);
    _setEmbeddingProviderForTest(remote.provider);
    assert.equal(await rankToolsBySemantic('query already in remote space', rankTools, 1_000), undefined);
    assert.equal(local.batches.length, 0, 'a pinned document batch does not cross into the fallback space');
    assert.equal((await rankToolsBySemantic('query already in remote space', rankTools, 1_001))?.get('fixture__alpha'), 1);
    assert.equal(remote.batches.length, 3, 'failure is not cached as successful document geometry');
  });
});
