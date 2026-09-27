/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/purge-soft-deleted.test.ts
 *
 * The chunked hard purge removes the same facts as the one-transaction purge,
 * a chunk per transaction with a turn between chunks, and keeps a fact that
 * was restored or pinned while it ran.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-purge-chunks-'));

const { openMemoryDb, resetMemoryDb, purgeSoftDeletedFacts, purgeSoftDeletedFactsAsync } = await import('./db.js');

const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();
const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString();

function seed(): { eligible: number[]; kept: number[] } {
  const db = openMemoryDb();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts (kind, content, content_hash, active, pinned, created_at, updated_at)
    VALUES ('project', ?, ?, ?, ?, ?, ?)
  `);
  const add = (i: number, active: number, pinned: number, at: string) =>
    Number(insert.run(`fact ${i}`, `purge-${i}`, active, pinned, at, at).lastInsertRowid);
  const eligible: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < 25; i += 1) eligible.push(add(i, 0, 0, OLD));
  for (let i = 25; i < 28; i += 1) kept.push(add(i, 0, 1, OLD));
  for (let i = 28; i < 31; i += 1) kept.push(add(i, 0, 0, RECENT));
  for (let i = 31; i < 36; i += 1) kept.push(add(i, 1, 0, OLD));
  return { eligible, kept };
}

function remainingIds(): number[] {
  return (openMemoryDb().prepare('SELECT id FROM consolidated_facts ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id);
}

beforeEach(() => { resetMemoryDb(); });

test('the chunked purge removes exactly what the one-transaction purge removes', async () => {
  seed();
  const sync = purgeSoftDeletedFacts({ minAgeDays: 180 });
  const afterSync = remainingIds();
  resetMemoryDb();
  seed();
  const chunked = await purgeSoftDeletedFactsAsync({ minAgeDays: 180, chunkSize: 10 });
  assert.equal(chunked, sync);
  assert.equal(chunked, 25);
  assert.deepEqual(remainingIds(), afterSync);
});

test('one chunk per transaction, a turn between chunks, and a fact restored or pinned mid-purge is kept', async () => {
  const { eligible } = seed();
  const db = openMemoryDb();
  const inTransactionAtTurn: boolean[] = [];
  const unitsPerSlice: number[] = [];
  let turns = 0;
  const purged = await purgeSoftDeletedFactsAsync({
    minAgeDays: 180,
    chunkSize: 10,
    hooks: {
      onSlice: (slice) => unitsPerSlice.push(slice.units),
      yieldTurn: async () => {
        inTransactionAtTurn.push(db.inTransaction);
        turns += 1;
        if (turns === 1) {
          // Between the selection and the first chunk: one fact comes back,
          // another is pinned.
          db.prepare('UPDATE consolidated_facts SET active = 1 WHERE id = ?').run(eligible[3]);
          db.prepare('UPDATE consolidated_facts SET pinned = 1 WHERE id = ?').run(eligible[17]);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
  });
  assert.equal(purged, 23);
  assert.equal(turns, 3, 'selection, then three chunks of at most ten: a turn between each');
  assert.ok(inTransactionAtTurn.every((open) => !open));
  assert.ok(unitsPerSlice.every((units) => units <= 10));
  const left = new Set(remainingIds());
  assert.ok(left.has(eligible[3]!) && left.has(eligible[17]!));
  assert.equal(eligible.filter((id) => left.has(id)).length, 2);
});
