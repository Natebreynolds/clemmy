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

interface StoredDaemonRuntimePhase {
  name: string;
  detail?: string;
  startedAt: string;
  startedAtMs: number;
  sequence: number;
}

let phaseSequence = 0;
let currentPhase: StoredDaemonRuntimePhase = {
  name: 'daemon.boot',
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  sequence: phaseSequence,
};

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
  return (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send;
}

export function getDaemonRuntimePhase(nowMs: number = Date.now()): DaemonRuntimePhase {
  return {
    name: currentPhase.name,
    detail: currentPhase.detail,
    startedAt: currentPhase.startedAt,
    activeMs: Math.max(0, nowMs - currentPhase.startedAtMs),
    sequence: currentPhase.sequence,
  };
}

export function setDaemonRuntimePhase(name: string, detail?: unknown): DaemonRuntimePhase {
  const nowMs = Date.now();
  phaseSequence += 1;
  currentPhase = {
    name,
    detail: cleanDetail(detail),
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    sequence: phaseSequence,
  };
  sendSupervisorIpcHeartbeat('phase');
  return getDaemonRuntimePhase(nowMs);
}

export async function withDaemonRuntimePhase<T>(
  name: string,
  detail: unknown,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = currentPhase;
  const active = setDaemonRuntimePhase(name, detail);
  try {
    return await fn();
  } finally {
    if (currentPhase.sequence === active.sequence) {
      currentPhase = previous;
      sendSupervisorIpcHeartbeat('phase_restore');
    }
  }
}

export function sendSupervisorIpcHeartbeat(reason: 'heartbeat' | 'phase' | 'phase_restore' = 'heartbeat'): void {
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
  if (typeof supervisorSend() !== 'function') return;
  sendSupervisorIpcHeartbeat();
  const timer = setInterval(() => sendSupervisorIpcHeartbeat(), intervalMs);
  timer.unref?.();
}
