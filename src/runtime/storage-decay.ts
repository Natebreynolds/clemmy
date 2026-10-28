/** Off-main-thread storage decay: a retired turn's working records and the
 * event log's diagnostic rows age out in a short-lived worker with its own
 * connection. Single-flight per store; it never falls back to blocking the
 * main loop. */
import { Worker } from 'node:worker_threads';
import type { StorageDecayWorkerData, StorageDecayWorkerResult } from './storage-decay.worker.js';

/** A pass works this long on the worker's connection; a turn's transaction
 * is short, so a chat's own write waits milliseconds at most. */
export const STORAGE_DECAY_PASS_BUDGET_MS = 2_000;
/** Diagnostic rows one pass removes at most. */
export const STORAGE_DECAY_DIAGNOSTIC_ROWS = 2_000;
const WORKER_TIMEOUT_MS = 20_000;

const running = new Map<string, Promise<StorageDecayWorkerResult>>();
export function runStorageDecayPass(dbPath: string, options: { budgetMs?: number; diagnosticRows?: number } = {}): Promise<StorageDecayWorkerResult> {
  const existing = running.get(dbPath);
  if (existing) return existing;
  const task = new Promise<StorageDecayWorkerResult>(resolve => {
    const data: StorageDecayWorkerData = { dbPath, budgetMs: options.budgetMs ?? STORAGE_DECAY_PASS_BUDGET_MS,
      diagnosticRows: options.diagnosticRows ?? STORAGE_DECAY_DIAGNOSTIC_ROWS };
    let worker: Worker;
    try {
      if (import.meta.url.endsWith('.ts')) {
        worker = new Worker(`const { workerData } = require('node:worker_threads');
          import(workerData.tsxApi).then(({ register }) => { register(); return import(workerData.entry); });`, {
          eval: true, workerData: { ...data, tsxApi: import.meta.resolve('tsx/esm/api'),
            entry: new URL('./storage-decay.worker.ts', import.meta.url).href },
        });
      } else worker = new Worker(new URL('./storage-decay.worker.js', import.meta.url), { workerData: data });
    } catch { resolve({ state: 'unavailable' }); return; }
    let result: StorageDecayWorkerResult = { state: 'unavailable' };
    let expired = false;
    const timer = setTimeout(() => { expired = true; void worker.terminate().catch(() => {}); }, WORKER_TIMEOUT_MS);
    timer.unref();
    worker.on('message', (message: StorageDecayWorkerResult) => { result = message; });
    worker.on('error', (error) => { result = { state: 'unavailable', error: error.message }; });
    worker.once('exit', code => { clearTimeout(timer); resolve(expired || code !== 0 ? { state: 'unavailable' } : result); });
  });
  running.set(dbPath, task);
  void task.finally(() => { if (running.get(dbPath) === task) running.delete(dbPath); });
  return task;
}
