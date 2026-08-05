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
  /**
   * Opaque write revision, bumped on EVERY write. The CAS compares it in
   * addition to the fence, so two writers holding one fence (a release and a
   * stale renewal, a reclaim and a late commit) can never both win — the
   * fence names WHO may act, the revision names WHICH read their write was
   * based on.
   */
  revision: number;
  /** Monotonic-clock expiry; a lease is only reclaimable after this. */
  expiresAt: number;
  released: boolean;
}

/** Injected CAS storage. `expected: undefined` = key must be absent;
 *  otherwise BOTH fence and revision must match the current record. */
export interface LeaseStorePort {
  read(key: string): Promise<LeaseRecord | undefined>;
  cas(
    key: string,
    expected: { fence: number; revision: number } | undefined,
    next: LeaseRecord,
  ): Promise<boolean>;
  /**
   * OPTIONAL storage transaction: run `work` iff the current record matches
   * (owner + fence + revision, unreleased, unexpired), atomically with a
   * revision bump — no competing lease write may interleave with `work`.
   * Stores that cannot provide it fall back to the commit-window semantics.
   */
  transact?(
    key: string,
    expected: { owner: string; fence: number },
    now: number,
    work: () => Promise<void>,
  ): Promise<{ ok: boolean; reason?: string }>;
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
  /**
   * Open a commit window as ONE conditional operation (owner+fence+revision
   * CAS that also extends expiry). The durable append that follows is fenced:
   * any interleaved reclaim/release loses the revision compare instead of
   * racing the append.
   */
  beginCommit(key: string, fence: number): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Run a durable append as ONE conditional operation with the lease check:
   * a storage transaction where the store provides one, else the
   * commit-window equivalent (beginCommit, then work).
   */
  commitWith(key: string, fence: number, work: () => Promise<void>): Promise<{ ok: boolean; reason?: string }>;
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
          owner, fence: 1, revision: 1, expiresAt: now + ttlMs, released: false,
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
      const won = await store.cas(key, { fence: current.fence, revision: current.revision }, {
        owner, fence: current.fence + 1, revision: current.revision + 1,
        expiresAt: now + ttlMs, released: false,
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
      const won = await store.cas(key, { fence, revision: current.revision }, {
        ...current, revision: current.revision + 1, expiresAt: clock() + ttlMs,
      });
      return won ? { ok: true } : { ok: false, reason: `renewal of "${key}" lost a concurrent write` };
    },
    async release(key, fence) {
      const current = await store.read(key);
      if (!current || current.owner !== owner || current.fence !== fence) {
        return { ok: false, reason: `cannot release "${key}": not held by "${owner}" at fence ${fence}` };
      }
      const won = await store.cas(key, { fence, revision: current.revision }, {
        ...current, revision: current.revision + 1, released: true,
      });
      return won ? { ok: true } : { ok: false, reason: `release of "${key}" lost a concurrent write` };
    },
    async holds(key, fence) {
      const current = await store.read(key);
      return !!current && current.owner === owner && current.fence === fence
        && !current.released && current.expiresAt > clock();
    },
    async commitWith(key, fence, work) {
      if (store.transact) {
        return store.transact(key, { owner, fence }, clock(), work);
      }
      const window = await this.beginCommit(key, fence);
      if (!window.ok) return window;
      await work();
      return { ok: true };
    },
    async beginCommit(key, fence) {
      // ONE conditional operation opens the commit window: verify owner +
      // fence + live, and CAS-bump the revision while extending the expiry.
      // A reclaim interleaved anywhere in this read-modify-write loses to
      // the revision compare; once the window is open, a reclaimer cannot
      // take the lease until the window's expiry lapses.
      const current = await store.read(key);
      const now = clock();
      if (!current || current.owner !== owner || current.fence !== fence
        || current.released || current.expiresAt <= now) {
        return { ok: false, reason: `commit window refused for "${key}": not live-held by "${owner}" at fence ${fence}` };
      }
      const won = await store.cas(key, { fence, revision: current.revision }, {
        ...current, revision: current.revision + 1, expiresAt: now + ttlMs,
      });
      return won
        ? { ok: true }
        : { ok: false, reason: `commit window for "${key}" lost a concurrent write — a reclaim or release landed first` };
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
        if (fence === undefined) {
          throw new Error(`stale fence: settlement of "${entry.nodeId}" has no held lease in this activation`);
        }
        // ONE conditional durable operation: the append runs inside the
        // lease check (a storage transaction where available, else the
        // commit-window equivalent) — a reclaim between check and append
        // loses instead of admitting a late settlement.
        const committed = await manager.commitWith(keyOf(entry.nodeId), fence, async () => {
          await adapter.append(entry);
        });
        if (!committed.ok) {
          throw new Error(`stale fence: settlement of "${entry.nodeId}" arrived after its lease was reclaimed — ${committed.reason}`);
        }
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
