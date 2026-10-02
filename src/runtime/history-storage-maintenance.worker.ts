/** This worker never imports config/eventlog: it cannot migrate a live store,
 * load credentials, run models, execute a task or publish a recovered write. */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { HARNESS_SCHEMA_VERSION } from './harness/schema-version.js';
import { registerAcceptedModelHistoryReader } from './harness/accepted-model-history-store.js';
import { convertAcceptedModelHistoryBatch, inspectAcceptedModelHistoryConversion,
  type HistoryConversionLane, type HistoryConversionResult } from './harness/accepted-model-history-conversion.js';

export interface HistoryStorageWorkerData { dbPath: string }
export type HistoryStorageWorkerResult = { state: 'processed'; result: HistoryConversionResult }
  | { state: 'deferred'; reason: 'work_active' | 'writer_busy' | 'schema_unready' }
  | { state: 'caught_up' | 'blocked' | 'unavailable' };

let db: Database.Database | undefined;
let response: HistoryStorageWorkerResult;
try {
  db = new Database((workerData as HistoryStorageWorkerData).dbPath, { fileMustExist: true, timeout: 1 });
  db.pragma('foreign_keys = ON');
  const schema = db.prepare('SELECT MIN(version) AS min, MAX(version) AS max, COUNT(*) AS count FROM schema_version').get() as {
    min: number; max: number; count: number;
  };
  if (schema.min !== 1 || schema.max !== HARNESS_SCHEMA_VERSION || schema.count !== HARNESS_SCHEMA_VERSION) {
    response = { state: 'deferred', reason: 'schema_unready' };
  } else if (db.prepare('SELECT 1 FROM run_attempts WHERE finished_at IS NULL LIMIT 1').get()) {
    response = { state: 'deferred', reason: 'work_active' };
  } else {
    registerAcceptedModelHistoryReader(db);
    const lanes = db.prepare(`SELECT lane, state FROM accepted_model_history_conversion_v1 ORDER BY updated_at, lane`).all() as
      Array<{ lane: HistoryConversionLane; state: string }>;
    if (lanes.length !== 3 || new Set(lanes.map(row => row.lane)).size !== 3
      || lanes.some(row => !['admission_pre', 'admission_frame', 'checkpoint'].includes(row.lane))) throw new Error('conversion lanes unavailable');
    response = { state: lanes.some(row => row.state === 'blocked') ? 'blocked' : 'caught_up' };
    for (const row of lanes) {
      if (row.state === 'blocked') continue; // preserve damaged proof and let other lanes progress
      const pending = inspectAcceptedModelHistoryConversion(db, row.lane, 1);
      if (pending.sampledRows === 0) continue;
      const result = convertAcceptedModelHistoryBatch(db, { lane: row.lane, maxRows: 16,
        maxInputBytes: Math.min(32 * 1024 * 1024, Math.max(2 * 1024 * 1024, pending.largestInlineBytes)), maxDurationMs: 50,
        shouldContinue: () => !db!.prepare('SELECT 1 FROM run_attempts WHERE finished_at IS NULL LIMIT 1').get() });
      response = result.state === 'deferred' && result.scanned === 0 ? { state: 'deferred', reason: 'work_active' }
        : { state: 'processed', result };
      break;
    }
  }
} catch (error) {
  response = (error as { code?: string }).code === 'SQLITE_BUSY' ? { state: 'deferred', reason: 'writer_busy' } : { state: 'unavailable' };
} finally { try { db?.close(); } catch { /* exit releases the connection */ } }
parentPort?.postMessage(response);
