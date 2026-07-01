/**
 * Per-session concurrency gate for run_worker fan-out.
 *
 * The parent model fires run_worker as N PARALLEL tool calls (one per item), and
 * each call is a full nested model turn. An unthrottled "fan out 100 items" turn
 * therefore opens ~100 concurrent provider calls at once — a self-inflicted 429
 * (account quota) / 529 (capacity) storm, observed live 2026-06-30 as a burst of
 * `resilient-model byo status:429`. runBoundedPool caps the WORKFLOW drain but was
 * never wired to chat fan-out.
 *
 * This is a standing async semaphore keyed by session: at most K worker executions
 * run at once per session; the rest queue and start as slots free (throttle, never
 * drop — every item still completes). Pure in-memory, no I/O, so the FIFO ordering
 * is unit-testable in isolation.
 *
 * TWO ceilings, both enforced:
 *  - PER-SESSION (CLEMMY_WORKER_MAX_CONCURRENCY, default 6): at most K workers per session.
 *  - GLOBAL (CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL, default max(perSession, 12)): a hard cap
 *    across ALL sessions, so several sessions swarming at once (or the per-session cap being
 *    widened) can't blow past the provider's real concurrency and storm 429/529. A worker
 *    acquires its SESSION slot FIRST, then the GLOBAL slot — consistent lock order (no
 *    deadlock) and no global slot is ever held by a worker still waiting for a session slot.
 *    The global default (12) is ≥ the per-session default (6), so a single session is never
 *    further limited — the global cap only bites when multiple sessions run concurrently.
 *
 * CLEMMY_WORKER_MAX_CONCURRENCY=0/off/unlimited is the MASTER off — fully unbounded, both
 * gates disabled (the documented pre-2026-06-30 escape hatch, unchanged). With any positive
 * per-session value (incl. the default 6) the global ceiling also applies, unless it is
 * independently disabled via CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL=0/off/unlimited.
 */

const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 12;

/** True when the per-session gate is disabled (unbounded) via the kill-switch. */
function gateDisabled(): boolean {
  const v = (process.env.CLEMMY_WORKER_MAX_CONCURRENCY ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'unlimited';
}

/** The per-session in-flight cap. */
function maxConcurrency(): number {
  const raw = Number.parseInt(process.env.CLEMMY_WORKER_MAX_CONCURRENCY ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return DEFAULT_MAX_CONCURRENCY;
}

/** True when the global ceiling is disabled. */
function globalGateDisabled(): boolean {
  const v = (process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'unlimited';
}

/** The process-global in-flight ceiling across ALL sessions. */
function maxGlobalConcurrency(): number {
  const raw = Number.parseInt(process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return Math.max(maxConcurrency(), DEFAULT_GLOBAL_MAX_CONCURRENCY);
}

interface Gate {
  active: number;
  /** FIFO queue of waiters; resolving one HANDS OVER a slot (active stays constant). */
  queue: Array<() => void>;
}

const gates = new Map<string, Gate>();
const globalGate: Gate = { active: 0, queue: [] };

/** Acquire one slot on a gate (FIFO). Returns an idempotent per-gate release. */
async function acquireOnGate(gate: Gate, max: number): Promise<() => void> {
  if (gate.active < max) {
    gate.active += 1;
  } else {
    await new Promise<void>((resolve) => gate.queue.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return; // idempotent — a double-release must not corrupt the count
    released = true;
    const next = gate.queue.shift();
    if (next) next(); // hand our slot to the next waiter — active stays the same
    else gate.active -= 1;
  };
}

/** For tests: current in-flight count for a session (0 if none). */
export function _activeWorkerSlots(sessionId: string): number {
  return gates.get(sessionId || '__global__')?.active ?? 0;
}

/** For tests: current GLOBAL in-flight worker count across all sessions. */
export function _activeGlobalWorkerSlots(): number {
  return globalGate.active;
}

/** For tests: reset all gate state. */
export function _resetWorkerConcurrencyForTest(): void {
  gates.clear();
  globalGate.active = 0;
  globalGate.queue = [];
}

/** Reported when a worker actually has to WAIT for a session slot (the per-session
 *  cap is already saturated) — so the caller can emit a worker_queued telemetry
 *  event WITHOUT this pure, I/O-free module taking on a telemetry dependency. */
export interface WorkerQueuedInfo {
  /** Waiters ahead of this one, plus this one (≥1). */
  queueDepth: number;
  perSessionCap: number;
  globalCap: number;
}

/**
 * Acquire a worker slot for `sessionId`. Resolves immediately if slots are free,
 * otherwise waits FIFO until they free. Returns an idempotent release fn — call it
 * exactly once (in a finally) when the worker execution finishes or throws.
 *
 * `onQueued` (optional) is invoked ONCE, synchronously, only when the caller will
 * actually wait on the per-session gate (the common throttle). It carries the
 * queue depth + caps so the caller owns the telemetry emit and this module stays
 * pure/in-memory.
 */
export async function acquireWorkerSlot(
  sessionId: string,
  onQueued?: (info: WorkerQueuedInfo) => void,
): Promise<() => void> {
  if (gateDisabled()) return () => {}; // MASTER off — fully unbounded (documented escape hatch)

  // SESSION slot FIRST (a worker waiting for a session slot holds nothing), THEN the GLOBAL
  // slot — so we never tie up a scarce global slot on a worker that's still queued per-session.
  const key = sessionId || '__global__';
  let gate = gates.get(key);
  if (!gate) { gate = { active: 0, queue: [] }; gates.set(key, gate); }
  const perSessionCap = maxConcurrency();
  if (onQueued && gate.active >= perSessionCap) {
    // This acquire will block on the FIFO queue — surface it before we await.
    try {
      onQueued({ queueDepth: gate.queue.length + 1, perSessionCap, globalCap: maxGlobalConcurrency() });
    } catch { /* telemetry must never break the throttle */ }
  }
  const releaseSession = await acquireOnGate(gate, perSessionCap);
  const releaseGlobal = globalGateDisabled() ? () => {} : await acquireOnGate(globalGate, maxGlobalConcurrency());

  const g = gate;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGlobal();
    releaseSession();
    if (g.active <= 0 && g.queue.length === 0) gates.delete(key); // GC the drained gate
  };
}
