/**
 * The liveness beacon worker — proof of life that does NOT depend on the main
 * event loop.
 *
 * 2026-09-10, during a Zoom call: the daemon blocked inside
 * daemon.loop.memory_maintenance doing synchronous ONNX + SQLite work on a
 * CPU-starved machine. Its HTTP listener stopped answering AND its supervisor
 * IPC heartbeat went stale — because that heartbeat is a setInterval on the
 * very loop that was blocked. The supervisor has a deferral built exactly for
 * "busy but alive" (LIVENESS_MAX_IPC_DEFERRALS), but it keys on heartbeat
 * freshness, so the one signal that could have saved the daemon died with the
 * thing it was measuring. It got SIGKILLed while merely slow.
 *
 * Two liveness signals that share a failure mode are one signal. This worker
 * has its own event loop, so it keeps beating while the main thread is blocked,
 * and it reports what the main thread was doing when it last checked in — which
 * is what lets the supervisor tell "starved" from "frozen".
 *
 * process.send() is undefined in a worker thread (verified), so the beacon is a
 * file. That also makes it inspectable after a kill.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { LivenessPhase, LivenessPhaseMessage } from './liveness-beacon.js';

interface BeaconWorkerData {
  file: string;
  stamps: SharedArrayBuffer;
  intervalMs: number;
  /** Sampling period while a metered phase is in flight. */
  sampleMs?: number;
  pid: number;
}

/** A stretch this long without a main-thread stamp is journalled, any time. */
const STALL_THRESHOLD_MS = 10_000;
/** While a metered phase is in flight the main thread promises a turn every
 *  few milliseconds, so a much shorter stretch is already worth a record. */
const METERED_STALL_THRESHOLD_MS = 1_000;
const STALL_JOURNAL_KEEP_LINES = 500;
/** Trim only once the journal is this far past its bound, so a busy night
 *  does not rewrite the file on every line. */
const STALL_JOURNAL_TRIM_SLACK = 50;

/** Stamps written by the main thread with plain stores (see
 *  LIVENESS_STAMP_SLOTS in liveness-beacon.ts):
 *    [0] ms timestamp (wall clock) of the main thread's last stamp
 *    [1] ms timestamp the running phase began
 *    [2] the running phase's sequence
 *    [3] 1 while a metered phase is in flight
 *    [4] the same last stamp on the process's monotonic clock (ms)
 *  No lock: a torn read is impossible for aligned float64, and a stale read is
 *  harmless (it only ever under-reports freshness, which fails safe toward
 *  keeping the daemon alive... and the supervisor's own ceiling still bounds a
 *  true freeze). */
const { file, stamps, intervalMs, sampleMs = 20, pid } = workerData as BeaconWorkerData;
const view = new Float64Array(stamps);

/**
 * The process's monotonic clock, read exactly as livenessMonotonicMs in
 * liveness-beacon.ts does (a worker cannot import that module from source).
 * Every thread of the process reads the same clock, and it does not advance
 * while the machine sleeps. Stretches are measured on it, so after a wake,
 * whichever thread runs first, the hours asleep are never a stall.
 */
function monotonicMs(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

/** The main thread's last stamp and how long ago it was, in awake time.
 *  Falls back to the wall clock only if the monotonic slot was never set. */
function readMainStamp(now: number): { wallAt: number; at: number; ageMs: number } | null {
  const wallAt = view[0] || 0;
  if (!wallAt) return null;
  const monoAt = view.length > 4 ? view[4] || 0 : 0;
  if (monoAt) return { wallAt, at: monoAt, ageMs: Math.max(0, monotonicMs() - monoAt) };
  return { wallAt, at: wallAt, ageMs: Math.max(0, now - wallAt) };
}

const stallFile = path.join(path.dirname(file), 'daemon-stalls.jsonl');

let running: LivenessPhase = { name: 'daemon.boot', startedAtMs: 0, sequence: 0 };
let inFlight: LivenessPhase[] = [];
let meteredByMessage = false;
const startedAt = Date.now();

/** Longest main-stamp age seen since the last beat was written. */
let windowMaxAgeMs = 0;
let sampler: NodeJS.Timeout | null = null;

interface OpenStall {
  /** The main thread's last stamp before the stretch (monotonic ms). */
  stampAt: number;
  /** The same stamp on the wall clock, for the record. */
  wallStampAt: number;
  thresholdMs: number;
  metered: boolean;
  maxAgeMs: number;
  phase: ReturnType<typeof describeRunning>;
  inFlight: ReturnType<typeof describeInFlight>;
}
let openStall: OpenStall | null = null;
let journalLines = countJournalLines();

parentPort?.on('message', (msg: Partial<LivenessPhaseMessage> | null) => {
  // Delivered while the main loop is free — i.e. at a known point. If the main
  // thread then blocks, we retain the phase it blocked in, which is precisely
  // the diagnostic the supervisor needs.
  if (!msg || typeof msg !== 'object' || !msg.running || typeof msg.running.name !== 'string') return;
  running = msg.running;
  inFlight = Array.isArray(msg.inFlight) ? msg.inFlight : [];
  meteredByMessage = msg.metered === true;
  syncSampler();
});

function isMetered(): boolean {
  return view[3] === 1 || meteredByMessage;
}

function iso(ms: number): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function describeRunning(now: number) {
  const phaseStartedAtMs = view[1] || running.startedAtMs || 0;
  return {
    name: running.name,
    detail: running.detail,
    startedAt: iso(phaseStartedAtMs),
    activeMs: phaseStartedAtMs ? Math.max(0, now - phaseStartedAtMs) : null,
  };
}

function describeInFlight(now: number) {
  return inFlight.map((phase) => ({
    name: phase.name,
    detail: phase.detail,
    startedAt: iso(phase.startedAtMs),
    activeMs: phase.startedAtMs ? Math.max(0, now - phase.startedAtMs) : null,
  }));
}

function countJournalLines(): number {
  try {
    if (!existsSync(stallFile)) return 0;
    return readFileSync(stallFile, 'utf8').split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function appendStallLine(record: Record<string, unknown>): void {
  try {
    appendFileSync(stallFile, `${JSON.stringify(record)}\n`);
    journalLines += 1;
    if (journalLines > STALL_JOURNAL_KEEP_LINES + STALL_JOURNAL_TRIM_SLACK) {
      const kept = readFileSync(stallFile, 'utf8').split('\n').filter((line) => line.trim()).slice(-STALL_JOURNAL_KEEP_LINES);
      const tmp = `${stallFile}.tmp`;
      writeFileSync(tmp, `${kept.join('\n')}\n`);
      renameSync(tmp, stallFile);
      journalLines = kept.length;
    }
  } catch {
    // Best-effort: the journal is a diagnostic, never a reason to stop beating.
  }
}

/**
 * Read the main thread's stamp once. Tracks the longest age for the current
 * beat window and opens/closes a stall record. A stall closes as soon as the
 * main thread stamps again; its duration is the gap between the two stamps.
 * Ages and durations are awake time (the monotonic stamp), so a machine that
 * slept since the last stamp opens no stall, whichever thread wakes first.
 */
function sample(now = Date.now()): void {
  const stamp = readMainStamp(now);
  if (!stamp) return;
  const { at: stampAt, ageMs } = stamp;
  if (ageMs > windowMaxAgeMs) windowMaxAgeMs = ageMs;

  if (openStall) {
    if (stampAt !== openStall.stampAt) {
      const durationMs = Math.max(0, stampAt - openStall.stampAt);
      if (durationMs > windowMaxAgeMs) windowMaxAgeMs = durationMs;
      appendStallLine({
        event: 'end',
        at: new Date(now).toISOString(),
        pid,
        since: iso(openStall.wallStampAt),
        durationMs,
        maxAgeMs: Math.max(openStall.maxAgeMs, durationMs),
        thresholdMs: openStall.thresholdMs,
        metered: openStall.metered,
        phase: openStall.phase,
        inFlight: openStall.inFlight,
      });
      openStall = null;
    } else {
      if (ageMs > openStall.maxAgeMs) openStall.maxAgeMs = ageMs;
      return;
    }
  }

  const metered = isMetered();
  const thresholdMs = metered ? METERED_STALL_THRESHOLD_MS : STALL_THRESHOLD_MS;
  if (ageMs < thresholdMs) return;
  openStall = {
    stampAt,
    wallStampAt: stamp.wallAt,
    thresholdMs,
    metered,
    maxAgeMs: ageMs,
    phase: describeRunning(now),
    inFlight: describeInFlight(now),
  };
  appendStallLine({
    event: 'start',
    at: new Date(now).toISOString(),
    pid,
    since: iso(stamp.wallAt),
    ageMs,
    thresholdMs,
    metered,
    phase: openStall.phase,
    inFlight: openStall.inFlight,
  });
}

/** Sample finely only while a metered phase is in flight; otherwise the beat
 *  cadence is enough (and costs nothing between beats). */
function syncSampler(): void {
  const want = isMetered();
  if (want && !sampler) {
    sampler = setInterval(() => sample(), sampleMs);
  } else if (!want && sampler) {
    clearInterval(sampler);
    sampler = null;
  }
}

function beat(): void {
  const now = Date.now();
  sample(now);
  syncSampler();
  const mainStamp = readMainStamp(now);
  const payload = JSON.stringify({
    at: new Date(now).toISOString(),
    pid,
    // Proof the PROCESS is alive even when its main loop is not.
    beaconUptimeMs: now - startedAt,
    // Proof of whether the main loop is making progress. The age is awake
    // time: a machine asleep since the last stamp does not age it.
    mainStampAt: mainStamp ? new Date(mainStamp.wallAt).toISOString() : null,
    mainStampAgeMs: mainStamp ? mainStamp.ageMs : null,
    // The longest stretch seen in this beat window. While metered it is sampled
    // every few milliseconds; otherwise it is this beat's own reading.
    maxMainStampAgeMs: windowMaxAgeMs,
    metered: isMetered(),
    // The running phase: the code that last took the main thread at a known
    // point. Kept under this name for readers that predate `inFlight`.
    phase: describeRunning(now),
    inFlight: describeInFlight(now),
  });
  windowMaxAgeMs = 0;
  try {
    // Atomic replace so the supervisor never reads a half-written beacon.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, file);
  } catch {
    // Best-effort: the supervisor's HTTP watchdog and IPC heartbeat still exist.
  }
}

beat();
setInterval(beat, intervalMs);
