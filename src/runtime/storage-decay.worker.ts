/** This worker never imports config/eventlog: it cannot migrate a live store,
 * load credentials, run models, execute a task or publish a recovered write.
 * It sheds what has aged out — a retired turn's working records and the
 * diagnostic rows of the event log — on its own connection, so the daemon's
 * loop never waits behind a delete. */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { HARNESS_SCHEMA_VERSION } from './harness/schema-version.js';
import { decayRetiredTurnWorkRecords, type RetiredWorkRecordDecay } from './harness/retired-work-records.js';
import { reapStaleDiagnosticEvents, type DiagnosticEventRetentionResult } from './harness/diagnostic-event-retention.js';

export interface StorageDecayWorkerData { dbPath: string; budgetMs: number; diagnosticRows: number }
export type StorageDecayWorkerResult = { state: 'processed'; decay: RetiredWorkRecordDecay; diagnostics: DiagnosticEventRetentionResult }
  | { state: 'deferred'; reason: 'writer_busy' | 'schema_unready' }
  | { state: 'unavailable'; error?: string };

let db: Database.Database | undefined;
let response: StorageDecayWorkerResult;
try {
  const data = workerData as StorageDecayWorkerData;
  db = new Database(data.dbPath, { fileMustExist: true, timeout: 1 });
  db.pragma('foreign_keys = ON');
  const schema = db.prepare('SELECT MIN(version) AS min, MAX(version) AS max, COUNT(*) AS count FROM schema_version').get() as {
    min: number; max: number; count: number;
  };
  if (schema.min !== 1 || schema.max !== HARNESS_SCHEMA_VERSION || schema.count !== HARNESS_SCHEMA_VERSION) {
    response = { state: 'deferred', reason: 'schema_unready' };
  } else {
    const decay = decayRetiredTurnWorkRecords(db, { budgetMs: data.budgetMs });
    const diagnostics = reapStaleDiagnosticEvents(db, { maxRows: data.diagnosticRows });
    response = { state: 'processed', decay, diagnostics };
  }
} catch (error) {
  response = (error as { code?: string }).code === 'SQLITE_BUSY' ? { state: 'deferred', reason: 'writer_busy' }
    : { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
} finally { try { db?.close(); } catch { /* exit releases the connection */ } }
parentPort?.postMessage(response);
