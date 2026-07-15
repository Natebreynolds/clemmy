import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recall-shadow';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { recallMemory } = await import('./recall-memory.js');
const { setFactEntityLinks } = await import('./relations.js');
const { upsertEntity } = await import('./reflection.js');
const { compareRecallShadow, readRecallShadowEntries, readRecallShadowSummary } = await import('./recall-shadow.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  rmSync(`${TEST_HOME}/state/memory-recall-shadow.jsonl`, { force: true });
  openMemoryDb();
});

test('shadow comparison records graph-only and tail-memory wins without changing the served result', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const graphOnly = rememberFact({ kind: 'project', content: 'The renewal closes on September 30.' });
  setFactEntityLinks(graphOnly.id, [acme]);
  const lexical = rememberFact({ kind: 'project', content: 'Acme renewal owner is Dana.' });

  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET updated_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', graphOnly.id);
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at, importance, valid_from, confidence)
    VALUES ('project', ?, ?, 1, 1, ?, ?, 1, ?, 1)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let index = 0; index < 510; index++) insert.run(`Recent shadow filler ${index}.`, `shadow-filler-${index}`, now, now, now);
  })();

  const served = await recallMemory('What do we know about Acme?', {
    stores: ['fact', 'entity'], graphDepth: 1, limit: 10,
  });
  assert.ok(served.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(graphOnly.id)));

  const entry = await compareRecallShadow({
    query: 'What do we know about Acme?',
    surface: 'automatic_primer',
    primary: served,
    limit: 10,
    nowIso: '2026-07-14T12:00:00.000Z',
  });
  assert.ok(entry);
  assert.ok(entry?.primaryOnlyFactIds.includes(graphOnly.id), 'stored graph traversal beats lexical-only recall');
  assert.ok(entry?.legacyFactIds.includes(lexical.id), 'legacy lexical baseline remains represented');
  assert.ok(entry?.tailFactIds.includes(graphOnly.id), 'fact beyond the former top-500 pool is measured');
  assert.ok((entry?.evidenceBacked ?? 0) >= 1);

  const [persisted] = readRecallShadowEntries(5);
  assert.equal(persisted.queryHash.length, 16);
  assert.equal(persisted.surface, 'automatic_primer');
  const summary = readRecallShadowSummary();
  assert.equal(summary.samples, 1);
  assert.ok(summary.primaryOnly >= 1);
  assert.ok(summary.tailHits >= 1);
  assert.ok(summary.evidenceRate > 0);
});
