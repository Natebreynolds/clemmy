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
/** How often the worker samples the main thread's stamp while a metered phase
 *  is in flight, and how often the main thread re-stamps while one is. */
const METERED_SAMPLE_MS = 20;
/** Bounds each post; the in-flight set is diagnostic, not an inventory. */
const MAX_POSTED_IN_FLIGHT = 32;

/**
 * Shared stamps, written by the main thread with plain stores:
 *   [0] ms timestamp of the main thread's last stamp
 *   [1] ms timestamp the running phase began
 *   [2] the running phase's sequence
 *   [3] 1 while any metered phase is in flight, else 0
 */
export const LIVENESS_STAMP_SLOTS = 4;

/** What phase.ts hands the beacon. Only these fields are ever posted. */
export interface LivenessPhase {
  name: string;
  detail?: string;
  startedAtMs: number;
  sequence: number;
}

/** The message the main thread posts to the worker. */
export interface LivenessPhaseMessage {
  running: LivenessPhase;
  inFlight: LivenessPhase[];
  metered: boolean;
}

let stamps: Float64Array | null = null;
let worker: Worker | null = null;
let postedSequence = -1;
let postedInFlightVersion = -1;
let posts = 0;
let meteredTicker: NodeJS.Timeout | null = null;

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

function pick(phase: LivenessPhase): LivenessPhase {
  return { name: phase.name, detail: phase.detail, startedAtMs: phase.startedAtMs, sequence: phase.sequence };
}

/**
 * While a metered phase is in flight the main thread re-stamps on a short
 * timer. A pass that yields stamps on every slice anyway; this keeps the stamp
 * fresh while the same phase awaits the network, so the stamp's age is the
 * main thread's real stretch and never just "nobody stamped lately".
 */
function syncMeteredTicker(metered: boolean): void {
  if (!stamps) return;
  stamps[3] = metered ? 1 : 0;
  if (metered && !meteredTicker) {
    meteredTicker = setInterval(() => { if (stamps) stamps[0] = Date.now(); }, METERED_SAMPLE_MS);
    meteredTicker.unref?.();
  } else if (!metered && meteredTicker) {
    clearInterval(meteredTicker);
    meteredTicker = null;
  }
}

/**
 * Record that the main thread is alive and which phase it is in. Called on
 * every phase entry, exit and resume, and on the heartbeat interval.
 * Deliberately as cheap as possible — a few float stores and, only when the
 * running phase or the in-flight set actually changed, one postMessage. The
 * slices of one job therefore post nothing.
 */
export function stampLiveness(
  running?: LivenessPhase,
  inFlightVersion = 0,
  metered = false,
  listInFlight?: () => readonly LivenessPhase[],
): void {
  if (!stamps) return;
  stamps[0] = Date.now();
  if (!running) return;
  stamps[1] = running.startedAtMs;
  stamps[2] = running.sequence;
  syncMeteredTicker(metered);
  if (running.sequence === postedSequence && inFlightVersion === postedInFlightVersion) return;
  postedSequence = running.sequence;
  postedInFlightVersion = inFlightVersion;
  posts += 1;
  // Delivered while the loop is still free (we are at a known point). If the
  // main thread blocks next, the worker keeps reporting THIS phase.
  try {
    const message: LivenessPhaseMessage = {
      running: pick(running),
      inFlight: (listInFlight?.() ?? []).slice(0, MAX_POSTED_IN_FLIGHT).map(pick),
      metered,
    };
    worker?.postMessage(message);
  } catch { /* best effort */ }
}

/** Start the beacon once. No-op without CLEMMY_LIVENESS_BEACON_FILE. */
export function startLivenessBeacon(): void {
  if (worker) return;
  const file = beaconFile();
  if (!file) return;
  try {
    const buffer = new SharedArrayBuffer(LIVENESS_STAMP_SLOTS * Float64Array.BYTES_PER_ELEMENT);
    const view = new Float64Array(buffer);
    view[0] = Date.now();
    view[1] = Date.now();
    const { url, execArgv } = workerEntry();
    const spawned = new Worker(url, {
      workerData: { file, stamps: buffer, intervalMs: BEACON_INTERVAL_MS, sampleMs: METERED_SAMPLE_MS, pid: process.pid },
      ...(execArgv ? { execArgv } : {}),
    });
    // Never hold the daemon open for the beacon.
    spawned.unref();
    spawned.on('error', () => { stopBeaconState(); });
    spawned.on('exit', () => { stopBeaconState(); });
    worker = spawned;
    stamps = view;
    postedSequence = -1;
    postedInFlightVersion = -1;
  } catch {
    stopBeaconState();
  }
}

function stopBeaconState(): void {
  if (meteredTicker) clearInterval(meteredTicker);
  meteredTicker = null;
  worker = null;
  stamps = null;
  postedSequence = -1;
  postedInFlightVersion = -1;
}

/** Test seam: how many phase messages have been posted to the worker. */
export function _livenessBeaconPostCountForTest(): number {
  return posts;
}

/** Test seam: the shared stamps, or null when the beacon is not running. */
export function _livenessStampsForTest(): Float64Array | null {
  return stamps;
}

/** Test seam: whether the metered re-stamp timer is running. */
export function _livenessMeteredTickerRunningForTest(): boolean {
  return meteredTicker !== null;
}

/** Test seam. */
export function _stopLivenessBeaconForTest(): void {
  try { void worker?.terminate(); } catch { /* ignore */ }
  stopBeaconState();
}
