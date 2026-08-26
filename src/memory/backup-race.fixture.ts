import Database from 'better-sqlite3';
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import {
  MEMORY_BACKUP_COORDINATOR_PATH,
  backupMemoryDb,
  closeMemoryDb,
  openMemoryDb,
} from './db.js';

const mode = process.argv[2];

if (mode === 'init') {
  const db = openMemoryDb();
  db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       derivation_depth, pinned, access_count, impression_count, utility_count)
    VALUES
      ('user', 'Cross-process backup fixture fact.', 'backup-race-fixture', 1, 1,
       datetime('now'), datetime('now'), 0, 0, 0, 0, 0)
  `).run();
  closeMemoryDb();
  process.stdout.write(`${JSON.stringify({ initialized: true })}\n`);
} else if (mode === 'backup') {
  const localDayKey = process.argv[3];
  const retain = Number(process.argv[4] ?? '7');
  const result = backupMemoryDb({ retain, localDayKey });
  closeMemoryDb();
  process.stdout.write(`${JSON.stringify({ pid: process.pid, result })}\n`);
} else if (mode === 'backup-unkeyed') {
  const retain = Number(process.argv[3] ?? '7');
  const result = backupMemoryDb({ retain });
  closeMemoryDb();
  process.stdout.write(`${JSON.stringify({ pid: process.pid, result })}\n`);
} else if (mode === 'hold-coordinator') {
  mkdirSync(path.dirname(MEMORY_BACKUP_COORDINATOR_PATH), { recursive: true });
  const coordinator = new Database(MEMORY_BACKUP_COORDINATOR_PATH);
  coordinator.pragma('busy_timeout = 300000');
  coordinator.exec('BEGIN IMMEDIATE');
  process.stdout.write('COORDINATOR_LOCKED\n');
  // Keep both the event loop and the exact handle/transaction alive until the
  // parent delivers SIGKILL.
  setInterval(() => { void coordinator.open; }, 1_000);
} else if (mode === 'publish-uncommitted') {
  const localDayKey = process.argv[3];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDayKey ?? '')) {
    throw new Error('publish-uncommitted requires a local day key');
  }
  mkdirSync(path.dirname(MEMORY_BACKUP_COORDINATOR_PATH), { recursive: true });
  const coordinator = new Database(MEMORY_BACKUP_COORDINATOR_PATH);
  coordinator.pragma('busy_timeout = 300000');
  coordinator.exec('BEGIN IMMEDIATE');
  const backupPath = path.join(path.dirname(MEMORY_BACKUP_COORDINATOR_PATH), `memory-${localDayKey}-nightly.db`);
  const partialPath = `${backupPath}.partial-${process.pid}-crash-fixture`;
  const source = openMemoryDb();
  source.exec(`VACUUM INTO '${partialPath.replace(/'/g, "''")}'`);
  renameSync(partialPath, backupPath);
  process.stdout.write(`PUBLISHED_UNCOMMITTED:${backupPath}\n`);
  // Exact crash window under test: final rename is visible, but the keyed
  // publication row/transaction has not committed.
  setInterval(() => { void coordinator.open; void source.open; }, 1_000);
} else {
  throw new Error(`unknown memory backup race fixture mode: ${mode ?? '<missing>'}`);
}
