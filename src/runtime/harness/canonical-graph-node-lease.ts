/**
 * Canonical durable graph/node execution lease.
 *
 * Owner, fence, generation/revision, expiry, and released state come only
 * from graph_node_leases. The graph executor's node-start acquire path is
 * the sole production creator. Reservation consumes one exact generation in
 * the same IMMEDIATE transaction that inserts the physical crossing.
 */
import { createHash } from 'node:crypto';
import { openEventLog } from './eventlog.js';
import type { ResolvedCallAuthorityV1 } from './resolved-call-authority.js';

export interface CanonicalGraphNodeLeaseIdentity {
  sessionId: string;
  sourceUserSeq: number;
  graphId: string;
  nodeId: string;
}

export interface CanonicalGraphNodeLeaseRecord {
  leaseKey: string;
  owner: string;
  fence: number;
  revision: number;
  expiresAt: number;
  released: boolean;
}

const OWNER_FENCE_RE = /^gnl1\.(\d+)\.(\d+)\.(.+)$/;

let reservationInsertFault = false;

export function setReservationInsertFault(enabled: boolean): void {
  reservationInsertFault = enabled;
}

export function reservationInsertFaultEnabled(): boolean {
  return reservationInsertFault;
}

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function encodeCanonicalGraphNodeLeaseIdentity(input: CanonicalGraphNodeLeaseIdentity): string {
  return [
    'gnl2',
    lengthPrefixed(input.sessionId),
    String(input.sourceUserSeq),
    lengthPrefixed(input.graphId),
    lengthPrefixed(input.nodeId),
  ].join('|');
}

export function canonicalGraphNodeLeaseKey(input: CanonicalGraphNodeLeaseIdentity): string {
  const encoded = encodeCanonicalGraphNodeLeaseIdentity(input);
  const digest = createHash('sha256').update(JSON.stringify({
    domain: 'graph-node-lease',
    version: 2,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    graphId: input.graphId,
    nodeId: input.nodeId,
  }), 'utf8').digest('hex');
  return `${encoded}#${digest}`;
}



export function encodeCanonicalOwnerFence(lease: Pick<CanonicalGraphNodeLeaseRecord, 'owner' | 'fence' | 'revision'>): string {
  return `gnl1.${lease.fence}.${lease.revision}.${lease.owner}`;
}

export function parseCanonicalOwnerFence(token: string): { owner: string; fence: number; revision: number } | null {
  const match = OWNER_FENCE_RE.exec(token);
  if (!match) return null;
  const fence = Number(match[1]);
  const revision = Number(match[2]);
  const owner = match[3] ?? '';
  if (!Number.isSafeInteger(fence) || fence <= 0 || !Number.isSafeInteger(revision) || revision <= 0 || !owner.trim()) {
    return null;
  }
  return { owner, fence, revision };
}

export function ensureGraphNodeLeaseTable(db: ReturnType<typeof openEventLog>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_node_leases (
      lease_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      fence INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function readCanonicalGraphNodeLease(
  input: CanonicalGraphNodeLeaseIdentity,
  db: ReturnType<typeof openEventLog> = openEventLog(),
): CanonicalGraphNodeLeaseRecord | null {
  ensureGraphNodeLeaseTable(db);
  const row = db.prepare(
    `SELECT owner, fence, revision, expires_at, released FROM graph_node_leases WHERE lease_key = ?`,
  ).get(canonicalGraphNodeLeaseKey(input)) as {
    owner: string;
    fence: number;
    revision: number;
    expires_at: number;
    released: number;
  } | undefined;
  if (!row) return null;
  return {
    leaseKey: canonicalGraphNodeLeaseKey(input),
    owner: row.owner,
    fence: row.fence,
    revision: row.revision,
    expiresAt: row.expires_at,
    released: row.released === 1,
  };
}

export function inspectCanonicalGraphNodeLeaseInTransaction(
  db: ReturnType<typeof openEventLog>,
  authority: ResolvedCallAuthorityV1,
): { ok: true; key: string; parsed: { owner: string; fence: number; revision: number } } | { ok: false; reason: string } {
  ensureGraphNodeLeaseTable(db);
  const parsed = parseCanonicalOwnerFence(authority.ownerFence);
  if (!parsed) {
    return { ok: false, reason: 'owner fence is not bound to a canonical graph/node lease generation' };
  }
  const identity: CanonicalGraphNodeLeaseIdentity = {
    sessionId: authority.acceptedSource.sessionId,
    sourceUserSeq: authority.acceptedSource.sourceUserSeq,
    graphId: authority.graphId,
    nodeId: authority.nodeId,
  };
  const key = canonicalGraphNodeLeaseKey(identity);
  const lease = db.prepare(`
    SELECT owner, fence, revision, expires_at AS expiresAt, released
      FROM graph_node_leases
     WHERE lease_key = ?
  `).get(key) as {
    owner: string;
    fence: number;
    revision: number;
    expiresAt: number;
    released: number;
  } | undefined;
  if (!lease) {
    return { ok: false, reason: 'canonical graph/node lease is missing' };
  }
  if (lease.owner !== parsed.owner) {
    return { ok: false, reason: 'canonical graph/node lease owner does not match the sealed fence' };
  }
  if (lease.fence !== parsed.fence) {
    return { ok: false, reason: 'canonical graph/node lease fence does not match the sealed fence' };
  }
  if (lease.revision !== parsed.revision) {
    return { ok: false, reason: 'canonical graph/node lease generation does not match the sealed fence' };
  }
  if (lease.released === 1) {
    return { ok: false, reason: 'canonical graph/node lease is released' };
  }
  if (lease.expiresAt <= Date.now()) {
    return { ok: false, reason: 'canonical graph/node lease is expired' };
  }
  return { ok: true, key, parsed };
}

export function consumeCanonicalGraphNodeLeaseInTransaction(
  db: ReturnType<typeof openEventLog>,
  authority: ResolvedCallAuthorityV1,
): { ok: true } | { ok: false; reason: string } {
  const inspected = inspectCanonicalGraphNodeLeaseInTransaction(db, authority);
  if (!inspected.ok) return inspected;
  const cas = db.prepare(`
    UPDATE graph_node_leases
       SET revision = revision + 1
     WHERE lease_key = ?
       AND owner = ? AND fence = ? AND revision = ?
       AND released = 0 AND expires_at > ?
  `).run(inspected.key, inspected.parsed.owner, inspected.parsed.fence, inspected.parsed.revision, Date.now());
  if (cas.changes !== 1) {
    return { ok: false, reason: 'canonical graph/node lease compare-and-swap failed' };
  }
  return { ok: true };
}
