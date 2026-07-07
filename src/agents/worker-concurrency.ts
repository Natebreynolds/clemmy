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
 *    acquires its SESSION slot FIRST, then any provider-specific slot, then the GLOBAL slot
 *    — consistent lock order (no deadlock) and no global slot is ever held by a worker still
 *    waiting for a session/provider slot.
 *    The global default (12) is ≥ the per-session default (6), so a single session is never
 *    further limited — the global cap only bites when multiple sessions run concurrently.
 *
 * CLEMMY_WORKER_MAX_CONCURRENCY=0/off/unlimited is the MASTER off — fully unbounded, both
 * gates disabled (the documented pre-2026-06-30 escape hatch, unchanged). With any positive
 * per-session value (incl. the default 6) the global ceiling also applies, unless it is
 * independently disabled via CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL=0/off/unlimited.
 *
 * BYO/OpenAI-compatible providers get an additional conservative clamp by default:
 *  - CLEMMY_WORKER_MAX_CONCURRENCY_BYO (default 1) limits each session.
 *  - CLEMMY_WORKER_MAX_CONCURRENCY_BYO_GLOBAL (default 2) limits all BYO workers across sessions.
 *
 * BYO backends are user-supplied and often sit behind smaller quota pools than Codex/Claude.
 * The clamps are opt-up, not opt-out: set the BYO env vars higher once a provider has proven
 * it can absorb parallel worker bursts.
 */

const DEFAULT_MAX_CONCURRENCY = 6;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 12;
// BYO parallel fan-out: 3/session, 4/global (was 1/2 — a serial bottleneck that
// made GLM/BYO worker fan-out run one item at a time). 3 concurrent is absorbed by
// essentially every real BYO provider (z.ai, Together, OpenRouter, Groq, …) yet
// stays well under the native 6/12 for smaller quota pools. Still opt-up AND
// opt-down via CLEMMY_WORKER_MAX_CONCURRENCY_BYO[_GLOBAL] for a tiny endpoint.
const DEFAULT_BYO_MAX_CONCURRENCY = 3;
const DEFAULT_BYO_GLOBAL_MAX_CONCURRENCY = 4;

type WorkerProviderClass = 'codex' | 'claude' | 'byo';

export interface WorkerSlotOptions {
  provider?: WorkerProviderClass | string | null;
  modelId?: string | null;
}

function envDisabled(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'unlimited';
}

function positiveEnvInt(key: string): number | null {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : null;
}

/** True when the per-session gate is disabled (unbounded) via the kill-switch. */
function gateDisabled(): boolean {
  return envDisabled(process.env.CLEMMY_WORKER_MAX_CONCURRENCY);
}

/** The per-session in-flight cap. */
function maxConcurrency(): number {
  const raw = positiveEnvInt('CLEMMY_WORKER_MAX_CONCURRENCY');
  if (raw !== null) return raw;
  return DEFAULT_MAX_CONCURRENCY;
}

/** True when the global ceiling is disabled. */
function globalGateDisabled(): boolean {
  return envDisabled(process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL);
}

/** The process-global in-flight ceiling across ALL sessions. */
function maxGlobalConcurrency(): number {
  const raw = positiveEnvInt('CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL');
  if (raw !== null) return raw;
  return Math.max(maxConcurrency(), DEFAULT_GLOBAL_MAX_CONCURRENCY);
}

function isByoWorker(opts?: WorkerSlotOptions): boolean {
  return (opts?.provider ?? '').toString().trim().toLowerCase() === 'byo';
}

function effectiveSessionCap(opts?: WorkerSlotOptions): number {
  const base = maxConcurrency();
  if (!isByoWorker(opts) || envDisabled(process.env.CLEMMY_WORKER_MAX_CONCURRENCY_BYO)) return base;
  return Math.min(base, positiveEnvInt('CLEMMY_WORKER_MAX_CONCURRENCY_BYO') ?? DEFAULT_BYO_MAX_CONCURRENCY);
}

function effectiveGlobalCap(opts: WorkerSlotOptions | undefined, sessionCap: number): number {
  const base = maxGlobalConcurrency();
  if (!isByoWorker(opts) || envDisabled(process.env.CLEMMY_WORKER_MAX_CONCURRENCY_BYO_GLOBAL)) return base;
  const providerDefault = Math.max(sessionCap, DEFAULT_BYO_GLOBAL_MAX_CONCURRENCY);
  return Math.min(base, positiveEnvInt('CLEMMY_WORKER_MAX_CONCURRENCY_BYO_GLOBAL') ?? providerDefault);
}

interface Gate {
  active: number;
  /** FIFO queue of waiters; resolving one HANDS OVER a slot (active stays constant). */
  queue: Array<() => void>;
}

const gates = new Map<string, Gate>();
const globalGate: Gate = { active: 0, queue: [] };
const providerGates = new Map<string, Gate>();

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

/** For tests: current provider-global in-flight count. */
export function _activeProviderWorkerSlots(provider: string): number {
  return providerGates.get(provider)?.active ?? 0;
}

/** For tests: reset all gate state. */
export function _resetWorkerConcurrencyForTest(): void {
  gates.clear();
  globalGate.active = 0;
  globalGate.queue = [];
  providerGates.clear();
}

/** Reported when a worker actually has to WAIT for a session slot (the per-session
 *  cap is already saturated) — so the caller can emit a worker_queued telemetry
 *  event WITHOUT this pure, I/O-free module taking on a telemetry dependency. */
export interface WorkerQueuedInfo {
  /** Waiters ahead of this one, plus this one (≥1). */
  queueDepth: number;
  perSessionCap: number;
  globalCap: number;
  provider?: string;
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
  opts?: WorkerSlotOptions,
): Promise<() => void> {
  if (gateDisabled()) return () => {}; // MASTER off — fully unbounded (documented escape hatch)

  // SESSION slot FIRST (a worker waiting for a session slot holds nothing), THEN provider,
  // THEN global — so we never tie up a scarce global slot on a worker queued upstream.
  const key = sessionId || '__global__';
  let gate = gates.get(key);
  if (!gate) { gate = { active: 0, queue: [] }; gates.set(key, gate); }
  const perSessionCap = effectiveSessionCap(opts);
  const provider = isByoWorker(opts) ? 'byo' : undefined;
  const globalCap = effectiveGlobalCap(opts, perSessionCap);
  if (onQueued && gate.active >= perSessionCap) {
    // This acquire will block on the FIFO queue — surface it before we await.
    try {
      onQueued({ queueDepth: gate.queue.length + 1, perSessionCap, globalCap, ...(provider ? { provider } : {}) });
    } catch { /* telemetry must never break the throttle */ }
  }
  const releaseSession = await acquireOnGate(gate, perSessionCap);
  const providerGate = provider ? (providerGates.get(provider) ?? { active: 0, queue: [] }) : null;
  if (provider && providerGate && !providerGates.has(provider)) providerGates.set(provider, providerGate);
  const releaseProvider = providerGate ? await acquireOnGate(providerGate, globalCap) : () => {};
  const releaseGlobal = globalGateDisabled() ? () => {} : await acquireOnGate(globalGate, maxGlobalConcurrency());

  const g = gate;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGlobal();
    releaseProvider();
    releaseSession();
    if (provider && providerGate && providerGate.active <= 0 && providerGate.queue.length === 0) providerGates.delete(provider);
    if (g.active <= 0 && g.queue.length === 0) gates.delete(key); // GC the drained gate
  };
}
