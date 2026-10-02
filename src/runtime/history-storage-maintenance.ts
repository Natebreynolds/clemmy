/** Off-main-thread historical conversion. Callers must establish the installed
 * compatible reader before scheduling this; starting it is not a migration or
 * release-acceptance shortcut. It never falls back to blocking the main loop. */
import { Worker } from 'node:worker_threads';
import type { HistoryStorageWorkerData, HistoryStorageWorkerResult } from './history-storage-maintenance.worker.js';

const running = new Map<string, Promise<HistoryStorageWorkerResult>>();
export function runHistoryStorageMaintenance(dbPath: string): Promise<HistoryStorageWorkerResult> {
  const existing = running.get(dbPath);
  if (existing) return existing;
  const task = new Promise<HistoryStorageWorkerResult>(resolve => {
    const data: HistoryStorageWorkerData = { dbPath };
    let worker: Worker;
    try {
      if (import.meta.url.endsWith('.ts')) {
        worker = new Worker(`const { workerData } = require('node:worker_threads');
          import(workerData.tsxApi).then(({ register }) => { register(); return import(workerData.entry); });`, {
          eval: true, workerData: { ...data, tsxApi: import.meta.resolve('tsx/esm/api'),
            entry: new URL('./history-storage-maintenance.worker.ts', import.meta.url).href },
        });
      } else worker = new Worker(new URL('./history-storage-maintenance.worker.js', import.meta.url), { workerData: data });
    } catch { resolve({ state: 'unavailable' }); return; }
    let result: HistoryStorageWorkerResult = { state: 'unavailable' };
    let expired = false;
    const timer = setTimeout(() => { expired = true; void worker.terminate().catch(() => {}); }, 10_000);
    timer.unref();
    // Keep awaited work alive until exit. Unref'ing this finite worker can
    // silently abandon the promise when it is the caller's last active job.
    worker.on('message', (message: HistoryStorageWorkerResult) => { result = message; });
    worker.on('error', () => { result = { state: 'unavailable' }; });
    // Keep the single-flight entry until the thread actually exits, including
    // native work still finishing after terminate() was requested.
    worker.once('exit', code => { clearTimeout(timer); resolve(expired || code !== 0 ? { state: 'unavailable' } : result); });
  });
  running.set(dbPath, task);
  void task.finally(() => { if (running.get(dbPath) === task) running.delete(dbPath); });
  return task;
}
