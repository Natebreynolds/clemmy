/**
 * Test-only lease fixtures. Production lease rows are created only by the
 * graph executor's durable node-start acquire path.
 */
import {
  canonicalGraphNodeLeaseKey,
  encodeCanonicalOwnerFence,
  ensureGraphNodeLeaseTable,
  readCanonicalGraphNodeLease,
  type CanonicalGraphNodeLeaseIdentity,
  type CanonicalGraphNodeLeaseRecord,
} from './canonical-graph-node-lease.js';
import { openEventLog } from './eventlog.js';

export function acquireCanonicalGraphNodeLease(input: CanonicalGraphNodeLeaseIdentity & {
  owner: string;
  ttlMs?: number;
}): { ok: true; lease: CanonicalGraphNodeLeaseRecord; ownerFence: string } | { ok: false; reason: string } {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.graphId.trim()
    || !input.nodeId.trim()
    || !input.owner.trim()
  ) {
    return { ok: false, reason: 'canonical lease identity is incomplete' };
  }
  const db = openEventLog();
  ensureGraphNodeLeaseTable(db);
  const key = canonicalGraphNodeLeaseKey(input);
  const now = Date.now();
  const ttlMs = input.ttlMs ?? 60_000;
  const existing = readCanonicalGraphNodeLease(input, db);
  if (!existing) {
    db.prepare(`
      INSERT INTO graph_node_leases (lease_key, owner, fence, revision, expires_at, released)
      VALUES (?, ?, 1, 1, ?, 0)
    `).run(key, input.owner, now + ttlMs);
    const lease = readCanonicalGraphNodeLease(input, db);
    if (!lease) return { ok: false, reason: 'canonical lease insert did not persist' };
    return { ok: true, lease, ownerFence: encodeCanonicalOwnerFence(lease) };
  }
  if (!existing.released && existing.expiresAt > now && existing.owner !== input.owner) {
    return { ok: false, reason: 'canonical lease is held by another owner' };
  }
  if (!existing.released && existing.expiresAt > now && existing.owner === input.owner) {
    return { ok: true, lease: existing, ownerFence: encodeCanonicalOwnerFence(existing) };
  }
  const next = {
    owner: input.owner,
    fence: existing.fence + 1,
    revision: existing.revision + 1,
    expiresAt: now + ttlMs,
    released: false,
  };
  const updated = db.prepare(`
    UPDATE graph_node_leases
       SET owner = ?, fence = ?, revision = ?, expires_at = ?, released = 0
     WHERE lease_key = ? AND fence = ? AND revision = ?
  `).run(next.owner, next.fence, next.revision, next.expiresAt, key, existing.fence, existing.revision);
  if (updated.changes !== 1) {
    return { ok: false, reason: 'canonical lease reclaim lost a concurrent write' };
  }
  const lease = readCanonicalGraphNodeLease(input, db);
  if (!lease) return { ok: false, reason: 'canonical lease reclaim did not persist' };
  return { ok: true, lease, ownerFence: encodeCanonicalOwnerFence(lease) };
}

export function writeCanonicalGraphNodeLeaseFixture(input: CanonicalGraphNodeLeaseIdentity & {
  owner: string;
  fence: number;
  revision: number;
  expiresAt: number;
  released: boolean;
}): void {
  const db = openEventLog();
  ensureGraphNodeLeaseTable(db);
  db.prepare(`
    INSERT INTO graph_node_leases (lease_key, owner, fence, revision, expires_at, released)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(lease_key) DO UPDATE SET
      owner = excluded.owner,
      fence = excluded.fence,
      revision = excluded.revision,
      expires_at = excluded.expires_at,
      released = excluded.released
  `).run(
    canonicalGraphNodeLeaseKey(input),
    input.owner,
    input.fence,
    input.revision,
    input.expiresAt,
    input.released ? 1 : 0,
  );
}
