/**
 * Main-thread host for the liveness beacon worker. See liveness.worker.ts for
 * why a second, loop-independent liveness signal exists at all.
 *
 * Kept out of phase.ts on purpose: that module is deliberately dependency-free
 * so it can be imported from anywhere without dragging in config or fs.
 *
 * Everything here is best-effort and silent. A beacon that cannot start must
 * never be the reason a daemon fails to boot — the supervisor simply falls back
 * to the IPC heartbeat it has always used.
 */
import { Worker } from 'node:worker_threads';

const BEACON_INTERVAL_MS = 5_000;

let stamps: Float64Array | null = null;
let worker: Worker | null = null;
let lastPhaseName: string | undefined;

/** Where the supervisor expects to read the beacon. Set by the desktop
 *  supervisor via envOverrides; unset elsewhere (CLI, tests, headless), where
 *  the beacon is simply not started. */
function beaconFile(): string | undefined {
  const raw = process.env.CLEMMY_LIVENESS_BEACON_FILE;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function workerEntry(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url;
  return here.endsWith('.ts')
    ? { url: new URL('./liveness.worker.ts', here), execArgv: ['--import', 'tsx'] }
    : { url: new URL('./liveness.worker.js', here) };
}

/**
 * Record that the main thread is alive and which phase it is in. Called from
 * the existing heartbeat path, so it fires on every phase transition and on the
 * heartbeat interval. Deliberately as cheap as possible — two float stores and,
 * only when the phase NAME actually changes, one postMessage.
 */
export function stampLiveness(phase?: { name: string; detail?: string; startedAtMs: number }): void {
  if (!stamps) return;
  stamps[0] = Date.now();
  if (!phase) return;
  stamps[1] = phase.startedAtMs;
  if (phase.name !== lastPhaseName) {
    lastPhaseName = phase.name;
    // Delivered while the loop is still free (we are at phase entry). If the
    // main thread blocks next, the worker keeps reporting THIS phase.
    try { worker?.postMessage({ name: phase.name, detail: phase.detail }); } catch { /* best effort */ }
  }
}

/** Start the beacon once. No-op without CLEMMY_LIVENESS_BEACON_FILE. */
export function startLivenessBeacon(): void {
  if (worker) return;
  const file = beaconFile();
  if (!file) return;
  try {
    const buffer = new SharedArrayBuffer(2 * Float64Array.BYTES_PER_ELEMENT);
    const view = new Float64Array(buffer);
    view[0] = Date.now();
    view[1] = Date.now();
    const { url, execArgv } = workerEntry();
    const spawned = new Worker(url, {
      workerData: { file, stamps: buffer, intervalMs: BEACON_INTERVAL_MS, pid: process.pid },
      ...(execArgv ? { execArgv } : {}),
    });
    // Never hold the daemon open for the beacon.
    spawned.unref();
    spawned.on('error', () => { worker = null; stamps = null; });
    spawned.on('exit', () => { worker = null; stamps = null; });
    worker = spawned;
    stamps = view;
  } catch {
    worker = null;
    stamps = null;
  }
}

/** Test seam. */
export function _stopLivenessBeaconForTest(): void {
  try { void worker?.terminate(); } catch { /* ignore */ }
  worker = null;
  stamps = null;
  lastPhaseName = undefined;
}
