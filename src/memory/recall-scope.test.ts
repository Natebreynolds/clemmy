/**
 * Run: npx tsx --test src/memory/recall-scope.test.ts
 *
 * P1 — unified recall scope. Verifies the recency + objective nudges in
 * recallHybrid: a freshly-referenced item edges out a stale one with a
 * stronger lexical match, while the DEFAULT path (no scope options) is
 * unchanged BM25/RRF ordering (the regression guard).
 *
 * FTS-only path is exercised (no OPENAI_API_KEY) so there's no network.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-recall-scope-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_API_KEY;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { recallHybrid } = await import('./recall.js');
const { openMemoryDb } = await import('./db.js');

const now = Date.now();
const DAY = 86_400_000;

// Seed two competing chunks directly (the AFTER INSERT trigger populates the
// FTS mirror). The OLD doc is the STRONGER lexical match (term repeated), but
// it is 200 days old; the NEW doc matches once and is 1 day old.
const db = openMemoryDb();
const insert = db.prepare(
  'INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash) VALUES (?,?,?,?,?,?,?)',
);
insert.run('/vault/old-list.md', 0, 'acme outreach list acme outreach list acme outreach campaign', 'Old Acme Outreach List', now - 200 * DAY, 200, 'hash-old');
insert.run('/vault/new-list.md', 0, 'acme outreach list', 'New Acme Outreach List', now - 1 * DAY, 50, 'hash-new');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('default path (no scope options) keeps the stronger-BM25 (old) doc first', async () => {
  const hits = await recallHybrid('acme outreach list', { limit: 5 });
  assert.ok(hits.length >= 2, 'both docs recalled');
  assert.match(hits[0].title, /Old/i, 'no scope → strongest lexical match leads (BM25 unchanged)');
});

test('recency nudge floats the recent doc above a stronger-but-stale match', async () => {
  const hits = await recallHybrid('acme outreach list', { limit: 5, recencyHalfLifeDays: 14 });
  assert.ok(hits.length >= 2);
  assert.match(hits[0].title, /New/i, 'recent doc wins with recency scope on');
});

test('objective overlap also floats the on-objective recent doc', async () => {
  const hits = await recallHybrid('acme outreach list', { limit: 5, objective: 'new acme outreach', recencyHalfLifeDays: 30 });
  assert.match(hits[0].title, /New/i);
});
