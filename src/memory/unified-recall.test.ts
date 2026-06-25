/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-unified npx tsx --test src/memory/unified-recall.test.ts
 *
 * WS4 — unified recall facade. One objective fans out to facts, vault, entities,
 * resources, and tool-recall, ranked together. No embedding provider in the test
 * (no key, local absent) so facts/vault use their lexical paths — deterministic.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-unified';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.OPENAI_API_KEY;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off'; // force lexical, fully offline + deterministic

// eslint-disable-next-line import/first
const { resetMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('./source-map.js');
// eslint-disable-next-line import/first
const { rememberToolChoice } = await import('./tool-choice-store.js');
// eslint-disable-next-line import/first
const { recallEverything, formatUnifiedRecall } = await import('./unified-recall.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('recallEverything fans out across stores and ranks them together', async () => {
  rememberFact({ kind: 'project', content: 'The Acme renewal closes at the end of the quarter.' });
  upsertEntity({ type: 'company', name: 'Acme' });
  upsertResourcePointer({ app: 'Salesforce', kind: 'object', name: 'Acme renewal opportunity', whatsHere: 'the Acme renewal deal record' });
  rememberToolChoice({ intent: 'query salesforce opportunities', choice: { kind: 'cli', identifier: 'sf', testedAt: new Date().toISOString() } });

  const result = await recallEverything('Acme renewal in salesforce', { limit: 20 });
  const types = new Set(result.hits.map((h) => h.type));
  assert.ok(types.has('fact'), 'a fact hit');
  assert.ok(types.has('entity'), 'an entity hit (Acme)');
  assert.ok(types.has('resource'), 'a resource hit (the SF opportunity)');
  // Hits are sorted by fused score descending.
  for (let i = 1; i < result.hits.length; i++) {
    assert.ok(result.hits[i - 1].score >= result.hits[i].score, 'descending fused score');
  }
  assert.ok((result.perStore.entity ?? 0) >= 1);
});

test('empty objective returns no hits', async () => {
  rememberFact({ kind: 'user', content: 'Something.' });
  const result = await recallEverything('   ');
  assert.equal(result.hits.length, 0);
});

test('stores filter restricts which stores participate', async () => {
  rememberFact({ kind: 'project', content: 'Acme renewal note.' });
  upsertEntity({ type: 'company', name: 'Acme' });
  const result = await recallEverything('Acme renewal', { stores: ['entity'] });
  assert.ok(result.hits.every((h) => h.type === 'entity'), 'only entity hits');
  assert.equal(result.perStore.fact, undefined, 'facts store not consulted');
});

test('formatUnifiedRecall produces a tagged, bounded block', async () => {
  upsertEntity({ type: 'company', name: 'Acme' });
  const result = await recallEverything('Acme', { stores: ['entity'] });
  const block = formatUnifiedRecall(result);
  assert.match(block, /RELEVANT MEMORY/);
  assert.match(block, /\[WHO\/WHAT\] Acme/);
});
