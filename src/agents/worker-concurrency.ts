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
 * Kill-switch CLEMMY_WORKER_MAX_CONCURRENCY: a positive integer sets the cap
 * (default 6); `0` / `off` / `unlimited` disables the gate entirely (unbounded, the
 * pre-2026-06-30 behavior).
 */

const DEFAULT_MAX_CONCURRENCY = 6;

/** True when the gate is disabled (unbounded) via the kill-switch. */
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

interface SessionGate {
  active: number;
  /** FIFO queue of waiters; resolving one HANDS OVER a slot (active stays constant). */
  queue: Array<() => void>;
}

const gates = new Map<string, SessionGate>();

/** For tests: current in-flight count for a session (0 if none). */
export function _activeWorkerSlots(sessionId: string): number {
  return gates.get(sessionId || '__global__')?.active ?? 0;
}

/** For tests: reset all gate state. */
export function _resetWorkerConcurrencyForTest(): void {
  gates.clear();
}

/**
 * Acquire a worker slot for `sessionId`. Resolves immediately if a slot is free,
 * otherwise waits FIFO until one frees. Returns an idempotent release fn — call it
 * exactly once (in a finally) when the worker execution finishes or throws.
 */
export async function acquireWorkerSlot(sessionId: string): Promise<() => void> {
  if (gateDisabled()) return () => {};
  const key = sessionId || '__global__';
  let gate = gates.get(key);
  if (!gate) {
    gate = { active: 0, queue: [] };
    gates.set(key, gate);
  }

  if (gate.active < maxConcurrency()) {
    gate.active += 1;
  } else {
    // No free slot: wait until a releaser HANDS its slot to us (active unchanged).
    await new Promise<void>((resolve) => gate!.queue.push(resolve));
  }

  let released = false;
  return () => {
    if (released) return; // idempotent — a double-release must not corrupt the count
    released = true;
    const g = gates.get(key);
    if (!g) return;
    const next = g.queue.shift();
    if (next) {
      next(); // hand our slot to the next waiter — active stays the same
    } else {
      g.active -= 1;
      if (g.active <= 0 && g.queue.length === 0) gates.delete(key); // GC the drained gate
    }
  };
}
