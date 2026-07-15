/**
 * Run: npx tsx --test src/memory/memory-import.test.ts
 *
 * Isolated temp CLEMENTINE_HOME — never touches the real memory store.
 * The LLM distiller is not exercised here (distill:false); these tests pin
 * the deterministic pipeline: scan bounds, frontmatter parse, kind mapping,
 * fallback harvest, dedup accounting, and batch undo.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-memory-import';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { listActiveFacts } = await import('./facts.js');
// eslint-disable-next-line import/first
const { getFactEvidence } = await import('./temporal-memory.js');
// eslint-disable-next-line import/first
const {
  scanMemorySource,
  ingestMemorySource,
  listMemoryImportBatches,
  undoMemoryImportBatch,
  _testOnly_sanitizeDistillerOutput,
} = await import('./memory-import.js');

const SRC = path.join(TEST_HOME, 'foreign-memory');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  resetMemoryDb();

  // Structured (Claude-Code-style) memory file.
  writeFileSync(path.join(SRC, 'user_jane.md'), [
    '---',
    'name: user-jane',
    'description: Jane is a solo family-law attorney in Austin who prefers weekly summaries.',
    'metadata:',
    '  type: user',
    '---',
    '',
    'Short body.',
  ].join('\n'));

  // Freeform memory.md with bullets (fallback harvest path).
  writeFileSync(path.join(SRC, 'memory.md'), [
    '# Agent memory',
    '- The production database is Postgres 16 on Railway; never run destructive migrations without a backup.',
    '- Deploys happen from the main branch only, via GitHub Actions.',
    'noise',
  ].join('\n'));

  // Unsupported + oversized files must be skipped.
  writeFileSync(path.join(SRC, 'binary.png'), 'not-really-a-png');
  writeFileSync(path.join(SRC, 'huge.md'), 'x'.repeat(600 * 1024));
});

test('scanMemorySource: finds importable files, classifies shape, skips unsupported/oversized', () => {
  const scan = scanMemorySource(SRC);
  const names = scan.files.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['memory.md', 'user_jane.md']);
  const jane = scan.files.find((f) => f.path.endsWith('user_jane.md'))!;
  assert.equal(jane.shape, 'structured_md');
  assert.match(jane.preview, /family-law attorney/);
  assert.equal(scan.files.find((f) => f.path.endsWith('memory.md'))!.shape, 'freeform');
  const skippedReasons = scan.skipped.map((s) => `${path.basename(s.path)}:${s.reason}`).join(' | ');
  assert.match(skippedReasons, /binary\.png:unsupported/);
  assert.match(skippedReasons, /huge\.md:too large/);
});

test('ingestMemorySource (distill off): structured description → typed fact; freeform bullets → reference facts; batch is undoable', async () => {
  const batch = await ingestMemorySource(SRC, { sourceLabel: 'test-foreign', distill: false });
  assert.equal(batch.errors.length, 0);
  assert.equal(batch.fileCount, 2);
  assert.ok(batch.newFactIds.length >= 3, `expected ≥3 new facts, got ${batch.newFactIds.length}`);

  const facts = listActiveFacts({ limit: 50 });
  const imported = facts.filter((f) => f.sourceApp === 'import:test-foreign');
  assert.equal(imported.length, batch.newFactIds.length);
  const jane = imported.find((f) => /family-law attorney/.test(f.content))!;
  assert.equal(jane.kind, 'user', 'frontmatter metadata type: user must map to kind user');
  assert.match(jane.content, /^\[user-jane\]/, 'headline fact carries the source name');
  assert.ok(imported.some((f) => /Postgres 16 on Railway/.test(f.content)), 'bullet harvested from freeform file');
  assert.ok(!imported.some((f) => f.content === 'noise'), 'short noise lines are not facts');

  const janeEvidence = getFactEvidence(jane.id);
  assert.ok(janeEvidence.length > 0, 'imported fact must retain durable source evidence');
  assert.ok(janeEvidence.every((item) => item.status === 'available'));
  assert.ok(janeEvidence.some((item) => item.excerpt.includes('Jane is a solo family-law attorney in Austin')));
  assert.ok(janeEvidence.every((item) => item.sourceUri === path.join(SRC, 'user_jane.md')));
  assert.ok(
    janeEvidence.every((item) => !item.excerpt.includes('[user-jane]')),
    'evidence must be copied from the source file, not synthesized from the normalized claim',
  );

  const postgres = imported.find((f) => /Postgres 16 on Railway/.test(f.content))!;
  const postgresEvidence = getFactEvidence(postgres.id);
  assert.ok(postgresEvidence.some((item) => item.excerpt.includes('The production database is Postgres 16 on Railway')));

  // Re-ingest: content-hash idempotency → zero NEW facts, all deduped.
  const again = await ingestMemorySource(SRC, { sourceLabel: 'test-foreign', distill: false });
  assert.equal(again.newFactIds.length, 0, 're-import must not duplicate facts');
  assert.ok(again.dedupedCount >= batch.newFactIds.length);

  // Undo removes exactly the first batch's facts (the re-import batch owns none).
  const batches = listMemoryImportBatches();
  assert.ok(batches.some((b) => b.id === batch.id));
  const undone = undoMemoryImportBatch(batch.id);
  assert.equal(undone.deleted, batch.newFactIds.length);
  const after = listActiveFacts({ limit: 50 }).filter((f) => f.sourceApp === 'import:test-foreign');
  assert.equal(after.length, 0, 'undo must remove all imported facts');
});

test('distiller sanitizer preserves facts from schema-drifted JSON', () => {
  const facts = _testOnly_sanitizeDistillerOutput('```json\n' + JSON.stringify({
    facts: [
      { type: 'preference', fact: 'Jane prefers weekly executive summaries.', importance: '9' },
      { category: 'policy', text: 'Never run destructive migrations without an approved backup.', score: '11' },
      { kind: 'reference', content: 'short' },
    ],
  }) + '\n```');
  assert.equal(facts?.length, 2);
  assert.deepEqual(facts?.map((f) => f.kind), ['user', 'constraint']);
  assert.deepEqual(facts?.map((f) => f.importance), [9, 10]);
  assert.match(facts?.[0].content ?? '', /weekly executive summaries/);

  assert.deepEqual(_testOnly_sanitizeDistillerOutput('{"facts":null}'), []);
  assert.deepEqual(_testOnly_sanitizeDistillerOutput('[{"summary":"Top-level array fact survives.","importance":4}]'), [
    { kind: 'reference', content: 'Top-level array fact survives.', importance: 4 },
  ]);
});

test('scanMemorySource: nonexistent path degrades to a skip, single file works', () => {
  const missing = scanMemorySource('/tmp/definitely-not-a-real-memory-dir-xyz');
  assert.equal(missing.files.length, 0);
  assert.match(missing.skipped[0].reason, /does not exist/);
  const single = scanMemorySource(path.join(SRC, 'memory.md'));
  assert.equal(single.files.length, 1);
});
