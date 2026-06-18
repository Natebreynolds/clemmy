/**
 * Run: npx tsx --test src/memory/recall.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recall';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.EMBEDDINGS_DISABLED = 'true';

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const {
  buildFtsQuery,
  getRecallStats,
  recall,
  recallHybrid,
  recallIndexSize,
} = await import('./recall.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

function insertChunk(input: {
  path: string;
  content: string;
  title?: string | null;
  mtime?: number;
}): void {
  const db = openMemoryDb();
  const mtime = input.mtime ?? Date.now();
  db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, ?, ?, ?, ?)
  `).run(
    input.path,
    input.content,
    input.title ?? null,
    mtime,
    Buffer.byteLength(input.content, 'utf-8'),
    `${input.path}:${mtime}:${input.content.length}`,
  );
}

test('builds OR-clause from multi-token query', () => {
  const fts = buildFtsQuery('memory recall architecture');
  // Each token should appear quoted and with prefix variant.
  assert.match(fts, /"memory"/);
  assert.match(fts, /memory\*/);
  assert.match(fts, /"recall"/);
  assert.match(fts, /recall\*/);
  assert.match(fts, /"architecture"/);
  assert.match(fts, /architecture\*/);
  // Clauses joined by OR.
  assert.match(fts, / OR /);
});

test('returns empty string for empty / single-char input', () => {
  assert.equal(buildFtsQuery(''), '');
  assert.equal(buildFtsQuery('a'), '');
  assert.equal(buildFtsQuery('   '), '');
});

test('dedups repeated tokens', () => {
  const fts = buildFtsQuery('clemmy clemmy clemmy');
  // Should appear at most once each in quoted and prefix forms.
  const quoted = (fts.match(/"clemmy"/g) ?? []).length;
  const prefix = (fts.match(/clemmy\*/g) ?? []).length;
  assert.equal(quoted, 1, 'quoted clemmy should appear once');
  assert.equal(prefix, 1, 'prefix clemmy should appear once');
});

test('strips FTS5-reserved characters from tokens', () => {
  // FTS5 syntax chars in input — we tokenize on non-alphanumerics so they vanish.
  const fts = buildFtsQuery('memory "fts" * (recall)');
  // Output should not include raw quote/paren/asterisk-as-syntax in dangerous places.
  // The tokenizer keeps memory, fts, recall.
  assert.match(fts, /"memory"/);
  assert.match(fts, /"fts"/);
  assert.match(fts, /"recall"/);
  // No bare parens or unmatched quotes.
  assert.equal(fts.split('"').length % 2, 1, 'balanced quote count');
});

test('lower-cases input tokens', () => {
  const fts = buildFtsQuery('MEMORY Recall ARCHITECTURE');
  assert.match(fts, /"memory"/);
  assert.match(fts, /"recall"/);
  assert.match(fts, /"architecture"/);
  assert.doesNotMatch(fts, /"MEMORY"/);
});

test('drops tokens shorter than 2 chars', () => {
  const fts = buildFtsQuery('a bb ccc');
  assert.doesNotMatch(fts, /"a"/);
  assert.match(fts, /"bb"/);
  assert.match(fts, /"ccc"/);
});

test('handles underscores in tokens (e.g. snake_case identifiers)', () => {
  const fts = buildFtsQuery('memory_search user_id');
  // Underscores survive the non-alphanumeric split because we allow [a-z0-9_].
  assert.match(fts, /"memory_search"/);
  assert.match(fts, /"user_id"/);
});

test('recall searches real indexed vault chunks and records hit telemetry', () => {
  insertChunk({
    path: '/vault/projects/recall-alpha.md',
    content: 'Clementine memory recall should find this indexed chunk immediately.',
  });
  insertChunk({
    path: '/vault/projects/noise.md',
    content: 'Calendar scheduling notes with no relevant marker.',
  });

  assert.equal(recallIndexSize(), 2, 'test fixture seeded two indexed chunks');
  const beforeStats = getRecallStats();
  const hits = recall('memory recall marker', { limit: 5 });
  const afterStats = getRecallStats();

  assert.equal(hits[0]?.filePath, '/vault/projects/recall-alpha.md');
  assert.equal(hits[0]?.title, 'recall-alpha', 'missing titles derive from the markdown path');
  assert.match(hits[0]?.snippet ?? '', /memory|recall/i);
  assert.equal(afterStats.calls, beforeStats.calls + 1);
  assert.equal(afterStats.hits, beforeStats.hits + 1);
});

test('recall pathPrefix scopes hits to the requested vault subtree', () => {
  insertChunk({
    path: '/vault/projects/deploy-plan.md',
    content: 'Deploy token for the current project lives here.',
    title: 'Project deploy plan',
  });
  insertChunk({
    path: '/vault/archive/deploy-plan.md',
    content: 'Deploy token for an archived, unrelated project lives here.',
    title: 'Archived deploy plan',
  });

  const hits = recall('deploy token project', { limit: 10, pathPrefix: '/vault/projects/' });
  assert.deepEqual(
    hits.map((h) => h.filePath),
    ['/vault/projects/deploy-plan.md'],
    'pathPrefix must prevent stale sibling vault areas from leaking into recall',
  );
});

test('recallHybrid objective rerank promotes the on-objective chunk from the FTS pool', async () => {
  insertChunk({
    path: '/vault/archive/plumbing-deploy.md',
    title: 'Old plumbing deploy',
    content: 'deploy deploy deploy plumbing archive note',
    mtime: Date.now(),
  });
  insertChunk({
    path: '/vault/projects/legal-deploy.md',
    title: 'Legal deploy',
    content: 'legal client deploy checklist',
    mtime: Date.now() - 30 * 24 * 60 * 60 * 1000,
  });

  const hits = await recallHybrid('deploy', {
    limit: 1,
    objective: 'legal client deploy',
  });

  assert.equal(
    hits[0]?.filePath,
    '/vault/projects/legal-deploy.md',
    'objective overlap should beat a stale high-BM25 sibling chunk',
  );
});
