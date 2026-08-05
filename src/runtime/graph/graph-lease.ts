/**
 * Leases, fencing, and lifecycle (R1B/B3).
 *
 * A durable run that can restart can also OVERLAP itself: the old activation
 * may still be finishing a node while a new activation reclaims the work.
 * Attempt ids make the histories distinguishable; leases make the overlap
 * SAFE — exactly one owner may dispatch a node at a time, a reclaim after
 * proven expiry carries a strictly higher fence, and a settlement from a
 * superseded fence is rejected at the durable boundary rather than silently
 * rewriting history the new owner is already building.
 *
 * Everything is injected: storage (CAS port over any durable store), owner
 * identity, a monotonic clock, and the TTL. No wall clock, no environment,
 * no ambient state.
 *
 * The executor stays lease-blind. Integration is a JOURNAL ADAPTER wrapper:
 * a node's lease is acquired before its durable claim is written and released
 * when its settlement lands; a lost lease surfaces as a rejected append,
 * which the executor already treats as an infrastructure halt — nothing after
 * the failed append dispatches, and the journal remains the source of truth.
 *
 * Budget parking RELEASES leases: a parked run holds no work in flight, and
 * the resuming activation re-acquires per node. `releaseAll` is the park-
 * boundary hook and is proven by test, not implied.
 */
import type { GraphJournalAdapter, GraphJournalEntry } from './graph-journal.js';

export interface LeaseRecord {
  owner: string;
  /** Strictly increasing across ownership changes — the fencing token. */
  fence: number;
  /** Monotonic-clock expiry; a lease is only reclaimable after this. */
  expiresAt: number;
  released: boolean;
}

/** Injected CAS storage. `expectedFence: undefined` = key must be absent. */
export interface LeaseStorePort {
  read(key: string): Promise<LeaseRecord | undefined>;
  cas(key: string, expectedFence: number | undefined, next: LeaseRecord): Promise<boolean>;
}

export type AcquireResult =
  | { ok: true; fence: number }
  | { ok: false; heldBy: string; reason: string };

export interface LeaseManager {
  readonly owner: string;
  acquire(key: string): Promise<AcquireResult>;
  /** Extend the expiry of a lease this owner holds at this fence. */
  renew(key: string, fence: number): Promise<{ ok: boolean; reason?: string }>;
  release(key: string, fence: number): Promise<{ ok: boolean; reason?: string }>;
  /** True iff this owner holds `key` at `fence` and it has not expired. */
  holds(key: string, fence: number): Promise<boolean>;
}

export function createLeaseManager(input: {
  store: LeaseStorePort;
  owner: string;
  clock: () => number;
  ttlMs: number;
}): LeaseManager {
  const { store, owner, clock, ttlMs } = input;
  return {
    owner,
    async acquire(key) {
      const current = await store.read(key);
      const now = clock();
      if (!current) {
        const won = await store.cas(key, undefined, {
          owner, fence: 1, expiresAt: now + ttlMs, released: false,
        });
        return won
          ? { ok: true, fence: 1 }
          : { ok: false, heldBy: 'unknown', reason: `lost the acquisition race for "${key}"` };
      }
      if (!current.released && current.expiresAt > now && current.owner !== owner) {
        return { ok: false, heldBy: current.owner, reason: `"${key}" is live-leased by "${current.owner}" until ${current.expiresAt}` };
      }
      if (!current.released && current.expiresAt > now && current.owner === owner) {
        return { ok: true, fence: current.fence }; // idempotent re-entry
      }
      // Released or provably expired: reclaim with a STRICTLY higher fence.
      const won = await store.cas(key, current.fence, {
        owner, fence: current.fence + 1, expiresAt: now + ttlMs, released: false,
      });
      return won
        ? { ok: true, fence: current.fence + 1 }
        : { ok: false, heldBy: current.owner, reason: `lost the reclaim race for "${key}"` };
    },
    async renew(key, fence) {
      const current = await store.read(key);
      if (!current || current.owner !== owner || current.fence !== fence || current.released) {
        return { ok: false, reason: `cannot renew "${key}": not held by "${owner}" at fence ${fence}` };
      }
      const won = await store.cas(key, fence, { ...current, expiresAt: clock() + ttlMs });
      return won ? { ok: true } : { ok: false, reason: `renewal of "${key}" lost a concurrent write` };
    },
    async release(key, fence) {
      const current = await store.read(key);
      if (!current || current.owner !== owner || current.fence !== fence) {
        return { ok: false, reason: `cannot release "${key}": not held by "${owner}" at fence ${fence}` };
      }
      const won = await store.cas(key, fence, { ...current, released: true });
      return won ? { ok: true } : { ok: false, reason: `release of "${key}" lost a concurrent write` };
    },
    async holds(key, fence) {
      const current = await store.read(key);
      return !!current && current.owner === owner && current.fence === fence
        && !current.released && current.expiresAt > clock();
    },
  };
}

/**
 * The journal-boundary integration. Wraps a durable adapter so that:
 *
 *   - `node_started` acquires the node's lease FIRST — a lost race rejects
 *     the append, so the claim never becomes durable and the executor halts
 *     (typed infrastructure), leaving the live owner sole writer;
 *   - `node_settled` lands only while the lease is still held at the fence
 *     acquired for that node — a settlement arriving after reclaim is a LATE
 *     OLD OWNER and is rejected before it can rewrite the new owner's
 *     history; a successful settlement releases the lease;
 *   - `releaseAll()` is the park boundary: budget parking holds nothing.
 */
export function withNodeLeases(
  adapter: GraphJournalAdapter,
  manager: LeaseManager,
  keyPrefix = 'node',
): GraphJournalAdapter & { releaseAll(): Promise<void> } {
  const held = new Map<string, number>();
  const keyOf = (nodeId: string): string => `${keyPrefix}:${nodeId}`;
  return {
    async append(entry: GraphJournalEntry): Promise<void> {
      if (entry.type === 'node_started') {
        const acquired = await manager.acquire(keyOf(entry.nodeId));
        if (!acquired.ok) {
          throw new Error(`lease unavailable for "${entry.nodeId}": ${acquired.reason}`);
        }
        held.set(entry.nodeId, acquired.fence);
        await adapter.append(entry);
        return;
      }
      if (entry.type === 'node_settled') {
        const fence = held.get(entry.nodeId);
        if (fence === undefined || !(await manager.holds(keyOf(entry.nodeId), fence))) {
          throw new Error(`stale fence: settlement of "${entry.nodeId}" arrived after its lease was reclaimed — a late old owner may not rewrite history`);
        }
        await adapter.append(entry);
        held.delete(entry.nodeId);
        await manager.release(keyOf(entry.nodeId), fence);
        return;
      }
      await adapter.append(entry);
    },
    async releaseAll(): Promise<void> {
      for (const [nodeId, fence] of [...held]) {
        held.delete(nodeId);
        await manager.release(keyOf(nodeId), fence);
      }
    },
  };
}
