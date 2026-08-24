#!/usr/bin/env node
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, WEBHOOK_SECRET_IS_STRONG } from '../config.js';
import { requireHarnessSchemaReady } from '../runtime/build-info.js';
import { CUTOVER_HOLD, requireValidCutoverHoldConfiguration } from '../runtime/cutover-hold.js';
import { applyHarnessMigrations } from '../runtime/harness/eventlog-schema.js';
import { readDaemonPid } from './process.js';

if (!CUTOVER_HOLD) throw new Error('cutover-hold-migrate requires CLEMMY_CUTOVER_HOLD=on at process start.');
requireValidCutoverHoldConfiguration();
if (!WEBHOOK_SECRET_IS_STRONG) {
  throw new Error('cutover-hold-migrate requires the held parent\'s strong WEBHOOK_SECRET.');
}
const expectedParentPid = Number.parseInt(process.env.CLEMMY_CUTOVER_MIGRATION_PARENT_PID ?? '', 10);
if (
  !Number.isSafeInteger(expectedParentPid)
  || expectedParentPid <= 0
  || process.ppid !== expectedParentPid
  || readDaemonPid() !== expectedParentPid
) {
  throw new Error('cutover-hold-migrate requires the live parent that owns the singleton daemon lease.');
}

// Keep the complete runtime event-log graph out of both the long-lived held
// process and this short-lived migration child. This child loads only the
// schema authority, applies it with the same SQLite pragmas as openEventLog,
// closes the write handle, and exits before authenticated ingress opens.
const stateDir = path.join(BASE_DIR, 'state');
const databasePath = path.join(stateDir, 'harness.db');
mkdirSync(stateDir, { recursive: true });

let db: Database.Database | null = null;
try {
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyHarnessMigrations(db);
} finally {
  db?.close();
}

requireHarnessSchemaReady();
