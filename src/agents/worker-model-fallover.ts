/**
 * Worker-model fallover (DREAM fleet resilience): a rate-limited worker model
 * must not idle a fan-out. One provider's 429 benches that MODEL for a
 * cooldown window; items route to the next healthy candidate instead of
 * failing (live 2026-07-22: a Moonshot 429 killed a whole retest round while
 * the session's other models sat idle).
 *
 * Mechanism mirrors the proven BYO unknown-model self-heal: an in-memory memo
 * consulted at spawn-time selection, plus an invite-retry message when a batch
 * dies uniformly on a rate limit. Deliberately NOT durable — a cooldown is a
 * transient provider property; a daemon restart forgetting it is correct.
 * Candidate chains are built by the CALLER (lane-specific), so this module
 * stays dependency-free and provider-isolation promises (all_in) are enforced
 * where the chain is assembled.
 */

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

const coolingUntil = new Map<string, number>();

export function markWorkerModelCoolingDown(modelId: string | null | undefined, retryAfterMs?: number): void {
  const id = (modelId ?? '').trim();
  if (!id) return;
  const ttl = typeof retryAfterMs === 'number' && retryAfterMs > 0
    ? Math.min(retryAfterMs + 5_000, MAX_COOLDOWN_MS)
    : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + ttl;
  // Never SHORTEN an existing cooldown (two racing failures must not shrink the bench).
  const existing = coolingUntil.get(id) ?? 0;
  coolingUntil.set(id, Math.max(existing, until));
}

export function isWorkerModelCoolingDown(modelId: string | null | undefined): boolean {
  const id = (modelId ?? '').trim();
  if (!id) return false;
  const until = coolingUntil.get(id);
  if (!until) return false;
  if (Date.now() >= until) {
    coolingUntil.delete(id);
    return false;
  }
  return true;
}

export function clearWorkerModelCooldownsForTest(): void {
  coolingUntil.clear();
}

/** Pure: does a worker failure text look like provider rate-limiting /
 *  overload (an infrastructure property of the MODEL, not the item)? Tight on
 *  purpose — unknown-model and transport shapes have their own handlers. */
export function workerFailureLooksRateLimited(text: string | null | undefined): boolean {
  return /\b(429|529)\b|rate.?limit|overloaded|usage.?limit|quota (?:exceeded|reached)/i.test((text ?? '').slice(0, 500));
}

export interface WorkerModelPick {
  model: string;
  /** Set when the routed model was benched and a fallback was chosen. */
  falloverFrom?: string;
}

/**
 * Pick the first non-cooling candidate. `candidates` is ordered by preference
 * and lane-assembled (routed model first, then the lane's legitimate
 * fallbacks). When EVERY candidate is cooling, returns the routed model
 * unchanged — an exhausted chain must fail visibly on the real route, not
 * invent a model to hide behind.
 */
export function pickWorkerModelWithFallover(candidates: Array<string | null | undefined>): WorkerModelPick {
  const chain = [...new Set(candidates.map((c) => (c ?? '').trim()).filter(Boolean))];
  if (chain.length === 0) return { model: '' };
  const routed = chain[0];
  for (const candidate of chain) {
    if (!isWorkerModelCoolingDown(candidate)) {
      return candidate === routed ? { model: routed } : { model: candidate, falloverFrom: routed };
    }
  }
  return { model: routed };
}
