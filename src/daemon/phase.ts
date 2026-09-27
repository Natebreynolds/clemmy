import { AsyncLocalStorage } from 'node:async_hooks';
import { startLivenessBeacon, stampLiveness } from './liveness-beacon.js';

const SUPERVISOR_IPC_HEARTBEAT_TYPE = 'clementine.daemon.heartbeat';
const DEFAULT_SUPERVISOR_IPC_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_DETAIL_CHARS = 240;

export interface DaemonRuntimePhase {
  name: string;
  detail?: string;
  startedAt: string;
  activeMs: number;
  sequence: number;
}

export interface DaemonRuntimePhaseOptions {
  /**
   * `false` keeps the phase off the supervisor IPC channel: no heartbeat is
   * sent when it begins or ends. For high-frequency phases (one per HTTP
   * request). The liveness beacon still learns about it, so a request that
   * blocks the loop is still named.
   */
  ipc?: boolean;
}

interface StoredDaemonRuntimePhase {
  name: string;
  detail?: string;
  startedAt: string;
  startedAtMs: number;
  sequence: number;
  /** The phase whose code entered this one, if any. Lets a continuation that
   *  outlives its own phase fall back to the nearest phase still in flight. */
  parent?: StoredDaemonRuntimePhase;
}

let phaseSequence = 0;

/**
 * Phase tracking keeps apart two things that one global slot used to conflate:
 *
 * - `ambientPhase` is the main loop's own label (setDaemonRuntimePhase).
 * - `runningPhase` is the phase that most recently took the CPU at a KNOWN
 *   point: a phase entry, a phase exit (its caller continues), or an explicit
 *   resume after an await. It is what the beacon and the supervisor report.
 *
 * Every entered, unfinished phase is in `inFlight`, and the code a phase runs
 * carries that phase in `context`, so an exit hands the label to the caller
 * that actually continues, never back to a phase that has already ended.
 * When that caller is the loop's own code (no phase in flight), the ambient
 * label is dated from that known point (see ownerAtKnownPoint).
 */
let ambientPhase: StoredDaemonRuntimePhase = {
  name: 'daemon.boot',
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  sequence: phaseSequence,
};
let runningPhase: StoredDaemonRuntimePhase = ambientPhase;
const inFlight = new Map<number, StoredDaemonRuntimePhase>();
/** Bumped on every entry and exit, so the beacon can tell a changed in-flight
 *  set from a repeated stamp without comparing lists. */
let inFlightVersion = 0;
/** How many in-flight phases are metered (see isMeteredDaemonPhase). */
let meteredInFlight = 0;
const context = new AsyncLocalStorage<StoredDaemonRuntimePhase>();

const METERED_PHASE_PREFIXES = ['daemon.nightly.', 'daemon.maintenance.'];
const METERED_PHASE_NAMES = ['daemon.http.memory_reconcile'];

/**
 * Metered phases are the long memory passes that promise to give the loop a
 * turn every few milliseconds. While one is in flight the beacon samples the
 * main thread's stretch finely and records any stretch over a second.
 */
export function isMeteredDaemonPhase(name: string): boolean {
  if (METERED_PHASE_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return METERED_PHASE_NAMES.some((exact) => name === exact || name.startsWith(`${exact}.`));
}

function cleanDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  let text: string;
  try {
    text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    text = String(detail);
  }
  return text.trim().slice(0, MAX_DETAIL_CHARS) || undefined;
}

function supervisorSend(): ((message: unknown) => boolean) | undefined {
  const owner = process as NodeJS.Process & { send?: (message: unknown) => boolean };
  return typeof owner.send === 'function' ? owner.send.bind(owner) : undefined;
}

function describePhase(phase: StoredDaemonRuntimePhase, nowMs: number): DaemonRuntimePhase {
  return {
    name: phase.name,
    detail: phase.detail,
    startedAt: phase.startedAt,
    activeMs: Math.max(0, nowMs - phase.startedAtMs),
    sequence: phase.sequence,
  };
}

function listStoredInFlight(): StoredDaemonRuntimePhase[] {
  return [...inFlight.values()];
}

/**
 * The phase that owns code continuing at a known point (a phase exit or a
 * resume): the nearest phase still in flight, starting from `phase` and
 * walking to the phases that entered it.
 *
 * With none in flight, the code is the loop's own, and it began HERE, not
 * when the loop pass began. The ambient label is handed out dated from
 * `nowMs`, so `activeMs` measures the code that is really running and never
 * the age of the whole pass (which can include a long awaited sub-phase).
 * Same name and sequence as the ambient label: the beacon learns the new
 * start from its stamp and posts nothing extra.
 */
function ownerAtKnownPoint(phase: StoredDaemonRuntimePhase | undefined, nowMs: number): StoredDaemonRuntimePhase {
  for (let cursor = phase; cursor; cursor = cursor.parent) {
    if (inFlight.has(cursor.sequence)) return cursor;
  }
  return {
    name: ambientPhase.name,
    detail: ambientPhase.detail,
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    sequence: ambientPhase.sequence,
  };
}

/** Tell the beacon where the main thread is: a few float stores, plus one post
 *  only when the running phase or the in-flight set changed. Never sends IPC. */
function stampBeacon(): void {
  stampLiveness(runningPhase, inFlightVersion, meteredInFlight > 0, listStoredInFlight);
}

export function getDaemonRuntimePhase(nowMs: number = Date.now()): DaemonRuntimePhase {
  return describePhase(runningPhase, nowMs);
}

/** Every phase that has been entered and has not finished, oldest first. */
export function listInFlightDaemonPhases(nowMs: number = Date.now()): DaemonRuntimePhase[] {
  return listStoredInFlight().map((phase) => describePhase(phase, nowMs));
}

export function setDaemonRuntimePhase(name: string, detail?: unknown): DaemonRuntimePhase {
  const nowMs = Date.now();
  phaseSequence += 1;
  ambientPhase = {
    name,
    detail: cleanDetail(detail),
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    sequence: phaseSequence,
  };
  runningPhase = ambientPhase;
  sendSupervisorIpcHeartbeat('phase');
  return getDaemonRuntimePhase(nowMs);
}

export async function withDaemonRuntimePhase<T>(
  name: string,
  detail: unknown,
  fn: () => Promise<T> | T,
  options: DaemonRuntimePhaseOptions = {},
): Promise<T> {
  const ipc = options.ipc !== false;
  const nowMs = Date.now();
  phaseSequence += 1;
  const entry: StoredDaemonRuntimePhase = {
    name,
    detail: cleanDetail(detail),
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    sequence: phaseSequence,
    parent: context.getStore(),
  };
  const metered = isMeteredDaemonPhase(name);
  inFlight.set(entry.sequence, entry);
  inFlightVersion += 1;
  if (metered) meteredInFlight += 1;
  runningPhase = entry;
  if (ipc) sendSupervisorIpcHeartbeat('phase');
  else stampBeacon();
  try {
    return await context.run(entry, fn);
  } finally {
    inFlight.delete(entry.sequence);
    inFlightVersion += 1;
    if (metered) meteredInFlight = Math.max(0, meteredInFlight - 1);
    // The code that runs next is this phase's CALLER. context.run scoped only
    // fn, so the store here is the caller's phase (if any). Never hand the
    // label back to a phase that has already ended.
    const before = runningPhase;
    runningPhase = ownerAtKnownPoint(context.getStore(), Date.now());
    if (ipc && runningPhase.sequence !== before.sequence) sendSupervisorIpcHeartbeat('phase_restore');
    else stampBeacon();
  }
}

/**
 * Take the label back for the phase that owns the code now executing, and
 * stamp the beacon. Call it right before synchronous work that follows an
 * await: nothing else can run between the stamp and that work, so the label is
 * exact for it. Sends no IPC, so it is cheap enough to call on every slice.
 */
export function resumeDaemonRuntimePhase(): void {
  runningPhase = ownerAtKnownPoint(context.getStore(), Date.now());
  stampBeacon();
}

/**
 * Give timers, I/O and HTTP one macrotask turn, then take the label back.
 * An `await` on a promise that settles without I/O is NOT a turn; this is.
 */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  resumeDaemonRuntimePhase();
}

export function sendSupervisorIpcHeartbeat(reason: 'heartbeat' | 'phase' | 'phase_restore' = 'heartbeat'): void {
  // Stamp the loop-independent beacon FIRST and unconditionally. It is the
  // signal that survives a blocked event loop, so it must not sit behind the
  // IPC channel's availability check below.
  stampLiveness(runningPhase, inFlightVersion, meteredInFlight > 0, listStoredInFlight);
  const send = supervisorSend();
  if (typeof send !== 'function') return;
  try {
    send({
      type: SUPERVISOR_IPC_HEARTBEAT_TYPE,
      at: new Date().toISOString(),
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      phase: getDaemonRuntimePhase(),
      reason,
    });
  } catch {
    // Best-effort only: the supervisor's HTTP watchdog still exists.
  }
}

export function startSupervisorIpcHeartbeat(intervalMs = DEFAULT_SUPERVISOR_IPC_HEARTBEAT_INTERVAL_MS): void {
  // The beacon is independent of the IPC channel AND of this interval — it is
  // started even if the parent gave us no IPC, and it keeps reporting when the
  // interval below can no longer fire because the loop is blocked.
  startLivenessBeacon();
  if (typeof supervisorSend() !== 'function') return;
  sendSupervisorIpcHeartbeat();
  const timer = setInterval(() => sendSupervisorIpcHeartbeat(), intervalMs);
  timer.unref?.();
}
