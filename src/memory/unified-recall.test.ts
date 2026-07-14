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
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, supersedeFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('./source-map.js');
// eslint-disable-next-line import/first
const { rememberToolChoice } = await import('./tool-choice-store.js');
// eslint-disable-next-line import/first
const { recallEverything, formatUnifiedRecall } = await import('./unified-recall.js');
// eslint-disable-next-line import/first
const { recallMemory } = await import('./recall-memory.js');
// eslint-disable-next-line import/first
const { setFactEntityLinks } = await import('./relations.js');

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

test('recallMemory traverses persisted entity links, not text guesses', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const linked = rememberFact({ kind: 'project', content: 'The renewal closes on September 30.' });
  setFactEntityLinks(linked.id, [acme]);

  const result = await recallMemory('Acme', { stores: ['fact', 'entity'], graphDepth: 1, limit: 10 });
  const hit = result.hits.find((item) => item.ref.type === 'fact' && item.ref.id === String(linked.id));
  assert.ok(hit, 'the fact is recalled through its stored entity edge despite not naming Acme');
  assert.ok(hit?.whyRecalled.includes('stored graph traversal'));
});

test('recallMemory considers a relevant fact beyond the former 500-row recency pool', async () => {
  const target = rememberFact({
    kind: 'reference',
    content: 'The zephyr-quartz recovery token is TAIL-7782.',
    occurredAt: '2020-01-01T00:00:00.000Z',
  });
  const db = openMemoryDb();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       importance, valid_from, confidence)
    VALUES ('project', ?, ?, 1, 1, ?, ?, 5, ?, 1)
  `);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (let i = 0; i < 510; i++) {
      insert.run(`Recent unrelated filler ${i}.`, `filler-hash-${i}`, now, now, now);
    }
  });
  tx();

  const result = await recallMemory('zephyr quartz recovery token', {
    stores: ['fact'],
    graphDepth: 0,
    limit: 5,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(target.id)));
  assert.ok(result.diagnostics.candidates >= 1);
});

test('unified recall identifies constraints as dispatch-enforced policy memory', async () => {
  const rule = rememberFact({ kind: 'constraint', content: 'Never publish a quote without legal approval.' });
  const result = await recallMemory('publish quote legal approval', { limit: 10 });
  const policy = result.hits.find((hit) => hit.ref.type === 'policy' && hit.ref.id === String(rule.id));
  assert.ok(policy);
  assert.ok(policy?.whyRecalled.includes('hard_constraint'));
  assert.ok(policy?.whyRecalled.includes('dispatch-enforced'));
  assert.ok(result.diagnostics.stores.includes('episode'));
  assert.ok(result.diagnostics.stores.includes('policy'));
});

test('unified recall searches every public memory store in one evidence pack', async () => {
  rememberFact({ kind: 'project', content: 'Orchid launch owner is Dana.' });
  rememberFact({ kind: 'constraint', content: 'Orchid publishing requires legal approval.' });
  upsertEntity({ type: 'project', name: 'Orchid' });
  upsertResourcePointer({ app: 'Drive', kind: 'folder', name: 'Orchid creative folder', whatsHere: 'campaign assets' });
  rememberToolChoice({ intent: 'review orchid campaign', choice: { kind: 'mcp', identifier: 'orchid__review_campaign', testedAt: new Date().toISOString() } });
  const note = 'Orchid meeting notes contain the creative brief and launch checklist.';
  openMemoryDb().prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, ?, ?, ?, ?)
  `).run('/vault/projects/orchid.md', note, 'Orchid brief', Date.now(), Buffer.byteLength(note), 'orchid-note-hash');

  const result = await recallMemory('Orchid launch publishing legal creative campaign review', { limit: 30 });
  const types = new Set(result.hits.map((hit) => hit.ref.type));
  for (const type of ['fact', 'note', 'entity', 'resource', 'episode', 'policy', 'procedure'] as const) {
    assert.ok(types.has(type), `unified search includes ${type}`);
  }
});

test('stored graph traversal respects fact validity for historical entity queries', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const old = rememberFact({
    kind: 'project',
    content: 'The renewal target was one million dollars.',
    occurredAt: '2025-01-01T00:00:00.000Z',
  });
  setFactEntityLinks(old.id, [acme]);
  const current = supersedeFact(old.id, {
    content: 'The renewal target is two million dollars.',
    occurredAt: '2025-02-01T00:00:00.000Z',
  });
  assert.ok(current);
  setFactEntityLinks(current!.id, [acme]);

  const result = await recallMemory('What did we know about Acme as of 2025-01-15?', {
    stores: ['fact', 'entity'],
    graphDepth: 1,
    limit: 10,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(old.id)));
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(current!.id)));
});
