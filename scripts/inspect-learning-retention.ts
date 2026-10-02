#!/usr/bin/env tsx
/** Explicit-path, read-only backlog inspection. This never opens the harness
 * stores through their migrating runtime APIs or grants deletion authority. */
import Database from 'better-sqlite3';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { inspectLearningRetentionInventory } from '../src/memory/learning-retention-inventory.js';

let db: Database.Database | undefined;
try {
  const allowed = new Set(['--db', '--after-rowid', '--max-batches', '--max-rows-per-batch', '--max-duration-ms']);
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]!;
    const value = process.argv[i + 1];
    if (!allowed.has(name) || args.has(name) || !value || value.startsWith('--')) throw new Error('invalid arguments');
    args.set(name, value);
  }
  if (!args.has('--db')) {
    console.error('Usage: npx tsx scripts/inspect-learning-retention.ts --db /path/to/memory.db [--after-rowid N] [--max-batches N] [--max-rows-per-batch N] [--max-duration-ms N]');
    process.exitCode = 2;
  } else {
    const file = path.resolve(args.get('--db')!);
    const before = lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || realpathSync(file) !== file) throw new Error('unsafe database identity');
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 50 });
    db.pragma('query_only = ON');
    const numeric = (name: string) => args.has(name) ? Number(args.get(name)) : undefined;
    const report = inspectLearningRetentionInventory(db, {
      afterRowid: numeric('--after-rowid'), maxBatches: numeric('--max-batches'),
      maxRowsPerBatch: numeric('--max-rows-per-batch'), maxDurationMs: numeric('--max-duration-ms'),
    });
    const after = lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || realpathSync(file) !== file) {
      throw new Error('database identity changed');
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.state === 'unavailable') process.exitCode = 1;
  }
} catch {
  // Private paths, SQL and source contents never become diagnostics.
  console.error('Learning retention inspection unavailable. Check the explicit database path, read access and budgets. No retention writes were issued.');
  process.exitCode = 2;
} finally { db?.close(); }
