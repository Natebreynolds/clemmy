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
const { chunkMarkdown } = await import('./indexer.js');
const { _setEmbeddingProviderForTest } = await import('./embeddings.js');
const {
  buildFtsQuery,
  getRecallStats,
  resolveTemporalMeetingDate,
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
  chunkIndex?: number;
}): void {
  const db = openMemoryDb();
  const mtime = input.mtime ?? Date.now();
  const chunkIndex = input.chunkIndex ?? 0;
  db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.path,
    chunkIndex,
    input.content,
    input.title ?? null,
    mtime,
    Buffer.byteLength(input.content, 'utf-8'),
    `${input.path}:${chunkIndex}:${mtime}:${input.content.length}`,
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
    path: '/fixture-vault/projects/recall-alpha.md',
    content: 'Clementine memory recall should find this indexed chunk immediately.',
  });
  insertChunk({
    path: '/fixture-vault/projects/noise.md',
    content: 'Calendar scheduling notes with no relevant marker.',
  });

  assert.equal(recallIndexSize(), 2, 'test fixture seeded two indexed chunks');
  const beforeStats = getRecallStats();
  const hits = recall('memory recall marker', { limit: 5 });
  const afterStats = getRecallStats();

  assert.equal(hits[0]?.filePath, '/fixture-vault/projects/recall-alpha.md');
  assert.equal(hits[0]?.title, 'recall-alpha', 'missing titles derive from the markdown path');
  assert.match(hits[0]?.snippet ?? '', /memory|recall/i);
  assert.equal(afterStats.calls, beforeStats.calls + 1);
  assert.equal(afterStats.hits, beforeStats.hits + 1);
});

test('recall pathPrefix scopes hits to the requested vault subtree', () => {
  insertChunk({
    path: '/fixture-vault/projects/deploy-plan.md',
    content: 'Deploy token for the current project lives here.',
    title: 'Project deploy plan',
  });
  insertChunk({
    path: '/fixture-vault/archive/deploy-plan.md',
    content: 'Deploy token for an archived, unrelated project lives here.',
    title: 'Archived deploy plan',
  });

  const hits = recall('deploy token project', { limit: 10, pathPrefix: '/fixture-vault/projects/' });
  assert.deepEqual(
    hits.map((h) => h.filePath),
    ['/fixture-vault/projects/deploy-plan.md'],
    'pathPrefix must prevent stale sibling vault areas from leaking into recall',
  );
});

test('recallHybrid objective rerank promotes the on-objective chunk from the FTS pool', async () => {
  insertChunk({
    path: '/fixture-vault/archive/plumbing-deploy.md',
    title: 'Old plumbing deploy',
    content: 'deploy deploy deploy plumbing archive note',
    mtime: Date.now(),
  });
  insertChunk({
    path: '/fixture-vault/projects/regulated-deploy.md',
    title: 'Regulated deploy',
    content: 'regulated client deploy checklist',
    mtime: Date.now() - 30 * 24 * 60 * 60 * 1000,
  });

  const hits = await recallHybrid('deploy', {
    limit: 1,
    objective: 'regulated client deploy',
  });

  assert.equal(
    hits[0]?.filePath,
    '/fixture-vault/projects/regulated-deploy.md',
    'objective overlap should beat a stale high-BM25 sibling chunk',
  );
});

test('relative meeting recall resolves the user timezone and ranks the exact recording first', async () => {
  const meetingPath = '/fixture-vault/04-Meetings/2026-07-14-in-person_meeting-fixture-review.md';
  insertChunk({
    path: meetingPath,
    chunkIndex: 0,
    title: null,
    content: `---
type: meeting-transcript
source: local whisper (base.en)
recording_id: FIXTURE_RECORDING_ID
title: Example Partnership Revenue and Synthetic Data Integration Review
started_at: 2026-07-14T20:00:00.000Z
ended_at: 2026-07-14T21:00:00.000Z
---`,
  });
  insertChunk({
    path: meetingPath,
    chunkIndex: 1,
    title: 'Summary',
    content: '## Summary\nSynthetic Example Organization meeting reviewing partnership revenue against fixture goals and data integration gaps.',
  });
  insertChunk({
    path: '/fixture-vault/projects/example-leadership-offsite.md',
    content: 'Today inperson meeting meeting meeting: Example Leadership Offsite at the fixture office.',
    title: 'Example Leadership Offsite',
  });
  insertChunk({
    path: '/fixture-vault/04-Meetings/2026-07-14-example-discovery.md',
    content: '---\ntype: meeting-transcript\nsource: recall.ai async transcript (canonical)\ntitle: Example Consulting Visibility Review\nstarted_at: 2026-07-14T17:00:00.000Z\n---',
    title: 'Example Consulting Visibility Review',
  });

  const nowMs = Date.parse('2026-07-15T01:23:20.713Z'); // July 14 in Los Angeles
  assert.equal(
    resolveTemporalMeetingDate('What was the inperson meeting I had today about?', { nowMs, timeZone: 'America/Los_Angeles' }),
    '2026-07-14',
  );
  assert.equal(
    resolveTemporalMeetingDate('Use local memory. Do not call any external connector. List the team saved today.', { nowMs, timeZone: 'America/Los_Angeles' }),
    null,
    'the tool-dispatch verb "call" must not turn ordinary today-memory recall into meeting-only recall',
  );
  assert.equal(
    resolveTemporalMeetingDate('What was my call today about?', { nowMs, timeZone: 'America/Los_Angeles' }),
    '2026-07-14',
    'an event-shaped call phrase remains meeting intent',
  );

  const firstQuery = recall('What was the inperson meeting I had today about?', {
    limit: 5,
    nowMs,
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(firstQuery[0]?.filePath, meetingPath, 'exact-date recording beats a calendar note with stronger repeated terms');
  assert.equal(firstQuery[0]?.title, 'Example Partnership Revenue and Synthetic Data Integration Review');
  assert.match(firstQuery[0]?.snippet ?? '', /Recorded meeting on 2026-07-14/);
  assert.match(firstQuery[0]?.snippet ?? '', /started Jul 14, 2026, 1:00 PM PDT/);
  assert.match(firstQuery[0]?.snippet ?? '', /2026-07-14T20:00:00\.000Z/);
  assert.equal(firstQuery[0]?.occurredAt, '2026-07-14T20:00:00.000Z');
  assert.equal(firstQuery[0]?.timeZone, 'America/Los_Angeles');
  assert.match(firstQuery[0]?.snippet ?? '', /partnership revenue/);

  const clarifiedQuery = await recallHybrid('I recorded a meeting today what was that', {
    limit: 5,
    nowMs,
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(clarifiedQuery[0]?.filePath, meetingPath);
  assert.match(clarifiedQuery[0]?.snippet ?? '', /data integration/);
});

function insertIndexedMarkdown(filePath: string, content: string): ReturnType<typeof chunkMarkdown> {
  const chunks = chunkMarkdown(content);
  chunks.forEach((chunk, chunkIndex) => insertChunk({
    path: filePath, chunkIndex, title: chunk.title, content: chunk.content,
  }));
  return chunks;
}

test('ambient selected metadata hydrates real title and sibling body from only the exact indexed note', async () => {
  const filePath = '/fixture-vault/Projects/selected-reference.md';
  const title = 'Acme Partnership Revenue and Legal Data Integration Review';
  const chunks = insertIndexedMarkdown(filePath, `---
lookup_ref: quasaronly482
title: "${title}"
started_at: 2026-07-14T20:24:09.442Z
---
## Decisions
Internal Acme team reviewed partnership revenue against 2026 goals and legal data integration gaps.`);
  insertIndexedMarkdown('/fixture-vault/Other/selected-reference.md', `---
title: Unrelated same-basename source
---
## Decisions
FOREIGN_BODY_MUST_NOT_BE_ATTACHED`);
  const hits = await recallHybrid('quasaronly482', { purpose: 'ambient', limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.filePath, filePath);
  assert.equal(hits[0]?.title, title);
  const indexed = openMemoryDb().prepare('SELECT id FROM vault_chunks WHERE path = ? ORDER BY chunk_index').all(filePath) as Array<{ id: number }>;
  assert.ok(hits[0]?.snippet.includes(`selected chunk ${indexed[0]!.id}, body chunk ${indexed[1]!.id}`), 'sibling bytes name their actual indexed chunk');
  assert.ok(hits[0]?.snippet.includes(chunks[1]!.content), 'the complete actual body chunk survives metadata-only selection');
  assert.match(hits[0]?.snippet ?? '', /2026-07-14T20:24:09.442Z/);
  assert.match(hits[0]?.snippet ?? '', /Indexed excerpt/);
  assert.match(hits[0]?.snippet ?? '', /reopen this source/i);
  assert.doesNotMatch(hits[0]?.snippet ?? '', /FOREIGN_BODY/);
  assert.equal(hits[0]?.occurredAt, undefined, 'generic frontmatter hydration does not infer a calendar occurrence');
});

test('ambient selected body preserves source text beyond FTS and old 240-character previews', () => {
  const filePath = '/fixture-vault/Research/source-preview.md';
  const body = `## Research\nBODY_START ${'Detailed source observations remain available. '.repeat(17)} bodyneedle739 BODY_END`;
  const chunks = insertIndexedMarkdown(filePath, body);
  assert.equal(chunks.length, 1, 'producer fixture is one complete indexed body chunk');
  const hits = recall('bodyneedle739', { purpose: 'ambient', limit: 1 });
  assert.equal(hits[0]?.filePath, filePath);
  assert.ok(hits[0]?.snippet.includes(chunks[0]!.content), 'source content is not replaced with the FTS search-match fragment');
  assert.match(hits[0]?.snippet ?? '', /BODY_START.*BODY_END/s);
});

test('metadata-only indexed note stays explicitly partial without invented body or temporal certainty', () => {
  const filePath = '/fixture-vault/Notes/capture-only.md';
  insertIndexedMarkdown(filePath, `---
lookup_ref: unopened571
title: Capture received, no content transcribed
recorded_date: 2026-07-14
---`);
  const hits = recall('unopened571', { purpose: 'ambient', limit: 1 });
  assert.equal(hits[0]?.title, 'Capture received, no content transcribed');
  assert.match(hits[0]?.snippet ?? '', /recorded_date: 2026-07-14/);
  assert.match(hits[0]?.snippet ?? '', /Indexed excerpt/);
  assert.doesNotMatch(hits[0]?.snippet ?? '', /partnership revenue|2026-07-15/);
  assert.equal(hits[0]?.occurredAt, undefined);
});

test('malformed indexed metadata remains verbatim and cannot fabricate a parsed title', () => {
  const filePath = '/fixture-vault/Notes/broken-metadata.md';
  const content = '---\ntitle: [broken\nlookup_ref: malformed802\n---';
  insertChunk({ path: filePath, content });
  const hits = recall('malformed802', { purpose: 'ambient', limit: 1 });
  assert.equal(hits[0]?.title, 'broken-metadata');
  assert.ok(hits[0]?.snippet.includes(content));
  assert.equal(hits[0]?.occurredAt, undefined);
});

test('async rerank cannot attach reindexed sibling content to an older selected chunk', async () => {
  const filePath = '/fixture-vault/Notes/reindexed-source.md';
  const oldMetadata = '---\nlookup_ref: snapshotprobe485\ntitle: Original selected title\n---';
  insertChunk({ path: filePath, chunkIndex: 0, content: oldMetadata, mtime: 1_000 });
  insertChunk({ path: filePath, chunkIndex: 1, title: 'Body', content: 'Original indexed body.', mtime: 1_000 });
  const db = openMemoryDb();
  const row = db.prepare('SELECT id FROM vault_chunks WHERE path = ? AND chunk_index = 0').get(filePath) as { id: number };
  db.prepare('INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, 'preview-snapshot-v1', 2, Buffer.from(new Float32Array([1, 0]).buffer), '2026-07-14T00:00:00Z');
  let embeddings = 0;
  _setEmbeddingProviderForTest({
    name: 'preview-snapshot', model: 'preview-snapshot-v1', dim: 2,
    async embed(texts) {
      embeddings += 1;
      db.prepare('UPDATE vault_chunks SET content = ?, mtime = ? WHERE path = ? AND chunk_index = 0')
        .run('---\nlookup_ref: snapshotprobe485\ntitle: NEW_VERSION_TITLE\n---', 2_000, filePath);
      db.prepare('UPDATE vault_chunks SET content = ?, mtime = ? WHERE path = ? AND chunk_index = 1')
        .run('NEW_VERSION_BODY', 2_000, filePath);
      return texts.map(() => new Float32Array([1, 0]));
    },
  });
  try {
    const hits = await recallHybrid('snapshotprobe485', { purpose: 'ambient', limit: 1 });
    assert.ok(embeddings > 0, 'actual async rerank crossed the injected embedding boundary');
    assert.equal(hits[0]?.filePath, filePath);
    assert.ok(hits[0]?.snippet.includes(oldMetadata), 'old selected bytes remain truthful instead of being replaced by a newer index version');
    assert.match(hits[0]?.snippet ?? '', /sibling context unavailable/);
    assert.doesNotMatch(hits[0]?.snippet ?? '', /NEW_VERSION/);
  } finally {
    _setEmbeddingProviderForTest(undefined);
  }
});

test('an incomplete frontmatter chunk is source text, not a fully parsed note identity', () => {
  const filePath = '/fixture-vault/Notes/incomplete-metadata.md';
  const content = '---\ntitle: Unclosed proposed title\nlookup_ref: incomplete694';
  insertChunk({ path: filePath, content });
  const hits = recall('incomplete694', { purpose: 'ambient', limit: 1 });
  assert.equal(hits[0]?.title, 'incomplete-metadata');
  assert.ok(hits[0]?.snippet.includes(content));
  assert.equal(hits[0]?.occurredAt, undefined);
});
