/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-db npx tsx --test src/memory/db.test.ts
 *
 * Tier C durability surface: memory.db backup (VACUUM INTO + retention) and
 * the episodic_pointers TTL reaper.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TEST_HOME = '/tmp/clemmy-test-db';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  resetMemoryDb,
  openMemoryDb,
  backupMemoryDb,
  reapStaleEpisodicPointers,
  MEMORY_BACKUP_DIR,
} = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
  rmSync(MEMORY_BACKUP_DIR, { recursive: true, force: true });
});

test('backupMemoryDb writes a consistent snapshot containing the facts', () => {
  rememberFact({ kind: 'user', content: 'Nathan prefers concise replies.' });
  const result = backupMemoryDb({ retain: 7 });
  assert.ok(result, 'backup returns a result');
  assert.ok(existsSync(result!.backupPath), 'backup file exists on disk');
  assert.ok(result!.bytes > 0, 'backup has non-zero size');

  // The snapshot is a real SQLite db with the fact in it.
  const snap = new Database(result!.backupPath, { readonly: true });
  const row = snap.prepare('SELECT COUNT(*) AS c FROM consolidated_facts').get() as { c: number };
  snap.close();
  assert.equal(row.c, 1, 'backed-up db contains the fact');
});

test('backupMemoryDb retains only the newest N snapshots', () => {
  // Seed three OLD fake snapshots (lexicographically earlier ISO stamps).
  if (!existsSync(MEMORY_BACKUP_DIR)) mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
  for (const stamp of ['2020-01-01T00-00-00-000Z', '2020-02-01T00-00-00-000Z', '2020-03-01T00-00-00-000Z']) {
    writeFileSync(path.join(MEMORY_BACKUP_DIR, `memory-${stamp}.db`), 'stale');
  }
  rememberFact({ kind: 'project', content: 'Backup retention check.' });

  const result = backupMemoryDb({ retain: 2 });
  assert.ok(result, 'backup succeeded');

  const remaining = readdirSync(MEMORY_BACKUP_DIR).filter((f) => f.startsWith('memory-') && f.endsWith('.db')).sort();
  assert.equal(remaining.length, 2, 'pruned to the newest 2 snapshots');
  // The fresh (real) backup is the newest, so it must survive.
  assert.ok(remaining.includes(path.basename(result!.backupPath)), 'the just-written backup survives pruning');
  // The oldest fakes are gone.
  assert.ok(!remaining.includes('memory-2020-01-01T00-00-00-000Z.db'), 'oldest snapshot pruned');
});

test('reapStaleEpisodicPointers drops pointers past the TTL but keeps fresh ones', () => {
  const db = openMemoryDb();
  const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60d ago
  const freshIso = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO episodic_pointers (session_id, call_id, label, tool, source_uri, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('s1', 'c-old', 'the old convo', 'outlook', 'outlook:thread:old', oldIso);
  insert.run('s2', 'c-new', 'the recent convo', 'outlook', 'outlook:thread:new', freshIso);

  const deleted = reapStaleEpisodicPointers({ maxAgeDays: 30 });
  assert.equal(deleted, 1, 'exactly the stale pointer is reaped');

  const remaining = db.prepare('SELECT call_id FROM episodic_pointers').all() as { call_id: string }[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].call_id, 'c-new', 'the fresh pointer survives');
});
