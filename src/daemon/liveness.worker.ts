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
import { renameSync, writeFileSync } from 'node:fs';

interface BeaconWorkerData {
  file: string;
  stamps: SharedArrayBuffer;
  intervalMs: number;
  pid: number;
}

/** Index 0: ms timestamp of the main thread's last stamp.
 *  Index 1: ms timestamp the current phase began. Both written by the main
 *  thread with a plain store — no lock, because a torn read is impossible for
 *  aligned float64 and a stale read is harmless (it only ever under-reports
 *  freshness, which fails safe toward keeping the daemon alive... and the
 *  supervisor's own ceiling still bounds a true freeze). */
const { file, stamps, intervalMs, pid } = workerData as BeaconWorkerData;
const view = new Float64Array(stamps);

let phaseName = 'daemon.boot';
let phaseDetail: string | undefined;
const startedAt = Date.now();

parentPort?.on('message', (msg: { name?: string; detail?: string }) => {
  // Delivered while the loop is free — i.e. at phase ENTRY. If the main thread
  // then blocks, we retain the phase it blocked in, which is precisely the
  // diagnostic the supervisor needs.
  if (typeof msg?.name === 'string') { phaseName = msg.name; phaseDetail = msg.detail; }
});

function beat(): void {
  const now = Date.now();
  const mainStampAt = view[0] || 0;
  const phaseStartedAtMs = view[1] || 0;
  const payload = JSON.stringify({
    at: new Date(now).toISOString(),
    pid,
    // Proof the PROCESS is alive even when its main loop is not.
    beaconUptimeMs: now - startedAt,
    // Proof of whether the main loop is making progress.
    mainStampAt: mainStampAt ? new Date(mainStampAt).toISOString() : null,
    mainStampAgeMs: mainStampAt ? Math.max(0, now - mainStampAt) : null,
    phase: {
      name: phaseName,
      detail: phaseDetail,
      startedAt: phaseStartedAtMs ? new Date(phaseStartedAtMs).toISOString() : null,
      activeMs: phaseStartedAtMs ? Math.max(0, now - phaseStartedAtMs) : null,
    },
  });
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
