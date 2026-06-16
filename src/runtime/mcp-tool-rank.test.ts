/**
 * Run: npx tsx --test src/runtime/mcp-tool-rank.test.ts
 *
 * T1 semantic tool ranker — the GRACEFUL-FALLBACK contract (deterministic, no
 * network): when embeddings are disabled or the kill-switch is off, the ranker
 * returns undefined so the filter falls straight back to keyword/index order.
 * The actual cosine ranking with live embeddings is covered by the live smoke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
