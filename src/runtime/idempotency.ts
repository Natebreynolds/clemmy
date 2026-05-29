/**
 * Small in-memory idempotency store for the mobile chat send path.
 *
 * Mobile networks retry — Cellular hand-offs, sleeping tabs, our
 * cloudflared tunnel hiccuping. Without an Idempotency-Key check, a
 * retry would re-run the whole gateway turn (tool calls included).
 * This store caches the response keyed by {deviceId + key} for a
 * short TTL so a retry just replays the same JSON.
 *
 * Process-local. The store lives in the daemon process; restarts
 * lose state, which is fine — a daemon restart resets every active
 * client connection anyway.
 */

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 256;

interface CachedEntry<T> {
  scope: string;
  key: string;
  value: T;
  expiresAt: number;
}

const store = new Map<string, CachedEntry<unknown>>();

function compositeKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

export interface IdempotencyHit<T> {
  cached: true;
  value: T;
}
export interface IdempotencyMiss {
  cached: false;
}
export type IdempotencyLookup<T> = IdempotencyHit<T> | IdempotencyMiss;

export function lookupIdempotent<T>(scope: string, key: string, now = Date.now()): IdempotencyLookup<T> {
  if (!key) return { cached: false };
  const composite = compositeKey(scope, key);
  const entry = store.get(composite);
  if (!entry) return { cached: false };
  if (entry.expiresAt <= now) {
    store.delete(composite);
    return { cached: false };
  }
  return { cached: true, value: entry.value as T };
}

export function rememberIdempotent<T>(
  scope: string,
  key: string,
  value: T,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): void {
  if (!key) return;
  // Best-effort eviction so the map never grows unbounded across a
  // long-running daemon. We scan when we're at the cap; that's O(N)
  // but N is small (256) and only fires when we're already full.
  if (store.size >= MAX_ENTRIES) {
    const expired: string[] = [];
    for (const [k, v] of store) {
      if (v.expiresAt <= now) expired.push(k);
    }
    for (const k of expired) store.delete(k);
    if (store.size >= MAX_ENTRIES) {
      // Still full → drop oldest by insertion order.
      const overflow = store.size - MAX_ENTRIES + 1;
      let dropped = 0;
      for (const k of store.keys()) {
        store.delete(k);
        dropped += 1;
        if (dropped >= overflow) break;
      }
    }
  }
  store.set(compositeKey(scope, key), {
    scope,
    key,
    value,
    expiresAt: now + ttlMs,
  });
}

/** Drop everything — for tests. */
export function _clearIdempotencyForTests(): void {
  store.clear();
}

/** Snapshot for diagnostics. */
export function idempotencySize(): number {
  return store.size;
}
