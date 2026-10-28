/** This worker never imports config, telemetry or the event log: it cannot
 * read a kill-switch, record an event or run a model. It rebuilds the route
 * policy table from the outcome window on its own connection, so the daemon's
 * loop never waits behind the window's rows. */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { rebuildRoutePolicyTable, type RoutePolicyRebuild } from '../model-route-scoring.js';

export interface RoutePolicyWorkerData { dbPath: string; cutoff: string; minSamples: number; floor: number; updatedAt: string }
export type RoutePolicyWorkerResult = { state: 'processed'; rebuild: RoutePolicyRebuild } | { state: 'unavailable'; error?: string };

let db: Database.Database | undefined;
let response: RoutePolicyWorkerResult;
try {
  const data = workerData as RoutePolicyWorkerData;
  db = new Database(data.dbPath, { fileMustExist: true, timeout: 5_000 });
  db.pragma('foreign_keys = ON');
  response = { state: 'processed', rebuild: rebuildRoutePolicyTable(db, data) };
} catch (error) {
  response = { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
} finally { try { db?.close(); } catch { /* exit releases the connection */ } }
parentPort?.postMessage(response);
