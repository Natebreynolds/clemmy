/**
 * Regression pin: two PROCESSES opening the same fresh database must not crash
 * each other while migrating.
 *
 * Observed live in the isolated test suite (2026-07-30): several test files
 * share one CLEMENTINE_HOME, two of them opened the same fresh memory.db at the
 * same moment, both read schema_version as empty, both applied the same
 * migration, and the loser threw
 *   SqliteError: UNIQUE constraint failed: schema_version.version
 * from an async continuation — which the runner surfaced as an uncaughtException
 * and a whole test FILE failing with no failing assertion inside it.
 *
 * The same shape is reachable in production whenever the daemon and a CLI
 * command open a fresh database concurrently, so this is a real durability fix,
 * not test-only hygiene.
 *
 * HONEST SCOPE — this is a concurrency SMOKE test, not a strict pin. The race
 * window is narrow: SQLite's write locking usually serializes the racers enough
 * that the leader commits before the others read schema_version, so this file
 * passes with the fix reverted too (verified — as does any in-process version,
 * where the first migration always commits first). It proves concurrent
 * migration SUCCEEDS and leaves a correct database; it cannot prove the
 * original crash is impossible. The fix it guards is defense-in-depth:
 * recording a schema version another writer already recorded is a no-op, so the
 * loser of the race can no longer die on a UNIQUE constraint.
 *
 * Run: npx tsx --test src/memory/db-concurrent-migration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { MEMORY_SCHEMA_VERSION } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

/** Racers all block on the same start time, then migrate the same file at once. */
const RACER_SRC = `
import Database from ${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'lib', 'index.js'))};
import { migrateMemoryDatabaseHandle } from ${JSON.stringify(path.join(here, 'db.ts'))};
const [file, startAtMs] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < startAtMs) { /* spin to a shared start instant */ }
const db = new Database(file);
try {
  migrateMemoryDatabaseHandle(db);
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err));
  process.exit(1);
} finally {
  try { db.close(); } catch {}
}
`;

test('concurrent processes migrating one fresh database all succeed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-concurrent-migrate-'));
  try {
    const racerPath = path.join(dir, 'racer.mts');
    writeFileSync(racerPath, RACER_SRC, 'utf8');
    const file = path.join(dir, 'memory.db');

    // Stagger-free start: every child spins until the same instant, so they
    // read schema_version in the same window — the actual production race.
    const startAt = Date.now() + 4_000;
    const racers = Array.from({ length: 4 }, () =>
      spawnSync(tsxBin, [racerPath, file, String(startAt)], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
      }));

    const failures = racers
      .map((r, i) => ({ i, status: r.status, stderr: (r.stderr ?? '').trim().slice(0, 300) }))
      .filter((r) => r.status !== 0);

    assert.deepEqual(
      failures,
      [],
      `every concurrent migrator must succeed; before the fix the losers threw `
      + `"UNIQUE constraint failed: schema_version.version"`,
    );

    // And the database is left correct: fully migrated, one row per version.
    const db = new Database(file, { readonly: true });
    try {
      const duplicates = db
        .prepare('SELECT version, COUNT(*) AS n FROM schema_version GROUP BY version HAVING n > 1')
        .all() as Array<{ version: number; n: number }>;
      assert.deepEqual(duplicates, [], 'a version must never be recorded twice');

      const current = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
      assert.equal(current, MEMORY_SCHEMA_VERSION, 'the database ends up fully migrated');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
